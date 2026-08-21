import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupSendOnRefilled } from "../src/send-on-refilled.js";
import {
  DEFAULT_DISPLAY,
  DEFAULT_SEND_ON_REFILLED,
  type ResolvedConfig,
} from "../src/config.js";
import { clearCache } from "../src/cache.js";
import type { DiscoveredProvider } from "../src/discover.js";
import type { QuotaProvider } from "../src/types.js";

// ─── Mocks ─────────────────────────────────────────────────────────────────

type Handler = (event: any, ctx: any) => unknown;

function makePi() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, any>();
  const sent: { content: string; options?: any }[] = [];
  const pi = {
    on: (event: string, h: Handler) => handlers.set(event, h),
    registerCommand: (name: string, def: any) => commands.set(name, def),
    sendUserMessage: (content: string, options?: any) => {
      sent.push({ content, options });
    },
  };
  return { pi: pi as any, handlers, commands, sent };
}

function makeCtx() {
  return {
    hasUI: true,
    isIdle: () => true,
    signal: undefined,
    model: { provider: "mock", id: "mock-1", baseUrl: "https://mock.example.com" },
    modelRegistry: { find: () => undefined, getProviderAuth: async () => undefined },
    ui: { notify: vi.fn() },
  } as any;
}

function makeConfig(over: Partial<ResolvedConfig["sendOnRefilled"]> = {}): ResolvedConfig {
  return {
    display: { ...DEFAULT_DISPLAY },
    sendOnRefilled: { ...DEFAULT_SEND_ON_REFILLED, ...over },
    providers: {},
  };
}

/** Quota items helper: one exhausted 5h window + one healthy weekly window. */
function items5h(exhausted: boolean) {
  return [
    { type: "quota", name: "5h", remain_time: 1800, total: 100, remain: exhausted ? 0 : 30 },
    { type: "quota", name: "weekly", remain_time: 360_000, total: 100, remain: 50 },
  ];
}

interface Setup {
  handlers: Map<string, Handler>;
  command: any;
  completions: ((prefix: string) => any) | undefined;
  sent: { content: string; options?: any }[];
  ctx: ReturnType<typeof makeCtx>;
  config: ResolvedConfig;
  fetch: ReturnType<typeof vi.fn>;
}

function setup(
  fetchImpl: () => Promise<any[]> = async () => items5h(false),
  config = makeConfig(),
): Setup {
  const { pi, handlers, commands, sent } = makePi();
  const fetch = vi.fn(fetchImpl);
  const provider: QuotaProvider = {
    name: "Mock",
    order: 30,
    providerIds: ["mock"],
    fetch: fetch as any,
  };
  const providers: DiscoveredProvider[] = [{ file: "30-mock.ts", provider }];
  setupSendOnRefilled(pi, () => providers, () => config);
  const ctx = makeCtx();
  const command = commands.get("quotas:send-message-on-refilled")!;
  return { handlers, command, completions: command.getArgumentCompletions, sent, ctx, config, fetch };
}

function notifies(s: Setup): string[] {
  return s.ctx.ui.notify.mock.calls.map((c: any[]) => c[0] as string);
}

async function armAndWait(s: Setup, args = "") {
  await s.command.handler(args, s.ctx);
}

/** Advance one poll interval and let the poll promise settle. */
async function tickPoll(s: Setup, ms = DEFAULT_SEND_ON_REFILLED.pollIntervalMs) {
  await vi.advanceTimersByTimeAsync(ms + 1);
}

// ─── Argument parsing ──────────────────────────────────────────────────────

