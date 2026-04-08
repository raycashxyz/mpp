# @raycash/mpp

Machine Payments Protocol (MPP) SDK for Raycash confidential payment channels. Enables pay-per-call API monetization with cumulative EIP-712 vouchers settled into FHE-encrypted tokens.

## Overview

```
┌─────────┐     402 Challenge      ┌─────────────┐      Verify       ┌──────────┐
│  Payer  │ ◄──────────────────── │   Service    │ ────────────────► │ Raycash  │
│ (Agent) │ ────────────────────► │  (your API)  │ ◄──────────────── │   API    │
│         │    Voucher + Request   │             │      Receipt      │          │
└─────────┘                        └─────────────┘                    └──────────┘
```

The payer never talks to Raycash directly. Everything flows through the service, which uses the `@raycash/mpp/server` middleware to verify vouchers and the Raycash API to settle payments.

## Installation

```bash
pnpm add @raycash/mpp
```

## Quick Start

### Server — Add payments to any Hono/Express API

```typescript
import { Hono } from "hono";
import { Mppx } from "mppx/hono";
import { raycash } from "@raycash/mpp/server";

const mppx = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY!,
  methods: [
    raycash({
      currency: "0xa0a2...158f",       // USDC address on Sepolia
      chainId: 11155111,                // Sepolia
      minDeposit: "100000",             // 0.1 USDC minimum channel funding
      serviceUrl: "http://localhost:3004",
      raycashBaseUrl: "http://localhost:3003",
      apiKey: process.env.RAYCASH_API_KEY!,
    }),
  ],
});

const app = new Hono();

// Free endpoint — no middleware
app.get("/cities", (c) => c.json(listCities()));

// Paid endpoint — 0.001 USDC per call
app.get("/weather", mppx.channel({ amount: "1000" }), (c) => {
  return c.json(getWeather(c.req.query("city")!));
});
```

### Client — Pay for API calls

```typescript
import { raycash } from "@raycash/mpp/client";
import { privateKeyToAccount } from "viem/accounts";

const client = raycash({
  account: privateKeyToAccount("0x..."),
  onFundChannel: async ({ channelAddress, minDeposit, chainId }) => {
    // Transfer USDC to the channel address
    await walletClient.writeContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: "transfer",
      args: [channelAddress, BigInt(minDeposit)],
    });
  },
});

// Use with mppx fetch
import { Mppx } from "mppx";
const mppx = Mppx.create({ methods: [client] });

const res = await mppx.fetch("http://localhost:3004/weather?city=paris");
const weather = await res.json();
```

### Client with OWS (Open Wallet Standard)

For agents that should never handle raw private keys:

```typescript
import { raycash } from "@raycash/mpp/client";
import { owsAccount } from "@raycash/mpp/ows";

const account = owsAccount({ wallet: "my-agent-wallet" });
const client = raycash({ account, onFundChannel: ... });
```

## Exports

| Import | Description |
|--------|-------------|
| `@raycash/mpp` | Core method definition (`raycashChannel`) |
| `@raycash/mpp/client` | Client-side payment method (`raycash()`) |
| `@raycash/mpp/server` | Server-side middleware (`raycash()`) |
| `@raycash/mpp/ows` | Open Wallet Standard integration (`owsAccount()`) |

## How It Works

### Payment Flow

1. Client calls a paid endpoint → server returns **402 Payment Required** with challenge
2. Challenge includes: `amount`, `currency`, `chainId`, `minDeposit`, `channelStateUrl`
3. Client creates/discovers a payment channel via `channelStateUrl`
4. Client signs a cumulative EIP-712 voucher covering `lastCumulative + amount`
5. Client retries the request with the voucher in the payment header
6. Server verifies the voucher against the Raycash API
7. Server returns the paid response

### Cumulative Vouchers

Each voucher contains a `cumulativeAmount` that strictly increases:

```text
Request 1: cumulative = 0 + 1000 = 1000      (pays 0.001 USDC)
Request 2: cumulative = 1000 + 1000 = 2000    (pays 0.001 USDC)
Request 3: cumulative = 2000 + 1000 = 3000    (pays 0.001 USDC)
```

No nonces or expiry — the cumulative amount prevents replay. The operator settles the latest voucher on-chain to collect the total.

### Channel Lifecycle

