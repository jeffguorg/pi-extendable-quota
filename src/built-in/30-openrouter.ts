import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QuotaItem, QuotaProvider } from "../types.js";

// OpenRouter key info: GET https://openrouter.ai/api/v1/key
//   limit / limit_remaining / limit_reset ("daily"|"weekly"|"monthly"|null)
// Display: quota window (only when the key has a credit limit) + credit.
// Credit and quota remain both use min(limit_remaining, account credits) —
// "remaining usable". extraConfig: showCredit / showQuota (both default true).
// remain_time for quota windows is a best-effort estimate: OpenRouter does not
// document the reset anchor, so we assume UTC calendar boundaries.

const FETCH_TIMEOUT_MS = 10_000;

interface OpenRouterKeyResponse {
  data?: OpenRouterKeyInfo;
  // Tolerate unwrapped responses.
  limit?: unknown;
  limit_remaining?: unknown;
}

interface OpenRouterKeyInfo {
  limit?: unknown;
  limit_remaining?: unknown;
  limit_reset?: unknown;
}

interface OpenRouterCreditsResponse {
  data?: {
    total_credits?: number;
    total_usage?: number;
  };
}

function num(v: unknown): number | undefined {
  // Number(null) === 0 — must reject null/undefined explicitly.
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

const RESET_SECONDS: Record<string, number> = {
  daily: 86_400,
  weekly: 604_800,
  monthly: 30 * 86_400,
};

/** Seconds until the next UTC calendar boundary for the reset period. */
function secondsUntilReset(reset: string, nowMs: number): number {
  const d = new Date(nowMs);
  let next: number;
  if (reset === "daily") {
    next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  } else if (reset === "weekly") {
    const daysUntilMonday = ((8 - d.getUTCDay()) % 7) || 7;
    next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysUntilMonday);
  } else if (reset === "monthly") {
    next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  } else {
    return 0;
  }
  return Math.max(0, Math.floor((next - nowMs) / 1000));
}

async function fetchJson(url: string, token: string, signal: AbortSignal): Promise<unknown | null> {
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal,
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

const provider: QuotaProvider = {
  name: "OpenRouter",
  order: 30,
  providerIds: ["openrouter"],

  async fetch(
    ctx: ExtensionContext,
    signal?: AbortSignal,
    extraConfig?: Record<string, unknown>,
  ): Promise<QuotaItem[]> {
    const showCredit = extraConfig?.showCredit !== false;
    const showQuota = extraConfig?.showQuota !== false;

    const auth = await ctx.modelRegistry.getProviderAuth("openrouter");
    const token = auth?.auth?.apiKey;
    if (!token) return [];

    const signals: AbortSignal[] = [AbortSignal.timeout(FETCH_TIMEOUT_MS)];
    if (signal) signals.push(signal);
    const combined = AbortSignal.any(signals);

    const raw = (await fetchJson("https://openrouter.ai/api/v1/key", token, combined)) as
      | OpenRouterKeyResponse
      | null;
    if (!raw) return [];
    const info: OpenRouterKeyInfo = (raw.data ?? raw) as OpenRouterKeyInfo;

    const now = Date.now();
    const items: QuotaItem[] = [];

    const limit = num(info.limit);
    const limitRemaining = num(info.limit_remaining);
    const limitReset = typeof info.limit_reset === "string" ? info.limit_reset : undefined;
    const hasLimit = limit !== undefined && limit > 0 && limitRemaining !== undefined;

    // Account credits are needed for the min() semantics whenever the key has
    // a limit, and as the credit source when it doesn't — always fetch.
    const creditsRaw = (await fetchJson(
      "https://openrouter.ai/api/v1/credits",
      token,
      combined,
    )) as OpenRouterCreditsResponse | null;
    const credits = creditsRaw?.data
      ? (creditsRaw.data.total_credits ?? 0) - (creditsRaw.data.total_usage ?? 0)
      : undefined;

    /** Remaining usable = min(key limit remaining, account credits). */
    const effectiveRemain =
      limitRemaining !== undefined && credits !== undefined
        ? Math.min(limitRemaining, credits)
        : (limitRemaining ?? credits);

    // Quota window — only when the key actually has a credit limit.
    if (showQuota && hasLimit && limitReset && effectiveRemain !== undefined) {
      items.push({
        type: "quota",
        name: limitReset,
        windowSeconds: RESET_SECONDS[limitReset],
        remain_time: secondsUntilReset(limitReset, now),
        total: limit,
        remain: Math.max(0, effectiveRemain),
      });
    }

    // Credit — remaining usable.
    if (showCredit && effectiveRemain !== undefined) {
      items.push({ type: "balance", currency: "usd", balance: Math.max(0, effectiveRemain) });
    }

    return items;
  },
};

export default provider;
