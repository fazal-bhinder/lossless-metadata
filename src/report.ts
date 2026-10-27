import { formatBytes } from './bytes.js';
import { CATEGORY_LABEL } from './tags.js';
import type { MetadataReport, StripResult, VerificationResult } from './types.js';

export interface AuditBundle {
  before: MetadataReport;
  after?: MetadataReport;
  result?: StripResult;
  verification?: VerificationResult;
}

/**
 * A downloadable before/after audit. Useful on its own for compliance work, and
 * it is the artefact that backs up the "verified clean" claim.
 */
export function buildJsonReport(b: AuditBundle): string {
  return JSON.stringify(
    {
      tool: 'Metadata Remover AI',
      generatedAt: new Date().toISOString(),
      note: 'Produced entirely in the browser. No file or field in this report was ever transmitted.',
      file: {
        name: b.before.fileName,
        sizeBytes: b.before.fileSize,
        format: b.before.format,
        dimensions: b.before.width && b.before.height ? `${b.before.width}x${b.before.height}` : undefined,
      },
      before: {
        tagCount: b.before.tags.length,
        metadataBytes: b.before.metadataBytes,
        hasGps: Boolean(b.before.gps),
        gps: b.before.gps ? { latitude: b.before.gps.lat, longitude: b.before.gps.lon } : undefined,
        hasC2PA: b.before.hasC2PA,
        aiGenerator: b.before.aiGenerator,
        hasThumbnail: b.before.hasThumbnail,
        tags: b.before.tags.map((t) => ({
          id: t.id, group: t.group, category: t.category, severity: t.severity, value: t.value,
        })),
      },
      removal: b.result && {
        method: b.result.method,
        lossless: b.result.lossless,
        bytesRemoved: b.result.bytesRemoved,
        note: b.result.note,
      },
      after: b.after && {
        tagCount: b.after.tags.length,
        metadataBytes: b.after.metadataBytes,
        hasGps: Boolean(b.after.gps),
        hasC2PA: b.after.hasC2PA,
      },
      verification: b.verification && {
        clean: b.verification.clean,
        residualTags: b.verification.residual.map((t) => t.id),
        pixelsIdentical: b.verification.pixelsIdentical,
        pixelsCompared: b.verification.pixelsCompared,
      },
    },
    null,
    2,
  );
}

/** Plain-text audit — pastes cleanly into a ticket or an email. */
export function buildTextReport(b: AuditBundle): string {
  const L: string[] = [];
  L.push('IMAGE METADATA REMOVER — AUDIT REPORT');
  L.push('Generated ' + new Date().toISOString());
  L.push('Processed entirely in-browser. Nothing was uploaded.');
  L.push('');
  L.push(`File:   ${b.before.fileName}`);
  L.push(`Format: ${b.before.format.toUpperCase()}   Size: ${formatBytes(b.before.fileSize)}`);
  if (b.before.width) L.push(`Size:   ${b.before.width} x ${b.before.height}`);
  L.push('');
  L.push(`BEFORE — ${b.before.tags.length} tags, ${formatBytes(b.before.metadataBytes)} of metadata`);
  if (b.before.gps) L.push(`  ! GPS: ${b.before.gps.display}`);
  if (b.before.hasC2PA) L.push('  ! C2PA content credentials present');
  if (b.before.aiGenerator) L.push(`  ! AI generator detected: ${b.before.aiGenerator}`);
  if (b.before.hasThumbnail) L.push('  ! Embedded thumbnail present');
  L.push('');

  const byCategory = new Map<string, string[]>();
  for (const t of b.before.tags) {
    const key = CATEGORY_LABEL[t.category];
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key)!.push(`    ${t.id} = ${t.value}`);
  }
  for (const [cat, lines] of byCategory) {
    L.push(`  ${cat} (${lines.length})`);
    L.push(...lines);
  }

  if (b.result) {
    L.push('');
    L.push(`REMOVAL — method: ${b.result.method}, lossless: ${b.result.lossless}`);
    L.push(`  ${formatBytes(b.result.bytesRemoved)} of metadata removed`);
    if (b.result.note) L.push('  ' + b.result.note);
  }
  if (b.verification) {
    L.push('');
    L.push('VERIFICATION — the output file was re-parsed from scratch');
    L.push(`  Clean: ${b.verification.clean ? 'YES — no personal metadata found' : 'NO'}`);
    if (b.verification.residual.length) {
      L.push('  Residual: ' + b.verification.residual.map((t) => t.id).join(', '));
    }
    if (b.verification.pixelsIdentical === true) {
      L.push(`  Pixels: IDENTICAL (${b.verification.pixelsCompared?.toLocaleString()} pixels compared, 0 changed)`);
    } else if (b.verification.pixelsIdentical === false) {
      L.push('  Pixels: CHANGED');
    } else {
      L.push('  Pixels: not compared (format not decodable here, or above the size cap)');
    }
  }
  L.push('');
  return L.join('\n');
}

export function downloadText(content: string, filename: string, mime = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
