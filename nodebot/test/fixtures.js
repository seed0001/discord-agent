// Test fixtures: real, parseable PDF and DOCX bytes built from scratch.
//
// The Python tests could lean on pypdf/python-docx to WRITE their fixtures,
// but the Node parsers (pdfjs-dist, mammoth) are read-only. Rather than
// commit binary blobs, these build the smallest valid file of each format.
// A .docx is just a ZIP of XML parts, and stored (uncompressed) entries are
// enough for any reader, so no compression is involved.
import { crc32 } from 'node:zlib';

// -- minimal ZIP writer (STORED entries only) --------------------------------

function zipEntry(name, contentBuffer) {
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(contentBuffer);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);   // local file header signature
  local.writeUInt16LE(20, 4);           // version needed
  local.writeUInt16LE(0, 6);            // flags
  local.writeUInt16LE(0, 8);            // method 0 = stored
  local.writeUInt16LE(0, 10);           // mod time
  local.writeUInt16LE(0x21, 12);        // mod date (arbitrary, valid)
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(contentBuffer.length, 18); // compressed size
  local.writeUInt32LE(contentBuffer.length, 22); // uncompressed size
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);           // extra field length
  return {
    name: nameBuf, crc, size: contentBuffer.length,
    local: Buffer.concat([local, nameBuf, contentBuffer]),
  };
}

export function makeZip(files) {
  const entries = [];
  let offset = 0;
  const locals = [];
  for (const [name, content] of Object.entries(files)) {
    const entry = zipEntry(name, Buffer.from(content, 'utf8'));
    entry.offset = offset;
    offset += entry.local.length;
    locals.push(entry.local);
    entries.push(entry);
  }
  const centrals = entries.map((e) => {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); // central directory signature
    header.writeUInt16LE(20, 4);         // version made by
    header.writeUInt16LE(20, 6);         // version needed
    header.writeUInt16LE(0, 8);          // flags
    header.writeUInt16LE(0, 10);         // method 0 = stored
    header.writeUInt16LE(0, 12);         // mod time
    header.writeUInt16LE(0x21, 14);      // mod date
    header.writeUInt32LE(e.crc, 16);
    header.writeUInt32LE(e.size, 20);
    header.writeUInt32LE(e.size, 24);
    header.writeUInt16LE(e.name.length, 28);
    header.writeUInt16LE(0, 30);         // extra length
    header.writeUInt16LE(0, 32);         // comment length
    header.writeUInt16LE(0, 34);         // disk number
    header.writeUInt16LE(0, 36);         // internal attrs
    header.writeUInt32LE(0, 38);         // external attrs
    header.writeUInt32LE(e.offset, 42);  // offset of local header
    return Buffer.concat([header, e.name]);
  });
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);      // end of central directory
  end.writeUInt16LE(0, 4);               // disk number
  end.writeUInt16LE(0, 6);               // disk with central dir
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);         // central dir offset
  end.writeUInt16LE(0, 20);              // comment length
  return Buffer.concat([...locals, centralBuf, end]);
}

// -- DOCX --------------------------------------------------------------------

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
  + '</Types>';

const RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
  + '</Relationships>';

/** A real .docx containing one paragraph per entry in `paragraphs`. */
export function makeDocx(paragraphs) {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`)
    .join('');
  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${body}</w:body></w:document>`;
  return makeZip({
    '[Content_Types].xml': CONTENT_TYPES,
    '_rels/.rels': RELS,
    'word/document.xml': document,
  });
}

// -- PDF ---------------------------------------------------------------------

/**
 * A real single-page PDF. Pass text to get an extractable text run, or omit
 * it for a blank page (the "scanned image, nothing to extract" case).
 * Byte offsets in the xref table are computed as the file is assembled, so
 * this is a structurally valid PDF rather than one a parser has to repair.
 */
export function makePdf(text) {
  const content = text
    ? `BT /F1 24 Tf 72 700 Td (${text.replace(/([()\\])/g, '\\$1')}) Tj ET`
    : '';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
      + '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
    + `startxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
