"""
Delta injection system for dynamic context updates.

Modeled after Claude Code's attachment-based delta mechanism:
- State is stored in message history (not in-memory)
- Each turn scans messages to reconstruct announced state
- Only changed content is injected as delta attachments
- Compaction resets state → full re-announcement

Architecture:
1. AttachmentMessage — typed message carrying delta info
2. State reconstruction — scan messages for prior attachments
3. Delta computation — diff current vs announced state
4. Injection — append delta as HumanMessage to conversation
5. Compaction handling — re-announce full state after compact
"""

from __future__ import annotations
import json
from dataclasses import dataclass, field
from typing import Any


# ─── Attachment Types ─────────────────────────────────────────────────────────

ATTACHMENT_MARKER = "[系统附件]"
WORKSPACE_DOCS_DELTA = "workspace_docs_delta"
TEMPLATE_DELTA = "template_delta"
CONTEXT_DELTA = "context_delta"


class AttachmentMessage:
    """A message that carries delta attachment info.
    
    These are persisted in the conversation history so that state can be
    reconstructed by scanning messages (no separate in-memory state needed).
    """
    def __init__(
        self,
        attachment_type: str,
        added: list[dict] | None = None,
        removed: list[dict] | None = None,
        updated: dict | None = None,
        is_initial: bool = False,
    ):
        self.attachment_type = attachment_type
        self.added = added or []
        self.removed = removed or []
        self.updated = updated
        self.is_initial = is_initial


# ─── State Reconstruction ─────────────────────────────────────────────────────

def _find_attachment_messages(
    messages: list[Any],
    attachment_type: str,
) -> list[AttachmentMessage]:
    """Scan message history to find all prior attachments of a given type.
    
    This is the core state reconstruction mechanism. Instead of storing state
    in memory, we replay all delta attachments from the transcript.
    
    Modeled after Claude Code's pattern:
      for msg in messages:
          if msg.type == 'attachment' and msg.attachment.type == 'deferred_tools_delta':
              for n in msg.attachment.addedNames: announced.add(n)
              for n in msg.attachment.removedNames: announced.delete(n)
    """
    results = []
    for msg in messages:
        content = _extract_content(msg)
        if not content:
            continue
        
        attachment = _parse_attachment(content, attachment_type)
        if attachment:
            results.append(attachment)
    
    return results


def _extract_content(msg: Any) -> str:
    """Extract text content from a LangChain message."""
    if hasattr(msg, "content"):
        content = msg.content
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts = []
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    parts.append(item.get("text", ""))
                elif isinstance(item, str):
                    parts.append(item)
            return "\n".join(parts)
    return ""


def _parse_attachment(content: str, attachment_type: str) -> AttachmentMessage | None:
    """Parse an attachment from message content."""
    marker = f"{ATTACHMENT_MARKER} type={attachment_type}"
    if marker not in content:
        return None
    
    start = content.find(marker)
    if start == -1:
        return None
    
    # Find JSON block after marker - handle nested objects
    json_start = content.find("{", start)
    if json_start == -1:
        return None
    
    # Count braces to find the matching closing brace
    depth = 0
    json_end = json_start
    for i in range(json_start, len(content)):
        ch = content[i]
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                json_end = i
                break
    
    if depth != 0:
        return None
    
    try:
        payload = json.loads(content[json_start:json_end + 1])
        return AttachmentMessage(
            attachment_type=payload.get("type", attachment_type),
            added=payload.get("added", []),
            removed=payload.get("removed", []),
            updated=payload.get("updated"),
            is_initial=payload.get("is_initial", False),
        )
    except (json.JSONDecodeError, ValueError):
        return None


# ─── Workspace Docs Delta ─────────────────────────────────────────────────────

def reconstruct_workspace_docs_state(
    messages: list[Any],
) -> set[str]:
    """Reconstruct announced workspace docs state from message history.
    
    Returns set of doc_ids that have been announced to the model.
    """
    announced = set()
    attachments = _find_attachment_messages(messages, WORKSPACE_DOCS_DELTA)
    
    for att in attachments:
        for item in att.added:
            doc_id = item.get("id")
            if doc_id:
                announced.add(doc_id)
        for item in att.removed:
            doc_id = item.get("id")
            if doc_id:
                announced.discard(doc_id)
    
    return announced


