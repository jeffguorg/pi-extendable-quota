import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QuotaProvider, QuotaItem } from "../types.js";

const FETCH_TIMEOUT_MS = 10_000;

interface DeepSeekBalanceResponse {
  balance_infos?: Array<{
    total_balance?: string;
    currency?: string;
  }>;
}

const provider: QuotaProvider = {
  name: "DeepSeek",
  order: 30,
  providerIds: ["deepseek"],

  async fetch(ctx: ExtensionContext, signal?: AbortSignal): Promise<QuotaItem[]> {
    const auth = await ctx.modelRegistry.getProviderAuth("deepseek");
    const token = auth?.auth?.apiKey;
    if (!token) return [];

    const signals: AbortSignal[] = [AbortSignal.timeout(FETCH_TIMEOUT_MS)];
    if (signal) signals.push(signal);
    const combined = AbortSignal.any(signals);

    try {
      const resp = await fetch("https://api.deepseek.com/user/balance", {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: combined,
      });
      if (!resp.ok) return [];

      const json = (await resp.json()) as DeepSeekBalanceResponse;
      const info = (json.balance_infos ?? [])[0];
      if (!info) return [];

      const currency = (info.currency ?? "usd").toLowerCase() === "cny" ? "cny" as const : "usd" as const;
      const balance = parseFloat(info.total_balance ?? "0");

      return [{
        type: "balance",
        currency,
        balance,
      }];
    } catch {
      return [];
    }
  },
};

export default provider;