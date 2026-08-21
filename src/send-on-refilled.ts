import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fetchWithCache } from "./cache.js";
import { resolveExtraConfig, type ResolvedConfig } from "./config.js";
import type { DiscoveredProvider } from "./discover.js";
import type { QuotaItem } from "./types.js";

// ─── Command: /quotas:send-message-on-refilled ─────────────────────────────
//
// User-triggered wait: anchor the currently-exhausted quota windows of the
// current provider, poll until every anchored window is refilled, then send a
// message (default: "continue"). Purely data-driven — it never inspects
// message_end/agent_settled, so it is immune to pi's abort-classification
// quirks that plagued the old auto-resume.
//
// Cancellation is hardcoded: any new conversation activity from the user
// (agent turn, compaction, provider switch, session change) cancels the wait.

const PREFIX = "[pi-extendable-quota]";

const FLAG_DEFS: { name: string; desc: string }[] = [
  { name: "--refilled-only", desc: "严格边沿模式：配额当前可用时拒绝发送（默认：可用即发）" },
  { name: "--steer", desc: "恢复时 agent 若正忙，以 steer 插入当前流（默认 followUp 排队）" },
  { name: "--cancel", desc: "取消挂起中的等待" },
];

interface ParsedArgs {
  refilledOnly: boolean;
  steer: boolean;
  cancel: boolean;
  message: string;
  error?: string;
}

function parseArgs(raw: string, defaultMessage: string): ParsedArgs {
  const out: ParsedArgs = { refilledOnly: false, steer: false, cancel: false, message: "" };
  const trimmed = raw.trim();
  const tokens: { text: string; start: number }[] = [];
  for (const m of trimmed.matchAll(/\S+/g)) {
    tokens.push({ text: m[0], start: m.index ?? 0 });
  }
  const messageParts: string[] = [];
  let pastSeparator = false;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (pastSeparator) {
      messageParts.push(tok.text);
      continue;
    }
    if (tok.text === "--") {
      pastSeparator = true;
      continue;
    }
    if (tok.text === "--refilled-only") out.refilledOnly = true;
    else if (tok.text === "--steer") out.steer = true;
    else if (tok.text === "--cancel") out.cancel = true;
    else if (tok.text.startsWith("--")) {
      return { ...out, message: "", error: `未知参数：${tok.text}` };
    } else {
      // First non-flag token starts the message; the rest of the raw string
      // (verbatim, including any later flags) belongs to it.
      messageParts.push(trimmed.slice(tok.start));
      break;
    }
  }
  out.message = messageParts.join(" ").trim() || defaultMessage;
  return out;
}

// ─── Quota edge detection ──────────────────────────────────────────────────

interface ExhaustedItem {
  label: string;
  isBalance: boolean;
  index: number;
}

function collectExhausted(items: QuotaItem[]): ExhaustedItem[] {
  const out: ExhaustedItem[] = [];
  items.forEach((item, index) => {
    if (item.type === "quota" && item.remain <= 0) {
      out.push({ label: item.name, isBalance: false, index });
    } else if (item.type === "balance" && item.balance <= 0) {
      out.push({ label: item.currency === "cny" ? "余额" : "credit", isBalance: true, index });
    }
  });
  return out;
}

/** True when every anchored exhausted item is now refilled (> 0).
 *  Anchoring is index-based against the arm-time items array: built-in
 *  providers construct fixed-shape arrays, and any degradation (empty or
 *  shortened fetch result) yields !item → false → keep waiting, which is the
 *  safe direction. */
function allRefilled(exhausted: ExhaustedItem[], items: QuotaItem[]): boolean {
  return exhausted.every((e) => {
    const item = items[e.index];
    if (!item) return false;
    return e.isBalance
      ? item.type === "balance" && item.balance > 0
      : item.type === "quota" && item.remain > 0;
  });
}

function describeExhausted(exhausted: ExhaustedItem[]): string {
  return exhausted.map((e) => e.label).join("、");
}

// ─── Setup ─────────────────────────────────────────────────────────────────

interface WaitState {
  /** pi provider id anchored at arm time. */
  provider: string;
  providerName: string;
  exhausted: ExhaustedItem[];
  message: string;
  steer: boolean;
  timer: ReturnType<typeof setInterval>;
}

