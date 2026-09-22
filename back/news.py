"""Protocol-1 news backend: lifecycle, Outbox and scheduler wiring."""

import json
import argparse
import os
from pathlib import Path
import queue
import sys
import threading
import time
from urllib.parse import urlsplit
from xml.parsers import expat

if __package__:
    from .classify import Classifier
    from .fetch import Fetcher
    from .scheduler import Scheduler
else:
    from classify import Classifier
    from fetch import Fetcher
    from scheduler import Scheduler


MAX_PACKET = 900 * 1024
BUSINESS = {"msg", "publish"}
_STOP = object()


def preflight(feeds_path, python_version=None, expat_version=None):
    """No network, no stdout. Preserve any error until hello supplies a seq."""
    python_version = python_version or sys.version_info[:3]
    expat_version = expat_version or expat.version_info
    if python_version < (3, 12):
        return [], "Python >= 3.12 is required"
    if expat_version < (2, 6):
        return [], "Expat >= 2.6 is required"
    try:
        feeds = json.loads(Path(feeds_path).read_text(encoding="utf-8"))
        if not isinstance(feeds, list) or not 1 <= len(feeds) <= 32:
            raise ValueError("feeds must be an array of 1..32 sources")
        for feed in feeds:
            if not isinstance(feed, dict):
                raise ValueError("each source must be an object")
            name, url = feed.get("name"), feed.get("url")
            if not isinstance(name, str) or not name.strip() or len(name) > 64:
                raise ValueError("source name must contain 1..64 characters")
            if not isinstance(url, str) or not url or any(c.isspace() for c in url):
                raise ValueError("source URL must be a nonempty URL without whitespace")
            parsed = urlsplit(url)
            if parsed.scheme not in ("http", "https") or not parsed.hostname:
                raise ValueError("source URL must use http or https with a host")
            if parsed.username is not None or parsed.password is not None:
                raise ValueError("source URL must not contain credentials")
            _ = parsed.port  # Reject malformed ports before ready.
        return feeds, None
    except (OSError, ValueError, UnicodeError) as exc:
        return [], ("feeds.json: " + str(exc))[:200]


class TestHooks:
    """Opt-in subprocess test gates. No hooks unless NEWS_TEST_DIR is set.

    Tests own this directory. Hooks never change production packet dispatch.
    Synthetic traffic in gate/flood mode isolates the Outbox from fetching;
    the manifest does not enable these environment variables.
    """

    def __init__(self):
        path = os.environ.get("NEWS_TEST_DIR")
        self.directory = Path(path) if path else None
        self.mode = os.environ.get("NEWS_TEST_MODE") if path else None

    def mark(self, name):
        if self.directory:
            (self.directory / name).touch()

    def before_write(self, packet):
        if not self.directory or packet["t"] != "msg":
            return
        self.mark("writer-entered")
        if self.mode == "gate":
            while not (self.directory / "writer-release").exists():
                time.sleep(0.002)

    def after_write(self, packet):
        if packet["t"] == "msg":
            self.mark("writer-flushed")

    def on_up(self, outbox, seq):
        if self.mode in ("gate", "flood"):
            payload = "x" * (800 * 1024 if self.mode == "flood" else 100)
            for i in range(8):
                outbox.put({"t": "msg", "seq": seq,
                            "body": {"op": "test", "index": i, "payload": payload}})
        self.mark("up-handled")


