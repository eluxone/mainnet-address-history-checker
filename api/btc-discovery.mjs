import crypto from 'node:crypto';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SATOSHIS_PER_BTC = 100_000_000;
const MAX_BODY_BYTES = 16_000;
const QUERY_POLL_LIMIT = 24;
const QUERY_POLL_MS = 5_000;
const DEFAULT_DISCOVERY_MAX_BYTES = 100_000_000_000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_CANDIDATE_CACHE_DAYS = 30;
const DEFAULT_ADDRESS_CACHE_HOURS = 168;
const MAX_CANDIDATES = 5_000;
const MAX_RESULTS = 100;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function setHeaders(response) {
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('X-Content-Type-Options', 'nosniff');
}

function send(response, status, payload) {
  setHeaders(response);
  return response.status(status).json(payload);
}

function safeTokenEqual(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(received, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

async function readJsonBody(request) {
  if (request.body && typeof request.body === 'object') return request.body;
  if (typeof request.body === 'string') {
    if (Buffer.byteLength(request.body, 'utf8') > MAX_BODY_BYTES) throw new HttpError(400, 'Request body is too large.');
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

function requireInteger(value, min, max, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new HttpError(400, `${label} must be between ${min} and ${max}.`);
  }
  return number;
}

function requireNumber(value, min, max, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new HttpError(400, `${label} must be between ${min} and ${max}.`);
  }
  return number;
}

function parseDate(value, label) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) throw new HttpError(400, `${label} is invalid.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, `${label} is invalid.`);
  }
  return value;
}

function envInteger(name, fallback, min, max) {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function normalizePrivateKey(value) {
  return typeof value === 'string' ? value.replace(/\\n/g, '\n') : value;
}

function serviceAccountFromObject(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) return null;
  return {
    projectId: String(parsed.project_id),
    clientEmail: String(parsed.client_email),
    privateKey: normalizePrivateKey(String(parsed.private_key))
  };
}

function parseServiceAccount() {
  const packed = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (packed) {
    const candidates = new Set([packed]);
    if ((packed.startsWith('"') && packed.endsWith('"')) || (packed.startsWith("'") && packed.endsWith("'"))) {
      candidates.add(packed.slice(1, -1));
    }
    try {
      candidates.add(JSON.parse(packed));
    } catch {
      // Continue with other supported encodings.
    }
    try {
      candidates.add(Buffer.from(packed, 'base64').toString('utf8'));
    } catch {
      // Raw JSON may still be valid.
    }

    for (const candidate of candidates) {
      try {
        const parsed = typeof candidate === 'object' ? candidate : JSON.parse(String(candidate));
        const account = serviceAccountFromObject(parsed);
        if (account) return account;
      } catch {
        // Try the next representation.
      }
    }
  }

  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID || process.env.GCP_PROJECT_ID;
  const clientEmail = process.env.GOOGLE_CLOUD_CLIENT_EMAIL || process.env.GCP_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_CLOUD_PRIVATE_KEY || process.env.GCP_PRIVATE_KEY;
  if (!projectId || !clientEmail || !privateKey) return null;
  return { projectId, clientEmail, privateKey: normalizePrivateKey(privateKey) };
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

function parseSupabase() {
  const restUrl = normalizeSupabaseRestUrl(process.env.SUPABASE_URL);
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!restUrl || !key) return null;
  return { restUrl, key };
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

async function getGoogleAccessToken(serviceAccount) {
  const issuedAt = Math.floor(Date.now() / 1_000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(JSON.stringify({
    iss: serviceAccount.clientEmail,
    scope: 'https://www.googleapis.com/auth/bigquery',
    aud: 'https://oauth2.googleapis.com/token',
    iat: issuedAt,
    exp: issuedAt + 3_000
  }));
  const unsigned = `${header}.${claims}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), serviceAccount.privateKey).toString('base64url');
  const assertion = `${unsigned}.${signature}`;

  const response = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth-type:jwt-bearer'.replace('oauth-type', 'oauth-grant-type'),
      assertion
    })
  }, 20_000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new HttpError(502, data.error_description || data.error || 'Google authentication failed.');
  }
  return data.access_token;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function googleJson(url, options, accessToken, timeoutMs = 60_000) {
  const response = await fetchWithTimeout(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options?.headers || {})
    }
  }, timeoutMs);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new HttpError(502, data?.error?.message || `Google BigQuery request failed (${response.status}).`);
  }
  return data;
}

