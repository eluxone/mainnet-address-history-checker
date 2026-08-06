# Mainnet Address History Checker

A manual Ethereum Mainnet public-address checker designed for Vercel.

## What it checks

- Current ETH balance (`eth_getBalance`)
- Outgoing transaction count / nonce (`eth_getTransactionCount`)
- Deployed contract code (`eth_getCode`)
- Latest incoming and outgoing indexed transfers using Alchemy's Transfers API:
  - External ETH transfers
  - Internal ETH transfers
  - ERC-20 transfers
  - ERC-721 transfers
  - ERC-1155 transfers

The app accepts **public Ethereum addresses only**. It has no seed phrase or private-key input.

## Privacy model

- Your Alchemy API key stays in a Vercel environment variable.
- The browser sends only the public address and, if configured, the private app passcode.
- Responses are marked `no-store`.
- The app does not use cookies, analytics, localStorage, or a database.

## Deploy to Vercel

### 1. Create an Alchemy Ethereum Mainnet key

Create an Alchemy app for Ethereum Mainnet and copy its API key.

### 2. Deploy the folder

Install or invoke the Vercel CLI, then run these commands from this project folder:

```bash
npx vercel
```

Follow the prompts to link or create a Vercel project.

### 3. Add environment variables

In Vercel, open:

`Project → Settings → Environment Variables`

Add:

- `ALCHEMY_API_KEY` — required
- `APP_ACCESS_TOKEN` — optional but recommended; choose a long, private passcode

Apply them to Production, Preview, and Development as needed.

### 4. Deploy production

```bash
npx vercel --prod
```

Open the deployment URL, enter a public `0x...` address, and run the check.

## Local development

Create `.env.local` from `.env.example`, then run:

```bash
npx vercel dev
```

Open the local URL printed by Vercel.

## Reading the result

- **ACTIVITY FOUND** means at least one of these was found: non-zero ETH balance, outgoing nonce, contract code, or indexed incoming/outgoing transfers.
- **NO INDEXED ACTIVITY FOUND** means those checks returned no evidence.

No indexed result can prove with mathematical certainty that an address has never appeared in every possible on-chain context. Provider indexing coverage and unusual event patterns can create limitations.

## Safety boundary

This project is for manually checking public addresses you own or are authorised to inspect. It does not generate recovery phrases, derive private keys, scan random wallets, or move funds.
