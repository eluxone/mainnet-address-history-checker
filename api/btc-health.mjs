function send(response, status, payload) {
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  return response.status(status).json(payload);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function safeUrlSummary(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function normalizeSupabaseRestUrl(value) {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return null;
    let path = parsed.pathname.replace(/\/+$/, '');
    if (!path || path === '/') path = '/rest/v1';
    else if (!path.endsWith('/rest/v1')) path = `${path}/rest/v1`;
    parsed.pathname = path;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

async function checkSupabase() {
  const rawUrl = process.env.SUPABASE_URL?.trim();
  const restUrl = normalizeSupabaseRestUrl(rawUrl);
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!rawUrl || !key) {
    return { ok: false, reason: 'SUPABASE_URL or server key is missing.' };
  }
  if (!restUrl) {
    return { ok: false, reason: 'SUPABASE_URL must be a valid https URL.' };
  }

  try {
    const response = await fetchWithTimeout(`${restUrl}/btc_candidate_cache?select=search_key&limit=1`, {
      method: 'GET',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: 'application/json'
      }
    });
    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();
    const looksHtml = /^\s*<!doctype html|^\s*<html/i.test(text);

    if (looksHtml) {
      return {
        ok: false,
        reason: 'SUPABASE_URL returned an HTML webpage instead of the Supabase REST API. Use the project URL or Data API URL.',
        host: safeUrlSummary(rawUrl),
        status: response.status
      };
    }

    if (!response.ok) {
      let detail = '';
      try {
        const body = JSON.parse(text || '{}');
        detail = body.message || body.hint || body.code || '';
      } catch {}
      return {
        ok: false,
        reason: detail || `Supabase REST API returned HTTP ${response.status}.`,
        host: safeUrlSummary(rawUrl),
        status: response.status,
        contentType
      };
    }

    return { ok: true, host: safeUrlSummary(rawUrl), status: response.status };
  } catch (error) {
    return { ok: false, reason: error?.message || 'Supabase connection failed.', host: safeUrlSummary(rawUrl) };
  }
}

async function checkProvider(name, baseUrl) {
  try {
    const response = await fetchWithTimeout(`${baseUrl.replace(/\/$/, '')}/blocks/tip/height`, {
      headers: { Accept: 'text/plain' }
    });
    const text = await response.text();
    if (!response.ok) {
      return { name, ok: false, status: response.status, reason: `HTTP ${response.status}` };
    }
    if (!/^\d+\s*$/.test(text)) {
      return { name, ok: false, status: response.status, reason: 'Unexpected response format.' };
    }
    return { name, ok: true, status: response.status };
  } catch (error) {
    return { name, ok: false, reason: error?.message || 'Connection failed.' };
  }
}

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return send(response, 405, { error: 'Method not allowed.' });
  }

  const [supabase, mempool, blockstream] = await Promise.all([
    checkSupabase(),
    checkProvider('mempool.space', 'https://mempool.space/api'),
    checkProvider('blockstream.info', 'https://blockstream.info/api')
  ]);

  return send(response, 200, {
    ok: Boolean(supabase.ok && (mempool.ok || blockstream.ok)),
    supabase,
    publicBitcoinApis: [mempool, blockstream],
    bigQueryCredentialsPresent: Boolean(
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
      (process.env.GOOGLE_CLOUD_PROJECT_ID && process.env.GOOGLE_CLOUD_CLIENT_EMAIL && process.env.GOOGLE_CLOUD_PRIVATE_KEY)
    ),
    bigQueryMaxDiscoveryBytes: process.env.BIGQUERY_MAX_DISCOVERY_BYTES || 'default',
    note: 'No secret values are returned by this endpoint.'
  });
}
