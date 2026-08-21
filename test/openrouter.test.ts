import { afterEach, describe, expect, it, vi } from "vitest";
import provider from "../src/built-in/30-openrouter.js";

// ─── Mocks ─────────────────────────────────────────────────────────────────

const KEY_NO_LIMIT = {
  data: { limit: null, limit_reset: null, limit_remaining: null, usage: 25.9 },
};

const KEY_WITH_LIMIT = {
  data: { limit: 5, limit_reset: "weekly", limit_remaining: 5, usage: 0 },
};

const CREDITS_11 = { data: { total_credits: 200, total_usage: 189 } }; // → $11
const CREDITS_3 = { data: { total_credits: 200, total_usage: 197 } }; // → $3

function mockFetch(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: unknown) => {
    const u = String(url);
    calls.push(u);
    const body = routes[u];
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) } as Response;
    return { ok: true, status: 200, json: async () => body } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

function makeCtx() {
  return {
    modelRegistry: {
      getProviderAuth: async () => ({ auth: { apiKey: "sk-or-test" } }),
    },
  } as any;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("openrouter provider", () => {
  it("key without limit: no quota item, credit = account credits", async () => {
    mockFetch({
      "https://openrouter.ai/api/v1/key": KEY_NO_LIMIT,
      "https://openrouter.ai/api/v1/credits": CREDITS_11,
    });
    const items = await provider.fetch(makeCtx());
    expect(items).toEqual([{ type: "balance", currency: "usd", balance: 11 }]);
  });

  it("null limit_remaining must not become $0.00 (regression: Number(null)===0)", async () => {
    mockFetch({
      "https://openrouter.ai/api/v1/key": KEY_NO_LIMIT,
      "https://openrouter.ai/api/v1/credits": CREDITS_11,
    });
    const items = await provider.fetch(makeCtx());
    const balance = items.find((i) => i.type === "balance");
    expect(balance && balance.type === "balance" && balance.balance).toBeGreaterThan(0);
  });

  it("limit $5, credits $11 → rem $5 (limit wins)", async () => {
    mockFetch({
      "https://openrouter.ai/api/v1/key": KEY_WITH_LIMIT,
      "https://openrouter.ai/api/v1/credits": CREDITS_11,
    });
    const items = await provider.fetch(makeCtx());
    expect(items).toContainEqual({ type: "balance", currency: "usd", balance: 5 });
    const quota = items.find((i) => i.type === "quota");
    expect(quota).toMatchObject({ type: "quota", total: 5, remain: 5, windowSeconds: 604_800 });
  });

  it("limit $5, credits $3 → rem $3 (credits win), pct consistent (3/5)", async () => {
    mockFetch({
      "https://openrouter.ai/api/v1/key": KEY_WITH_LIMIT,
      "https://openrouter.ai/api/v1/credits": CREDITS_3,
    });
    const items = await provider.fetch(makeCtx());
    expect(items).toContainEqual({ type: "balance", currency: "usd", balance: 3 });
    const quota = items.find((i) => i.type === "quota");
    expect(quota).toMatchObject({ type: "quota", total: 5, remain: 3 });
  });

  it("/credits failure with limited key degrades to limit_remaining", async () => {
    mockFetch({ "https://openrouter.ai/api/v1/key": KEY_WITH_LIMIT });
    const items = await provider.fetch(makeCtx());
    expect(items).toContainEqual({ type: "balance", currency: "usd", balance: 5 });
  });

  it("showQuota=false hides the window; showCredit=false hides balance", async () => {
    mockFetch({
      "https://openrouter.ai/api/v1/key": KEY_WITH_LIMIT,
      "https://openrouter.ai/api/v1/credits": CREDITS_11,
    });
    const items = await provider.fetch(makeCtx(), undefined, { showQuota: false, showCredit: false });
    expect(items).toEqual([]);
  });

  it("no limit → quota never shown even with showQuota=true", async () => {
    mockFetch({
      "https://openrouter.ai/api/v1/key": KEY_NO_LIMIT,
      "https://openrouter.ai/api/v1/credits": CREDITS_11,
    });
    const items = await provider.fetch(makeCtx(), undefined, { showQuota: true });
    expect(items.every((i) => i.type === "balance")).toBe(true);
  });

  it("/key request failure → empty", async () => {
    mockFetch({});
    expect(await provider.fetch(makeCtx())).toEqual([]);
  });
});
