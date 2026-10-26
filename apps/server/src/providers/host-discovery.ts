import { open } from 'node:fs/promises';
import { z } from 'zod';
import { deviceInputSchema, type DiscoveryResult } from '@openwebprint/shared';

const snapshotSchema = z.object({
  version: z.literal(1),
  source: z.literal('macos-bonjour'),
  generatedAt: z.iso.datetime(),
  devices: z.array(deviceInputSchema.extend({ kind: z.literal('printer') })).max(100),
  warnings: z.array(z.string().max(300)).max(10),
});
export async function hostDiscovery(
  path: string,
  validateAddress: (value: string) => string,
  now = Date.now(),
): Promise<DiscoveryResult> {
  try {
    const file = await open(path, 'r');
    let contents: string;
    try {
      const buffer = Buffer.alloc(128 * 1024 + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!chunk.bytesRead) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead > 128 * 1024) throw new Error('Snapshot too large');
      contents = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await file.close();
    }
    const snapshot = snapshotSchema.parse(JSON.parse(contents));
    const age = now - Date.parse(snapshot.generatedAt);
    if (age > 30_000 || age < -5_000) throw new Error('Stale discovery snapshot');
    return {
      devices: snapshot.devices.map((device) => ({
        ...device,
        address: validateAddress(device.address),
      })),
      warnings: snapshot.warnings,
      hostDiscovery: { source: snapshot.source, updatedAt: snapshot.generatedAt },
    };
  } catch {
    return {
      devices: [],
      warnings: [
        'macOS Bonjour helper is unavailable or its results have expired. Run npm run discovery:macos on the Mac and check the read-only discovery mount.',
      ],
    };
  }
}
