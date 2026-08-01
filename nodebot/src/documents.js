// Extracts readable text from message attachments so the AI can review
// documents dropped in chat: plain text/code/markdown, PDFs, and Word docs.
// Ported from documents.py.
//
// Extraction is automatic (like the GitHub-link auto-attach in tools.js) —
// no tool call needed, the text is folded into the user's message before it
// reaches the model.
//
// The Python version imported pypdf/python-docx lazily and degraded to
// "support isn't installed" when they were missing. Here the parsers are
// hard dependencies (pdfjs-dist, mammoth) declared in package.json, so that
// branch can't happen — but the per-document try/catch stays, because a
// malformed file a member uploads must never take down message handling.

const MAX_FILE_BYTES = 15 * 1024 * 1024; // Discord's own default upload cap
const MAX_ATTACHMENTS = 3;               // documents read per message
const EXTRACT_MAX = 8000;                // chars of extracted text kept per document

export { MAX_FILE_BYTES, MAX_ATTACHMENTS, EXTRACT_MAX };

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'json', 'log', 'yaml', 'yml',
  'py', 'js', 'ts', 'jsx', 'tsx', 'html', 'css', 'xml', 'toml',
  'ini', 'cfg', 'sh', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h',
]);

function ext(filename) {
  return filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
}

function decodeText(data) {
  return Buffer.from(data).toString('utf8').slice(0, EXTRACT_MAX);
}

async function extractPdf(data) {
  try {
    // The legacy build is the one meant for Node; importing lazily keeps
    // pdfjs (and its font tables) out of memory unless a PDF actually shows up.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(data),
      // No DOM here, and neither of these should reach out to the network
      // or the filesystem for a text extraction.
      useSystemFonts: false,
      isEvalSupported: false,
    });
    const doc = await loadingTask.promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const page = await doc.getPage(i);
      // eslint-disable-next-line no-await-in-loop
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str ?? '').join(' '));
    }
    // destroy() is on the loading task, not the document proxy — releasing
    // it matters because these run for every PDF anyone drops in chat.
    await loadingTask.destroy();
    const text = pages.join('\n').replace(/[ \t]+/g, ' ').trim();
    return text ? text.slice(0, EXTRACT_MAX) : '[No extractable text — likely a scanned/image PDF]';
  } catch (err) {
    console.warn('[documents] PDF extraction failed:', err?.message || err);
    return `[Couldn't read this PDF: ${err?.message || err}]`;
  }
}

async function extractDocx(data) {
  try {
    const mammoth = (await import('mammoth')).default;
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(data) });
    const text = (value || '').trim();
    return text ? text.slice(0, EXTRACT_MAX) : '[Empty document]';
  } catch (err) {
    console.warn('[documents] DOCX extraction failed:', err?.message || err);
    return `[Couldn't read this Word document: ${err?.message || err}]`;
  }
}

/** discord.js Attachments expose a URL, not the bytes — fetch them. Tests
 * pass a fake with its own read() so nothing touches the network. */
async function readAttachment(attachment) {
  if (typeof attachment.read === 'function') return attachment.read();
  const resp = await fetch(attachment.url);
  if (!resp.ok) throw new Error(`attachment fetch failed: ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

/**
 * Extracted text for a supported attachment, or null if its type isn't one
 * we know how to read.
 */
export async function extractText(attachment) {
  // discord.js calls it `name`; the Python original called it `filename`.
  const filename = attachment.name || attachment.filename || '';
  if (attachment.size > MAX_FILE_BYTES) {
    return `[${filename} is ${Math.floor(attachment.size / 1024)}KB — too large to read]`;
  }
  const extension = ext(filename);
  const contentType = attachment.contentType || attachment.content_type || '';
  const isText = TEXT_EXTENSIONS.has(extension) || contentType.startsWith('text/');
  if (!(extension === 'pdf' || extension === 'docx' || isText)) return null;

  let data;
  try {
    data = await readAttachment(attachment);
  } catch (err) {
    console.warn('[documents] could not download attachment:', err?.message || err);
    return `[Couldn't download ${filename}]`;
  }
  if (extension === 'pdf') return extractPdf(data);
  if (extension === 'docx') return extractDocx(data);
  return decodeText(data);
}

/**
 * A text block with each supported attachment's extracted content, ready to
 * append to the user's message before it goes to the model. Empty string
 * when there's nothing readable.
 */
export async function buildAttachmentContext(message) {
  const attachments = [...(message.attachments?.values?.() ?? message.attachments ?? [])];
  if (!attachments.length) return '';
  const parts = [];
  for (const attachment of attachments.slice(0, MAX_ATTACHMENTS)) {
    // eslint-disable-next-line no-await-in-loop
    const text = await extractText(attachment);
    if (text === null) continue;
    const filename = attachment.name || attachment.filename || 'attachment';
    parts.push(`[attached document: ${filename}]\n${text}`);
  }
  const skipped = attachments.length - MAX_ATTACHMENTS;
  if (skipped > 0) {
    parts.push(`[${skipped} more attachment(s) not read — max ${MAX_ATTACHMENTS} per message]`);
  }
  return parts.join('\n\n');
}
