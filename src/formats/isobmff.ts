import { ascii } from '../bytes.js';

/**
 * ISO Base Media File Format — the container behind HEIC, AVIF, MP4 and MOV.
 *
 * Two different strategies live here, because the format demands it:
 *
 *  - HEIC/AVIF store EXIF/XMP/C2PA as *items* whose byte ranges are recorded in
 *    an `iloc` table. Deleting those bytes would invalidate every offset in the
 *    file, so instead we overwrite the payloads in place with zeros. The file
 *    stays structurally valid, every offset still resolves, and the pixels are
 *    untouched.
 *
 *  - MP4/MOV keep metadata in `udta`/`meta` boxes inside `moov`, while `stco`
 *    chunk offsets point into `mdat`. Shrinking `moov` would shift all of them,
 *    so we swap the metadata boxes for `free` boxes of identical size. `free` is
 *    spec-defined padding that every demuxer skips.
 *
 * Both are byte-exact for pixel data. Neither ever decodes a frame.
 */

export interface Box { type: string; start: number; end: number; headerSize: number }

export function readBoxes(bytes: Uint8Array, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = start;
  while (i + 8 <= end) {
    let size = dv.getUint32(i, false);
    const type = ascii(bytes, i + 4, 4);
    let headerSize = 8;
    if (size === 1) {
      if (i + 16 > end) break;
      const hi = dv.getUint32(i + 8, false);
      const lo = dv.getUint32(i + 12, false);
      size = hi * 0x100000000 + lo;
      headerSize = 16;
    } else if (size === 0) {
      size = end - i;
    }
    if (size < headerSize || i + size > end) break;
    boxes.push({ type, start: i, end: i + size, headerSize });
    i += size;
  }
  return boxes;
}

export function findBox(bytes: Uint8Array, path: string[], start = 0, end = bytes.length): Box | null {
  let boxes = readBoxes(bytes, start, end);
  let current: Box | null = null;
  for (let depth = 0; depth < path.length; depth++) {
    current = boxes.find((b) => b.type === path[depth]) ?? null;
    if (!current) return null;
    if (depth < path.length - 1) {
      // `meta` is a FullBox: 4 extra bytes before its children.
      const childStart = current.start + current.headerSize + (current.type === 'meta' ? 4 : 0);
      boxes = readBoxes(bytes, childStart, current.end);
    }
  }
  return current;
}

/* ── HEIC / AVIF ────────────────────────────────────────────────────────── */

export interface HeifItem { id: number; type: string; contentType: string; ranges: [number, number][] }

function parseIinf(bytes: Uint8Array, box: Box): Map<number, { type: string; contentType: string }> {
  const map = new Map<number, { type: string; contentType: string }>();
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = box.start + box.headerSize;
  const version = bytes[p];
  p += 4;
  if (version === 0) p += 2; else p += 4;
  for (const infe of readBoxes(bytes, p, box.end)) {
    if (infe.type !== 'infe') continue;
    let q = infe.start + infe.headerSize;
    const v = bytes[q];
    q += 4;
    let id: number;
    if (v >= 3) { id = dv.getUint32(q, false); q += 4; } else { id = dv.getUint16(q, false); q += 2; }
    q += 2; // protection index
    const type = ascii(bytes, q, 4); q += 4;
    while (q < infe.end && bytes[q] !== 0) q++; // item_name
    q++;
    let contentType = '';
    if (type === 'mime' && q < infe.end) {
      const s = q;
      while (q < infe.end && bytes[q] !== 0) q++;
      contentType = ascii(bytes, s, q - s);
    }
    map.set(id, { type, contentType });
  }
  return map;
}

