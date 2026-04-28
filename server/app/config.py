from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = BASE_DIR / "config" / "ai.json"
CONVERSATIONS_DIR = BASE_DIR / "data" / "conversations"
DOCUMENTS_DIR = BASE_DIR / "data" / "documents"
DOCUMENT_SETTINGS_PATH = BASE_DIR / "data" / "document_settings.json"
TASKS_DIR = BASE_DIR / "data" / "tasks"
AGENTS_DIR = BASE_DIR / "data" / "agents"
AGENT_RUNS_DIR = BASE_DIR / "data" / "agent_runs"
TEMPLATES_DIR = BASE_DIR / "data" / "templates"
TEMPLATE_SOURCES_DIR = TEMPLATES_DIR / "sources"
DIST_DIR = BASE_DIR.parent / "dist"

CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
CONVERSATIONS_DIR.mkdir(parents=True, exist_ok=True)
DOCUMENTS_DIR.mkdir(parents=True, exist_ok=True)
TASKS_DIR.mkdir(parents=True, exist_ok=True)
AGENTS_DIR.mkdir(parents=True, exist_ok=True)
AGENT_RUNS_DIR.mkdir(parents=True, exist_ok=True)
TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
TEMPLATE_SOURCES_DIR.mkdir(parents=True, exist_ok=True)

PRESET_PROVIDERS = [
    {
        "id": "siliconflow",
        "label": "硅基流动",
        "endpoint": "https://api.siliconflow.cn/v1",
        "defaultModel": "Qwen/Qwen2.5-72B-Instruct",
        "apiKey": "",
        "isPreset": True,
        "supportsVision": True,
    },
    {
        "id": "openai",
        "label": "OpenAI",
        "endpoint": "https://api.openai.com/v1",
        "defaultModel": "gpt-4o",
        "apiKey": "",
        "isPreset": True,
        "supportsVision": True,
        "promptCacheMode": "openai_auto",
        "promptCacheRetention": "in_memory",
    },
    {
        "id": "openrouter",
        "label": "OpenRouter",
        "endpoint": "https://openrouter.ai/api/v1",
        "defaultModel": "openai/gpt-4o-mini",
        "apiKey": "",
        "isPreset": True,
        "supportsVision": True,
    },
    {
        "id": "groq",
        "label": "Groq",
        "endpoint": "https://api.groq.com/openai/v1",
        "defaultModel": "llama-3.3-70b-versatile",
        "apiKey": "",
        "isPreset": True,
        "supportsVision": True,
    },
    {
        "id": "ollama",
        "label": "Ollama",
        "endpoint": "http://localhost:11434/v1",
        "defaultModel": "llama3.2",
        "apiKey": "",
        "isPreset": True,
        "supportsVision": True,
    },
]

DEFAULT_IMAGE_PROCESSING_MODE = "direct_multimodal"
DEFAULT_OCR_BACKEND = "compat_chat"
DEFAULT_OCR_CONFIG = {
    "enabled": True,
    "backend": DEFAULT_OCR_BACKEND,
    "providerId": "siliconflow",
    "endpoint": "https://api.siliconflow.cn/v1",
    "model": "PaddlePaddle/PaddleOCR-VL-1.5",
    "apiKey": "",
    "timeoutSeconds": 60,
    "maxImages": 5,
}

DEFAULT_VISION_CONFIG = {
    "enabled": False,
    "providerId": "openai",
    "endpoint": "https://api.openai.com/v1",
    "model": "gpt-4o-mini",
    "apiKey": "",
    "timeoutSeconds": 30,
}

DEFAULT_TAVILY_CONFIG = {
    "enabled": True,
    "apiKey": "",
    "searchDepth": "basic",
    "topic": "general",
    "maxResults": 5,
    "timeoutSeconds": 15,
}

DEFAULT_CONFIG = {
    "version": 2,
    "activeProviderId": "siliconflow",
    "imageProcessingMode": DEFAULT_IMAGE_PROCESSING_MODE,
    "ocrConfig": deepcopy(DEFAULT_OCR_CONFIG),
    "visionConfig": deepcopy(DEFAULT_VISION_CONFIG),
    "tavilyConfig": deepcopy(DEFAULT_TAVILY_CONFIG),
    "providers": deepcopy(PRESET_PROVIDERS),
}


