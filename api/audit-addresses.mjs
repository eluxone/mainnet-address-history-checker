import crypto from "node:crypto";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const MAX_ADDRESSES = 1;
const DEFAULT_CATEGORIES = ["external", "erc20", "erc721", "erc1155"];
const NETWORK_PAUSE_MS = 650;
const MAX_RPC_ATTEMPTS = 3;

function supportedNetworks(apiKey) {
  return [
    {
      key: "ethereum",
      label: "Ethereum",
      categories: [...DEFAULT_CATEGORIES, "internal"],
      endpoint: `https://eth-mainnet.g.alchemy.com/v2/${encodeURIComponent(apiKey)}`
    },
    {
      key: "base",
      label: "Base",
      categories: DEFAULT_CATEGORIES,
      endpoint: `https://base-mainnet.g.alchemy.com/v2/${encodeURIComponent(apiKey)}`
    },
    {
      key: "arbitrum",
      label: "Arbitrum",
      categories: DEFAULT_CATEGORIES,
      endpoint: `https://arb-mainnet.g.alchemy.com/v2/${encodeURIComponent(apiKey)}`
    },
    {
      key: "optimism",
      label: "Optimism",
      categories: DEFAULT_CATEGORIES,
      endpoint: `https://opt-mainnet.g.alchemy.com/v2/${encodeURIComponent(apiKey)}`
    },
    {
      key: "polygon",
      label: "Polygon",
      categories: [...DEFAULT_CATEGORIES, "internal"],
      endpoint: `https://polygon-mainnet.g.alchemy.com/v2/${encodeURIComponent(apiKey)}`
    }
  ];
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function setResponseHeaders(response) {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function send(response, status, payload) {
  setResponseHeaders(response);
  return response.status(status).json(payload);
}

function safeTokenEqual(received, expected) {
  if (typeof received !== "string" || typeof expected !== "string") return false;
  const receivedBuffer = Buffer.from(received, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (receivedBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

async function readJsonBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body === "string") {
    if (request.body.length > 8_192) throw new Error("Request body is too large.");
    return JSON.parse(request.body);
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 8_192) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function retryableRpcPayload(payload) {
  const entries = Array.isArray(payload) ? payload : [payload];
  return entries.some((entry) => {
    const code = Number(entry?.error?.code);
    const message = String(entry?.error?.message || "").toLowerCase();
    return code === 429 || message.includes("rate limit") || message.includes("compute units") || message.includes("throughput") || message.includes("temporarily unavailable");
  });
}

function retryDelay(attempt, retryAfterHeader) {
  const retryAfterSeconds = Number.parseInt(retryAfterHeader || "", 10);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1_000, 8_000);
  }
  const exponential = Math.min(1_000 * (2 ** attempt), 8_000);
  return exponential + crypto.randomInt(100, 351);
}

async function alchemyRpc(endpoint, payload) {
  let lastError = null;

  for (let attempt = 0; attempt < MAX_RPC_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const upstream = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      const text = await upstream.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`Blockchain provider returned an invalid response (${upstream.status}).`);
      }

      const retryable = upstream.status === 429 || upstream.status >= 500 || retryableRpcPayload(data);
      if (retryable && attempt < MAX_RPC_ATTEMPTS - 1) {
        await sleep(retryDelay(attempt, upstream.headers.get("retry-after")));
        continue;
      }

      if (!upstream.ok) {
        throw new Error(data?.error?.message || `Blockchain provider request failed (${upstream.status}).`);
      }
      return data;
    } catch (error) {
      lastError = error;
      const retryable = error?.name === "AbortError" || /rate|throughput|temporarily|timeout/i.test(error?.message || "");
      if (!retryable || attempt >= MAX_RPC_ATTEMPTS - 1) throw error;
      await sleep(retryDelay(attempt, null));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error("Blockchain provider request failed.");
}

function getBatchItem(batch, id) {
  if (!Array.isArray(batch)) throw new Error("Unexpected blockchain response.");
  const item = batch.find((entry) => entry?.id === id);
  if (!item) throw new Error("Blockchain response is incomplete.");
  if (item.error) throw new Error(item.error.message || "Blockchain query failed.");
  return item.result;
}

function weiToNativeString(hexWei) {
  const wei = BigInt(hexWei || "0x0");
  const base = 10n ** 18n;
  const whole = wei / base;
  const fraction = (wei % base).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction.slice(0, 8)}` : whole.toString();
}

async function inspectAddressOnNetwork(network, address, ordinal) {
  const transferBase = {
    fromBlock: "0x0",
    toBlock: "latest",
    category: network.categories,
    excludeZeroValue: false,
    withMetadata: false,
    order: "desc",
    maxCount: "0x1"
  };

  const baseId = ordinal * 10;
  const payload = [
    { jsonrpc: "2.0", id: baseId + 1, method: "eth_getBalance", params: [address, "latest"] },
    { jsonrpc: "2.0", id: baseId + 2, method: "eth_getTransactionCount", params: [address, "latest"] },
    { jsonrpc: "2.0", id: baseId + 3, method: "eth_getCode", params: [address, "latest"] },
    {
      jsonrpc: "2.0",
      id: baseId + 4,
      method: "alchemy_getAssetTransfers",
      params: [{ ...transferBase, toAddress: address }]
    },
    {
      jsonrpc: "2.0",
      id: baseId + 5,
      method: "alchemy_getAssetTransfers",
      params: [{ ...transferBase, fromAddress: address }]
    }
  ];

  const batch = await alchemyRpc(network.endpoint, payload);
  const balanceHex = getBatchItem(batch, baseId + 1);
  const nonceHex = getBatchItem(batch, baseId + 2);
  const codeHex = getBatchItem(batch, baseId + 3);
  const incoming = getBatchItem(batch, baseId + 4);
  const outgoing = getBatchItem(batch, baseId + 5);

  const balanceWei = BigInt(balanceHex || "0x0");
  const nonce = BigInt(nonceHex || "0x0");
  const hasContractCode = Boolean(codeHex && codeHex !== "0x" && codeHex !== "0x0");
  const incomingFound = Array.isArray(incoming?.transfers) && incoming.transfers.length > 0;
  const outgoingFound = Array.isArray(outgoing?.transfers) && outgoing.transfers.length > 0;
  const activityFound = balanceWei > 0n || nonce > 0n || hasContractCode || incomingFound || outgoingFound;

  const evidence = [];
  if (balanceWei > 0n) evidence.push("Non-zero native balance");
  if (nonce > 0n) evidence.push("Outgoing transaction count is non-zero");
  if (hasContractCode) evidence.push("Contract code exists at the address");
  if (incomingFound) evidence.push("Indexed incoming transfer found");
  if (outgoingFound) evidence.push("Indexed outgoing transfer found");

  return {
    key: network.key,
    label: network.label,
    activityFound,
    evidence,
    balanceNative: weiToNativeString(balanceHex),
    outgoingTransactionCount: nonce.toString(),
    hasContractCode,
    incomingFound,
    outgoingFound
  };
}

async function inspectAddress(networks, item, ordinal) {
  const networkResults = [];

  for (let index = 0; index < networks.length; index += 1) {
    const network = networks[index];
    try {
      networkResults.push(await inspectAddressOnNetwork(network, item.address, ordinal));
    } catch (error) {
      networkResults.push({
        key: network.key,
        label: network.label,
        activityFound: false,
        evidence: [],
        balanceNative: "0",
        outgoingTransactionCount: "0",
        hasContractCode: false,
        incomingFound: false,
        outgoingFound: false,
        error: error?.name === "AbortError" ? "Provider request timed out." : error?.message || "Unable to check this network."
      });
    }

    if (index < networks.length - 1) await sleep(NETWORK_PAUSE_MS);
  }

  const activeNetworks = networkResults.filter((result) => result.activityFound);
  const failedNetworks = networkResults.filter((result) => result.error);
  const successfulNetworkCount = networkResults.length - failedNetworks.length;
  const evidence = activeNetworks.map(
    (result) => `${result.label}: ${result.evidence.join(", ") || "activity found"}`
  );

  const result = {
    address: item.address,
    index: item.index,
    path: item.path,
    activityFound: activeNetworks.length > 0,
    activeNetworks: activeNetworks.map((result) => result.label),
    evidence,
    networkResults,
    networkErrorCount: failedNetworks.length,
    successfulNetworkCount,
    failedNetworks: failedNetworks.map((result) => ({
      key: result.key,
      label: result.label,
      error: result.error
    }))
  };

  if (successfulNetworkCount === 0) {
    result.error = `All network checks failed: ${failedNetworks
      .map((network) => `${network.label} (${network.error})`)
      .join("; ")}`;
  }

  return result;
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return send(response, 405, { error: "Method not allowed." });
  }

  const apiKey = process.env.ALCHEMY_API_KEY;
  if (!apiKey) {
    return send(response, 500, {
      error: "Server configuration is incomplete: ALCHEMY_API_KEY is missing."
    });
  }

  const expectedAccessToken = process.env.APP_ACCESS_TOKEN;
  if (!expectedAccessToken) {
    return send(response, 503, {
      error: "Recovery auditing is disabled until APP_ACCESS_TOKEN is configured in Vercel."
    });
  }

  const receivedAccessToken = request.headers["x-app-access-token"];
  if (!safeTokenEqual(receivedAccessToken, expectedAccessToken)) {
    return send(response, 401, { error: "Incorrect or missing app passcode." });
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return send(response, 400, { error: error.message || "Invalid JSON request." });
  }

  if (!Array.isArray(body.addresses) || body.addresses.length !== MAX_ADDRESSES) {
    return send(response, 400, {
      error: "Submit exactly one public address per recovery-audit request."
    });
  }

  const raw = body.addresses[0];
  const address = typeof raw?.address === "string" ? raw.address.trim() : "";
  const path = typeof raw?.path === "string" ? raw.path.trim() : "";
  const index = Number(raw?.index);

  if (!ADDRESS_RE.test(address)) {
    return send(response, 400, { error: "The submitted public address is invalid." });
  }
  if (!Number.isSafeInteger(index) || index < 0 || index > 0x7fffffff) {
    return send(response, 400, { error: "The derivation index is invalid." });
  }
  if (!path || path.length > 96) {
    return send(response, 400, { error: "The derivation path is invalid." });
  }

  const networks = supportedNetworks(apiKey);

  try {
    const result = await inspectAddress(networks, { address, path, index }, 1);
    return send(response, 200, {
      network: "Supported EVM networks",
      supportedNetworks: networks.map(({ key, label }) => ({ key, label })),
      results: [result],
      checkedAt: new Date().toISOString(),
      disclaimer: "This deployment checks Ethereum, Base, Arbitrum, Optimism, and Polygon. Failed network checks are reported separately and are never counted as empty results."
    });
  } catch (error) {
    const message = error?.name === "AbortError"
      ? "The blockchain provider timed out. Try again later."
      : error?.message || "Unable to audit this address.";
    return send(response, 502, { error: message });
  }
}
