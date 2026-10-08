import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  access,
  link,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

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

export interface PythonEnvironment {
  directory: string;
  python: string;
  /** Whether this call created the returned environment. */
  prepared: boolean;
}

/** Per-user cache directory, outside the package so updates never touch it. */
export function defaultEnvironmentCacheRoot(): string {
  if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
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
export async function environmentKey(packageRoot: string): Promise<string> {
  const root = await realpath(packageRoot);
  const hash = createHash("sha256").update(`ida-mcp-env-v1\0${root}\0`);
  for (const name of KEY_INPUTS) {
    let content: Buffer | undefined;
    try {
      content = await readFile(join(root, name));
    } catch (error) {
      if (
        name !== OPTIONAL_KEY_INPUT ||
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw error;
      }
    }
    hash.update(`${name}\0${content?.length ?? -1}\0`);
    if (content) hash.update(content);
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
 * Aborting cancels only an unpublished uv preparation and its build processes.
 * Cleanup and lock release finish before preparation rejects.
 */
export async function preparePythonEnvironment(
  packageRoot: string,
  options: { cacheRoot?: string; signal?: AbortSignal } = {},
): Promise<PythonEnvironment> {
  const { cacheRoot = defaultEnvironmentCacheRoot(), signal } = options;
  const root = await realpath(packageRoot);
  const key = await environmentKey(root);
  const markerPath = join(cacheRoot, `${key}.ready`);
  const pythonIn = (directory: string) =>
    process.platform === "win32"
      ? join(directory, "Scripts", "python.exe")
      : join(directory, "bin", "python");
  const readMarker = () =>
    readFile(markerPath, "utf8").then(
      (name) => name.trim(),
      () => undefined,
    );
  const environmentNamed = async (
    name: string | undefined,
  ): Promise<PythonEnvironment | undefined> => {
    if (!name) return undefined;
    const directory = join(cacheRoot, name);
    const python = pythonIn(directory);
    return access(python).then(
      () => ({ directory, python, prepared: false }),
      () => undefined,
    );
  };

  const ready = await environmentNamed(await readMarker());
  if (ready) return ready;

  await mkdir(cacheRoot, { recursive: true });
  const releaseLock = await acquireLock(join(cacheRoot, `${key}.lock`), signal);
  try {
    const name = await readMarker();
    const readyNow = await environmentNamed(name);
    if (readyNow) return readyNow;
    // The published environment was deleted; nothing can run from it.
    if (name) await discardMarker(markerPath, name);

    const directory = join(cacheRoot, `${key}-${randomBytes(4).toString("hex")}`);
    try {
      await uvSync(root, directory, `${directory}.log`, signal);
    } catch (error) {
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      if (signal?.aborted) await rm(`${directory}.log`, { force: true });
      throw error;
    }
    await rm(`${directory}.log`, { force: true });

    // Publish atomically: a hard link exposes the fully written marker and
    // never replaces one another host published.
    const pendingMarker = `${directory}.ready`;
    await writeFile(pendingMarker, basename(directory));
    try {
      await link(pendingMarker, markerPath);
    } catch (error) {
      // Either way this directory is never used.
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Another host published first: use its environment.
      const winner = await environmentNamed(await readMarker());
      if (!winner) {
        throw new Error(`Unusable IDA MCP environment marker ${markerPath}`);
      }
      return winner;
    } finally {
      await rm(pendingMarker, { force: true });
    }
    return { directory, python: pythonIn(directory), prepared: true };
  } finally {
    await releaseLock();
  }
}

/**
 * Remove the marker if it still names `name`. It is moved aside atomically,
 * and a marker another host published meanwhile is linked back.
 */
async function discardMarker(markerPath: string, name: string): Promise<void> {
  const discarded = `${markerPath}.${randomBytes(4).toString("hex")}.discard`;
  try {
    await rename(markerPath, discarded);
  } catch {
    return;
  }
  const moved = await readFile(discarded, "utf8").catch(() => "");
  if (moved.trim() !== name) {
    await link(discarded, markerPath).catch(() => undefined);
  }
  await rm(discarded, { force: true });
}

async function acquireLock(
  path: string,
  signal: AbortSignal | undefined,
): Promise<() => Promise<void>> {
  const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
  let deletePendingRetries = 0;
  for (;;) {
    signal?.throwIfAborted();
    try {
      await writeFile(path, token, { flag: "wx" });
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Windows reports EPERM while a released lock file is being deleted;
      // persistent EPERM is a real permission problem.
      const deletePending =
        code === "EPERM" &&
        process.platform === "win32" &&
        ++deletePendingRetries < 50;
      if (code !== "EEXIST" && !deletePending) throw error;
    }
    const age = await stat(path).then(
      (stats) => Date.now() - stats.mtimeMs,
      () => undefined,
    );
    if (age !== undefined && age > LOCK_STALE_MS) {
      await rm(path, { force: true }).catch(() => undefined);
      continue;
    }
    // A lock released meanwhile is retried at once.
    if (age !== undefined) await delay(LOCK_POLL_MS, undefined, { signal });
    else if (deletePendingRetries > 0) await delay(10, undefined, { signal });
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

async function uvSync(
  root: string,
  directory: string,
  logPath: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  signal?.throwIfAborted();
  const log = await open(logPath, "w");
  let exitCode: number | null;
  try {
    signal?.throwIfAborted();
    const child = spawn(
      "uv",
      ["sync", "--project", root, "--no-dev", "--locked"],
      {
        cwd: root,
        env: { ...process.env, UV_PROJECT_ENVIRONMENT: directory },
        stdio: ["ignore", log.fd, log.fd],
        windowsHide: true,
        // POSIX cancellation targets this preparation's process group, never
        // a published MCP server or its potentially shared Nexus workers.
        detached: process.platform !== "win32",
      },
    );
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    let cancellation: Promise<void> | undefined;
    let cancellationError: unknown;
    const cancel = () => {
      const pid = child.pid;
      if (cancellation || !pid || child.exitCode !== null || child.signalCode !== null) return;
      // Preparation owns no database leases. Its unpublished build tree can
      // safely be terminated; unlike the server, it cannot finish after its
      // host dies because the host must publish or discard the environment.
      cancellation = (process.platform === "win32"
        ? promisify(execFile)("taskkill", ["/PID", String(pid), "/T", "/F"]).then(() => undefined)
        : Promise.resolve().then(() => { process.kill(-pid, "SIGKILL"); })
      ).catch(error => { cancellationError = error; });
    };
    child.once("spawn", () => { if (signal?.aborted) cancel(); });
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
    try {
      exitCode = await exited;
      await cancellation;
      if (cancellationError) throw cancellationError;
      signal?.throwIfAborted();
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new Error(
      `Could not run uv to prepare the IDA MCP Python environment: ${(error as Error).message}`,
    );
  } finally {
    await log.close();
  }

  if (exitCode !== 0) {
    const output = (await readFile(logPath, "utf8").catch(() => ""))
      .trimEnd()
      .split(/\r?\n/)
      .slice(-UV_LOG_TAIL_LINES)
      .join("\n");
    throw new Error(
      `uv sync failed (exit code ${exitCode}) preparing ${directory}\n${output}\nLog: ${logPath}`,
    );
  }
}
