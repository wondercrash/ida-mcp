/** @typedef {{directory: string, python: string, prepared: boolean}} PythonEnvironment */

import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, link, mkdir, open, readFile, realpath, rename, rm, stat, utimes, writeFile, } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
// Files whose content defines the environment. The project is installed
// editable from the package root, so source edits need no new environment;
// a version bump changes pyproject.toml.
const KEY_INPUTS = ["pyproject.toml", "uv.lock", ".python-version"];
const OPTIONAL_KEY_INPUT = ".python-version";
// Readers trust only published environments; lock contention merely avoids
// duplicate work. A preparing host refreshes its lock; one that stopped
// refreshing crashed.
const LOCK_HEARTBEAT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 200;
const UV_LOG_TAIL_LINES = 40;
/** Per-user cache directory, outside the package so updates never touch it. */
export function defaultEnvironmentCacheRoot() {
    if (process.platform === "win32") {
        const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
        return join(localAppData, "ida-mcp", "envs");
    }
    if (process.platform === "darwin") {
        return join(homedir(), "Library", "Caches", "ida-mcp", "envs");
    }
    const cacheHome = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
    return join(cacheHome, "ida-mcp", "envs");
}
/**
 * Identify the environment for a package root: its canonical path (the
 * editable install target) and the content, not times, of its key inputs.
 */
/** @param {string} packageRoot */
export async function environmentKey(packageRoot) {
    const root = await realpath(packageRoot);
    const hash = createHash("sha256").update(`ida-mcp-env-v1\0${root}\0`);
    for (const name of KEY_INPUTS) {
        let content;
        try {
            content = await readFile(join(root, name));
        }
        catch (error) {
            if (name !== OPTIONAL_KEY_INPUT ||
                error.code !== "ENOENT") {
                throw error;
            }
        }
        hash.update(`${name}\0${content?.length ?? -1}\0`);
        if (content)
            hash.update(content);
    }
    return hash.digest("hex").slice(0, 16);
}
/**
 * Return the cached Python environment for a package root, creating it with
 * `uv sync` on first use.
 *
 * Each preparation syncs into a fresh directory and publishes it by
 * exclusively creating `<key>.ready`, which names that directory. uv never
 * runs against a published environment again, because running servers hold
 * its files open and Windows cannot replace them. Hosts serialize on a lock
 * and recheck after acquiring it so only one normally syncs; if a lock is
 * wrongly reclaimed, the losing preparation discards its own directory.
 * Failed preparation publishes nothing, so the next start retries.
 *
 * Aborting cancels only unpublished preparation. If the OS refuses to stop
 * its writer, the cold worker retains cleanup ownership after the host exits.
 */
/**
 * @param {string} packageRoot
 * @param {{cacheRoot?: string, signal?: AbortSignal}} [options]
 * @returns {Promise<PythonEnvironment>}
 */
export async function preparePythonEnvironment(packageRoot, options = {}) {
    const { cacheRoot = defaultEnvironmentCacheRoot(), signal } = options;
    signal?.throwIfAborted();
    const root = await realpath(packageRoot);
    const key = await environmentKey(root);
    const name = (await readFile(join(cacheRoot, `${key}.ready`), "utf8").catch(() => "")).trim();
    if (name) {
        const directory = join(cacheRoot, name);
        const python = process.platform === "win32"
            ? join(directory, "Scripts", "python.exe") : join(directory, "bin", "python");
        if (await access(python).then(() => true, () => false)) {
            return { directory, python, prepared: false };
        }
    }
    signal?.throwIfAborted();
    // Only cold preparation needs an independent owner. It retains cleanup
    // responsibility even if OS permissions prevent cancelling a build and the
    // host must leave. BUN_BE_BUN also supports OMP's compiled Bun executable.
    const owner = spawn(process.execPath, [fileURLToPath(new URL("./ida-mcp-preparation.mjs", import.meta.url)), root, cacheRoot], {
        env: { ...process.env, BUN_BE_BUN: "1" },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        windowsHide: true,
        detached: true,
    });
    let stderr = "";
    owner.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-32_768); });
    return new Promise((resolve, reject) => {
        let settled = false;
        let ownerReady = false;
        const cancel = () => { if (ownerReady && owner.connected)
            owner.send({ type: "cancel" }); };
        /** @param {Error} [error] @param {PythonEnvironment} [environment] */
        const finish = (error, environment) => {
            if (settled)
                return;
            settled = true;
            signal?.removeEventListener("abort", cancel);
            if (owner.connected)
                owner.disconnect();
            owner.unref();
            if ("unref" in owner.stderr && typeof owner.stderr.unref === "function")
                owner.stderr.unref();
            if (error)
                reject(error);
            else
                resolve(environment);
        };
        signal?.addEventListener("abort", cancel, { once: true });
        owner.on("message", (message) => {
            if (!message || typeof message !== "object" || !("type" in message))
                return;
            if (message.type === "ready") {
                ownerReady = true;
                if (signal?.aborted)
                    cancel();
            }
            else if (message.type === "result" && "environment" in message) {
                // The owned worker sends this internal contract.
                finish(undefined, /** @type {PythonEnvironment} */ (message.environment));
            }
            else if ((message.type === "error" || message.type === "deferred") && "error" in message) {
                // The owned worker sends this internal contract.
                const reported = /** @type {{name: string, message: string}} */ (message.error);
                const error = new Error(reported.message);
                error.name = reported.name;
                finish(error);
            }
        });
        owner.once("error", (error) => finish(error));
        owner.once("exit", (code) => finish(new Error(`IDA MCP preparation owner exited without a result (${code}): ${stderr}`)));
    });
}
/** Internal entry point used only by the independently owned cold worker. */
/**
 * @param {string} packageRoot
 * @param {{cacheRoot: string, signal: AbortSignal, onTerminationFailure: (error: Error) => void}} options
 * @returns {Promise<PythonEnvironment>}
 */