describe("argument parsing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    clearCache();
  });

  it("empty args → default message, immediate send (quota available)", async () => {
    const s = setup(); // healthy quotas
    await armAndWait(s);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0].content).toBe(DEFAULT_SEND_ON_REFILLED.defaultMessage);
    expect(s.sent[0].options).toEqual({ deliverAs: "followUp" });
    expect(notifies(s).some((m) => m.includes("配额当前可用，消息已直接发出"))).toBe(true);
  });

  it("custom message is passed through verbatim after flags", async () => {
    const s = setup();
    await armAndWait(s, "--steer please continue the refactor");
    expect(s.sent[0].content).toBe("please continue the refactor");
    expect(s.sent[0].options).toEqual({ deliverAs: "steer" });
  });

  it("-- separator keeps a leading-dash message verbatim", async () => {
    const s = setup();
    await armAndWait(s, "-- --verbose-flag-command");
    expect(s.sent[0].content).toBe("--verbose-flag-command");
  });

  it("message containing flag-like words stays intact (index-of hazard)", async () => {
    const s = setup();
    await armAndWait(s, "--steer steer the ship");
    expect(s.sent[0].content).toBe("steer the ship");
  });

  it("unknown flag → usage error, nothing sent", async () => {
    const s = setup();
    await armAndWait(s, "--bogus hello");
    expect(s.sent).toHaveLength(0);
    expect(notifies(s).some((m) => m.includes("未知参数：--bogus"))).toBe(true);
  });

  it("config default message override is honored", async () => {
    const s = setup(async () => items5h(false), makeConfig({ defaultMessage: "custom default" }));
    await armAndWait(s);
    expect(s.sent[0].content).toBe("custom default");
  });
});

// ─── Arm paths ─────────────────────────────────────────────────────────────

describe("arm", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    clearCache();
  });

  it("no quota provider for current model → warning, nothing sent", async () => {
    const s = setup();
    s.ctx.model = { provider: "unknown", id: "u-1" };
    await armAndWait(s);
    expect(s.sent).toHaveLength(0);
    expect(notifies(s).some((m) => m.includes("没有配额 provider"))).toBe(true);
  });

  it("quota fetch failure at arm → warning, no wait armed", async () => {
    const s = setup(async () => {
      throw new Error("net down");
    });
    await armAndWait(s);
    expect(s.sent).toHaveLength(0);
    expect(notifies(s).some((m) => m.includes("未挂起等待"))).toBe(true);
    await tickPoll(s);
    expect(s.sent).toHaveLength(0);
  });

  it("exhausted → armed, notify summary, sends on refilled edge", async () => {
    let exhaustedNow = true;
    const s = setup(async () => items5h(exhaustedNow));
    await armAndWait(s, "继续刚才的工作");
    expect(s.sent).toHaveLength(0);
    expect(notifies(s).some((m) => m.includes("配额耗尽（5h）") && m.includes("已挂起等待"))).toBe(true);

    exhaustedNow = false;
    await tickPoll(s);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0].content).toBe("继续刚才的工作");
    expect(notifies(s).some((m) => m.includes("配额已恢复，消息已发出"))).toBe(true);
  });

  it("anchored windows all must recover (weekly still healthy is irrelevant; both-exhausted case)", async () => {
    const both = (a: boolean, b: boolean) => [
      { type: "quota", name: "5h", remain_time: 100, total: 100, remain: a ? 0 : 10 },
      { type: "quota", name: "weekly", remain_time: 100, total: 100, remain: b ? 0 : 10 },
    ];
    let state: [boolean, boolean] = [true, true];
    const s = setup(async () => both(...state));
    await armAndWait(s);
    expect(notifies(s).some((m) => m.includes("5h、weekly"))).toBe(true);

    state = [false, true]; // only 5h recovered
    await tickPoll(s);
    expect(s.sent).toHaveLength(0);

    state = [false, false]; // both recovered
    await tickPoll(s);
    expect(s.sent).toHaveLength(1);
  });

  it("balance exhaustion is anchored and edge-detected", async () => {
    let balance = 0;
    const s = setup(async () => [
      { type: "balance", currency: "usd" as const, balance },
    ]);
    await armAndWait(s);
    expect(notifies(s).some((m) => m.includes("配额耗尽（credit）"))).toBe(true);
    balance = 5;
    await tickPoll(s);
    expect(s.sent).toHaveLength(1);
  });

  it("re-arming replaces the previous wait with a notify", async () => {
    const s = setup(async () => items5h(true));
    await armAndWait(s, "first");
    await armAndWait(s, "second");
    expect(notifies(s).some((m) => m.includes("已替换之前的等待（Mock）"))).toBe(true);
    // Old timer cleared: even after the interval nothing from "first" sends.
    await tickPoll(s, DEFAULT_SEND_ON_REFILLED.pollIntervalMs * 3);
    expect(s.sent.filter((x) => x.content === "first")).toHaveLength(0);
  });

  it("--refilled-only with healthy quota → refuses to send", async () => {
    const s = setup();
    await armAndWait(s, "--refilled-only hello");
    expect(s.sent).toHaveLength(0);
    expect(notifies(s).some((m) => m.includes("严格边沿模式") && m.includes("未发送"))).toBe(true);
  });

  it("--cancel with an armed wait", async () => {
    const s = setup(async () => items5h(true));
    await armAndWait(s, "msg");
    await armAndWait(s, "--cancel");
    expect(notifies(s).some((m) => m.includes("已取消等待：Mock（手动取消）"))).toBe(true);
    await tickPoll(s, 180_000);
    expect(s.sent).toHaveLength(0);
  });

  it("--cancel with no wait", async () => {
    const s = setup();
    await armAndWait(s, "--cancel");
    expect(notifies(s).some((m) => m.includes("没有挂起中的等待"))).toBe(true);
  });
});

