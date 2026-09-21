"""Own the go-run process group and always reap it, including on check failure."""
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
SHELL = Path('/Users/gatewenlee/Code/modudock/shell')
MODULES = ROOT.parent


def main():
    # Do not accidentally validate an unrelated shell already on this port.
    with socket.socket() as probe:
        # Match a restartable server: TIME_WAIT is not an active listener.
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(('127.0.0.1', 8731))
        probe.listen(1)
    with tempfile.TemporaryFile() as log:
        process = subprocess.Popen(
            ['go', 'run', './cmd/modudock', '-addr', '127.0.0.1:8731', '-modules', str(MODULES)],
            cwd=SHELL, stdout=log, stderr=log, start_new_session=True)
        try:
            deadline = time.monotonic() + 60
            while True:
                if process.poll() is not None:
                    raise RuntimeError('shell exited during startup')
                # pread does not change the offset shared with the child's
                # stdout/stderr; seeking here could overwrite its next log.
                output = os.pread(log.fileno(), 1024 * 1024, 0).decode(errors='replace')
                if 'modudock: listening on 127.0.0.1:8731,' in output:
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError('shell startup timeout')
                time.sleep(0.05)
            print('START: go run ./cmd/modudock -addr 127.0.0.1:8731 -modules ' + str(MODULES), flush=True)
            subprocess.run(['node', str(ROOT / 'scripts/check-catalog.mjs')], check=True, timeout=10)
        finally:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=3)
            finally:
                # go run and the compiled shell share our dedicated group.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait(timeout=3)
                log.seek(0)
                print(log.read().decode(errors='replace').rstrip(), flush=True)
            print('STOP: owned shell process group terminated', flush=True)


if __name__ == '__main__':
    main()
