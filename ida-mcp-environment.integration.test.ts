// Runs the real uv against a temporary copy of this package. Needs uv on PATH
// and its package cache or network access: `npm run test:integration`.
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  watch,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

import {
  environmentKey,
  preparePythonEnvironment,
} from "./ida-mcp-environment.mjs";

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));

async function packedPackage(base: string): Promise<string> {
  // npm supplies the actual CLI path to its test script on every platform.
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "run the package integration tests via npm run test:integration");
  const { stdout } = await promisify(execFile)(process.execPath, [npmCli, "pack", "--json", "--ignore-scripts", "--pack-destination", base], { cwd: PACKAGE_ROOT });
  const output: unknown = JSON.parse(stdout);
  assert.ok(Array.isArray(output) && output[0] && typeof output[0].filename === "string");
  const root = join(base, "node_modules", "ida-mcp");
  await mkdir(root, { recursive: true });
  await promisify(execFile)("tar", ["-xzf", join(base, output[0].filename), "-C", root, "--strip-components=1"]);
  return root;
}

for (const runtime of ["node", "bun"] as const) {
  test(`${runtime} npm-installed package prepares cold and reuses warm environment`, { timeout: 120_000 }, async (t) => {
    const command = runtime === "node" ? process.execPath : "bun";
    if (runtime === "bun" && spawnSync(command, ["--version"]).error?.message.includes("ENOENT")) {
      t.skip("Bun is not installed");
      return;
    }
    const base = await mkdtemp(join(tmpdir(), "ida-mcp-packed-cold-it-"));
    t.after(() => rm(base, { recursive: true, force: true }));
    const root = await packedPackage(base);
    const environmentUrl = pathToFileURL(join(root, "ida-mcp-environment.mjs")).href;
    const cacheRoot = join(base, "cache");
    const code = `
import assert from "node:assert/strict";
import { preparePythonEnvironment } from ${JSON.stringify(environmentUrl)};
const first = await preparePythonEnvironment(${JSON.stringify(root)}, { cacheRoot: ${JSON.stringify(cacheRoot)} });
const second = await preparePythonEnvironment(${JSON.stringify(root)}, { cacheRoot: ${JSON.stringify(cacheRoot)} });
assert.equal(first.prepared, true);
assert.equal(second.prepared, false);
assert.equal(first.python, second.python);
console.log("packed cold/warm PASS");
`;
    const { stdout } = await promisify(execFile)(command, ["--input-type=module", "-e", code], { env: { ...process.env, BUN_BE_BUN: "1" } });
    assert.equal(stdout.trim(), "packed cold/warm PASS");
  });
}