export function setupSendOnRefilled(
  pi: ExtensionAPI,
  /** Lazy provider discovery (same contract as the old auto-resume). */
  getProviders: () => DiscoveredProvider[] | Promise<DiscoveredProvider[]>,
  getConfig: () => ResolvedConfig,
): void {
  let wait: WaitState | null = null;
  /** Set right before our own sendUserMessage; consumed by the next agent_start. */
  let firingByUs = false;
  let lastCtx: ExtensionContext | undefined;
  /** Poll-failure notify gate: only notify on state *change*. */
  let pollFailing = false;
  let fireWatchdog: ReturnType<typeof setTimeout> | null = null;
  const FIRE_WATCHDOG_MS = 15_000;

  function notify(ctx: ExtensionContext | undefined, msg: string, level: "info" | "warning" | "error" = "info"): void {
    ctx?.ui.notify(`${PREFIX} ${msg}`, level);
  }

  function disarmWatchdog(): void {
    if (fireWatchdog) {
      clearTimeout(fireWatchdog);
      fireWatchdog = null;
    }
  }

  function clearWait(reason?: string): void {
    if (!wait) return;
    clearInterval(wait.timer);
    const name = wait.providerName;
    wait = null;
    pollFailing = false;
    if (reason) notify(lastCtx, `已取消等待：${name}（${reason}）`);
  }

  // ─── Fire ────────────────────────────────────────────────────────────────

  function fireMessage(): void {
    const ctx = lastCtx;
    const w = wait;
    if (!ctx || !w) return;
    clearInterval(w.timer);
    wait = null;
    pollFailing = false;

    firingByUs = true;
    notify(ctx, `${w.providerName} 配额已恢复，消息已发出`);
    const options = w.steer ? { deliverAs: "steer" as const } : { deliverAs: "followUp" as const };
    pi.sendUserMessage(w.message, options);
    // pi's sendUserMessage is fire-and-forget (errors land in extension
    // diagnostics). When fired from idle, a new agent_start within the window
    // confirms the send worked; none means it failed. When fired while the
    // agent is busy the message is only *queued* (steer injects mid-run and
    // never emits agent_start; followUp's agent_start may come long after),
    // so the watchdog heuristic does not apply — queue acceptance is success.
    if (ctx.isIdle()) {
      disarmWatchdog();
      fireWatchdog = setTimeout(() => {
        fireWatchdog = null;
        if (!firingByUs) return; // agent_start consumed it → send worked
        firingByUs = false;
        notify(ctx, "消息发送失败（未触发新对话），请手动发送", "warning");
      }, FIRE_WATCHDOG_MS);
      fireWatchdog.unref?.();
    } else {
      firingByUs = false;
    }
  }

  // ─── Poll ────────────────────────────────────────────────────────────────

  async function poll(): Promise<void> {
    const w = wait;
    if (!w) return;
    const ctx = lastCtx;
    if (!ctx) return;

    const providers = await getProviders();
    const match = providers.find((d) => d.provider.providerIds.includes(w.provider));
    const prov = match?.provider;
    if (!prov) return; // provider vanished (config change) → keep waiting silently

    try {
      const items = await fetchWithCache(
        prov,
        ctx,
        ctx.signal,
        true,
        resolveExtraConfig(getConfig(), prov.providerIds, w.provider),
      );
      if (pollFailing) {
        pollFailing = false;
        notify(ctx, "配额查询已恢复，继续轮询中");
      }
      if (allRefilled(w.exhausted, items)) fireMessage();
    } catch (err) {
      if (!pollFailing) {
        pollFailing = true;
        notify(
          ctx,
          `配额查询失败：${err instanceof Error ? err.message : String(err)}，继续轮询中`,
          "warning",
        );
      }
    }
  }

  // ─── Arm ─────────────────────────────────────────────────────────────────

  async function arm(args: string, ctx: ExtensionContext): Promise<void> {
    lastCtx = ctx;
    const config = getConfig();
    const parsed = parseArgs(args, config.sendOnRefilled.defaultMessage);

    if (parsed.error) {
      notify(
        ctx,
        `${parsed.error}\n用法：/quotas:send-message-on-refilled [--refilled-only] [--steer] [--cancel] [--] <message>`,
        "warning",
      );
      return;
    }

    if (parsed.cancel) {
      if (wait) {
        clearWait("手动取消");
      } else {
        notify(ctx, "没有挂起中的等待");
      }
      return;
    }

    const providerId = ctx.model?.provider;
    if (!providerId) {
      notify(ctx, "当前没有选中的模型，无法判断配额", "warning");
      return;
    }

    const providers = await getProviders();
    const match = providers.find((d) => d.provider.providerIds.includes(providerId));
    const prov = match?.provider;
    if (!prov) {
      notify(ctx, `当前模型（${providerId}）没有配额 provider，无法判断恢复`, "warning");
      return;
    }

    // Replace an existing wait (single slot).
    if (wait) {
      const old = wait;
      clearInterval(old.timer);
      wait = null;
      notify(ctx, `已替换之前的等待（${old.providerName}）`);
    }
    pollFailing = false;

    let items: QuotaItem[];
    try {
      items = await fetchWithCache(
        prov,
        ctx,
        ctx.signal,
        true,
        resolveExtraConfig(config, prov.providerIds, providerId),
      );
    } catch (err) {
      notify(
        ctx,
        `配额查询失败：${err instanceof Error ? err.message : String(err)}，未挂起等待`,
        "warning",
      );
      return;
    }

    const exhausted = collectExhausted(items);

    if (exhausted.length === 0) {
      if (parsed.refilledOnly) {
        notify(ctx, "配额当前可用，严格边沿模式要求观察到恢复，未发送");
        return;
      }
      firingByUs = true;
      notify(ctx, "配额当前可用，消息已直接发出");
      pi.sendUserMessage(parsed.message, parsed.steer ? { deliverAs: "steer" } : { deliverAs: "followUp" });
      if (ctx.isIdle()) {
        disarmWatchdog();
        fireWatchdog = setTimeout(() => {
          fireWatchdog = null;
          if (!firingByUs) return;
          firingByUs = false;
          notify(ctx, "消息发送失败（未触发新对话），请手动发送", "warning");
        }, FIRE_WATCHDOG_MS);
        fireWatchdog.unref?.();
      } else {
        // Queued into the active run (command ran while streaming) — no
        // agent_start timing guarantee, so no watchdog.
        firingByUs = false;
      }
      return;
    }

    const intervalMs = Math.max(30_000, config.sendOnRefilled.pollIntervalMs);
    const timer = setInterval(() => {
      void poll();
    }, intervalMs);
    timer.unref?.();
    wait = {
      provider: providerId,
      providerName: prov.name,
      exhausted,
      message: parsed.message,
      steer: parsed.steer,
      timer,
    };
    const summary = parsed.message.length > 50 ? `${parsed.message.slice(0, 50)}…` : parsed.message;
    notify(ctx, `${prov.name} 配额耗尽（${describeExhausted(exhausted)}），已挂起等待，恢复后发送：${summary}`);
  }

  // ─── Events ──────────────────────────────────────────────────────────────

  pi.on("agent_start", (_event, ctx) => {
    lastCtx = ctx;
    if (firingByUs) {
      // Our own message turn — not user activity.
      firingByUs = false;
      disarmWatchdog();
      return;
    }
    clearWait("检测到新的对话");
  });

  pi.on("session_before_compact", (_event, ctx) => {
    lastCtx = ctx;
    clearWait("检测到 compaction");
  });

  pi.on("session_compact", (_event, ctx) => {
    lastCtx = ctx;
    clearWait(); // silent; already cancelled at session_before_compact (idempotent)
  });

  pi.on("model_select", (event, ctx) => {
    lastCtx = ctx;
    if (event.previousModel && event.model.provider !== event.previousModel.provider) {
      clearWait(`检测到 provider 切换：${event.previousModel.provider} → ${event.model.provider}`);
    }
  });

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    clearWait(); // silent: new session context, nothing to notify into
  });

  pi.on("session_shutdown", () => {
    clearWait();
    disarmWatchdog();
    firingByUs = false;
    lastCtx = undefined;
  });

  // ─── Command registration ────────────────────────────────────────────────

  pi.registerCommand("quotas:send-message-on-refilled", {
    description: "[--refilled-only] [--steer] [--cancel] [--] message — 等配额恢复后发送消息",
    getArgumentCompletions: (argumentPrefix: string) => {
      // The TUI replaces the *entire* argument text after the command name
      // with item.value on completion (applyCompletion uses the provider's
      // prefix), so the value must re-include any tokens already typed —
      // otherwise completing "--a --st" would eat "--a".
      const matches = [...argumentPrefix.matchAll(/\S+/g)];
      if (matches.length === 0) return null;
      const last = matches[matches.length - 1][0];
      const lastStart = matches[matches.length - 1].index ?? 0;
      // Exact "--" is the verbatim-message separator, not a flag prefix.
      if (!last.startsWith("--") || last === "--") return null;
      const hits = FLAG_DEFS.filter((f) => f.name.startsWith(last));
      if (hits.length === 0) return null;
      const before = argumentPrefix.slice(0, lastStart);
      return hits.map((f) => ({ value: `${before}${f.name} `, label: f.name, description: f.desc }));
    },
    handler: async (args, ctx) => {
      await arm(args, ctx);
    },
  });
}
