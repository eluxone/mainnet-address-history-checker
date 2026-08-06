import crypto from 'node:crypto';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SATOSHIS_PER_BTC = 100_000_000;
const DEFAULT_MAX_BYTES_BILLED = '1000000000000';
const MAX_BODY_BYTES = 12_000;
const QUERY_POLL_LIMIT = 24;
const QUERY_POLL_MS = 5_000;

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
    if (Buffer.byteLength(request.body, 'utf8') > MAX_BODY_BYTES) throw new Error('Request body is too large.');
    return JSON.parse(request.body || '{}');
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function requireInteger(value, min, max, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return number;
}

function requireNumber(value, min, max, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return number;
}

function parseDate(value, label) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) throw new Error(`${label} is invalid.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function parseServiceAccount() {
  const packed = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (packed) {
    const candidates = [packed];
    try {
      candidates.push(Buffer.from(packed, 'base64').toString('utf8'));
    } catch {
      // Raw JSON is still attempted below.
    }
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed.project_id && parsed.client_email && parsed.private_key) {
          return {
            projectId: parsed.project_id,
            clientEmail: parsed.client_email,
            privateKey: parsed.private_key
          };
        }
      } catch {
        // Try the next supported representation.
      }
    }
  }

  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID || process.env.GCP_PROJECT_ID;
  const clientEmail = process.env.GOOGLE_CLOUD_CLIENT_EMAIL || process.env.GCP_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_CLOUD_PRIVATE_KEY || process.env.GCP_PRIVATE_KEY;
  if (!projectId || !clientEmail || !privateKey) return null;
  return {
    projectId,
    clientEmail,
    privateKey: privateKey.replace(/\\n/g, '\n')
  };
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion
      }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
      throw new Error(data.error_description || data.error || 'Google authentication failed.');
    }
    return data.access_token;
  } finally {
    clearTimeout(timeout);
  }
}

function queryParameters(filters) {
  return [
    namedTimestamp('start_timestamp', `${filters.startDate}T00:00:00Z`),
    namedTimestamp('end_timestamp', `${filters.endDate}T00:00:00Z`),
    namedInt('min_balance_sats', filters.minBalanceSats),
    namedInt('max_balance_sats', filters.maxBalanceSats),
    namedInt('min_inactive_days', filters.minInactiveDays),
    namedInt('candidate_limit', filters.candidateLimit),
    namedInt('target_results', filters.target)
  ];
}

function namedTimestamp(name, value) {
  return {
    name,
    parameterType: { type: 'TIMESTAMP' },
    parameterValue: { value }
  };
}

function namedInt(name, value) {
  return {
    name,
    parameterType: { type: 'INT64' },
    parameterValue: { value: String(value) }
  };
}

function orderBy(sort) {
  if (sort === 'balance_desc') return 'balance_sats DESC, inactive_days DESC';
  if (sort === 'oldest_first') return 'first_seen ASC, balance_sats DESC';
  return 'inactive_days DESC, balance_sats DESC';
}

function buildQuery(filters) {
  return `
WITH candidates AS (
  SELECT
    address,
    MIN(o.block_timestamp) AS first_seen,
    MAX(o.block_timestamp) AS last_seen_in_window,
    SUM(o.value) AS received_sats_in_window
  FROM \`bigquery-public-data.crypto_bitcoin.outputs\` AS o
  CROSS JOIN UNNEST(o.addresses) AS address
  WHERE o.block_timestamp >= @start_timestamp
    AND o.block_timestamp < TIMESTAMP_ADD(@end_timestamp, INTERVAL 1 DAY)
    AND o.value BETWEEN @min_balance_sats AND @max_balance_sats
    AND address IS NOT NULL
    AND address != ''
    AND LENGTH(address) BETWEEN 26 AND 90
  GROUP BY address
  ORDER BY first_seen ASC, received_sats_in_window DESC
  LIMIT @candidate_limit
),
ledger AS (
  SELECT
    address,
    o.block_timestamp AS activity_timestamp,
    o.value AS delta_sats
  FROM \`bigquery-public-data.crypto_bitcoin.outputs\` AS o
  CROSS JOIN UNNEST(o.addresses) AS address
  INNER JOIN candidates c USING (address)

  UNION ALL

  SELECT
    address,
    i.block_timestamp AS activity_timestamp,
    -i.value AS delta_sats
  FROM \`bigquery-public-data.crypto_bitcoin.inputs\` AS i
  CROSS JOIN UNNEST(i.addresses) AS address
  INNER JOIN candidates c USING (address)
),
summary AS (
  SELECT
    c.address,
    c.first_seen,
    MAX(l.activity_timestamp) AS last_activity,
    SUM(l.delta_sats) AS balance_sats,
    COUNT(*) AS activity_records
  FROM candidates c
  INNER JOIN ledger l USING (address)
  GROUP BY c.address, c.first_seen
),
filtered AS (
  SELECT
    address,
    first_seen,
    last_activity,
    balance_sats,
    SAFE_DIVIDE(balance_sats, ${SATOSHIS_PER_BTC}) AS balance_btc,
    DATE_DIFF(CURRENT_DATE(), DATE(last_activity), DAY) AS inactive_days,
    activity_records
  FROM summary
  WHERE balance_sats BETWEEN @min_balance_sats AND @max_balance_sats
    AND DATE_DIFF(CURRENT_DATE(), DATE(last_activity), DAY) >= @min_inactive_days
)
SELECT
  address,
  first_seen,
  last_activity,
  balance_sats,
  balance_btc,
  inactive_days,
  activity_records
FROM filtered
ORDER BY ${orderBy(filters.sort)}
LIMIT @target_results
`;
}

async function googleJson(url, options, accessToken, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(options?.headers || {})
      },
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.error?.message || `Google BigQuery request failed (${response.status}).`;
      throw new Error(message);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function runQuery(serviceAccount, accessToken, filters) {
  const endpoint = `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(serviceAccount.projectId)}/queries`;
  const maximumBytesBilled = process.env.BIGQUERY_MAX_BYTES_BILLED || DEFAULT_MAX_BYTES_BILLED;
  const initial = await googleJson(endpoint, {
    method: 'POST',
    body: JSON.stringify({
      query: buildQuery(filters),
      useLegacySql: false,
      parameterMode: 'NAMED',
      queryParameters: queryParameters(filters),
      location: 'US',
      timeoutMs: 20_000,
      maximumBytesBilled,
      useQueryCache: true
    })
  }, accessToken);

  if (initial.errors?.length) {
    throw new Error(initial.errors.map((item) => item.message).filter(Boolean).join('; ') || 'BigQuery rejected the query.');
  }
  if (initial.jobComplete) return initial;

  const jobId = initial.jobReference?.jobId;
  const location = initial.jobReference?.location || 'US';
  if (!jobId) throw new Error('BigQuery did not return a query job identifier.');

  for (let attempt = 0; attempt < QUERY_POLL_LIMIT; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, QUERY_POLL_MS));
    const pollUrl = `${endpoint}/${encodeURIComponent(jobId)}?location=${encodeURIComponent(location)}&timeoutMs=10000&maxResults=100`;
    const polled = await googleJson(pollUrl, { method: 'GET' }, accessToken, 30_000);
    if (polled.errors?.length) {
      throw new Error(polled.errors.map((item) => item.message).filter(Boolean).join('; ') || 'BigQuery query failed.');
    }
    if (polled.jobComplete) return polled;
  }

  throw new Error('The public Bitcoin query did not finish before the Vercel request deadline. Narrow the date range or reduce the candidate limit.');
}

