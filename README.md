# pi-extendable-quota

Extensible quota monitor + send-message-on-refilled for [pi](https://pi.dev) — built-in providers auto-match, custom providers are dropped-in as TS files.

## Philosophy

A modernized fork of [latentminds-ai/pi-quotas](https://github.com/latentminds-ai/pi-quotas): same file-based provider discovery and quota data model, rebuilt around pi's current extension API with an explicit, data-driven resume flow.

- **Zero config.** Install the extension, providers auto-detect when they're active.
- **File-based discovery.** Drop a TS file in `~/.pi/pi-extendable-quota/`, it's picked up automatically.
- **Override by name.** User files with the same filename as a built-in provider override it.
- **Two data types.** Account balance (`type: "balance"`) and subscription quota (`type: "quota"`).
- **User-triggered resume.** `/quotas:send-message-on-refilled` waits (edge-triggered) for exhausted quota windows to refill, then sends your message. Purely data-driven — it never guesses why a turn ended.

> **Why not automatic resume?** We tried it and removed it: auto-resume
> inspected `message_end`/`agent_settled` to infer "quota hit". That inference
> proved unreliable — aborts of tool calls / compaction can be misclassified
> as provider errors, and extension-driven continuations race with retry
> timers — so we dropped it in favor of an explicit, data-driven wait.

## Install

```bash
# Global install
pi install /path/to/pi-extendable-quota

# Or project-local
pi install /path/to/pi-extendable-quota -l

# Or try without installing
pi -e /path/to/pi-extendable-quota/src/index.ts
```

## Usage

Once installed, the extension works automatically:

- **Footer status** — shows current provider's quota on the right side of the footer
- **`/quotas`** — display detailed quota info in a notification
- **`/quotas:refresh`** — force refresh cached data
- **`/quotas:send-message-on-refilled`** — wait for quota refill, then send a message

## `/quotas:send-message-on-refilled`

```
/quotas:send-message-on-refilled [--refilled-only] [--steer] [--cancel] [--] [message]
```

| Flag | Meaning |
|------|---------|
| `--refilled-only` | Strict edge mode: if quota is currently available, **refuse** to send (default: send immediately) |
| `--steer` | If the agent is busy when the wait triggers, insert the message as steering (default: queue as follow-up) |
| `--cancel` | Cancel a pending wait (distinct notify when nothing is pending) |
| `message` | Content sent on refill; omitted → built-in default (configurable) |
| `--` | Everything after is the message verbatim (for messages starting with `-`) |

Flow:

1. Anchors the currently-exhausted windows of the current provider's quota
   (`remain <= 0` quota windows, `balance <= 0` balances).
2. All currently available → sends immediately + notify「配额当前可用，消息已直接发出」
   (`--refilled-only` refuses instead).
3. Something exhausted → arms a poll (default 60s) and notifies
   「已挂起等待，恢复后发送：<summary>」. When **every anchored window is
   refilled** (`> 0`), the message is sent (+ notify).
4. Any user conversation activity cancels the wait (each with its own notify):
   a new agent turn, compaction, a **cross-provider** model switch, session
   change. Switching models within the same provider does not cancel — quota
   belongs to the provider account.

Single wait slot: invoking the command again replaces the previous wait (with a
notify). `--cancel` is the manual way out.

## Configuration

`~/.pi/pi-extendable-quota/config.json` (all fields optional; re-read on `/reload`):

```jsonc
{
  "display": {
    "footer": true,
    "warnings": true,
    "command": true,
    "refreshIntervalMs": 60000
  },
  "sendOnRefilled": {
    // Message used when the command is invoked without one.
    // Wrapping in <harness>…</harness> signals "environment speaking, not the
    // user" — modern models handle this without narrating it back.
    "defaultMessage": "<harness>\n[pi-extendable-quota] 自动唤醒：用户在配额耗尽时设置的等待已触发（配额现已恢复），本消息由插件代用户发出。\n上文末尾若有限流/报错残留，是当时的中断痕迹，无需处理。请直接从中断处继续未完成的工作，无需解释本消息。\n</harness>",
    "pollIntervalMs": 60000          // clamped to >= 30000
  },
  "providers": {
    "minimax-cn":  { "extraConfig": { "groupId": "10000" } }
  }
}
```

- `providers[id].extraConfig` — passed verbatim to that provider's `fetch`
- The current pi provider id wins, then the file's other `providerIds` in order

## Built-in Providers

| Provider file | pi provider ids | Data |
|---------------|-----------------|------|
| `30-anthropic.ts` | `anthropic` | Subscription quota windows (silent for direct `sk-ant-` keys) |
| `30-zai.ts` | `zai`, `zai-coding-cn` | Token window percentages (5h/weekly) |
| `30-kimi.ts` | `kimi-coding` | Subscription windows + weekly |
| `30-minimax.ts` | `minimax-cn`, `minimax` | Coding-plan interval + weekly |
| `30-openrouter.ts` | `openrouter` | Credit 余额 + key 限额窗口 + 原始用量 |
| `30-deepseek.ts` | `deepseek` | CNY/USD balance |

Notes:

- **MiniMax** needs a GroupId for quota display: set
  `providers["minimax-cn"].extraConfig.groupId` in `config.json` or the
  `MINIMAX_GROUP_ID` env var. Without it, display shows nothing (one warning is
  emitted).
- **OpenRouter** shows remaining usable credit = `min(key limit_remaining,
  account credits)`, plus a quota window when the key has a credit limit
  (`1d`/`1w`/`1mon`). Toggles via `providers["openrouter"].extraConfig`:
  `showCredit` / `showQuota` (both default `true`).
- Quota endpoints follow the current model's `baseUrl` origin, so CN/global
  deployments of the same provider are both covered.

## Custom Providers

Drop a `.ts` file into `~/.pi/pi-extendable-quota/`:

```typescript
// ~/.pi/pi-extendable-quota/30-my-corp.ts
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QuotaProvider, QuotaItem } from "@jeffguorg/pi-extendable-quota/src/types.js";

const provider: QuotaProvider = {
  name: "My Corp LLM",
  order: 30,
  providerIds: ["my-corp"],   // required
  async fetch(ctx: ExtensionContext, signal?: AbortSignal): Promise<QuotaItem[]> {
    const auth = await ctx.modelRegistry.getProviderAuth("my-corp");
    const token = auth?.auth?.apiKey;
    if (!token) return [];

    const resp = await fetch("https://api.corp.com/v1/quota", {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!resp.ok) return [];
    const data = await resp.json();

    return [
      { type: "balance", currency: "cny", balance: data.balance },
      {
        type: "quota",
        name: "daily",
        remain_time: data.daily.reset_in_seconds,
        total: data.daily.limit,
        remain: data.daily.remaining,
      },
    ];
  },
};

export default provider;
```

### Provider Interface

```typescript
interface QuotaProvider {
  name: string;
  order: number;
  providerIds: string[];                       // required; default matcher = providerIds.includes(ctx.model?.provider)
  matcher?(ctx: ExtensionContext): boolean;    // optional override
  fetch(ctx: ExtensionContext, signal?: AbortSignal, extraConfig?: Record<string, unknown>): Promise<QuotaItem[]>;
  ttlMs?: number;                              // default 60000
}
```

`extraConfig` is resolved by the framework from `config.json`: the current pi
provider id wins, then the file's other `providerIds` in order — so a `groupId`
configured under `minimax-cn` is also found when `minimax` is active.

**Coming from pi-quotas**: `providerIds` is required here (add
`providerIds: ["<pi-provider-id>"]` to your file; `matcher` becomes optional —
delete it if it just checked `ctx.model.provider`). Files without
`providerIds` are skipped with a warning. The upstream `retry()` hook,
`RetryInput`/`RetryOutcome` and the auto-resume config were removed;
`/quotas:send-message-on-refilled` is data-driven and needs nothing from
provider files beyond `fetch`.

### Data Model

```typescript
type QuotaItem =
  | { type: "balance";   currency: "cny" | "usd";  balance: number }
  | { type: "quota";     name: string;              remain_time: number;
                          total: number;             remain: number;
                          windowSeconds?: number }   // label derived: 30m/5h/3d/1w/1mon
```

## Development

```bash
git clone https://github.com/jeffguorg/pi-extendable-quota
cd pi-extendable-quota
npm install
npm test        # vitest
npm run typecheck
```

Test with pi:

```bash
pi -e ./src/index.ts
```
