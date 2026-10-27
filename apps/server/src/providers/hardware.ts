import { Bonjour } from 'bonjour-service';
import ipp from '@sealsystems/ipp';
import type {
  Device,
  DeviceInput,
  DiscoveryResult,
  PrintOptions,
  ScanOptions,
  JobStatus,
} from '@openwebprint/shared';
import {
  MAX_SCAN_PAGES,
  PRINT_SIDES,
  PRINT_COLOR_MODES,
  scanSettingsError,
  type ScanSources,
} from '@openwebprint/shared';
import { randomUUID } from 'node:crypto';
import { dirname, basename, join } from 'node:path';
import { AppError } from '../errors.js';
import type { StoredJob } from '../store.js';
import { command, CommandError, type Command } from './command.js';
import type { Provider } from './types.js';
import { hostDiscovery } from './host-discovery.js';
import { saneCapabilities } from './sane-capabilities.js';

type Attributes = Record<string, unknown>;
export type IppRequest = (
  queue: string,
  operation: string,
  attributes?: Attributes,
) => Promise<Attributes>;
export function cupsIpp(server: string): IppRequest {
  return (queue, operation, attributes = {}) =>
    new Promise((resolve, reject) => {
      const url = `http://${server}/printers/${encodeURIComponent(queue)}`;
      const printer = ipp.Printer(url, {
        version: '2.0',
        timeout: 10_000,
        uri: `ipp://${server}/printers/${encodeURIComponent(queue)}`,
      });
      printer.execute(
        operation,
        { 'operation-attributes-tag': { 'requesting-user-name': 'openwebprint', ...attributes } },
        (error: Error | null, response: { statusCode: string; [key: string]: unknown }) => {
          if (error || !response?.statusCode?.startsWith('successful')) {
            reject(new AppError(502, 'CUPS did not return a valid IPP response.'));
            return;
          }
          resolve(
            (response['printer-attributes-tag'] ??
              response['job-attributes-tag'] ??
              {}) as Attributes,
          );
        },
      );
    });
}
const queuePattern = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,126}$/;
export function validateQueue(queue: string) {
  if (!queuePattern.test(queue)) throw new AppError(400, 'Invalid CUPS queue name.');
  return queue;
}
export function validatePrinterUri(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(400, 'Enter a valid ipp:// or ipps:// address.');
  }
  if (
    !['ipp:', 'ipps:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    /[\s\x00-\x1f]/.test(value)
  ) {
    throw new AppError(
      400,
      'Only IPP/IPPS addresses without credentials, query strings or fragments are allowed.',
    );
  }
  return url.href;
}
export function validateScanner(value: string) {
  if (
    !/^[a-zA-Z0-9_][a-zA-Z0-9_-]*:.+/.test(value) ||
    /[\x00-\x1f\x7f]/.test(value) ||
    value.length > 512
  ) {
    throw new AppError(400, 'Enter a valid SANE device ID, e.g. airscan:e0:Brother.');
  }
  return value;
}
export function validateHostScanner(value: string) {
  const match = /^airscan:escl:([^:\x00-\x1f\x7f]{1,80}):(https?:\/\/.+)$/.exec(value);
  if (!match || value.length > 512) throw new AppError(400, 'Invalid AirScan discovery address.');
  let url: URL;
  try {
    url = new URL(match[2]);
  } catch {
    throw new AppError(400, 'Invalid AirScan URL.');
  }
  if (
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    /[\s\x00-\x1f\x7f]/.test(match[2])
  )
    throw new AppError(400, 'Invalid AirScan discovery address.');
  return validateScanner(value);
}
const list = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const states: Record<string, JobStatus> = {
  3: 'queued',
  4: 'queued',
  5: 'processing',
  6: 'processing',
  7: 'canceled',
  8: 'failed',
  9: 'completed',
  pending: 'queued',
  'pending-held': 'queued',
  processing: 'processing',
  'processing-stopped': 'processing',
  canceled: 'canceled',
  aborted: 'failed',
  completed: 'completed',
};

