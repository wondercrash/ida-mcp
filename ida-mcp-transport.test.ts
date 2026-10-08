import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import {
  EofStdioClientTransport,
  type ServerLaunch,
} from "./ida-mcp-transport.ts";

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));

// A real MCP server that, like the IDA server saving its databases, needs a
// while after stdin EOF before it exits on its own.
const SLOW_EOF_SERVER = `
import { writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
const server = new McpServer({ name: "fixture", version: "1.0.0" });
server.registerTool("ping", { description: "ping" }, async () => ({
  content: [{ type: "text", text: "pong" }],
}));
process.stdin.once("end", () => {
  setTimeout(() => {
    writeFileSync(process.env.SAVED_FILE, String(process.pid));
    process.exit(0);
  }, Number(process.env.SAVE_DELAY_MS));
});
await server.connect(new StdioServerTransport());
`;

function nodeLaunch(code: string, env: Record<string, string>): ServerLaunch {
  return {
    command: process.execPath,
    args: ["--input-type=module", "-e", code],
    cwd: PACKAGE_ROOT,
    env: { ...(process.env as Record<string, string>), ...env },
  };
}

async function tempDir(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ida-mcp-transport-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// These tests drive real child processes, whose exit and file writes have no
// in-process event to await, so polling the observable effect is the signal.
async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("close sends EOF and lets the server finish its own shutdown", async (t) => {
  const savedFile = join(await tempDir(t), "saved");
  const transport = new EofStdioClientTransport(
    async () =>
      nodeLaunch(SLOW_EOF_SERVER, {
        SAVED_FILE: savedFile,
        SAVE_DELAY_MS: "2500",
      }),
    { closeGraceMs: 300 },
  );
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["ping"],
  );

  const closeStarted = Date.now();
  await client.close();
  assert.ok(
    Date.now() - closeStarted < 1000,
    "close must return after its bounded grace period",
  );
  assert.equal(existsSync(savedFile), false);

  // The server is never signalled: it only completes its "save" (2.5 s after
  // EOF) if close left it alone.
  await waitFor(() => existsSync(savedFile), 10_000, "the server save");
  const pid = Number(await readFile(savedFile, "utf8"));
  await waitFor(() => !isAlive(pid), 5000, "the server to exit");
});

// Exercise the embedded Bun host as well as Node. Bun is not installed in the
// upstream Node-only CI job, so skip only that case when it is unavailable.
for (const runtime of ["node", "bun"] as const) {
test(`${runtime} host can exit while the server is still shutting down`, async (t) => {
  const hostCommand = runtime === "node" ? process.execPath : "bun";
  if (runtime === "bun") {
    const available = spawnSync(hostCommand, ["--version"], { encoding: "utf8" });
    if (available.error && "code" in available.error && available.error.code === "ENOENT") {
      t.skip("Bun is not installed");
      return;
    }
    assert.equal(available.status, 0, available.stderr || available.error?.message);
  }
  const savedFile = join(await tempDir(t), "saved");
  const launch = nodeLaunch(SLOW_EOF_SERVER, {
    SAVED_FILE: savedFile,
    SAVE_DELAY_MS: "3000",
  });
  const transportUrl = pathToFileURL(
    join(PACKAGE_ROOT, "ida-mcp-transport.ts"),
  ).href;
  const hostCode = `
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { EofStdioClientTransport } from ${JSON.stringify(transportUrl)};
const launch = JSON.parse(process.env.FIXTURE_LAUNCH);
const client = new Client({ name: "host", version: "1.0.0" });
let closed = false;
client.onclose = () => { closed = true; };
await client.connect(new EofStdioClientTransport(async () => launch, { closeGraceMs: 200 }));
await client.listTools();
await client.close();
assert.equal(closed, true, "close must notify the client before resolving");
`;
  const host = spawn(
    hostCommand,
    ["--input-type=module", "-e", hostCode],
    {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, FIXTURE_LAUNCH: JSON.stringify(launch) },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let hostStderr = "";
  host.stderr.on("data", (chunk: Buffer) => {
    hostStderr += chunk.toString("utf8");
  });
  const hostExit = await new Promise<number | null>((resolve) =>
    host.once("exit", resolve),
  );
  assert.equal(hostExit, 0, hostStderr);
  assert.equal(
    existsSync(savedFile),
    false,
    "the host must not wait for the server's shutdown",
  );

  // On Windows a host's ordinary children die with it; the server must survive
  // to finish its save after the host is gone.
  await waitFor(() => existsSync(savedFile), 10_000, "the server save");
});
}

test("close during preparation prevents a late server launch", async () => {
  let finishPreparation: (() => void) | undefined;
  const preparation = new Promise<void>((resolve) => {
    finishPreparation = resolve;
  });
  let preparationAborted = false;
  let launchUsed = false;
  const launch = nodeLaunch("", {});
  const transport = new EofStdioClientTransport(async (signal) => {
    signal.addEventListener("abort", () => {
      preparationAborted = true;
      finishPreparation?.();
    });
    await preparation;
    return {
      ...launch,
      get command() {
        launchUsed = true;
        return launch.command;
      },
    };
  });

  const started = transport.start();
  await new Promise((resolve) => setImmediate(resolve));
  await transport.close();
  await assert.rejects(started);
  assert.equal(preparationAborted, true);

  // Preparation outliving the session must not spawn the server afterwards.
  finishPreparation?.();
  await preparation;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(launchUsed, false);
});

test("reports a server that exits on its own as closed", async () => {
  const transport = new EofStdioClientTransport(async () =>
    nodeLaunch("process.exit(3);", {}),
  );
  const closed = new Promise<void>((resolve) => {
    transport.onclose = resolve;
  });
  await transport.start();
  await closed;
  await transport.close();
});
