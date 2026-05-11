from __future__ import annotations

import base64
import json
import re
import shutil
import shlex
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from .workspace import _require_workspace, _workspace_files_root, get_active_workspace_id


SKILL_DIRNAME = "skills"
SKILL_FILENAME = "SKILL.md"
OPENWPS_INTERNAL_DIRNAME = ".openwps"
USER_SKILLS_DIR = Path.home() / ".openwps" / SKILL_DIRNAME
BUILTIN_SKILLS_DIR = Path(__file__).parent / "builtin_skills"
SKILL_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
FRONTMATTER_RE = re.compile(r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)", re.DOTALL)
MODEL_DISCOVERY_LIMIT = 30
SCOPE_PRIORITY = {"workspace": 0, "user": 1, "builtin": 2}


@dataclass
class SkillRecord:
    slug: str
    scope: str
    workspace_id: str | None
    root_dir: Path
    file_path: Path
    content: str
    frontmatter: dict[str, Any] = field(default_factory=dict)
    available_for_model: bool = True
    overridden_by: str | None = None

    @property
    def id(self) -> str:
        return encode_skill_id(self.scope, self.workspace_id, self.slug)

    @property
    def name(self) -> str:
        return _string(self.frontmatter.get("name")) or self.slug

    @property
    def description(self) -> str:
        return _string(self.frontmatter.get("description")) or _markdown_excerpt(self.content)

    @property
    def when_to_use(self) -> str:
        return _string(self.frontmatter.get("when_to_use"))

    @property
    def argument_hint(self) -> str:
        return _string(self.frontmatter.get("argument-hint"))

    @property
    def argument_names(self) -> list[str]:
        return _string_list(self.frontmatter.get("arguments"))

    @property
    def disabled_for_model(self) -> bool:
        return _bool(self.frontmatter.get("disable-model-invocation"))

    @property
    def execution_context(self) -> str:
        value = _string(self.frontmatter.get("context")).strip().lower()
        return "fork" if value == "fork" else "inline"

    @property
    def agent(self) -> str:
        return _string(self.frontmatter.get("agent")) or "general-purpose"

    @property
    def model(self) -> str:
        return _string(self.frontmatter.get("model"))

    @property
    def effort(self) -> str:
        return _string(self.frontmatter.get("effort"))

    @property
    def version(self) -> str:
        return _string(self.frontmatter.get("version"))

    @property
    def allowed_tools(self) -> list[str]:
        return _string_list(self.frontmatter.get("allowed-tools"))

    @property
    def paths(self) -> list[str]:
        return _string_list(self.frontmatter.get("paths"))

    @property
    def read_only(self) -> bool:
        return self.scope == "builtin"

    @property
    def can_edit(self) -> bool:
        return not self.read_only

    @property
    def can_delete(self) -> bool:
        return not self.read_only

    def to_summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "slug": self.slug,
            "directoryName": self.slug,
            "scope": self.scope,
            "workspaceId": self.workspace_id,
            "name": self.name,
            "description": self.description,
            "whenToUse": self.when_to_use,
            "argumentHint": self.argument_hint,
            "arguments": self.argument_names,
            "disableModelInvocation": self.disabled_for_model,
            "availableForModel": self.available_for_model and not self.disabled_for_model,
            "overriddenBy": self.overridden_by,
            "context": self.execution_context,
            "agent": self.agent,
            "model": self.model,
            "effort": self.effort,
            "version": self.version,
            "updatedAt": _mtime_iso(self.file_path),
            "readOnly": self.read_only,
            "canEdit": self.can_edit,
            "canDelete": self.can_delete,
        }

    def to_detail(self) -> dict[str, Any]:
        return {
            **self.to_summary(),
            "content": self.content,
            "frontmatter": self.frontmatter,
            "allowedTools": self.allowed_tools,
            "hooks": self.frontmatter.get("hooks"),
            "shell": self.frontmatter.get("shell"),
            "paths": self.paths,
        }

    def to_discovery_summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.slug,
            "displayName": self.name,
            "description": self.description,
            "whenToUse": self.when_to_use,
            "context": self.execution_context,
            "argumentHint": self.argument_hint,
            "scope": self.scope,
            "workspaceId": self.workspace_id,
        }


def encode_skill_id(scope: str, workspace_id: str | None, slug: str) -> str:
    payload = json.dumps(
        {"scope": scope, "workspaceId": workspace_id or "", "slug": slug},
        ensure_ascii=False,
        sort_keys=True,
    )
    return base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii").rstrip("=")


