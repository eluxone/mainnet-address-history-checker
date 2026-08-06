import crypto from "node:crypto";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const MAX_ADDRESSES = 10;
const CATEGORIES = ["external", "internal", "erc20", "erc721", "erc1155"];

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

function weiToEthString(hexWei) {
  const wei = BigInt(hexWei || "0x0");
  const base = 10n ** 18n;
  const whole = wei / base;
  const fraction = (wei % base).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction.slice(0, 8)}` : whole.toString();
}

async function inspectAddress(endpoint, item, ordinal) {
  const address = item.address;
  const transferBase = {
    fromBlock: "0x0",
    toBlock: "latest",
    category: CATEGORIES,
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

  const batch = await alchemyRpc(endpoint, payload);
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
  if (balanceWei > 0n) evidence.push("Non-zero ETH balance");
  if (nonce > 0n) evidence.push("Outgoing transaction nonce is non-zero");
  if (hasContractCode) evidence.push("Contract code exists at the address");
  if (incomingFound) evidence.push("Indexed incoming transfer found");
  if (outgoingFound) evidence.push("Indexed outgoing transfer found");

  return {
    address,
    index: item.index,
    path: item.path,
    activityFound,
    evidence,
    balanceEth: weiToEthString(balanceHex),
    outgoingTransactionCount: nonce.toString(),
    hasContractCode,
    incomingFound,
    outgoingFound
  };
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return send(response, 405, { error: "Method not allowed." });
  }

  const apiKey = process.env.ALCHEMY_API_KEY;
  if (!apiKey) {
    return send(response, 500, { error: "Server configuration is incomplete: ALCHEMY_API_KEY is missing." });
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
    return send(response, 400, { error: `Submit between 1 and ${MAX_ADDRESSES} public addresses per request.` });
  }

  const seen = new Set();
  const addresses = [];
  for (const raw of body.addresses) {
    const address = typeof raw?.address === "string" ? raw.address.trim() : "";
    const path = typeof raw?.path === "string" ? raw.path.trim() : "";
    const index = Number(raw?.index);
    if (!ADDRESS_RE.test(address)) {
      return send(response, 400, { error: "One or more submitted public addresses are invalid." });
    }
    if (!Number.isSafeInteger(index) || index < 0 || index > 0x7fffffff) {
      return send(response, 400, { error: "One or more derivation indexes are invalid." });
    }
    if (!path || path.length > 96) {
      return send(response, 400, { error: "One or more derivation paths are invalid." });
    }
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    addresses.push({ address, path, index });
  }

  const endpoint = `https://eth-mainnet.g.alchemy.com/v2/${encodeURIComponent(apiKey)}`;

  try {
    const settled = await Promise.allSettled(
      addresses.map((item, ordinal) => inspectAddress(endpoint, item, ordinal))
    );

    const results = settled.map((entry, index) => {
      if (entry.status === "fulfilled") return entry.value;
      return {
        ...addresses[index],
        activityFound: false,
        evidence: [],
        error: entry.reason?.message || "Unable to check this address."
      };
    });

    return send(response, 200, {
      network: "Ethereum Mainnet",
      results,
      checkedAt: new Date().toISOString(),
      disclaimer: "A zero result means no evidence was returned by these checks; it is not a mathematical proof that an address never appeared on-chain."
    });
  } catch (error) {
    const message = error?.name === "AbortError"
      ? "The blockchain provider timed out. Try a smaller batch."
      : error?.message || "Unable to audit these addresses.";
    return send(response, 502, { error: message });
  }
}
