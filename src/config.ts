import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  DisplayConfig,
  ExtendableQuotaConfig,
  ProviderConfigEntry,
  SendOnRefilledConfig,
} from "./types.js";

// ─── Defaults ──────────────────────────────────────────────────────────────

export const DEFAULT_DISPLAY: DisplayConfig = {
  footer: true,
  warnings: true,
  command: true,
  refreshIntervalMs: 60_000,
};

export const DEFAULT_SEND_ON_REFILLED: SendOnRefilledConfig = {
  defaultMessage:
    "<harness>\n[pi-extendable-quota] 自动唤醒：用户在配额耗尽时设置的等待已触发（配额现已恢复），本消息由插件代用户发出。\n上文末尾若有限流/报错残留，是当时的中断痕迹，无需处理。请直接从中断处继续未完成的工作，无需解释本消息。\n</harness>",
  pollIntervalMs: 60_000,
};

export interface ResolvedConfig {
  display: DisplayConfig;
  sendOnRefilled: SendOnRefilledConfig;
  providers: Record<string, ProviderConfigEntry>;
}

// ─── Path ──────────────────────────────────────────────────────────────────

export function configPath(): string {
  return join(homedir(), ".pi", "pi-extendable-quota", "config.json");
}

// ─── Sanitizers (keep only known keys with correct types) ─────────────────

function pickBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function pickNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function pickStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function sanitizeDisplay(raw: unknown): Partial<DisplayConfig> {
  if (typeof raw !== "object" || raw === null) return {};
  const r = raw as Record<string, unknown>;
  return {
    footer: pickBool(r.footer),
    warnings: pickBool(r.warnings),
    command: pickBool(r.command),
    refreshIntervalMs: pickNum(r.refreshIntervalMs),
  };
}

function sanitizeSendOnRefilled(raw: unknown): Partial<SendOnRefilledConfig> {
  if (typeof raw !== "object" || raw === null) return {};
  const r = raw as Record<string, unknown>;
  return {
    defaultMessage: pickStr(r.defaultMessage),
    pollIntervalMs: pickNum(r.pollIntervalMs),
  };
}

function sanitizeProviders(raw: unknown): Record<string, ProviderConfigEntry> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, ProviderConfigEntry> = {};
  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    for (const key of Object.keys(e)) {
      if (key !== "extraConfig") {
        console.warn(
          `[pi-extendable-quota] config providers["${id}"]: unknown key "${key}" (did you mean "extraConfig"?), ignoring`,
        );
      }
    }
    const sanitized: ProviderConfigEntry = {};
    if (typeof e.extraConfig === "object" && e.extraConfig !== null) {
      sanitized.extraConfig = e.extraConfig as Record<string, unknown>;
    }
    out[id] = sanitized;
  }
  return out;
}

function dropUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

// ─── Load ──────────────────────────────────────────────────────────────────

/**
 * Load config.json and merge with defaults.
 * Missing/corrupt file → defaults + console.warn (once per call).
 */
export function loadConfig(): ResolvedConfig {
  const path = configPath();
  let raw: ExtendableQuotaConfig = {};

  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (typeof parsed === "object" && parsed !== null) {
        raw = parsed as ExtendableQuotaConfig;
      } else {
        console.warn(`[pi-extendable-quota] ${path}: expected a JSON object, using defaults`);
      }
    } catch (err) {
      console.warn(`[pi-extendable-quota] failed to parse ${path}, using defaults:`, err);
    }
  }

  const sanitizedSend = sanitizeSendOnRefilled(raw.sendOnRefilled);
  return {
    display: { ...DEFAULT_DISPLAY, ...dropUndefined(sanitizeDisplay(raw.display)) },
    sendOnRefilled: {
      ...DEFAULT_SEND_ON_REFILLED,
      ...dropUndefined(sanitizedSend),
      pollIntervalMs: Math.max(30_000, sanitizedSend.pollIntervalMs ?? DEFAULT_SEND_ON_REFILLED.pollIntervalMs),
    },
    providers: sanitizeProviders(raw.providers),
  };
}

/**
 * Resolve extraConfig for a provider file. preferredId (the current
 * pi provider id) wins; then fall back to the file's providerIds in order, so
 * multi-deployment files (e.g. minimax-cn + minimax) find a groupId configured
 * under either key. Returns {} when nothing is configured.
 */
export function resolveExtraConfig(
  config: ResolvedConfig,
  providerIds: string[],
  preferredId?: string,
): Record<string, unknown> {
  const ids =
    preferredId && providerIds.includes(preferredId)
      ? [preferredId, ...providerIds.filter((id) => id !== preferredId)]
      : providerIds;
  for (const id of ids) {
    const ec = config.providers[id]?.extraConfig;
    if (ec) return ec;
  }
  return {};
}
