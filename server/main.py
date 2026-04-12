#!/usr/bin/env python3
"""
openwps 后端服务 - Python FastAPI + LangGraph
端口：5174
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

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


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=5174, log_level="info")
