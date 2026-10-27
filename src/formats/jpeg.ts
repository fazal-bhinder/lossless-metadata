import { concat, startsWith, ascii } from '../bytes.js';
import type { StripOptions } from '../types.js';

/**
 * JPEG is a sequence of marker segments followed by entropy-coded scan data.
 * We walk the segments, drop the ones that carry metadata, and copy the scan
 * data through byte-for-byte. The pixels are never decoded, so the output is
 * bit-identical where it matters.
 */

export interface JpegScan {
  /** Byte ranges that hold metadata (used for the "x KB of metadata" readout). */
  metadataBytes: number;
  hasC2PA: boolean;
  hasExif: boolean;
  hasXmp: boolean;
  hasIcc: boolean;
  hasIptc: boolean;
  orientation?: number;
  copyright?: string;
  artist?: string;
  xmpText: string;
  comments: string[];
}

const APP1 = 0xe1, APP2 = 0xe2, APP11 = 0xeb, APP13 = 0xed, APP14 = 0xee, COM = 0xfe;
const SOS = 0xda, SOI = 0xd8, EOI = 0xd9;

/** Markers that carry no length field. */
function isStandalone(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9);
}

interface Segment { marker: number; start: number; end: number; dataStart: number }

function walk(bytes: Uint8Array): { segments: Segment[]; scanStart: number } {
  const segments: Segment[] = [];
  let i = 2; // skip SOI
  while (i < bytes.length - 1) {
    if (bytes[i] !== 0xff) { i++; continue; }
    let marker = bytes[i + 1];
    // Skip fill bytes
    while (marker === 0xff && i + 2 < bytes.length) { i++; marker = bytes[i + 1]; }
    if (marker === EOI) break;
    if (isStandalone(marker)) { i += 2; continue; }
    if (i + 4 > bytes.length) break;
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    const end = i + 2 + length;
    segments.push({ marker, start: i, end, dataStart: i + 4 });
    if (marker === SOS) return { segments, scanStart: end };
    i = end;
  }
  return { segments, scanStart: bytes.length };
}

export function scanJpeg(bytes: Uint8Array): JpegScan {
  const { segments } = walk(bytes);
  const out: JpegScan = {
    metadataBytes: 0, hasC2PA: false, hasExif: false, hasXmp: false,
    hasIcc: false, hasIptc: false, xmpText: '', comments: [],
  };

  for (const seg of segments) {
    const { marker, dataStart, start, end } = seg;
    const size = end - start;
    if (marker === APP1) {
      if (startsWith(bytes, dataStart, 'Exif\0\0')) {
        out.hasExif = true;
        out.metadataBytes += size;
        const tiff = dataStart + 6;
        readTiffBasics(bytes, tiff, out);
      } else if (startsWith(bytes, dataStart, 'http://ns.adobe.com/xap/1.0/\0')) {
        out.hasXmp = true;
        out.metadataBytes += size;
        out.xmpText += ascii(bytes, dataStart + 29, Math.min(end - dataStart - 29, 65536));
      }
    } else if (marker === APP2 && startsWith(bytes, dataStart, 'ICC_PROFILE\0')) {
      out.hasIcc = true;
      out.metadataBytes += size;
    } else if (marker === APP11) {
      out.hasC2PA = true;
      out.metadataBytes += size;
    } else if (marker === APP13) {
      out.hasIptc = true;
      out.metadataBytes += size;
    } else if (marker === COM) {
      out.comments.push(ascii(bytes, dataStart, Math.min(end - dataStart, 4096)));
      out.metadataBytes += size;
    }
  }
  return out;
}

/** Pull just Orientation / Copyright / Artist out of IFD0 so we can rebuild them. */
function readTiffBasics(bytes: Uint8Array, tiffStart: number, out: JpegScan): void {
  if (tiffStart + 8 > bytes.length) return;
  const le = bytes[tiffStart] === 0x49;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = dv.getUint16(tiffStart + 2, le);
  if (magic !== 0x2a) return;
  const ifd0 = tiffStart + dv.getUint32(tiffStart + 4, le);
  if (ifd0 + 2 > bytes.length) return;
  const count = dv.getUint16(ifd0, le);
  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > bytes.length) break;
    const tag = dv.getUint16(entry, le);
    const type = dv.getUint16(entry + 2, le);
    const n = dv.getUint32(entry + 4, le);
    if (tag === 0x0112 && type === 3) {
      out.orientation = dv.getUint16(entry + 8, le);
    } else if ((tag === 0x8298 || tag === 0x013b) && type === 2) {
      const valOffset = n <= 4 ? entry + 8 : tiffStart + dv.getUint32(entry + 8, le);
      const text = ascii(bytes, valOffset, Math.max(0, n - 1));
      if (tag === 0x8298) out.copyright = text; else out.artist = text;
    }
  }
}

