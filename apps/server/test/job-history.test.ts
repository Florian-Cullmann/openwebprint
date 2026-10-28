import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobPage } from '@openwebprint/shared';
import type { StoredJob } from '../src/store.js';
import { fixture, pdf } from './helpers.js';

let f: Awaited<ReturnType<typeof fixture>>;
afterEach(async () => {
  vi.restoreAllMocks();
  await f?.close();
});

function job(index: number, overrides: Partial<StoredJob> = {}): StoredJob {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    deviceId: randomUUID(),
    deviceName: 'Synthetic device',
    kind: index % 2 ? 'scan' : 'print',
    title: `Archive ${index}`,
    status: 'completed',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    mode: 'demo',
    hasFile: false,
    options: { resolution: 150, color: 'Color' },
    ...overrides,
  };
}
async function listing(query = '') {
  const response = await f.app.inject({
    url: `/api/jobs${query ? `?${query}` : ''}`,
    headers: f.headers,
  });
  expect(response.statusCode).toBe(200);
  return response.json<JobPage>();
}

describe('bounded job history (synthetic stored records, no hardware)', () => {
  it('reaches all 305 mixed records with tied timestamps despite insertion and cursor-record deletion', async () => {
    f = await fixture();
    for (let index = 1; index <= 305; index++) f.store.putJob(job(index));
    f.store.putJob(job(900, { mode: 'hardware' }));
    // HTTP listings must not fall back to materializing the full store history.
    const allJobs = vi.spyOn(f.store, 'jobs').mockImplementation(() => {
      throw new Error('Unbounded history read');
    });
    const pageRead = vi.spyOn(f.store, 'jobPage');
    const first = await listing('limit=37');
    expect(first.jobs).toHaveLength(37);
    expect(first.total).toBe(305);
    expect(first.offset).toBe(0);
    expect(first.jobs[0].id).toBe(job(305).id);
    expect(pageRead.mock.results[0].value).toHaveLength(38);
    const seen = first.jobs.map((job) => job.id);
    f.store.putJob(job(999, { createdAt: '2026-01-02T00:00:00.000Z' }));
    const shifted = await listing(`limit=37&cursor=${first.nextCursor}`);
    expect(shifted.total).toBe(306);
    expect(shifted.offset).toBe(38);
    const anchor = first.jobs.at(-1)!;
    f.store.deleteJob(anchor.id, 'demo');
    let cursor = first.nextCursor;
    while (cursor) {
      const next = await listing(`limit=37&cursor=${cursor}`);
      expect(next.jobs.length).toBeLessThanOrEqual(37);
      expect(next.total).toBe(305);
      seen.push(...next.jobs.map((job) => job.id));
      cursor = next.nextCursor;
    }
    expect(seen).toEqual(Array.from({ length: 305 }, (_, index) => job(305 - index).id));
    expect((await listing()).jobs[0].id).toBe(job(999).id);
    const snapshot = await f.app.inject({ url: '/api/snapshot', headers: f.headers });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json().jobs).toHaveLength(200);
    expect(allJobs).not.toHaveBeenCalled();
    expect(pageRead.mock.calls.every(([, options]) => options.limit <= 200)).toBe(true);
  });

  it('filters the entire history and keeps old files and expired records honest', async () => {
    f = await fixture();
    for (let index = 1; index <= 240; index++) f.store.putJob(job(index, { kind: 'print' }));
    const filePath = join(f.dataDir, 'archive.pdf');
    const document = await pdf();
    await writeFile(filePath, document);
    const retained = job(0, {
      kind: 'scan',
      hasFile: true,
      filePath,
      previewPath: '/private/preview.png',
      externalId: 'secret',
      createdAt: new Date().toISOString(),
    });
    f.store.putJob(retained);
    const expired = job(241, { kind: 'scan' });
    f.store.putJob(expired);
    f.store.putJob(job(242, { status: 'unknown' }));
    f.store.putJob(job(243, { status: 'processing' }));
    const scans = await listing('kind=scan&search=archive&limit=1');
    expect(scans.total).toBe(3);
    expect(scans.jobs[0].id).toBe(retained.id);
    expect(scans.jobs[0].hasFile).toBe(true);
    for (const key of ['filePath', 'previewPath', 'externalId'])
      expect(scans.jobs[0]).not.toHaveProperty(key);
    expect(
      (await listing(`kind=scan&search=archive&limit=1&cursor=${scans.nextCursor}`)).jobs[0].id,
    ).toBe(job(243).id);
    const active = await listing('filter=active');
    expect(active.total).toBe(2);
    expect(active.jobs.map((job) => job.status)).toEqual(['processing', 'unknown']);
    const completed = await listing('kind=print&filter=completed&limit=100');
    expect(completed.jobs).toHaveLength(100);
    expect(completed.total).toBe(240);
    const expiredInfo = await f.app.inject({ url: `/api/jobs/${expired.id}`, headers: f.headers });
    expect(expiredInfo.json().hasFile).toBe(false);
    expect(
      (await f.app.inject({ url: `/api/jobs/${expired.id}/pdf`, headers: f.headers })).statusCode,
    ).toBe(404);
    expect(
      (await f.app.inject({ url: `/api/jobs/${retained.id}/pdf`, headers: f.headers })).rawPayload,
    ).toEqual(document);
    // Expiration removes files but keeps the scan reachable in history and through its ID.
    retained.createdAt = new Date(Date.now() - 8 * 86400_000).toISOString();
    retained.previewPath = undefined;
    f.store.putJob(retained);
    await f.service.expireFiles();
    const old = await f.app.inject({ url: `/api/jobs/${retained.id}`, headers: f.headers });
    expect(old.statusCode).toBe(200);
    expect(old.json().hasFile).toBe(false);
    expect(
      (await listing('kind=scan&search=Archive%200')).jobs.some(
        (job) => job.id === retained.id && !job.hasFile,
      ),
    ).toBe(true);
  });

  it('rejects invalid bounds/cursors and authenticates history and direct job reads', async () => {
    f = await fixture();
    for (let index = 1; index <= 3; index++) f.store.putJob(job(index));
    const first = await listing('limit=1');
    for (const query of [
      'limit=0',
      'limit=101',
      'limit=1.5',
      'limit=no',
      'kind=invalid',
      'filter=failed',
      `search=${'a'.repeat(201)}`,
      'cursor=broken',
      `kind=scan&cursor=${first.nextCursor}`,
      `filter=active&cursor=${first.nextCursor}`,
    ]) {
      expect(
        (await f.app.inject({ url: `/api/jobs?${query}`, headers: f.headers })).statusCode,
      ).toBe(400);
    }
    const foreign = Buffer.from(
      JSON.stringify({
        createdAt: job(1).createdAt,
        id: job(1).id,
        mode: 'hardware',
        filter: 'all',
      }),
    ).toString('base64url');
    expect(
      (await f.app.inject({ url: `/api/jobs?cursor=${foreign}`, headers: f.headers })).statusCode,
    ).toBe(400);
    for (const url of ['/api/jobs', '/api/jobs?kind=scan&search=Archive', `/api/jobs/${job(1).id}`])
      expect((await f.app.inject({ url })).statusCode).toBe(401);
    expect(
      (await f.app.inject({ url: `/api/jobs/${randomUUID()}`, headers: f.headers })).statusCode,
    ).toBe(404);
  });

  it('searches all titles with literal Unicode text and binds pagination to the query', async () => {
    f = await fixture();
    for (let index = 1; index <= 305; index++)
      f.store.putJob(
        job(index, { kind: 'scan', title: index <= 65 ? `ÜBER archive ${index}` : 'Other scan' }),
      );
    f.store.putJob(job(306, { kind: 'print', title: 'Über archive print' }));
    f.store.putJob(job(307, { mode: 'hardware', kind: 'scan', title: 'Über archive hardware' }));
    f.store.putJob(job(308, { kind: 'scan', title: 'Über archive active', status: 'processing' }));
    f.store.putJob(job(309, { kind: 'scan', title: "100%_literal \\ ' OR 1=1 --" }));
    const allJobs = vi.spyOn(f.store, 'jobs').mockImplementation(() => {
      throw new Error('Unbounded history read');
    });
    const query = new URLSearchParams({
      kind: 'scan',
      search: '  über ARCHIVE  ',
      limit: '30',
      filter: 'completed',
    });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      if (cursor) query.set('cursor', cursor);
      const page = await listing(query.toString());
      expect(page.total).toBe(65);
      expect(page.offset).toBe(seen.length);
      expect(page.jobs.length).toBeLessThanOrEqual(30);
      seen.push(...page.jobs.map((job) => job.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(Array.from({ length: 65 }, (_, index) => job(65 - index).id));
    expect(allJobs).not.toHaveBeenCalled();
    expect((await listing('kind=scan&search=missing')).total).toBe(0);
    expect((await listing('kind=scan&search=%20%20')).total).toBe(307);
    expect(
      (await listing('kind=scan&search=archive&filter=active')).jobs.map((job) => job.id),
    ).toEqual([job(308).id]);
    for (const search of ['%', '_', "\\ ' OR 1=1 --"])
      expect(
        (await listing(new URLSearchParams({ kind: 'scan', search }).toString())).jobs.map(
          (job) => job.id,
        ),
      ).toEqual([job(309).id]);
    const first = await listing('kind=scan&search=archive&limit=1');
    for (const search of ['', 'Other']) {
      const response = await f.app.inject({
        url: `/api/jobs?${new URLSearchParams({ kind: 'scan', search, cursor: first.nextCursor! })}`,
        headers: f.headers,
      });
      expect(response.statusCode).toBe(400);
    }
    // A maximum-length non-ASCII query still fits in a round-trippable cursor.
    const search = '界'.repeat(200);
    f.store.putJob(job(310, { kind: 'scan', title: search }));
    f.store.putJob(job(311, { kind: 'scan', title: search }));
    const longQuery = new URLSearchParams({ kind: 'scan', search, limit: '1' });
    const longFirst = await listing(longQuery.toString());
    longQuery.set('cursor', longFirst.nextCursor!);
    expect((await listing(longQuery.toString())).jobs[0].id).toBe(job(310).id);
  });

  it('uses ordered indexes for both the mixed history and dedicated scans', async () => {
    f = await fixture();
    for (const [predicate, index] of [
      ['mode=?', 'jobs_history'],
      ["mode=? AND json_extract(data, '$.kind')='scan'", 'jobs_kind_history'],
    ]) {
      const plan = f.store.db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT data FROM jobs WHERE ${predicate} AND (created,id)<(?,?) ORDER BY created DESC,id DESC LIMIT ?`,
        )
        .all('demo', job(1).createdAt, job(1).id, 51);
      expect(plan.some((row) => String(row.detail).includes(index))).toBe(true);
      expect(plan.some((row) => String(row.detail).includes('TEMP B-TREE'))).toBe(false);
    }
  });
});

it('combines device, inclusive/exclusive timestamp bounds, status and title across pages (synthetic history)', async () => {
  f = await fixture();
  const deviceId = randomUUID();
  for (let index = 1; index <= 310; index++) {
    f.store.putJob(
      job(index, {
        kind: 'scan',
        deviceId: index <= 70 ? deviceId : randomUUID(),
        deviceName: 'Removed scanner',
        title: 'Invoice Über',
        createdAt: '2026-03-29T00:00:00.000Z',
        status: index <= 65 ? 'failed' : 'completed',
      }),
    );
  }
  f.store.putJob(
    job(311, {
      kind: 'scan',
      deviceId,
      title: 'Invoice Über',
      status: 'failed',
      createdAt: '2026-03-29T22:00:00.000Z',
      deviceName: 'Latest removed scanner',
    }),
  );
  f.store.putJob(
    job(312, {
      kind: 'scan',
      deviceId,
      title: 'Invoice Über',
      status: 'failed',
      createdAt: '2026-03-28T22:59:59.999Z',
    }),
  );
  f.store.putJob(
    job(313, {
      kind: 'scan',
      deviceId,
      mode: 'hardware',
      title: 'Invoice Über',
      status: 'failed',
      createdAt: '2026-03-29T00:00:00.000Z',
    }),
  );
  const query = new URLSearchParams({
    kind: 'scan',
    deviceId,
    status: 'failed',
    search: 'über',
    from: '2026-03-28T23:00:00Z',
    until: '2026-03-29T22:00:00Z',
    limit: '17',
  });
  const first = await listing(query.toString());
  expect(first.total).toBe(65);
  const seen = first.jobs.map((job) => job.id);
  let cursor = first.nextCursor;
  while (cursor) {
    query.set('cursor', cursor);
    const page = await listing(query.toString());
    expect(page.total).toBe(65);
    expect(page.offset).toBe(seen.length);
    seen.push(...page.jobs.map((job) => job.id));
    cursor = page.nextCursor;
  }
  expect(new Set(seen).size).toBe(65);
  expect(seen).toEqual(Array.from({ length: 65 }, (_, index) => job(65 - index).id));
  query.set('cursor', first.nextCursor!);
  for (const field of ['deviceId', 'status', 'from', 'until']) {
    const changed = new URLSearchParams(query);
    changed.delete(field);
    expect(
      (await f.app.inject({ url: `/api/jobs?${changed}`, headers: f.headers })).statusCode,
    ).toBe(400);
  }
  for (const params of [
    'deviceId=no',
    'status=active',
    'from=2026-02-30T00:00:00Z',
    'until=tomorrow',
    'from=2026-01-02T00:00:00Z&until=2026-01-01T00:00:00Z',
  ])
    expect(
      (await f.app.inject({ url: `/api/jobs?${params}`, headers: f.headers })).statusCode,
    ).toBe(400);
  expect((await listing('status=failed&filter=completed')).total).toBe(0);
  expect((await f.app.inject({ url: '/api/jobs/devices?kind=scan' })).statusCode).toBe(401);
  const devices = (
    await f.app.inject({ url: '/api/jobs/devices?kind=scan', headers: f.headers })
  ).json();
  expect(devices.filter((device: { id: string }) => device.id === deviceId)).toEqual([
    { id: deviceId, name: 'Latest removed scanner' },
  ]);
});

it('renames scan metadata safely, preserves document identity/revision/expiry and rejects stale titles', async () => {
  f = await fixture();
  const filePath = join(f.dataDir, 'retained.pdf');
  const bytes = await pdf();
  await writeFile(filePath, bytes);
  const scan = job(1, {
    kind: 'scan',
    hasFile: true,
    filePath,
    createdAt: new Date().toISOString(),
  });
  f.store.putJob(scan);
  const rename = (title: string, previousTitle = scan.title, id = scan.id, headers = f.headers) =>
    f.app.inject({
      method: 'PATCH',
      url: `/api/scans/${id}/title`,
      headers,
      payload: { title, previousTitle },
    });
  const before = (await f.app.inject({ url: `/api/jobs/${scan.id}`, headers: f.headers })).json();
  const response = await rename('  ../Über invoice <draft>  ');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    title: '../Über invoice <draft>',
    customTitle: true,
    scanRevision: before.scanRevision,
    expiresAt: before.expiresAt,
  });
  expect(f.service.job(scan.id)).toMatchObject({
    filePath,
    createdAt: scan.createdAt,
    scanRevision: scan.updatedAt,
  });
  expect(
    (await f.app.inject({ url: `/api/jobs/${scan.id}/pdf`, headers: f.headers })).rawPayload,
  ).toEqual(bytes);
  expect((await rename('Stale rename')).statusCode).toBe(409);
  for (const title of ['', '   ', 'a'.repeat(121), 'x\u0000y', 'x\ny'])
    expect((await rename(title, '../Über invoice <draft>')).statusCode).toBe(400);
  expect(
    (
      await rename('Unauthorized', '../Über invoice <draft>', scan.id, {
        cookie: '',
        'x-openwebprint': '1',
      })
    ).statusCode,
  ).toBe(401);
  f.store.putJob(job(2, { kind: 'print' }));
  expect((await rename('Print title', job(2).title, job(2).id)).statusCode).toBe(400);
  f.store.putJob(job(3, { kind: 'scan', mode: 'hardware' }));
  expect((await rename('Hardware title', job(3).title, job(3).id)).statusCode).toBe(404);
  f.store.putJob(job(4, { kind: 'scan', status: 'processing' }));
  expect((await rename('Active title', job(4).title, job(4).id)).statusCode).toBe(409);
  const directory = f.dataDir;
  await f.close(false);
  f = await fixture({ dataDir: directory });
  expect((await listing('search=%C3%9Cber')).jobs[0].title).toBe('../Über invoice <draft>');
  const stored = f.service.job(scan.id);
  stored.createdAt = '2020-01-01T00:00:00.000Z';
  f.store.putJob(stored);
  await f.service.expireFiles();
  expect((await rename('Expired but indexed', stored.title)).statusCode).toBe(200);
  expect(
    (await f.app.inject({ url: `/api/jobs/${scan.id}/pdf`, headers: f.headers })).statusCode,
  ).toBe(404);
  await f.service.deleteJob(scan.id);
  expect((await rename('Deleted', 'Expired but indexed')).statusCode).toBe(404);
});
