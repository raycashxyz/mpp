/**
 * Server-side Raycash payment method for mppx.
 *
 * `amount` = per-call price (constant, safe for mppx cross-route checks).
 * `lastCumulative` = injected per-channel by the request hook.
 * `channelStateUrl` = how the client discovers/creates channels.
 *
 * The request hook always injects lastCumulative:
 * - No credential (first 402) → "0"
 * - Credential with channel → fetches real cumulative from Raycash
 */
import type { Address } from "viem";

import { Method, Receipt } from "mppx";

import { raycashChannel } from "../method.js";

export interface RaycashServerConfig {
  currency: Address;
  chainId: number;
  minDeposit: string;
  /** Public URL where the service exposes /channel-state. The client SDK calls this. */
  serviceUrl: string;
  raycashBaseUrl: string;
  apiKey: string;
  /** Override the channelStateUrl (defaults to `${serviceUrl}/channel-state`). */
  channelStateUrl?: string;
  /** Arbitrary metadata forwarded to verify/submit endpoints (e.g. session tracking). */
  metadata?: Record<string, string>;
}

/** Configured server-side Raycash payment method for mppx. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function raycash (config: RaycashServerConfig): any {
  return Method.toServer(raycashChannel, {
    defaults: {
      currency: config.currency,
      chainId: config.chainId,
      minDeposit: config.minDeposit,
      channelStateUrl: config.channelStateUrl ?? `${config.serviceUrl}/channel-state`,
      // Initial value for the first 402 (no channel yet). The request hook
      // overrides this per-channel on subsequent requests. Must be in defaults
      // so mppx's type system doesn't require it per-route in channel().
      lastCumulative: "0",
    },

    // Override lastCumulative per-channel on every request.
    async request ({ credential, request }) {
      const payload = credential?.payload as { channel?: string } | undefined;

      if (!payload?.channel) {
        return { ...request, lastCumulative: "0" };
      }

      const res = await fetch(
        `${config.raycashBaseUrl}/api/vouchers/latest?channelAddress=${encodeURIComponent(payload.channel)}`,
        {
          headers: { "Authorization": `Bearer ${config.apiKey}` },
          signal: AbortSignal.timeout(10_000),
        },
      );

      if (!res.ok) {
        return { ...request, lastCumulative: "0" };
      }

      const data = await res.json() as { cumulativeAmount?: string };
      return { ...request, lastCumulative: data.cumulativeAmount ?? "0" };
    },

    async verify ({ credential }) {
      const { payload } = credential;

      const verifyRes = await fetch(`${config.raycashBaseUrl}/api/vouchers/verify`, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          voucher: {
            channel: payload.channel,
            cumulativeAmount: payload.cumulativeAmount,
          },
          signature: payload.signature,
          ...(config.metadata ? { metadata: config.metadata } : {}),
        }),
      });

      if (!verifyRes.ok) {
        throw new Error(`Raycash verification failed: ${verifyRes.status}`);
      }

      const result = await verifyRes.json() as { valid: boolean; reason?: string };
      if (!result.valid) {
        throw new Error(result.reason ?? "Voucher verification failed");
      }

      const submitRes = await fetch(`${config.raycashBaseUrl}/api/vouchers/submit`, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          voucher: {
            channel: payload.channel,
            cumulativeAmount: payload.cumulativeAmount,
          },
          signature: payload.signature,
          ...(config.metadata ? { metadata: config.metadata } : {}),
        }),
      });

      if (!submitRes.ok) {
        throw new Error(`Raycash voucher submit failed: ${submitRes.status}`);
      }

      return Receipt.from({
        method: "raycash",
        status: "success",
        timestamp: new Date().toISOString(),
        reference: `${payload.channel}:${payload.cumulativeAmount}`,
      });
    },
  });
}
