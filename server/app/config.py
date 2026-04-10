from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = BASE_DIR / "config" / "ai.json"
CONVERSATIONS_DIR = BASE_DIR / "data" / "conversations"
DOCUMENTS_DIR = BASE_DIR / "data" / "documents"
DIST_DIR = BASE_DIR.parent / "dist"

CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
CONVERSATIONS_DIR.mkdir(parents=True, exist_ok=True)
DOCUMENTS_DIR.mkdir(parents=True, exist_ok=True)

PRESET_PROVIDERS = [
    {
        "id": "siliconflow",
        "label": "硅基流动",
        "endpoint": "https://api.siliconflow.cn/v1",
        "defaultModel": "Qwen/Qwen2.5-72B-Instruct",
        "apiKey": "",
        "isPreset": True,
    },
    {
        "id": "openai",
        "label": "OpenAI",
        "endpoint": "https://api.openai.com/v1",
        "defaultModel": "gpt-4o",
        "apiKey": "",
        "isPreset": True,
    },
    {
        "id": "openrouter",
        "label": "OpenRouter",
        "endpoint": "https://openrouter.ai/api/v1",
        "defaultModel": "openai/gpt-4o-mini",
        "apiKey": "",
        "isPreset": True,
    },
    {
        "id": "groq",
        "label": "Groq",
        "endpoint": "https://api.groq.com/openai/v1",
        "defaultModel": "llama-3.3-70b-versatile",
        "apiKey": "",
        "isPreset": True,
    },
    {
        "id": "ollama",
        "label": "Ollama",
        "endpoint": "http://localhost:11434/v1",
        "defaultModel": "llama3.2",
        "apiKey": "",
        "isPreset": True,
    },
]

DEFAULT_CONFIG = {
    "version": 2,
    "activeProviderId": "siliconflow",
    "providers": deepcopy(PRESET_PROVIDERS),
}


def _normalize_endpoint(value: Any) -> str:
    return str(value or "").strip().rstrip("/")


def _sanitize_provider(raw: dict[str, Any], fallback_id: str, is_preset: bool) -> dict[str, Any]:
    provider_id = str(raw.get("id") or fallback_id).strip() or fallback_id
    label = str(raw.get("label") or raw.get("name") or ("自定义服务商" if not is_preset else provider_id)).strip()
    default_model = str(raw.get("defaultModel") or raw.get("model") or "").strip()
    return {
        "id": provider_id,
        "label": label,
        "endpoint": _normalize_endpoint(raw.get("endpoint")),
        "defaultModel": default_model,
        "apiKey": str(raw.get("apiKey") or "").strip(),
        "isPreset": bool(raw.get("isPreset", is_preset)),
    }


def _merge_providers(saved: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    saved_by_id = {
        str(item.get("id")): _sanitize_provider(item, str(item.get("id") or "custom"), bool(item.get("isPreset")))
        for item in (saved or [])
        if isinstance(item, dict)
    }

    providers: list[dict[str, Any]] = []
    for preset in PRESET_PROVIDERS:
        current = deepcopy(preset)
        saved_item = saved_by_id.pop(preset["id"], None)
        if saved_item:
            current.update(
                endpoint=saved_item["endpoint"] or current["endpoint"],
                defaultModel=saved_item["defaultModel"] or current["defaultModel"],
                apiKey=saved_item["apiKey"],
                label=saved_item["label"] or current["label"],
            )
        providers.append(current)

    custom_index = 1
    for item in saved_by_id.values():
        provider_id = item["id"]
        if any(existing["id"] == provider_id for existing in providers):
            provider_id = f"custom-{custom_index}"
            custom_index += 1
        providers.append(
            {
                **item,
                "id": provider_id,
                "label": item["label"] or f"自定义服务商 {custom_index}",
                "isPreset": False,
            }
        )

    return providers


def _migrate_legacy_config(raw: dict[str, Any]) -> dict[str, Any]:
    providers = deepcopy(PRESET_PROVIDERS)
    endpoint = _normalize_endpoint(raw.get("endpoint"))
    model = str(raw.get("model") or "").strip()
    api_key = str(raw.get("apiKey") or "").strip()

    active_provider_id = DEFAULT_CONFIG["activeProviderId"]
    matched = next((provider for provider in providers if _normalize_endpoint(provider["endpoint"]) == endpoint), None)

    if matched:
        matched["defaultModel"] = model or matched["defaultModel"]
        matched["apiKey"] = api_key
        active_provider_id = matched["id"]
    elif endpoint:
        providers.append(
            {
                "id": "custom-1",
                "label": "自定义服务商",
                "endpoint": endpoint,
                "defaultModel": model,
                "apiKey": api_key,
                "isPreset": False,
            }
        )
        active_provider_id = "custom-1"

    return {
        "version": 2,
        "activeProviderId": active_provider_id,
        "providers": providers,
    }


def normalize_config(raw: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return deepcopy(DEFAULT_CONFIG)

    if isinstance(raw.get("providers"), list):
        providers = _merge_providers(raw.get("providers"))
        active_provider_id = str(raw.get("activeProviderId") or "").strip()
        if not any(provider["id"] == active_provider_id for provider in providers):
            active_provider_id = providers[0]["id"] if providers else DEFAULT_CONFIG["activeProviderId"]
        return {
            "version": 2,
            "activeProviderId": active_provider_id,
            "providers": providers,
        }

    if any(key in raw for key in ("endpoint", "apiKey", "model")):
        return _migrate_legacy_config(raw)

    return deepcopy(DEFAULT_CONFIG)


def read_config() -> dict:
    if CONFIG_PATH.exists():
        try:
            raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            return normalize_config(raw)
        except Exception:
            return deepcopy(DEFAULT_CONFIG)
    return deepcopy(DEFAULT_CONFIG)


def write_config(cfg: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(normalize_config(cfg), ensure_ascii=False, indent=2), encoding="utf-8")


def get_provider(cfg: dict | None = None, provider_id: str | None = None) -> dict[str, Any]:
    normalized = normalize_config(cfg if cfg is not None else read_config())
    target_id = provider_id or normalized["activeProviderId"]
    provider = next((item for item in normalized["providers"] if item["id"] == target_id), None)
    if provider:
        return deepcopy(provider)
    return deepcopy(normalized["providers"][0])


def public_config(cfg: dict | None = None) -> dict[str, Any]:
    normalized = normalize_config(cfg if cfg is not None else read_config())
    active_provider = get_provider(normalized)
    return {
        "activeProviderId": normalized["activeProviderId"],
        "providers": [
            {
                "id": provider["id"],
                "label": provider["label"],
                "endpoint": provider["endpoint"],
                "defaultModel": provider["defaultModel"],
                "hasApiKey": bool(provider.get("apiKey")),
                "isPreset": bool(provider.get("isPreset")),
            }
            for provider in normalized["providers"]
        ],
        "endpoint": active_provider["endpoint"],
        "model": active_provider["defaultModel"],
        "hasApiKey": bool(active_provider.get("apiKey")),
    }