/**
 * Build a minimal EXIF APP1 segment holding only the fields the user chose to
 * keep. Dropping the original EXIF block wholesale and re-emitting 1-3 tags is
 * far safer than trying to surgically edit a vendor's IFD in place.
 */
function buildMinimalExif(fields: { orientation?: number; copyright?: string; artist?: string }): Uint8Array | null {
  const entries: { tag: number; type: number; value: number | string }[] = [];
  if (fields.orientation && fields.orientation >= 1 && fields.orientation <= 8) {
    entries.push({ tag: 0x0112, type: 3, value: fields.orientation });
  }
  if (fields.artist) entries.push({ tag: 0x013b, type: 2, value: fields.artist });
  if (fields.copyright) entries.push({ tag: 0x8298, type: 2, value: fields.copyright });
  if (entries.length === 0) return null;

  entries.sort((a, b) => a.tag - b.tag); // TIFF requires ascending tag order

  const ifdSize = 2 + entries.length * 12 + 4;
  const heapParts: Uint8Array[] = [];
  let heapLen = 0;
  const enc = new TextEncoder();

  // TIFF body: header(8) + IFD + heap for values longer than 4 bytes
  const ifd = new Uint8Array(ifdSize);
  const idv = new DataView(ifd.buffer);
  idv.setUint16(0, entries.length, true);

  entries.forEach((e, i) => {
    const at = 2 + i * 12;
    idv.setUint16(at, e.tag, true);
    idv.setUint16(at + 2, e.type, true);
    if (e.type === 3) {
      idv.setUint32(at + 4, 1, true);
      idv.setUint16(at + 8, e.value as number, true);
      idv.setUint16(at + 10, 0, true);
    } else {
      const raw = enc.encode(String(e.value));
      const withNul = new Uint8Array(raw.length + 1);
      withNul.set(raw);
      idv.setUint32(at + 4, withNul.length, true);
      if (withNul.length <= 4) {
        ifd.set(withNul, at + 8);
      } else {
        idv.setUint32(at + 8, 8 + ifdSize + heapLen, true); // offset from TIFF header start
        heapParts.push(withNul);
        heapLen += withNul.length;
      }
    }
  });

  const header = new Uint8Array(8);
  header.set([0x49, 0x49, 0x2a, 0x00]); // little-endian TIFF
  new DataView(header.buffer).setUint32(4, 8, true); // IFD0 at offset 8

  const tiff = concat([header, ifd, ...heapParts]);
  const payload = concat([enc.encode('Exif\0\0'), tiff]);
  const segLen = payload.length + 2;
  if (segLen > 0xffff) return null;

  const seg = new Uint8Array(payload.length + 4);
  seg[0] = 0xff; seg[1] = APP1;
  seg[2] = (segLen >> 8) & 0xff; seg[3] = segLen & 0xff;
  seg.set(payload, 4);
  return seg;
}

export function stripJpeg(bytes: Uint8Array, opts: StripOptions): { out: Uint8Array; removed: number } {
  const { segments, scanStart } = walk(bytes);
  const scan = scanJpeg(bytes);
  const parts: Uint8Array[] = [bytes.subarray(0, 2)]; // SOI
  let removed = 0;
  let injected = false;

  const keptExif = buildMinimalExif({
    orientation: opts.keepOrientation ? scan.orientation : undefined,
    copyright: opts.keepCopyright ? scan.copyright : undefined,
    artist: opts.keepCopyright ? scan.artist : undefined,
  });

  for (const seg of segments) {
    if (seg.marker === SOS) break;
    const { marker, dataStart, start, end } = seg;
    let drop = false;

    if (marker === APP1) {
      // Both EXIF and XMP live in APP1. Drop either; re-emit a minimal EXIF once.
      drop = true;
      if (!injected && keptExif) { parts.push(keptExif); injected = true; }
    } else if (marker === APP2 && startsWith(bytes, dataStart, 'ICC_PROFILE\0')) {
      drop = !opts.keepIcc;
    } else if (marker === APP11) {
      drop = true; // JUMBF / C2PA content credentials
    } else if (marker === APP13) {
      drop = true; // Photoshop IRB, carries IPTC
    } else if (marker === COM) {
      drop = true;
    } else if (marker >= 0xe3 && marker <= 0xef && marker !== APP14) {
      // APP3-APP15 are vendor scratch space. APP14 ("Adobe") is load-bearing:
      // it declares the colour transform, and removing it breaks CMYK/YCCK files.
      drop = true;
    }

    if (drop) { removed += end - start; } else { parts.push(bytes.subarray(start, end)); }
  }

  // If EXIF was absent but the user asked to keep orientation, there is nothing to keep.
  if (!injected && keptExif) parts.push(keptExif);

  // Everything from SOS onward — headers plus entropy-coded pixels — copied verbatim.
  const sos = segments.find((s) => s.marker === SOS);
  if (sos) parts.push(bytes.subarray(sos.start, bytes.length));
  else parts.push(bytes.subarray(scanStart));

  return { out: concat(parts), removed };
}