async function copyPackage(t: test.TestContext): Promise<{
  base: string;
  root: string;
  cacheRoot: string;
}> {
  const base = await mkdtemp(join(tmpdir(), "ida-mcp-environment-it-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "pkg");
  await mkdir(join(root, "ida_mcp"), { recursive: true });
  for (const file of [
    "pyproject.toml",
    "uv.lock",
    ".python-version",
    "README.md",
    "LICENSE",
  ]) {
    await copyFile(join(PACKAGE_ROOT, file), join(root, file));
  }
  for (const file of await readdir(join(PACKAGE_ROOT, "ida_mcp"))) {
    if (file.endsWith(".py")) {
      await copyFile(
        join(PACKAGE_ROOT, "ida_mcp", file),
        join(root, "ida_mcp", file),
      );
    }
  }
  return { base, root, cacheRoot: join(base, "cache") };
}

test(
  "concurrent first preparation syncs once and warm starts never resync",
  { timeout: 600_000 },
  async (t) => {
    const { base, root, cacheRoot } = await copyPackage(t);

    const results = await Promise.all([
      preparePythonEnvironment(root, { cacheRoot }),
      preparePythonEnvironment(root, { cacheRoot }),
    ]);
    assert.deepEqual(
      results.map((result) => result.prepared).sort(),
      [false, true],
      "the waiter must reuse the environment the first preparation finished",
    );
    assert.equal(results[0].python, results[1].python);
    const { python, directory } = results[0];
    assert.equal(relative(cacheRoot, directory).startsWith(".."), false);

    // The project is installed editable from the package root, with metadata.
    const { stdout } = await promisify(execFile)(
      python,
      [
        "-c",
        "import importlib.metadata as m, ida_mcp.cli as c; print(m.version('ida-mcp')); print(c.__file__)",
      ],
      { cwd: base },
    );
    const [version, cliPath] = stdout.trim().split(/\r?\n/);
    const pyproject = await readFile(join(root, "pyproject.toml"), "utf8");
    assert.equal(version, /^version = "(.+)"$/m.exec(pyproject)?.[1]);
    assert.equal(relative(root, cliPath), join("ida_mcp", "cli.py"));

    // A server keeps running from the environment while the package files are
    // touched, as a package manager reinstalling the same version does.
    const server = spawn(
      python,
      ["-c", "import ida_mcp.cli, sys; sys.stdin.read()"],
      { cwd: root, stdio: ["pipe", "ignore", "inherit"] },
    );
    const serverExit = new Promise<number | null>((resolve) =>
      server.once("exit", resolve),
    );
    t.after(() => server.stdin.end());
    await new Promise<void>((resolve, reject) => {
      server.once("spawn", resolve);
      server.once("error", reject);
    });
    const later = new Date(Date.now() + 60_000);
    for (const file of ["pyproject.toml", "uv.lock", "ida_mcp/cli.py"]) {
      await utimes(join(root, file), later, later);
    }

    assert.deepEqual(await preparePythonEnvironment(root, { cacheRoot }), {
      directory,
      python,
      prepared: false,
    });
    server.stdin.end();
    assert.equal(await serverExit, 0);
  },
);

test(
  "failed preparation is not marked ready and releases the lock",
  { timeout: 120_000 },
  async (t) => {
    const { root, cacheRoot } = await copyPackage(t);
    await writeFile(join(root, "pyproject.toml"), "not toml [");
    const key = await environmentKey(root);
    // A lock left behind by a crashed host is reclaimed.
    await mkdir(cacheRoot);
    const staleLock = join(cacheRoot, `${key}.lock`);
    await writeFile(staleLock, "");
    const longAgo = new Date(Date.now() - 3_600_000);
    await utimes(staleLock, longAgo, longAgo);
    // A published environment the user deleted is replaced, not trusted.
    await writeFile(join(cacheRoot, `${key}.ready`), `${key}-deleted`);

    await assert.rejects(preparePythonEnvironment(root, { cacheRoot }), {
      message: /uv sync failed/,
    });
    assert.equal(existsSync(join(cacheRoot, `${key}.ready`)), false);
    const leftovers = await readdir(cacheRoot, { withFileTypes: true });
    assert.deepEqual(
      leftovers.filter((entry) => entry.isDirectory()).map((e) => e.name),
      [],
      "a failed environment must not be left behind",
    );
    assert.equal(existsSync(staleLock), false);
    // The next start tries again instead of trusting a broken environment.
    await assert.rejects(preparePythonEnvironment(root, { cacheRoot }), {
      message: /uv sync failed/,
    });
  },
);

test(
  "hosts racing to reclaim a stale lock publish one environment",
  { timeout: 600_000 },
  async (t) => {
    const { root, cacheRoot } = await copyPackage(t);
    const key = await environmentKey(root);
    await mkdir(cacheRoot);
    const staleLock = join(cacheRoot, `${key}.lock`);
    await writeFile(staleLock, "");
    const longAgo = new Date(Date.now() - 3_600_000);
    await utimes(staleLock, longAgo, longAgo);

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        preparePythonEnvironment(root, { cacheRoot }),
      ),
    );
    assert.equal(
      results.filter((result) => result.prepared).length,
      1,
      "exactly one host creates the environment the others use",
    );
    assert.equal(new Set(results.map((result) => result.python)).size, 1);
    const entries = await readdir(cacheRoot, { withFileTypes: true });
    assert.deepEqual(
      entries.filter((entry) => entry.isDirectory()).map((e) => e.name),
      [relative(cacheRoot, results[0].directory)],
      "environments that lost the race are removed",
    );
    assert.equal(existsSync(staleLock), false);
  },
);

