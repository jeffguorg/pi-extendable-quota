import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import type { QuotaProvider } from "./types.js";

// ─── User provider directory ───────────────────────────────────────────────

export function userProviderDir(): string {
  return join(homedir(), ".pi", "pi-extendable-quota");
}

// ─── Built-in provider discovery ───────────────────────────────────────────

/**
 * Discover all .ts/.js files in the given directory (non-recursive),
 * sorted by filename (lexical = order prefix).
 */
function listProviderFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") || f.endsWith(".js"))
    .filter((f) => !f.startsWith("_"))
    .sort();
}

// ─── Dynamic import helper ─────────────────────────────────────────────────

/**
 * Load a provider module from a file path.
 * Uses dynamic import() — in pi's jiti context this handles TS files.
 */
async function loadProviderFile(filePath: string): Promise<QuotaProvider | null> {
  try {
    // Use file:// URL for cross-platform ESM compatibility
    const url = pathToFileURL(filePath).href;
    const mod = await import(url);
    const exported = mod.default ?? mod;
    // Accept both default export and named export `provider`
    const provider: QuotaProvider | undefined =
      exported?.provider ?? exported?.default ?? exported;
    if (!provider || typeof provider.fetch !== "function") {
      console.warn(`[pi-extendable-quota] ${basename(filePath)}: missing fetch, skipping`);
      return null;
    }
    if (
      !Array.isArray(provider.providerIds) ||
      provider.providerIds.length === 0 ||
      provider.providerIds.some((id) => typeof id !== "string")
    ) {
      console.warn(
        `[pi-extendable-quota] ${basename(filePath)}: missing required providerIds (string[]), skipping`,
      );
      return null;
    }
    if (provider.matcher !== undefined && typeof provider.matcher !== "function") {
      console.warn(`[pi-extendable-quota] ${basename(filePath)}: matcher must be a function, skipping`);
      return null;
    }
    return provider;
  } catch (err) {
    console.warn(`[pi-extendable-quota] failed to load ${basename(filePath)}:`, err);
    return null;
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

export interface DiscoveredProvider {
  file: string;
  provider: QuotaProvider;
}

/**
 * Discover all providers from built-in and user directories.
 * User files with the same basename override built-in ones.
 */
export async function discoverProviders(builtInDir: string): Promise<DiscoveredProvider[]> {
  const seen = new Set<string>();
  const result: DiscoveredProvider[] = [];

  // 1. Built-in (lower priority, may be overridden)
  for (const f of listProviderFiles(builtInDir)) {
    const fullPath = join(builtInDir, f);
    const provider = await loadProviderFile(fullPath);
    if (provider) {
      seen.add(f);
      result.push({ file: f, provider });
    }
  }

  // 2. User directory (higher priority — overrides built-in by same name)
  const userDir = userProviderDir();
  for (const f of listProviderFiles(userDir)) {
    const fullPath = join(userDir, f);
    // Remove any previously loaded built-in with same name
    if (seen.has(f)) {
      const idx = result.findIndex((r) => r.file === f);
      if (idx !== -1) result.splice(idx, 1);
    }
    const provider = await loadProviderFile(fullPath);
    if (provider) {
      seen.add(f);
      result.push({ file: f, provider });
    }
  }

  // 3. Sort by order
  result.sort((a, b) => a.provider.order - b.provider.order);
  return result;
}