def compute_workspace_docs_delta(
    current_docs: list[dict],
    messages: list[Any],
) -> str | None:
    """Compute delta for workspace docs changes.
    
    Scans messages to reconstruct what the model already knows,
    then diffs against current state to find what changed.
    
    Returns formatted delta text, or None if no changes.
    """
    announced_ids = reconstruct_workspace_docs_state(messages)
    
    current_ids = {doc.get("id") for doc in current_docs}
    current_map = {doc.get("id"): doc for doc in current_docs}
    
    added_ids = current_ids - announced_ids
    removed_ids = announced_ids - current_ids
    
    if not added_ids and not removed_ids:
        return None
    
    added_docs = [current_map[doc_id] for doc_id in added_ids if doc_id in current_map]
    removed_docs = [{"id": doc_id} for doc_id in removed_ids]
    
    parts = [f"{ATTACHMENT_MARKER} type={WORKSPACE_DOCS_DELTA}"]
    
    payload = {
        "type": WORKSPACE_DOCS_DELTA,
        "added": [{"id": d.get("id"), "name": d.get("name", "?")} for d in added_docs],
        "removed": removed_docs,
        "is_initial": len(announced_ids) == 0,
    }
    parts.append(json.dumps(payload, ensure_ascii=False))
    
    # Human-readable text for the model
    parts.append("")
    parts.append("[工作区文档变更]")
    
    if added_docs:
        parts.append("新增文档：")
        for doc in added_docs:
            name = doc.get("name", "?")
            doc_id = doc.get("id", "?")
            doc_type = doc.get("type", "?")
            size = doc.get("size", 0)
            text_length = doc.get("textLength", 0)
            parts.append(f"  + [{doc_id}] {name} ({doc_type}, {size} bytes, {text_length} chars)")
    
    if removed_ids:
        parts.append("移除文档：")
        for doc_id in removed_ids:
            parts.append(f"  - [{doc_id}]")
    
    return "\n".join(parts)


# ─── Template Delta ───────────────────────────────────────────────────────────

def reconstruct_template_state(
    messages: list[Any],
) -> dict | None:
    """Reconstruct current template state from message history.
    
    Returns the current template dict, or None if no template announced.
    """
    current = None
    attachments = _find_attachment_messages(messages, TEMPLATE_DELTA)
    
    for att in attachments:
        if att.updated:
            current = att.updated
        elif att.added:
            current = att.added[0] if att.added else None
        elif att.removed:
            current = None
    
    return current


def compute_template_delta(
    current_template: dict | None,
    messages: list[Any],
) -> str | None:
    """Compute delta for template changes."""
    announced = reconstruct_template_state(messages)
    
    # Compare by serializing (handles nested dict comparison)
    current_json = json.dumps(current_template, sort_keys=True) if current_template else None
    announced_json = json.dumps(announced, sort_keys=True) if announced else None
    
    if current_json == announced_json:
        return None
    
    parts = [f"{ATTACHMENT_MARKER} type={TEMPLATE_DELTA}"]
    
    payload = {
        "type": TEMPLATE_DELTA,
        "added": [current_template] if current_template else [],
        "removed": [announced] if announced else [],
        "updated": current_template,
        "is_initial": announced is None,
    }
    parts.append(json.dumps(payload, ensure_ascii=False))
    
    # Human-readable text
    parts.append("")
    
    if current_template is None:
        parts.append("[模板已移除] 当前无激活模板。如需统一全文样式，请使用页面设置与批量样式工具。")
    elif announced is None:
        parts.append("[新模板] 当前激活模板：")
        parts.append(f"context.activeTemplate = {json.dumps(current_template, ensure_ascii=False, indent=2)}")
        parts.append("若用户要求按模板排版，优先遵循 templateText。")
    else:
        parts.append("[模板变更] 当前激活模板已更新：")
        parts.append(f"context.activeTemplate = {json.dumps(current_template, ensure_ascii=False, indent=2)}")
        parts.append("若用户要求按模板排版，优先遵循 templateText。")
    
    return "\n".join(parts)


