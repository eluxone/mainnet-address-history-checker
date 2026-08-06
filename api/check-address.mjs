import crypto from "node:crypto";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const DEFAULT_CATEGORIES = ["external", "erc20", "erc721", "erc1155"];
const MAX_TRANSFERS_EACH_DIRECTION = "0x14";

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

function weiToNativeString(hexWei) {
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

function normaliseTransfer(transfer, addressLower, network) {
  const tokenId = transfer.tokenId || transfer.erc721TokenId || null;
  const fallbackId = `${transfer.hash || "unknown"}:${transfer.category || "transfer"}:${tokenId || ""}`;
  return {
    id: `${network.key}:${transfer.uniqueId || fallbackId}`,
    network: network.key,
    networkLabel: network.label,
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

function mergeTransfers(items) {
  return [...items]
    .sort((a, b) => {
      const timeA = a.timestamp ? Date.parse(a.timestamp) : 0;
      const timeB = b.timestamp ? Date.parse(b.timestamp) : 0;
      if (timeA !== timeB) return timeB - timeA;
      return (b.blockNumber || 0) - (a.blockNumber || 0);
    })
    .slice(0, 200);
}

async function inspectNetwork(address, network) {
  const addressLower = address.toLowerCase();
  const stateRequest = [
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

  const [statePayload, incomingPayload, outgoingPayload] = await Promise.all([
    alchemyRpc(network.endpoint, stateRequest),
    alchemyRpc(network.endpoint, incomingRequest),
    alchemyRpc(network.endpoint, outgoingRequest)
  ]);

  const balanceWeiHex = getBatchResult(statePayload, 1);
  const nonceHex = getBatchResult(statePayload, 2);
  const codeHex = getBatchResult(statePayload, 3);
  const incoming = getTransferResult(incomingPayload);
  const outgoing = getTransferResult(outgoingPayload);

  const transfers = [
    ...incoming.transfers.map((item) => normaliseTransfer(item, addressLower, network)),
    ...outgoing.transfers.map((item) => normaliseTransfer(item, addressLower, network))
  ];
  const uniqueTransfers = Array.from(new Map(transfers.map((item) => [item.id, item])).values());

  const balanceWei = BigInt(balanceWeiHex || "0x0");
  const outgoingTransactionCount = BigInt(nonceHex || "0x0");
  const hasContractCode = Boolean(codeHex && codeHex !== "0x" && codeHex !== "0x0");
  const indexedTransferFound = incoming.transfers.length > 0 || outgoing.transfers.length > 0;
  const activityFound = balanceWei > 0n || outgoingTransactionCount > 0n || hasContractCode || indexedTransferFound;

  const evidence = [];
  if (balanceWei > 0n) evidence.push("Non-zero native balance");
  if (outgoingTransactionCount > 0n) evidence.push("Outgoing transaction count is non-zero");
  if (hasContractCode) evidence.push("Contract code is deployed at this address");
  if (indexedTransferFound) evidence.push("Indexed transfer history was found");

  return {
    key: network.key,
    label: network.label,
    activityFound,
    evidence,
    state: {
      balanceWei: balanceWei.toString(),
      balanceNative: weiToNativeString(balanceWeiHex),
      outgoingTransactionCount: outgoingTransactionCount.toString(),
      hasContractCode
    },
    history: {
      incomingReturned: incoming.transfers.length,
      outgoingReturned: outgoing.transfers.length,
      returned: uniqueTransfers.length,
      partial: Boolean(incoming.pageKey || outgoing.pageKey),
      transfers: uniqueTransfers
    }
  };
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
    return send(response, 400, {
      error: "Enter a valid 42-character Ethereum-compatible address beginning with 0x."
    });
  }

  const networks = supportedNetworks(apiKey);

  try {
    const settled = await Promise.allSettled(
      networks.map((network) => inspectNetwork(address, network))
    );

    const networkResults = settled.map((entry, index) => {
      const base = { key: networks[index].key, label: networks[index].label };
      if (entry.status === "fulfilled") return entry.value;
      return {
        ...base,
        activityFound: false,
        evidence: [],
        error: entry.reason?.message || "Unable to check this network.",
        state: {
          balanceNative: "0",
          outgoingTransactionCount: "0",
          hasContractCode: false
        },
        history: {
          incomingReturned: 0,
          outgoingReturned: 0,
          returned: 0,
          partial: false,
          transfers: []
        }
      };
    });

    const activeNetworks = networkResults.filter((item) => item.activityFound);
    const contractsFound = networkResults.filter((item) => item.state?.hasContractCode).length;
    const allTransfers = mergeTransfers(
      networkResults.flatMap((item) => item.history?.transfers || [])
    );
    const partial = networkResults.some((item) => item.history?.partial);
    const activityFound = activeNetworks.length > 0;
    const evidence = activityFound
      ? activeNetworks.map((item) => `Activity found on ${item.label}`)
      : ["No supported network returned balance, nonce, contract code, or indexed transfer evidence."];

    return send(response, 200, {
      address,
      network: "Supported EVM networks",
      supportedNetworks: networks.map(({ key, label }) => ({ key, label })),
      activity: {
        found: activityFound,
        label: activityFound ? "ACTIVITY FOUND" : "NO INDEXED ACTIVITY FOUND",
        evidence
      },
      summary: {
        networksChecked: networkResults.length,
        activeNetworkCount: activeNetworks.length,
        contractNetworkCount: contractsFound,
        historyReturned: allTransfers.length
      },
      networkResults,
      history: {
        returned: allTransfers.length,
        partial,
        transfers: allTransfers
      },
      checkedAt: new Date().toISOString(),
      disclaimer: "This deployment checks Ethereum, Base, Arbitrum, Optimism, and Polygon. A zero result is not a mathematical proof that the address never appeared on any EVM chain."
    });
  } catch (error) {
    const message = error?.name === "AbortError"
      ? "The blockchain provider timed out. Try again."
      : error?.message || "Unable to check this address.";
    return send(response, 502, { error: message });
  }
}
