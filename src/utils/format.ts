import type { QuotaItem, BalanceEntry, QuotaEntry } from "../types.js";

export function formatBalance(item: BalanceEntry): string {
  const sign = item.currency === "cny" ? "¥" : "$";
  const display = item.balance.toFixed(2).replace(/\.00$/, "");
  return `${sign}${display}`;
}

const MIN = 60;
const HOUR = 3600;
const DAY = 86_400;
const WEEK = 604_800;
const MONTH = 30 * DAY;

/** Trim to one decimal, dropping a trailing ".0". */
function trim1(v: number): string {
  return v.toFixed(1).replace(/\.0$/, "");
}

/**
 * Standard window label from a length in seconds (framework-wide, the single
 * source of truth): 30m / 5h / 3d / 1w (7d multiples) / 1mon (30d multiples).
 */
export function formatWindowLabel(seconds: number): string {
  if (seconds % MONTH === 0) return `${seconds / MONTH}mon`;
  if (seconds % WEEK === 0) return `${seconds / WEEK}w`;
  if (seconds % DAY === 0) return `${seconds / DAY}d`;
  if (seconds % HOUR === 0) return `${seconds / HOUR}h`;
  if (seconds % MIN === 0) return `${seconds / MIN}m`;
  return `${seconds}s`;
}

/** Label for a quota item: derived from windowSeconds when present. */
export function quotaLabel(item: QuotaEntry): string {
  return item.windowSeconds && item.windowSeconds > 0
    ? formatWindowLabel(item.windowSeconds)
    : item.name;
}

export function formatQuota(item: QuotaEntry): string {
  const label = quotaLabel(item);
  // total = 0 表示无限额信息，仅展示当前值（如 1h 消耗）。
  if (item.total <= 0) {
    return `${label}: ${item.remain.toFixed(2)}`;
  }
  const pct = Math.round((item.remain / item.total) * 100);
  return `${label}: ${item.remain}/${item.total} (${pct}%)`;
}

/** Countdown: ≥1d → 2.5d, ≥1h → 2.5h, <1h → Nm, <1m → Ns. */
export function formatResetTime(seconds: number): string {
  if (seconds <= 0) return "";
  if (seconds >= DAY) return `${trim1(seconds / DAY)}d`;
  if (seconds >= HOUR) return `${trim1(seconds / HOUR)}h`;
  if (seconds >= MIN) return `${Math.round(seconds / MIN)}m`;
  return `${Math.round(seconds)}s`;
}

export function formatItem(item: QuotaItem): string {
  if (item.type === "balance") return formatBalance(item);
  return formatQuota(item);
}

export function severityFor(item: QuotaItem): "none" | "warning" | "high" | "critical" {
  if (item.type === "balance") {
    if (item.balance <= 0) return "critical";
    if (item.balance < 1) return "high";
    if (item.balance < 5) return "warning";
    return "none";
  }
  const pct = item.total > 0 ? item.remain / item.total : 0;
  if (item.total <= 0) return "none"; // 无限额信息，无告警依据
  if (pct <= 0) return "critical";
  if (pct < 0.1) return "high";
  if (pct < 0.2) return "warning";
  return "none";
}

export function formatItemsShort(items: QuotaItem[]): string {
  return items.map((item) => {
    if (item.type === "balance") return formatBalance(item);
    // <周期>(in 剩余时间) 余量，如 `5h(in 2.5h) 37%`
    const countdown = item.remain_time > 0 ? `(in ${formatResetTime(item.remain_time)}) ` : " ";
    if (item.total > 0) {
      const pct = Math.round((item.remain / item.total) * 100);
      return `${quotaLabel(item)}${countdown}${pct}%`;
    }
    return `${quotaLabel(item)}${countdown}${item.remain.toFixed(2)}`;
  }).join(" ");
}