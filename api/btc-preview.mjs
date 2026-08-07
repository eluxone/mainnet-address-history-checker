import { authorizeSessionOrApp } from './_auth.mjs';
import crypto from 'node:crypto';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SATOSHIS_PER_BTC = 100_000_000;
const MAX_BODY_BYTES = 16_000;
const MAX_CANDIDATES = 10_000;
const DEFAULT_MAX_BYTES = 25_000_000_000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(response, status, payload) {
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  return response.status(status).json(payload);
}

function safeTokenEqual(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readBody(request) {
  if (request.body && typeof request.body === 'object') return request.body;
  if (typeof request.body === 'string') {
    if (Buffer.byteLength(request.body) > MAX_BODY_BYTES) throw new HttpError(400, 'Request body is too large.');
    return JSON.parse(request.body || '{}');
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new HttpError(400, 'Request body is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function validDate(value, label) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) throw new HttpError(400, `${label} is invalid.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new HttpError(400, `${label} is invalid.`);
  return value;
}

function number(value, min, max, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${label} must be between ${min} and ${max}.`);
  return n;
}

function integer(value, min, max, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new HttpError(400, `${label} must be between ${min} and ${max}.`);
  return n;
}

function envInteger(name, fallback, min, max) {
  const n = Number(process.env[name]);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
}

function normalizePrivateKey(value) {
  return typeof value === 'string' ? value.replace(/\\n/g, '\n') : value;
}

function serviceAccountFromObject(value) {
  if (!value?.project_id || !value?.client_email || !value?.private_key) return null;
  return {
    projectId: String(value.project_id),
    clientEmail: String(value.client_email),
    privateKey: normalizePrivateKey(String(value.private_key))
  };
}

function parseServiceAccount() {
  const packed = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (packed) {
    const candidates = [packed];
    try { candidates.push(Buffer.from(packed, 'base64').toString('utf8')); } catch {}
    for (const candidate of candidates) {
      try {
        const account = serviceAccountFromObject(JSON.parse(candidate));
        if (account) return account;
      } catch {}
    }
  }
  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID || process.env.GCP_PROJECT_ID;
  const clientEmail = process.env.GOOGLE_CLOUD_CLIENT_EMAIL || process.env.GCP_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_CLOUD_PRIVATE_KEY || process.env.GCP_PRIVATE_KEY;
  return projectId && clientEmail && privateKey
    ? { projectId, clientEmail, privateKey: normalizePrivateKey(privateKey) }
    : null;
}

function normalizeSupabaseRestUrl(value) {
  try {
    const parsed = new URL(value?.trim());
    if (parsed.protocol !== 'https:') return null;
    let path = parsed.pathname.replace(/\/+$/, '');
    if (!path || path === '/') path = '/rest/v1';
    else if (!path.endsWith('/rest/v1')) path += '/rest/v1';
    parsed.pathname = path;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function parseSupabase() {
  const restUrl = normalizeSupabaseRestUrl(process.env.SUPABASE_URL);
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  return restUrl && key ? { restUrl, key } : null;
}

async function fetchTimeout(url, options = {}, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function supabaseRequest(config, path) {
  const response = await fetchTimeout(`${config.restUrl}/${path}`, {
    method: 'GET',
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      Accept: 'application/json'
    }
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch { throw new HttpError(502, `Supabase returned a non-JSON response (${response.status}).`); }
  }
  if (!response.ok) throw new HttpError(502, data?.message || data?.hint || data?.code || `Supabase request failed (${response.status}).`);
  return data;
}

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

async function googleAccessToken(account) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: account.clientEmail,
    scope: 'https://www.googleapis.com/auth/bigquery',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3000
  }));
  const unsigned = `${header}.${claims}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), account.privateKey).toString('base64url');
  const response = await fetchTimeout('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new HttpError(502, data.error_description || 'Google authentication failed.');
  return data.access_token;
}

async function googleJson(url, options, token, timeoutMs = 30_000) {
  const response = await fetchTimeout(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  }, timeoutMs);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpError(502, data?.error?.message || `BigQuery request failed (${response.status}).`);
  return data;
}

function monthStart(date) {
  return `${date.slice(0, 7)}-01`;
}

function buildCandidateQuery(filters) {
  const startMonth = monthStart(filters.startDate);
  const endMonth = monthStart(filters.endDate);
  return `
SELECT
  address,
  MIN(t.block_timestamp) AS first_seen,
  SUM(output.value) AS received_sats_in_window
FROM \`bigquery-public-data.crypto_bitcoin.transactions\` AS t
CROSS JOIN UNNEST(t.outputs) AS output
CROSS JOIN UNNEST(output.addresses) AS address
WHERE t.block_timestamp_month BETWEEN DATE '${startMonth}' AND DATE '${endMonth}'
  AND t.block_timestamp >= TIMESTAMP('${filters.startDate}T00:00:00Z')
  AND t.block_timestamp < TIMESTAMP_ADD(TIMESTAMP('${filters.endDate}T00:00:00Z'), INTERVAL 1 DAY)
  AND address IS NOT NULL
  AND address != ''
  AND LENGTH(address) BETWEEN 26 AND 90
GROUP BY address
HAVING SUM(output.value) >= ${filters.minBalanceSats}
ORDER BY first_seen ASC, received_sats_in_window DESC
LIMIT ${filters.candidateLimit}
`;
}

function searchKey(filters) {
  return crypto.createHash('sha256').update(JSON.stringify({
    version: 3,
    source: 'transactions-block_timestamp_month',
    startDate: filters.startDate,
    endDate: filters.endDate,
    minBalanceSats: filters.minBalanceSats,
    candidateLimit: filters.candidateLimit
  })).digest('hex');
}

function parseFilters(body) {
  const startDate = validDate(body.startDate, 'Start date');
  const endDate = validDate(body.endDate, 'End date');
  if (startDate > endDate) throw new HttpError(400, 'Start date must be on or before end date.');
  if (startDate < '2009-01-03') throw new HttpError(400, 'Start date cannot precede the Bitcoin genesis block.');
  const minBtc = number(body.minBalanceBtc, 0, 21_000_000, 'Minimum BTC');
  const maxBtc = number(body.maxBalanceBtc, 0, 21_000_000, 'Maximum BTC');
  if (minBtc > maxBtc) throw new HttpError(400, 'Minimum BTC cannot exceed maximum BTC.');
  return {
    startDate,
    endDate,
    minBalanceSats: Math.round(minBtc * SATOSHIS_PER_BTC),
    candidateLimit: integer(body.candidateLimit, 10, MAX_CANDIDATES, 'Candidate limit')
  };
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return send(response, 405, { error: 'Method not allowed.' });
  }

  try { await authorizeSessionOrApp(request); } catch (error) {
    return send(response, error.status || 401, { error: error.message || 'Authentication required.' });
  }

  const supabase = parseSupabase();
  if (!supabase) return send(response, 503, { error: 'Supabase URL/key are missing or invalid.' });

  try {
    const body = await readBody(request);
    const filters = parseFilters(body);
    const key = searchKey(filters);
    const now = encodeURIComponent(new Date().toISOString());
    const rows = await supabaseRequest(
      supabase,
      `btc_candidate_cache?select=search_key,candidate_count,total_bytes_processed,expires_at&search_key=eq.${key}&expires_at=gt.${now}&limit=1`
    );
    const cached = Array.isArray(rows) && rows.length ? rows[0] : null;
    const maxBytes = envInteger('BIGQUERY_MAX_DISCOVERY_BYTES', DEFAULT_MAX_BYTES, 10_000_000, 10_000_000_000_000);

    if (cached) {
      return send(response, 200, {
        allowed: true,
        candidateCacheHit: true,
        candidateCount: Number(cached.candidate_count || 0),
        estimatedBytes: '0',
        maxBytes: String(maxBytes),
        percentOfLimit: 0,
        bigQueryRequired: false,
        previousDiscoveryBytes: String(cached.total_bytes_processed || '0'),
        expiresAt: cached.expires_at,
        searchKey: key,
        note: 'Candidate list is already cached. Starting this search does not require a new BigQuery discovery query.'
      });
    }

    const account = parseServiceAccount();
    if (!account) return send(response, 503, { error: 'Google BigQuery credentials are missing or invalid.' });
    const token = await googleAccessToken(account);
    const endpoint = `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(account.projectId)}/queries`;
    const dry = await googleJson(endpoint, {
      method: 'POST',
      body: JSON.stringify({
        query: buildCandidateQuery(filters),
        useLegacySql: false,
        location: 'US',
        dryRun: true,
        useQueryCache: false
      })
    }, token);
    const estimatedBytes = Number(dry.totalBytesProcessed || 0);
    const allowed = estimatedBytes <= maxBytes;

    return send(response, 200, {
      allowed,
      candidateCacheHit: false,
      candidateCount: null,
      estimatedBytes: String(estimatedBytes),
      maxBytes: String(maxBytes),
      percentOfLimit: maxBytes > 0 ? Number(((estimatedBytes / maxBytes) * 100).toFixed(2)) : 0,
      bigQueryRequired: true,
      previousDiscoveryBytes: null,
      expiresAt: null,
      searchKey: key,
      note: allowed
        ? 'Dry run complete. The estimated query is within the configured safety limit.'
        : 'Dry run complete. The estimated query exceeds the configured safety limit and will remain blocked.'
    });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : error?.name === 'AbortError' ? 504 : 502;
    return send(response, status, {
      error: error?.name === 'AbortError' ? 'The cost preview timed out.' : error?.message || 'Unable to preview BTC search cost.'
    });
  }
}