export async function prepareOwnedPythonEnvironment(packageRoot, options) {
    const { cacheRoot, signal, onTerminationFailure } = options;
    const root = await realpath(packageRoot);
    const key = await environmentKey(root);
    const markerPath = join(cacheRoot, `${key}.ready`);
    const pythonIn = (directory) => process.platform === "win32"
        ? join(directory, "Scripts", "python.exe")
        : join(directory, "bin", "python");
    const readMarker = () => readFile(markerPath, "utf8").then((name) => name.trim(), () => undefined);
    /** @param {string | undefined} name @returns {Promise<PythonEnvironment | undefined>} */
    const environmentNamed = async (name) => {
        if (!name)
            return undefined;
        const directory = join(cacheRoot, name);
        const python = pythonIn(directory);
        return access(python).then(() => ({ directory, python, prepared: false }), () => undefined);
    };
    const ready = await environmentNamed(await readMarker());
    if (ready)
        return ready;
    await mkdir(cacheRoot, { recursive: true });
    const releaseLock = await acquireLock(join(cacheRoot, `${key}.lock`), signal);
    try {
        const name = await readMarker();
        const readyNow = await environmentNamed(name);
        if (readyNow)
            return readyNow;
        // The published environment was deleted; nothing can run from it.
        if (name)
            await discardMarker(markerPath, name);
        const directory = join(cacheRoot, `${key}-${randomBytes(4).toString("hex")}`);
        const pendingMarker = `${directory}.ready`;
        try {
            await uvSync(root, directory, `${directory}.log`, signal, onTerminationFailure);
            signal.throwIfAborted();
            await rm(`${directory}.log`, { force: true });
            // Publish atomically: a hard link exposes the fully written marker and
            // never replaces one another host published.
            await writeFile(pendingMarker, basename(directory));
            signal.throwIfAborted();
            try {
                await link(pendingMarker, markerPath);
            }
            catch (error) {
                if (error.code !== "EEXIST")
                    throw error;
                // Another host published first: drop only this attempt.
                await rm(directory, { recursive: true, force: true });
                const winner = await environmentNamed(await readMarker());
                if (!winner)
                    throw new Error(`Unusable IDA MCP environment marker ${markerPath}`);
                return winner;
            }
            return { directory, python: pythonIn(directory), prepared: true };
        }
        catch (error) {
            await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
            if (signal.aborted)
                await rm(`${directory}.log`, { force: true });
            throw error;
        }
        finally {
            await rm(pendingMarker, { force: true });
        }
    }
    finally {
        await releaseLock();
    }
}
/**
 * Remove the marker if it still names `name`. It is moved aside atomically,
 * and a marker another host published meanwhile is linked back.
 */
/** @param {string} markerPath @param {string} name */
async function discardMarker(markerPath, name) {
    const discarded = `${markerPath}.${randomBytes(4).toString("hex")}.discard`;
    try {
        await rename(markerPath, discarded);
    }
    catch {
        return;
    }
    const moved = await readFile(discarded, "utf8").catch(() => "");
    if (moved.trim() !== name) {
        await link(discarded, markerPath).catch(() => undefined);
    }
    await rm(discarded, { force: true });
}
/**
 * @param {string} path
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<() => Promise<void>>}
 */
