import { readMetadata, isVideo } from './read.js';
import type { MetadataReport, StripResult, VerificationResult, Tag } from './types.js';

/** Tags that are structural, not personal — their presence is not a failure. */
const BENIGN = new RegExp(
  '^(' + [
    // Dimensions and pixel layout — a decoder cannot open the file without these.
    'Image ?Width', 'Image ?Length', 'Image ?Height', 'Bits ?Per ?Sample', 'Bit ?Depth',
    'Color ?Components', 'Color ?Type', 'Subsampling', 'Encoding ?Process', 'ColorSpace',
    'Samples ?Per ?Pixel', 'Planar', 'Photometric', 'New ?Subfile ?Type', 'Fill ?Order',
    'Compression', 'Predictor', 'Sample ?Format', 'Extra ?Samples', 'Color ?Map',
    // Strip and tile geometry — pointers to the pixel data itself.
    'Strip ?Offsets', 'Strip ?Byte ?Counts', 'Rows ?Per ?Strip',
    'Tile ?Width', 'Tile ?Length', 'Tile ?Offsets', 'Tile ?Byte ?Counts',
    // Rendering intent, not personal data.
    'Resolution', 'X ?Resolution', 'Y ?Resolution', 'Gamma', 'Chromaticities', 'sRGB',
    'Rendering', 'Alpha', 'Animation', 'Canvas', 'Interlace', 'Filter', 'Pixel',
    'Profile', 'ICC', 'Device', 'Media ?White', 'Connection ?Space', 'Class', 'Intent',
    // Explicitly kept at the user's request.
    'Orientation', 'Copyright', 'Artist',
  ].join('|') + ')',
  'i',
);

const BENIGN_GROUPS = new Set(['ICC', 'file']);

export function residualTags(report: MetadataReport, keptByChoice: Set<string>): Tag[] {
  return report.tags.filter((t) => {
    if (BENIGN_GROUPS.has(t.group)) return false;
    if (keptByChoice.has(t.id)) return false;
    if (BENIGN.test(t.label) || BENIGN.test(t.id)) return false;
    return true;
  });
}

export async function verify(
  original: File,
  result: StripResult,
  keptByChoice: Set<string>,
): Promise<{ report: MetadataReport; verification: VerificationResult }> {
  const cleanedFile = new File([result.blob], original.name, { type: result.blob.type });
  const report = await readMetadata(cleanedFile);
  const residual = residualTags(report, keptByChoice);

  let pixelsIdentical: boolean | null = null;
  let pixelsCompared: number | undefined;

  if (result.lossless && !isVideo(report.format)) {
    const cmp = await comparePixels(original, cleanedFile);
    pixelsIdentical = cmp.identical;
    pixelsCompared = cmp.pixels;
  }

  return {
    report,
    verification: {
      clean: residual.length === 0 && !report.hasC2PA,
      residual,
      pixelsIdentical,
      pixelsCompared,
    },
  };
}

/** Hard cap so verification never becomes the slow part of the flow. */
const MAX_PIXELS = 12_000_000;

/**
 * Decode both files and compare every channel. This is what lets the UI say
 * "0 pixels changed" as a measured fact rather than a marketing claim.
 */
async function comparePixels(a: Blob, b: Blob): Promise<{ identical: boolean | null; pixels?: number }> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    return { identical: null };
  }
  let bmpA: ImageBitmap | undefined;
  let bmpB: ImageBitmap | undefined;
  try {
    [bmpA, bmpB] = await Promise.all([createImageBitmap(a), createImageBitmap(b)]);
    if (bmpA.width !== bmpB.width || bmpA.height !== bmpB.height) return { identical: false };

    const pixels = bmpA.width * bmpA.height;
    if (pixels > MAX_PIXELS) return { identical: null };

    const dataA = draw(bmpA);
    const dataB = draw(bmpB);
    if (!dataA || !dataB || dataA.length !== dataB.length) return { identical: null };

    for (let i = 0; i < dataA.length; i++) {
      if (dataA[i] !== dataB[i]) return { identical: false, pixels };
    }
    return { identical: true, pixels };
  } catch {
    // HEIC and AVIF are not decodable everywhere; that is not a failure.
    return { identical: null };
  } finally {
    bmpA?.close();
    bmpB?.close();
  }
}

function draw(bmp: ImageBitmap): Uint8ClampedArray | null {
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, bmp.width, bmp.height).data;
}
