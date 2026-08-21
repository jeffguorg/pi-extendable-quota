import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ─── Provider data model ───────────────────────────────────────────────────

export type Currency = "cny" | "usd";

/** Account balance (e.g. DeepSeek, OpenRouter prepaid credits) */
export interface BalanceEntry {
  type: "balance";
  currency: Currency;
  balance: number;
}

/** Subscription period quota (e.g. Anthropic 5h/7d, Kimi weekly) */
export interface QuotaEntry {
  type: "quota";
  /** Fallback label, used when windowSeconds is absent. */
  name: string;
  /** Window length in seconds. When present, the framework derives the label
   *  (30m / 5h / 3d / 1w / 1mon) and `name` is only a fallback. */
  windowSeconds?: number;
  /** Seconds until this window resets. 0 = no reset. */
  remain_time: number;
  /** Total quota in this window. */
  total: number;
  /** Remaining quota in this window. */
  remain: number;
}

export type QuotaItem = BalanceEntry | QuotaEntry;

// ─── Provider interface ───────────────────────────────────────────────────

export interface QuotaProvider {
  /** Display name shown in TUI / footer. */
  name: string;

  /** Sort order — lower runs first. Only the first matching provider is used. */
  order: number;

  /**
   * pi provider ids this provider handles (required).
   * Used for display matching (default matcher).
   */
  providerIds: string[];

  /**
   * Return true when this provider is active for the current session.
   * Default: providerIds.includes(ctx.model?.provider).
   */
  matcher?(ctx: ExtensionContext): boolean;

  /** Fetch quota data. Called only when matcher returns true.
   *  extraConfig: resolved from config.json (see resolveExtraConfig). */
  fetch(
    ctx: ExtensionContext,
    signal?: AbortSignal,
    extraConfig?: Record<string, unknown>,
  ): Promise<QuotaItem[]>;

  /** Cache TTL in milliseconds. Default 60_000. */
  ttlMs?: number;
}

// ─── Result wrapper ────────────────────────────────────────────────────────

export type FetchResult =
  | { ok: true; items: QuotaItem[]; providerName: string }
  | { ok: false; error: string; providerName: string };

// ─── Config (~/.pi/pi-extendable-quota/config.json) ───────────────────────

export interface DisplayConfig {
  /** Enable footer status. */
  footer: boolean;
  /** Enable quota warnings. */
  warnings: boolean;
  /** Enable /quotas command. */
  command: boolean;
  /** Refresh interval in ms for footer status. */
  refreshIntervalMs: number;
}

export interface SendOnRefilledConfig {
  /** Message sent when the wait triggers and the user supplied none. */
  defaultMessage: string;
  /** Quota poll interval while waiting (ms). Clamped to >= 30_000 on load. */
  pollIntervalMs: number;
}

export type ResolvedSendOnRefilledConfig = SendOnRefilledConfig;

export interface ProviderConfigEntry {
  /** Passed through verbatim to the provider (fetch). */
  extraConfig?: Record<string, unknown>;
}

/** Raw config.json shape (all fields optional; defaults applied on load). */
export interface ExtendableQuotaConfig {
  display?: Partial<DisplayConfig>;
  sendOnRefilled?: Partial<SendOnRefilledConfig>;
  providers?: Record<string, ProviderConfigEntry>;
}
