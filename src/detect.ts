/**
 * Identify AI-generator fingerprints and C2PA content credentials.
 *
 * This is detection and disclosure only. We surface what is in the file and let
 * the user decide. We do not modify pixels, and we do not try to defeat any
 * platform's detection systems — see /ai-metadata-remover for the reasoning.
 */

export interface AiSignals {
  generator?: string;
  /** Stable Diffusion style generation parameters, if present. */
  parameters?: string;
  fields: { key: string; value: string }[];
}

const GENERATORS: { name: string; test: RegExp }[] = [
  { name: 'Midjourney', test: /midjourney/i },
  { name: 'DALL·E', test: /dall[·•.\-\s]?e|openai/i },
  { name: 'Adobe Firefly', test: /firefly/i },
  { name: 'Stable Diffusion (Automatic1111)', test: /automatic1111|a1111|sd-webui|stable[\s-]?diffusion[\s-]?webui/i },
  { name: 'ComfyUI', test: /comfyui|comfy_/i },
  { name: 'Stable Diffusion', test: /stable[\s-]?diffusion|sdxl|sd_?xl/i },
  { name: 'Leonardo.ai', test: /leonardo/i },
  { name: 'Google Imagen / Gemini', test: /imagen|gemini|synthid/i },
  { name: 'Grok / xAI', test: /grok|x\.?ai/i },
  { name: 'Flux', test: /black[\s-]?forest|flux\.\d|flux[\s-]?dev|flux[\s-]?schnell/i },
  { name: 'Ideogram', test: /ideogram/i },
  { name: 'Recraft', test: /recraft/i },
  { name: 'Canva AI', test: /canva/i },
];

/** Keys that AI tools use to stash generation data. */
const AI_KEYS = /^(parameters|prompt|negative_prompt|workflow|sd-metadata|Dream|generation_data|aiMetadata|Comment|UserComment|Software|CreatorTool)$/i;

/** Hallmarks of a Stable Diffusion parameter blob. */
const SD_PARAM_SHAPE = /(Steps:\s*\d+|Sampler:|CFG scale:|Model hash:|Seed:\s*\d+|denoising_strength)/i;

/**
 * IPTC digital source type values that declare generative AI. They sit in XMP
 * (and inside C2PA actions) with no generator name attached, and they are one
 * of the signals Meta reads for its "AI info" label.
 */
const AI_SOURCE_TYPE = /compositeWithTrainedAlgorithmicMedia|trainedAlgorithmicMedia/;

export function detectAi(fields: { key: string; value: string }[], xmpText = ''): AiSignals {
  const relevant = fields.filter((f) => AI_KEYS.test(f.key) || SD_PARAM_SHAPE.test(f.value));
  const haystack = fields.map((f) => f.key + ' ' + f.value).join('\n');

  let generator: string | undefined;
  for (const g of GENERATORS) {
    if (g.test.test(haystack)) { generator = g.name; break; }
  }

  const paramField = fields.find((f) => SD_PARAM_SHAPE.test(f.value));
  if (!generator && paramField) generator = 'Stable Diffusion';

  const declared = (haystack + '\n' + xmpText).match(AI_SOURCE_TYPE)?.[0];
  if (!generator && declared) {
    generator = declared.startsWith('composite')
      ? 'AI-edited (IPTC digital source type)'
      : 'AI-generated (IPTC digital source type)';
  }

  return { generator, parameters: paramField?.value, fields: relevant };
}

/**
 * C2PA manifests are JUMBF boxes. Where they live depends on the container:
 * JPEG APP11, PNG `caBX`, ISOBMFF `jumb` or `uuid`. Container parsers report
 * their own findings; this catches the XMP-level references they can miss.
 */
export function detectC2pa(xmpText: string, extra: string[] = []): boolean {
  const haystack = xmpText + ' ' + extra.join(' ');
  return /c2pa|contentauth|content[\s-]?credential|claim_generator|urn:uuid:c2pa/i.test(haystack);
}

export const C2PA_EXPLAINER =
  'C2PA Content Credentials are a cryptographically signed record of how a file was made — ' +
  'which tool, when, and whether AI was involved. Removing them removes the signed history, ' +
  'not a watermark. Some platforms and jurisdictions expect AI-generated content to carry ' +
  'disclosure, so check where the file is going before you strip it.';
