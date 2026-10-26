/**
 * Engine test suite. Exercises every supported container plus the edge cases
 * that break naive implementations: empty files, truncated files, files with
 * no metadata at all, repeated stripping, and the keep-toggles.
 *
 * Pixel-level verification lives in verify.py, deliberately written against
 * PIL and ffprobe rather than our own parsers.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMetadata } from '../src/read';
import { stripFile } from '../src/strip';
import { verify } from '../src/verify';
import { DEFAULT_STRIP_OPTIONS, type StripOptions } from '../src/types';
import { formatBytes, sniffFormat } from '../src/bytes';
import { buildJsonReport, buildTextReport } from '../src/report';
import { detectAi } from '../src/detect';

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, 'fixtures');
const OUT = join(here, 'out');
mkdirSync(OUT, { recursive: true });

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', tiff: 'image/tiff', mp4: 'video/mp4', mov: 'video/quicktime',
};

let checks = 0;
const failures: string[] = [];
const ok = (cond: boolean, msg: string) => {
  checks++;
  if (!cond) failures.push(msg);
};

const load = (name: string) => {
  const ext = name.split('.').pop()!.toLowerCase();
  return new File([readFileSync(join(FIX, name))], name, { type: MIME[ext] ?? '' });
};

const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

/**
 * Mirrors the predicate the results panel uses to decide whether to show
 * "No metadata found" (on metadataremoverai.com). Kept in step deliberately: the
 * engine reporting metadata is worthless if the UI still calls the file clean.
 */
const isReportedClean = (r: Awaited<ReturnType<typeof readMetadata>>) =>
  r.tags.length === 0 && !r.hasC2PA && !r.hasThumbnail && !r.aiGenerator && !r.gps;

console.log('── Format coverage ' + '─'.repeat(48));

for (const name of readdirSync(FIX).sort()) {
  const file = load(name);
  const before = await readMetadata(file);

  ok(!before.error, `${name}: read failed — ${before.error}`);
  ok(before.format !== 'unknown', `${name}: format not recognised`);
  if (before.error) { console.log(`\n${name}\n  ERROR ${before.error}`); continue; }

  const result = await stripFile(file, DEFAULT_STRIP_OPTIONS);
  const outBuf = await bytesOf(result.blob);
  writeFileSync(join(OUT, name), outBuf);

  const { report: after, verification } = await verify(file, result, new Set(['Orientation']));

  ok(verification.clean, `${name}: residual metadata — ${verification.residual.map((t) => t.id).join(', ')}`);
  ok(result.lossless, `${name}: strip was not lossless`);
  ok(outBuf.length > 0, `${name}: produced an empty file`);
  ok(
    sniffFormat(outBuf) === sniffFormat(await bytesOf(file.slice(0, 64))),
    `${name}: output container changed format`,
  );
  ok(after.metadataBytes <= before.metadataBytes, `${name}: metadata grew after stripping`);

  // The reports must render without throwing on any real input.
  ok(buildTextReport({ before, after, result, verification }).length > 100, `${name}: text report too short`);
  ok(JSON.parse(buildJsonReport({ before, after, result, verification })).file.name === name, `${name}: JSON report malformed`);

  // Stripping an already-clean file must be a no-op, not a slow corruption.
  const second = await stripFile(new File([outBuf], name, { type: file.type }), DEFAULT_STRIP_OPTIONS);
  const secondBuf = await bytesOf(second.blob);
  ok(
    Buffer.compare(Buffer.from(outBuf), Buffer.from(secondBuf)) === 0,
    `${name}: stripping twice is not idempotent (${outBuf.length} vs ${secondBuf.length} bytes)`,
  );

  console.log(
    `\n${name}  [${before.format}]\n` +
    `  before  ${before.tags.length} tags, ${formatBytes(before.metadataBytes)}` +
      (before.gps ? `, GPS ${before.gps.display}` : '') +
      (before.hasC2PA ? ', C2PA' : '') +
      (before.aiGenerator ? `, AI=${before.aiGenerator}` : '') +
      (before.hasThumbnail ? ', thumbnail' : '') + '\n' +
    `  strip   ${result.method}, removed ${formatBytes(result.bytesRemoved)}, ` +
      `${formatBytes(file.size)} → ${formatBytes(outBuf.length)}\n` +
    `  after   ${after.tags.length} tags, clean=${verification.clean}, idempotent=yes`,
  );
}

console.log('\n── Keep toggles ' + '─'.repeat(51));

