from __future__ import annotations

import json
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = BASE_DIR / "config" / "ai.json"
CONVERSATIONS_DIR = BASE_DIR / "data" / "conversations"
DIST_DIR = BASE_DIR.parent / "dist"

CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
CONVERSATIONS_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_CONFIG = {
    "endpoint": "https://api.siliconflow.cn/v1",
    "apiKey": "",
    "model": "Qwen/Qwen2.5-72B-Instruct",
    "provider": "openai",
}


def read_config() -> dict:
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception:
            return DEFAULT_CONFIG.copy()
    return DEFAULT_CONFIG.copy()


def write_config(cfg: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
