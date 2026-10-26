import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostDiscovery } from '../src/providers/host-discovery.js';
import { validatePrinterUri } from '../src/providers/hardware.js';

let directory: string;
let path: string;
const now = Date.parse('2026-10-26T12:00:00Z');
const printer = {
  name: 'Brother fixture',
  kind: 'printer',
  address: 'ipps://192.0.2.50:443/ipp/print',
  location: '',
};
function snapshot(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 1,
    source: 'macos-bonjour',
    generatedAt: new Date(now).toISOString(),
    devices: [printer],
    warnings: [],
    ...overrides,
  });
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'owp-host-discovery-'));
  path = join(directory, 'devices.json');
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
describe('host discovery snapshot boundary (synthetic file fixtures)', () => {
  it('returns current, validated Bonjour candidates and their provenance without configuring them', async () => {
    await writeFile(path, snapshot());
    const result = await hostDiscovery(path, validatePrinterUri, now);
    expect(result.devices).toEqual([printer]);
    expect(result.warnings).toEqual([]);
    expect(result.hostDiscovery).toEqual({
      source: 'macos-bonjour',
      updatedAt: new Date(now).toISOString(),
    });
  });
  it.each([
    { generatedAt: new Date(now - 31_000).toISOString() },
    { generatedAt: new Date(now + 6_000).toISOString() },
    { source: 'unknown' },
    { devices: [{ ...printer, address: 'file:///etc/passwd' }] },
    { devices: [{ ...printer, address: 'ipp://user:secret@printer.local/ipp/print' }] },
    { devices: [{ ...printer, kind: 'scanner' }] },
  ])('rejects stale, forged or unsafe inventory: %j', async (overrides) => {
    await writeFile(path, snapshot(overrides));
    const result = await hostDiscovery(path, validatePrinterUri, now);
    expect(result.devices).toEqual([]);
    expect(result.hostDiscovery).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).not.toContain('secret');
  });
  it('fails closed for a stopped helper, a partial write or oversized inventory', async () => {
    for (const contents of [undefined, '{"version":1,', ' '.repeat(128 * 1024 + 1)]) {
      if (contents !== undefined) await writeFile(path, contents);
      const result = await hostDiscovery(path, validatePrinterUri, now);
      expect(result.devices).toEqual([]);
      expect(result.warnings[0]).toContain('helper is unavailable');
    }
  });
});
