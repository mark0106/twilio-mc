import { getIdToken } from './auth.js';

// All backend routes live under /api/** so Firebase Hosting's cleanUrls
// doesn't intercept paths like /sends and serve the matching static page.
export const API_BASE = '/api';

export async function apiFetch(path, { method = 'GET', body, headers = {} } = {}) {
  const token = await getIdToken();
  const url = path.startsWith('/api/') || path.startsWith('http')
    ? path
    : API_BASE + path;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    data = await res.json();
  }
  if (!res.ok) {
    const err = new Error(data?.error || `request_failed_${res.status}`);
    err.status = res.status;
    err.details = data;
    throw err;
  }
  return data;
}
