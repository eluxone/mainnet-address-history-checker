const COOKIE_NAME = 'wallet_tool_session';

function parseCookies(header) {
  return Object.fromEntries(
    String(header || '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf('=');
        return separator < 0
          ? [part, '']
          : [part.slice(0, separator), part.slice(separator + 1)];
      })
  );
}

function normalizeSecret(value) {
  let normalized = String(value ?? '').trim();
  if (normalized.length >= 2) {
    const first = normalized[0];
    const last = normalized[normalized.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      normalized = normalized.slice(1, -1).trim();
    }
  }
  return normalized;
}

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

async function sign(value, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return toBase64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

async function validSession(request, secret) {
  const token = parseCookies(request.headers.get('cookie'))[COOKIE_NAME];
  if (!token) return false;

  const separator = token.indexOf('.');
  if (separator < 1) return false;
  const expiresAt = token.slice(0, separator);
  const suppliedSignature = token.slice(separator + 1);
  if (!/^\d+$/u.test(expiresAt) || Number(expiresAt) <= Math.floor(Date.now() / 1000)) return false;

  const expectedSignature = await sign(expiresAt, secret);
  return constantTimeEqual(suppliedSignature, expectedSignature);
}

export default async function middleware(request) {
  const secret = normalizeSecret(process.env.SITE_PASSWORD);
  if (!secret) {
    return new Response('SITE_PASSWORD is not configured.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }

  if (await validSession(request, secret)) return;

  const url = new URL(request.url);
  const loginUrl = new URL('/login.html', url.origin);
  loginUrl.searchParams.set('next', `${url.pathname}${url.search}`);
  return Response.redirect(loginUrl, 307);
}

export const config = {
  matcher: ['/((?!login.html|login.js|styles.css|favicon.ico|api/login).*)']
};