function parseIloc(bytes: Uint8Array, box: Box): Map<number, [number, number][]> {
  const out = new Map<number, [number, number][]>();
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = box.start + box.headerSize;
  const version = bytes[p];
  p += 4;
  const offsetSize = bytes[p] >> 4, lengthSize = bytes[p] & 0x0f; p++;
  const baseOffsetSize = bytes[p] >> 4, indexSize = bytes[p] & 0x0f; p++;

  const readN = (n: number): number => {
    let v = 0;
    for (let k = 0; k < n; k++) v = v * 256 + bytes[p + k];
    p += n;
    return v;
  };

  let count: number;
  if (version < 2) { count = dv.getUint16(p, false); p += 2; }
  else { count = dv.getUint32(p, false); p += 4; }

  for (let i = 0; i < count && p < box.end; i++) {
    let id: number;
    if (version < 2) { id = dv.getUint16(p, false); p += 2; }
    else { id = dv.getUint32(p, false); p += 4; }
    if (version === 1 || version === 2) p += 2; // construction_method
    p += 2; // data_reference_index
    const base = readN(baseOffsetSize);
    const extents = dv.getUint16(p, false); p += 2;
    const ranges: [number, number][] = [];
    for (let e = 0; e < extents; e++) {
      if ((version === 1 || version === 2) && indexSize > 0) readN(indexSize);
      const off = readN(offsetSize);
      const len = readN(lengthSize);
      ranges.push([base + off, len]);
    }
    out.set(id, ranges);
  }
  return out;
}

export interface HeifScan {
  items: HeifItem[];
  metadataBytes: number;
  hasC2PA: boolean;
  hasExif: boolean;
  hasXmp: boolean;
}

export function scanHeif(bytes: Uint8Array): HeifScan {
  const items: HeifItem[] = [];
  let metadataBytes = 0, hasC2PA = false, hasExif = false, hasXmp = false;

  const meta = findBox(bytes, ['meta']);
  if (meta) {
    const childStart = meta.start + meta.headerSize + 4;
    const children = readBoxes(bytes, childStart, meta.end);
    const iinfBox = children.find((b) => b.type === 'iinf');
    const ilocBox = children.find((b) => b.type === 'iloc');
    if (iinfBox && ilocBox) {
      const infos = parseIinf(bytes, iinfBox);
      const locs = parseIloc(bytes, ilocBox);
      for (const [id, info] of infos) {
        const isExif = info.type === 'Exif';
        const isXmp = info.type === 'mime' && /xmp|rdf/i.test(info.contentType);
        const isC2pa = info.type === 'jumb' || /c2pa/i.test(info.contentType);
        if (!isExif && !isXmp && !isC2pa) continue;
        const ranges = locs.get(id) ?? [];
        for (const [, len] of ranges) metadataBytes += len;
        if (isExif) hasExif = true;
        if (isXmp) hasXmp = true;
        if (isC2pa) hasC2PA = true;
        items.push({ id, type: info.type, contentType: info.contentType, ranges });
      }
    }
  }

  // Top-level uuid / jumb boxes are the other common XMP and C2PA hiding place.
  for (const b of readBoxes(bytes, 0, bytes.length)) {
    if (b.type === 'uuid' || b.type === 'jumb') {
      metadataBytes += b.end - b.start;
      if (b.type === 'jumb') hasC2PA = true; else hasXmp = true;
      items.push({
        id: -1,
        type: b.type,
        contentType: '',
        ranges: [[b.start + b.headerSize, b.end - b.start - b.headerSize]],
      });
    }
  }

  return { items, metadataBytes, hasC2PA, hasExif, hasXmp };
}

export function stripHeif(bytes: Uint8Array): { out: Uint8Array; removed: number } {
  const out = bytes.slice();
  const { items } = scanHeif(bytes);
  let removed = 0;
  for (const item of items) {
    for (const [off, len] of item.ranges) {
      if (off < 0 || len <= 0 || off + len > out.length) continue;
      out.fill(0, off, off + len);
      removed += len;
    }
  }
  return { out, removed };
}

/* ── MP4 / MOV ──────────────────────────────────────────────────────────── */

/** Metadata boxes that can be safely blanked to `free` without moving anything. */
const VIDEO_META_BOXES = new Set(['udta', 'meta', 'uuid', 'skip']);

const CONTAINERS = ['trak', 'mdia', 'minf', 'stbl', 'edts', 'moof', 'traf'];

function blankToFree(buf: Uint8Array, box: Box): number {
  // Keep the 4-byte size field, rewrite the type to 'free', zero the payload.
  buf[box.start + 4] = 0x66; // f
  buf[box.start + 5] = 0x72; // r
  buf[box.start + 6] = 0x65; // e
  buf[box.start + 7] = 0x65; // e
  buf.fill(0, box.start + box.headerSize, box.end);
  return box.end - box.start;
}

