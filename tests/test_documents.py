"""Tests for documents.py — attachment text extraction.

    python -m unittest tests.test_documents -v
"""
from __future__ import annotations

import io
import unittest

import documents


class FakeAttachment:
    def __init__(self, filename: str, data: bytes, content_type: str | None = None):
        self.filename = filename
        self.size = len(data)
        self.content_type = content_type
        self._data = data

    async def read(self) -> bytes:
        return self._data


class ExtractTextTest(unittest.IsolatedAsyncioTestCase):
    async def test_plain_text_file(self):
        text = await documents.extract_text(FakeAttachment("notes.txt", b"hello world"))
        self.assertEqual(text, "hello world")

    async def test_markdown_file(self):
        text = await documents.extract_text(FakeAttachment("readme.md", b"# Title\n\nbody"))
        self.assertEqual(text, "# Title\n\nbody")

    async def test_unknown_extension_without_text_content_type(self):
        text = await documents.extract_text(
            FakeAttachment("photo.png", b"\x89PNG...", content_type="image/png"))
        self.assertIsNone(text)

    async def test_unknown_extension_with_text_content_type(self):
        text = await documents.extract_text(
            FakeAttachment("data.weird", b"some content", content_type="text/plain; charset=utf-8"))
        self.assertEqual(text, "some content")

    async def test_oversized_file_is_not_read(self):
        big = FakeAttachment("huge.txt", b"x")
        big.size = documents.MAX_FILE_BYTES + 1
        text = await documents.extract_text(big)
        self.assertIn("too large", text)

    async def test_pdf_extraction(self):
        from pypdf import PdfWriter

        writer = PdfWriter()
        writer.add_blank_page(width=200, height=200)
        buf = io.BytesIO()
        writer.write(buf)
        text = await documents.extract_text(FakeAttachment("doc.pdf", buf.getvalue()))
        self.assertIn("No extractable text", text)

    async def test_docx_extraction(self):
        import docx

        d = docx.Document()
        d.add_paragraph("Hello from a Word doc.")
        buf = io.BytesIO()
        d.save(buf)
        text = await documents.extract_text(FakeAttachment("doc.docx", buf.getvalue()))
        self.assertEqual(text, "Hello from a Word doc.")

    async def test_corrupt_pdf_returns_error_message_not_raise(self):
        text = await documents.extract_text(FakeAttachment("bad.pdf", b"not a pdf"))
        self.assertIn("Couldn't read", text)


class BuildAttachmentContextTest(unittest.IsolatedAsyncioTestCase):
    class FakeMessage:
        def __init__(self, attachments):
            self.attachments = attachments

    async def test_no_attachments(self):
        ctx = await documents.build_attachment_context(self.FakeMessage([]))
        self.assertEqual(ctx, "")

    async def test_single_text_attachment(self):
        msg = self.FakeMessage([FakeAttachment("plan.txt", b"the plan")])
        ctx = await documents.build_attachment_context(msg)
        self.assertIn("plan.txt", ctx)
        self.assertIn("the plan", ctx)

    async def test_unsupported_attachment_is_skipped(self):
        msg = self.FakeMessage([FakeAttachment("photo.png", b"\x89PNG", content_type="image/png")])
        ctx = await documents.build_attachment_context(msg)
        self.assertEqual(ctx, "")

    async def test_extra_attachments_reported_as_skipped(self):
        attachments = [FakeAttachment(f"f{i}.txt", b"x") for i in range(documents.MAX_ATTACHMENTS + 2)]
        msg = self.FakeMessage(attachments)
        ctx = await documents.build_attachment_context(msg)
        self.assertIn("2 more attachment(s) not read", ctx)


if __name__ == "__main__":
    unittest.main()
