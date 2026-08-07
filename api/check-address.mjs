import { authorizeSessionOrApp } from './_auth.mjs';
import crypto from "node:crypto";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const DEFAULT_CATEGORIES = ["external", "erc20", "erc721", "erc1155"];
const MAX_TRANSFERS_EACH_DIRECTION = "0x14";

function supportedNetworks(apiKey) {
  const key = encodeURIComponent(apiKey);
  return [
    {
      key: "ethereum",
      label: "Ethereum Mainnet",
      categories: [...DEFAULT_CATEGORIES, "internal"],
      endpoint: `https://eth-mainnet.g.alchemy.com/v2/${key}`
    },
    {
      key: "base",
      label: "Base Mainnet",
      categories: DEFAULT_CATEGORIES,
      endpoint: `https://base-mainnet.g.alchemy.com/v2/${key}`
    },
    {
      key: "optimism",
      label: "OP Mainnet",
      categories: DEFAULT_CATEGORIES,
      endpoint: `https://opt-mainnet.g.alchemy.com/v2/${key}`
    }
  ];
}

function send(response, status, payload) {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  return response.status(status).json(payload);
}

function safeTokenEqual(received, expected) {
  if (typeof received !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(received, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readJsonBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body === "string") {
    if (request.body.length > 4_096) throw new Error("Request body is too large.");
    return JSON.parse(request.body);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 4_096) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function rpc(endpoint, payload) {
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

function batchResult(batch, id) {
  if (!Array.isArray(batch)) throw new Error("Unexpected blockchain state response.");
  const item = batch.find((entry) => entry?.id === id);
  if (!item) throw new Error("Blockchain response is incomplete.");
  if (item.error) throw new Error(item.error.message || "Blockchain query failed.");
  return item.result;
}

function transferResult(payload) {
  if (payload?.error) throw new Error(payload.error.message || "Transfer-history query failed.");
  if (!Array.isArray(payload?.result?.transfers)) throw new Error("Unexpected transfer-history response.");
  return payload.result;
}

function weiToNative(hexWei) {
  const wei = BigInt(hexWei || "0x0");
  const base = 10n ** 18n;
  const whole = wei / base;
  const fraction = (wei % base).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction.slice(0, 8)}` : whole.toString();
}

function direction(transfer, addressLower) {
  const from = String(transfer.from || "").toLowerCase();
  const to = String(transfer.to || "").toLowerCase();
  if (from === addressLower && to === addressLower) return "self";
  if (to === addressLower) return "incoming";
  if (from === addressLower) return "outgoing";
  return "related";
}

function normaliseTransfer(transfer, addressLower, network) {
  const tokenId = transfer.tokenId || transfer.erc721TokenId || null;
  const fallback = `${transfer.hash || "unknown"}:${transfer.category || "transfer"}:${tokenId || ""}`;
  return {
    id: `${network.key}:${transfer.uniqueId || fallback}`,
    network: network.key,
    networkLabel: network.label,
    hash: transfer.hash || null,
    blockNumber: transfer.blockNum ? Number.parseInt(transfer.blockNum, 16) : null,
    timestamp: transfer.metadata?.blockTimestamp || null,
    direction: direction(transfer, addressLower),
    category: transfer.category || "unknown",
    from: transfer.from || null,
    to: transfer.to || null,
    value: transfer.value ?? null,
    asset: transfer.asset || null,
    tokenId,
    contractAddress: transfer.rawContract?.address || null
  };
}

async function inspectNetwork(address, network) {
  const state = [
    { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] },
    { jsonrpc: "2.0", id: 2, method: "eth_getTransactionCount", params: [address, "latest"] },
    { jsonrpc: "2.0", id: 3, method: "eth_getCode", params: [address, "latest"] }
  ];
  const transferBase = {
    fromBlock: "0x0",
    toBlock: "latest",
    category: network.categories,
    excludeZeroValue: false,
    withMetadata: true,
    order: "desc",
    maxCount: MAX_TRANSFERS_EACH_DIRECTION
  };
  const incoming = { jsonrpc: "2.0", id: 4, method: "alchemy_getAssetTransfers", params: [{ ...transferBase, toAddress: address }] };
  const outgoing = { jsonrpc: "2.0", id: 5, method: "alchemy_getAssetTransfers", params: [{ ...transferBase, fromAddress: address }] };

  const [statePayload, incomingPayload, outgoingPayload] = await Promise.all([
    rpc(network.endpoint, state),
    rpc(network.endpoint, incoming),
    rpc(network.endpoint, outgoing)
  ]);

  const balanceHex = batchResult(statePayload, 1);
  const nonceHex = batchResult(statePayload, 2);
  const codeHex = batchResult(statePayload, 3);
  const inResult = transferResult(incomingPayload);
  const outResult = transferResult(outgoingPayload);
  const addressLower = address.toLowerCase();
  const transferMap = new Map();
  for (const raw of [...inResult.transfers, ...outResult.transfers]) {
    const item = normaliseTransfer(raw, addressLower, network);
    transferMap.set(item.id, item);
  }

  const balanceWei = BigInt(balanceHex || "0x0");
  const nonce = BigInt(nonceHex || "0x0");
  const hasContractCode = Boolean(codeHex && codeHex !== "0x" && codeHex !== "0x0");
  const indexedTransferFound = inResult.transfers.length > 0 || outResult.transfers.length > 0;
  const activityFound = balanceWei > 0n || nonce > 0n || hasContractCode || indexedTransferFound;
  const evidence = [];
  if (balanceWei > 0n) evidence.push("Non-zero native balance");
  if (nonce > 0n) evidence.push("Outgoing transaction count is non-zero");
  if (hasContractCode) evidence.push("Contract code is deployed at this address");
  if (indexedTransferFound) evidence.push("Indexed transfer history was found");

  return {
    key: network.key,
    label: network.label,
    activityFound,
    evidence,
    state: {
      balanceWei: balanceWei.toString(),
      balanceNative: weiToNative(balanceHex),
      outgoingTransactionCount: nonce.toString(),
      hasContractCode
    },
    history: {
      incomingReturned: inResult.transfers.length,
      outgoingReturned: outResult.transfers.length,
      returned: transferMap.size,
      partial: Boolean(inResult.pageKey || outResult.pageKey),
      transfers: [...transferMap.values()]
    }
  };
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return send(response, 405, { error: "Method not allowed." });
  }
  const apiKey = process.env.ALCHEMY_API_KEY;
  if (!apiKey) return send(response, 500, { error: "ALCHEMY_API_KEY is missing." });

  const expectedToken = process.env.APP_ACCESS_TOKEN;
  if (expectedToken && !safeTokenEqual(request.headers["x-app-access-token"], expectedToken)) {
    return send(response, 401, { error: "Incorrect or missing app passcode." });
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return send(response, 400, { error: error.message || "Invalid JSON request." });
  }
  const address = typeof body.address === "string" ? body.address.trim() : "";
  if (!ADDRESS_RE.test(address)) return send(response, 400, { error: "Enter a valid EVM address beginning with 0x." });

  const networks = supportedNetworks(apiKey);
  const settled = await Promise.allSettled(networks.map((network) => inspectNetwork(address, network)));
  const networkResults = settled.map((entry, index) => {
    if (entry.status === "fulfilled") return entry.value;
    return {
      key: networks[index].key,
      label: networks[index].label,
      activityFound: false,
      evidence: [],
      error: entry.reason?.message || "Unable to check this network.",
      state: { balanceNative: "0", outgoingTransactionCount: "0", hasContractCode: false },
      history: { returned: 0, partial: false, transfers: [] }
    };
  });

  const activeNetworks = networkResults.filter((item) => item.activityFound);
  const transfers = networkResults
    .flatMap((item) => item.history?.transfers || [])
    .sort((a, b) => Date.parse(b.timestamp || 0) - Date.parse(a.timestamp || 0))
    .slice(0, 200);
  const failedNetworkCount = networkResults.filter((item) => item.error).length;

  return send(response, 200, {
    address,
    network: "Configured EVM networks",
    supportedNetworks: networks.map(({ key, label }) => ({ key, label })),
    activity: {
      found: activeNetworks.length > 0,
      label: activeNetworks.length ? "ACTIVITY FOUND" : "NO INDEXED ACTIVITY FOUND",
      evidence: activeNetworks.length
        ? activeNetworks.map((item) => `Activity found on ${item.label}`)
        : ["No configured network returned balance, nonce, contract code, or indexed transfer evidence."]
    },
    summary: {
      networksChecked: networkResults.length,
      activeNetworkCount: activeNetworks.length,
      contractNetworkCount: networkResults.filter((item) => item.state?.hasContractCode).length,
      historyReturned: transfers.length,
      failedNetworkCount
    },
    networkResults,
    history: {
      returned: transfers.length,
      partial: networkResults.some((item) => item.history?.partial),
      transfers
    },
    checkedAt: new Date().toISOString(),
    disclaimer: "This deployment checks Ethereum Mainnet, Base Mainnet, and OP Mainnet only. Failed network checks are reported separately."
  });
}
