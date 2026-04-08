/**
 * Raycash payment method for MPP.
 *
 * The 402 challenge includes:
 * - `amount`: per-call price (constant, checked by mppx for cross-route safety)
 * - `lastCumulative`: set by the server's request hook when it knows the channel
 * - `channelStateUrl`: endpoint the client queries to get lastCumulative for its channel
 *
 * The client queries channelStateUrl to get the correct lastCumulative,
 * then signs `lastCumulative + amount`.
 */
import { Method, z } from "mppx";

export const raycashChannel = Method.from({
  name: "raycash",
  intent: "channel",
  schema: {
    credential: {
      payload: z.object({
        signature: z.signature(),
        channel: z.address(),
        cumulativeAmount: z.amount(),
      }),
    },
    request: z.object({
      /** Per-call price. */
      amount: z.amount(),
      /** Per-channel cumulative total. Always "0" in the initial 402; the server
       *  request hook overrides this per-channel on subsequent requests. Required
       *  by the mppx schema — the client uses max(local, server) as the base. */
      lastCumulative: z.amount(),
      /** URL to query channel state (lastCumulative) by channel address. */
      channelStateUrl: z.string(),
      /** Underlying ERC-20 token address. */
      currency: z.address(),
      /** Chain ID. */
      chainId: z.number(),
      /** Minimum deposit to fund a channel. */
      minDeposit: z.amount(),
    }),
  },
});

export type RaycashChannelMethod = typeof raycashChannel;