{
  const file = load('photo-gps.jpg');
  const before = await readMetadata(file);
  ok(before.tags.some((t) => t.id === 'Orientation'), 'fixture should carry an Orientation tag');

  // Orientation kept (the default) — a photo must not silently rotate.
  const kept = await stripFile(file, DEFAULT_STRIP_OPTIONS);
  const keptReport = await readMetadata(new File([await bytesOf(kept.blob)], 'k.jpg', { type: 'image/jpeg' }));
  ok(keptReport.tags.some((t) => t.id === 'Orientation'), 'keepOrientation=true should preserve Orientation');
  ok(!keptReport.gps, 'GPS must be gone even when orientation is kept');
  console.log(`  keepOrientation=true   → Orientation preserved, GPS removed`);

  // Orientation dropped on request.
  const dropped = await stripFile(file, { ...DEFAULT_STRIP_OPTIONS, keepOrientation: false });
  const droppedReport = await readMetadata(new File([await bytesOf(dropped.blob)], 'd.jpg', { type: 'image/jpeg' }));
  ok(!droppedReport.tags.some((t) => t.id === 'Orientation'), 'keepOrientation=false should remove Orientation');
  console.log(`  keepOrientation=false  → Orientation removed`);

  // Copyright and Artist preserved for photographers who want attribution.
  const attributed: StripOptions = { ...DEFAULT_STRIP_OPTIONS, keepCopyright: true };
  const attrib = await stripFile(file, attributed);
  const attribReport = await readMetadata(new File([await bytesOf(attrib.blob)], 'a.jpg', { type: 'image/jpeg' }));
  const hasCopyright = attribReport.tags.some((t) => /Copyright|Artist/i.test(t.id));
  ok(hasCopyright, 'keepCopyright=true should preserve Copyright/Artist');
  ok(!attribReport.gps, 'GPS must be gone even when copyright is kept');
  ok(
    !attribReport.tags.some((t) => /Serial|Model|Make/i.test(t.id)),
    'keepCopyright must not preserve device identifiers',
  );
  console.log(`  keepCopyright=true     → Copyright kept, GPS and device data still removed`);
}

console.log('\n── Edge cases ' + '─'.repeat(53));

{
  const empty = new File([new Uint8Array(0)], 'empty.jpg', { type: 'image/jpeg' });
  const r = await readMetadata(empty);
  ok(Boolean(r.error), 'empty file should report an error, not crash');
  console.log(`  empty file             → ${r.error ? 'handled' : 'NOT handled'}`);
}

{
  const text = new File([new TextEncoder().encode('this is not an image at all')], 'notes.txt', { type: 'text/plain' });
  const r = await readMetadata(text);
  ok(Boolean(r.error), 'non-image should report an error');
  let threw = false;
  try { await stripFile(text, DEFAULT_STRIP_OPTIONS); } catch { threw = true; }
  ok(threw, 'stripping a non-image should throw a clean error');
  console.log(`  text file              → rejected with a message`);
}

{
  // A JPEG cut off mid-scan. Must not hang or throw.
  const full = readFileSync(join(FIX, 'photo-gps.jpg'));
  const truncated = new File([full.subarray(0, Math.floor(full.length / 3))], 'cut.jpg', { type: 'image/jpeg' });
  const r = await readMetadata(truncated);
  ok(!r.error || typeof r.error === 'string', 'truncated file should degrade gracefully');
  const stripped = await stripFile(truncated, DEFAULT_STRIP_OPTIONS);
  ok((await bytesOf(stripped.blob)).length > 0, 'truncated file should still produce output');
  console.log(`  truncated JPEG         → ${r.tags.length} tags read, output produced`);
}

{
  // Header-only file: the JPEG magic is there but nothing follows it. Refusing
  // is the right call — claiming to have cleaned 3 bytes would be a lie.
  const stub = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'stub.jpg', { type: 'image/jpeg' });
  const r = await readMetadata(stub);
  ok(Boolean(r.error), 'a 3-byte stub should be rejected rather than processed');
  console.log(`  3-byte JPEG stub       → rejected, no crash`);
}

{
  const plain = load('plain.png');
  const r = await readMetadata(plain);
  ok(r.metadataBytes === 0, 'a clean PNG should report zero metadata bytes');
  const stripped = await stripFile(plain, DEFAULT_STRIP_OPTIONS);
  ok(stripped.bytesRemoved === 0, 'nothing to remove should remove nothing');
  ok(
    Buffer.compare(readFileSync(join(FIX, 'plain.png')), Buffer.from(await bytesOf(stripped.blob))) === 0,
    'a file with no metadata should come back byte-identical',
  );
  console.log(`  already-clean PNG      → returned byte-identical`);
}

