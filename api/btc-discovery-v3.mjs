import { authorizeSessionOrApp } from './_auth.mjs';
import crypto from 'node:crypto';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SATOSHIS_PER_BTC = 100_000_000;
const MAX_BODY_BYTES = 16_000;
const MAX_CANDIDATES = 10_000;
const MAX_RESULTS = 100;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_PROVIDER_CONCURRENCY = 2;
const DEFAULT_MAX_BYTES = 25_000_000_000;
const DEFAULT_CANDIDATE_CACHE_DAYS = 30;
const DEFAULT_ADDRESS_CACHE_HOURS = 168;

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

function integer(value, min, max, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new HttpError(400, `${label} must be between ${min} and ${max}.`);
  return n;
}

function number(value, min, max, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${label} must be between ${min} and ${max}.`);
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

async function googleJson(url, options, token, timeoutMs = 60_000) {
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

async function discoverCandidates(account, token, filters) {
  const endpoint = `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(account.projectId)}/queries`;
  const base = { query: buildCandidateQuery(filters), useLegacySql: false, location: 'US' };
  const dry = await googleJson(endpoint, {
    method: 'POST',
    body: JSON.stringify({ ...base, dryRun: true, useQueryCache: false })
  }, token, 30_000);
  const estimatedBytes = Number(dry.totalBytesProcessed || 0);
  const maxBytes = envInteger('BIGQUERY_MAX_DISCOVERY_BYTES', DEFAULT_MAX_BYTES, 10_000_000, 10_000_000_000_000);
  if (estimatedBytes > maxBytes) {
    throw new HttpError(413, `This partition-pruned query is estimated to process ${formatBytes(estimatedBytes)}, above the configured ${formatBytes(maxBytes)} limit. Narrow the date range.`);
  }

  let result = await googleJson(endpoint, {
    method: 'POST',
    body: JSON.stringify({ ...base, timeoutMs: 20_000, maximumBytesBilled: String(maxBytes), useQueryCache: true, maxResults: MAX_CANDIDATES })
  }, token);

  if (!result.jobComplete) {
    const jobId = result.jobReference?.jobId;
    const location = result.jobReference?.location || 'US';
    if (!jobId) throw new HttpError(502, 'BigQuery did not return a job ID.');
    for (let attempt = 0; attempt < 24 && !result.jobComplete; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      result = await googleJson(`${endpoint}/${encodeURIComponent(jobId)}?location=${encodeURIComponent(location)}&timeoutMs=10000&maxResults=${MAX_CANDIDATES}`, { method: 'GET' }, token, 30_000);
    }
    if (!result.jobComplete) throw new HttpError(504, 'BigQuery did not finish before the request deadline.');
  }
  if (result.errors?.length) throw new HttpError(502, result.errors.map((item) => item.message).filter(Boolean).join('; '));
  return result;
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  const n = Number(text);
  const date = Number.isFinite(n) ? new Date(Math.abs(n) >= 1e12 ? n : n * 1000) : new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function decodeCandidates(result) {
  const fields = result.schema?.fields || [];
  return (result.rows || []).map((row) => {
    const record = {};
    fields.forEach((field, index) => { record[field.name] = row.f?.[index]?.v ?? null; });
    return {
      address: String(record.address || ''),
      firstSeen: normalizeTimestamp(record.first_seen),
      receivedSatsInWindow: String(record.received_sats_in_window || '0')
    };
  }).filter((item) => item.address);
}

function formatBytes(value) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return 'unknown bytes';
  let unit = 0;
  while (amount >= 1000 && unit < units.length - 1) { amount /= 1000; unit += 1; }
  return `${amount.toFixed(amount >= 10 || unit === 0 ? 1 : 2)} ${units[unit]}`;
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

async function supabaseRequest(config, path, options = {}) {
  const response = await fetchTimeout(`${config.restUrl}/${path}`, {
    ...options,
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
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

async function getCandidateCache(config, key) {
  const now = encodeURIComponent(new Date().toISOString());
  const rows = await supabaseRequest(config, `btc_candidate_cache?select=search_key,candidates,candidate_count,total_bytes_processed,expires_at&search_key=eq.${key}&expires_at=gt.${now}&limit=1`, { method: 'GET' });
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function saveCandidateCache(config, key, filters, candidates, bytes) {
  const days = envInteger('BTC_CANDIDATE_CACHE_DAYS', DEFAULT_CANDIDATE_CACHE_DAYS, 1, 365);
  await supabaseRequest(config, 'btc_candidate_cache?on_conflict=search_key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{
      search_key: key,
      filters: { startDate: filters.startDate, endDate: filters.endDate, minBalanceSats: filters.minBalanceSats, candidateLimit: filters.candidateLimit, version: 3 },
      candidates,
      candidate_count: candidates.length,
      total_bytes_processed: String(bytes || 0),
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + days * 86400000).toISOString()
    }])
  });
}

function inFilter(values) {
  return encodeURIComponent(`in.(${values.map((value) => `"${String(value).replaceAll('"', '')}"`).join(',')})`);
}

async function getAddressCache(config, addresses) {
  if (!addresses.length) return new Map();
  const hours = envInteger('BTC_ADDRESS_CACHE_HOURS', DEFAULT_ADDRESS_CACHE_HOURS, 1, 8760);
  const cutoff = encodeURIComponent(new Date(Date.now() - hours * 3600000).toISOString());
  const rows = await supabaseRequest(config, `btc_address_cache?select=address,first_seen,last_activity,balance_sats,tx_count,checked_at&address=${inFilter(addresses)}&checked_at=gte.${cutoff}`, { method: 'GET' });
  return new Map((rows || []).map((row) => [row.address, row]));
}

async function saveAddressCache(config, rows) {
  if (!rows.length) return;
  await supabaseRequest(config, 'btc_address_cache?on_conflict=address', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows.map((row) => ({
      address: row.address,
      first_seen: row.firstSeen,
      last_activity: row.lastActivity,
      balance_sats: String(row.balanceSats),
      tx_count: row.txCount,
      checked_at: row.checkedAt,
      source: row.source
    })))
  });
}

function providerBases(address) {
  const configured = process.env.BTC_ESPLORA_BASE_URL?.trim().replace(/\/$/, '');
  const providers = [
    configured ? { name: 'configured-esplora', base: configured } : null,
    { name: 'mempool.space', base: 'https://mempool.space/api' },
    { name: 'blockstream.info', base: 'https://blockstream.info/api' }
  ].filter(Boolean);
  const unique = providers.filter((provider, index, all) => all.findIndex((item) => item.base === provider.base) === index);
  if (unique.length < 2) return unique;
  const start = address.charCodeAt(address.length - 1) % unique.length;
  return [...unique.slice(start), ...unique.slice(0, start)];
}

function retryDelay(response, attempt) {
  const retryAfter = Number(response?.headers?.get?.('retry-after'));
  const fromHeader = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
  const exponential = 700 * (2 ** attempt) + Math.floor(Math.random() * 250);
  return Math.min(6000, Math.max(fromHeader, exponential));
}

async function fetchJsonRetry(url, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response;
    try {
      response = await fetchTimeout(url, { headers: { Accept: 'application/json' } }, 18_000);
      if (response.ok) return await response.json();
      lastError = new Error(`Public Bitcoin API returned ${response.status}.`);
      if (response.status !== 429 && response.status < 500) throw lastError;
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt)));
  }
  throw lastError || new Error('Public Bitcoin API failed.');
}

async function checkWithProvider(candidate, provider) {
  const address = encodeURIComponent(candidate.address);
  const summary = await fetchJsonRetry(`${provider.base}/address/${address}`);
  const txs = await fetchJsonRetry(`${provider.base}/address/${address}/txs`);
  const chain = summary?.chain_stats || {};
  const latest = Array.isArray(txs) ? txs.find((tx) => tx?.status?.confirmed && tx.status.block_time) : null;
  return {
    address: candidate.address,
    firstSeen: candidate.firstSeen,
    lastActivity: latest?.status?.block_time ? new Date(Number(latest.status.block_time) * 1000).toISOString() : null,
    balanceSats: Math.max(0, Number(chain.funded_txo_sum || 0) - Number(chain.spent_txo_sum || 0)),
    txCount: Number(chain.tx_count || 0),
    checkedAt: new Date().toISOString(),
    source: provider.name
  };
}

async function checkAddress(candidate) {
  let lastError;
  for (const provider of providerBases(candidate.address)) {
    try {
      return await checkWithProvider(candidate, provider);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('All public Bitcoin providers failed.');
}

async function mapLimit(items, limit, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

function cachedAddress(candidate, row) {
  return {
    address: candidate.address,
    firstSeen: candidate.firstSeen || row.first_seen || null,
    lastActivity: row.last_activity || null,
    balanceSats: Number(row.balance_sats || 0),
    txCount: Number(row.tx_count || 0),
    checkedAt: row.checked_at,
    source: 'supabase-cache'
  };
}

function inactiveDays(timestamp) {
  if (!timestamp) return null;
  const time = new Date(timestamp).getTime();
  return Number.isFinite(time) ? Math.max(0, Math.floor((Date.now() - time) / 86400000)) : null;
}

function selectResults(rows, filters) {
  const matches = rows.filter(Boolean).map((row) => ({ ...row, inactiveDays: inactiveDays(row.lastActivity) })).filter((row) =>
    row.inactiveDays !== null && row.balanceSats >= filters.minBalanceSats && row.balanceSats <= filters.maxBalanceSats && row.inactiveDays >= filters.minInactiveDays
  );
  matches.sort((a, b) => {
    if (filters.sort === 'balance_desc') return b.balanceSats - a.balanceSats || b.inactiveDays - a.inactiveDays;
    if (filters.sort === 'oldest_first') return String(a.firstSeen || '').localeCompare(String(b.firstSeen || ''));
    return b.inactiveDays - a.inactiveDays || b.balanceSats - a.balanceSats;
  });
  return matches.slice(0, filters.target).map((row) => ({
    address: row.address,
    firstSeen: row.firstSeen,
    lastActivity: row.lastActivity,
    balanceSats: String(row.balanceSats),
    balanceBtc: String(row.balanceSats / SATOSHIS_PER_BTC),
    inactiveDays: row.inactiveDays,
    activityRecords: row.txCount,
    source: row.source
  }));
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return send(response, 405, { error: 'Method not allowed.' });
  }

  try { await authorizeSessionOrApp(request); } catch (error) {
    return send(response, error.status || 401, { error: error.message || 'Authentication required.' });
  }

  const account = parseServiceAccount();
  const supabase = parseSupabase();
  if (!account) return send(response, 503, { error: 'Google BigQuery credentials are missing or invalid.' });
  if (!supabase) return send(response, 503, { error: 'Supabase URL/key are missing or invalid.' });

  try {
    const body = await readBody(request);
    const startDate = validDate(body.startDate, 'Start date');
    const endDate = validDate(body.endDate, 'End date');
    if (startDate > endDate) throw new HttpError(400, 'Start date must be on or before end date.');
    if (startDate < '2009-01-03') throw new HttpError(400, 'Start date cannot precede the Bitcoin genesis block.');

    const minBtc = number(body.minBalanceBtc, 0, 21_000_000, 'Minimum BTC');
    const maxBtc = number(body.maxBalanceBtc, 0, 21_000_000, 'Maximum BTC');
    if (minBtc > maxBtc) throw new HttpError(400, 'Minimum BTC cannot exceed maximum BTC.');

    const filters = {
      startDate,
      endDate,
      minBalanceSats: Math.round(minBtc * SATOSHIS_PER_BTC),
      maxBalanceSats: Math.round(maxBtc * SATOSHIS_PER_BTC),
      minInactiveDays: integer(body.minInactiveDays, 0, 10_000, 'Minimum inactive days'),
      target: integer(body.target, 1, MAX_RESULTS, 'Target results'),
      candidateLimit: integer(body.candidateLimit, 10, MAX_CANDIDATES, 'Candidate limit'),
      offset: integer(body.offset ?? 0, 0, MAX_CANDIDATES, 'Candidate offset'),
      sort: ['inactive_desc', 'balance_desc', 'oldest_first'].includes(body.sort) ? body.sort : 'inactive_desc'
    };

    const key = searchKey(filters);
    let candidateCache = await getCandidateCache(supabase, key);
    let candidates;
    let bigQueryBytesProcessed = 0;
    let candidateCacheHit = Boolean(candidateCache);

    if (candidateCache) {
      candidates = Array.isArray(candidateCache.candidates) ? candidateCache.candidates : [];
    } else {
      const token = await googleAccessToken(account);
      const result = await discoverCandidates(account, token, filters);
      candidates = decodeCandidates(result);
      bigQueryBytesProcessed = Number(result.totalBytesProcessed || 0);
      await saveCandidateCache(supabase, key, filters, candidates, bigQueryBytesProcessed);
      candidateCacheHit = false;
    }

    if (filters.offset > candidates.length) throw new HttpError(400, 'Candidate offset is beyond the cached candidate list.');

    const batchSize = envInteger('BTC_ESPLORA_BATCH_SIZE', DEFAULT_BATCH_SIZE, 10, 50);
    const concurrency = envInteger('BTC_PROVIDER_CONCURRENCY', DEFAULT_PROVIDER_CONCURRENCY, 1, 4);
    const batch = candidates.slice(filters.offset, filters.offset + batchSize);
    const addressCache = await getAddressCache(supabase, batch.map((item) => item.address));
    const fresh = [];
    const failedAddresses = [];

    const enriched = await mapLimit(batch, concurrency, async (candidate) => {
      const cached = addressCache.get(candidate.address);
      if (cached) return cachedAddress(candidate, cached);
      try {
        const row = await checkAddress(candidate);
        fresh.push(row);
        return row;
      } catch {
        failedAddresses.push(candidate.address);
        return null;
      }
    });

    await saveAddressCache(supabase, fresh);

    const providerErrors = failedAddresses.length;
    const retryRequired = providerErrors > 0;
    const completedOffset = Math.min(candidates.length, filters.offset + batch.length);
    const nextOffset = retryRequired ? filters.offset : completedOffset;

    return send(response, 200, {
      results: selectResults(enriched, filters),
      searchKey: key,
      candidateCount: candidates.length,
      candidatesCheckedThisBatch: batch.length - providerErrors,
      batchSize: batch.length,
      checkedFrom: filters.offset,
      nextOffset,
      completedOffset,
      hasMore: retryRequired || completedOffset < candidates.length,
      retryRequired,
      bigQueryBytesProcessed: String(bigQueryBytesProcessed),
      candidateCacheHit,
      addressCacheHits: addressCache.size,
      providerChecks: fresh.length,
      providerErrors,
      providerStrategy: 'mempool.space + blockstream.info fallback',
      queryMode: 'partition-pruned transactions.block_timestamp_month',
      checkedAt: new Date().toISOString(),
      disclaimer: 'Public blockchain analytics only. Results do not establish ownership, abandonment, accessibility or permission to spend funds.'
    });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : error?.name === 'AbortError' ? 504 : 502;
    return send(response, status, {
      error: error?.name === 'AbortError' ? 'A public-data provider timed out.' : error?.message || 'Unable to search public Bitcoin data.'
    });
  }
}
