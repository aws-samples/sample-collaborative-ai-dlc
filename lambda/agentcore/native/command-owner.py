"""Per-command Linux ownership, not a service or a hostile-code sandbox.

Subreaping preserves ownership when ordinary CLI tools double-fork or setsid.
Only direct children are signalled, using pidfds; killing a parent adopts its
remaining descendants here. No UID-wide/process-table scan or numeric-PID kill.
The command never inherits the private status pipe.
"""

import ctypes
import errno
import json
import os
import signal
import subprocess
import sys
import time


def main():
    stopping = False
    primary_status = None
    cleanup_deadline = None
    status_fd = 3
    os.set_inheritable(status_fd, False)

    def stop(_signal, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    # Fail before starting executable code if the kernel lacks ownership support.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), "subreaper unavailable")
    own_fd = os.pidfd_open(os.getpid())
    signal.pidfd_send_signal(own_fd, 0)
    os.close(own_fd)
    # Python can coerce LC_CTYPE during startup. Preserve precisely the explicit
    # environment supplied by Node, including absence of locale/Python settings.
    with open("/proc/self/environ", "rb") as source:
        environment = dict(
            tuple(os.fsdecode(field).split("=", 1))
            for field in source.read().split(b"\0")
            if field
        )
    try:
        command = subprocess.Popen(sys.argv[1:], env=environment, close_fds=True)
    except OSError as error:
        os.write(status_fd, json.dumps({
            "cleanupComplete": True, "exitCode": None, "signal": None,
            "spawnError": errno.errorcode.get(error.errno, "SPAWN_FAILED"),
        }).encode())
        return

    while True:
        # This single thread is the sole reaper. An enumerated child cannot have
        # its PID reused before we open its pidfd, even if it exits in between.
        no_children = False
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                no_children = True
                break
            if pid == 0:
                break
            if pid == command.pid:
                primary_status = os.waitstatus_to_exitcode(status)
                command.returncode = primary_status
                stopping = True
        if no_children:
            if primary_status is None:
                raise RuntimeError("missing command exit")
            os.write(status_fd, json.dumps({
                "cleanupComplete": True,
                "exitCode": primary_status if primary_status >= 0 else None,
                "signal": signal.Signals(-primary_status).name if primary_status < 0 else None,
                "spawnError": None,
            }).encode())
            return
        if stopping:
            if cleanup_deadline is None:
                cleanup_deadline = time.monotonic() + 0.65
            if time.monotonic() >= cleanup_deadline:
                # No success receipt: Node poisons the runtime on incomplete cleanup.
                return
            with open(f"/proc/self/task/{os.getpid()}/children", "rb") as source:
                children = source.read(65537)
            if len(children) > 65536:
                raise RuntimeError("child inventory bound")
            for child in children.split():
                try:
                    descriptor = os.pidfd_open(int(child))
                except ProcessLookupError:
                    continue
                try:
                    signal.pidfd_send_signal(descriptor, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                finally:
                    os.close(descriptor)
        time.sleep(0.005 if stopping else 0.01)


try:
    main()
except Exception:
    # No paths, argv, environment, or raw exception text on the diagnostic pipe.
    pass
