# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

This directory (`pi-web-enhanced/`) is the git repo root. Its sibling `../pi-web-access/` is the upstream project this was forked from — treat it as reference only, never as a build target.

## What this is

A Pi coding-agent extension: a single ESM TypeScript package that registers `web_search`, `web_search_enhanced`, `fetch_content`, `get_search_content`, and `source_check` (plus the `web_enable` loader tool and the `/search` command). `package.json` declares `"pi": { "extensions": ["./index.ts"] }` — Pi loads the raw TypeScript via jiti in development and the prebuilt `dist/` bundle when installed from npm.

This fork deliberately removed the upstream curator UI, the `summary-review` / `auto-summary` workflows, generated summaries, all video support, the hosted PDF engines, and ~22 search providers. Do not reintroduce them without being asked.

## Commands

Requires Node 24 (CI pins 24; native type stripping means no build step is needed to run tests).

```bash
npm ci                              # install (node_modules is gitignored)
npm run typecheck                   # tsc, noEmit, include: ["*.ts"] only
npm test                            # node --import ./test/isolate-env.mjs --test
node --import ./test/isolate-env.mjs --test test/ssrf-protection.test.mjs   # single file
npm test -- --test-concurrency=2    # what CI runs
npm run build                       # esbuild bundle index.ts -> dist/
npm run audit:runtime               # npm audit --omit=dev --omit=peer
```

Always narrow to a file while iterating. There is no lint step — `tsc` is the only static gate. A couple of tests (the GitHub clone ones, and the Readability fallback in `fetch-content-domain-policy.test.mjs`) are timing-sensitive and occasionally fail when the whole suite runs under load; verify a failure in isolation before treating it as real.

Release: `npm run release` wraps `npm publish` so `pi.extensions` points at `./dist` during publish and is restored to `./index.ts`. If a publish is interrupted, `git checkout -- package.json` restores the manifest.

## Architecture

### Entry point

`index.ts` is the whole extension surface — `export default function (pi: ExtensionAPI)`. It loads config, resolves feature flags, tool activation, and the provider allowlist, then registers tools/commands/shortcuts/widgets.

The two search tools come from one local factory, `createWebSearchTool(mode)` (`mode: "balanced" | "enhanced"`), wrapped in `defineTool(...)` so TypeBox parameter types stay inferred. Registering them from a separate module would need eight injected dependencies, so keep the factory inside the default export. `fetch_content`, `get_search_content`, and `source_check` are registered inline.

`createWebSearchTool` calls `search(query, { provider, selectionMode: mode, ... })` and then `buildSearchReturn(...)`, which bounds the output, stores the results, and emits the `responseId` retrieval guidance.

### Search providers

Nine providers, all sharing one contract. Canonical types live in `search-types.ts` (`SearchResult`, `SearchResponse`, `SearchOptions`) — do not redefine them.

- `export function isXAvailable(): boolean`
- `export async function searchWithX(query: string, options: SearchOptions): Promise<SearchResponse>`

`search.ts` is the dispatcher: it owns `RESOLVED_SEARCH_PROVIDERS`, `ALL_SEARCH_PROVIDERS`, `providerLabel`, `SearchProviderError` + `SearchProviderErrorKind`, the `search()` entry point, and the automatic fallback chain.

- `RESOLVED_SEARCH_PROVIDERS` = exa, tavily, anysearch, tinyfish, serpapi, firecrawl, brave, duckduckgo, querit.
- `ALL_SEARCH_PROVIDERS` = exa, brave, tinyfish, tavily, firecrawl. AnySearch, SerpApi, DuckDuckGo, and Querit are **explicit-only**: they are absent from `ALL_SEARCH_PROVIDERS` and from the automatic chain, so `auto` and `all` never reach them. An explicit id, an explicit array, or `searchRouting.providers` can still select them.
- Adding a provider means: a new `x.ts` with the two exports, an entry in `RESOLVED_SEARCH_PROVIDERS`, a branch in `searchWithResolvedProvider` and `isResolvedProviderAvailable`, a label in `providerLabel`, an import in `index.ts`, and a test.

