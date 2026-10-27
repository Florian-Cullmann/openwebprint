// Check native document filters without submitting a physical print job.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PDFDocument } from 'pdf-lib';
const directory = await mkdtemp(join(tmpdir(), 'openwebprint-cups-'));
try {
  const pdf = await PDFDocument.create();
  pdf.addPage([144, 144]).drawText('CUPS check', { x: 12, y: 100, size: 12 });
  const input = join(directory, 'document.pdf');
  await writeFile(input, await pdf.save());
  const { stdout } = await promisify(execFile)(
    '/usr/sbin/cupsfilter',
    ['-i', 'application/pdf', '-m', 'image/pwg-raster', input],
    { encoding: 'buffer', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
  );
  assert.equal(stdout.subarray(0, 4).toString('ascii'), 'RaS2', 'CUPS must produce PWG Raster');
  assert.ok(stdout.length > 100, 'Raster output must contain page data');
  console.log(
    'PASS CUPS: PDF converted to PWG Raster through installed native filters (no physical printing)',
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
