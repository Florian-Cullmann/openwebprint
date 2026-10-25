export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('x-openwebprint', '1');
  if (init.body && !(init.body instanceof FormData))
    headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api${path}`, { ...init, headers, credentials: 'same-origin' });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/login')
      window.dispatchEvent(new Event('owp:unauthorized'));
    throw new ApiError(response.status, data.error ?? 'Der Vorgang ist fehlgeschlagen.');
  }
  return data as T;
}
export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
