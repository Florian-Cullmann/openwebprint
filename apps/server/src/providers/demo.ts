import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import type { Device, DeviceInput, PrintOptions, ScanOptions } from '@openwebprint/shared';
import {
  PRINT_SIDES,
  FALLBACK_SCAN_RESOLUTIONS,
  FALLBACK_SCAN_COLOR_MODES,
  scanSettingsError,
} from '@openwebprint/shared';
import { AppError } from '../errors.js';
import type { StoredJob } from '../store.js';
import type { Provider } from './types.js';
export const demoDevices: DeviceInput[] = [
  {
    name: 'Brother MFC-L2750DW',
    kind: 'printer',
    address: 'demo://brother-printer',
    location: 'Study',
  },
  {
    name: 'Brother MFC-L2750DW · Scanner',
    kind: 'scanner',
    address: 'demo://brother-scanner',
    location: 'Study',
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
              sides: [...PRINT_SIDES],
              media: ['iso_a4_210x297mm', 'na_letter_8.5x11in', 'iso_a5_148x210mm'],
            }
          : undefined,
    };
  }
  async inspect(device: Device) {
    // Rebuild capabilities so devices saved before sides discovery are refreshed too.
    return this.add(device, device.id);
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
  async scanSources() {
    return {
      sources: [
        { name: 'Flatbed', feeder: false },
        { name: 'ADF', feeder: true },
        { name: 'ADF Duplex', feeder: true },
      ],
      duplex: false,
      resolutions: [...FALLBACK_SCAN_RESOLUTIONS],
      colorModes: [...FALLBACK_SCAN_COLOR_MODES],
      defaultResolution: 300,
      defaultColorMode: 'Color',
    };
  }
  async scan(
    _device: Device,
    outputPath: string,
    options: ScanOptions,
    pageLimit = 100,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const settingsError = scanSettingsError(await this.scanSources(), options);
    if (settingsError) throw new AppError(400, settingsError);
    const image = await sharp(
      Buffer.from(`<svg width="1240" height="1754" xmlns="http://www.w3.org/2000/svg">
    <rect width="1240" height="1754" fill="#fff"/><rect x="90" y="100" width="50" height="50" rx="10" fill="#24252a"/>
    <g font-family="sans-serif" fill="#202124"><text x="170" y="140" font-size="36" font-weight="bold">openwebprint</text>
    <text x="90" y="300" font-size="58" font-weight="bold">Your scan, ready to use.</text>
    <text x="90" y="370" font-size="25">One document. One browser. All on your server.</text>
    <text x="90" y="560" font-size="24">This is a simulated scan in demo mode.</text>
    <text x="90" y="610" font-size="24">No physical scanner was used.</text>
    <text x="90" y="1450" font-size="20">OPEN SOURCE · SELF HOSTED · MIT LICENSE</text></g>
    <path d="M90 760H1100M90 830H1100M90 900H850" stroke="#e3e4e8" stroke-width="12"/>
    <rect x="90" y="1070" width="1010" height="180" rx="16" fill="#f1f1f3"/>
    <text x="130" y="1170" font-family="sans-serif" fill="#24252a" font-size="30">Your documents stay on your server.</text></svg>`),
    )
      // The sample represents an A4 page at 150 dpi; scale its pixels to the
      // simulated acquisition resolution so exported dimensions stay constant.
      .resize(
        Math.round((1240 * options.resolution) / 150),
        Math.round((1754 * options.resolution) / 150),
      )
      .png()
      .toBuffer();
    const count = options.batch ? (options.duplex || options.source === 'ADF Duplex' ? 4 : 3) : 1;
    for (let page = 1; page <= Math.min(count, pageLimit); page++) {
      signal?.throwIfAborted();
      await writeFile(outputPath.replace('%d', String(page)), image, { mode: 0o600 });
    }
  }
}
