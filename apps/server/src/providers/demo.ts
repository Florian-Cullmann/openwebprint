import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import type { Device, DeviceInput, PrintOptions, ScanOptions } from '@openwebprint/shared';
import type { StoredJob } from '../store.js';
import type { Provider } from './types.js';
export const demoDevices: DeviceInput[] = [
  {
    name: 'Brother MFC-L2750DW',
    kind: 'printer',
    address: 'demo://brother-printer',
    location: 'Arbeitszimmer',
  },
  {
    name: 'Brother MFC-L2750DW · Scanner',
    kind: 'scanner',
    address: 'demo://brother-scanner',
    location: 'Arbeitszimmer',
  },
  {
    name: 'Epson EcoTank ET-4850',
    kind: 'printer',
    address: 'demo://epson-printer',
    location: 'Studio',
  },
];
export class DemoProvider implements Provider {
  async discover() {
    return { devices: demoDevices, warnings: [] };
  }
  async add(input: DeviceInput, id: string): Promise<Device> {
    return {
      ...input,
      id,
      provider: 'demo',
      mode: 'demo',
      status: 'ready',
      capabilities:
        input.kind === 'printer'
          ? {
              color: !input.name.includes('L2750'),
              duplex: true,
              media: ['iso_a4_210x297mm', 'na_letter_8.5x11in', 'iso_a5_148x210mm'],
            }
          : undefined,
    };
  }
  async inspect(device: Device) {
    return { ...device, status: 'ready' as const };
  }
  async print(_device: Device, _path: string, _title: string, _options: PrintOptions) {
    return `demo-${crypto.randomUUID()}`;
  }
  async poll(job: StoredJob) {
    const age = Date.now() - new Date(job.createdAt).getTime();
    return {
      status:
        age > 7000
          ? ('completed' as const)
          : age > 2000
            ? ('processing' as const)
            : ('queued' as const),
    };
  }
  async cancel() {}
  async scan(_device: Device, outputPath: string, _options: ScanOptions) {
    const image = await sharp(
      Buffer.from(`<svg width="1240" height="1754" xmlns="http://www.w3.org/2000/svg">
    <rect width="1240" height="1754" fill="#fff"/><rect x="90" y="100" width="50" height="50" rx="10" fill="#087f6e"/>
    <g font-family="sans-serif" fill="#1a3030"><text x="170" y="140" font-size="36" font-weight="bold">openwebprint</text>
    <text x="90" y="300" font-size="58" font-weight="bold">Platz für deine Ideen.</text>
    <text x="90" y="370" font-size="25">Ein Dokument. Ein Browser. Alles unter deiner Kontrolle.</text>
    <text x="90" y="560" font-size="24">Dies ist ein simulierter Scan im Demo-Modus.</text>
    <text x="90" y="610" font-size="24">Es wurde kein Scanner angesprochen.</text>
    <text x="90" y="1450" font-size="20">OPEN SOURCE · SELF HOSTED · MIT LICENSE</text></g>
    <path d="M90 760H1100M90 830H1100M90 900H850" stroke="#e0e8e5" stroke-width="12"/>
    <rect x="90" y="1070" width="1010" height="180" rx="16" fill="#edf7f3"/>
    <text x="130" y="1170" font-family="sans-serif" fill="#087f6e" font-size="30">Deine Dokumente bleiben bei dir.</text></svg>`),
    )
      .png()
      .toBuffer();
    await writeFile(outputPath, image, { mode: 0o600 });
  }
}