function namedTimestamp(name, value) {
  return { name, parameterType: { type: 'TIMESTAMP' }, parameterValue: { value } };
}

function namedInt(name, value) {
  return { name, parameterType: { type: 'INT64' }, parameterValue: { value: String(value) } };
}

function candidateQueryParameters(filters) {
  return [
    namedTimestamp('start_timestamp', `${filters.startDate}T00:00:00Z`),
    namedTimestamp('end_timestamp', `${filters.endDate}T00:00:00Z`),
    namedInt('min_received_sats', filters.minBalanceSats),
    namedInt('candidate_limit', filters.candidateLimit)
  ];
}

function buildCandidateQuery() {
  return `
SELECT
  address,
  MIN(o.block_timestamp) AS first_seen,
  SUM(o.value) AS received_sats_in_window
FROM \`bigquery-public-data.crypto_bitcoin.outputs\` AS o
CROSS JOIN UNNEST(o.addresses) AS address
WHERE o.block_timestamp >= @start_timestamp
  AND o.block_timestamp < TIMESTAMP_ADD(@end_timestamp, INTERVAL 1 DAY)
  AND address IS NOT NULL
  AND address != ''
  AND LENGTH(address) BETWEEN 26 AND 90
GROUP BY address
HAVING SUM(o.value) >= @min_received_sats
ORDER BY first_seen ASC, received_sats_in_window DESC
LIMIT @candidate_limit
`;
}

async function runBigQueryCandidateDiscovery(serviceAccount, accessToken, filters) {
  const endpoint = `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(serviceAccount.projectId)}/queries`;
  const query = buildCandidateQuery();
  const baseRequest = {
    query,
    useLegacySql: false,
    parameterMode: 'NAMED',
    queryParameters: candidateQueryParameters(filters),
    location: 'US'
  };

  const dryRun = await googleJson(endpoint, {
    method: 'POST',
    body: JSON.stringify({ ...baseRequest, dryRun: true, useQueryCache: false })
  }, accessToken, 30_000);
  const estimatedBytes = Number(dryRun.totalBytesProcessed || 0);
  const maxBytes = envInteger('BIGQUERY_MAX_DISCOVERY_BYTES', DEFAULT_DISCOVERY_MAX_BYTES, 10_000_000, 10_000_000_000_000);
  if (estimatedBytes > maxBytes) {
    throw new HttpError(
      413,
      `This candidate-discovery query is estimated to process ${formatBytes(estimatedBytes)}, above the configured ${formatBytes(maxBytes)} limit. Narrow the date range before searching.`
    );
  }

  const initial = await googleJson(endpoint, {
    method: 'POST',
    body: JSON.stringify({
      ...baseRequest,
      timeoutMs: 20_000,
      maximumBytesBilled: String(maxBytes),
      useQueryCache: true,
      maxResults: MAX_CANDIDATES
    })
  }, accessToken);

  if (initial.errors?.length) {
    throw new HttpError(502, initial.errors.map((item) => item.message).filter(Boolean).join('; ') || 'BigQuery rejected the query.');
  }
  if (initial.jobComplete) return initial;

  const jobId = initial.jobReference?.jobId;
  const location = initial.jobReference?.location || 'US';
  if (!jobId) throw new HttpError(502, 'BigQuery did not return a query job identifier.');

  for (let attempt = 0; attempt < QUERY_POLL_LIMIT; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, QUERY_POLL_MS));
    const pollUrl = `${endpoint}/${encodeURIComponent(jobId)}?location=${encodeURIComponent(location)}&timeoutMs=10000&maxResults=${MAX_CANDIDATES}`;
    const polled = await googleJson(pollUrl, { method: 'GET' }, accessToken, 30_000);
    if (polled.errors?.length) {
      throw new HttpError(502, polled.errors.map((item) => item.message).filter(Boolean).join('; ') || 'BigQuery query failed.');
    }
    if (polled.jobComplete) return polled;
  }

  throw new HttpError(504, 'The candidate-discovery query did not finish before the Vercel request deadline. Narrow the date range.');
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!text) return null;
  const numeric = Number(text);
  const date = Number.isFinite(numeric)
    ? new Date(Math.abs(numeric) >= 1_000_000_000_000 ? numeric : numeric * 1_000)
    : new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function decodeCandidateRows(result) {
  const fields = result.schema?.fields || [];
  return (result.rows || []).map((row) => {
    const record = {};
    fields.forEach((field, index) => {
      record[field.name] = row.f?.[index]?.v ?? null;
    });
    return {
      address: String(record.address || ''),
      firstSeen: normalizeTimestamp(record.first_seen),
      receivedSatsInWindow: String(record.received_sats_in_window || '0')
    };
  }).filter((item) => item.address);
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown bytes';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1_000 && unit < units.length - 1) {
    amount /= 1_000;
    unit += 1;
  }
  return `${amount.toFixed(amount >= 10 || unit === 0 ? 1 : 2)} ${units[unit]}`;
}