class Outbox:
    """One writer. Admission and terminal insertion share a lock.

    The writer never holds the admission lock while doing I/O. The bounded
    queue avoids growth if stdout stops draining. Control saturation is an
    internal error; business saturation discards the new packet.
    """

    def __init__(self, stream, hooks=None):
        self.stream = stream
        self.hooks = hooks or TestHooks()
        self.lock = threading.Lock()
        self.queue = queue.Queue(maxsize=32)
        self.closed = False
        self.terminal_sent = threading.Event()
        self.writer = threading.Thread(target=self._write, name="news-writer", daemon=True)
        self.writer.start()

    @staticmethod
    def encode(packet):
        data = (json.dumps(packet, ensure_ascii=True, allow_nan=False) + "\n").encode("ascii")
        if len(data) > MAX_PACKET:
            raise ValueError("protocol packet exceeds 900 KiB")
        return data

    def put(self, packet):
        data = self.encode(packet)
        with self.lock:
            if self.closed:
                return False
            try:
                self.queue.put_nowait((packet, data, False))
                return True
            except queue.Full:
                if packet["t"] in BUSINESS:
                    return False
                raise RuntimeError("control outbox full")

    def close_with(self, terminal=None):
        """Keep prior control packets; discard queued business, then seal.

        One business packet already held by the writer may finish before done.
        No packet can be admitted after the terminal packet.
        """
        data = self.encode(terminal) if terminal is not None else None
        with self.lock:
            if self.closed:
                return
            self.closed = True
            controls = []
            while True:
                try:
                    item = self.queue.get_nowait()
                except queue.Empty:
                    break
                if item[0]["t"] not in BUSINESS:
                    controls.append(item)
            # Protocol admits ready once; fail is terminal. Thus <= 1 queued
            # control here, leaving room for terminal and sentinel.
            for item in controls:
                self.queue.put_nowait(item)
            if terminal is not None:
                self.queue.put_nowait((terminal, data, True))
            self.queue.put_nowait(_STOP)
        self.hooks.mark("outbox-closed")

    def _write(self):
        try:
            while True:
                item = self.queue.get()
                if item is _STOP:
                    self.terminal_sent.set()
                    return
                packet, data, terminal = item
                self.hooks.before_write(packet)
                self.stream.write(data)
                self.stream.flush()
                self.hooks.after_write(packet)
                if terminal:
                    self.terminal_sent.set()
        except (OSError, ValueError):
            # Do not falsely acknowledge a failed write. shutdown's deadline
            # uses os._exit so interpreter flush cannot hang on a full pipe.
            return


def shutdown(outbox, terminal=None, code=0):
    outbox.close_with(terminal)
    if outbox.hooks.directory and terminal is not None:
        # Exercise a producer arriving after close through the real put path.
        accepted = outbox.put({"t": "msg", "seq": terminal["seq"],
                               "body": {"op": "test-late"}})
        outbox.hooks.mark("late-accepted" if accepted else "late-rejected")
    if not outbox.terminal_sent.wait(0.8):
        os._exit(code)
    return code


def valid_seq(value):
    return type(value) is int and 0 <= value < 2**53


def main(argv=None, scheduler_factory=Scheduler):
    parser = argparse.ArgumentParser()
    parser.add_argument("--allow-host", action="append", default=[])
    args = parser.parse_args(argv)
    fetcher = Fetcher(allow_hosts=args.allow_host)
    hooks = TestHooks()
    feeds_path = Path(__file__).with_name("feeds.json")
    if hooks.directory:
        feeds_path = os.environ.get("NEWS_TEST_FEEDS", feeds_path)
    classify_options = {}
    if hooks.directory:
        endpoint = os.environ.get("NEWS_TEST_JEV_URL")
        if endpoint:
            classify_options["endpoint"] = endpoint
    classifier = Classifier(**classify_options)
    feeds, error = preflight(feeds_path)
    hooks.mark("preflight-complete")
    outbox = Outbox(sys.stdout.buffer, hooks)
    seq = None
    running = False
    scheduler = None

    def finish():
        if scheduler is not None:
            scheduler.stop()
        return shutdown(outbox, {"t": "done", "seq": seq} if seq is not None else None)

    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return finish()
        try:
            packet = json.loads(line)
        except (ValueError, UnicodeError):
            print("discard: invalid JSON", file=sys.stderr, flush=True)
            continue
        if not isinstance(packet, dict) or not valid_seq(packet.get("seq")):
            print("discard: invalid seq", file=sys.stderr, flush=True)
            continue
        kind = packet.get("t")
        if seq is None:
            if kind != "hello":
                print("discard: expected hello", file=sys.stderr, flush=True)
                continue
            seq = packet["seq"]
            if error:
                return shutdown(outbox, {"t": "fail", "seq": seq, "reason": error}, 1)
            outbox.put({"t": "ready", "seq": seq})
        elif packet["seq"] != seq:
            print("discard: seq mismatch", file=sys.stderr, flush=True)
            hooks.mark("seq-discarded")
        elif kind == "bye":
            return finish()
        elif kind == "up" and not running:
            running = True
            # Writer-only stress tests use synthetic traffic, never live feeds.
            if hooks.mode not in ("gate", "flood"):
                options = {}
                if hooks.directory:
                    options = json.loads(os.environ.get("NEWS_TEST_SCHEDULER", "{}"))
                scheduler = scheduler_factory(feeds, fetcher, outbox, seq, classifier=classifier, **options)
                scheduler.start()
            hooks.on_up(outbox, seq)
        elif kind == "msg" and running:
            body = packet.get("body")
            if scheduler is not None and isinstance(body, dict) and body.get("op") == "refresh":
                scheduler.refresh()
        elif kind == "event":
            pass  # No subscribed topics.
        else:
            print("discard: unexpected message", file=sys.stderr, flush=True)


if __name__ == "__main__":
    sys.exit(main())
