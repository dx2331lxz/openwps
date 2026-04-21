from __future__ import annotations

import base64
import io
import json
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import HTTPException, UploadFile

from .config import BASE_DIR, read_config

logger = logging.getLogger("uvicorn.error")

WORKSPACE_DIR = BASE_DIR / "data" / "workspace"
WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)

META_PATH = WORKSPACE_DIR / "meta.json"

ALLOWED_EXTENSIONS = {".docx", ".txt", ".md", ".pdf", ".ppt", ".pptx", ".markdown"}

MIME_MAP = {
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "application/vnd.ms-powerpoint": ".ppt",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "text/markdown": ".md",
}


def _load_meta() -> list[dict[str, Any]]:
    if META_PATH.exists():
        try:
            return json.loads(META_PATH.read_text(encoding="utf-8"))
        except Exception:
            return []
    return []


def _save_meta(docs: list[dict[str, Any]]) -> None:
    META_PATH.write_text(json.dumps(docs, ensure_ascii=False, indent=2), encoding="utf-8")


def _detect_extension(filename: str, content_type: str) -> str:
    ct = (content_type or "").strip().lower()
    if ct in MIME_MAP:
        return MIME_MAP[ct]
    name_lower = filename.lower()
    for ext in ALLOWED_EXTENSIONS:
        if name_lower.endswith(ext):
            return ext
    return ""


def _render_pdf_pages_to_images(file_path: Path, max_pages: int = 10) -> list[tuple[int, str]]:
    """Render PDF pages to base64-encoded PNG images using pypdfium2.
    Returns list of (page_number, base64_data_url)."""
    try:
        import pypdfium2
    except ImportError:
        return []

    pages_data: list[tuple[int, str]] = []
    try:
        pdf = pypdfium2.PdfDocument(str(file_path))
        page_count = min(len(pdf), max_pages)
        for i in range(page_count):
            page = pdf[i]
            bitmap = page.render(scale=2)
            img = bitmap.to_pil()
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            b64 = base64.b64encode(buf.getvalue()).decode("ascii")
            pages_data.append((i + 1, f"data:image/png;base64,{b64}"))
        pdf.close()
    except Exception as exc:
        logger.warning("Failed to render PDF pages: %s", exc)
    return pages_data


PADDLEOCR_API_URL = "https://60acw0te7fv2z9yf.aistudio-app.com/layout-parsing"
PADDLEOCR_TOKEN = "baf2212551eec93343531e64ce30a103e8fcf934"


def _ocr_pdf_via_paddleocr(file_path: Path) -> str:
    """Send PDF to PaddleOCR layout parsing API for text extraction (scanned PDFs)."""
    try:
        file_bytes = file_path.read_bytes()
        file_data = base64.b64encode(file_bytes).decode("ascii")

        payload = {
            "file": file_data,
            "fileType": 0,
            "useDocOrientationClassify": False,
            "useDocUnwarping": False,
            "useChartRecognition": False,
        }

        resp = httpx.post(
            PADDLEOCR_API_URL,
            json=payload,
            headers={
                "Authorization": f"token {PADDLEOCR_TOKEN}",
                "Content-Type": "application/json",
            },
            timeout=120,
        )

        if resp.status_code != 200:
            logger.warning("PaddleOCR API returned status %d: %s", resp.status_code, resp.text[:500])
            return ""

        data = resp.json()
        result = data.get("result", {})
        layout_results = result.get("layoutParsingResults", [])

        if not layout_results:
            return ""

        pages_text: list[str] = []
        for i, res in enumerate(layout_results):
            md = res.get("markdown", {})
            text = (md.get("text") or "").strip()
            if text:
                pages_text.append(f"--- 第 {i + 1} 页 ---\n{text}")

        return "\n\n".join(pages_text)

    except Exception as exc:
        logger.warning("PaddleOCR layout parsing failed for PDF: %s", exc)
        return ""


