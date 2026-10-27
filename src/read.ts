import ExifReader from 'exifreader';
import { sniffFormat } from './bytes.js';
import { classify } from './tags.js';
import { detectAi, detectC2pa } from './detect.js';
import { scanJpeg } from './formats/jpeg.js';
import { scanPng } from './formats/png.js';
import { scanWebp } from './formats/webp.js';
import { scanGif } from './formats/gif.js';
import { scanTiff } from './formats/tiff.js';
import { scanHeif, scanMoov } from './formats/isobmff.js';
import type { FormatId, GpsFix, MetadataReport, Tag } from './types.js';

const LOSSLESS_FORMATS = new Set<FormatId>(['jpeg', 'png', 'webp', 'gif', 'tiff', 'heic', 'avif', 'mp4', 'mov']);
const VIDEO_FORMATS = new Set<FormatId>(['mp4', 'mov']);

export const isVideo = (f: FormatId) => VIDEO_FORMATS.has(f);

function pushTag(tags: Tag[], id: string, value: unknown, group: string): void {
  if (value === null || value === undefined) return;
  let text: string;
  if (Array.isArray(value)) text = value.slice(0, 12).join(', ');
  else if (typeof value === 'object') text = JSON.stringify(value).slice(0, 300);
  else text = String(value);
  text = text.trim();
  if (!text || text === '[object Object]' || text === 'undefined') return;
  if (text.length > 400) text = text.slice(0, 400) + '…';
  const { category, severity } = classify(id, group);
  tags.push({ id, label: humanize(id), value: text, group, category, severity });
}

function humanize(id: string): string {
  return id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toDisplayGps(lat: number, lon: number): string {
  const f = (v: number, pos: string, neg: string) =>
    `${Math.abs(v).toFixed(6)}° ${v >= 0 ? pos : neg}`;
  return `${f(lat, 'N', 'S')}, ${f(lon, 'E', 'W')}`;
}

/** Pull tags out of ExifReader's expanded result without trusting its shape too hard. */
function harvestExif(result: Record<string, any>, tags: Tag[], collected: { key: string; value: string }[]): void {
  const GROUPS: [string, string][] = [
    ['exif', 'EXIF'], ['gps', 'GPS'], ['iptc', 'IPTC'], ['xmp', 'XMP'],
    ['icc', 'ICC'], ['pngText', 'PNG'], ['riff', 'RIFF'], ['photoshop', 'Photoshop'],
    ['mpf', 'MPF'], ['Thumbnail', 'Thumbnail'], ['makerNote', 'MakerNote'],
  ];
  for (const [key, label] of GROUPS) {
    const section = result[key];
    if (!section || typeof section !== 'object') continue;
    for (const [tagName, raw] of Object.entries<any>(section)) {
      if (tagName === 'Thumbnail' || tagName === 'base64') continue;
      const value = raw?.description ?? raw?.value ?? raw;
      pushTag(tags, tagName, value, label);
      collected.push({ key: tagName, value: String(value ?? '').slice(0, 4000) });
    }
  }
}

export async function readMetadata(file: File): Promise<MetadataReport> {
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const format = sniffFormat(head) as FormatId;

  const base: MetadataReport = {
    fileName: file.name,
    fileSize: file.size,
    mime: file.type || 'application/octet-stream',
    format,
    tags: [],
    hasC2PA: false,
    metadataBytes: 0,
    canStripLosslessly: LOSSLESS_FORMATS.has(format),
    hasThumbnail: false,
  };

  if (format === 'unknown') {
    return { ...base, error: 'Unsupported file type. This tool handles JPEG, PNG, WebP, AVIF, HEIC, GIF, TIFF, MP4 and MOV.' };
  }

  try {
    return isVideo(format) ? await readVideo(file, base) : await readImage(file, base);
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : 'Could not read this file.' };
  }
}

