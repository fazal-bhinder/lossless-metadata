import { concat } from '../bytes.js';

/**
 * GIF carries metadata in Comment (0xFE) and Application (0xFF) extension
 * blocks. The Netscape looping extension is an Application block too, so it is
 * kept explicitly — dropping it would break animation looping.
 */

export function scanGif(bytes: Uint8Array): { metadataBytes: number; comments: string[] } {
  const { removed, comments } = process(bytes, false);
  return { metadataBytes: removed, comments };
}

export function stripGif(bytes: Uint8Array): { out: Uint8Array; removed: number } {
  const { parts, removed } = process(bytes, true);
  return { out: concat(parts), removed };
}

function process(bytes: Uint8Array, build: boolean) {
  const parts: Uint8Array[] = [];
  const comments: string[] = [];
  let removed = 0;
  let i = 13; // header + logical screen descriptor

  // Global colour table
  if (bytes[10] & 0x80) i += 3 * (1 << ((bytes[10] & 0x07) + 1));
  if (build) parts.push(bytes.subarray(0, i));

  const skipSubBlocks = (p: number) => {
    while (p < bytes.length && bytes[p] !== 0) p += bytes[p] + 1;
    return p + 1;
  };

  while (i < bytes.length) {
    const b = bytes[i];
    if (b === 0x3b) { if (build) parts.push(bytes.subarray(i)); break; } // trailer
    if (b === 0x21) { // extension
      const label = bytes[i + 1];
      const end = skipSubBlocks(i + 2);
      const isNetscape = label === 0xff && bytes[i + 2] === 11 &&
        String.fromCharCode(...bytes.subarray(i + 3, i + 14)).startsWith('NETSCAPE');
      const isMetadata = label === 0xfe || (label === 0xff && !isNetscape);
      if (isMetadata) {
        removed += end - i;
        if (label === 0xfe) {
          let p = i + 2; let text = '';
          while (p < bytes.length && bytes[p] !== 0) {
            text += new TextDecoder().decode(bytes.subarray(p + 1, p + 1 + bytes[p]));
            p += bytes[p] + 1;
          }
          comments.push(text);
        }
      } else if (build) parts.push(bytes.subarray(i, end));
      i = end;
    } else if (b === 0x2c) { // image descriptor
      let p = i + 10;
      if (bytes[i + 9] & 0x80) p += 3 * (1 << ((bytes[i + 9] & 0x07) + 1));
      p += 1; // LZW minimum code size
      p = skipSubBlocks(p);
      if (build) parts.push(bytes.subarray(i, p));
      i = p;
    } else { if (build) parts.push(bytes.subarray(i)); break; }
  }
  return { parts, removed, comments };
}