# ─── Context Delta (Selection, Preview, etc.) ─────────────────────────────────

def reconstruct_context_state(
    messages: list[Any],
) -> dict:
    """Reconstruct last known context from message history.
    
    Returns dict with selection, preview, etc.
    """
    context = {}
    attachments = _find_attachment_messages(messages, CONTEXT_DELTA)
    
    for att in attachments:
        if att.updated:
            context.update(att.updated)
    
    return context


def compute_context_delta(
    current_context: dict,
    messages: list[Any],
    keys: list[str] | None = None,
) -> str | None:
    """Compute delta for context changes (selection, preview, etc.).
    
    Only checks specified keys (default: selection, preview).
    """
    if keys is None:
        keys = ["selection", "preview"]
    
    announced = reconstruct_context_state(messages)
    
    changed = {}
    for key in keys:
        current_val = current_context.get(key)
        announced_val = announced.get(key)
        
        # Compare by serializing
        current_json = json.dumps(current_val, sort_keys=True) if current_val else None
        announced_json = json.dumps(announced_val, sort_keys=True) if announced_val else None
        
        if current_json != announced_json:
            changed[key] = current_val
    
    if not changed:
        return None
    
    parts = [f"{ATTACHMENT_MARKER} type={CONTEXT_DELTA}"]
    
    payload = {
        "type": CONTEXT_DELTA,
        "updated": changed,
    }
    parts.append(json.dumps(payload, ensure_ascii=False))
    
    # Human-readable text
    parts.append("")
    parts.append("[上下文变更]")
    
    if "selection" in changed:
        sel = changed["selection"]
        if sel:
            parts.append("context.selection = " + json.dumps(sel, ensure_ascii=False, indent=2))
            parts.append("选区已更新，请按新选区进行操作。")
        else:
            parts.append("context.selection = null")
            parts.append("选区已清除。")
    
    if "preview" in changed:
        prev = changed["preview"]
        if prev:
            parts.append("context.preview 已更新。")
    
    return "\n".join(parts)


# ─── Full Delta Computation ───────────────────────────────────────────────────

def compute_all_deltas(
    context: dict,
    messages: list[Any],
    force_full: bool = False,
) -> list[str]:
    """Compute all delta attachments for the current turn.
    
    If force_full=True (e.g., after compaction), announces full state.
    Otherwise, only announces changes.
    """
    deltas = []
    
    if force_full:
        # Full re-announcement: pass empty messages list
        docs_delta = compute_workspace_docs_delta(
            context.get("workspaceDocs", []),
            [],  # empty → no prior state → full announcement
        )
        template_delta = compute_template_delta(
            context.get("activeTemplate"),
            [],
        )
        context_delta = compute_context_delta(
            context,
            [],
        )
    else:
        docs_delta = compute_workspace_docs_delta(
            context.get("workspaceDocs", []),
            messages,
        )
        template_delta = compute_template_delta(
            context.get("activeTemplate"),
            messages,
        )
        context_delta = compute_context_delta(
            context,
            messages,
        )
    
    if docs_delta:
        deltas.append(docs_delta)
    if template_delta:
        deltas.append(template_delta)
    if context_delta:
        deltas.append(context_delta)
    
    return deltas


# ─── Initial Full Context ─────────────────────────────────────────────────────

def build_initial_context_attachment(context: dict) -> str:
    """Build full context attachment for session start.
    
    This is the initial state announcement, equivalent to passing
    empty messages to compute_all_deltas(force_full=True).
    """
    parts = []
    
    docs_delta = compute_workspace_docs_delta(context.get("workspaceDocs", []), [])
    if docs_delta:
        parts.append(docs_delta)
    
    template_delta = compute_template_delta(context.get("activeTemplate"), [])
    if template_delta:
        parts.append(template_delta)
    
    context_delta = compute_context_delta(context, [])
    if context_delta:
        parts.append(context_delta)
    
    return "\n\n".join(parts) if parts else ""
