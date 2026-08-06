import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'wallet_tool_session';
const MAX_AGE_SECONDS = 60 * 60 * 8;

function json(response, status = 200, headers = {}) {
  return new Response(JSON.stringify(response), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }
  });
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

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const configuredPassword = normalizeSecret(process.env.SITE_PASSWORD);
  if (!configuredPassword) {
    return json({ error: 'SITE_PASSWORD is not configured in Vercel.' }, 503);
  }

  const body = await request.json().catch(() => ({}));
  const suppliedPassword = normalizeSecret(typeof body.password === 'string' ? body.password : '');
  if (!safeEqual(suppliedPassword, configuredPassword)) {
    return json({ error: 'Incorrect password. Check capitalization and confirm SITE_PASSWORD was saved for the Production environment before the latest deployment.' }, 401, { 'Cache-Control': 'no-store' });
  }

  const expiresAt = Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS;
  const signature = createHmac('sha256', configuredPassword)
    .update(String(expiresAt))
    .digest('base64url');
  const token = `${expiresAt}.${signature}`;
  const cookie = `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${MAX_AGE_SECONDS}`;

  return json({ ok: true }, 200, { 'Set-Cookie': cookie, 'Cache-Control': 'no-store' });
}
