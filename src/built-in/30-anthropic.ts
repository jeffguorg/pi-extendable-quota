import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QuotaProvider, QuotaItem } from "../types.js";

const FETCH_TIMEOUT_MS = 10_000;

function isDirectApiKey(token: string): boolean {
  return token.startsWith("sk-ant-");
}

interface AnthropicUsageWindow {
  key: string;
  name: string;
  total?: { limit: number; used: number };
  limit?: { limit: number; used: number };
  currency?: { limit: number; used: number };
  renews_at?: string;
}

interface AnthropicUsageResponse {
  data?: AnthropicUsageWindow[];
}

const provider: QuotaProvider = {
  name: "Anthropic",
  order: 30,
  providerIds: ["anthropic"],

  async fetch(ctx: ExtensionContext, signal?: AbortSignal): Promise<QuotaItem[]> {
    const auth = await ctx.modelRegistry.getProviderAuth("anthropic");
    const token = auth?.auth?.apiKey;
    if (!token) return [];

    // Direct API key has no subscription usage to report
    if (isDirectApiKey(token)) return [];

    const signals: AbortSignal[] = [AbortSignal.timeout(FETCH_TIMEOUT_MS)];
    if (signal) signals.push(signal);
    const combined = AbortSignal.any(signals);

    try {
      const resp = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
          Accept: "application/json",
        },
        signal: combined,
      });
      if (!resp.ok) return [];

      const json = (await resp.json()) as AnthropicUsageResponse;
      if (!json.data) return [];

      const items: QuotaItem[] = [];
      for (const w of json.data) {
        // Subscription quota windows (usage limits)
        const limit = w.limit ?? w.total;
        if (limit && limit.limit > 0) {
          items.push({
            type: "quota",
            name: w.name ?? w.key,
            remain_time: w.renews_at
              ? Math.max(0, Math.floor((new Date(w.renews_at).getTime() - Date.now()) / 1000))
              : 0,
            total: limit.limit,
            remain: Math.max(0, limit.limit - limit.used),
          });
        }

        // Currency-based windows (spend caps)
        const currency = w.currency;
        if (currency && currency.limit > 0) {
          items.push({
            type: "quota",
            name: `${w.name ?? w.key} (spend)`,
            remain_time: w.renews_at
              ? Math.max(0, Math.floor((new Date(w.renews_at).getTime() - Date.now()) / 1000))
              : 0,
            total: Math.round(currency.limit * 100),
            remain: Math.max(0, Math.round((currency.limit - currency.used) * 100)),
          });
        }
      }
      return items;
    } catch {
      return [];
    }
  },

  ttlMs: 5 * 60_000,
};

export default provider;