import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QuotaItem, QuotaProvider } from "./types.js";

interface CacheEntry {
  items: QuotaItem[];
  fetchedAt: number;
  ttlMs: number;
}

const cache = new Map<string, CacheEntry>();

export function clearCache(providerName?: string): void {
  if (providerName) cache.delete(providerName);
  else cache.clear();
}

export async function fetchWithCache(
  provider: QuotaProvider,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  force = false,
  extraConfig?: Record<string, unknown>,
): Promise<QuotaItem[]> {
  const ttl = provider.ttlMs ?? 60_000;
  const now = Date.now();
  const entry = cache.get(provider.name);

  if (!force && entry && now - entry.fetchedAt < entry.ttlMs) {
    return entry.items;
  }

  const items = await provider.fetch(ctx, signal, extraConfig);
  cache.set(provider.name, { items, fetchedAt: Date.now(), ttlMs: ttl });
  return items;
}