def _ocr_images_via_paddleocr(images: list[tuple[int, str]]) -> str:
    """Send rendered page images to PaddleOCR layout parsing API (for PPT etc.)."""
    try:
        pages_text: list[str] = []
        for page_num, data_url in images:
            # data_url is like "data:image/png;base64,XXXX" — extract the base64 part
            b64_part = data_url.split(",", 1)[-1] if "," in data_url else data_url

            payload = {
                "file": b64_part,
                "fileType": 1,
                "useDocOrientationClassify": False,
                "useDocUnwarping": False,
                "useChartRecognition": False,
            }

            resp = httpx.post(
                PADDLEOCR_API_URL,
                json=payload,
                headers={
                    "Authorization": f"token {PADDLEOCR_TOKEN}",
                    "Content-Type": "application/json",
                },
                timeout=60,
            )

            if resp.status_code != 200:
                logger.warning("PaddleOCR API returned %d for page %d", resp.status_code, page_num)
                continue

            data = resp.json()
            result = data.get("result", {})
            layout_results = result.get("layoutParsingResults", [])

            for res in layout_results:
                md = res.get("markdown", {})
                text = (md.get("text") or "").strip()
                if text:
                    pages_text.append(f"--- 第 {page_num} 页 ---\n{text}")

        return "\n\n".join(pages_text)

    except Exception as exc:
        logger.warning("PaddleOCR image OCR failed: %s", exc)
        return ""


def extract_text(file_path: Path, extension: str) -> str:
    try:
        if extension in {".txt", ".md", ".markdown"}:
            return file_path.read_text(encoding="utf-8", errors="replace")

        if extension == ".docx":
            from docx import Document
            doc = Document(str(file_path))
            parts: list[str] = []
            for para in doc.paragraphs:
                if para.text.strip():
                    parts.append(para.text)
            for table in doc.tables:
                for row in table.rows:
                    cells = [cell.text.strip() for cell in row.cells if cell.text.strip()]
                    if cells:
                        parts.append(" | ".join(cells))
            return "\n".join(parts)

        if extension == ".pdf":
            text = _extract_pdf_text(file_path)
            if text.strip():
                return text
            # Fallback: render pages and OCR
            ocr_text = _ocr_pdf(file_path)
            if ocr_text.strip():
                return ocr_text
            page_count = _pdf_page_count(file_path)
            return f"[扫描版PDF，共{page_count}页，文字提取为空。此文件可能是扫描件或图片PDF，OCR服务未配置或未能识别文字。]"

        if extension in {".ppt", ".pptx"}:
            from pptx import Presentation
            prs = Presentation(str(file_path))
            slides: list[str] = []
            for i, slide in enumerate(prs.slides):
                texts: list[str] = []
                for shape in slide.shapes:
                    if shape.has_text_frame:
                        for para in shape.text_frame.paragraphs:
                            t = para.text.strip()
                            if t:
                                texts.append(t)
                if texts:
                    slides.append(f"--- 幻灯片 {i + 1} ---\n" + "\n".join(texts))
            return "\n\n".join(slides)

    except Exception as exc:
        return f"[提取失败: {exc}]"

    return "[不支持的文件格式]"


def _extract_pdf_text(file_path: Path) -> str:
    """Try pdfplumber first, then PyPDF2 as fallback."""
    # Try pdfplumber (better extraction for most PDFs)
    try:
        import pdfplumber
        pages: list[str] = []
        with pdfplumber.open(str(file_path)) as pdf:
            for i, page in enumerate(pdf.pages):
                text = page.extract_text() or ""
                if text.strip():
                    pages.append(f"--- 第 {i + 1} 页 ---\n{text}")
        return "\n\n".join(pages)
    except ImportError:
        pass
    except Exception:
        pass

    # Fallback to PyPDF2
    try:
        from PyPDF2 import PdfReader
        reader = PdfReader(str(file_path))
        pages: list[str] = []
        for i, page in enumerate(reader.pages):
            text = page.extract_text() or ""
            if text.strip():
                pages.append(f"--- 第 {i + 1} 页 ---\n{text}")
        return "\n\n".join(pages)
    except Exception:
        return ""


def _ocr_pdf(file_path: Path) -> str:
    """Send entire PDF to PaddleOCR layout parsing API for text extraction."""
    return _ocr_pdf_via_paddleocr(file_path)


def _pdf_page_count(file_path: Path) -> int:
    try:
        import pdfplumber
        with pdfplumber.open(str(file_path)) as pdf:
            return len(pdf.pages)
    except Exception:
        pass
    try:
        from PyPDF2 import PdfReader
        return len(PdfReader(str(file_path)).pages)
    except Exception:
        return 0