def decode_skill_id(skill_id: str) -> tuple[str, str | None, str]:
    text = str(skill_id or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Skill ID 不能为空")
    try:
        padded = text + ("=" * (-len(text) % 4))
        raw = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
        payload = json.loads(raw)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Skill ID 无效") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Skill ID 无效")
    scope = _normalize_scope(payload.get("scope"), allow_all=False)
    slug = _normalize_slug(payload.get("slug"))
    workspace_id = _string(payload.get("workspaceId")) or None
    if scope == "workspace":
        workspace_id = _require_workspace(workspace_id)
    elif scope != "workspace":
        workspace_id = None
    return scope, workspace_id, slug


def list_skills(workspace_id: str | None = None, scope: str = "all") -> dict[str, Any]:
    normalized_scope = _normalize_scope(scope, allow_all=True)
    target_workspace_id = _resolve_workspace_id(workspace_id) if normalized_scope in {"all", "workspace", "user", "builtin"} else get_active_workspace_id()
    records = _list_skill_records(target_workspace_id, normalized_scope)
    return {
        "workspaceId": target_workspace_id,
        "scope": normalized_scope,
        "skills": [record.to_summary() for record in records],
    }


def read_skill(skill_id: str) -> dict[str, Any]:
    record = _require_skill_by_id(skill_id, include_unavailable=True)
    return record.to_detail()


def create_skill(payload: dict[str, Any]) -> dict[str, Any]:
    scope = _normalize_scope(payload.get("scope") or "workspace", allow_all=False)
    if scope == "builtin":
        raise HTTPException(status_code=403, detail="内置 Skill 为只读，不能创建")
    workspace_id = _resolve_workspace_id(payload.get("workspaceId")) if scope == "workspace" else None
    slug = _normalize_slug(payload.get("directoryName") or payload.get("slug") or payload.get("name") or "skill")
    root = _skill_root(scope, workspace_id)
    skill_dir = _safe_skill_dir(root, slug)
    file_path = skill_dir / SKILL_FILENAME
    if file_path.exists():
        raise HTTPException(status_code=409, detail="Skill 已存在")
    skill_dir.mkdir(parents=True, exist_ok=False)
    file_path.write_text(_render_skill_markdown(payload, fallback_slug=slug), encoding="utf-8")
    return read_skill(encode_skill_id(scope, workspace_id, slug))