// ─── Cancellation events ───────────────────────────────────────────────────

describe("cancellation events", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    clearCache();
  });

  async function armed() {
    const s = setup(async () => items5h(true));
    await armAndWait(s, "msg");
    return s;
  }

  it("foreign agent_start cancels with notify", async () => {
    const s = await armed();
    await s.handlers.get("agent_start")!({}, s.ctx);
    expect(notifies(s).some((m) => m.includes("检测到新的对话"))).toBe(true);
    await tickPoll(s, 180_000);
    expect(s.sent).toHaveLength(0);
  });

  it("own agent_start (firingByUs) does not cancel", async () => {
    let exhausted = true;
    const s = setup(async () => items5h(exhausted));
    await armAndWait(s, "msg");
    exhausted = false;
    await tickPoll(s); // fires the message → firingByUs = true
    expect(s.sent).toHaveLength(1);
    await s.handlers.get("agent_start")!({}, s.ctx); // our own turn
    expect(notifies(s).some((m) => m.includes("已取消等待"))).toBe(false);
  });

  it("session_before_compact cancels", async () => {
    const s = await armed();
    await s.handlers.get("session_before_compact")!({}, s.ctx);
    expect(notifies(s).some((m) => m.includes("检测到 compaction"))).toBe(true);
  });

  it("session_compact is an idempotent backstop (silent)", async () => {
    const s = await armed();
    await s.handlers.get("session_before_compact")!({}, s.ctx);
    const before = notifies(s).length;
    await s.handlers.get("session_compact")!({}, s.ctx);
    expect(notifies(s).length).toBe(before);
  });

  it("same-provider model switch does NOT cancel", async () => {
    const s = await armed();
    await s.handlers.get("model_select")!({
      model: { provider: "mock", id: "mock-2" },
      previousModel: { provider: "mock", id: "mock-1" },
      source: "set",
    }, s.ctx);
    expect(notifies(s).some((m) => m.includes("已取消等待"))).toBe(false);
  });

  it("cross-provider switch cancels with from→to names", async () => {
    const s = await armed();
    await s.handlers.get("model_select")!({
      model: { provider: "kimi", id: "k-1" },
      previousModel: { provider: "mock", id: "mock-1" },
      source: "set",
    }, s.ctx);
    expect(notifies(s).some((m) => m.includes("provider 切换：mock → kimi"))).toBe(true);
  });

  it("session_start cleans up silently", async () => {
    const s = await armed();
    await s.handlers.get("session_start")!({}, s.ctx);
    expect(notifies(s).some((m) => m.includes("已取消等待"))).toBe(false);
    await tickPoll(s, 180_000);
    expect(s.sent).toHaveLength(0);
  });

  it("session_shutdown cleans up silently", async () => {
    const s = await armed();
    await s.handlers.get("session_shutdown")!({}, s.ctx);
    await tickPoll(s, 180_000);
    expect(s.sent).toHaveLength(0);
  });
});

// ─── Poll failure semantics ────────────────────────────────────────────────

