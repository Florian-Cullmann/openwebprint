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
import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';
import type { StoredJob } from '../store.js';
import { command, type Command } from './command.js';
import type { Provider } from './types.js';

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
            reject(new AppError(502, 'CUPS hat keine gültige IPP-Antwort geliefert.'));
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
  if (!queuePattern.test(queue)) throw new AppError(400, 'Ungültiger CUPS-Warteschlangenname.');
  return queue;
}
export function validatePrinterUri(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(400, 'Eine gültige ipp://- oder ipps://-Adresse eingeben.');
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
      'Nur IPP/IPPS-Adressen ohne Zugangsdaten, Query oder Fragment sind erlaubt.',
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
    throw new AppError(400, 'Eine gültige SANE-Gerätekennung eingeben, z. B. airscan:e0:Brother.');
  }
  return value;
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
  ) {
    this.request = request ?? cupsIpp(server);
  }
  private cups(executable: string, args: string[]) {
    return this.run(executable, ['-h', this.server, ...args]);
  }
  async discover(): Promise<DiscoveryResult> {
    const devices: DeviceInput[] = [];
    const warnings: string[] = [];
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
        .catch((e: Error) => warnings.push(`CUPS: ${e.message}`)),
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
        .catch(() =>
          warnings.push(
            'mDNS-Erkennung nicht verfügbar. Geräte können manuell hinzugefügt werden.',
          ),
        ),
    ]);
    return { devices: [...new Map(devices.map((d) => [d.address, d])).values()], warnings };
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
        detail: 'SANE-Gerät eingerichtet. Verfügbarkeit wird beim Scan geprüft.',
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
      return { ...device, status: 'unknown', detail: 'Verfügbarkeit wird beim Scan geprüft.' };
    try {
      const attrs = await this.request(validateQueue(device.target!), 'Get-Printer-Attributes');
      const reasons = list(attrs['printer-state-reasons']).join(', ');
      const offline = /offline|connecting-to-device|paused|shutdown/.test(reasons);
      const state =
        ({ idle: 3, processing: 4, stopped: 5 } as Record<string, number>)[
          String(attrs['printer-state'])
        ] ?? Number(attrs['printer-state']);
      const media = ['iso_a4_210x297mm', 'na_letter_8.5x11in', 'iso_a5_148x210mm'] as const;
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
        detail: reasons && reasons !== 'none' ? reasons : 'Status der CUPS-Warteschlange',
        capabilities: {
          color:
            list(attrs['print-color-mode-supported']).includes('color') ||
            attrs['color-supported'] === true,
          duplex: list(attrs['sides-supported']).includes('two-sided-long-edge'),
          media: media.filter((m) => list(attrs['media-supported']).includes(m)),
        },
      };
    } catch {
      return {
        ...device,
        status: 'unknown',
        capabilities: undefined,
        detail: 'CUPS-Warteschlange nicht erreichbar.',
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
        'CUPS hat keine Auftragskennung zurückgegeben. Vor erneutem Druck die Warteschlange prüfen.',
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
        error:
          state === 'failed'
            ? 'CUPS hat den Auftrag abgebrochen. Bitte die CUPS-Protokolle prüfen.'
            : undefined,
      };
    } catch {
      return {
        status: 'unknown' as const,
        error: 'Auftragsstatus derzeit nicht über CUPS abrufbar.',
      };
    }
  }
  async cancel(job: StoredJob, device: Device) {
    if (!/^\d+$/.test(job.externalId ?? '')) throw new AppError(400, 'Ungültige Auftragskennung.');
    await this.cups('cancel', [`${validateQueue(device.target!)}-${job.externalId}`]);
  }
  async scan(device: Device, outputPath: string, options: ScanOptions) {
    await this.run(
      'scanimage',
      [
        '--device-name',
        validateScanner(device.target!),
        '--format=png',
        '--output-file',
        outputPath,
        '--resolution',
        String(options.resolution),
        '--mode',
        options.color,
      ],
      120_000,
    );
  }
}