### Weighted provider selection

`search-provider-weights.ts` implements balanced mode:

- `parseProviderWeights(value, allowedProviders, label)` returns `null` for anything that is not the `[[name, positiveIntegerWeight], ...]` tuple form, so the caller falls back to plain string/array selection. It throws on malformed tuples, unknown providers, duplicates, and weights that are not positive integers (zero, negative, and fractional are all rejected); weights are not clamped.
- `sampleWeightedProvider(weights, isAvailable, random = Math.random)` filters to providers with usable credentials **first**, then samples with `wᵢ / Σ wⱼ`, typically reading each weight as a provider's request budget over a common window. Pass a seeded `random` in tests for deterministic draws.
- `search.ts` caches the parsed weight table but **never** the sampled provider — sampling happens once per call inside `search()`. `cachedSearchConfig` is memoized for the process lifetime, so tests must set `PI_CODING_AGENT_DIR` before importing.
- `selectionMode` defaults to `"balanced"`, so any caller that omits it (for example `source_check`) gets one provider per query, not a fan-out.

### Balanced retry and routing fallback

`search()` runs the balanced resolution — weighted sample / plain string / explicit array / `all` / the automatic chain — in a retry loop of `config.retry` **total** attempts (default `1`, so an unconfigured `retry` preserves single-attempt behavior). Each attempt re-resolves the selection, so a weighted retry re-samples and can land on a different provider. Aborts and `CredentialResolutionError` propagate immediately instead of retrying.

When every attempt fails **and** `searchRouting` is configured, `searchWithConfiguredRouting` runs as the last-resort fallback; if it also fails, the two error sets are combined into one `Balanced search failed after N attempts: … searchRouting fallback failed: …` error. With a single failed attempt and no routing, the original error object is rethrown unchanged, which keeps upstream error-message tests valid.

Original behavior is preserved for the one case where routing was already the primary: no `provider`/`searchProvider` configured + `searchRouting` set → the routing rotation runs directly (no retry wrapper). `web_search_enhanced` (`selectionMode: "enhanced"`) is a single fan-out and is not retried.

### Fetch / extract

`extractContent(url, signal, options)` in `extract.ts` is the dispatcher: SSRF preflight → auth-fetch/`raw` short-circuit → image gate → GitHub issue/PR → GitHub repo → the `fetchRouting` provider chain.

`FETCH_PROVIDERS` is `["http", "firecrawl", "tinyfish", "querit"]`; the default order is the same. `REMOTE_HOSTED_FETCH_PROVIDERS` is `{"tinyfish", "querit"}` — they perform their own fetch, so for remote HTTP(S) targets they are filtered out unless `fetchRouting.allowRemoteHostedProviders` is true. Firecrawl is *not* remote-hosted. When the first provider is not `http`, an HTTP probe still runs first.

Three modes flow through `fetch-params.ts`: `readable`, `raw` (exact textual body, no readability, no hosted fallbacks), `answer` (page-grounded Q&A via `page-query.ts`, which wraps page text in `<untrusted_page_content>` as prompt-injection defense).

### Config

`web-search-enhanced.json` under the Pi agent dir — deliberately a different filename than upstream pi-web-access's `web-search.json`, so the two extensions can coexist. The name is centralized in `utils.ts` (`CONFIG_FILE_NAME`). `getWebSearchConfigDir()` (`utils.ts`) resolves `PI_CODING_AGENT_DIR` → `$XDG_CONFIG_HOME/pi` (only if the file already exists) → legacy `~/.pi` → `~/.pi/agent`, and memoizes the result for the process lifetime.

Precedence worth remembering: an environment variable beats a literal config value for credentials (`credential-source.ts`); per-call `proxy` beats config `proxy`; `NO_PROXY`, localhost, and `127.0.0.1` are never proxied (proxying shells out to `curl`, not undici).

