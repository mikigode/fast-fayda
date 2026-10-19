import { env } from "../env";
import type { BotStore, Settings } from "./store";

/**
 * The settings actually in effect: whatever the portal has set in
 * app_settings, falling back to the environment variable for anything still
 * null. One call site for that merge, used by both the conversation and the
 * portal, so the two cannot disagree about which price or account a customer
 * was shown.
 */
export type ResolvedSettings = {
  pricePerPoint: number;
  cbeAccountName: string;
  cbeAccountNumber: string;
  telebirrAccountName: string;
  telebirrAccountNumber: string;
  /** The Card API key in force: the portal's, else the environment's. */
  cardApiKey: string;
};

export async function resolveSettings(store: BotStore): Promise<ResolvedSettings> {
  const stored: Settings = await store.getSettings();
  return {
    pricePerPoint: stored.pointPriceEtb ?? env.pointPriceEtb,
    cbeAccountName: stored.cbeAccountName ?? env.cbeAccountName,
    cbeAccountNumber: stored.cbeAccountNumber ?? env.cbeAccountNumber,
    telebirrAccountName: stored.telebirrAccountName ?? env.telebirrAccountName,
    telebirrAccountNumber: stored.telebirrAccountNumber ?? env.telebirrAccountNumber,
    cardApiKey: stored.cardApiKey ?? env.cardApiKey,
  };
}

/** Whether there is anywhere to tell a customer to send money at all. */
export function hasAnyAccount(settings: ResolvedSettings): boolean {
  return Boolean(
    (settings.cbeAccountName && settings.cbeAccountNumber) ||
      (settings.telebirrAccountName && settings.telebirrAccountNumber),
  );
}