for (const runtime of ["node", "bun"] as const) {
for (const denied of [false, true]) {
test(`${runtime} aborted host ${denied ? "hands off after termination denial" : "cleans up its unpublished uv build"}`, { timeout: 60_000 }, async (t) => {
  const hostCommand = runtime === "node" ? process.execPath : "bun";
  if (runtime === "bun") {
    const available = spawnSync(hostCommand, ["--version"], { encoding: "utf8" });
    if (available.error && "code" in available.error && available.error.code === "ENOENT") {
      t.skip("Bun is not installed");
      return;
    }
    assert.equal(available.status, 0, available.stderr || available.error?.message);
  }
  if (denied && process.platform !== "win32") {
    t.skip("taskkill denial exercises the Windows termination path");
    return;
  }
  const base = await mkdtemp(join(tmpdir(), "ida-mcp-aborted-build-it-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = await packedPackage(base);
  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === "PATH") ?? "PATH";
  let childEnv = { ...process.env };
  if (denied) {
    // Execute a real failing taskkill replacement. The uv/build/owner
    // processes remain real and run independently of the host process.
    const shim = join(base, "denied-taskkill");
    await mkdir(shim);
    await copyFile(process.execPath, join(shim, "taskkill.exe"));
    const preload = join(base, "deny-taskkill.mjs");
    await writeFile(preload, `if (/taskkill[.]exe$/i.test(process.execPath)) { process.stderr.write("injected termination denied\\n"); process.exit(1); }`);
    childEnv = { ...childEnv, [pathKey]: `${shim}${delimiter}${process.env[pathKey]}`, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}` };
  }
  const cacheRoot = join(base, "cache");
  await writeFile(join(root, "pyproject.toml"), `[project]
name = "abort-fixture"
version = "1.0.0"
requires-python = ">=3.11"
[build-system]
requires = []
build-backend = "backend"
backend-path = ["."]
`);
  // A local stdlib-only PEP 517 backend: no network or third-party build
  // dependencies. Real sleeping processes cannot be controlled by fake timers.
  await writeFile(join(root, "backend.py"), `
import os, pathlib, subprocess, sys, time, zipfile
DIST = "abort_fixture-1.0.0.dist-info"
META = "Metadata-Version: 2.1\\nName: abort-fixture\\nVersion: 1.0.0\\n"
WHEEL = "Wheel-Version: 1.0\\nGenerator: fixture\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n"
def get_requires_for_build_editable(config_settings=None):
    return []
def prepare_metadata_for_build_editable(metadata_directory, config_settings=None):
    target = pathlib.Path(metadata_directory) / DIST
    target.mkdir()
    (target / "METADATA").write_text(META)
    (target / "WHEEL").write_text(WHEEL)
    return DIST
def build_editable(wheel_directory, config_settings=None, metadata_directory=None):
    if os.environ.get("ABORT_BUILD_MARKER"):
        descendant = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(2)"])
        marker = pathlib.Path(os.environ["ABORT_BUILD_MARKER"])
        temp = marker.with_suffix(".pending")
        temp.write_text(str(os.getpid()) + " " + str(descendant.pid))
        os.replace(temp, marker)
        time.sleep(3)
    filename = "abort_fixture-1.0.0-py3-none-any.whl"
    with zipfile.ZipFile(pathlib.Path(wheel_directory) / filename, "w") as wheel:
        wheel.writestr(DIST + "/METADATA", META)
        wheel.writestr(DIST + "/WHEEL", WHEEL)
        wheel.writestr(DIST + "/RECORD", "")
    return filename
`);
  await promisify(execFile)("uv", ["lock", "--offline", "--project", root]);
  const startedFile = join(root, "build-started");
  const launchedFile = join(root, "server-launched");
  const watchAbort = new AbortController();
  t.after(() => watchAbort.abort());
  const markerWatch = watch(root, { signal: watchAbort.signal });
  const building = (async () => {
    for await (const event of markerWatch) {
      if (event.filename === "build-started") return readFile(startedFile, "utf8");
    }
    throw new Error("build watcher closed without a marker");
  })();
  const transportUrl = pathToFileURL(join(PACKAGE_ROOT, "ida-mcp-transport.ts")).href;
  const environmentUrl = pathToFileURL(join(root, "ida-mcp-environment.mjs")).href;
  const hostCode = `
import { once } from "node:events";
import assert from "node:assert/strict";
import { EofStdioClientTransport } from ${JSON.stringify(transportUrl)};
import { preparePythonEnvironment } from ${JSON.stringify(environmentUrl)};
const transport = new EofStdioClientTransport(async signal => {
  await preparePythonEnvironment(process.env.FIXTURE_ROOT, { cacheRoot: process.env.FIXTURE_CACHE, signal });
  return { command: process.execPath, args: ["-e", "require('node:fs').writeFileSync(process.env.SERVER_MARKER, 'launched')"], cwd: process.env.FIXTURE_ROOT, env: process.env };
});
const started = transport.start().catch(error => {
  if (error.name !== "AbortError" && process.env.DENY_TERMINATION !== "1") throw error;
});
process.stdin.resume();
await once(process.stdin, "end");
if (process.env.DENY_TERMINATION === "1") {
  try { await transport.close(); assert.fail("termination denial must reject close"); }
  catch (error) {
    assert.match(error.message, /injected termination denied/);
    console.log(error.message);
  }
} else await transport.close();
await started;
`;
  const host = spawn(hostCommand, ["--input-type=module", "-e", hostCode], {
    env: { ...childEnv, UV_OFFLINE: "1", ABORT_BUILD_MARKER: startedFile, SERVER_MARKER: launchedFile, FIXTURE_ROOT: root, FIXTURE_CACHE: cacheRoot, DENY_TERMINATION: denied ? "1" : "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  host.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  host.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = once(host, "exit");
  const pids = (await Promise.race([
    building,
    exited.then(([code]) => { throw new Error(`host exited before build started (${code}): ${stderr}`); }),
  ])).trim().split(" ").map(Number);
  const shutdownAt = Date.now();
  host.stdin.end();
  const [exitCode] = await exited;
  assert.equal(exitCode, 0, stderr);
  assert.ok(Date.now() - shutdownAt < 2000, "preparation cancellation must fit the host shutdown budget");
  assert.equal(existsSync(launchedFile), false, "aborting preparation must not launch a server");
  if (denied) {
    process.kill(pids[0], 0);
    const entries = await readdir(cacheRoot, { withFileTypes: true });
    assert.equal(entries.filter(entry => entry.isDirectory()).length, 1, "live writer's staging must stay intact");
    assert.equal(entries.some(entry => entry.name.endsWith(".ready")), false, "aborted build must never publish");
    const ownerPid = Number(/cleanup owner (\d+)/.exec(stdout)?.[1]);
    assert.ok(ownerPid > 0, stdout);
    process.kill(ownerPid, 0);
    const deadline = Date.now() + 15_000;
    for (;;) {
      let ownerAlive = true;
      try { process.kill(ownerPid, 0); } catch { ownerAlive = false; }
      if (!ownerAlive && (await readdir(cacheRoot)).length === 0) break;
      assert.ok(Date.now() < deadline, "cleanup owner must eventually discard the finished build and exit");
      // Cross-process termination and cleanup are real integration effects.
      await delay(25);
    }
  }
  for (const pid of pids) {
    assert.throws(() => process.kill(pid, 0), `preparation process ${pid} is still alive`);
  }
  assert.deepEqual(await readdir(cacheRoot), [], "aborted preparation must remove its environment, log and lock");
  const retryAt = Date.now();
  // Import from the real packed installation, not the checkout's runtime.
  const { preparePythonEnvironment: prepareInstalled } = await import(environmentUrl);
  const next = await prepareInstalled(root, { cacheRoot });
  assert.equal(next.prepared, true);
  assert.ok(Date.now() - retryAt < 5000, "retry must not wait for a stale lock");
});
}
}
