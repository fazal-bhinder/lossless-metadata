export type FormatId =
  | 'jpeg' | 'png' | 'webp' | 'avif' | 'heic' | 'gif' | 'tiff'
  | 'mp4' | 'mov'
  | 'unknown';

/** How dangerous a tag is if the file is shared publicly. */
export type Severity = 'high' | 'medium' | 'low';

export type Category =
  | 'location'    // GPS — the one that can point at your front door
  | 'device'      // make, model, serial numbers
  | 'datetime'    // when it was taken
  | 'settings'    // aperture, ISO, focal length
  | 'identity'    // author, copyright, artist, creator
  | 'software'    // editing history, processing chain
  | 'ai'          // generator fingerprints, prompts, seeds
  | 'provenance'  // C2PA content credentials
  | 'thumbnail'   // embedded preview (can survive cropping!)
  | 'other';

export interface Tag {
  id: string;
  label: string;
  value: string;
  group: string;
  category: Category;
  severity: Severity;
}

export interface GpsFix {
  lat: number;
  lon: number;
  altitude?: number;
  /** Human-readable, e.g. "37.7749° N, 122.4194° W" */
  display: string;
}

export interface MetadataReport {
  fileName: string;
  fileSize: number;
  mime: string;
  format: FormatId;
  width?: number;
  height?: number;
  tags: Tag[];
  gps?: GpsFix;
  hasC2PA: boolean;
  aiGenerator?: string;
  /** Exact number of bytes in this file that are metadata, not pixels. */
  metadataBytes: number;
  /** Whether we can strip this format without re-encoding pixels. */
  canStripLosslessly: boolean;
  hasThumbnail: boolean;
  error?: string;
}

export interface StripOptions {
  /** Keep the ICC colour profile. Off by default = colours can shift. */
  keepIcc: boolean;
  /** Keep EXIF Orientation. Off by default = photo can appear rotated. */
  keepOrientation: boolean;
  /** Keep Copyright / Artist fields. For photographers who want attribution. */
  keepCopyright: boolean;
}

export const DEFAULT_STRIP_OPTIONS: StripOptions = {
  keepIcc: true,
  keepOrientation: true,
  keepCopyright: false,
};

export type StripMethod = 'byte-surgery' | 'in-place-erase' | 'canvas-reencode';

export interface StripResult {
  blob: Blob;
  bytesRemoved: number;
  method: StripMethod;
  /** True only when the pixel data was copied through untouched. */
  lossless: boolean;
  /** Human-readable explanation of what the engine did. */
  note?: string;
}

export interface VerificationResult {
  clean: boolean;
  residual: Tag[];
  /** null when a pixel comparison was not run (too large, or format re-encoded). */
  pixelsIdentical: boolean | null;
  pixelsCompared?: number;
}

export interface ProcessedFile {
  id: string;
  file: File;
  before: MetadataReport;
  after?: MetadataReport;
  result?: StripResult;
  verification?: VerificationResult;
  status: 'reading' | 'ready' | 'stripping' | 'done' | 'error';
  error?: string;
}
