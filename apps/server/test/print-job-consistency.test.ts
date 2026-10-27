import { afterEach, expect, it, vi } from 'vitest';
import { access, readdir } from 'node:fs/promises';
import type { StoredJob } from '../src/store.js';
import { AppError } from '../src/errors.js';
import { fixture, pdf } from './helpers.js';

let f: Awaited<ReturnType<typeof fixture>> | undefined;
afterEach(async () => {
  await f?.close();
  vi.restoreAllMocks();
  f = undefined;
});

// Explicit barriers keep the ordering deterministic, without sleeps or hardware.
function barrier() {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    started,
    release,
    async wait() {
      entered();
      await pending;
    },
  };
}

async function unconfirmedPrint() {
  f = await fixture({ users: false });
  const print = vi.spyOn(f.service.provider, 'print');
  const printer = f.store.devices('demo').find((device) => device.kind === 'printer')!;
  const submitted = await f.service.print(
    printer.id,
    await pdf(),
    'application/pdf',
    'Race fixture',
    {
      copies: 1,
      color: 'monochrome',
      sides: 'one-sided',
      media: 'iso_a4_210x297mm',
    },
  );
  const job = f.service.job(submitted.id);
  // A known scheduler ID with temporarily unconfirmed state, still eligible for deletion.
  job.status = 'unknown';
  job.error = 'Status not confirmed.';
  f.store.putJob(job);
  return { job, print };
}
function cancel(id: string) {
  return f!.app
    .inject({ method: 'POST', url: `/api/jobs/${id}/cancel`, headers: f!.headers })
    .then((response) => response);
}
function remove(id: string) {
  return f!.app
    .inject({ method: 'DELETE', url: `/api/jobs/${id}`, headers: f!.headers })
    .then((response) => response);
}
async function expectDeleted(job: StoredJob) {
  expect(f!.store.job(job.id, 'demo')).toBeUndefined();
  expect(f!.store.jobs('demo')).toEqual([]);
  await expect(access(job.filePath!)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readdir(f!.service.filesDir)).toEqual([]);
  for (const suffix of ['', '/document']) {
    expect((await f!.app.inject(`/api/jobs/${job.id}${suffix}`)).statusCode).toBe(404);
  }
}

it('never recreates a deleted unknown print when pending cancellation succeeds (stubbed provider)', async () => {
  const { job, print } = await unconfirmedPrint();
  const gate = barrier();
  const canceled = vi.spyOn(f!.service.provider, 'cancel').mockImplementationOnce(gate.wait);
  const pending = cancel(job.id);
  try {
    await gate.started;
    expect((await remove(job.id)).statusCode).toBe(200);
    await expectDeleted(job);
  } finally {
    gate.release();
    // The provider succeeded, but the HTTP request must report that the record is gone.
    expect((await pending).statusCode).toBe(404);
  }
  await expectDeleted(job);
  expect((await cancel(job.id)).statusCode).toBe(404);
  expect(canceled).toHaveBeenCalledTimes(1);
  expect(print).toHaveBeenCalledTimes(1);
});

it.each(['status', 'error'] as const)(
  'ignores a late polling %s after deletion without cancellation (stubbed provider)',
  async (outcome) => {
    const { job, print } = await unconfirmedPrint();
    const gate = barrier();
    const poll = vi.spyOn(f!.service.provider, 'poll').mockImplementationOnce(async () => {
      await gate.wait();
      if (outcome === 'error') throw new Error('Controlled poll failure');
      return { status: 'processing' };
    });
    const pending = f!.service.tick();
    try {
      await gate.started;
      expect((await remove(job.id)).statusCode).toBe(200);
    } finally {
      gate.release();
      await pending;
    }
    await expectDeleted(job);
    await f!.service.tick();
    expect(poll).toHaveBeenCalledTimes(1);
    expect(print).toHaveBeenCalledTimes(1);
  },
);

it('allows deletion after confirmed cancellation without submitting another print (stubbed provider)', async () => {
  const { job, print } = await unconfirmedPrint();
  const canceled = vi.spyOn(f!.service.provider, 'cancel');
  const poll = vi.spyOn(f!.service.provider, 'poll');
  expect((await cancel(job.id)).json()).toMatchObject({ status: 'canceled', hasFile: true });
  expect((await remove(job.id)).statusCode).toBe(200);
  await f!.service.tick();
  await expectDeleted(job);
  expect(canceled).toHaveBeenCalledTimes(1);
  expect(poll).not.toHaveBeenCalled();
  expect(print).toHaveBeenCalledTimes(1);
});

it('keeps deletion final when cancellation completes during file removal (stubbed provider)', async () => {
  const { job, print } = await unconfirmedPrint();
  const gate = barrier();
  const removeFiles = f!.service.removeFiles.bind(f!.service);
  vi.spyOn(f!.service, 'removeFiles').mockImplementationOnce(async (stored) => {
    await gate.wait();
    await removeFiles(stored);
  });
  const pending = remove(job.id);
  try {
    await gate.started;
    const response = await cancel(job.id);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ status: 'canceled', hasFile: true });
    await access(job.filePath!);
  } finally {
    gate.release();
    expect((await pending).statusCode).toBe(200);
  }
  await expectDeleted(job);
  expect(print).toHaveBeenCalledTimes(1);
});

it.each(['status', 'error'] as const)(
  'preserves a successful cancellation when an earlier poll returns a late %s (stubbed provider)',
  async (outcome) => {
    const { job, print } = await unconfirmedPrint();
    const gate = barrier();
    vi.spyOn(f!.service.provider, 'poll').mockImplementationOnce(async () => {
      await gate.wait();
      if (outcome === 'error') throw new Error('Controlled poll failure');
      return { status: 'processing' };
    });
    const pending = f!.service.tick();
    let canceled: StoredJob | undefined;
    try {
      await gate.started;
      expect((await cancel(job.id)).statusCode).toBe(200);
      canceled = f!.service.job(job.id);
      expect(canceled).toMatchObject({ status: 'canceled', hasFile: true });
      expect(canceled.error).toBeUndefined();
    } finally {
      gate.release();
      await pending;
    }
    expect(f!.service.job(job.id)).toEqual(canceled);
    await access(job.filePath!);
    expect((await f!.app.inject(`/api/jobs/${job.id}/document`)).statusCode).toBe(200);
    expect(print).toHaveBeenCalledTimes(1);
  },
);

it('preserves an unconfirmed job and its document when cancellation is rejected (stubbed provider)', async () => {
  const { job, print } = await unconfirmedPrint();
  vi.spyOn(f!.service.provider, 'cancel').mockRejectedValueOnce(
    new AppError(502, 'Controlled cancellation rejection.'),
  );
  expect((await cancel(job.id)).statusCode).toBe(502);
  expect(f!.service.job(job.id)).toEqual(job);
  await access(job.filePath!);
  expect(print).toHaveBeenCalledTimes(1);
});
