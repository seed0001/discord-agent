// documents.js — attachment text extraction, mirroring tests/test_documents.py.
// PDF and DOCX are exercised against real files built by fixtures.js, not
// mocks, so a parser regression actually fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as documents from '../src/documents.js';
import { makeDocx, makePdf } from './fixtures.js';

/** Stands in for a discord.js Attachment. The real one exposes a URL and
 * gets fetched; read() is the seam that keeps tests off the network. */
function fakeAttachment(name, data, contentType = null) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return { name, size: buf.length, contentType, read: async () => buf };
}

// -- extractText ------------------------------------------------------------

test('reads a plain text file', async () => {
  assert.equal(await documents.extractText(fakeAttachment('notes.txt', 'hello world')), 'hello world');
});

test('reads a markdown file', async () => {
  assert.equal(await documents.extractText(fakeAttachment('readme.md', '# Title\n\nbody')), '# Title\n\nbody');
});

test('skips an unknown extension with a non-text content type', async () => {
  const result = await documents.extractText(fakeAttachment('photo.png', '\x89PNG...', 'image/png'));
  assert.equal(result, null);
});

test('reads an unknown extension when the content type says text', async () => {
  const result = await documents.extractText(
    fakeAttachment('data.weird', 'some content', 'text/plain; charset=utf-8'),
  );
  assert.equal(result, 'some content');
});

test('refuses to read an oversized file', async () => {
  const attachment = fakeAttachment('huge.txt', 'x');
  attachment.size = documents.MAX_FILE_BYTES + 1;
  const result = await documents.extractText(attachment);
  assert.match(result, /too large/);
});

test('truncates a very long text file to the extract cap', async () => {
  const result = await documents.extractText(
    fakeAttachment('big.txt', 'x'.repeat(documents.EXTRACT_MAX + 5000)),
  );
  assert.equal(result.length, documents.EXTRACT_MAX);
});

test('extracts text from a real PDF', async () => {
  const result = await documents.extractText(fakeAttachment('doc.pdf', makePdf('Hello from a test PDF')));
  assert.match(result, /Hello from a test PDF/);
});

test('reports a PDF with no text layer rather than returning empty', async () => {
  const result = await documents.extractText(fakeAttachment('scan.pdf', makePdf(null)));
  assert.match(result, /No extractable text/);
});

test('a corrupt PDF returns an error message instead of throwing', async () => {
  const result = await documents.extractText(fakeAttachment('bad.pdf', 'not a pdf'));
  assert.match(result, /Couldn't read/);
});

test('extracts text from a real Word document', async () => {
  const docx = makeDocx(['Hello from a Word doc.']);
  assert.equal(await documents.extractText(fakeAttachment('doc.docx', docx)), 'Hello from a Word doc.');
});

test('reads every paragraph of a multi-paragraph Word document', async () => {
  const docx = makeDocx(['First paragraph.', 'Second paragraph.', 'Third one.']);
  const result = await documents.extractText(fakeAttachment('doc.docx', docx));
  assert.match(result, /First paragraph\./);
  assert.match(result, /Second paragraph\./);
  assert.match(result, /Third one\./);
});

test('a corrupt Word document returns an error message instead of throwing', async () => {
  const result = await documents.extractText(fakeAttachment('bad.docx', 'not a docx'));
  assert.match(result, /Couldn't read/);
});

test('a failed download is reported, not thrown', async () => {
  const attachment = {
    name: 'gone.txt', size: 10, contentType: 'text/plain',
    read: async () => { throw new Error('404'); },
  };
  assert.match(await documents.extractText(attachment), /Couldn't download/);
});

// -- buildAttachmentContext -------------------------------------------------

test('no attachments produces no context', async () => {
  assert.equal(await documents.buildAttachmentContext({ attachments: [] }), '');
});

test('a single text attachment is labelled with its filename', async () => {
  const ctx = await documents.buildAttachmentContext({
    attachments: [fakeAttachment('plan.txt', 'the plan')],
  });
  assert.match(ctx, /plan\.txt/);
  assert.match(ctx, /the plan/);
});

test('unsupported attachments are skipped entirely', async () => {
  const ctx = await documents.buildAttachmentContext({
    attachments: [fakeAttachment('photo.png', '\x89PNG', 'image/png')],
  });
  assert.equal(ctx, '');
});

test('attachments past the per-message cap are reported, not silently dropped', async () => {
  const attachments = Array.from(
    { length: documents.MAX_ATTACHMENTS + 2 },
    (_, i) => fakeAttachment(`f${i}.txt`, 'x'),
  );
  const ctx = await documents.buildAttachmentContext({ attachments });
  assert.match(ctx, /2 more attachment\(s\) not read/);
});

test('accepts a discord.js Collection of attachments, not just an array', async () => {
  // message.attachments is a Collection on a real Message — it has .values().
  const collection = new Map([['1', fakeAttachment('plan.txt', 'the plan')]]);
  const ctx = await documents.buildAttachmentContext({ attachments: collection });
  assert.match(ctx, /the plan/);
});