{
  // Extension lying about content: a PNG named .jpg must still work.
  const png = readFileSync(join(FIX, 'ai-image.png'));
  const liar = new File([png], 'actually-a-png.jpg', { type: 'image/jpeg' });
  const r = await readMetadata(liar);
  ok(r.format === 'png', 'format must come from magic bytes, not the extension');
  const stripped = await stripFile(liar, DEFAULT_STRIP_OPTIONS);
  ok(stripped.bytesRemoved > 0, 'mislabelled PNG should still be cleaned');
  console.log(`  PNG named .jpg         → sniffed as png, cleaned correctly`);
}

console.log('\n── Detection ' + '─'.repeat(54));

{
  const ai = await readMetadata(load('ai-image.png'));
  ok(ai.aiGenerator?.includes('Automatic1111') ?? false, `SD params should be detected, got ${ai.aiGenerator}`);
  console.log(`  ai-image.png           → ${ai.aiGenerator}`);

  const mj = await readMetadata(load('photo-xmp.jpg'));
  ok(mj.aiGenerator === 'Midjourney', `XMP CreatorTool should detect Midjourney, got ${mj.aiGenerator}`);
  console.log(`  photo-xmp.jpg          → ${mj.aiGenerator}`);

  const dst = (v: string) => detectAi([], `<Iptc4xmpExt:DigitalSourceType>http://cv.iptc.org/newscodes/digitalsourcetype/${v}</Iptc4xmpExt:DigitalSourceType>`).generator;
  ok(dst('trainedAlgorithmicMedia')?.startsWith('AI-generated') ?? false, 'IPTC trainedAlgorithmicMedia should be flagged as AI-generated');
  ok(dst('compositeWithTrainedAlgorithmicMedia')?.startsWith('AI-edited') ?? false, 'IPTC composite source type should be flagged as AI-edited');
  ok(dst('digitalCapture') === undefined, 'a camera-capture source type must not be flagged');
  console.log(`  IPTC DigitalSourceType → ${dst('compositeWithTrainedAlgorithmicMedia')}`);

  const gps = await readMetadata(load('photo-gps.jpg'));
  ok(Math.abs((gps.gps?.lat ?? 0) - 37.7749) < 0.01, 'GPS latitude should decode correctly');
  ok(Math.abs((gps.gps?.lon ?? 0) + 122.4194) < 0.01, 'GPS longitude should decode with the correct sign');
  console.log(`  photo-gps.jpg          → ${gps.gps?.display}`);

  const vid = await readMetadata(load('clip.mov'));
  ok(vid.tags.length > 0, 'video should surface QuickTime atoms');
  console.log(`  clip.mov               → ${vid.tags.length} atoms, GPS ${vid.gps?.display ?? 'none'}`);
}

console.log('\n── C2PA-only files ' + '─'.repeat(48));

{
  // A ChatGPT or Gemini export carries a signed `caBX` manifest and nothing
  // else — no EXIF, no text chunks. It therefore yields zero *named* tags, and
  // any "is this file clean?" test that counts tags gets the answer backwards.
  for (const name of ['c2pa-openai.png', 'c2pa-google.png']) {
    const file = load(name);
    const before = await readMetadata(file);

    ok(before.tags.length === 0, `${name}: expected no named tags (the whole point of this case)`);
    ok(before.hasC2PA, `${name}: caBX chunk must be detected as C2PA`);
    ok(before.metadataBytes > 20_000, `${name}: manifest bytes should be counted, got ${before.metadataBytes}`);

    // The bug this guards: a file with metadata must never be reported clean.
    ok(
      !isReportedClean(before),
      `${name}: reported as having no metadata despite a ${before.metadataBytes}-byte manifest`,
    );

    const stripped = await stripFile(file, DEFAULT_STRIP_OPTIONS);
    const outBuf = await bytesOf(stripped.blob);
    const after = await readMetadata(new File([outBuf], name, { type: 'image/png' }));

    ok(!after.hasC2PA, `${name}: C2PA survived stripping`);
    ok(after.metadataBytes === 0, `${name}: metadata bytes remain after stripping`);
    ok(stripped.lossless, `${name}: removing a caBX chunk must be lossless`);
    ok(!Buffer.from(outBuf).includes(Buffer.from('jumb')), `${name}: JUMBF bytes still present in output`);
    ok(isReportedClean(after), `${name}: stripped file should now report clean`);

    console.log(
      `  ${name.padEnd(21)}→ before: 0 tags but C2PA + ${formatBytes(before.metadataBytes)}, ` +
      `after: clean, ${formatBytes(file.size)} → ${formatBytes(outBuf.length)}`,
    );
  }
}

console.log('\n' + '─'.repeat(68));
if (failures.length) {
  console.log(`FAIL — ${failures.length} of ${checks} checks failed:`);
  for (const f of failures) console.log('   x ' + f);
  process.exit(1);
}
console.log(`PASS — all ${checks} engine checks passed\n`);
