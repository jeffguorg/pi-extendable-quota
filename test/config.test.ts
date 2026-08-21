import { describe, expect, it } from "vitest";
import { DEFAULT_DISPLAY, DEFAULT_SEND_ON_REFILLED, resolveExtraConfig, type ResolvedConfig } from "../src/config.js";

function makeConfig(providers: ResolvedConfig["providers"] = {}): ResolvedConfig {
  return {
    display: { ...DEFAULT_DISPLAY },
    sendOnRefilled: { ...DEFAULT_SEND_ON_REFILLED },
    providers,
  };
}

describe("resolveExtraConfig", () => {
  const ids = ["minimax-cn", "minimax"];

  it("returns {} when nothing is configured", () => {
    expect(resolveExtraConfig(makeConfig(), ids, "minimax-cn")).toEqual({});
  });

  it("prefers the preferred id's extraConfig", () => {
    const config = makeConfig({
      "minimax-cn": { extraConfig: { groupId: "cn" } },
      minimax: { extraConfig: { groupId: "global" } },
    });
    expect(resolveExtraConfig(config, ids, "minimax")).toEqual({ groupId: "global" });
    expect(resolveExtraConfig(config, ids, "minimax-cn")).toEqual({ groupId: "cn" });
  });

  it("falls back to other providerIds in file order when preferred id has none", () => {
    const config = makeConfig({ "minimax-cn": { extraConfig: { groupId: "cn" } } });
    // Current provider is "minimax" but only "minimax-cn" is configured → still found.
    expect(resolveExtraConfig(config, ids, "minimax")).toEqual({ groupId: "cn" });
  });

  it("unknown preferred id → file order", () => {
    const config = makeConfig({ minimax: { extraConfig: { groupId: "global" } } });
    expect(resolveExtraConfig(config, ids, "something-else")).toEqual({ groupId: "global" });
  });
});
