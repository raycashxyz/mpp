/**
 * Client-side Raycash payment method for mppx.
 *
 * On first request: calls channelStateUrl?payer=... to create a channel
 * and get its address. The payer funds it via onFundChannel callback.
 *
 * On subsequent requests: calls channelStateUrl?channel=... to get lastCumulative.
 *
 * Signs lastCumulative + amount as the new voucher.
 */
import type { Address } from "viem";
import type { Account } from "viem/accounts";

import { Credential, Method } from "mppx";
import type { Challenge } from "mppx";

import { raycashChannel } from "../method.js";

const serviceChannels = new Map<string, Address>();
const channelCumulatives = new Map<string, bigint>();
const pendingCreations = new Map<string, Promise<Address>>();
const pendingVouchers = new Map<string, Promise<string>>();

function cumulativeKey (payer: Address, channelAddress: Address): string {
  return `${payer.toLowerCase()}:${channelAddress.toLowerCase()}`;
}

export interface RaycashClientConfig {
  /** Payer's account for EIP-712 signing. */
  account: Account;
  /**
   * Override the origin used for channelStateUrl when the server advertises
   * a localhost URL (common when SERVICE_URL isn't set on the deployment).
   * Example: "https://my-api.vercel.app"
   */
  serviceOrigin?: string;
  /**
   * Called when a new channel is created and needs funding.
   * The payer should send at least minDeposit of the underlying token
   * to the channelAddress.
   */
  onFundChannel: (params: {
    channelAddress: Address;
    underlying: Address;
    minDeposit: string;
    chainId: number;
  }) => Promise<void>;
}

/** Configured client-side Raycash payment method for mppx. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function raycash (config: RaycashClientConfig): any {
  return Method.toClient(raycashChannel, {
    async createCredential ({ challenge }) {
      const { request } = challenge;

      // Fix channelStateUrl when server advertises localhost but realm is remote
      let channelStateUrl = request.channelStateUrl;
      if (config.serviceOrigin) {
        try {
          const parsed = new URL(channelStateUrl);
          if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
            parsed.protocol = new URL(config.serviceOrigin).protocol;
            parsed.host = new URL(config.serviceOrigin).host;
            channelStateUrl = parsed.toString();
          }
        } catch (e) {
          console.warn("Failed to rewrite channelStateUrl origin:", e);
        }
      }

      const serviceOriginKey = new URL(channelStateUrl).origin;
      const serviceKey = `${config.account.address.toLowerCase()}:${serviceOriginKey}:${request.chainId}:${request.currency.toLowerCase()}`;
      let channelAddress = serviceChannels.get(serviceKey);

      if (!channelAddress) {
        const pending = pendingCreations.get(serviceKey);
        if (pending) {
          channelAddress = await pending;
        } else {
          const creation = (async (): Promise<Address> => {
            const createUrl = new URL(channelStateUrl);
            createUrl.searchParams.set("payer", config.account.address);
            const createRes = await globalThis.fetch(createUrl.toString(), {
              signal: AbortSignal.timeout(15_000),
            });
            if (!createRes.ok) {
              throw new Error(`Channel creation failed: ${createRes.status}`);
            }
            const createData = await createRes.json() as {
              channelAddress: string;
              underlying?: string;
              minDeposit?: string;
              chainId?: number;
              lastCumulative?: string;
            };

            if (!createData.channelAddress) {
              throw new Error("Channel-state response missing channelAddress");
            }
            const addr = createData.channelAddress as Address;

            // Validate channel-state response matches the 402 challenge
            if (createData.chainId !== undefined && createData.chainId !== request.chainId) {
              throw new Error(
                `Channel-state chainId (${createData.chainId}) does not match challenge chainId (${request.chainId})`,
              );
            }
            if (createData.underlying !== undefined && createData.underlying.toLowerCase() !== request.currency.toLowerCase()) {
              throw new Error(
                `Channel-state underlying (${createData.underlying}) does not match challenge currency (${request.currency})`,
              );
            }

            if (createData.lastCumulative) {
              channelCumulatives.set(cumulativeKey(config.account.address as Address, addr), BigInt(createData.lastCumulative));
            }

            await config.onFundChannel({
              channelAddress: addr,
              underlying: request.currency as Address,
              minDeposit: request.minDeposit,
              chainId: request.chainId,
            });

            serviceChannels.set(serviceKey, addr);
            return addr;
          })();

          pendingCreations.set(serviceKey, creation);
          try {
            channelAddress = await creation;
          } finally {
            pendingCreations.delete(serviceKey);
          }
        }
      }

      // Serialize voucher issuance per channel to prevent concurrent reads
      // of the same ratchet value from producing duplicate cumulative amounts.
      const ck = cumulativeKey(config.account.address as Address, channelAddress);
      const pending = pendingVouchers.get(ck) ?? Promise.resolve("");
      const voucherPromise = pending.then(async () => {
        // Always fetch latest cumulative from the service to handle fresh-process restarts
        try {
          const stateUrl = new URL(channelStateUrl);
          stateUrl.searchParams.set("channel", channelAddress);
          const stateRes = await globalThis.fetch(stateUrl.toString(), {
            signal: AbortSignal.timeout(15_000),
          });
          if (stateRes.ok) {
            const data = await stateRes.json() as { lastCumulative?: string };
            if (data.lastCumulative) {
              const fromService = BigInt(data.lastCumulative);
              const current = channelCumulatives.get(ck) ?? 0n;
              if (fromService > current) {
                channelCumulatives.set(ck, fromService);
              }
            }
          }
        } catch (e) {
          console.warn("Failed to refresh cumulative:", e);
        }

        // Compute cumulative: max(local, server) + price
        const localLast = channelCumulatives.get(ck) ?? 0n;
        const serverLast = BigInt(request.lastCumulative);
        const base = serverLast > localLast ? serverLast : localLast;
        const pricePerCall = BigInt(request.amount);
        const cumulativeAmount = base + pricePerCall;

        if (!config.account.signTypedData) {
          throw new Error("Account does not support signTypedData");
        }

        const signature = await config.account.signTypedData({
          domain: {
            name: "MPPChannel",
            version: "1",
            chainId: request.chainId,
            verifyingContract: channelAddress,
          },
          types: {
            Voucher: [{
              name: "channel",
              type: "address"
            }, {
              name: "cumulativeAmount",
              type: "uint256"
            }],
          },
          primaryType: "Voucher",
          message: {
            channel: channelAddress,
            cumulativeAmount,
          },
        });

        // Advance local ratchet only after signing succeeds
        channelCumulatives.set(ck, cumulativeAmount);

        return Credential.serialize({
          challenge,
          payload: {
            signature,
            channel: channelAddress,
            cumulativeAmount: cumulativeAmount.toString(),
          },
          source: `did:pkh:eip155:${request.chainId}:${config.account.address}`,
        });
      });

      pendingVouchers.set(ck, voucherPromise.catch(() => ""));
      return voucherPromise;
    },
  });
}