def _normalize_endpoint(value: Any) -> str:
    return str(value or "").strip().rstrip("/")


def _normalize_prompt_cache_mode(value: Any, provider_id: str) -> str:
    normalized = str(value or "").strip().lower()
    if normalized == "openai_auto":
        return "openai_auto"
    if normalized == "off":
        return "off"
    return "openai_auto" if provider_id == "openai" else "off"


def _normalize_prompt_cache_retention(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    return normalized if normalized in {"in_memory", "24h"} else "in_memory"


def _normalize_image_processing_mode(value: Any) -> str:
    normalized = str(value or "").strip().lower().replace("-", "_")
    if normalized in {"ocr", "ocr_text"}:
        return "ocr_text"
    return DEFAULT_IMAGE_PROCESSING_MODE


def _normalize_ocr_backend(value: Any) -> str:
    normalized = str(value or "").strip().lower().replace("-", "_")
    if normalized in {"paddleocr_service", "official_service", "layout_parsing"}:
        return "paddleocr_service"
    return DEFAULT_OCR_BACKEND


def _normalize_tavily_search_depth(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized == "advanced":
        return "advanced"
    return DEFAULT_TAVILY_CONFIG["searchDepth"]


def _normalize_tavily_topic(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"general", "news", "finance"}:
        return normalized
    return DEFAULT_TAVILY_CONFIG["topic"]


def _normalize_positive_int(value: Any, default: int, *, minimum: int = 1, maximum: int = 600) -> int:
    try:
        parsed = int(value)
    except Exception:
        return default
    return max(min(parsed, maximum), minimum)


def _normalize_optional_positive_int(value: Any, *, minimum: int = 1, maximum: int = 1_000_000) -> int | None:
    try:
        parsed = int(value)
    except Exception:
        return None
    if parsed < minimum:
        return None
    return min(parsed, maximum)


def _sanitize_provider(raw: dict[str, Any], fallback_id: str, is_preset: bool) -> dict[str, Any]:
    provider_id = str(raw.get("id") or fallback_id).strip() or fallback_id
    label = str(raw.get("label") or raw.get("name") or ("自定义服务商" if not is_preset else provider_id)).strip()
    default_model = str(raw.get("defaultModel") or raw.get("model") or "").strip()
    prompt_cache_mode = _normalize_prompt_cache_mode(raw.get("promptCacheMode"), provider_id)
    return {
        "id": provider_id,
        "label": label,
        "endpoint": _normalize_endpoint(raw.get("endpoint")),
        "defaultModel": default_model,
        "apiKey": str(raw.get("apiKey") or "").strip(),
        "isPreset": bool(raw.get("isPreset", is_preset)),
        "supportsVision": bool(raw.get("supportsVision", False)),
        "promptCacheMode": prompt_cache_mode,
        "promptCacheRetention": _normalize_prompt_cache_retention(raw.get("promptCacheRetention")),
        "contextWindowTokens": _normalize_optional_positive_int(raw.get("contextWindowTokens"), minimum=4_000),
        "compactSummaryMaxOutputTokens": _normalize_optional_positive_int(
            raw.get("compactSummaryMaxOutputTokens"),
            minimum=1_000,
            maximum=20_000,
        ),
    }


def _sanitize_ocr_config(raw: dict[str, Any] | None, providers: list[dict[str, Any]]) -> dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    provider_id = str(source.get("providerId") or DEFAULT_OCR_CONFIG["providerId"]).strip() or DEFAULT_OCR_CONFIG["providerId"]
    provider = next((item for item in providers if item["id"] == provider_id), None)
    endpoint = _normalize_endpoint(source.get("endpoint")) or _normalize_endpoint(
        provider.get("endpoint") if provider else DEFAULT_OCR_CONFIG["endpoint"]
    )
    backend = _normalize_ocr_backend(source.get("backend"))
    model = str(source.get("model") or source.get("modelId") or DEFAULT_OCR_CONFIG["model"]).strip()
    if backend == "compat_chat":
        model = model or DEFAULT_OCR_CONFIG["model"]
    return {
        "enabled": bool(source.get("enabled", DEFAULT_OCR_CONFIG["enabled"])),
        "backend": backend,
        "providerId": provider["id"] if provider else provider_id,
        "endpoint": endpoint,
        "model": model,
        "apiKey": str(source.get("apiKey") or "").strip(),
        "timeoutSeconds": _normalize_positive_int(
            source.get("timeoutSeconds"),
            DEFAULT_OCR_CONFIG["timeoutSeconds"],
            minimum=5,
            maximum=600,
        ),
        "maxImages": _normalize_positive_int(
            source.get("maxImages"),
            DEFAULT_OCR_CONFIG["maxImages"],
            minimum=1,
            maximum=20,
        ),
    }


def _sanitize_vision_config(raw: dict[str, Any] | None, providers: list[dict[str, Any]]) -> dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    provider_id = str(source.get("providerId") or DEFAULT_VISION_CONFIG["providerId"]).strip() or DEFAULT_VISION_CONFIG["providerId"]
    provider = next((item for item in providers if item["id"] == provider_id), None)
    endpoint = _normalize_endpoint(source.get("endpoint")) or _normalize_endpoint(
        provider.get("endpoint") if provider else DEFAULT_VISION_CONFIG["endpoint"]
    )
    model = str(source.get("model") or source.get("modelId") or "").strip()
    if not model:
        model = str((provider or {}).get("defaultModel") or DEFAULT_VISION_CONFIG["model"]).strip()
    return {
        "enabled": bool(source.get("enabled", DEFAULT_VISION_CONFIG["enabled"])),
        "providerId": provider["id"] if provider else provider_id,
        "endpoint": endpoint,
        "model": model,
        "apiKey": str(source.get("apiKey") or "").strip(),
        "timeoutSeconds": _normalize_positive_int(
            source.get("timeoutSeconds"),
            DEFAULT_VISION_CONFIG["timeoutSeconds"],
            minimum=5,
            maximum=120,
        ),
    }


def _sanitize_tavily_config(raw: dict[str, Any] | None) -> dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    return {
        "enabled": bool(source.get("enabled", DEFAULT_TAVILY_CONFIG["enabled"])),
        "apiKey": str(source.get("apiKey") or "").strip(),
        "searchDepth": _normalize_tavily_search_depth(source.get("searchDepth")),
        "topic": _normalize_tavily_topic(source.get("topic")),
        "maxResults": _normalize_positive_int(
            source.get("maxResults"),
            DEFAULT_TAVILY_CONFIG["maxResults"],
            minimum=1,
            maximum=10,
        ),
        "timeoutSeconds": _normalize_positive_int(
            source.get("timeoutSeconds"),
            DEFAULT_TAVILY_CONFIG["timeoutSeconds"],
            minimum=5,
            maximum=60,
        ),
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
                promptCacheMode=saved_item["promptCacheMode"],
                promptCacheRetention=saved_item["promptCacheRetention"],
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
                "supportsVision": bool(item.get("supportsVision", False)),
                "promptCacheMode": _normalize_prompt_cache_mode(item.get("promptCacheMode"), provider_id),
                "promptCacheRetention": _normalize_prompt_cache_retention(item.get("promptCacheRetention")),
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
                "supportsVision": False,
            }
        )
        active_provider_id = "custom-1"

    return {
        "version": 2,
        "activeProviderId": active_provider_id,
        "imageProcessingMode": DEFAULT_IMAGE_PROCESSING_MODE,
        "ocrConfig": _sanitize_ocr_config(None, providers),
        "visionConfig": _sanitize_vision_config(None, providers),
        "tavilyConfig": deepcopy(DEFAULT_TAVILY_CONFIG),
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
            "imageProcessingMode": _normalize_image_processing_mode(raw.get("imageProcessingMode")),
            "ocrConfig": _sanitize_ocr_config(raw.get("ocrConfig"), providers),
            "visionConfig": _sanitize_vision_config(raw.get("visionConfig"), providers),
            "tavilyConfig": _sanitize_tavily_config(raw.get("tavilyConfig")),
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
    ocr_config = _sanitize_ocr_config(normalized.get("ocrConfig"), normalized["providers"])
    vision_config = _sanitize_vision_config(normalized.get("visionConfig"), normalized["providers"])
    tavily_config = _sanitize_tavily_config(normalized.get("tavilyConfig"))
    ocr_provider = get_provider(normalized, ocr_config.get("providerId"))
    vision_provider = get_provider(normalized, vision_config.get("providerId"))
    return {
        "activeProviderId": normalized["activeProviderId"],
        "imageProcessingMode": normalized.get("imageProcessingMode", DEFAULT_IMAGE_PROCESSING_MODE),
        "providers": [
            {
                "id": provider["id"],
                "label": provider["label"],
                "endpoint": provider["endpoint"],
                "defaultModel": provider["defaultModel"],
                "hasApiKey": bool(provider.get("apiKey")),
                "isPreset": bool(provider.get("isPreset")),
                "supportsVision": bool(provider.get("supportsVision")),
                "promptCacheMode": _normalize_prompt_cache_mode(provider.get("promptCacheMode"), provider["id"]),
                "promptCacheRetention": _normalize_prompt_cache_retention(provider.get("promptCacheRetention")),
            }
            for provider in normalized["providers"]
        ],
        "ocrConfig": {
            "enabled": bool(ocr_config.get("enabled", True)),
            "backend": _normalize_ocr_backend(ocr_config.get("backend")),
            "providerId": ocr_provider["id"],
            "endpoint": _normalize_endpoint(ocr_config.get("endpoint")) or ocr_provider["endpoint"],
            "model": str(ocr_config.get("model") or ""),
            "hasApiKey": bool(ocr_config.get("apiKey") or ocr_provider.get("apiKey")),
            "timeoutSeconds": int(ocr_config.get("timeoutSeconds") or DEFAULT_OCR_CONFIG["timeoutSeconds"]),
            "maxImages": int(ocr_config.get("maxImages") or DEFAULT_OCR_CONFIG["maxImages"]),
        },
        "visionConfig": {
            "enabled": bool(vision_config.get("enabled", DEFAULT_VISION_CONFIG["enabled"])),
            "providerId": vision_provider["id"],
            "endpoint": _normalize_endpoint(vision_config.get("endpoint")) or vision_provider["endpoint"],
            "model": str(vision_config.get("model") or vision_provider.get("defaultModel") or ""),
            "hasApiKey": bool(vision_config.get("apiKey") or vision_provider.get("apiKey")),
            "timeoutSeconds": int(vision_config.get("timeoutSeconds") or DEFAULT_VISION_CONFIG["timeoutSeconds"]),
        },
        "tavilyConfig": {
            "enabled": bool(tavily_config.get("enabled", DEFAULT_TAVILY_CONFIG["enabled"])),
            "hasApiKey": bool(tavily_config.get("apiKey")),
            "searchDepth": _normalize_tavily_search_depth(tavily_config.get("searchDepth")),
            "topic": _normalize_tavily_topic(tavily_config.get("topic")),
            "maxResults": int(tavily_config.get("maxResults") or DEFAULT_TAVILY_CONFIG["maxResults"]),
            "timeoutSeconds": int(tavily_config.get("timeoutSeconds") or DEFAULT_TAVILY_CONFIG["timeoutSeconds"]),
        },
        "endpoint": active_provider["endpoint"],
        "model": active_provider["defaultModel"],
        "hasApiKey": bool(active_provider.get("apiKey")),
        "supportsVision": bool(active_provider.get("supportsVision")),
        "promptCacheMode": _normalize_prompt_cache_mode(active_provider.get("promptCacheMode"), active_provider["id"]),
        "promptCacheRetention": _normalize_prompt_cache_retention(active_provider.get("promptCacheRetention")),
    }
