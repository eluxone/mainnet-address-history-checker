# EVM Recovery & Address Auditor

A password-protected Vercel app with three owner-authorized tools:

1. **Seed recovery assistant** — recovers one missing or incorrect word from a 12-word MetaMask/Ethereum BIP-39 phrase by matching a known public address.
2. **Recovery auditor** — derives EVM addresses from a complete BIP-39 phrase the user already owns and checks those public addresses across supported networks.
3. **Public address checker** — performs a detailed multi-network check for one public EVM address.

## Website access

The entire deployment is protected by `SITE_PASSWORD`. A successful login creates a signed, secure, HTTP-only session cookie that expires after eight hours. The website password is read only from the Vercel environment and is not committed to this repository.

The seed-recovery page is available at `/recover` or `/recovery-assistant.html`.

## Seed recovery assistant

The initial version supports:

- 12-word English BIP-39 phrases
- MetaMask / standard Ethereum derivation
- Ledger Live derivation
- Legacy Ledger derivation
- exactly one missing word at a known position
- exactly one incorrect word at a known position
- a required known `0x...` public address
- account-index scanning from a user-selected starting index
- an optional BIP-39 passphrase

All candidate generation, checksum validation and public-address derivation happen inside the browser. The recovery page does not call application APIs while processing the words. It does not generate random phrases or search unknown wallets.

The browser wallet library is installed from the pinned `ethers` package during the Vercel build and served from the same deployment rather than loaded from a third-party CDN.

## Supported networks

The current public-address and complete-phrase audit deployment checks the networks configured in the API source. The interface currently highlights Ethereum Mainnet, Base Mainnet and OP Mainnet.

## Recovery privacy model

- Recovery words and an optional BIP-39 passphrase are processed in browser memory.
- Recovery words, passphrases and private keys are never intentionally submitted to Vercel, blockchain providers or the application APIs.
- The seed-recovery assistant requires a known public address and returns a result only when the candidate derives that address.
- The complete-phrase recovery auditor sends only derived public addresses, derivation paths and indexes to `/api/audit-addresses`.
- No recovery phrase is written to localStorage, a database or an exported file.
- Sensitive fields can be cleared manually and are cleared when leaving the recovery page.
- The website-access session cookie contains only an expiry timestamp and an HMAC signature; it does not contain the password or recovery information.

## Supported derivation profiles

- Standard / MetaMask: `m/44'/60'/0'/0/index`
- Ledger Live: `m/44'/60'/account'/0/0`
- Legacy Ledger: `m/44'/60'/0'/index`

## Required Vercel environment variables

Open `Project → Settings → Environment Variables` and configure:

- `SITE_PASSWORD` — required to unlock the website
- `ALCHEMY_API_KEY` — required for live blockchain checks
- `APP_ACCESS_TOKEN` — required by the existing complete-phrase recovery-auditor batch API unless that feature is later migrated fully to the website session

Apply the variables to the environments you use and redeploy after changing them.

## Deployment

Connect this GitHub repository to Vercel using the **Other** framework preset. The `vercel-build` script copies the pinned browser wallet bundle into `vendor/` before deployment.

For local development, create `.env.local` from `.env.example`, then run:

```bash
npm install
npx vercel dev
```

Run syntax checks with:

```bash
npm run check
```

## Security note

Entering a recovery phrase into any hosted webpage carries risk, even when the page is designed to keep the phrase local. Use the tool only for a wallet you own or are authorized to recover. For a high-value wallet, prefer a reviewed local copy on a clean computer, verify the recovered public address, and migrate assets to a newly generated wallet if the phrase may have been exposed.
