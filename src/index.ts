import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { QuotaProvider, QuotaItem } from "./types.js";
import { loadConfig, resolveExtraConfig } from "./config.js";
import { setupSendOnRefilled } from "./send-on-refilled.js";
import { discoverProviders, userProviderDir, type DiscoveredProvider } from "./discover.js";
import { fetchWithCache, clearCache } from "./cache.js";
import { formatItemsShort, formatResetTime, quotaLabel, severityFor } from "./utils/format.js";

// ─── Resolve built-in directory ────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILT_IN_DIR = join(__dirname, "built-in");

// ─── Default matcher ───────────────────────────────────────────────────────

function matches(provider: QuotaProvider, ctx: ExtensionContext): boolean {
  if (provider.matcher) return provider.matcher(ctx);
  return provider.providerIds.includes(ctx.model?.provider ?? "");
}

// ─── Extension entry ───────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  // Ensure user provider directory exists
  try { mkdirSync(userProviderDir(), { recursive: true }); } catch { /* ignore */ }

  const config = loadConfig();
  let providers: DiscoveredProvider[] = [];
  let activeProvider: QuotaProvider | null = null;
  let cachedItems: QuotaItem[] = [];
  let currentCtx: ExtensionContext | undefined;

  // ─── Send-on-refilled (wait command) ───────────────────────────────────────────────────

  /**
   * Lazily discover providers on first use (same contract as before).
   */
  async function ensureProviders(): Promise<DiscoveredProvider[]> {
    if (providers.length === 0) {
      try {
        providers = await discoverProviders(BUILT_IN_DIR);
      } catch {
        /* keep empty; the command reports "no quota provider" */
      }
    }
    return providers;
  }

  setupSendOnRefilled(pi, ensureProviders, () => config);

  // ─── Helpers ─────────────────────────────────────────────────────────────

  async function findAndFetch(ctx: ExtensionContext, force = false): Promise<void> {
    providers = await discoverProviders(BUILT_IN_DIR);

    // Find first matching provider
    const match = providers.find((p) => matches(p.provider, ctx));
    activeProvider = match?.provider ?? null;

    if (!activeProvider) {
      cachedItems = [];
      if (ctx.hasUI) ctx.ui.setStatus("pi-extendable-quota", "");
      return;
    }

    try {
      const extraConfig = resolveExtraConfig(config, activeProvider.providerIds, ctx.model?.provider);
      cachedItems = await fetchWithCache(activeProvider, ctx, ctx.signal, force, extraConfig);
      updateFooter(ctx);
    } catch {
      cachedItems = [];
      if (ctx.hasUI) ctx.ui.setStatus("pi-extendable-quota", ctx.ui.theme.fg("warning", "quota err"));
    }
  }

  function updateFooter(ctx: ExtensionContext): void {
    if (!ctx.hasUI || !config.display.footer) return;
    if (!activeProvider || cachedItems.length === 0) {
      ctx.ui.setStatus("pi-extendable-quota", "");
      return;
    }
    const text = formatItemsShort(cachedItems);
    ctx.ui.setStatus("pi-extendable-quota", text);
  }

  function checkWarnings(ctx: ExtensionContext): void {
    if (!config.display.warnings || !activeProvider || cachedItems.length === 0) return;
    const risky = cachedItems.filter((item) => severityFor(item) !== "none");
    if (risky.length === 0) return;

    const name = activeProvider.name;
    const lines = risky.map((item) => {
      const sev = severityFor(item);
      const detail = item.type === "balance"
        ? `${item.currency === "cny" ? "¥" : "$"}${item.balance.toFixed(2)}`
        : `${item.remain}/${item.total} (${Math.round((item.remain / item.total) * 100)}%)`;
      return `- ${name}: ${detail} (${sev})`;
    });

    const level = risky.some((item) => {
      const s = severityFor(item);
      return s === "critical" || s === "high";
    }) ? "error" : "warning";

    ctx.ui.notify(`Quota warning:\n${lines.join("\n")}`, level);
  }

  // ─── /quotas command ─────────────────────────────────────────────────────

  if (config.display.command) {
    pi.registerCommand("quotas", {
      description: "Show quota usage for the current provider",
      handler: async (_args, ctx) => {
        await findAndFetch(ctx, true);
        if (!activeProvider || cachedItems.length === 0) {
          ctx.ui.notify("No matching quota provider found", "info");
          return;
        }

        const lines: string[] = [];
        lines.push(`Provider: ${activeProvider.name}`);
        lines.push("");

        for (const item of cachedItems) {
          if (item.type === "balance") {
            const sign = item.currency === "cny" ? "¥" : "$";
            lines.push(`  Balance: ${sign}${item.balance.toFixed(2)}`);
          } else {
            const pct = item.total > 0 ? Math.round((item.remain / item.total) * 100) : 0;
            lines.push(`  ${quotaLabel(item)}: ${item.remain}/${item.total} (${pct}%)`);
            if (item.remain_time > 0) {
              lines.push(`    Resets in ${formatResetTime(item.remain_time)}`);
            }
          }
        }

        ctx.ui.notify(lines.join("\n"), "info");
      },
    });

    pi.registerCommand("quotas:refresh", {
      description: "Force refresh quota data",
      handler: async (_args, ctx) => {
        clearCache(activeProvider?.name);
        await findAndFetch(ctx, true);
        if (activeProvider) {
          ctx.ui.notify(`Quota refreshed for ${activeProvider.name}`, "info");
        }
      },
    });
  }

  // ─── Events ──────────────────────────────────────────────────────────────

  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    await findAndFetch(ctx);
    checkWarnings(ctx);

    // Start periodic refresh
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (currentCtx) {
        void findAndFetch(currentCtx).catch(() => {});
      }
    }, config.display.refreshIntervalMs);
    refreshTimer.unref?.();
  });

  pi.on("model_select", async (_event, ctx) => {
    currentCtx = ctx;
    clearCache();
    await findAndFetch(ctx, true);
  });

  pi.on("turn_end", async (_event, ctx) => {
    currentCtx = ctx;
    if (activeProvider) {
      await findAndFetch(ctx);
    }
  });

  pi.on("session_shutdown", async () => {
    currentCtx = undefined;
    activeProvider = null;
    cachedItems = [];
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    clearCache();
  });
}