async function acquireLock(path, signal) {
    const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
    let deletePendingRetries = 0;
    for (;;) {
        signal?.throwIfAborted();
        try {
            await writeFile(path, token, { flag: "wx" });
            break;
        }
        catch (error) {
            const code = error.code;
            // Windows reports EPERM while a released lock file is being deleted;
            // persistent EPERM is a real permission problem.
            const deletePending = code === "EPERM" &&
                process.platform === "win32" &&
                ++deletePendingRetries < 50;
            if (code !== "EEXIST" && !deletePending)
                throw error;
        }
        const age = await stat(path).then((stats) => Date.now() - stats.mtimeMs, () => undefined);
        if (age !== undefined && age > LOCK_STALE_MS) {
            await rm(path, { force: true }).catch(() => undefined);
            continue;
        }
        // A lock released meanwhile is retried at once.
        if (age !== undefined)
            await delay(LOCK_POLL_MS, undefined, { signal });
        else if (deletePendingRetries > 0)
            await delay(10, undefined, { signal });
    }
    const heartbeat = setInterval(() => {
        const now = new Date();
        utimes(path, now, now).catch(() => undefined);
    }, LOCK_HEARTBEAT_MS);
    heartbeat.unref();
    return async () => {
        clearInterval(heartbeat);
        // Never remove a lock another host took over.
        if ((await readFile(path, "utf8").catch(() => undefined)) === token) {
            await rm(path, { force: true });
        }
    };
}
/**
 * @param {string} root
 * @param {string} directory
 * @param {string} logPath
 * @param {AbortSignal | undefined} signal
 * @param {(error: Error) => void} onTerminationFailure
 * @returns {Promise<void>}
 */
async function uvSync(root, directory, logPath, signal, onTerminationFailure) {
    signal?.throwIfAborted();
    const log = await open(logPath, "w");
    let exitCode;
    try {
        signal?.throwIfAborted();
        const child = spawn("uv", ["sync", "--project", root, "--no-dev", "--locked"], {
            cwd: root,
            env: { ...process.env, UV_PROJECT_ENVIRONMENT: directory },
            stdio: ["ignore", log.fd, log.fd],
            windowsHide: true,
            // POSIX cancellation targets this preparation's process group, never
            // a published MCP server or its potentially shared Nexus workers.
            detached: process.platform !== "win32",
        });
        const exited = new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", resolve);
        });
        let cancellation;
        let cancellationError;
        const cancel = () => {
            const pid = child.pid;
            if (cancellation || !pid || child.exitCode !== null || child.signalCode !== null)
                return;
            // Preparation owns no database leases. Its unpublished build tree can
            // safely be terminated; unlike the server, it cannot finish after its
            // host dies because the host must publish or discard the environment.
            cancellation = (process.platform === "win32"
                ? promisify(execFile)("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 750 }).then(() => undefined)
                : Promise.resolve().then(() => { process.kill(-pid, "SIGKILL"); })).catch(error => {
                const diagnostic = new Error(`Could not terminate unpublished uv preparation ${pid}: ${error.message}; cleanup owner ${process.pid} will discard it after the build exits`);
                diagnostic.name = "PreparationTerminationError";
                cancellationError = diagnostic;
                // Report promptly, but remain the owner until the writer exits.
                onTerminationFailure(diagnostic);
            });
        };
        child.once("spawn", () => { if (signal?.aborted)
            cancel(); });
        if (signal?.aborted)
            cancel();
        else
            signal?.addEventListener("abort", cancel, { once: true });
        try {
            exitCode = await exited;
            await cancellation;
            if (cancellationError)
                throw cancellationError;
            signal?.throwIfAborted();
        }
        finally {
            signal?.removeEventListener("abort", cancel);
        }
    }
    catch (error) {
        if (error instanceof Error && error.name === "PreparationTerminationError")
            throw error;
        if (signal?.aborted)
            throw signal.reason;
        throw new Error(`Could not run uv to prepare the IDA MCP Python environment: ${error.message}`);
    }
    finally {
        await log.close();
    }
    if (exitCode !== 0) {
        const output = (await readFile(logPath, "utf8").catch(() => ""))
            .trimEnd()
            .split(/\r?\n/)
            .slice(-UV_LOG_TAIL_LINES)
            .join("\n");
        throw new Error(`uv sync failed (exit code ${exitCode}) preparing ${directory}\n${output}\nLog: ${logPath}`);
    }
}
