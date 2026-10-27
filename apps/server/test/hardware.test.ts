import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import {
  HardwareProvider,
  cupsIpp,
  validatePrinterUri,
  validateScanner,
  validateQueue,
} from '../src/providers/hardware.js';
import type { Device, PrintOptions } from '@openwebprint/shared';
import type { StoredJob } from '../src/store.js';
import { fixture } from './helpers.js';
import { command, CommandError } from '../src/providers/command.js';
import { randomUUID } from 'node:crypto';
const discoveryTypes = vi.hoisted(() => [] as string[]);
const advertisements = vi.hoisted(() => ({ enabled: true }));
vi.mock('bonjour-service', () => ({
  Bonjour: class {
    find({ type }: { type: string }, callback: (service: unknown) => void) {
      discoveryTypes.push(type);
      if (advertisements.enabled && ['ipp', 'ipps'].includes(type))
        callback({
          name: `Brother ${type}`,
          host: 'brother.local',
          port: 631,
          addresses: ['192.168.1.50'],
          txt: { rp: 'ipp/print' },
        });
      return { stop() {} };
    }
    destroy() {}
  },
}));
const device: Device = {
  id: randomUUID(),
  name: 'Brother',
  kind: 'printer',
  address: 'cups://Brother',
  target: 'Brother',
  location: '',
  mode: 'hardware',
  provider: 'cups',
  status: 'unknown',
};
const printOptions: PrintOptions = {
  copies: 2,
  color: 'monochrome',
  sides: 'two-sided-long-edge',
  media: 'iso_a4_210x297mm',
};
const job: StoredJob = {
  id: randomUUID(),
  deviceId: device.id,
  deviceName: device.name,
  kind: 'print',
  title: 'Test',
  status: 'queued',
  mode: 'hardware',
  externalId: '42',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  options: printOptions,
  hasFile: false,
};
describe('CUPS/SANE contracts (stubbed transport, no physical device claims)', () => {
  it.each([
    [new CommandError('No printers have been configured in CUPS.', 'empty-destinations'), false],
    [new CommandError('Scheduler unavailable.'), true],
  ])(
    'keeps network discovery working when local queue enumeration returns %s',
    async (failure, warning) => {
      vi.useFakeTimers();
      try {
        const run = vi.fn(async (tool: string) => {
          if (tool === 'lpstat') throw failure;
          return '';
        });
        const pending = new HardwareProvider('localhost:631', run).discover();
        await vi.advanceTimersByTimeAsync(4001);
        const result = await pending;
        expect(result.devices).toHaveLength(2);
        expect(result.warnings.some((message) => message.startsWith('CUPS:'))).toBe(warning);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it('explains network permission and multicast limitations when no devices respond', async () => {
    vi.useFakeTimers();
    advertisements.enabled = false;
    try {
      const run = vi.fn(async (tool: string) => {
        if (tool === 'lpstat')
          throw new CommandError('No printers configured.', 'empty-destinations');
        return '';
      });
      const pending = new HardwareProvider('localhost:631', run).discover();
      await vi.advanceTimersByTimeAsync(4001);
      const result = await pending;
      expect(result.devices).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Local Network');
      expect(result.warnings[0]).toContain('IP address');
      expect(result.warnings[0]).not.toContain('Docker');
    } finally {
      advertisements.enabled = true;
      vi.useRealTimers();
    }
  });
  it('discovers standard IPP/IPPS advertisements, local queues and SANE identifiers', async () => {
    vi.useFakeTimers();
    discoveryTypes.length = 0;
    try {
      const run = vi.fn(async (tool: string) =>
        tool === 'lpstat'
          ? 'device for Brother_Office: ipp://192.168.1.50/ipp/print\n'
          : 'airscan:e0:Brother\tBrother scanner\n',
      );
      const pending = new HardwareProvider('localhost:631', run).discover();
      await vi.advanceTimersByTimeAsync(4001);
      const found = await pending;
      expect(discoveryTypes).toEqual(['ipp', 'ipps']);
      expect(found.devices.map((d) => d.address)).toEqual(
        expect.arrayContaining([
          'cups://Brother_Office',
          'airscan:e0:Brother',
          'ipp://192.168.1.50:631/ipp/print',
          'ipps://192.168.1.50:631/ipp/print',
        ]),
      );
      expect(found.warnings).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
  it('maps the actual IPP library enum strings and unknown states honestly', async () => {
    const request = vi.fn().mockResolvedValue({
      'printer-state': 'idle',
      'printer-state-reasons': 'none',
      'sides-supported': ['one-sided', 'two-sided-long-edge'],
      'print-color-mode-supported': ['monochrome'],
      'media-supported': ['iso_a4_210x297mm'],
    });
    const provider = new HardwareProvider('localhost:631', vi.fn(), request);
    const inspected = await provider.inspect(device);
    expect(inspected.status).toBe('ready');
    expect(inspected.capabilities).toEqual({
      color: false,
      colorModes: ['monochrome'],
      sides: ['one-sided', 'two-sided-long-edge'],
      media: ['iso_a4_210x297mm'],
    });
    request.mockResolvedValue({ 'job-state': 'completed' });
    expect((await provider.poll(job, device)).status).toBe('completed');
    request.mockResolvedValue({ 'job-state': 7 });
    expect((await provider.poll(job, device)).status).toBe('canceled');
    request.mockResolvedValue({ 'job-state': 'aborted' });
    expect((await provider.poll(job, device)).status).toBe('failed');
    request.mockRejectedValue(new Error('Offline'));
    expect((await provider.poll(job, device)).status).toBe('unknown');
    expect((await provider.inspect(device)).status).toBe('unknown');
  });
  it('passes print and cancel arguments as values and parses the exact queue job id', async () => {
    const run = vi.fn().mockResolvedValue('request id is Brother-42 (1 file(s))\n');
    const provider = new HardwareProvider('localhost:631', run);
    expect(
      await provider.print(device, '/safe/id.pdf', '$(touch /tmp/never); -d hacked', printOptions),
    ).toBe('42');
    expect(run).toHaveBeenCalledWith('lp', [
      '-h',
      'localhost:631',
      '-d',
      'Brother',
      '-t',
      '$(touch /tmp/never); -d hacked',
      '-n',
      '2',
      '-o',
      'print-color-mode=monochrome',
      '-o',
      'sides=two-sided-long-edge',
      '-o',
      'media=iso_a4_210x297mm',
      '-o',
      'fit-to-page',
      '--',
      '/safe/id.pdf',
    ]);
    await provider.cancel(job, device);
    expect(run).toHaveBeenLastCalledWith('cancel', ['-h', 'localhost:631', 'Brother-42']);
    run.mockResolvedValue('request id is Another-42');
    await expect(provider.print(device, '/safe/id.pdf', 'Test', printOptions)).rejects.toThrow(
      'job ID',
    );
  });
  it('rejects unsafe protocols, credentials and command-like identifiers before invoking tools', async () => {
    for (const uri of [
      'file:///etc/passwd',
      'http://printer.local',
      'ipp://user:pass@printer.local/ipp',
      'ipp://printer.local/x#fragment',
      'ipp://printer.local/x\n-o',
    ])
      expect(() => validatePrinterUri(uri)).toThrow();
    expect(validatePrinterUri('ipps://192.168.1.50:631/ipp/print')).toContain('ipps:');
    for (const name of ['--help', 'Brother;rm', '../printer'])
      expect(() => validateQueue(name)).toThrow();
    expect(() => validateScanner('--help')).toThrow();
    expect(validateScanner('airscan:e0:Brother MFC-L2750DW')).toContain('Brother');
    const run = vi.fn();
    const provider = new HardwareProvider('localhost:631', run);
    await expect(
      provider.add(
        { name: 'Bad', kind: 'printer', address: 'file:///etc/passwd', location: '' },
        randomUUID(),
      ),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
  it('uses advertised SANE feeder and duplex options for bounded batches (stubbed command)', async () => {
    const scanner: Device = {
      ...device,
      kind: 'scanner',
      provider: 'sane',
      target: 'airscan:e0:Brother',
    };
    const run = vi.fn(async (_tool: string, args: string[]) => {
      if (args.includes('--all-options'))
        return '  --source Flatbed|ADF|ADF Duplex [Flatbed]\n    Selects the scan source.\n  --duplex[=(yes|no)] [no]\n';
      throw new CommandError('The document feeder is empty.', 'no-documents');
    });
    const provider = new HardwareProvider('localhost:631', run);
    expect(await provider.scanSources(scanner)).toEqual({
      sources: [
        { name: 'Flatbed', feeder: false },
        { name: 'ADF', feeder: true },
        { name: 'ADF Duplex', feeder: true },
      ],
      duplex: true,
    });
    await provider.scan(
      scanner,
      '/private/100%/page-%d.png',
      { resolution: 300, color: 'Gray', source: 'ADF', batch: true, duplex: true },
      12,
    );
    expect(run).toHaveBeenLastCalledWith(
      'scanimage',
      [
        '--device-name',
        scanner.target,
        '--format=png',
        '--batch=/private/100%%/page-%d.png',
        '--batch-count=12',
        '--source',
        'ADF',
        '--duplex=yes',
        '--resolution',
        '300',
        '--mode',
        'Gray',
      ],
      600_000,
      undefined,
    );
    await expect(
      provider.scan(scanner, '/private/page.png', { resolution: 300, color: 'Gray' }),
    ).rejects.toThrow('empty');
    await expect(
      provider.scan(scanner, '/private/page-%d.png', {
        resolution: 300,
        color: 'Gray',
        batch: true,
        source: 'Flatbed',
      }),
    ).rejects.toThrow('document feeder');
    await expect(
      provider.scan(scanner, '/private/page-%d.png', {
        resolution: 300,
        color: 'Gray',
        batch: true,
        source: 'Unadvertised ADF',
      }),
    ).rejects.toThrow('selected source');
    run.mockImplementation(async (_tool: string, args: string[]) => {
      if (args.includes('--all-options')) throw new CommandError('Disconnected');
      return '';
    });
    await expect(
      provider.scan(scanner, '/private/page-%d.png', {
        resolution: 300,
        color: 'Gray',
        batch: true,
        source: 'ADF',
      }),
    ).rejects.toThrow('unavailable');
  });
  it('reads wrapped source lists without inventing duplex support (stubbed command)', async () => {
    const scanner = { ...device, kind: 'scanner' as const, target: 'airscan:e0:Brother' };
    const run = vi
      .fn()
      .mockResolvedValue(
        '  --source Flatbed|Automatic Document Feeder|\n    ADF Duplex [Flatbed]\n    Selects the scan source.\n',
      );
    const provider = new HardwareProvider('localhost:631', run);
    expect(await provider.scanSources(scanner)).toEqual({
      sources: [
        { name: 'Flatbed', feeder: false },
        { name: 'Automatic Document Feeder', feeder: true },
        { name: 'ADF Duplex', feeder: true },
      ],
      duplex: false,
    });
  });
  it('calls SANE with explicit bounded options and surfaces failures', async () => {
    const run = vi.fn().mockResolvedValue('');
    const provider = new HardwareProvider('localhost:631', run);
    const scanner: Device = {
      ...device,
      kind: 'scanner',
      provider: 'sane',
      target: 'airscan:e0:Brother',
    };
    await provider.scan(scanner, '/safe/output.png', { resolution: 300, color: 'Gray' });
    expect(run).toHaveBeenCalledWith(
      'scanimage',
      [
        '--device-name',
        'airscan:e0:Brother',
        '--format=png',
        '--output-file',
        '/safe/output.png',
        '--resolution',
        '300',
        '--mode',
        'Gray',
      ],
      120_000,
      undefined,
    );
    run.mockRejectedValue(new Error('Disconnected'));
    await expect(
      provider.scan(scanner, '/safe/output.png', { resolution: 300, color: 'Color' }),
    ).rejects.toThrow('Disconnected');
    await expect(command('/nonexistent/openwebprint-command', [])).rejects.toThrow('not installed');
  });
  it('round-trips actual IPP bytes through the library against a local protocol fixture', async () => {
    const { default: ipp } = await import('@sealsystems/ipp');
    const codec = ipp as unknown as {
      serialize: (message: unknown) => Buffer;
      parse: (buffer: Buffer) => Record<string, unknown>;
    };
    let received: Record<string, unknown> | undefined;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        received = codec.parse(Buffer.concat(chunks));
        res.writeHead(200, { 'Content-Type': 'application/ipp' });
        res.end(
          codec.serialize({
            version: '2.0',
            statusCode: 'successful-ok',
            id: received!.id,
            'operation-attributes-tag': {
              'attributes-charset': 'utf-8',
              'attributes-natural-language': 'en',
            },
            'job-attributes-tag': { 'job-state': 'completed', 'job-id': 42 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const attrs = await cupsIpp(`127.0.0.1:${port}`)('Brother', 'Get-Job-Attributes', {
        'job-id': 42,
      });
      expect(attrs['job-state']).toBe('completed');
      expect(received!.operation).toBe('Get-Job-Attributes');
      expect((received!['operation-attributes-tag'] as Record<string, unknown>)['job-id']).toBe(42);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
describe('durability and mode isolation', () => {
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  afterEach(async () => {
    await f?.close();
    f = undefined;
  });
  it('never seeds demo devices during hardware setup', async () => {
    f = await fixture({ mode: 'hardware' });
    expect(f.store.devices('hardware')).toEqual([]);
    expect((await f.service.snapshot()).devices).toEqual([]);
    expect(f.store.devices('demo')).toEqual([]);
  });
  it('recovers interrupted scan state after restart and keeps users and device removals', async () => {
    f = await fixture();
    const dir = f.dataDir;
    const removed = f.store.devices('demo')[0];
    f.service.deleteDevice(removed.id);
    f.store.putJob({
      ...job,
      id: randomUUID(),
      mode: 'demo',
      kind: 'scan',
      externalId: undefined,
      status: 'processing',
      hasFile: false,
    });
    await f.close(false);
    f = undefined;
    f = await fixture({ dataDir: dir });
    expect(f.auth.hasUsers()).toBe(true);
    expect(f.store.devices('demo')).toHaveLength(2);
    expect(f.store.jobs('demo')[0].status).toBe('failed');
    expect(f.store.jobs('demo')[0].error).toContain('restarted');
  });
});
