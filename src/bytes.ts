/** Small endian-aware helpers shared by every container parser. */

export const u16be = (v: DataView, o: number) => v.getUint16(o, false);
export const u32be = (v: DataView, o: number) => v.getUint32(o, false);
export const u32le = (v: DataView, o: number) => v.getUint32(o, true);

export function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let s = '';
  const end = Math.min(offset + length, bytes.length);
  for (let i = offset; i < end; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

export function startsWith(bytes: Uint8Array, offset: number, sig: string): boolean {
  if (offset + sig.length > bytes.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[offset + i] !== sig.charCodeAt(i)) return false;
  }
  return true;
}

/** Concatenate byte ranges of `src` (plus any injected chunks) into one array. */
export function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export function writeU32be(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

export function writeU32le(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

/** Detect the container from magic bytes rather than trusting the file extension. */
export function sniffFormat(bytes: Uint8Array): string {
  if (bytes.length < 12) return 'unknown';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (startsWith(bytes, 0, '\x89PNG\r\n\x1a\n')) return 'png';
  if (startsWith(bytes, 0, 'GIF8')) return 'gif';
  if (startsWith(bytes, 0, 'RIFF') && startsWith(bytes, 8, 'WEBP')) return 'webp';
  if (startsWith(bytes, 0, 'II\x2a\x00') || startsWith(bytes, 0, 'MM\x00\x2a')) return 'tiff';

  // ISOBMFF family — the brand is in the ftyp box
  if (startsWith(bytes, 4, 'ftyp')) {
    const brand = ascii(bytes, 8, 4);
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (brand.startsWith('hei') || brand === 'mif1' || brand === 'msf1' || brand === 'heic' || brand === 'heix') return 'heic';
    if (brand === 'qt  ') return 'mov';
    return 'mp4';
  }
  return 'unknown';
}

export function formatBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}
