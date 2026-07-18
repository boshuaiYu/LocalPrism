"""Wait for Codex app-server login completion. Manual opt-in only.

Usage:
  python .tmp/probe_login_wait.py
  python .tmp/probe_login_wait.py --mode device
  python .tmp/probe_login_wait.py --codex C:\\path\\to\\codex.exe
"""

from __future__ import annotations

import argparse
import json
import queue
import subprocess
import sys
import threading
import time
from typing import Any


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--codex", default="codex")
    parser.add_argument("--mode", choices=("browser", "device"), default="browser")
    parser.add_argument("--timeout", type=float, default=180.0)
    args = parser.parse_args()

    proc = subprocess.Popen(
        [args.codex, "app-server", "--listen", "stdio://"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    out_q: queue.Queue[str] = queue.Queue()
    err_q: queue.Queue[str] = queue.Queue()

    def reader(stream: Any, target: queue.Queue[str]) -> None:
        for line in stream:
            target.put(line)

    threading.Thread(target=reader, args=(proc.stdout, out_q), daemon=True).start()
    threading.Thread(target=reader, args=(proc.stderr, err_q), daemon=True).start()

    req_id = 0

    def send(method: str, params: dict[str, Any] | None = None, *, notify: bool = False) -> int | None:
        nonlocal req_id
        msg: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if not notify:
            req_id += 1
            msg["id"] = req_id
        if params is not None:
            msg["params"] = params
        line = json.dumps(msg)
        print(">>", line, flush=True)
        assert proc.stdin is not None
        proc.stdin.write(line + "\n")
        proc.stdin.flush()
        return None if notify else req_id

    def recv_until(expect_id: int | None = None, timeout: float = 8.0) -> list[dict[str, Any]]:
        end = time.time() + timeout
        msgs: list[dict[str, Any]] = []
        while time.time() < end:
            try:
                line = out_q.get(timeout=0.2)
            except queue.Empty:
                continue
            print("<<", line.rstrip(), flush=True)
            try:
                msg = json.loads(line)
            except Exception:
                continue
            msgs.append(msg)
            if expect_id is not None and msg.get("id") == expect_id:
                return msgs
        return msgs

    try:
        rid = send(
            "initialize",
            {
                "clientInfo": {"name": "claude-prism-probe-wait", "version": "0.0.0"},
                "capabilities": {},
            },
        )
        recv_until(expect_id=rid)
        send("initialized", {}, notify=True)
        time.sleep(0.3)

        rid = send("account/read", {"refreshToken": False})
        recv_until(expect_id=rid)

        if args.mode == "browser":
            params = {"type": "chatgpt", "codexStreamlinedLogin": True}
        else:
            params = {"type": "chatgptDeviceCode"}
        rid = send("account/login/start", params)
        start_msgs = recv_until(expect_id=rid, timeout=12.0)
        print("START_RESULT", json.dumps(start_msgs[-1] if start_msgs else {}, indent=2), flush=True)

        deadline = time.time() + args.timeout
        completed = False
        while time.time() < deadline:
            try:
                line = out_q.get(timeout=0.5)
            except queue.Empty:
                continue
            print("<<", line.rstrip(), flush=True)
            try:
                msg = json.loads(line)
            except Exception:
                continue
            method = msg.get("method")
            if method in ("account/login/completed", "account/updated"):
                print("EVENT", method, json.dumps(msg.get("params"), indent=2), flush=True)
                if method == "account/login/completed":
                    completed = True
                    break

        rid = send("account/read", {"refreshToken": False})
        final_msgs = recv_until(expect_id=rid, timeout=8.0)
        print("FINAL_ACCOUNT", json.dumps(final_msgs[-1] if final_msgs else {}, indent=2), flush=True)
        print("COMPLETED_SEEN", completed, flush=True)
        return 0 if completed else 2
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except Exception:
            proc.kill()
        while not err_q.empty():
            print("stderr:", err_q.get_nowait().rstrip(), flush=True)


if __name__ == "__main__":
    sys.exit(main())
