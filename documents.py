"""Extracts readable text from message attachments so the AI can review
documents dropped in chat: plain text/code/markdown, PDFs, and Word docs.

Extraction is automatic (like the GitHub-link auto-attach in tools.py) —
no tool call needed, the text is folded into the user's message before it
reaches the model.
"""
import io
import logging

import discord

log = logging.getLogger("documents")

MAX_FILE_BYTES = 15 * 1024 * 1024  # Discord's own default upload cap
MAX_ATTACHMENTS = 3                # documents read per message
EXTRACT_MAX = 8000                 # chars of extracted text kept per document

TEXT_EXTENSIONS = {
    "txt", "md", "markdown", "csv", "json", "log", "yaml", "yml",
    "py", "js", "ts", "jsx", "tsx", "html", "css", "xml", "toml",
    "ini", "cfg", "sh", "rb", "go", "rs", "java", "c", "cpp", "h",
}


def _ext(filename: str) -> str:
    return filename.rsplit(".", 1)[-1].lower() if "." in filename else ""


def _decode_text(data: bytes) -> str:
    return data.decode("utf-8", errors="replace")[:EXTRACT_MAX]


def _extract_pdf(data: bytes) -> str:
    try:
        from pypdf import PdfReader
    except ImportError:
        return "[PDF support isn't installed on this bot]"
    try:
        reader = PdfReader(io.BytesIO(data))
        text = "\n".join(page.extract_text() or "" for page in reader.pages).strip()
        return text[:EXTRACT_MAX] if text else "[No extractable text — likely a scanned/image PDF]"
    except Exception as exc:
        log.warning("PDF extraction failed: %s", exc)
        return f"[Couldn't read this PDF: {exc}]"


def _extract_docx(data: bytes) -> str:
    try:
        import docx
    except ImportError:
        return "[Word document support isn't installed on this bot]"
    try:
        text = "\n".join(p.text for p in docx.Document(io.BytesIO(data)).paragraphs).strip()
        return text[:EXTRACT_MAX] if text else "[Empty document]"
    except Exception as exc:
        log.warning("DOCX extraction failed: %s", exc)
        return f"[Couldn't read this Word document: {exc}]"


async def extract_text(attachment: discord.Attachment) -> str | None:
    """Return extracted text for a supported attachment, or None if its
    type isn't one we know how to read."""
    if attachment.size > MAX_FILE_BYTES:
        return f"[{attachment.filename} is {attachment.size // 1024}KB — too large to read]"
    ext = _ext(attachment.filename)
    is_text = ext in TEXT_EXTENSIONS or (attachment.content_type or "").startswith("text/")
    if not (ext == "pdf" or ext == "docx" or is_text):
        return None
    data = await attachment.read()
    if ext == "pdf":
        return _extract_pdf(data)
    if ext == "docx":
        return _extract_docx(data)
    return _decode_text(data)


async def build_attachment_context(message: discord.Message) -> str:
    """Build a text block with each supported attachment's extracted
    content, ready to append to the user's message before it's sent to
    the model. Empty string if there's nothing to read."""
    if not message.attachments:
        return ""
    parts = []
    for attachment in message.attachments[:MAX_ATTACHMENTS]:
        text = await extract_text(attachment)
        if text is None:
            continue
        parts.append(f"[attached document: {attachment.filename}]\n{text}")
    skipped = len(message.attachments) - MAX_ATTACHMENTS
    if skipped > 0:
        parts.append(f"[{skipped} more attachment(s) not read — max {MAX_ATTACHMENTS} per message]")
    return "\n\n".join(parts)