def update_skill(skill_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    scope, workspace_id, slug = decode_skill_id(skill_id)
    if scope == "builtin":
        raise HTTPException(status_code=403, detail="内置 Skill 为只读，不能修改")
    record = _require_skill(scope, workspace_id, slug)
    next_slug = _normalize_slug(payload.get("directoryName") or payload.get("slug") or slug)
    root = _skill_root(scope, workspace_id)
    target_dir = _safe_skill_dir(root, next_slug)
    if next_slug != slug and target_dir.exists():
        raise HTTPException(status_code=409, detail="目标 Skill 名称已存在")
    merged = {
        **record.frontmatter,
        "name": record.name,
        "description": record.description,
        "when_to_use": record.when_to_use,
        "arguments": record.argument_names,
        "argument-hint": record.argument_hint,
        "disable-model-invocation": record.disabled_for_model,
        "context": record.execution_context,
        "agent": record.agent,
        "model": record.model,
        "effort": record.effort,
        "version": record.version,
        "allowed-tools": record.allowed_tools,
        "hooks": record.frontmatter.get("hooks"),
        "shell": record.frontmatter.get("shell"),
        "paths": record.paths,
        "content": record.content,
    }
    merged.update({key: value for key, value in payload.items() if value is not None})
    rendered = _render_skill_markdown(merged, fallback_slug=next_slug)
    if next_slug != slug:
        record.root_dir.rename(target_dir)
        record = _require_skill(scope, workspace_id, next_slug)
    record.file_path.write_text(rendered, encoding="utf-8")
    return read_skill(encode_skill_id(scope, workspace_id, next_slug))


def delete_skill(skill_id: str) -> dict[str, Any]:
    scope, workspace_id, slug = decode_skill_id(skill_id)
    if scope == "builtin":
        raise HTTPException(status_code=403, detail="内置 Skill 为只读，不能删除")
    record = _require_skill(scope, workspace_id, slug)
    shutil.rmtree(record.root_dir)
    return {"success": True, "skillId": skill_id, "slug": slug, "scope": scope, "workspaceId": workspace_id}


def get_model_skill_summaries(workspace_id: str | None = None) -> list[dict[str, Any]]:
    target_workspace_id = _resolve_workspace_id(workspace_id)
    records = _list_skill_records(target_workspace_id, "all")
    return [
        record.to_discovery_summary()
        for record in records
        if record.available_for_model and not record.disabled_for_model
    ][:MODEL_DISCOVERY_LIMIT]


def build_skill_discovery_delta(workspace_id: str | None = None) -> list[dict[str, Any]]:
    try:
        return get_model_skill_summaries(workspace_id)
    except HTTPException:
        return []


def expand_skill_for_model(
    skill_name: str,
    arguments: str | None,
    *,
    session_id: str,
    workspace_id: str | None = None,
) -> dict[str, Any]:
    record = _resolve_model_skill(skill_name, workspace_id)
    expanded = _expand_skill_content(record, arguments, session_id=session_id)
    attachment = _build_skill_context_attachment(record, expanded, arguments)
    return {
        "skillId": record.id,
        "slug": record.slug,
        "name": record.name,
        "scope": record.scope,
        "workspaceId": record.workspace_id,
        "context": record.execution_context,
        "agent": record.agent,
        "model": record.model,
        "effort": record.effort,
        "attachment": attachment,
        "prompt": expanded,
        "arguments": arguments or "",
    }


def _list_skill_records(workspace_id: str | None, scope: str) -> list[SkillRecord]:
    workspace_records = _scan_skill_root(_skill_root("workspace", workspace_id), "workspace", workspace_id)
    user_records = _scan_skill_root(USER_SKILLS_DIR, "user", None)
    builtin_records = _scan_skill_root(BUILTIN_SKILLS_DIR, "builtin", None)
    grouped = {
        "workspace": workspace_records,
        "user": user_records,
        "builtin": builtin_records,
    }
    strongest: dict[str, SkillRecord] = {}
    for record in [*workspace_records, *user_records, *builtin_records]:
        current = strongest.get(record.slug)
        if current is None or SCOPE_PRIORITY[record.scope] < SCOPE_PRIORITY[current.scope]:
            strongest[record.slug] = record
    for record in [*workspace_records, *user_records, *builtin_records]:
        winner = strongest.get(record.slug)
        if winner and winner.scope != record.scope:
            record.available_for_model = False
            record.overridden_by = winner.workspace_id if winner.scope == "workspace" else winner.scope
    if scope == "all":
        records = [*workspace_records, *user_records, *builtin_records]
    else:
        records = grouped[scope]
    records.sort(key=lambda item: (SCOPE_PRIORITY[item.scope], item.slug))
    return records


def _scan_skill_root(root: Path, scope: str, workspace_id: str | None) -> list[SkillRecord]:
    if not root.exists():
        return []
    if not root.is_dir():
        return []
    records: list[SkillRecord] = []
    for entry in sorted(root.iterdir(), key=lambda item: item.name.lower()):
        if not entry.is_dir():
            continue
        slug = entry.name
        if not SKILL_NAME_RE.fullmatch(slug):
            continue
        file_path = entry / SKILL_FILENAME
        if not file_path.is_file():
            continue
        raw = file_path.read_text(encoding="utf-8", errors="replace")
        frontmatter, content = _split_frontmatter(raw)
        records.append(SkillRecord(
            slug=slug,
            scope=scope,
            workspace_id=workspace_id if scope == "workspace" else None,
            root_dir=entry,
            file_path=file_path,
            content=content,
            frontmatter=frontmatter,
        ))
    return records


def _require_skill_by_id(skill_id: str, *, include_unavailable: bool = False) -> SkillRecord:
    scope, workspace_id, slug = decode_skill_id(skill_id)
    if include_unavailable:
        return _require_skill(scope, workspace_id, slug)
    record = _resolve_model_skill(slug, workspace_id)
    if record.id != skill_id:
        raise HTTPException(status_code=404, detail="Skill 不可用或已被覆盖")
    return record


def _require_skill(scope: str, workspace_id: str | None, slug: str) -> SkillRecord:
    root = _skill_root(scope, workspace_id)
    skill_dir = _safe_skill_dir(root, slug)
    file_path = skill_dir / SKILL_FILENAME
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="Skill 不存在")
    raw = file_path.read_text(encoding="utf-8", errors="replace")
    frontmatter, content = _split_frontmatter(raw)
    return SkillRecord(
        slug=slug,
        scope=scope,
        workspace_id=workspace_id if scope == "workspace" else None,
        root_dir=skill_dir,
        file_path=file_path,
        content=content,
        frontmatter=frontmatter,
    )


def _resolve_model_skill(skill_name: str, workspace_id: str | None = None) -> SkillRecord:
    target_workspace_id = _resolve_workspace_id(workspace_id)
    key = str(skill_name or "").strip()
    records = _list_skill_records(target_workspace_id, "all")
    for record in records:
        candidates = {record.slug, record.name, record.id}
        if key in candidates and record.available_for_model and not record.disabled_for_model:
            return record
    raise HTTPException(status_code=404, detail=f"Skill 不存在或不可被模型调用: {key}")


