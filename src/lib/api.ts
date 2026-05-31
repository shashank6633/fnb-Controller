/**
 * Browser fetch wrapper that auto-injects the CSRF header on state-changing requests.
 * Reads `fnb_csrf` from document.cookie (set by /api/auth/login + middleware).
 *
 * Usage:
 *   import { api } from '@/lib/api';
 *   await api('/api/purchase-orders', { method: 'POST', body: { … } });
 *
 * The 2nd arg is the same as fetch's RequestInit, except `body` may be a plain
 * object (auto-JSON-stringified + Content-Type set).
 */
export type ApiOptions = Omit<RequestInit, 'body'> & { body?: any };

const CSRF_COOKIE = 'fnb_csrf';

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.split('; ').find(c => c.startsWith(name + '='));
  return match ? decodeURIComponent(match.split('=')[1]) : null;
}

function isStateChanging(method?: string): boolean {
  const m = (method || 'GET').toUpperCase();
  return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
}

export async function api(input: string, init: ApiOptions = {}): Promise<Response> {
  const headers = new Headers(init.headers || {});
  const method  = (init.method || 'GET').toUpperCase();

  // Auto-JSON
  let body = init.body;
  if (body && typeof body === 'object' && !(body instanceof FormData) && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
    body = JSON.stringify(body);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  }

  // CSRF
  if (isStateChanging(method)) {
    const token = readCookie(CSRF_COOKIE);
    if (token) headers.set('X-CSRF-Token', token);
  }

  return fetch(input, { ...init, method, headers, body, credentials: 'same-origin' });
}

/** Convenience: api(...).then(r => r.json()) with error throw. */
export async function apiJson<T = any>(input: string, init: ApiOptions = {}): Promise<T> {
  const res = await api(input, init);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}
