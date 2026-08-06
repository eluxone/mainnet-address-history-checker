import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'wallet_tool_session';
const MAX_AGE_SECONDS = 60 * 60 * 8;
const LOGIN_BUILD = '2026-08-06.1836';

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

function configuredSecret() {
  const preferred = normalizeSecret(process.env.WALLET_TOOL_PASSWORD);
  if (preferred) return { value: preferred, source: 'WALLET_TOOL_PASSWORD' };
  const legacy = normalizeSecret(process.env.SITE_PASSWORD);
  if (legacy) return { value: legacy, source: 'SITE_PASSWORD' };
  return { value: '', source: null };
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function json(body, status = 200, extraHeaders = {}) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      'X-Login-Build': LOGIN_BUILD,
      ...extraHeaders
    }
  });
}

async function handle(request) {
  const { value: configuredPassword, source } = configuredSecret();

  if (request.method === 'GET') {
    return json({
      ok: true,
      configured: Boolean(configuredPassword),
      source,
      environment: process.env.VERCEL_ENV || 'unknown',
      build: LOGIN_BUILD
    });
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed.', build: LOGIN_BUILD }, 405, { Allow: 'GET, POST' });
  }

  if (!configuredPassword) {
    return json({
      error: 'No website-password environment variable is available to this deployment. Add WALLET_TOOL_PASSWORD or SITE_PASSWORD to Production and redeploy.',
      build: LOGIN_BUILD
    }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'The login request contained invalid JSON.', build: LOGIN_BUILD }, 400);
  }

  const suppliedPassword = normalizeSecret(typeof body?.password === 'string' ? body.password : '');
  if (!safeEqual(suppliedPassword, configuredPassword)) {
    return json({
      error: `Password did not match the ${source} value available to this Production deployment.`,
      build: LOGIN_BUILD,
      environment: process.env.VERCEL_ENV || 'unknown'
    }, 401);
  }

  const expiresAt = Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS;
  const signature = createHmac('sha256', configuredPassword)
    .update(String(expiresAt))
    .digest('base64url');
  const token = `${expiresAt}.${signature}`;
  const cookie = `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${MAX_AGE_SECONDS}`;

  return json({ ok: true, build: LOGIN_BUILD }, 200, { 'Set-Cookie': cookie });
}

export default {
  fetch: handle
};
