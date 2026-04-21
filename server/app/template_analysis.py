from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import HTTPException
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from .config import get_provider, read_config

logger = logging.getLogger("uvicorn.error")

TEMPLATE_ANALYSIS_SYSTEM_PROMPT = """你是 openwps 的模板分析器。你的任务不是聊天，而是根据上传的 DOCX 模板全文内容，产出一份可复用、可编辑、适合后续 AI 套版的 Markdown 格式总结。

你会收到：
- 模板名称
- 文档全文原文

必须遵守：
1. 只能依据输入的文档内容总结，不要编造未出现的规则。
2. 输出重点是"后续如何套版"，不是解释模板长什么样。
3. 使用 Markdown 格式输出，必须包含以下二级标题结构：
   - ## 文档定位
   - ## 页面与版心
   - ## 文档结构顺序
   - ## 样式规范
   - ## 特殊格式要求
   - ## 套版执行指令
   - ## 不确定项
4. 在"样式规范"里，每条规则尽量包含：
   - 适用对象：
   - 文字样式：
   - 段落样式：
   不要输出"证据摘录"或类似字段。
5. 若证据不足，在"不确定项"中明确写出。
6. 标题用 # 模板名称 开头。

返回严格 JSON，字段必须包含：
- summary: 字符串，简短总结模板适用场景与主要特征
- templateText: 字符串，完整的 Markdown 格式总结
"""


def _extract_json(content: str) -> dict[str, Any] | None:
    text = str(content or "").strip()
    if not text:
        return None

    import re
    for match in re.finditer(r"```(?:json)?\s*([\s\S]*?)```", text, flags=re.IGNORECASE):
        try:
            parsed = json.loads(match.group(1).strip())
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            continue

    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass

    return None


async def analyze_template_request(body: dict[str, Any]) -> dict[str, Any]:
    raw_text = str(body.get("rawText") or "").strip()
    if not raw_text:
        raise HTTPException(status_code=400, detail="模板分析缺少 rawText")

    cfg = read_config()
    provider = get_provider(cfg, str(body.get("providerId") or "").strip() or None)
    model = str(body.get("model") or provider.get("defaultModel") or "").strip()
    if not model:
        raise HTTPException(status_code=400, detail="模板分析模型未配置")

    endpoint = str(provider.get("endpoint") or "").rstrip("/")
    api_key = str(provider.get("apiKey") or "").strip() or "not-needed"
    if not endpoint:
        raise HTTPException(status_code=400, detail="当前 AI 服务未配置 endpoint")

    template_name = str(body.get("name") or "模板").strip() or "模板"

    truncated_text = raw_text[:30000] if len(raw_text) > 30000 else raw_text
    user_prompt = json.dumps({
        "templateName": template_name,
        "rawText": truncated_text,
    }, ensure_ascii=False)

    llm = ChatOpenAI(
        model=model,
        api_key=api_key,
        base_url=endpoint,
        temperature=0.1,
        streaming=False,
        max_tokens=5000,
    )

    try:
        response = await llm.ainvoke([
            SystemMessage(content=TEMPLATE_ANALYSIS_SYSTEM_PROMPT),
            HumanMessage(content=user_prompt),
        ])
    except Exception as exc:
        logger.warning("template analysis failed provider=%s model=%s error=%s", provider.get("id"), model, exc)
        raise HTTPException(status_code=502, detail=f"模板分析请求失败：{exc}") from exc

    content = response.content if isinstance(response.content, str) else str(response.content or "")
    if not content.strip():
        raise HTTPException(status_code=502, detail="模板分析返回为空")

    parsed = _extract_json(content)
    if parsed:
        summary = str(parsed.get("summary") or "").strip()
        template_text = str(parsed.get("templateText") or "").strip()
    else:
        template_text = content.strip()
        summary = f"{template_name}，AI 生成的排版格式总结。"

    template_text = template_text.replace("\\n", "\n").replace("\\r", "")

    if not template_text:
        raise HTTPException(status_code=502, detail="模板分析未返回有效内容")

    if not summary:
        summary = f"{template_name}，AI 生成的排版格式总结。"

    return {
        "summary": summary,
        "templateText": template_text,
    }
