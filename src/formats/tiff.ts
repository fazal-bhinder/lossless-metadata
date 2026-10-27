import { concat } from '../bytes.js';
import type { StripOptions } from '../types.js';

/**
 * TIFF is the awkward one: the metadata *is* the directory structure, and every
 * offset in the file is absolute. So rather than editing in place, we append a
 * freshly built IFD chain containing only the image-critical tags and repoint
 * the header at it. The pixel strips never move, so they stay byte-identical;
 * the old directory and its value heap are zeroed where they are.
 */

/** Tags a decoder genuinely needs to render the image. Everything else goes. */
const ESSENTIAL = new Set([
  0x00fe, 0x00ff, // SubfileType
  0x0100, 0x0101, 0x0102, 0x0103, 0x0106, 0x0107, 0x0108, 0x0109, 0x010a,
  0x0111, // StripOffsets
  0x0115, 0x0116, 0x0117, // SamplesPerPixel, RowsPerStrip, StripByteCounts
  0x011a, 0x011b, 0x011c, 0x0128, // resolution + planar config
  0x013d, 0x0140, // Predictor, ColorMap
  0x0142, 0x0143, 0x0144, 0x0145, // tiled variants
  0x0152, 0x0153, // ExtraSamples, SampleFormat
  0x828d, 0x828e, // CFARepeatPatternDim, CFAPattern
]);

const TAG_ORIENTATION = 0x0112;
const TAG_ICC = 0x8773;
const TAG_COPYRIGHT = 0x8298;
const TAG_ARTIST = 0x013b;

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };

interface Entry { tag: number; type: number; count: number; valueOffset: number; inlineBytes: Uint8Array }
interface Ifd { start: number; entries: Entry[]; next: number }

function readIfds(bytes: Uint8Array, le: boolean, first: number): Ifd[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ifds: Ifd[] = [];
  let at = first;
  const seen = new Set<number>();
  while (at > 0 && at + 2 <= bytes.length && !seen.has(at)) {
    seen.add(at);
    const count = dv.getUint16(at, le);
    const entries: Entry[] = [];
    for (let i = 0; i < count; i++) {
      const e = at + 2 + i * 12;
      if (e + 12 > bytes.length) break;
      entries.push({
        tag: dv.getUint16(e, le),
        type: dv.getUint16(e + 2, le),
        count: dv.getUint32(e + 4, le),
        valueOffset: dv.getUint32(e + 8, le),
        inlineBytes: bytes.subarray(e + 8, e + 12),
      });
    }
    const nextAt = at + 2 + count * 12;
    const next = nextAt + 4 <= bytes.length ? dv.getUint32(nextAt, le) : 0;
    ifds.push({ start: at, entries, next });
    at = next;
  }
  return ifds;
}

const byteLength = (e: Entry) => (TYPE_SIZE[e.type] ?? 1) * e.count;

export interface TiffScan { metadataBytes: number; entries: { tag: number; count: number }[] }

export function scanTiff(bytes: Uint8Array): TiffScan {
  if (bytes.length < 8) return { metadataBytes: 0, entries: [] };
  const le = bytes[0] === 0x49;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ifds = readIfds(bytes, le, dv.getUint32(4, le));
  let metadataBytes = 0;
  const entries: { tag: number; count: number }[] = [];
  for (const ifd of ifds) {
    for (const e of ifd.entries) {
      if (ESSENTIAL.has(e.tag)) continue;
      const len = byteLength(e);
      metadataBytes += 12 + (len > 4 ? len : 0);
      entries.push({ tag: e.tag, count: e.count });
    }
  }
  return { metadataBytes, entries };
}

export function stripTiff(bytes: Uint8Array, opts: StripOptions): { out: Uint8Array; removed: number } {
  if (bytes.length < 8) return { out: bytes, removed: 0 };
  const le = bytes[0] === 0x49;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ifds = readIfds(bytes, le, dv.getUint32(4, le));
  if (ifds.length === 0) return { out: bytes, removed: 0 };

  const keep = (tag: number): boolean => {
    if (ESSENTIAL.has(tag)) return true;
    if (tag === TAG_ORIENTATION) return opts.keepOrientation;
    if (tag === TAG_ICC) return opts.keepIcc;
    if (tag === TAG_COPYRIGHT || tag === TAG_ARTIST) return opts.keepCopyright;
    return false;
  };

  // The rebuild appends a new directory, so running it on a file that has
  // nothing left to drop would grow the file on every pass. Bail out first.
  const droppedEntries = ifds.reduce(
    (n, ifd) => n + ifd.entries.filter((e) => !keep(e.tag)).length,
    0,
  );
  if (droppedEntries === 0) return { out: bytes, removed: 0 };

  const body = bytes.slice();
  let removed = 0;

  // Blank the original directories and the value heap of everything we drop.
  for (const ifd of ifds) {
    for (const e of ifd.entries) {
      const len = byteLength(e);
      if (!keep(e.tag) && len > 4 && e.valueOffset + len <= body.length) {
        body.fill(0, e.valueOffset, e.valueOffset + len);
        removed += len;
      }
    }
    const dirSize = 2 + ifd.entries.length * 12 + 4;
    removed += ifd.entries.filter((e) => !keep(e.tag)).length * 12;
    if (ifd.start + dirSize <= body.length) body.fill(0, ifd.start, ifd.start + dirSize);
  }

  // Build the replacement chain, appended after the existing data.
  const appended: Uint8Array[] = [];
  let cursor = body.length + (body.length % 2); // keep word alignment
  if (cursor > body.length) appended.push(new Uint8Array(cursor - body.length));
  const newFirst = cursor;

  const kept = ifds.map((ifd) => ifd.entries.filter((e) => keep(e.tag)));

  // Pre-compute sizes so we can resolve the "next IFD" pointers up front.
  const dirSizes = kept.map((entries) => 2 + entries.length * 12 + 4);
  const heapSizes = kept.map((entries) =>
    entries.reduce((sum, e) => sum + (byteLength(e) > 4 ? byteLength(e) + (byteLength(e) % 2) : 0), 0),
  );

  const starts: number[] = [];
  let running = newFirst;
  for (let i = 0; i < kept.length; i++) {
    starts.push(running);
    running += dirSizes[i] + heapSizes[i];
  }

  for (let i = 0; i < kept.length; i++) {
    const entries = kept[i];
    const dir = new Uint8Array(dirSizes[i]);
    const ddv = new DataView(dir.buffer);
    ddv.setUint16(0, entries.length, le);

    const heap: Uint8Array[] = [];
    let heapAt = starts[i] + dirSizes[i];

    entries
      .slice()
      .sort((a, b) => a.tag - b.tag)
      .forEach((e, idx) => {
        const at = 2 + idx * 12;
        ddv.setUint16(at, e.tag, le);
        ddv.setUint16(at + 2, e.type, le);
        ddv.setUint32(at + 4, e.count, le);
        const len = byteLength(e);
        if (len <= 4) {
          dir.set(e.inlineBytes, at + 8);
        } else {
          // StripOffsets / TileOffsets still point at untouched pixel data.
          const src = bytes.subarray(e.valueOffset, e.valueOffset + len);
          ddv.setUint32(at + 8, heapAt, le);
          const padded = len + (len % 2);
          const buf = new Uint8Array(padded);
          buf.set(src);
          heap.push(buf);
          heapAt += padded;
        }
      });

    ddv.setUint32(2 + entries.length * 12, i + 1 < kept.length ? starts[i + 1] : 0, le);
    appended.push(dir, ...heap);
  }

  const out = concat([body, ...appended]);
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(4, newFirst, le);
  return { out, removed };
}