function searchKey(filters) {
  const material = JSON.stringify({
    version: 2,
    startDate: filters.startDate,
    endDate: filters.endDate,
    minBalanceSats: filters.minBalanceSats,
    candidateLimit: filters.candidateLimit
  });
  return crypto.createHash('sha256').update(material).digest('hex');
}

async function supabaseRequest(config, path, options = {}) {
  const response = await fetchWithTimeout(`${config.restUrl}/${path}`, {
    ...options,
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  }, 20_000);
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new HttpError(502, `Supabase cache returned a non-JSON response (HTTP ${response.status}). Check SUPABASE_URL.`);
    }
  }
  if (!response.ok) {
    throw new HttpError(502, data?.message || data?.hint || data?.code || `Supabase cache request failed (${response.status}).`);
  }
  return data;
}

async function getCandidateCache(config, key) {
  const now = new Date().toISOString();
  const path = `btc_candidate_cache?select=search_key,candidates,candidate_count,total_bytes_processed,expires_at&search_key=eq.${key}&expires_at=gt.${encodeURIComponent(now)}&limit=1`;
  const rows = await supabaseRequest(config, path, { method: 'GET' });
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function upsertCandidateCache(config, key, filters, candidates, bytesProcessed) {
  const days = envInteger('BTC_CANDIDATE_CACHE_DAYS', DEFAULT_CANDIDATE_CACHE_DAYS, 1, 365);
  const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
  await supabaseRequest(config, 'btc_candidate_cache?on_conflict=search_key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{
      search_key: key,
      filters,
      candidates,
      candidate_count: candidates.length,
      total_bytes_processed: String(bytesProcessed || 0),
      created_at: new Date().toISOString(),
      expires_at: expiresAt
    }])
  });
}

function postgrestIn(values) {
  return `(${values.map((value) => `"${String(value).replaceAll('"', '')}"`).join(',')})`;
}

async function getAddressCache(config, addresses) {
  if (!addresses.length) return new Map();
  const hours = envInteger('BTC_ADDRESS_CACHE_HOURS', DEFAULT_ADDRESS_CACHE_HOURS, 1, 8_760);
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  const filter = encodeURIComponent(`in.${postgrestIn(addresses)}`);
  const path = `btc_address_cache?select=address,first_seen,last_activity,balance_sats,tx_count,checked_at&address=${filter}&checked_at=gte.${encodeURIComponent(cutoff)}`;
  const rows = await supabaseRequest(config, path, { method: 'GET' });
  return new Map((rows || []).map((row) => [row.address, row]));
}

async function upsertAddressCache(config, rows) {
  if (!rows.length) return;
  await supabaseRequest(config, 'btc_address_cache?on_conflict=address', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows.map((row) => ({
      address: row.address,
      first_seen: row.firstSeen,
      last_activity: row.lastActivity,
      balance_sats: String(row.balanceSats),
      tx_count: Number(row.txCount || 0),
      checked_at: row.checkedAt,
      source: row.source || 'esplora'
    })))
  });
}

