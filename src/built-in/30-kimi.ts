import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QuotaItem, QuotaProvider } from "../types.js";

// Kimi Code (Moonshot AI) subscription quotas.
//   kimi-coding → https://api.kimi.com/coding  (no separate CN endpoint)
// Quota endpoint: GET {origin}/coding/v1/usages
// Response: { limits: [{ window: {duration, timeUnit}, detail: {limit, used|remaining, resetTime(ISO)} }],
//             usage:  { limit, used|remaining, resetTime }  ← weekly aggregate }
// moonshotai / moonshotai-cn are pay-as-you-go (D 类) and intentionally not covered.

const FETCH_TIMEOUT_MS = 10_000;

const UNIT_SECONDS: Record<string, number> = {
  second: 1,
  minute: 60,
  hour: 3600,
  day: 86_400,
  week: 604_800,
  month: 30 * 86_400,
};

function windowSeconds(window: { duration?: unknown; timeUnit?: unknown } | undefined): number | undefined {
  if (!window) return undefined;
  const duration = Number(window.duration ?? 0);
  if (!Number.isFinite(duration) || duration <= 0) return undefined;
  const unit = String(window.timeUnit ?? "").replace(/^TIME_UNIT_/, "").toLowerCase();
  const secs = UNIT_SECONDS[unit];
  return secs ? duration * secs : undefined;
}

function usedOf(detail: { limit?: unknown; used?: unknown; remaining?: unknown }): { limit: number; used: number } | undefined {
  const limit = Number(detail.limit ?? 0);
  if (!Number.isFinite(limit) || limit <= 0) return undefined;
  let used = Number(detail.used);
  if (!Number.isFinite(used)) {
    const remaining = Number(detail.remaining);
    used = Number.isFinite(remaining) ? limit - remaining : 0;
  }
  return { limit, used };
}

function remainTimeOf(resetTime: unknown, now: number): number {
  if (typeof resetTime !== "string") return 0;
  const t = Date.parse(resetTime);
  return Number.isFinite(t) ? Math.max(0, Math.floor((t - now) / 1000)) : 0;
}

interface KimiUsagesResponse {
  limits?: Array<{
    window?: { duration?: unknown; timeUnit?: unknown };
    detail?: { limit?: unknown; used?: unknown; remaining?: unknown; resetTime?: unknown };
  }>;
  usage?: { limit?: unknown; used?: unknown; remaining?: unknown; resetTime?: unknown };
}

const provider: QuotaProvider = {
  name: "Kimi",
  order: 30,
  providerIds: ["kimi-coding"],

  async fetch(ctx: ExtensionContext, signal?: AbortSignal): Promise<QuotaItem[]> {
    const auth = await ctx.modelRegistry.getProviderAuth("kimi-coding");
    const token = auth?.auth?.apiKey;
    if (!token) return [];

    const baseUrl = ctx.model?.baseUrl;
    if (!baseUrl) return [];
    let origin: string;
    try {
      origin = new URL(baseUrl).origin;
    } catch {
      return [];
    }

    const signals: AbortSignal[] = [AbortSignal.timeout(FETCH_TIMEOUT_MS)];
    if (signal) signals.push(signal);
    const combined = AbortSignal.any(signals);

    try {
      const resp = await fetch(`${origin}/coding/v1/usages`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: combined,
      });
      if (!resp.ok) return [];
      const json = (await resp.json()) as KimiUsagesResponse;

      const now = Date.now();
      const items: QuotaItem[] = [];
      let hasWeekly = false;

      for (const entry of json.limits ?? []) {
        const secs = windowSeconds(entry.window);
        const counts = entry.detail ? usedOf(entry.detail) : undefined;
        if (!secs || !counts) continue;
        if (secs === 604_800) hasWeekly = true;
        items.push({
          type: "quota",
          name: "window",
          windowSeconds: secs,
          remain_time: remainTimeOf(entry.detail?.resetTime, now),
          total: counts.limit,
          remain: Math.max(0, counts.limit - counts.used),
        });
      }

      // Weekly aggregate fallback when no explicit weekly window exists.
      if (!hasWeekly && json.usage) {
        const counts = usedOf(json.usage);
        if (counts) {
          items.push({
            type: "quota",
            name: "weekly",
            windowSeconds: 604_800,
            remain_time: remainTimeOf(json.usage.resetTime, now),
            total: counts.limit,
            remain: Math.max(0, counts.limit - counts.used),
          });
        }
      }

      return items;
    } catch {
      return [];
    }
  },

  ttlMs: 60_000,
};

export default provider;
