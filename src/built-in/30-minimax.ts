import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QuotaItem, QuotaProvider } from "../types.js";

// MiniMax Coding Plan — covers both deployments:
//   minimax-cn → https://api.minimaxi.com
//   minimax    → https://api.minimax.io
// Quota endpoint (B 类): GET {origin}/v1/api/openplatform/coding_plan/remains?GroupId=<id>
//   Requires a GroupId: config.json providers["minimax-cn"|"minimax"].extraConfig.groupId,
//   falling back to env MINIMAX_GROUP_ID.
//   Response model_remains[] — we use the entry with model_name === "general",
//   which carries a current interval window (start_time/end_time) and a weekly
//   window (weekly_start_time/weekly_end_time). Count fields may be absent on
//   `general`; then current_*_remaining_percent is used with total = 100.

const FETCH_TIMEOUT_MS = 10_000;

/** One-shot: notify about missing GroupId only once per session (display path). */
let notifiedMissingGroupId = false;

/**
 * GroupId from the framework-injected extraConfig (already resolved across all
 * providerIds by resolveExtraConfig), falling back to env MINIMAX_GROUP_ID.
 */
function groupIdFrom(extraConfig: Record<string, unknown> | undefined): string | undefined {
  const v = extraConfig?.groupId;
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  const env = process.env.MINIMAX_GROUP_ID;
  return env && env.length > 0 ? env : undefined;
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

function buildWindow(
  name: string,
  totalCount: unknown,
  usedCount: unknown,
  remainingPercent: unknown,
  startMs: unknown,
  endMs: unknown,
  now: number,
): QuotaItem | undefined {
  const start = Number(startMs ?? 0);
  const end = Number(endMs ?? 0);
  if (!(end > start)) return undefined;

  let total = Number(totalCount ?? 0);
  let used = Number(usedCount ?? 0);
  if (!(total > 0)) {
    const pct = Number(remainingPercent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return undefined;
    total = 100;
    used = Math.round(100 - pct);
  }

  const windowSecs = Math.floor((end - start) / 1000);
  return {
    type: "quota",
    name,
    windowSeconds: windowSecs,
    remain_time: Math.max(0, Math.floor((end - now) / 1000)),
    total,
    remain: Math.max(0, total - used),
  };
}

interface MinimaxModelRemains {
  model_name?: string;
  current_interval_total_count?: number;
  current_interval_usage_count?: number;
  current_interval_remaining_percent?: number;
  start_time?: number;
  end_time?: number;
  current_weekly_total_count?: number;
  current_weekly_usage_count?: number;
  current_weekly_remaining_percent?: number;
  weekly_start_time?: number;
  weekly_end_time?: number;
}

interface MinimaxRemainsResponse {
  base_resp?: { status_code?: number };
  baseResp?: { status_code?: number };
  model_remains?: MinimaxModelRemains[];
}

async function fetchRemains(origin: string, token: string, groupId: string, signal: AbortSignal): Promise<QuotaItem[]> {
  try {
    const resp = await fetch(
      `${origin}/v1/api/openplatform/coding_plan/remains?GroupId=${encodeURIComponent(groupId)}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal },
    );
    if (!resp.ok) return [];
    const json = (await resp.json()) as MinimaxRemainsResponse;

    const statusCode = json.base_resp?.status_code ?? json.baseResp?.status_code;
    if (statusCode !== undefined && statusCode !== 0) return [];

    const target = (json.model_remains ?? []).find((e) => e.model_name === "general");
    if (!target) return [];

    const now = Date.now();
    const items: QuotaItem[] = [];
    const current = buildWindow(
      "current",
      target.current_interval_total_count,
      target.current_interval_usage_count,
      target.current_interval_remaining_percent,
      target.start_time,
      target.end_time,
      now,
    );
    if (current) items.push(current);
    const weekly = buildWindow(
      "weekly",
      target.current_weekly_total_count,
      target.current_weekly_usage_count,
      target.current_weekly_remaining_percent,
      target.weekly_start_time,
      target.weekly_end_time,
      now,
    );
    if (weekly) items.push(weekly);
    return items;
  } catch {
    return [];
  }
}

const provider: QuotaProvider = {
  name: "MiniMax",
  order: 30,
  providerIds: ["minimax-cn", "minimax"],

  async fetch(
    ctx: ExtensionContext,
    signal?: AbortSignal,
    extraConfig?: Record<string, unknown>,
  ): Promise<QuotaItem[]> {
    const groupId = groupIdFrom(extraConfig);
    if (!groupId) {
      // 缺 groupId：提示一次，不展示（而非静默）。
      if (!notifiedMissingGroupId) {
        notifiedMissingGroupId = true;
        ctx.ui.notify(
          "[pi-extendable-quota] MiniMax 配额显示需要 GroupId：请在 ~/.pi/pi-extendable-quota/config.json 的 " +
            `providers["${currentProviderId(ctx)}"].extraConfig.groupId 配置，或设置环境变量 MINIMAX_GROUP_ID`,
          "warning",
        );
      }
      return [];
    }

    const auth = await ctx.modelRegistry.getProviderAuth(currentProviderId(ctx));
    const token = auth?.auth?.apiKey;
    if (!token) return [];

    const baseUrl = ctx.model?.baseUrl;
    if (!baseUrl) return [];

    const signals: AbortSignal[] = [AbortSignal.timeout(FETCH_TIMEOUT_MS)];
    if (signal) signals.push(signal);
    const combined = AbortSignal.any(signals);

    return fetchRemains(originOf(baseUrl), token, groupId, combined);
  },

  ttlMs: 60_000,
};

export default provider;
