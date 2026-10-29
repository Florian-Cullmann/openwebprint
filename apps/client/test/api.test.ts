import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publicErrorBody } from '@openwebprint/shared';
import { api, ApiError, documentData, post, STATUS_REQUEST_TIMEOUT_MS } from '../src/api.js';

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
  it('keeps lost responses uncertain and replaces network diagnostics with a safe message', async () => {
    fetchMock.mockRejectedValue(new TypeError('private backend or network diagnostics'));
    await expect(post('/print')).rejects.toMatchObject({
      status: 0,
      message: 'Unable to reach the server. Check your connection and try again.',
    });
  });
  it('preserves intentional request cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockRejectedValue(controller.signal.reason);
    await expect(api('/snapshot', { signal: controller.signal })).rejects.toBe(
      controller.signal.reason,
    );
  });

  it('preserves useful application errors and their HTTP status', async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { ...publicErrorBody('Choose a file.'), error: 'private backend diagnostics' },
        { status: 400 },
      ),
    );
    await expect(api('/print')).rejects.toMatchObject({
      status: 400,
      message: 'Choose a file.',
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
    [500, '{"error":"private backend diagnostics"}', 'application/json'],
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

describe('bounded status reads (stubbed transport)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(['headers', 'body', 'error body'])(
    'times out stalled %s and permits the next read',
    async (stage) => {
      fetchMock.mockImplementationOnce(async () => {
        if (stage === 'headers') return new Promise<Response>(() => {});
        return new Response(new ReadableStream(), { status: stage === 'error body' ? 502 : 200 });
      });
      const pending = api('/snapshot');
      const failed = expect(pending).rejects.toMatchObject({
        status: 0,
        message: 'The server took too long to respond. Check your connection.',
      });
      await vi.advanceTimersByTimeAsync(STATUS_REQUEST_TIMEOUT_MS);
      await failed;
      expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
      fetchMock.mockResolvedValueOnce(Response.json({ recovered: true }));
      await expect(api('/snapshot')).resolves.toEqual({ recovered: true });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('preserves caller cancellation while consuming a stalled body and removes its listener', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream()));
    const pending = api('/snapshot', { signal: controller.signal });
    const failed = expect(pending).rejects.toBeInstanceOf(DOMException);
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await failed;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['/print', '/scans'])('does not time out or retry submission %s', async (path) => {
    let complete!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    const pending = post(path, {});
    await vi.advanceTimersByTimeAsync(STATUS_REQUEST_TIMEOUT_MS * 2);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    complete(Response.json({ accepted: true }));
    await expect(pending).resolves.toEqual({ accepted: true });
  });
});