`resolveRequestedProvider` in `index.ts` returns `"auto"` when the configured provider is a weighted tuple list, so `search()` performs the weighted sampling. A config naming a provider that no longer exists throws with the config path and the offending name — that is intentional (`CHANGELOG.md` documents it under Migration).

### Cross-cutting safety

- `ssrf-protection.ts`: HTTP(S) only, blocks localhost and private/reserved v4+v6 ranges, re-validates every redirect (max 5), downgrades POST→GET on 301/302/303. Knobs: `ssrf.allowRanges` (CIDR) and `ssrf.trustEnvProxy`.
- `data-uri-sanitize.ts`: replaces inline `data:` URIs with bounded markers + sha256 so base64 payloads never reach model output, the fetch cache, or session persistence.
- `auth-fetch.ts`: HTTPS only, host allowlist, same-origin redirects only; never sends cookies to hosted providers. Browser cookie extraction stays opt-in (`allowBrowserCookies` / `PI_ALLOW_BROWSER_COOKIES`).
- `storage.ts`: in-memory map + `web-search-cache` dir (`PI_WEB_ACCESS_CACHE_ROOT` overrides), 1 h TTL, 128 entries / 128 MiB, LRU prune, `O_NOFOLLOW` defenses, `0600`/`0700` modes, atomic writes.
- `render-search-error.ts:buildSearchErrorPlan()` is a pure, pi-tui-free renderer returning `{expanded, collapsed, expandHint}`. `test/search-error-render.test.mjs` counts its call sites in `index.ts`, so adding or removing an error branch will fail that test.

## Testing conventions

Tests are `.mjs` files in `test/` run by Node's built-in runner, importing `.ts` modules directly (native type stripping — no jiti/tsx). Two import styles:

1. **In-process** for pure modules: `import { resolveCredential } from "../credential-source.ts"`.
2. **Subprocess** for anything that captures config at import time or needs a real extension instance: `spawnSync(process.execPath, ["--input-type=module"], { input: script, env: childEnv })` with `await import(...)` inside and JSON on stdout.

`test/isolate-env.mjs` runs before every test file and (a) deletes `PI_WEB_ACCESS_CACHE_ROOT`, and (b) pins `PI_CODING_AGENT_DIR` to a fresh empty temp dir. (b) matters: without it, an in-process test reads the developer's real `~/.pi/agent/web-search-enhanced.json`, and any provider named there changes what the shared config path resolves to. Tests that need a specific config must spawn a child with their own `PI_CODING_AGENT_DIR`, `HOME`, and `USERPROFILE` — several upstream tests forgot `HOME`, so add all three.

Mocking: prefer the module's injectable seams (`runCommand`, `lookup`, `now`/`sleep`); otherwise stub `globalThis.fetch` inside the child.

`test/tool-registration-config.test.mjs` pins sha256 hashes of every tool's `{name, description, parameters}`. **Any change to a tool description or schema breaks it** — recompute the hashes from the assertion diff rather than deleting the test.

## Invariants that are easy to break

- Config path and `feature-config.ts` are computed **at import time**; set env vars before importing.
- Memoized singletons with no invalidation hook: the config dir (`utils.ts`), `cachedSearchConfig` (`search.ts`), `extractModulePromise` (`index.ts`).
- Tool registration is a snapshot taken at init; later config edits only affect per-call `loadConfig()` paths. Pi must be restarted for registration changes.
- `isToolEnabled` deliberately makes `tools.webSearch.enabled` gate `web_search_enhanced` too, unless `tools.webSearchEnhanced` has its own entry. Changing that silently re-registers a disabled capability.
- `web_enable` is a reserved tool name; `resolveToolNames` rejects duplicates and that name.
- `abortable.ts` is not imported by `index.ts`; it exists for the cold-start `awaitWithAbort` pattern in `page-query.ts`.
- Several tests read `index.ts` as text and regex for registration call shapes (`provider-precedence`, `search-error-render`, `lazy-extract-load`), so keep the factory and `pi.registerTool(createWebSearchTool(...))` calls recognizable.
