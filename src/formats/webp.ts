import { concat, ascii, writeU32le } from '../bytes';
import type { StripOptions } from '../types';

/**
 * WebP is RIFF: "RIFF" <size> "WEBP" then FourCC chunks.
 * Removing EXIF/XMP/ICCP also means clearing the matching feature bits in the
 * VP8X header, otherwise decoders look for chunks that are no longer there.
 */

const VP8X_ICC = 0x20, VP8X_EXIF = 0x08, VP8X_XMP = 0x04;

export interface WebpScan { metadataBytes: number; hasExif: boolean; hasXmp: boolean; hasIcc: boolean }

interface Chunk { type: string; start: number; end: number; dataStart: number; dataLen: number }

function walk(bytes: Uint8Array): Chunk[] {
  const chunks: Chunk[] = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 12; // RIFF header + WEBP fourcc
  while (i + 8 <= bytes.length) {
    const type = ascii(bytes, i, 4);
    const len = dv.getUint32(i + 4, true);
    const padded = len + (len % 2); // chunks are word-aligned
    const end = i + 8 + padded;
    if (end > bytes.length + 1) break;
    chunks.push({ type, start: i, end: Math.min(end, bytes.length), dataStart: i + 8, dataLen: len });
    i = end;
  }
  return chunks;
}

export function scanWebp(bytes: Uint8Array): WebpScan {
  const out: WebpScan = { metadataBytes: 0, hasExif: false, hasXmp: false, hasIcc: false };
  for (const c of walk(bytes)) {
    if (c.type === 'EXIF') { out.hasExif = true; out.metadataBytes += c.end - c.start; }
    else if (c.type === 'XMP ') { out.hasXmp = true; out.metadataBytes += c.end - c.start; }
    else if (c.type === 'ICCP') { out.hasIcc = true; out.metadataBytes += c.end - c.start; }
  }
  return out;
}

export function stripWebp(bytes: Uint8Array, opts: StripOptions): { out: Uint8Array; removed: number } {
  const parts: Uint8Array[] = [];
  let removed = 0;
  let clearedFlags = 0;

  for (const c of walk(bytes)) {
    let drop = false;
    if (c.type === 'EXIF') { drop = true; clearedFlags |= VP8X_EXIF; }
    else if (c.type === 'XMP ') { drop = true; clearedFlags |= VP8X_XMP; }
    else if (c.type === 'ICCP') { drop = !opts.keepIcc; if (drop) clearedFlags |= VP8X_ICC; }

    if (drop) removed += c.end - c.start;
    else parts.push(bytes.subarray(c.start, c.end).slice()); // copy so we can patch VP8X
  }

  // Patch the VP8X feature flags to match what actually survived.
  if (clearedFlags) {
    for (const p of parts) {
      if (ascii(p, 0, 4) === 'VP8X' && p.length >= 9) { p[8] &= ~clearedFlags & 0xff; break; }
    }
  }

  const header = bytes.subarray(0, 12).slice();
  const body = concat(parts);
  writeU32le(header, 4, body.length + 4); // RIFF size covers "WEBP" + chunks
  return { out: concat([header, body]), removed };
}
