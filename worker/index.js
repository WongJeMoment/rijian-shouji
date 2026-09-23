const encoder = new TextEncoder();
const decoder = new TextDecoder();
const allowedOrigins = new Set(['https://wongjemoment.github.io']);

function hexBytes(value) { return Uint8Array.from(value.match(/../g) || [], part => parseInt(part, 16)); }
function sameBytes(a, b) { if (a.length !== b.length) return false; let result = 0; for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i]; return result === 0; }
function base64url(bytes) { let text = ''; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function fromBase64url(value) { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0)); }
function corsOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  if (origin === new URL(request.url).origin || allowedOrigins.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return origin;
  return null;
}
function response(request, data, status = 200) {
  const origin = corsOrigin(request);
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (origin) { headers['Access-Control-Allow-Origin'] = origin; headers.Vary = 'Origin'; }
  return new Response(JSON.stringify(data), { status, headers });
}
async function hmacKey(env) { return crypto.subtle.importKey('raw', hexBytes(env.TOKEN_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
async function tokenFor(env) {
  const payload = base64url(encoder.encode(JSON.stringify({ exp: Date.now() + 12 * 60 * 60 * 1000, nonce: crypto.randomUUID() })));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(env), encoder.encode(payload));
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}
async function authorized(request, env) {
  const value = request.headers.get('Authorization') || '';
  if (!value.startsWith('Bearer ')) return false;
  try {
    const [payload, signature] = value.slice(7).split('.');
    if (!payload || !signature) return false;
    const claims = JSON.parse(decoder.decode(fromBase64url(payload)));
    if (!Number.isFinite(claims.exp) || claims.exp < Date.now()) return false;
    return crypto.subtle.verify('HMAC', await hmacKey(env), fromBase64url(signature), encoder.encode(payload));
  } catch { return false; }
}
async function ipKey(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(env.TOKEN_SECRET + ip));
  return `auth/${Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')}.json`;
}
async function authenticate(request, env) {
  if (!env.ARCHIVE || !env.PASSWORD_SALT || !env.PASSWORD_HASH || !env.TOKEN_SECRET) return response(request, { error: 'cloud_not_configured' }, 503);
  const throttleKey = await ipKey(request, env);
  const previous = await env.ARCHIVE.get(throttleKey);
  const attempts = previous ? await previous.json() : { count: 0, until: 0 };
  if (attempts.count >= 8 && attempts.until > Date.now()) return response(request, { error: 'too_many_attempts' }, 429);
  let password;
  try { password = (await request.json()).password; } catch { return response(request, { error: 'bad_request' }, 400); }
  if (typeof password !== 'string' || password.length > 200) return response(request, { error: 'bad_request' }, 400);
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: hexBytes(env.PASSWORD_SALT), iterations: 100000, hash: 'SHA-256' }, keyMaterial, 256));
  if (!sameBytes(derived, hexBytes(env.PASSWORD_HASH))) {
    await env.ARCHIVE.put(throttleKey, JSON.stringify({ count: attempts.until > Date.now() ? attempts.count + 1 : 1, until: Date.now() + 15 * 60 * 1000 }));
    return response(request, { error: 'wrong_password' }, 401);
  }
  await env.ARCHIVE.delete(throttleKey);
  return response(request, { token: await tokenFor(env) });
}
function entryId(pathname) { const match = pathname.match(/^\/api\/entries\/([a-f0-9-]{36})$/i); return match?.[1] || null; }
async function listEntries(request, env) {
  const entries = []; let cursor;
  do {
    const page = await env.ARCHIVE.list({ prefix: 'entries/', cursor });
    for (const item of page.objects) {
      const object = await env.ARCHIVE.get(item.key);
      if (object) entries.push(await object.json());
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return response(request, { entries });
}
async function putEntry(request, env, id) {
  const size = Number(request.headers.get('Content-Length') || 0);
  if (size > 50 * 1024 * 1024) return response(request, { error: 'too_large' }, 413);
  let row;
  try { row = await request.json(); } catch { return response(request, { error: 'bad_request' }, 400); }
  if (row?.id !== id || typeof row.iv !== 'string' || typeof row.data !== 'string' || row.iv.length > 100 || row.data.length > 50 * 1024 * 1024 || !/^[A-Za-z0-9+/=]+$/.test(row.iv + row.data)) return response(request, { error: 'bad_request' }, 400);
  await env.ARCHIVE.put(`entries/${id}.json`, JSON.stringify({ id, iv: row.iv, data: row.data }), { httpMetadata: { contentType: 'application/json' } });
  return response(request, { saved: true });
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    if (request.method === 'OPTIONS') {
      if (!corsOrigin(request)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': corsOrigin(request), 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' } });
    }
    try {
      if (url.pathname === '/api/auth' && request.method === 'POST') return await authenticate(request, env);
      if (!await authorized(request, env)) return response(request, { error: 'unauthorized' }, 401);
      if (url.pathname === '/api/entries' && request.method === 'GET') return await listEntries(request, env);
      const id = entryId(url.pathname);
      if (id && request.method === 'PUT') return await putEntry(request, env, id);
      if (id && request.method === 'DELETE') { await env.ARCHIVE.delete(`entries/${id}.json`); return response(request, { deleted: true }); }
      return response(request, { error: 'not_found' }, 404);
    } catch (error) { console.error(error); return response(request, { error: 'server_error' }, 500); }
  },
};
