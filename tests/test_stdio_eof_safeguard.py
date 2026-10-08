"""Subprocess regressions for the stdio EOF exit safeguard.

Each scenario runs ``serve_stdio`` in a child interpreter because the safeguard
ends the whole process; the child shortens the grace period on the module
before serving. A stranded loop is modelled by blocking the event-loop thread,
which, like a lost Proactor wakeup, leaves thread-safe callbacks unprocessed.
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

_GRACE_SECONDS = 0.2
_PROCESS_TIMEOUT_SECONDS = 15

_CHILD_SCRIPT = """
import asyncio
import sys
import threading
import time
from pathlib import Path

from ida_mcp import mcp as mcp_api

scenario = sys.argv[1]
release_path = Path(sys.argv[2])
grace = float(sys.argv[3])
mcp_api.EOF_EXIT_GRACE_SECONDS = grace


def report_threads_and_survive():
    time.sleep(grace * 5)
    alive = [
        thread.name
        for thread in threading.enumerate()
        if thread is not threading.main_thread()
    ]
    print(f"threads={alive}", flush=True)
    print("survived", flush=True)
    sys.exit(3)


if scenario == "arm-after-cancel":
    safeguard = mcp_api._EOFExitSafeguard(grace)
    safeguard.cancel()
    safeguard.arm(asyncio.new_event_loop())
    report_threads_and_survive()


if scenario in ("late-answer", "loop-closed"):
    exit_waiting = threading.Event()
    next_probe = threading.Event()
    trace_lock = threading.Lock()
    trace_lock.acquire()

    class TrackingTraceLock:
        def __enter__(self):
            exit_waiting.set()
            trace_lock.acquire()

        def __exit__(self, *_args):
            trace_lock.release()

    class FakeLoop:
        closed = False
        first_callback = None

        def call_soon_threadsafe(self, callback):
            if self.closed:
                raise RuntimeError("loop closed")
            if self.first_callback is None:
                self.first_callback = callback
            else:
                callback()
                next_probe.set()

        def is_closed(self):
            return self.closed

    mcp_api.TRACE._lock = TrackingTraceLock()
    loop = FakeLoop()
    safeguard = mcp_api._EOFExitSafeguard(grace)
    safeguard.arm(loop)
    assert exit_waiting.wait(5), "watcher never reached trace-lock wait"
    if scenario == "late-answer":
        loop.first_callback()
        print("late-answer", flush=True)
    else:
        loop.closed = True
        print("loop-closed", flush=True)
    trace_lock.release()
    if scenario == "late-answer":
        assert next_probe.wait(5), "watcher did not resume probes"
        print("probe-resumed", flush=True)
    else:
        safeguard._thread.join(5)
        assert not safeguard._thread.is_alive(), "closed-loop watcher did not stop"
    safeguard.cancel()
    report_threads_and_survive()


class FakeManager:
    def __init__(self, **_kwargs):
        self.started = False

    def schedule_startup_open(self, _database):
        pass

    def shutdown(self):
        # Like DatabaseManager, shutdown is one-way even when it fails.
        if self.started:
            return
        self.started = True
        if scenario == "blocked":
            print("shutdown-blocked", flush=True)
            while not release_path.exists():
                time.sleep(0.02)
        if scenario == "release-error":
            print("shutdown-failed", flush=True)
            raise RuntimeError("release failed")
        print("shutdown-complete", flush=True)


if scenario == "trace-error":
    emit = mcp_api.TRACE.emit

    def failing_emit(event, **fields):
        if event == "mcp_stopped":
            print("trace-failed", flush=True)
            raise OSError("trace write failed")
        emit(event, **fields)

    mcp_api.TRACE.emit = failing_emit


def strand_event_loop():
    print("loop-stranded", flush=True)
    threading.Event().wait()


async def stdio_async(stdin=None, stdout=None):
    slow = None
    if scenario in ("slow-tool", "slow-then-stranded"):
        mcp_api.TRACE.emit("tool_call", tool="slow")
        slow = asyncio.create_task(asyncio.to_thread(time.sleep, grace * 5))
    try:
        while await asyncio.to_thread(stdin.readline):
            pass
    except Exception as error:
        print(f"read-failed {type(error).__name__}", flush=True)
        strand_event_loop()
    if slow is not None:
        await slow
        mcp_api.TRACE.emit("tool_result", tool="slow")
        print("slow-result", flush=True)
    if scenario in ("stranded", "blocked", "slow-then-stranded"):
        strand_event_loop()


