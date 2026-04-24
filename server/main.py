#!/usr/bin/env python3
"""
openwps 后端服务 - Python FastAPI + LangGraph
端口：5174
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

PORT = 5174

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

try:
    import uvicorn
except ModuleNotFoundError as error:
    venv_python = ROOT_DIR / ".venv" / "bin" / "python3"
    if error.name == "uvicorn" and venv_python.exists() and Path(sys.executable).resolve() != venv_python.resolve():
        os.execv(str(venv_python), [str(venv_python), __file__])
    raise

from server.app import create_app

app = create_app()


def find_listening_pids(port: int) -> list[int]:
    try:
        result = subprocess.run(
            ["lsof", "-ti", f"tcp:{port}", "-sTCP:LISTEN"],
            capture_output=True,
            check=False,
            text=True,
        )
    except FileNotFoundError:
        return []

    pids: list[int] = []
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            pid = int(line)
        except ValueError:
            continue
        if pid != os.getpid():
            pids.append(pid)
    return pids


def terminate_pid(pid: int) -> bool:
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return True
    except PermissionError:
        return False

    deadline = time.time() + 3
    while time.time() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        time.sleep(0.1)

    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        return True
    except PermissionError:
        return False

    deadline = time.time() + 1
    while time.time() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        time.sleep(0.05)
    return False


def ensure_port_available(port: int) -> None:
    pids = find_listening_pids(port)
    if not pids:
        return

    print(f"Port {port} is in use, stopping existing process(es): {', '.join(map(str, pids))}")
    failed_pids: list[int] = []
    for pid in pids:
        if not terminate_pid(pid):
            failed_pids.append(pid)

    if failed_pids:
        raise RuntimeError(
            f"Failed to stop process(es) on port {port}: {', '.join(map(str, failed_pids))}"
        )


if __name__ == "__main__":
    ensure_port_available(PORT)
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