async function readImage(file: File, base: MetadataReport): Promise<MetadataReport> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const tags: Tag[] = [];
  const collected: { key: string; value: string }[] = [];
  let metadataBytes = 0;
  let hasC2PA = false;
  let xmpText = '';

  switch (base.format) {
    case 'jpeg': {
      const s = scanJpeg(bytes);
      metadataBytes = s.metadataBytes;
      hasC2PA = s.hasC2PA;
      xmpText = s.xmpText;
      for (const c of s.comments) collected.push({ key: 'Comment', value: c });
      break;
    }
    case 'png': {
      const s = scanPng(bytes);
      metadataBytes = s.metadataBytes;
      hasC2PA = s.hasC2PA;
      base.width = s.width; base.height = s.height;
      for (const t of s.text) {
        collected.push(t);
        pushTag(tags, t.key, t.value, 'PNG text');
      }
      break;
    }
    case 'webp': metadataBytes = scanWebp(bytes).metadataBytes; break;
    case 'gif': {
      const s = scanGif(bytes);
      metadataBytes = s.metadataBytes;
      for (const c of s.comments) { collected.push({ key: 'Comment', value: c }); pushTag(tags, 'Comment', c, 'GIF'); }
      break;
    }
    case 'tiff': metadataBytes = scanTiff(bytes).metadataBytes; break;
    case 'heic':
    case 'avif': {
      const s = scanHeif(bytes);
      metadataBytes = s.metadataBytes;
      hasC2PA = s.hasC2PA;
      break;
    }
  }

  try {
    const result = ExifReader.load(bytes.buffer as ArrayBuffer, { expanded: true, includeUnknown: false }) as Record<string, any>;
    harvestExif(result, tags, collected);

    if (result.file) {
      base.width = base.width ?? result.file['Image Width']?.value;
      base.height = base.height ?? result.file['Image Height']?.value;
    }
    if (result.Thumbnail?.image || result.exif?.ThumbnailLength) base.hasThumbnail = true;

    const g = result.gps;
    if (g && typeof g.Latitude === 'number' && typeof g.Longitude === 'number') {
      base.gps = {
        lat: g.Latitude,
        lon: g.Longitude,
        altitude: typeof g.Altitude === 'number' ? g.Altitude : undefined,
        display: toDisplayGps(g.Latitude, g.Longitude),
      } satisfies GpsFix;
    }
    if (result.xmp?._raw) xmpText += String(result.xmp._raw);
  } catch {
    // A file with no parseable metadata is a perfectly normal outcome.
  }

  const ai = detectAi(collected, xmpText);

  // Dedupe: ExifReader and our own container scan can surface the same field.
  const seen = new Set<string>();
  const deduped = tags.filter((t) => {
    const key = t.group + '|' + t.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    ...base,
    tags: deduped,
    metadataBytes,
    hasC2PA: hasC2PA || detectC2pa(xmpText, collected.map((c) => c.value)),
    aiGenerator: ai.generator,
  };
}

/**
 * Video is read by slicing, never by loading the whole file. A 2 GB MOV only
 * ever puts its `moov` box (a few hundred KB) into memory.
 */
async function readVideo(file: File, base: MetadataReport): Promise<MetadataReport> {
  const tags: Tag[] = [];
  const collected: { key: string; value: string }[] = [];
  let metadataBytes = 0;

  const moov = await locateMoov(file);
  if (moov) {
    const buf = new Uint8Array(await file.slice(moov.start, moov.end).arrayBuffer());
    const scan = scanMoov(buf, 8, buf.length);
    metadataBytes = scan.metadataBytes;
    for (const t of scan.tags) {
      collected.push(t);
      pushTag(tags, t.key, t.value, 'QuickTime');
    }
    const coords = scan.tags.find((t) => t.key === 'GPSCoordinates');
    if (coords) {
      // ISO 6709, e.g. "+37.7749-122.4194+010.000/"
      const m = coords.value.match(/([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
      if (m) {
        const lat = parseFloat(m[1]);
        const lon = parseFloat(m[2]);
        base.gps = { lat, lon, display: toDisplayGps(lat, lon) };
      }
    }
  }

  const ai = detectAi(collected);
  return { ...base, tags, metadataBytes, aiGenerator: ai.generator };
}

/** Walk top-level boxes via slices to find `moov` without reading the whole file. */
export async function locateMoov(file: File): Promise<{ start: number; end: number } | null> {
  let offset = 0;
  const guard = 4096; // top-level box count is tiny; this is only a runaway stop
  for (let i = 0; i < guard && offset + 8 <= file.size; i++) {
    const header = new Uint8Array(await file.slice(offset, offset + 16).arrayBuffer());
    if (header.length < 8) break;
    const dv = new DataView(header.buffer, header.byteOffset, header.byteLength);
    let size = dv.getUint32(0, false);
    const type = String.fromCharCode(header[4], header[5], header[6], header[7]);
    if (size === 1) {
      if (header.length < 16) break;
      size = dv.getUint32(8, false) * 0x100000000 + dv.getUint32(12, false);
    } else if (size === 0) {
      size = file.size - offset;
    }
    if (size < 8) break;
    if (type === 'moov') return { start: offset, end: Math.min(offset + size, file.size) };
    offset += size;
  }
  return null;
}
