import { prepareOwnedPythonEnvironment } from "./ida-mcp-environment.mjs";
// This process owns only cold preparation, never the MCP server. Keeping the
// owner separate lets a host leave after a denied termination while the owner
// still waits for the writer, discards staging and releases its token lock.
const abort = new AbortController();
process.on("message", (message) => {
    if (message && typeof message === "object" && "type" in message && message.type === "cancel") {
        abort.abort();
    }
});
process.on("disconnect", () => abort.abort());
process.send?.({ type: "ready" });
let report;
try {
    const environment = await prepareOwnedPythonEnvironment(process.argv[2], {
        cacheRoot: process.argv[3],
        signal: abort.signal,
        onTerminationFailure(error) {
            if (process.connected) {
                process.send?.({ type: "deferred", error: { name: error.name, message: error.message } });
            }
        },
    });
    report = { type: "result", environment };
}
catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    report = { type: "error", error: { name: failure.name, message: failure.message } };
}
// Do not leave an IPC channel or heartbeat keeping a finished owner alive.
if (process.connected && process.send) {
    process.send(report, () => process.exit(0));
}
else {
    process.exit(0);
}