function decodeRows(result) {
  const fields = result.schema?.fields || [];
  const rows = result.rows || [];
  return rows.map((row) => {
    const record = {};
    fields.forEach((field, index) => {
      record[field.name] = row.f?.[index]?.v ?? null;
    });
    return {
      address: String(record.address || ''),
      firstSeen: record.first_seen || null,
      lastActivity: record.last_activity || null,
      balanceSats: String(record.balance_sats || '0'),
      balanceBtc: String(record.balance_btc || '0'),
      inactiveDays: Number(record.inactive_days || 0),
      activityRecords: Number(record.activity_records || 0)
    };
  }).filter((item) => item.address);
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return send(response, 405, { error: 'Method not allowed.' });
  }

  const expectedAccessToken = process.env.APP_ACCESS_TOKEN;
  if (expectedAccessToken) {
    const receivedAccessToken = request.headers['x-app-access-token'];
    if (!safeTokenEqual(receivedAccessToken, expectedAccessToken)) {
      return send(response, 401, { error: 'Incorrect or missing app passcode.' });
    }
  }

  const serviceAccount = parseServiceAccount();
  if (!serviceAccount) {
    return send(response, 503, {
      error: 'BTC Discovery Lab requires a Google Cloud service account. Configure GOOGLE_SERVICE_ACCOUNT_JSON in Vercel, then redeploy.'
    });
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return send(response, 400, { error: error?.message || 'Invalid JSON request.' });
  }

  let filters;
  try {
    const startDate = parseDate(body.startDate, 'Start date');
    const endDate = parseDate(body.endDate, 'End date');
    if (startDate > endDate) throw new Error('Start date must be on or before end date.');
    if (startDate < '2009-01-03') throw new Error('Start date cannot precede the Bitcoin genesis block.');

    const minBalanceBtc = requireNumber(body.minBalanceBtc, 0, 21_000_000, 'Minimum BTC');
    const maxBalanceBtc = requireNumber(body.maxBalanceBtc, 0, 21_000_000, 'Maximum BTC');
    if (minBalanceBtc > maxBalanceBtc) throw new Error('Minimum BTC cannot exceed maximum BTC.');

    filters = {
      startDate,
      endDate,
      minBalanceSats: Math.round(minBalanceBtc * SATOSHIS_PER_BTC),
      maxBalanceSats: Math.round(maxBalanceBtc * SATOSHIS_PER_BTC),
      minInactiveDays: requireInteger(body.minInactiveDays, 0, 10_000, 'Minimum inactive days'),
      target: requireInteger(body.target, 1, 100, 'Target results'),
      candidateLimit: requireInteger(body.candidateLimit, 10, 5_000, 'Candidate limit'),
      sort: ['inactive_desc', 'balance_desc', 'oldest_first'].includes(body.sort) ? body.sort : 'inactive_desc'
    };
  } catch (error) {
    return send(response, 400, { error: error?.message || 'Invalid search filters.' });
  }

  try {
    const accessToken = await getGoogleAccessToken(serviceAccount);
    const queryResult = await runQuery(serviceAccount, accessToken, filters);
    const results = decodeRows(queryResult);
    return send(response, 200, {
      results,
      candidatesEvaluated: filters.candidateLimit,
      totalRows: Number(queryResult.totalRows || results.length),
      totalBytesProcessed: String(queryResult.totalBytesProcessed || '0'),
      cacheHit: Boolean(queryResult.cacheHit),
      checkedAt: new Date().toISOString(),
      source: 'Google BigQuery public Bitcoin dataset',
      disclaimer: 'Public blockchain analytics only. Results do not establish ownership, abandonment, accessibility or permission to spend funds.'
    });
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? 'The public-data provider timed out. Narrow the search and try again.'
      : error?.message || 'Unable to query public Bitcoin data.';
    return send(response, 502, { error: message });
  }
}