async function fetchJsonWithRetry(url, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, 15_000);
      if (response.ok) return await response.json();
      if (response.status !== 429 && response.status < 500) {
        throw new Error(`Public Bitcoin API returned ${response.status}.`);
      }
      lastError = new Error(`Public Bitcoin API returned ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }
  throw lastError || new Error('Public Bitcoin API request failed.');
}

async function fetchEsploraAddress(candidate) {
  const base = (process.env.BTC_ESPLORA_BASE_URL || 'https://blockstream.info/api').replace(/\/$/, '');
  const encoded = encodeURIComponent(candidate.address);
  const [summary, transactions] = await Promise.all([
    fetchJsonWithRetry(`${base}/address/${encoded}`),
    fetchJsonWithRetry(`${base}/address/${encoded}/txs`)
  ]);

  const chain = summary?.chain_stats || {};
  const funded = Number(chain.funded_txo_sum || 0);
  const spent = Number(chain.spent_txo_sum || 0);
  const latestConfirmed = Array.isArray(transactions)
    ? transactions.find((transaction) => transaction?.status?.confirmed && transaction?.status?.block_time)
    : null;
  const lastActivity = latestConfirmed?.status?.block_time
    ? new Date(Number(latestConfirmed.status.block_time) * 1_000).toISOString()
    : null;

  return {
    address: candidate.address,
    firstSeen: candidate.firstSeen,
    lastActivity,
    balanceSats: Math.max(0, funded - spent),
    txCount: Number(chain.tx_count || 0),
    checkedAt: new Date().toISOString(),
    source: 'esplora'
  };
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function cachedRowToResult(candidate, cached) {
  return {
    address: candidate.address,
    firstSeen: candidate.firstSeen || cached.first_seen || null,
    lastActivity: cached.last_activity || null,
    balanceSats: Number(cached.balance_sats || 0),
    txCount: Number(cached.tx_count || 0),
    checkedAt: cached.checked_at || null,
    source: 'supabase-cache'
  };
}

function inactiveDays(lastActivity) {
  if (!lastActivity) return null;
  const date = new Date(lastActivity);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000));
}

function filterAndSort(rows, filters) {
  const filtered = rows.map((row) => ({
    ...row,
    balanceBtc: row.balanceSats / SATOSHIS_PER_BTC,
    inactiveDays: inactiveDays(row.lastActivity),
    activityRecords: row.txCount
  })).filter((row) =>
    row.inactiveDays !== null &&
    row.balanceSats >= filters.minBalanceSats &&
    row.balanceSats <= filters.maxBalanceSats &&
    row.inactiveDays >= filters.minInactiveDays
  );

  filtered.sort((left, right) => {
    if (filters.sort === 'balance_desc') return right.balanceSats - left.balanceSats || right.inactiveDays - left.inactiveDays;
    if (filters.sort === 'oldest_first') return String(left.firstSeen || '').localeCompare(String(right.firstSeen || ''));
    return right.inactiveDays - left.inactiveDays || right.balanceSats - left.balanceSats;
  });

  return filtered.slice(0, filters.target).map((row) => ({
    address: row.address,
    firstSeen: row.firstSeen,
    lastActivity: row.lastActivity,
    balanceSats: String(row.balanceSats),
    balanceBtc: String(row.balanceBtc),
    inactiveDays: row.inactiveDays,
    activityRecords: row.activityRecords,
    source: row.source
  }));
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return send(response, 405, { error: 'Method not allowed.' });
  }

  const expectedAccessToken = process.env.APP_ACCESS_TOKEN;
  if (expectedAccessToken && !safeTokenEqual(request.headers['x-app-access-token'], expectedAccessToken)) {
    return send(response, 401, { error: 'Incorrect or missing app passcode.' });
  }

  const serviceAccount = parseServiceAccount();
  if (!serviceAccount) {
    const packed = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    return send(response, 503, {
      error: packed
        ? 'GOOGLE_SERVICE_ACCOUNT_JSON is present but invalid.'
        : 'GOOGLE_SERVICE_ACCOUNT_JSON is missing from this deployment.'
    });
  }

  const supabase = parseSupabase();
  if (!supabase) {
    return send(response, 503, {
      error: 'Hybrid BTC caching requires a valid HTTPS SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in this Vercel project.'
    });
  }

  try {
    const body = await readJsonBody(request);
    const startDate = parseDate(body.startDate, 'Start date');
    const endDate = parseDate(body.endDate, 'End date');
    if (startDate > endDate) throw new HttpError(400, 'Start date must be on or before end date.');
    if (startDate < '2009-01-03') throw new HttpError(400, 'Start date cannot precede the Bitcoin genesis block.');

    const minBalanceBtc = requireNumber(body.minBalanceBtc, 0, 21_000_000, 'Minimum BTC');
    const maxBalanceBtc = requireNumber(body.maxBalanceBtc, 0, 21_000_000, 'Maximum BTC');
    if (minBalanceBtc > maxBalanceBtc) throw new HttpError(400, 'Minimum BTC cannot exceed maximum BTC.');

    const filters = {
      startDate,
      endDate,
      minBalanceSats: Math.round(minBalanceBtc * SATOSHIS_PER_BTC),
      maxBalanceSats: Math.round(maxBalanceBtc * SATOSHIS_PER_BTC),
      minInactiveDays: requireInteger(body.minInactiveDays, 0, 10_000, 'Minimum inactive days'),
      target: requireInteger(body.target, 1, MAX_RESULTS, 'Target results'),
      candidateLimit: requireInteger(body.candidateLimit, 10, MAX_CANDIDATES, 'Candidate limit'),
      offset: requireInteger(body.offset ?? 0, 0, MAX_CANDIDATES, 'Candidate offset'),
      sort: ['inactive_desc', 'balance_desc', 'oldest_first'].includes(body.sort) ? body.sort : 'inactive_desc'
    };

    const key = searchKey(filters);
    let cache = await getCandidateCache(supabase, key);
    let candidates;
    let bigQueryBytesProcessed = 0;
    let candidateCacheHit = Boolean(cache);

    if (cache) {
      candidates = Array.isArray(cache.candidates) ? cache.candidates : [];
    } else {
      const googleAccessToken = await getGoogleAccessToken(serviceAccount);
      const queryResult = await runBigQueryCandidateDiscovery(serviceAccount, googleAccessToken, filters);
      candidates = decodeCandidateRows(queryResult);
      bigQueryBytesProcessed = Number(queryResult.totalBytesProcessed || 0);
      await upsertCandidateCache(supabase, key, {
        startDate: filters.startDate,
        endDate: filters.endDate,
        minBalanceSats: filters.minBalanceSats,
        candidateLimit: filters.candidateLimit
      }, candidates, bigQueryBytesProcessed);
      cache = { candidates, candidate_count: candidates.length, total_bytes_processed: String(bigQueryBytesProcessed) };
      candidateCacheHit = false;
    }

    if (filters.offset > candidates.length) {
      throw new HttpError(400, 'Candidate offset is beyond the available candidate list. Start a new search.');
    }

    const batchSize = envInteger('BTC_ESPLORA_BATCH_SIZE', DEFAULT_BATCH_SIZE, 10, 100);
    const batch = candidates.slice(filters.offset, filters.offset + batchSize);
    const cachedAddresses = await getAddressCache(supabase, batch.map((item) => item.address));
    const freshResults = [];
    let providerErrors = 0;

    const enriched = await mapLimit(batch, 4, async (candidate) => {
      const cachedAddress = cachedAddresses.get(candidate.address);
      if (cachedAddress) return cachedRowToResult(candidate, cachedAddress);
      try {
        const result = await fetchEsploraAddress(candidate);
        freshResults.push(result);
        return result;
      } catch {
        providerErrors += 1;
        return null;
      }
    });

    await upsertAddressCache(supabase, freshResults);
    const validRows = enriched.filter(Boolean);
    const results = filterAndSort(validRows, filters);
    const nextOffset = Math.min(candidates.length, filters.offset + batch.length);

    return send(response, 200, {
      results,
      searchKey: key,
      candidateCount: candidates.length,
      candidatesCheckedThisBatch: batch.length,
      checkedFrom: filters.offset,
      nextOffset,
      hasMore: nextOffset < candidates.length,
      bigQueryBytesProcessed: String(bigQueryBytesProcessed),
      candidateCacheHit,
      addressCacheHits: cachedAddresses.size,
      providerChecks: freshResults.length,
      providerErrors,
      checkedAt: new Date().toISOString(),
      source: 'BigQuery candidate discovery + Supabase cache + Esplora public address verification',
      disclaimer: 'Public blockchain analytics only. Results do not establish ownership, abandonment, accessibility or permission to spend funds.'
    });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : error?.name === 'AbortError' ? 504 : 502;
    const message = error?.name === 'AbortError'
      ? 'A public-data provider timed out. Retry the batch or narrow the search.'
      : error?.message || 'Unable to search public Bitcoin data.';
    return send(response, status, { error: message });
  }
}
