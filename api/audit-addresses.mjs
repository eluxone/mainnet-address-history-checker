import crypto from "node:crypto";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const MAX_ADDRESSES = 4;
const DEFAULT_CATEGORIES = ["external", "erc20", "erc721", "erc1155"];

function supportedNetworks(apiKey) {
  const key = encodeURIComponent(apiKey);
  return [
    {
      key: "ethereum",
      label: "Ethereum",
      categories: [...DEFAULT_CATEGORIES, "internal"],
      endpoint: `https://eth-mainnet.g.alchemy.com/v2/${key}`
    },
    {
      key: "base",
      label: "Base",
      categories: DEFAULT_CATEGORIES,
      endpoint: `https://base-mainnet.g.alchemy.com/v2/${key}`
    },
    {
      key: "arbitrum",
      label: "Arbitrum",
      categories: DEFAULT_CATEGORIES,
      endpoint: `https://arb-mainnet.g.alchemy.com/v2/${key}`
    },
    {
      key: "optimism",
      label: "Optimism",
      categories: DEFAULT_CATEGORIES,
      endpoint: `https://opt-mainnet.g.alchemy.com/v2/${key}`
    },
    {
      key: "polygon",
      label: "Polygon",
      categories: [...DEFAULT_CATEGORIES, "internal"],
      endpoint: `https://polygon-mainnet.g.alchemy.com/v2/${key}`
    }
  ];
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
    if (request.body.length > 32_768) throw new Error("Request body is too large.");
    return JSON.parse(request.body);
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 32_768) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function alchemyRpc(endpoint, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
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

    if (!upstream.ok) {
      throw new Error(data?.error?.message || `Blockchain provider request failed (${upstream.status}).`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
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
  const settled = await Promise.allSettled(
    networks.map((network) => inspectAddressOnNetwork(network, item.address, ordinal))
  );

  const networkResults = settled.map((entry, index) => {
    const base = { key: networks[index].key, label: networks[index].label };
    if (entry.status === "fulfilled") return entry.value;
    return {
      ...base,
      activityFound: false,
      evidence: [],
      balanceNative: "0",
      outgoingTransactionCount: "0",
      hasContractCode: false,
      incomingFound: false,
      outgoingFound: false,
      error: entry.reason?.message || "Unable to check this network."
    };
  });

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

  if (!Array.isArray(body.addresses) || body.addresses.length < 1 || body.addresses.length > MAX_ADDRESSES) {
    return send(response, 400, {
      error: `Submit between 1 and ${MAX_ADDRESSES} public addresses per request.`
    });
  }

  const seen = new Set();
  const addresses = [];
  for (const raw of body.addresses) {
    const address = typeof raw?.address === "string" ? raw.address.trim() : "";
    const path = typeof raw?.path === "string" ? raw.path.trim() : "";
    const index = Number(raw?.index);

    if (!ADDRESS_RE.test(address)) {
      return send(response, 400, {
        error: "One or more submitted public addresses are invalid."
      });
    }
    if (!Number.isSafeInteger(index) || index < 0 || index > 0x7fffffff) {
      return send(response, 400, {
        error: "One or more derivation indexes are invalid."
      });
    }
    if (!path || path.length > 96) {
      return send(response, 400, {
        error: "One or more derivation paths are invalid."
      });
    }

    const dedupeKey = `${address.toLowerCase()}|${path}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    addresses.push({ address, path, index });
  }

  const networks = supportedNetworks(apiKey);

  try {
    const settled = await Promise.allSettled(
      addresses.map((item, ordinal) => inspectAddress(networks, item, ordinal + 1))
    );

    const results = settled.map((entry, index) => {
      if (entry.status === "fulfilled") return entry.value;
      return {
        ...addresses[index],
        activityFound: false,
        activeNetworks: [],
        evidence: [],
        networkErrorCount: networks.length,
        successfulNetworkCount: 0,
        error: entry.reason?.message || "Unable to check this address."
      };
    });

    return send(response, 200, {
      network: "Supported EVM networks",
      supportedNetworks: networks.map(({ key, label }) => ({ key, label })),
      results,
      checkedAt: new Date().toISOString(),
      disclaimer: "This deployment checks Ethereum, Base, Arbitrum, Optimism, and Polygon. A zero result is reported only when at least one network check succeeded."
    });
  } catch (error) {
    const message = error?.name === "AbortError"
      ? "The blockchain provider timed out. Try a smaller batch."
      : error?.message || "Unable to audit these addresses.";
    return send(response, 502, { error: message });
  }
}