def _skill_root(scope: str, workspace_id: str | None) -> Path:
    if scope == "builtin":
        return BUILTIN_SKILLS_DIR
    if scope == "user":
        return USER_SKILLS_DIR
    target = _resolve_workspace_id(workspace_id)
    return _workspace_files_root(target) / OPENWPS_INTERNAL_DIRNAME / SKILL_DIRNAME


def _resolve_workspace_id(workspace_id: Any) -> str:
    value = _string(workspace_id)
    return _require_workspace(value or None)


def _safe_skill_dir(root: Path, slug: str) -> Path:
    normalized = _normalize_slug(slug)
    root_resolved = root.resolve()
    target = (root / normalized).resolve()
    try:
        target.relative_to(root_resolved)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Skill 路径无效") from exc
    return target


def _normalize_scope(value: Any, *, allow_all: bool) -> str:
    scope = str(value or "all").strip().lower()
    allowed = {"workspace", "user", "builtin"} | ({"all"} if allow_all else set())
    if scope not in allowed:
        raise HTTPException(status_code=400, detail="Skill scope 无效")
    return scope


def _normalize_slug(value: Any) -> str:
    text = str(value or "").strip().lower()
    if not SKILL_NAME_RE.fullmatch(text):
        raise HTTPException(status_code=400, detail="Skill 目录名必须匹配 [a-z0-9][a-z0-9_-]{0,63}")
    return text


def _split_frontmatter(raw: str) -> tuple[dict[str, Any], str]:
    match = FRONTMATTER_RE.match(raw)
    if not match:
        return {}, raw
    frontmatter = _parse_simple_yaml(match.group(1))
    return frontmatter, raw[match.end():]


def _parse_simple_yaml(text: str) -> dict[str, Any]:
    result: dict[str, Any] = {}
    lines = text.splitlines()
    index = 0
    while index < len(lines):
        line = lines[index]
        index += 1
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = re.match(r"^([A-Za-z0-9_-]+)\s*:\s*(.*)$", line)
        if not match:
            continue
        key = match.group(1)
        rest = match.group(2).strip()
        if rest:
            result[key] = _parse_scalar(rest)
            continue
        items: list[Any] = []
        while index < len(lines):
            child = lines[index]
            if not child.startswith((" ", "\t")):
                break
            index += 1
            stripped = child.strip()
            if not stripped:
                continue
            if stripped.startswith("- "):
                items.append(_parse_scalar(stripped[2:].strip()))
            elif ":" in stripped:
                child_key, child_value = stripped.split(":", 1)
                existing = result.get(key)
                if not isinstance(existing, dict):
                    existing = {}
                    result[key] = existing
                existing[child_key.strip()] = _parse_scalar(child_value.strip())
        if items:
            result[key] = items
        elif key not in result:
            result[key] = ""
    return result


def _parse_scalar(value: str) -> Any:
    text = value.strip()
    if text in {"", "''", '""'}:
        return ""
    lowered = text.lower()
    if lowered in {"true", "false"}:
        return lowered == "true"
    if text.startswith("[") and text.endswith("]"):
        try:
            parsed = json.loads(text.replace("'", '"'))
            if isinstance(parsed, list):
                return parsed
        except Exception:
            pass
    if (text.startswith('"') and text.endswith('"')) or (text.startswith("'") and text.endswith("'")):
        return text[1:-1]
    return text


def _render_skill_markdown(payload: dict[str, Any], *, fallback_slug: str) -> str:
    content = _string(payload.get("content") if "content" in payload else payload.get("markdown")).strip()
    if not content:
        content = "# " + (_string(payload.get("name")) or fallback_slug)
    frontmatter = _frontmatter_from_payload(payload, fallback_slug=fallback_slug)
    return "---\n" + _dump_simple_yaml(frontmatter).rstrip() + "\n---\n\n" + content.rstrip() + "\n"


