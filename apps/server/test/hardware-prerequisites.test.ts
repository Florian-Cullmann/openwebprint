import { afterEach, expect, it, vi } from 'vitest';
import type { HardwareReport } from '@openwebprint/shared';
import { fixture } from './helpers.js';
const check = vi.hoisted(() => vi.fn());
vi.mock('../../../scripts/install/hardware.mjs', () => ({ checkHardware: check }));
let instance: Awaited<ReturnType<typeof fixture>> | undefined;
afterEach(async () => {
  await instance?.close();
  instance = undefined;
  check.mockReset();
});
const report: HardwareReport = {
  checkedAt: '2026-10-27T12:00:00.000Z',
  platform: 'linux',
  method: 'source',
  ready: false,
  checks: [{ id: 'scanimage', label: 'Scanning software (SANE)', state: 'missing' }],
  guidance: 'Install scanning software.',
  note: 'Software checks only.',
};
it('protects read-only hardware checks with normal authentication and origin rules (stubbed OS checks)', async () => {
  instance = await fixture();
  const { app, headers } = instance;
  check.mockResolvedValue(report);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/hardware/prerequisites',
        headers: { 'x-openwebprint': '1' },
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/hardware/prerequisites',
        headers: { ...headers, origin: 'https://foreign.example' },
      })
    ).statusCode,
  ).toBe(403);
  expect(check).not.toHaveBeenCalled();
  expect(
    (await app.inject({ method: 'POST', url: '/api/hardware/prerequisites', headers })).json(),
  ).toEqual(report);
});
it('coalesces concurrent checks, retries after completion, and keeps checks out of snapshots (stubbed OS checks)', async () => {
  instance = await fixture({ users: false });
  const { app, headers } = instance;
  let finish!: (value: HardwareReport) => void;
  check.mockImplementationOnce(
    () =>
      new Promise<HardwareReport>((resolve) => {
        finish = resolve;
      }),
  );
  await app.inject('/api/snapshot');
  expect(check).not.toHaveBeenCalled();
  const request = { method: 'POST' as const, url: '/api/hardware/prerequisites', headers };
  const first = app.inject(request).then((response) => response.json());
  const second = app.inject(request).then((response) => response.json());
  await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
  await new Promise((resolve) => setImmediate(resolve));
  finish(report);
  expect(await first).toEqual(report);
  expect(await second).toEqual(report);
  check.mockResolvedValue({ ...report, ready: true, checks: [] });
  expect((await app.inject(request)).json().ready).toBe(true);
  expect(check).toHaveBeenCalledTimes(2);
});
