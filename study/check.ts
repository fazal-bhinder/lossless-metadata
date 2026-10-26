// Which platforms strip photo metadata? Compares what survives a round trip through each
// platform against the original test images. Protocol: study/README.md.
//
//   npx tsx study/check.ts            # prints a Markdown table for STUDY.md
//
// Layout: study/originals/<file>, study/results/<platform>/<file-or-renamed-download>.
// A download is matched to its original by format (one original per format).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readMetadata, type MetadataReport } from '../src/index.ts';

const DIR = new URL('.', import.meta.url).pathname;
const read = async (path: string) => readMetadata(new File([readFileSync(path)], path.split('/').pop()!));

function summary(r: MetadataReport) {
  const cats = new Set(r.tags.map((t) => t.category));
  return {
    gps: Boolean(r.gps) || cats.has('location'),
    device: cats.has('device'),
    datetime: cats.has('datetime'),
    c2pa: r.hasC2PA,
    tags: r.tags.length,
  };
}

const originals = new Map<string, ReturnType<typeof summary>>();
for (const f of readdirSync(join(DIR, 'originals'))) {
  const r = await read(join(DIR, 'originals', f));
  originals.set(r.format, summary(r));
  console.error(`original ${f}: ${r.format}, ${r.tags.length} tags, gps=${Boolean(r.gps)}, c2pa=${r.hasC2PA}`);
}

const mark = (before: boolean, after: boolean) => (!before ? 'n/a' : after ? '**kept**' : 'removed');
console.log('| Platform | File | GPS | Camera/device | Date taken | C2PA / AI label | Tags left |');
console.log('|---|---|---|---|---|---|---|');
const results = join(DIR, 'results');
for (const platform of existsSync(results) ? readdirSync(results).sort() : []) {
  for (const f of readdirSync(join(results, platform)).filter((n) => !n.startsWith('.'))) {
    const r = await read(join(results, platform, f));
    const o = originals.get(r.format);
    const a = summary(r);
    if (!o) {
      // Platform converted the format (e.g. PNG → JPEG): compare against "everything removed"
      console.log(`| ${platform} | ${f} (converted to ${r.format}) | ${a.gps ? '**kept**' : 'removed'} | ${a.device ? '**kept**' : 'removed'} | ${a.datetime ? '**kept**' : 'removed'} | ${a.c2pa ? '**kept**' : 'removed'} | ${a.tags} |`);
      continue;
    }
    console.log(`| ${platform} | ${f} | ${mark(o.gps, a.gps)} | ${mark(o.device, a.device)} | ${mark(o.datetime, a.datetime)} | ${mark(o.c2pa, a.c2pa)} | ${a.tags} of ${o.tags} |`);
  }
}
