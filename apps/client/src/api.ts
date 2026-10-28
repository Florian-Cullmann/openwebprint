import { publicMessageText } from '@openwebprint/shared';
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await request(path, init);
  return (await response.json()) as T;
}
export async function documentData(path: string, init: RequestInit = {}): Promise<Uint8Array> {
  const response = await request(path, init);
  return new Uint8Array(await response.arrayBuffer());
}
export async function downloadBlob(path: string, init: RequestInit = {}): Promise<Blob> {
  const response = await request(path, init);
  return response.blob();
}
async function request(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('x-openwebprint', '1');
  if (init.body && !(init.body instanceof FormData))
    headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { ...init, headers, credentials: 'same-origin' });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ApiError(0, 'Unable to reach the server. Check your connection and try again.');
  }
  if (!response.ok) {
    if (response.status === 401 && path !== '/login')
      window.dispatchEvent(new Event('owp:unauthorized'));
    const data: unknown = await response.json().catch(() => undefined);
    const message =
      data !== null && typeof data === 'object' && 'code' in data
        ? publicMessageText(data.code, 'params' in data ? data.params : {})
        : `The request failed (HTTP ${response.status}).`;
    throw new ApiError(response.status, message);
  }
  return response;
}
export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