describe("poll failure notifications", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    clearCache();
  });

  it("notifies once on first failure, stays silent while failing, re-notifies recovery", async () => {
    let failing = false;
    const s = setup(async () => {
      if (failing) throw new Error("boom");
      return items5h(true);
    });
    await armAndWait(s, "msg");

    failing = true;
    await tickPoll(s); // failure #1 → notify
    expect(notifies(s).filter((m) => m.includes("配额查询失败")).length).toBe(1);

    await tickPoll(s); // failure #2 → silent
    await tickPoll(s); // failure #3 → silent
    expect(notifies(s).filter((m) => m.includes("配额查询失败")).length).toBe(1);

    failing = false;
    await tickPoll(s); // recovery → notify once, keep waiting (still exhausted)
    expect(notifies(s).filter((m) => m.includes("配额查询已恢复")).length).toBe(1);
    expect(s.sent).toHaveLength(0);

    failing = true;
    await tickPoll(s); // new failure → notify again (state change)
    expect(notifies(s).filter((m) => m.includes("配额查询失败")).length).toBe(2);
  });
});

// ─── Watchdog ──────────────────────────────────────────────────────────────

describe("send watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    clearCache();
  });

  it("immediate send with no agent_start → watchdog failure notify", async () => {
    const s = setup();
    await armAndWait(s, "hello");
    expect(s.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000 + 100);
    expect(notifies(s).some((m) => m.includes("消息发送失败"))).toBe(true);
  });

  it("agent_start within the window disarms the watchdog", async () => {
    const s = setup();
    await armAndWait(s, "hello");
    await s.handlers.get("agent_start")!({}, s.ctx);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(notifies(s).some((m) => m.includes("消息发送失败"))).toBe(false);
  });

  it("edge-triggered send also watchdogs", async () => {
    let exhausted = true;
    const s = setup(async () => items5h(exhausted));
    await armAndWait(s, "msg");
    exhausted = false;
    await tickPoll(s);
    expect(s.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000 + 100);
    expect(notifies(s).some((m) => m.includes("消息发送失败"))).toBe(true);
  });

  it("firing while agent busy → no watchdog (queued message must not false-fail)", async () => {
    let exhausted = true;
    const s = setup(async () => items5h(exhausted));
    await armAndWait(s, "msg");
    s.ctx.isIdle = () => false; // same run still going at fire time
    exhausted = false;
    await tickPoll(s);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0].options).toEqual({ deliverAs: "followUp" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(notifies(s).some((m) => m.includes("消息发送失败"))).toBe(false);
  });

  it("immediate send while streaming → queued, no watchdog false-fail", async () => {
    const s = setup();
    s.ctx.isIdle = () => false;
    await armAndWait(s, "hello");
    expect(s.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(notifies(s).some((m) => m.includes("消息发送失败"))).toBe(false);
  });
});

// ─── Completions ───────────────────────────────────────────────────────────

describe("flag completions", () => {
  it("completes flags by prefix with trailing space and descriptions", () => {
    const s = setup();
    const refilled = s.completions!("--re");
    expect(refilled).not.toBeNull();
    expect(refilled.map((i: any) => i.value)).toEqual(["--refilled-only "]);
    expect(refilled[0].description).toBeTruthy();

    expect(s.completions!("--st")).not.toBeNull();
    expect(s.completions!("--ca")).not.toBeNull();
    expect(s.completions!("--st")!.map((i: any) => i.value)).toEqual(["--steer "]);

    expect(s.completions!("--nope")).toBeNull();
    // Non-flag last token → no completions (message typing).
    expect(s.completions!("hello the")).toBeNull();
    // Exact "--" is the separator — must not be completed into a flag.
    expect(s.completions!("keep going --")).toBeNull();
    expect(s.completions!("--")).toBeNull();
    // Last token flag, earlier message words present.
    expect(s.completions!("wait and --re")).not.toBeNull();
  });

  it("completions preserve tokens already typed (TUI replaces the whole argument text)", () => {
    const s = setup();
    // The reported bug: /quotas:... --a --st[tab] ate "--a".
    const fixed = s.completions!("--a --st")!;
    expect(fixed.map((i: any) => i.value)).toEqual(["--a --steer "]);
    expect(fixed[0].label).toBe("--steer");

    // Multiple prior flags survive; label stays the bare flag name.
    expect(s.completions!("--steer --ca")!.map((i: any) => i.value)).toEqual(["--steer --cancel "]);

    // Prefix rebuild is by last-token offset, so intra-token spacing survives.
    expect(s.completions!("wait and  --re")![0].value).toBe("wait and  --refilled-only ");

    // Only the flag fragment is shown; the message text is not re-offered.
    expect(s.completions!("--a --nope")).toBeNull();
  });
});
