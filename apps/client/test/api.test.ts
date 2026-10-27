import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, documentData, post } from '../src/api.js';

const fetchMock = vi.fn<typeof fetch>();
let unauthorized: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  const events = new EventTarget();
  unauthorized = vi.fn();
  events.addEventListener('owp:unauthorized', unauthorized);
  vi.stubGlobal('window', events);
});
afterEach(() => vi.unstubAllGlobals());

describe('API response errors', () => {
  it('preserves useful application errors and their HTTP status', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: 'Choose a connected printer.' }, { status: 400 }),
    );
    await expect(api('/print')).rejects.toMatchObject({
      status: 400,
      message: 'Choose a connected printer.',
    });
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it.each([
    [502, '<html>Private proxy diagnostics</html>', 'text/html'],
    [503, '', 'text/plain'],
    [500, '{"error":', 'application/json'],
    [502, 'Private proxy diagnostics', 'text/plain'],
    [400, 'null', 'application/json'],
    [400, '{"error":{"private":"details"}}', 'application/json'],
    [400, '{"error":"  "}', 'application/json'],
    [400, '{}', 'application/json'],
  ])('uses a safe HTTP fallback for %i with body %j', async (status, body, contentType) => {
    fetchMock.mockResolvedValue(
      new Response(body, { status, headers: { 'content-type': contentType } }),
    );
    const error = await api('/snapshot').catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status, message: `The request failed (HTTP ${status}).` });
  });

  it.each(['<html>Unauthorized</html>', '', '{"error":', '{"error":"Sign in again."}'])(
    'dispatches unauthorized even when the body is %j',
    async (body) => {
      fetchMock.mockResolvedValue(new Response(body, { status: 401 }));
      await expect(api('/snapshot')).rejects.toBeInstanceOf(ApiError);
      expect(unauthorized).toHaveBeenCalledOnce();
    },
  );

  it('does not dispatch unauthorized for a failed login', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 401 }));
    await expect(post('/login', { username: 'sample', password: 'sample' })).rejects.toMatchObject({
      status: 401,
    });
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it.each(['/print', '/scans'])('does not retry a failed submission to %s', async (path) => {
    fetchMock.mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 }));
    await expect(post(path, {})).rejects.toMatchObject({ status: 502 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('applies the same fallback to document requests', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 503 }));
    await expect(documentData('/jobs/example/document')).rejects.toMatchObject({
      status: 503,
      message: 'The request failed (HTTP 503).',
    });
  });

  it('keeps successful JSON and binary responses readable', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ready: true }));
    await expect(api('/session')).resolves.toEqual({ ready: true });
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    await expect(documentData('/jobs/example/document')).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });
});