def _frontmatter_from_payload(payload: dict[str, Any], *, fallback_slug: str) -> dict[str, Any]:
    frontmatter: dict[str, Any] = {}
    mapping = [
        ("name", "name"),
        ("description", "description"),
        ("whenToUse", "when_to_use"),
        ("when_to_use", "when_to_use"),
        ("arguments", "arguments"),
        ("argumentHint", "argument-hint"),
        ("argument-hint", "argument-hint"),
        ("disableModelInvocation", "disable-model-invocation"),
        ("disable-model-invocation", "disable-model-invocation"),
        ("context", "context"),
        ("agent", "agent"),
        ("model", "model"),
        ("effort", "effort"),
        ("version", "version"),
        ("allowedTools", "allowed-tools"),
        ("allowed-tools", "allowed-tools"),
        ("hooks", "hooks"),
        ("shell", "shell"),
        ("paths", "paths"),
    ]
    for source_key, target_key in mapping:
        if source_key not in payload:
            continue
        value = payload.get(source_key)
        if value in (None, "", [], {}):
            continue
        frontmatter[target_key] = value
    frontmatter.setdefault("name", fallback_slug)
    if "context" in frontmatter and str(frontmatter["context"]).strip().lower() != "fork":
        frontmatter["context"] = "inline"
    return frontmatter


def _dump_simple_yaml(values: dict[str, Any]) -> str:
    lines: list[str] = []
    for key in [
        "name",
        "description",
        "when_to_use",
        "arguments",
        "argument-hint",
        "disable-model-invocation",
        "context",
        "agent",
        "model",
        "effort",
        "version",
        "allowed-tools",
        "paths",
        "hooks",
        "shell",
    ]:
        if key not in values:
            continue
        value = values[key]
        if isinstance(value, list):
            lines.append(f"{key}:")
            for item in value:
                lines.append(f"  - {_yaml_scalar(item)}")
        elif isinstance(value, dict):
            lines.append(f"{key}:")
            for child_key, child_value in value.items():
                lines.append(f"  {child_key}: {_yaml_scalar(child_value)}")
        else:
            lines.append(f"{key}: {_yaml_scalar(value)}")
    return "\n".join(lines) + "\n"


def _yaml_scalar(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    text = _string(value)
    if not text:
        return '""'
    if re.fullmatch(r"[A-Za-z0-9_./:@+-]+", text):
        return text
    return json.dumps(text, ensure_ascii=False)


def _expand_skill_content(record: SkillRecord, arguments: str | None, *, session_id: str) -> str:
    final = f"Base directory for this skill: {record.root_dir}\n\n{record.content}"
    final = _substitute_arguments(final, arguments, record.argument_names)
    final = final.replace("${OPENWPS_SKILL_DIR}", record.root_dir.as_posix())
    final = final.replace("${OPENWPS_SESSION_ID}", session_id)
    return final.strip()


def _substitute_arguments(content: str, arguments: str | None, argument_names: list[str]) -> str:
    if arguments is None:
        return content
    args = str(arguments)
    parsed = _parse_arguments(args)
    original = content
    for index, name in enumerate(argument_names):
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            continue
        content = re.sub(rf"\${re.escape(name)}(?![\[\w])", parsed[index] if index < len(parsed) else "", content)
    content = re.sub(r"\$ARGUMENTS\[(\d+)\]", lambda match: parsed[int(match.group(1))] if int(match.group(1)) < len(parsed) else "", content)
    content = re.sub(r"\$(\d+)(?!\w)", lambda match: parsed[int(match.group(1))] if int(match.group(1)) < len(parsed) else "", content)
    content = content.replace("$ARGUMENTS", args)
    if content == original and args:
        content = content + f"\n\nARGUMENTS: {args}"
    return content


def _parse_arguments(arguments: str) -> list[str]:
    if not arguments.strip():
        return []
    try:
        return shlex.split(arguments)
    except ValueError:
        return [item for item in arguments.split() if item]


def _build_skill_context_attachment(record: SkillRecord, expanded: str, arguments: str | None) -> str:
    payload = {
        "type": "skill_context",
        "skillId": record.id,
        "skill": record.slug,
        "displayName": record.name,
        "scope": record.scope,
        "workspaceId": record.workspace_id,
        "context": record.execution_context,
        "arguments": arguments or "",
    }
    return "\n".join([
        "[系统附件] type=skill_context",
        json.dumps(payload, ensure_ascii=False, sort_keys=True),
        "",
        "[Skill 内容]",
        expanded,
    ])


def _string(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    return str(value).strip()


def _string_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [_string(item) for item in value if _string(item)]
    text = _string(value)
    if not text:
        return []
    return [item.strip() for item in re.split(r"[,\s]+", text) if item.strip()]


def _bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _markdown_excerpt(content: str) -> str:
    for line in content.splitlines():
        text = line.strip().lstrip("#").strip()
        if text:
            return text[:160]
    return ""


def _mtime_iso(path: Path) -> str:
    try:
        ts = path.stat().st_mtime
    except OSError:
        return ""
    return datetime.fromtimestamp(ts, timezone.utc).isoformat()