/** Zero the creation/modification timestamps in an mvhd/tkhd/mdhd FullBox. */
function zeroTimestamps(buf: Uint8Array, box: Box): void {
  const p = box.start + box.headerSize;
  const version = buf[p];
  const at = p + 4;
  if (version === 1) {
    if (at + 16 <= box.end) buf.fill(0, at, at + 16);
  } else {
    if (at + 8 <= box.end) buf.fill(0, at, at + 8);
  }
}

/** Recursively neutralise metadata inside a `moov` buffer, in place. */
export function cleanMoov(buf: Uint8Array, start: number, end: number): number {
  let removed = 0;
  for (const box of readBoxes(buf, start, end)) {
    if (VIDEO_META_BOXES.has(box.type)) {
      removed += blankToFree(buf, box);
      continue;
    }
    if (box.type === 'mvhd' || box.type === 'tkhd' || box.type === 'mdhd') {
      zeroTimestamps(buf, box);
      continue;
    }
    if (CONTAINERS.includes(box.type)) {
      removed += cleanMoov(buf, box.start + box.headerSize, box.end);
    }
  }
  return removed;
}

export interface MoovScan { metadataBytes: number; tags: { key: string; value: string }[] }

export function scanMoov(buf: Uint8Array, start: number, end: number): MoovScan {
  let metadataBytes = 0;
  const tags: { key: string; value: string }[] = [];
  for (const box of readBoxes(buf, start, end)) {
    if (VIDEO_META_BOXES.has(box.type)) {
      metadataBytes += box.end - box.start;
      collectAtomTags(buf, box.start + box.headerSize, box.end, tags);
      continue;
    }
    if (CONTAINERS.includes(box.type)) {
      const sub = scanMoov(buf, box.start + box.headerSize, box.end);
      metadataBytes += sub.metadataBytes;
      tags.push(...sub.tags);
    }
  }
  return { metadataBytes, tags };
}

const COPYRIGHT_SIGN = String.fromCharCode(0xa9);

const LABELS: Record<string, string> = {
  [COPYRIGHT_SIGN + 'xyz']: 'GPSCoordinates',
  [COPYRIGHT_SIGN + 'nam']: 'Title',
  [COPYRIGHT_SIGN + 'cmt']: 'Comment',
  [COPYRIGHT_SIGN + 'ART']: 'Artist',
  [COPYRIGHT_SIGN + 'too']: 'EncodingSoftware',
  [COPYRIGHT_SIGN + 'day']: 'CreationDate',
  [COPYRIGHT_SIGN + 'mak']: 'Make',
  [COPYRIGHT_SIGN + 'mod']: 'Model',
  [COPYRIGHT_SIGN + 'swr']: 'Software',
  'gps ': 'GPSCoordinates',
  loci: 'LocationInformation',
};

/** QuickTime-style atoms plus iTunes `ilst` entries. */
function collectAtomTags(
  buf: Uint8Array,
  start: number,
  end: number,
  out: { key: string; value: string }[],
): void {
  for (const box of readBoxes(buf, start, end)) {
    const name = box.type;
    if (name === 'meta') { collectAtomTags(buf, box.start + box.headerSize + 4, box.end, out); continue; }
    if (name === 'ilst') { collectAtomTags(buf, box.start + box.headerSize, box.end, out); continue; }
    if (name === 'hdlr' || name === 'free') continue;

    const payload = buf.subarray(
      box.start + box.headerSize,
      Math.min(box.end, box.start + box.headerSize + 512),
    );
    // Atom payloads carry small binary prefixes; keep only printable runs.
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(payload);
    const text = (decoded.match(/[\x20-\x7e][\x20-\x7e\s]{2,}/g) ?? []).join(' ').trim();
    if (text.length > 2) {
      out.push({
        key: LABELS[name] ?? name.replace(new RegExp(COPYRIGHT_SIGN, 'g'), ''),
        value: text.slice(0, 200),
      });
    }
  }
}
