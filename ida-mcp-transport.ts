import { spawn, type ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

import {
  ReadBuffer,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export interface ServerLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/**
 * MCP stdio client transport whose only shutdown signal is stdin EOF.
 *
 * The server owns its shutdown: on EOF it saves its databases and releases
 * Nexus leases, which can outlast any host budget. Signalling it, or its
 * process tree, could interrupt a save or kill a Nexus worker shared with
 * another session, so close() never does. It waits a bounded time for the
 * server to exit, then lets the host exit without it.
 *
 * The launch is resolved in start() so that closing during a slow preparation
 * aborts it and never spawns a server afterwards.
 */
export class EofStdioClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  /** Server stderr, available before start() so early output is not lost. */
  readonly stderr = new PassThrough();

  readonly #prepareLaunch: (signal: AbortSignal) => Promise<ServerLaunch>;
  readonly #closeGraceMs: number;
  readonly #abort = new AbortController();
  readonly #readBuffer = new ReadBuffer();
  #child: ChildProcess | undefined;
  #started = false;
  #closing = false;
  #closeNotified = false;
  #preparation: Promise<ServerLaunch> | undefined;

  constructor(
    prepareLaunch: (signal: AbortSignal) => Promise<ServerLaunch>,
    options: { closeGraceMs?: number } = {},
  ) {
    this.#prepareLaunch = prepareLaunch;
    this.#closeGraceMs = options.closeGraceMs ?? 1000;
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error("The IDA MCP transport already started");
    this.#started = true;

    const signal = this.#abort.signal;
    const launch = await Promise.race([
      (this.#preparation = this.#prepareLaunch(signal)),
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
    ]);
    signal.throwIfAborted();

    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // Windows kills a host's ordinary children, and the Nexus workers they
      // started, when the host exits. The server must outlive the host to
      // finish its EOF shutdown.
      detached: process.platform === "win32",
    });
    this.#child = child;
    child.stdout.on("data", (chunk: Buffer) => {
      // Keep draining after close so a shutting-down server never blocks on a
      // full pipe, but deliver nothing more.
      if (this.#closing) return;
      this.#readBuffer.append(chunk);
      this.#processReadBuffer();
    });
    child.stderr.pipe(this.stderr);
    child.stdin.on("error", (error) => this.onerror?.(error));
    child.stdout.on("error", (error) => this.onerror?.(error));
    child.once("close", () => this.#notifyClosed());

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.on("error", (error) => this.onerror?.(error));
  }

  send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.#child?.stdin;
    if (!stdin || this.#closing) {
      return Promise.reject(new Error("The IDA MCP server is not connected"));
    }
    return new Promise((resolve) => {
      if (stdin.write(serializeMessage(message))) resolve();
      else stdin.once("drain", resolve);
    });
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    this.#abort.abort();
    // Await cancellation or an acknowledged independent cleanup owner. Report
    // an OS termination denial without disguising it as ordinary EOF/abort.
    let preparationError: unknown;
    await this.#preparation?.catch((error: unknown) => {
      if (!(error instanceof Error && error.name === "AbortError")) preparationError = error;
    });

    const child = this.#child;
    if (child) {
      child.stdin?.end();
      if (child.exitCode === null && child.signalCode === null) {
        let timer: NodeJS.Timeout | undefined;
        await new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.#closeGraceMs);
          child.once("exit", () => resolve());
        });
        clearTimeout(timer);
      }
      // A server still shutting down keeps running on its own; it must not
      // keep the host alive. Node pipes also need unref; Bun child pipes do
      // not expose that method, and child.unref() suffices there.
      child.unref();
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        if (stream && "unref" in stream && typeof stream.unref === "function") {
          stream.unref();
        }
      }
    }
    this.#readBuffer.clear();
    this.#notifyClosed();
    if (preparationError !== undefined) throw preparationError;
  }

  #processReadBuffer(): void {
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.#readBuffer.readMessage();
      } catch (error) {
        this.onerror?.(error as Error);
        continue;
      }
      if (message === null) return;
      this.onmessage?.(message);
    }
  }

  #notifyClosed(): void {
    if (this.#closeNotified) return;
    this.#closeNotified = true;
    this.onclose?.();
  }
}
