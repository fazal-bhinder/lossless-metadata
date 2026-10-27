import type { Category, Severity } from './types.js';

interface Rule { test: RegExp; category: Category; severity: Severity }

/**
 * Ordered rules — first match wins. Deliberately conservative: anything we
 * cannot confidently classify falls through to 'other' / 'low' rather than
 * being over-claimed as dangerous.
 */
const RULES: Rule[] = [
  { test: /^GPS|Latitude|Longitude|Altitude|GeoTag|location/i, category: 'location', severity: 'high' },

  { test: /SerialNumber|BodySerial|InternalSerial|LensSerial|CameraID|DeviceID|OwnerName|CameraOwner/i, category: 'device', severity: 'high' },
  { test: /^(Make|Model|LensMake|LensModel|LensInfo|Lens|CameraModel|HostComputer|FirmwareVersion)$/i, category: 'device', severity: 'medium' },

  { test: /Artist|Copyright|Creator|Author|By-?line|Credit|Rights|Contact|Email|Owner|Photographer/i, category: 'identity', severity: 'high' },

  { test: /DateTime|^Date$|Created|Modif|Digitized|OffsetTime|SubSecTime|Timestamp|TimeZone/i, category: 'datetime', severity: 'medium' },

  { test: /Thumbnail|Preview|JPEGInterchange/i, category: 'thumbnail', severity: 'high' },

  { test: /c2pa|contentauth|jumbf|ContentCredential|claim_generator/i, category: 'provenance', severity: 'medium' },

  { test: /parameters|prompt|negative_prompt|seed|sampler|cfg|steps|model_hash|workflow|Midjourney|DALL|Firefly|StableDiffusion|Stable Diffusion|ComfyUI|Automatic1111|Leonardo|generat/i, category: 'ai', severity: 'medium' },

  { test: /Software|ProcessingSoftware|HistorySoftware|CreatorTool|Toolkit|xmpMM|DocumentID|InstanceID|OriginalDocumentID|History/i, category: 'software', severity: 'medium' },

  { test: /FNumber|Aperture|ExposureTime|ShutterSpeed|ISO|FocalLength|Flash|WhiteBalance|Metering|ExposureProgram|ExposureBias|SceneType|LightSource|DigitalZoom|SubjectDistance/i, category: 'settings', severity: 'low' },
];

export function classify(id: string, group = ''): { category: Category; severity: Severity } {
  const haystack = group + ' ' + id;
  for (const rule of RULES) {
    if (rule.test.test(haystack)) return { category: rule.category, severity: rule.severity };
  }
  return { category: 'other', severity: 'low' };
}

export const CATEGORY_LABEL: Record<Category, string> = {
  location: 'Location',
  device: 'Device & camera',
  datetime: 'Date & time',
  settings: 'Camera settings',
  identity: 'Identity & ownership',
  software: 'Software & edit history',
  ai: 'AI generation data',
  provenance: 'Content credentials (C2PA)',
  thumbnail: 'Embedded thumbnail',
  other: 'Other',
};

export const CATEGORY_BLURB: Record<Category, string> = {
  location: 'Exact coordinates of where the photo was taken. Often accurate to a few metres.',
  device: 'Identifies the specific camera or phone. Serial numbers link every photo you have ever taken.',
  datetime: 'When the photo was captured, down to the second, including your timezone.',
  settings: 'Exposure and lens data. Low risk on its own, but it fingerprints your equipment.',
  identity: 'Your name, copyright line, or contact details, embedded in the file.',
  software: 'Which apps touched this file, and sometimes the full edit history.',
  ai: 'Prompts, seeds, model names and generator tags left behind by AI image tools.',
  provenance: 'Cryptographically signed C2PA record of how the file was made.',
  thumbnail: 'A small copy of the original image. It can survive cropping and reveal what you edited out.',
  other: 'Uncategorised metadata found in the file.',
};

/** Display order in the UI — most alarming first. */
export const CATEGORY_ORDER: Category[] = [
  'location', 'identity', 'thumbnail', 'device', 'ai', 'provenance', 'datetime', 'software', 'settings', 'other',
];