def search_text_lines(text: str, query: str, context_lines: int = 3) -> list[dict[str, Any]]:
    keywords = [kw for kw in query.lower().split() if kw]
    if not keywords:
        return []

    lines = text.split("\n")
    results: list[dict[str, Any]] = []

    for i, line in enumerate(lines):
        line_lower = line.lower()
        if all(kw in line_lower for kw in keywords):
            start = max(0, i - context_lines)
            end = min(len(lines), i + context_lines + 1)
            context = lines[start:end]
            results.append({
                "lineNumber": i,
                "matchedLine": line,
                "context": context,
                "contextStart": start,
            })

    return results


def list_workspace_docs() -> list[dict[str, Any]]:
    docs = _load_meta()
    for doc in docs:
        doc_dir = WORKSPACE_DIR / doc["id"]
        if not doc_dir.exists():
            doc["_missing"] = True
    docs = [d for d in docs if not d.get("_missing")]
    return docs


def upload_document(filename: str, content_type: str, content: bytes) -> dict[str, Any]:
    extension = _detect_extension(filename, content_type)

    if not extension or extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的文件类型。支持：{', '.join(sorted(ALLOWED_EXTENSIONS))}",
        )

    doc_id = uuid.uuid4().hex[:12]
    doc_dir = WORKSPACE_DIR / doc_id
    doc_dir.mkdir(parents=True, exist_ok=True)

    safe_name = f"upload{extension}"
    file_path = doc_dir / safe_name

    file_path.write_bytes(content)

    extracted = extract_text(file_path, extension)

    text_path = doc_dir / "text.txt"
    text_path.write_text(extracted, encoding="utf-8")

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    entry = {
        "id": doc_id,
        "name": filename,
        "type": extension.lstrip("."),
        "size": len(content),
        "textLength": len(extracted),
        "uploadedAt": now,
    }

    docs = _load_meta()
    docs.append(entry)
    _save_meta(docs)

    return entry


def delete_document(doc_id: str) -> dict[str, Any]:
    docs = _load_meta()
    target = next((d for d in docs if d["id"] == doc_id), None)
    if not target:
        raise HTTPException(status_code=404, detail="文档不存在")

    doc_dir = WORKSPACE_DIR / doc_id
    if doc_dir.exists():
        import shutil
        shutil.rmtree(doc_dir)

    docs = [d for d in docs if d["id"] != doc_id]
    _save_meta(docs)
    return {"success": True, "id": doc_id}


def get_document_content(doc_id: str, from_line: int | None = None, to_line: int | None = None) -> dict[str, Any]:
    docs = _load_meta()
    target = next((d for d in docs if d["id"] == doc_id), None)
    if not target:
        raise HTTPException(status_code=404, detail="文档不存在")

    text_path = WORKSPACE_DIR / doc_id / "text.txt"
    if not text_path.exists():
        raise HTTPException(status_code=404, detail="文档内容未找到")

    text = text_path.read_text(encoding="utf-8")
    lines = text.split("\n")

    total_lines = len(lines)
    start = from_line if from_line is not None else 0
    end = to_line if to_line is not None else total_lines

    start = max(0, start)
    end = min(total_lines, end)

    selected = lines[start:end]

    return {
        "id": doc_id,
        "name": target["name"],
        "type": target["type"],
        "totalLines": total_lines,
        "fromLine": start,
        "toLine": end,
        "content": "\n".join(selected),
    }


def search_workspace(query: str, doc_id: str | None = None, context_lines: int = 3) -> dict[str, Any]:
    docs = _load_meta()

    if doc_id:
        docs = [d for d in docs if d["id"] == doc_id]

    all_results: list[dict[str, Any]] = []
    for doc in docs:
        text_path = WORKSPACE_DIR / doc["id"] / "text.txt"
        if not text_path.exists():
            continue
        text = text_path.read_text(encoding="utf-8")
        matches = search_text_lines(text, query, context_lines)
        if matches:
            all_results.append({
                "docId": doc["id"],
                "docName": doc["name"],
                "matches": matches,
                "matchCount": len(matches),
            })

    return {
        "query": query,
        "totalDocs": len(docs),
        "matchedDocs": len(all_results),
        "results": all_results,
    }