mcp_api.mcp.stdio_async = stdio_async
mcp_api.serve_stdio(database_manager_class=FakeManager)
print("serve-returned", flush=True)
print(f"trace={mcp_api.TRACE.path}", flush=True)
report_threads_and_survive()
"""


def _start_child(
    scenario: str, tmp_path: Path, release_path: Path | None = None
) -> subprocess.Popen[str]:
    environment = dict(os.environ, IDA_MCP_STATE_DIR=str(tmp_path / "state"))
    process = subprocess.Popen(
        [
            sys.executable,
            "-c",
            _CHILD_SCRIPT,
            scenario,
            str(release_path or tmp_path / "unused"),
            str(_GRACE_SECONDS),
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=environment,
    )
    assert process.stdin is not None
    process.stdin.close()
    return process


def _finish(process: subprocess.Popen[str]) -> tuple[str, str]:
    try:
        return process.communicate(timeout=_PROCESS_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        process.kill()
    stdout, stderr = process.communicate()
    pytest.fail(
        "stdio server did not exit after EOF cleanup\n"
        f"stdout:\n{stdout}\nstderr:\n{stderr}"
    )


def _read_until(process: subprocess.Popen[str], marker: str) -> list[str]:
    assert process.stdout is not None
    lines: list[str] = []
    while (line := process.stdout.readline()) != "":
        lines.append(line.rstrip("\n"))
        if lines[-1] == marker:
            return lines
    pytest.fail(f"child exited before {marker!r}; stdout: {lines}")


def _assert_exits_after_unanswered_grace(
    process: subprocess.Popen[str], lines: list[str]
) -> list[str]:
    stranded_at = time.monotonic()
    stdout, stderr = _finish(process)

    assert process.returncode == 0, stderr
    assert time.monotonic() - stranded_at >= _GRACE_SECONDS
    return lines + stdout.splitlines()


def test_stranded_event_loop_exits_after_completed_eof_cleanup(
    tmp_path: Path,
) -> None:
    process = _start_child("stranded", tmp_path)
    lines = _read_until(process, "loop-stranded")

    assert _assert_exits_after_unanswered_grace(process, lines) == [
        "shutdown-complete",
        "loop-stranded",
    ]


def test_stranded_event_loop_waits_for_blocked_eof_cleanup(tmp_path: Path) -> None:
    release_path = tmp_path / "release"
    process = _start_child("blocked", tmp_path, release_path)
    assert _read_until(process, "shutdown-blocked") == ["shutdown-blocked"]

    time.sleep(_GRACE_SECONDS * 5)
    assert process.poll() is None

    release_path.touch()
    lines = _read_until(process, "loop-stranded")
    assert _assert_exits_after_unanswered_grace(process, lines) == [
        "shutdown-complete",
        "loop-stranded",
    ]


def test_stranded_event_loop_exits_when_trace_stop_fails_after_release(
    tmp_path: Path,
) -> None:
    process = _start_child("trace-error", tmp_path)
    lines = _read_until(process, "loop-stranded")

    assert _assert_exits_after_unanswered_grace(process, lines) == [
        "shutdown-complete",
        "trace-failed",
        "read-failed OSError",
        "loop-stranded",
    ]


def test_failed_lease_release_never_forces_exit(tmp_path: Path) -> None:
    process = _start_child("release-error", tmp_path)
    lines = _read_until(process, "loop-stranded")

    time.sleep(_GRACE_SECONDS * 5)
    alive = process.poll() is None
    process.kill()
    stdout, _stderr = process.communicate()

    assert alive
    assert lines + stdout.splitlines() == [
        "shutdown-failed",
        "read-failed RuntimeError",
        "loop-stranded",
    ]


def test_responsive_loop_finishes_slow_tool_after_eof_cleanup(
    tmp_path: Path,
) -> None:
    process = _start_child("slow-tool", tmp_path)

    stdout, stderr = _finish(process)

    assert process.returncode == 3, stderr
    lines = stdout.splitlines()
    trace_line = lines.pop(3)
    assert lines == [
        "shutdown-complete",
        "slow-result",
        "serve-returned",
        "threads=[]",
        "survived",
    ]
    trace_path = Path(trace_line.removeprefix("trace="))
    events = [
        json.loads(record)["event"]
        for record in trace_path.read_text(encoding="utf-8").splitlines()
    ]
    assert events == ["mcp_started", "tool_call", "mcp_stopped", "tool_result"]


def test_event_loop_stranded_after_slow_tool_reply_still_exits(
    tmp_path: Path,
) -> None:
    process = _start_child("slow-then-stranded", tmp_path)
    lines = _read_until(process, "loop-stranded")

    assert _assert_exits_after_unanswered_grace(process, lines) == [
        "shutdown-complete",
        "slow-result",
        "loop-stranded",
    ]


def test_normal_stdio_shutdown_cancels_exit_safeguard(tmp_path: Path) -> None:
    process = _start_child("normal", tmp_path)

    stdout, stderr = _finish(process)

    assert process.returncode == 3, stderr
    lines = stdout.splitlines()
    assert lines.pop(2).startswith("trace=")
    assert lines == [
        "shutdown-complete",
        "serve-returned",
        "threads=[]",
        "survived",
    ]


def test_safeguard_armed_after_cancel_never_starts(tmp_path: Path) -> None:
    process = _start_child("arm-after-cancel", tmp_path)

    stdout, stderr = _finish(process)

    assert process.returncode == 3, stderr
    assert stdout.splitlines() == ["threads=[]", "survived"]


@pytest.mark.parametrize("scenario", ["late-answer", "loop-closed"])
def test_watchdog_rechecks_liveness_after_waiting_for_trace_lock(
    tmp_path: Path, scenario: str
) -> None:
    process = _start_child(scenario, tmp_path)
    stdout, stderr = _finish(process)

    assert process.returncode == 3, stderr
    expected = [scenario]
    if scenario == "late-answer":
        expected.append("probe-resumed")
    assert stdout.splitlines() == expected + ["threads=[]", "survived"]
