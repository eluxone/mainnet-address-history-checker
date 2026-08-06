# EVM Recovery & Address Auditor

A Vercel app with two tools:

1. **Recovery auditor** — derives EVM addresses from a BIP-39 phrase the user already owns and checks those public addresses across supported networks.
2. **Public address checker** — performs a detailed multi-network check for one public EVM address.

## Supported networks

The current deployment checks:

- Ethereum Mainnet
- Base Mainnet
- Arbitrum One
- OP Mainnet
- Polygon Mainnet

The code is structured around a network configuration array so additional providers and networks can be added later.

## Recovery-auditor privacy model

- The recovery phrase and optional BIP-39 passphrase are processed in browser memory.
- The phrase, passphrase and private keys are never submitted to Vercel or Alchemy.
- Only derived public addresses, derivation paths and indexes are sent to `/api/audit-addresses`.
- The app does not use cookies, analytics, localStorage or a database.
- Sensitive phrase fields are cleared after a completed audit.
- Exported CSV files contain public results only; they never contain the phrase.

The recovery auditor accepts only an existing phrase supplied by the user. It does not create random phrases or search random wallets.

## Supported derivation profiles

- Standard / MetaMask: `m/44'/60'/0'/0/index`
- Ledger Live: `m/44'/60'/account'/0/0`
- Legacy Ledger: `m/44'/60'/0'/index`

The app can audit up to 1,000 derived addresses per run. Public addresses are checked in small protected batches and the audit can be stopped by the user. The optional gap-stop setting ends the run after 50 consecutive addresses with no returned evidence.

## What each network check includes

- Current native balance (`eth_getBalance`)
- Outgoing transaction count / nonce (`eth_getTransactionCount`)
- Deployed contract code (`eth_getCode`)
- Indexed incoming and outgoing external, ERC-20, ERC-721 and ERC-1155 transfers
- Internal transfers where the provider supports them

A zero result means those checks returned no evidence. It is not a mathematical proof that an address has never appeared on any EVM network.

## Required Vercel environment variables

Open `Project → Settings → Environment Variables` and add:

- `ALCHEMY_API_KEY` — an Alchemy API key with Ethereum, Base, Arbitrum, Optimism and Polygon enabled
- `APP_ACCESS_TOKEN` — a long private passcode; required for recovery-auditor batch checks

Apply both variables to Production. Redeploy after saving them.

## Deployment

Connect this GitHub repository to Vercel and deploy it using the **Other** framework preset. The repository already contains `vercel.json` and the required API functions.

For local development, create `.env.local` from `.env.example`, then run:

```bash
npx vercel dev
```

## Security note

Entering a recovery phrase into any hosted webpage carries additional risk, even when the page is designed to keep the phrase local. For a high-value wallet, use a reviewed local copy on a clean computer and verify recovered public addresses against the original wallet software before taking action.