export class HardwareProvider implements Provider {
  private readonly request: IppRequest;
  constructor(
    private readonly server: string,
    private readonly run: Command = command,
    request?: IppRequest,
    private readonly hostDiscoveryFile?: string,
  ) {
    this.request = request ?? cupsIpp(server);
  }
  private cups(executable: string, args: string[]) {
    return this.run(executable, ['-h', this.server, ...args]);
  }
  async discover(): Promise<DiscoveryResult> {
    const devices: DeviceInput[] = [];
    const warnings: string[] = [];
    let host: DiscoveryResult['hostDiscovery'];
    await Promise.all([
      this.cups('lpstat', ['-v'])
        .then((output) => {
          for (const line of output.split('\n')) {
            const match = /^device for ([^:]+):\s*(.+)$/.exec(line);
            if (match && queuePattern.test(match[1]))
              devices.push({
                name: match[1],
                kind: 'printer',
                address: `cups://${match[1]}`,
                location: '',
              });
          }
        })
        .catch((e: Error) => {
          if (!(e instanceof CommandError && e.reason === 'empty-destinations'))
            warnings.push(`CUPS: ${e.message}`);
        }),
      this.run('scanimage', ['--formatted-device-list=%d\t%v %m%n'], 35_000)
        .then((output) => {
          for (const line of output.trim().split('\n')) {
            const [address, name] = line.split('\t');
            if (address && name)
              devices.push({
                name: name.trim().slice(0, 80),
                kind: 'scanner',
                address,
                location: '',
              });
          }
        })
        .catch((e: Error) => warnings.push(`SANE: ${e.message}`)),
      this.networkPrinters()
        .then((found) => devices.push(...found))
        .catch(() => warnings.push('mDNS discovery is unavailable. Add devices manually.')),
      this.hostDiscoveryFile
        ? hostDiscovery(this.hostDiscoveryFile, (address, kind) =>
            kind === 'printer' ? validatePrinterUri(address) : validateHostScanner(address),
          ).then((result) => {
            devices.push(...result.devices);
            warnings.push(...result.warnings);
            host = result.hostDiscovery;
          })
        : Promise.resolve(),
    ]);
    if (!devices.length)
      warnings.push(
        'No devices responded to discovery. If you use Docker Desktop on macOS, enable Docker in System Settings → Privacy & Security → Local Network. Docker bridge networking can also limit automatic discovery; use the optional macOS Bonjour helper, Linux host networking, or add a device by IP address.',
      );
    return {
      devices: [...new Map(devices.map((d) => [d.address, d])).values()],
      warnings,
      ...(host ? { hostDiscovery: host } : {}),
    };
  }
  private networkPrinters(): Promise<DeviceInput[]> {
    return new Promise((resolve, reject) => {
      const found = new Map<string, DeviceInput>();
      const bonjour = new Bonjour(undefined, () => {
        cleanup();
        reject(new Error('mDNS unavailable'));
      });
      let timer: ReturnType<typeof setTimeout>;
      const browsers: ReturnType<Bonjour['find']>[] = [];
      function cleanup() {
        clearTimeout(timer);
        browsers.forEach((b) => b.stop());
        bonjour.destroy();
      }
      for (const type of ['ipp', 'ipps']) {
        browsers.push(
          bonjour.find({ type }, (service) => {
            const host =
              service.addresses?.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? service.host;
            const path = String(service.txt?.rp ?? 'ipp/print').replace(/^\/+/, '');
            try {
              const address = validatePrinterUri(`${type}://${host}:${service.port}/${path}`);
              found.set(address, {
                name: service.name.slice(0, 80),
                kind: 'printer',
                address,
                location: String(service.txt?.note ?? '').slice(0, 80),
              });
            } catch {
              /* Ignore malformed network advertisements. */
            }
          }),
        );
      }
      timer = setTimeout(() => {
        cleanup();
        resolve([...found.values()]);
      }, 4000);
    });
  }
  async add(input: DeviceInput, id: string): Promise<Device> {
    if (input.kind === 'scanner') {
      const target = validateScanner(input.address);
      // Probe the exact backend before storing it; discovery alone is not a health check.
      await this.run('scanimage', ['--device-name', target, '--all-options'], 20_000);
      return {
        ...input,
        target,
        id,
        mode: 'hardware',
        provider: 'sane',
        status: 'unknown',
        detail: 'SANE device configured. Availability is checked when scanning.',
      };
    }
    let queue: string;
    if (input.address.startsWith('cups://')) {
      queue = validateQueue(input.address.slice(7));
      await this.cups('lpstat', ['-p', queue]);
    } else {
      const uri = validatePrinterUri(input.address);
      queue = `owp_${id.replaceAll('-', '')}`;
      await this.cups('lpadmin', [
        '-p',
        queue,
        '-E',
        '-v',
        uri,
        '-m',
        'everywhere',
        '-o',
        'printer-is-shared=false',
      ]);
    }
    return this.inspect({
      ...input,
      id,
      target: queue,
      mode: 'hardware',
      provider: 'cups',
      status: 'unknown',
    });
  }
  async inspect(device: Device): Promise<Device> {
    if (device.kind === 'scanner')
      return { ...device, status: 'unknown', detail: 'Availability is checked when scanning.' };
    try {
      const attrs = await this.request(validateQueue(device.target!), 'Get-Printer-Attributes');
      const reasons = list(attrs['printer-state-reasons']).join(', ');
      const offline = /offline|connecting-to-device|paused|shutdown/.test(reasons);
      const state =
        ({ idle: 3, processing: 4, stopped: 5 } as Record<string, number>)[
          String(attrs['printer-state'])
        ] ?? Number(attrs['printer-state']);
      const media = ['iso_a4_210x297mm', 'na_letter_8.5x11in', 'iso_a5_148x210mm'] as const;
      const colorModes =
        attrs['print-color-mode-supported'] == null
          ? undefined
          : PRINT_COLOR_MODES.filter((mode) =>
              list(attrs['print-color-mode-supported']).includes(mode),
            );
      return {
        ...device,
        status:
          offline || state === 5
            ? 'offline'
            : state === 4
              ? 'busy'
              : state === 3
                ? 'ready'
                : 'unknown',
        detail: reasons && reasons !== 'none' ? reasons : 'CUPS queue status',
        capabilities: {
          color: colorModes?.includes('color') ?? false,
          colorModes,
          sides:
            attrs['sides-supported'] == null
              ? undefined
              : PRINT_SIDES.filter((side) => list(attrs['sides-supported']).includes(side)),
          media: media.filter((m) => list(attrs['media-supported']).includes(m)),
        },
      };
    } catch {
      return {
        ...device,
        status: 'unknown',
        capabilities: undefined,
        detail: 'CUPS queue is unreachable.',
      };
    }
  }
  async print(device: Device, filePath: string, title: string, options: PrintOptions) {
    const queue = validateQueue(device.target!);
    const output = await this.cups('lp', [
      '-d',
      queue,
      '-t',
      title,
      '-n',
      String(options.copies),
      '-o',
      `print-color-mode=${options.color}`,
      '-o',
      `sides=${options.sides}`,
      '-o',
      `media=${options.media}`,
      '-o',
      'fit-to-page',
      '--',
      filePath,
    ]);
    const match = /request id is (\S+)-(\d+)/.exec(output);
    if (!match || match[1] !== queue)
      throw new AppError(
        502,
        'CUPS did not return a job ID. Check the queue before printing again.',
      );
    return match[2];
  }
  async poll(job: StoredJob, device: Device) {
    try {
      const attrs = await this.request(validateQueue(device.target!), 'Get-Job-Attributes', {
        'job-id': Number(job.externalId),
      });
      const state = states[String(attrs['job-state'])] ?? 'unknown';
      return {
        status: state,
        error: state === 'failed' ? 'CUPS aborted this job. Check the CUPS logs.' : undefined,
      };
    } catch {
      return {
        status: 'unknown' as const,
        error: 'CUPS job status is currently unavailable.',
      };
    }
  }
  async cancel(job: StoredJob, device: Device) {
    if (!/^\d+$/.test(job.externalId ?? '')) throw new AppError(400, 'Invalid job ID.');
    await this.cups('cancel', [`${validateQueue(device.target!)}-${job.externalId}`]);
  }
  async scanSources(device: Device, source?: string, signal?: AbortSignal): Promise<ScanSources> {
    signal?.throwIfAborted();
    const args = ['--device-name', validateScanner(device.target!)];
    let capabilities: ScanSources;
    try {
      capabilities = saneCapabilities(
        await this.run('scanimage', [...args, '--all-options'], 20_000, signal),
      );
    } catch {
      signal?.throwIfAborted();
      return {
        sources: [],
        duplex: false,
        warning: 'Scanner capabilities could not be determined.',
      };
    }
    if (!source) return capabilities;
    if (!capabilities.sources.some((s) => s.name === source))
      throw new AppError(400, 'The scanner does not support the selected source.');
    try {
      const selected = saneCapabilities(
        await this.run('scanimage', [...args, '--source', source, '--all-options'], 20_000, signal),
      );
      return { ...selected, sources: capabilities.sources };
    } catch {
      signal?.throwIfAborted();
      return {
        sources: capabilities.sources,
        duplex: false,
        warning: 'Capabilities for this paper source could not be determined.',
      };
    }
  }
  async scan(
    device: Device,
    outputPath: string,
    options: ScanOptions,
    pageLimit = MAX_SCAN_PAGES,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (options.batch && !options.source)
      throw new AppError(400, 'Choose a document feeder source for batch scanning.');
    const capabilities = await this.scanSources(device, options.source, signal);
    signal?.throwIfAborted();
    const settingsError = scanSettingsError(capabilities, options);
    if (settingsError) throw new AppError(400, settingsError);
    if (options.source || options.duplex) {
      const source = capabilities.sources.find((s) => s.name === options.source);
      if (options.source && !source && capabilities.warning)
        throw new AppError(
          409,
          'Scanner paper sources are unavailable. Retry discovery or use the device default.',
        );
      if (options.source && !source)
        throw new AppError(400, 'The scanner does not support the selected source.');
      if (options.batch && !source?.feeder)
        throw new AppError(400, 'Batch scanning requires a document feeder.');
      if (options.duplex && !capabilities.duplex)
        throw new AppError(400, 'The scanner does not support the duplex option.');
    }
    try {
      await this.run(
        'scanimage',
        [
          '--device-name',
          validateScanner(device.target!),
          '--format=png',
          ...(options.batch
            ? [
                `--batch=${join(dirname(outputPath).replaceAll('%', '%%'), basename(outputPath))}`,
                `--batch-count=${pageLimit}`,
              ]
            : ['--output-file', outputPath]),
          ...(options.source ? ['--source', options.source] : []),
          ...(options.duplex ? ['--duplex=yes'] : []),
          '--resolution',
          String(options.resolution),
          '--mode',
          options.color,
        ],
        options.batch ? 600_000 : 120_000,
        signal,
      );
    } catch (error) {
      signal?.throwIfAborted();
      if (!(options.batch && error instanceof CommandError && error.reason === 'no-documents'))
        throw error;
      // The service requires at least one complete image before publishing the batch.
    }
  }
}
