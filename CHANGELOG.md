# @raycash/mpp

## 0.1.0

Initial release.

### Features

- **Client SDK** (`@raycash/mpp/client`) — EIP-712 voucher signing, channel management, concurrent serialization
- **Server SDK** (`@raycash/mpp/server`) — mppx middleware with Raycash API voucher verification
- **OWS integration** (`@raycash/mpp/ows`) — Open Wallet Standard adapter for viem Account (no raw key exposure)
- **Method definition** (`@raycash/mpp`) — Raycash payment method schema for mppx

### Architecture

- Cumulative voucher model — no nonces or expiry
- Per-service channel caching with concurrent serialization
- Permissionless settlement via EIP-712 signatures
- ESM-native with `createRequire` for OWS native bindings
