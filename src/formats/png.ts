import { concat, ascii, u32be } from '../bytes';
import type { StripOptions } from '../types';

/**
 * PNG is a signature followed by length-prefixed, CRC-checked chunks.
 * Because we copy surviving chunks byte-for-byte (CRC included) there is
 * nothing to recompute and the IDAT pixel stream is never touched.
 */

const SIG = 8;

/** Chunks that carry metadata rather than image data. */
const METADATA_CHUNKS = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME', 'caBX', 'dSIG', 'iDOT']);

export interface PngScan {
  metadataBytes: number;
  hasC2PA: boolean;
  hasExif: boolean;
  hasIcc: boolean;
  text: { key: string; value: string }[];
  width?: number;
  height?: number;
}

interface Chunk { type: string; start: number; end: number; dataStart: number; dataLen: number }

function walk(bytes: Uint8Array): Chunk[] {
  const chunks: Chunk[] = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = SIG;
  while (i + 8 <= bytes.length) {
    const len = dv.getUint32(i, false);
    const type = ascii(bytes, i + 4, 4);
    const end = i + 12 + len;
    if (len > bytes.length || end > bytes.length) break;
    chunks.push({ type, start: i, end, dataStart: i + 8, dataLen: len });
    if (type === 'IEND') break;
    i = end;
  }
  return chunks;
}

function decodeText(bytes: Uint8Array, c: Chunk): { key: string; value: string } | null {
  const raw = bytes.subarray(c.dataStart, c.dataStart + c.dataLen);
  const nul = raw.indexOf(0);
  if (nul < 0) return null;
  const key = ascii(raw, 0, nul);
  if (c.type === 'tEXt') {
    return { key, value: new TextDecoder().decode(raw.subarray(nul + 1)) };
  }
  if (c.type === 'iTXt') {
    // key \0 compressionFlag compressionMethod langTag \0 translatedKey \0 text
    let p = nul + 1;
    const compressed = raw[p] === 1;
    p += 2;
    const langEnd = raw.indexOf(0, p); if (langEnd < 0) return null;
    p = langEnd + 1;
    const transEnd = raw.indexOf(0, p); if (transEnd < 0) return null;
    p = transEnd + 1;
    if (compressed) return { key, value: '[compressed]' };
    return { key, value: new TextDecoder().decode(raw.subarray(p)) };
  }
  return { key, value: '[compressed]' }; // zTXt — deflate, not worth inflating just to display
}

export function scanPng(bytes: Uint8Array): PngScan {
  const out: PngScan = { metadataBytes: 0, hasC2PA: false, hasExif: false, hasIcc: false, text: [] };
  for (const c of walk(bytes)) {
    if (c.type === 'IHDR' && c.dataLen >= 8) {
      out.width = u32be(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), c.dataStart);
      out.height = u32be(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), c.dataStart + 4);
    }
    if (c.type === 'caBX') { out.hasC2PA = true; out.metadataBytes += c.end - c.start; }
    else if (c.type === 'eXIf') { out.hasExif = true; out.metadataBytes += c.end - c.start; }
    else if (c.type === 'iCCP') { out.hasIcc = true; out.metadataBytes += c.end - c.start; }
    else if (METADATA_CHUNKS.has(c.type)) {
      out.metadataBytes += c.end - c.start;
      if (c.type === 'tEXt' || c.type === 'iTXt' || c.type === 'zTXt') {
        const t = decodeText(bytes, c);
        if (t) out.text.push(t);
      }
    }
  }
  return out;
}

export function stripPng(bytes: Uint8Array, opts: StripOptions): { out: Uint8Array; removed: number } {
  const parts: Uint8Array[] = [bytes.subarray(0, SIG)];
  let removed = 0;
  for (const c of walk(bytes)) {
    let drop = METADATA_CHUNKS.has(c.type);
    if (c.type === 'iCCP') drop = !opts.keepIcc;
    // gAMA / cHRM / sRGB / sBIT are rendering intent, not personal data — always kept.
    if (drop) removed += c.end - c.start;
    else parts.push(bytes.subarray(c.start, c.end));
  }
  return { out: concat(parts), removed };
}
