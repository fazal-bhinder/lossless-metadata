import { sniffFormat } from './bytes';
import { stripJpeg } from './formats/jpeg';
import { stripPng } from './formats/png';
import { stripWebp } from './formats/webp';
import { stripGif } from './formats/gif';
import { stripTiff } from './formats/tiff';
import { stripHeif, cleanMoov } from './formats/isobmff';
import { locateMoov, isVideo } from './read';
import type { FormatId, StripOptions, StripResult } from './types';

const MIME: Record<string, string> = {
  jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif',
  heic: 'image/heic', gif: 'image/gif', tiff: 'image/tiff',
  mp4: 'video/mp4', mov: 'video/quicktime',
};

export async function stripFile(file: File, opts: StripOptions): Promise<StripResult> {
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const format = sniffFormat(head) as FormatId;
  if (format === 'unknown') throw new Error('Unsupported file type.');

  if (isVideo(format)) return stripVideo(file, format);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = MIME[format] ?? file.type;

  switch (format) {
    case 'jpeg': {
      const { out, removed } = stripJpeg(bytes, opts);
      return done(out, removed, type, 'byte-surgery',
        'Metadata segments removed. The compressed scan data was copied through untouched.');
    }
    case 'png': {
      const { out, removed } = stripPng(bytes, opts);
      return done(out, removed, type, 'byte-surgery',
        'Text, EXIF and C2PA chunks removed. The IDAT pixel stream is unchanged.');
    }
    case 'webp': {
      const { out, removed } = stripWebp(bytes, opts);
      return done(out, removed, type, 'byte-surgery',
        'EXIF/XMP chunks removed and the VP8X feature flags corrected.');
    }
    case 'gif': {
      const { out, removed } = stripGif(bytes);
      return done(out, removed, type, 'byte-surgery',
        'Comment and application extension blocks removed. Animation timing preserved.');
    }
    case 'tiff': {
      const { out, removed } = stripTiff(bytes, opts);
      return done(out, removed, type, 'byte-surgery',
        'Directory rebuilt with image-critical tags only. Pixel strips never moved.');
    }
    case 'heic':
    case 'avif': {
      const { out, removed } = stripHeif(bytes);
      return done(out, removed, type, 'in-place-erase',
        'Metadata item payloads erased in place. Offsets stay valid, so the image data is untouched.');
    }
    default:
      throw new Error('Unsupported file type.');
  }
}

function done(out: Uint8Array, removed: number, type: string, method: StripResult['method'], note: string): StripResult {
  return {
    blob: new Blob([out.buffer as ArrayBuffer], { type }),
    bytesRemoved: removed,
    method,
    lossless: true,
    note,
  };
}

/**
 * Video never enters memory whole. We read and patch only `moov`, then assemble
 * the output from lazy Blob slices of the original file — so a 2 GB MOV costs a
 * few hundred KB of RAM.
 */
async function stripVideo(file: File, format: FormatId): Promise<StripResult> {
  const moov = await locateMoov(file);
  const type = MIME[format] ?? file.type;

  if (!moov) {
    return {
      blob: file.slice(0, file.size, type),
      bytesRemoved: 0,
      method: 'byte-surgery',
      lossless: true,
      note: 'No moov box found — this file carries no container metadata to remove.',
    };
  }

  const buf = new Uint8Array(await file.slice(moov.start, moov.end).arrayBuffer());
  const removed = cleanMoov(buf, 8, buf.length);

  const blob = new Blob(
    [file.slice(0, moov.start), buf.buffer as ArrayBuffer, file.slice(moov.end)],
    { type },
  );

  return {
    blob,
    bytesRemoved: removed,
    method: 'in-place-erase',
    lossless: true,
    note: 'Metadata atoms replaced with spec-standard `free` padding and timestamps zeroed. ' +
      'Every chunk offset still resolves, so not one frame was re-encoded.',
  };
}

/** Suggested filename for the cleaned download. */
export function cleanName(original: string): string {
  const dot = original.lastIndexOf('.');
  if (dot <= 0) return original + '-clean';
  return original.slice(0, dot) + '-clean' + original.slice(dot);
}
