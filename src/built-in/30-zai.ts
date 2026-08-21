import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QuotaItem, QuotaProvider } from "../types.js";

// Z.ai (GLM Coding Plan) — covers both deployments:
//   zai           → https://api.z.ai
//   zai-coding-cn → https://open.bigmodel.cn
// Quota endpoint: GET {origin}/api/monitor/usage/quota/limit
// Response: { data: { limits: [...] } } (or top-level limits).
//   TOKENS_LIMIT entries report `percentage` (used %) plus (unit, number)
//   encoding the window length and `nextResetTime` (epoch ms).
//   Observed units: 3 = hour (5h window), 5 = 30d month, 6 = week.

const FETCH_TIMEOUT_MS = 10_000;

const UNIT_SECONDS: Record<number, number> = {
  3: 3600,
  4: 86_400,
  5: 30 * 86_400,
  6: 604_800,
};

interface ZaiLimitEntry {
  type?: string;
  percentage?: number;
  unit?: number;
  number?: number;
  nextResetTime?: number;
}

interface ZaiQuotaResponse {
  data?: { limits?: ZaiLimitEntry[] };
  limits?: ZaiLimitEntry[];
}

function currentProviderId(ctx: ExtensionContext): string {
  const p = ctx.model?.provider;
  return p && provider.providerIds.includes(p) ? p : provider.providerIds[0];
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

async function fetchJson(origin: string, token: string, signal: AbortSignal): Promise<ZaiQuotaResponse | null> {
  // Bearer first; some gateways expect the bare token — retry once on 401.
  for (const header of [`Bearer ${token}`, token]) {
    try {
      const resp = await fetch(`${origin}/api/monitor/usage/quota/limit`, {
        headers: { Authorization: header, Accept: "application/json" },
        signal,
      });
      if (resp.status === 401 && header.startsWith("Bearer ")) continue;
      if (!resp.ok) return null;
      return (await resp.json()) as ZaiQuotaResponse;
    } catch {
      return null;
    }
  }
  return null;
}

const provider: QuotaProvider = {
  name: "Z.ai",
  order: 30,
  providerIds: ["zai", "zai-coding-cn"],

  async fetch(ctx: ExtensionContext, signal?: AbortSignal): Promise<QuotaItem[]> {
    const auth = await ctx.modelRegistry.getProviderAuth(currentProviderId(ctx));
    const token = auth?.auth?.apiKey;
    if (!token) return [];

    const baseUrl = ctx.model?.baseUrl;
    if (!baseUrl) return [];
    const origin = originOf(baseUrl);

    const signals: AbortSignal[] = [AbortSignal.timeout(FETCH_TIMEOUT_MS)];
    if (signal) signals.push(signal);
    const combined = AbortSignal.any(signals);

    const json = await fetchJson(origin, token, combined);
    if (!json) return [];

    const limits = json.data?.limits ?? json.limits ?? [];
    const now = Date.now();
    const items: QuotaItem[] = [];

    for (const entry of limits) {
      if (entry.type !== "TOKENS_LIMIT") continue;
      const percentage = Number(entry.percentage ?? 0);
      const unit = Number(entry.unit ?? 0);
      const count = Number(entry.number ?? 1) || 1;
      const resetMs = Number(entry.nextResetTime ?? 0);
      const windowSeconds = (UNIT_SECONDS[unit] ?? 0) * count;
      items.push({
        type: "quota",
        name: "tokens",
        windowSeconds: windowSeconds > 0 ? windowSeconds : undefined,
        remain_time: resetMs > 0 ? Math.max(0, Math.floor((resetMs - now) / 1000)) : 0,
        total: 100,
        remain: Math.max(0, 100 - percentage),
      });
    }
    return items;
  },

  ttlMs: 60_000,
};

export default provider;