1. **Create** — operator deploys a channel at a deterministic CREATE2 address
2. **Fund** — payer sends ERC-20 tokens to the channel address
3. **Use** — payer signs cumulative vouchers, anyone can settle on-chain
4. **Close** — payer requests close → 15-minute grace period → withdraw remaining

## Configuration

### RaycashServerConfig

```typescript
interface RaycashServerConfig {
  /** ERC-20 token address (e.g. USDC on Sepolia). */
  currency: Address;
  /** Chain ID (e.g. 11155111 for Sepolia). */
  chainId: number;
  /** Minimum deposit to fund a new channel (in smallest token units). */
  minDeposit: string;
  /** Public URL where the service exposes /channel-state. */
  serviceUrl: string;
  /** Raycash dashboard API URL. */
  raycashBaseUrl: string;
  /** Bearer API key from the Raycash dashboard. */
  apiKey: string;
  /** Override the channelStateUrl (defaults to `${serviceUrl}/channel-state`). */
  channelStateUrl?: string;
  /** Arbitrary metadata forwarded to verify/submit (e.g. session tracking). */
  metadata?: Record<string, string>;
}
```

### RaycashClientConfig

```typescript
interface RaycashClientConfig {
  /** Payer's account for EIP-712 signing. */
  account: Account;
  /** Override the service origin for localhost URLs. */
  serviceOrigin?: string;
  /** Callback to fund the channel when it's created. */
  onFundChannel: (params: {
    channelAddress: Address;
    underlying: Address;
    minDeposit: string;
    chainId: number;
  }) => Promise<void>;
}
```

### OwsAccountConfig

```typescript
interface OwsAccountConfig {
  /** OWS wallet name or ID. */
  wallet: string;
  /** Chain for signing (default: "evm"). */
  chain?: string;
  /** Account derivation index (default: 0). */
  index?: number;
}
```

## Channel State Endpoint

Services must expose a `/channel-state` endpoint that the client SDK calls to create/discover channels. The endpoint proxies to the Raycash API:

```text
GET /channel-state?payer=0x...           → Create channel, return address + params
GET /channel-state?channel=0x...         → Return lastCumulative for existing channel
```

See `demo/weather-api/src/index.ts` for a complete implementation.

## Publishing

`@raycash/mpp` is published to npm **from the public mirror repo** ([raycashxyz/mpp](https://github.com/raycashxyz/mpp)), not from this monorepo.

### How it works

```text
raycash-monorepo (private)          raycashxyz/mpp (public)           npm
┌──────────────────────┐           ┌──────────────────────┐      ┌──────────┐
│ packages/mpp/src/    │  sync →   │ src/                 │      │          │
│ packages/mpp/README  │  ──────►  │ README.md            │ ───► │ @raycash │
│ packages/mpp/CHANGE  │  on push  │ CHANGELOG.md         │ tag  │   /mpp   │
│                      │  to main  │ package.json         │      │          │
└──────────────────────┘           └──────────────────────┘      └──────────┘
```

1. **Develop** in `packages/mpp/` in the monorepo (this repo)
2. **Merge to main** — the `sync-mpp-mirror` GitHub Action automatically syncs source, README, CHANGELOG, and version to [raycashxyz/mpp](https://github.com/raycashxyz/mpp)
3. **Publish** — push a version tag (`v0.1.0`) to the public mirror repo, which triggers `npm publish`

### Why a mirror?

- The monorepo is private; npm needs a public repo for `repository` field and source links
- Publishing from the mirror ensures only `@raycash/mpp` source is public, not the entire monorepo
- The sync workflow keeps the mirror in lockstep with the monorepo automatically

### Publishing from the monorepo is blocked

`package.json` includes a `prepublishOnly` script that errors if you try to `npm publish` from the monorepo. Always publish from the public mirror.

### Setup (one-time)

1. Create the public repo: `gh repo create raycashxyz/mpp --public`
2. Add `MPP_MIRROR_TOKEN` secret to the monorepo (a GitHub PAT with `repo` scope for `raycashxyz/mpp`)
3. Add `NPM_TOKEN` secret to `raycashxyz/mpp` for npm publishing

## Related

- [MPPWrapper contracts](../../contracts/docs/mpp/spec.md) — on-chain payment channel specification
- [demo/weather-api](../../demo/weather-api/) — complete demo service
- [mppx](https://github.com/wevm/mppx) — the underlying payment protocol framework
- [raycashxyz/mpp](https://github.com/raycashxyz/mpp) — public mirror (npm publish source)
