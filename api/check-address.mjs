import crypto from "node:crypto";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const CATEGORIES = ["external", "internal", "erc20", "erc721", "erc1155"];
const MAX_TRANSFERS_EACH_DIRECTION = "0x32"; // 50 incoming + 50 outgoing.

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
      const message = data?.error?.message || `Blockchain provider request failed (${upstream.status}).`;
      throw new Error(message);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function getBatchResult(batch, id) {
  if (!Array.isArray(batch)) throw new Error("Unexpected blockchain state response.");
  const item = batch.find((entry) => entry?.id === id);
  if (!item) throw new Error("Blockchain state response is incomplete.");
  if (item.error) throw new Error(item.error.message || "Blockchain state query failed.");
  return item.result;
}

function getTransferResult(payload) {
  if (payload?.error) throw new Error(payload.error.message || "Transfer-history query failed.");
  if (!payload?.result || !Array.isArray(payload.result.transfers)) {
    throw new Error("Unexpected transfer-history response.");
  }
  return payload.result;
}

function weiToEthString(hexWei) {
  const wei = BigInt(hexWei || "0x0");
  const base = 10n ** 18n;
  const whole = wei / base;
  const fraction = (wei % base).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction.slice(0, 8)}` : whole.toString();
}

function transferDirection(transfer, addressLower) {
  const from = String(transfer.from || "").toLowerCase();
  const to = String(transfer.to || "").toLowerCase();
  if (from === addressLower && to === addressLower) return "self";
  if (to === addressLower) return "incoming";
  if (from === addressLower) return "outgoing";
  return "related";
}

function normaliseTransfer(transfer, addressLower) {
  const tokenId = transfer.tokenId || transfer.erc721TokenId || null;
  return {
    id: transfer.uniqueId || `${transfer.hash || "unknown"}:${transfer.category || "transfer"}:${tokenId || ""}`,
    hash: transfer.hash || null,
    blockNumber: transfer.blockNum ? Number.parseInt(transfer.blockNum, 16) : null,
    timestamp: transfer.metadata?.blockTimestamp || null,
    direction: transferDirection(transfer, addressLower),
    category: transfer.category || "unknown",
    from: transfer.from || null,
    to: transfer.to || null,
    value: transfer.value ?? null,
    asset: transfer.asset || null,
    tokenId,
    contractAddress: transfer.rawContract?.address || null
  };
}

function mergeTransfers(incoming, outgoing, addressLower) {
  const byId = new Map();
  for (const transfer of [...incoming, ...outgoing]) {
    const item = normaliseTransfer(transfer, addressLower);
    byId.set(item.id, item);
  }

  return [...byId.values()]
    .sort((a, b) => {
      const timeA = a.timestamp ? Date.parse(a.timestamp) : 0;
      const timeB = b.timestamp ? Date.parse(b.timestamp) : 0;
      if (timeA !== timeB) return timeB - timeA;
      return (b.blockNumber || 0) - (a.blockNumber || 0);
    })
    .slice(0, 100);
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
  if (expectedAccessToken) {
    const receivedAccessToken = request.headers["x-app-access-token"];
    if (!safeTokenEqual(receivedAccessToken, expectedAccessToken)) {
      return send(response, 401, { error: "Incorrect or missing app passcode." });
    }
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return send(response, 400, { error: error.message || "Invalid JSON request." });
  }

  const address = typeof body.address === "string" ? body.address.trim() : "";
  if (!ADDRESS_RE.test(address)) {
    return send(response, 400, { error: "Enter a valid 42-character Ethereum address beginning with 0x." });
  }

  const addressLower = address.toLowerCase();
  const endpoint = `https://eth-mainnet.g.alchemy.com/v2/${encodeURIComponent(apiKey)}`;
  const categories = CATEGORIES;

  const stateRequest = [
    { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] },
    { jsonrpc: "2.0", id: 2, method: "eth_getTransactionCount", params: [address, "latest"] },
    { jsonrpc: "2.0", id: 3, method: "eth_getCode", params: [address, "latest"] }
  ];

  const transferBase = {
    fromBlock: "0x0",
    toBlock: "latest",
    category: categories,
    excludeZeroValue: false,
    withMetadata: true,
    order: "desc",
    maxCount: MAX_TRANSFERS_EACH_DIRECTION
  };

  const incomingRequest = {
    jsonrpc: "2.0",
    id: 4,
    method: "alchemy_getAssetTransfers",
    params: [{ ...transferBase, toAddress: address }]
  };

  const outgoingRequest = {
    jsonrpc: "2.0",
    id: 5,
    method: "alchemy_getAssetTransfers",
    params: [{ ...transferBase, fromAddress: address }]
  };

  try {
    const [statePayload, incomingPayload, outgoingPayload] = await Promise.all([
      alchemyRpc(endpoint, stateRequest),
      alchemyRpc(endpoint, incomingRequest),
      alchemyRpc(endpoint, outgoingRequest)
    ]);

    const balanceWeiHex = getBatchResult(statePayload, 1);
    const nonceHex = getBatchResult(statePayload, 2);
    const codeHex = getBatchResult(statePayload, 3);
    const incoming = getTransferResult(incomingPayload);
    const outgoing = getTransferResult(outgoingPayload);
    const transfers = mergeTransfers(incoming.transfers, outgoing.transfers, addressLower);

    const balanceWei = BigInt(balanceWeiHex || "0x0");
    const outgoingTransactionCount = BigInt(nonceHex || "0x0");
    const hasContractCode = Boolean(codeHex && codeHex !== "0x" && codeHex !== "0x0");
    const indexedTransferFound = incoming.transfers.length > 0 || outgoing.transfers.length > 0;
    const activityFound = balanceWei > 0n || outgoingTransactionCount > 0n || hasContractCode || indexedTransferFound;

    const evidence = [];
    if (balanceWei > 0n) evidence.push("Non-zero ETH balance");
    if (outgoingTransactionCount > 0n) evidence.push("One or more outgoing Ethereum transactions");
    if (hasContractCode) evidence.push("Contract code is deployed at this address");
    if (indexedTransferFound) evidence.push("Indexed transfer history was found");

    return send(response, 200, {
      address,
      network: "Ethereum Mainnet",
      activity: {
        found: activityFound,
        label: activityFound ? "ACTIVITY FOUND" : "NO INDEXED ACTIVITY FOUND",
        evidence
      },
      state: {
        balanceWei: balanceWei.toString(),
        balanceEth: weiToEthString(balanceWeiHex),
        outgoingTransactionCount: outgoingTransactionCount.toString(),
        hasContractCode
      },
      history: {
        incomingReturned: incoming.transfers.length,
        outgoingReturned: outgoing.transfers.length,
        returned: transfers.length,
        partial: Boolean(incoming.pageKey || outgoing.pageKey),
        transfers
      },
      checkedAt: new Date().toISOString(),
      disclaimer: "No indexed activity found is not a mathematical guarantee that an address has never appeared anywhere on-chain."
    });
  } catch (error) {
    const message = error?.name === "AbortError"
      ? "The blockchain provider timed out. Try again."
      : error?.message || "Unable to check this address.";
    return send(response, 502, { error: message });
  }
}
