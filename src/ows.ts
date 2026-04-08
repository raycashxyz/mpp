/**
 * Open Wallet Standard (OWS) integration for MPP.
 *
 * Creates a viem-compatible Account that delegates EIP-712 signing to OWS.
 * The agent never sees raw private keys — OWS manages an encrypted vault
 * with scoped API keys and spending policies.
 *
 * Usage:
 *   import { owsAccount } from "@raycash/mpp/ows"
 *   const account = owsAccount({ wallet: "my-agent-wallet" })
 *   raycash({ account, ... })
 */
import { createRequire } from "module";

import type { Address, Hex } from "viem";
import { toAccount } from "viem/accounts";

export interface OwsAccountConfig {
  /** OWS wallet name or ID. */
  wallet: string;
  /** Chain for signing (default: "evm"). */
  chain?: string;
  /** Account derivation index (default: 0). */
  index?: number;
}

interface OwsBindings {
  getWallet: (name: string) => { accounts: Array<{ chainId: string; address: string }> };
  signTypedData: (
    wallet: string,
    chain: string,
    typedDataJson: string,
    passphrase?: string | null,
    index?: number | null,
  ) => { signature: string };
  signMessage: (
    wallet: string,
    chain: string,
    message: string,
    encoding?: string | null,
    typedData?: string | null,
    index?: number | null,
  ) => { signature: string };
}

let cachedOws: OwsBindings | undefined;

function loadOws (): OwsBindings {
  if (cachedOws) return cachedOws;
  try {
    const require = createRequire(import.meta.url);
    cachedOws = require("@open-wallet-standard/core") as OwsBindings;
    return cachedOws;
  } catch {
    throw new Error(
      "OWS not installed. Run: npm install -g @open-wallet-standard/core\n" +
      "Then create a wallet: ows wallet create --name my-agent",
    );
  }
}

/**
 * Creates a viem-compatible Account backed by OWS.
 *
 * Lazily loads `@open-wallet-standard/core` so the dependency is optional —
 * only needed when this function is called.
 */
export function owsAccount (config: OwsAccountConfig) {
  const chainName = config.chain ?? "evm";
  const index = config.index ?? 0;

  // Resolve address from OWS wallet
  const ows = loadOws();
  const walletInfo = ows.getWallet(config.wallet);
  const ethAccounts = walletInfo.accounts.filter((a) => a.chainId.startsWith("eip155:"));
  if (ethAccounts.length === 0) {
    throw new Error(`No Ethereum account found in OWS wallet "${config.wallet}"`);
  }
  if (!ethAccounts[index]) {
    throw new Error(
      `OWS wallet "${config.wallet}" has no Ethereum account at index ${index} (wallet has ${ethAccounts.length} account(s))`,
    );
  }
  const ethAccount = ethAccounts[index];
  const address = ethAccount.address as Address;

  return toAccount({
    address,

    signMessage: async ({ message }) => {
      const bindings = loadOws();
      let msg: string;
      let encoding: string;
      if (typeof message === "string") {
        msg = message;
        encoding = "utf8";
      } else if ("raw" in message) {
        const raw = message.raw;
        if (typeof raw === "string") {
          // Already a hex string (0x-prefixed) — strip prefix for OWS
          msg = raw.startsWith("0x") ? raw.slice(2) : raw;
        } else {
          // Uint8Array — convert to hex
          msg = Array.from(raw as Uint8Array).map((b) => b.toString(16).padStart(2, "0")).join("");
        }
        encoding = "hex";
      } else {
        msg = String(message);
        encoding = "utf8";
      }
      const result = bindings.signMessage(
        config.wallet,
        chainName,
        msg,
        encoding,
        null,
        index,
      );
      return result.signature as Hex;
    },

    signTypedData: async (typedData) => {
      const bindings = loadOws();
      const json = JSON.stringify(
        {
          types: typedData.types,
          primaryType: typedData.primaryType,
          domain: typedData.domain,
          message: typedData.message,
        },
        (_, v) => typeof v === "bigint" ? v.toString() : v,
      );
      const result = bindings.signTypedData(
        config.wallet,
        chainName,
        json,
        null,
        index,
      );
      return result.signature as Hex;
    },

    signTransaction: async () => {
      throw new Error("MPP wallets are signing-only — no on-chain transactions needed");
    },
  });
}
