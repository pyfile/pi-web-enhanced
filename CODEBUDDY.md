# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

The project lives in `pi-web-access/` (the git repo root), not the outer workspace folder. Run every command from `pi-web-access/`.

## What this is

`pi-web-access` is a Pi coding-agent extension: a single ESM TypeScript package that registers the `web_search`, `fetch_content`, `get_search_content`, and `source_check` tools (plus `web_enable`, `/websearch`, `/curator`, `/search`, `/google-account` commands) into the Pi agent. `package.json` declares `"pi": { "extensions": ["./index.ts"] }` — Pi loads the raw TypeScript via jiti in development, and the prebuilt `dist/` bundle when installed from npm.

## Commands

Requires Node 24 (CI pins 24; native type stripping means no build step is needed to run tests).

```bash
npm ci                              # install (node_modules is gitignored)
npm run typecheck                   # tsc, noEmit, include: ["*.ts"] only
npm test                            # node --import ./test/isolate-env.mjs --test  (whole suite)
node --test test/ssrf-protection.test.mjs          # single test file
npm test -- --test-concurrency=2    # what CI runs
npm run build                       # esbuild bundle index.ts -> dist/
npm run audit:runtime               # npm audit --omit=dev --omit=peer
```

`npm test` with no path runs all 100+ files in `test/`; always narrow to a file while iterating. There is no lint step — `tsc` is the only static gate.

Release: `npm run release` wraps `npm publish` so `pi.extensions` points at `./dist` during publish and is restored to `./index.ts` (`scripts/pi-extensions-dist.js`, `scripts/publish.js`). If a publish is interrupted, `git checkout -- package.json` restores the manifest.

## Architecture

### Entry point

`index.ts` (156 KB) is the whole extension surface: `export default function (pi: ExtensionAPI)` at `index.ts:1081`. It loads config, resolves feature flags (`feature-config.ts`), tool activation (`tool-activation.ts`), the provider allowlist, and curator run state, then registers tools/commands/shortcuts/widgets.

Tool registration shape is `{ name, label, description, promptSnippet, parameters: Type.Object({...}) (TypeBox), prepareArguments?, execute(callId, params, signal, onUpdate, ctx), renderCall?, renderResult? }`. `StringEnum` (`index.ts:95`) is a local `Type.Unsafe` shim used instead of the pi-ai compat barrel to keep registration cheap.

| Tool | Registered | Real work |
| --- | --- | --- |
| `web_search` | `index.ts:1838` | `search()` in `gemini-search.ts`; curator branch via `curator-server.ts` + `summary-review.ts` |
| `source_check` | `index.ts:2437` | `source-check.ts`, rendered by `formatSourceCheckResult` |
| `fetch_content` | `index.ts:2536` | `fetch-params.ts` normalization → `extract.ts` (lazy import) → `page-query.ts` for `answer` mode |
| `get_search_content` | `index.ts:2891` | `storage.ts` + `content-find.ts` |
| `web_enable` | `tool-activation.ts:73` | toggles `pi.setActiveTools` for dynamic activation |

`index.ts` imports ~35 provider modules, but only for their `isXAvailable()` probes; the heavy extraction path is deliberately deferred behind `extractModulePromise` (`index.ts:108`), a cached `import("./extract.ts")`.

### Search providers

Every provider module has the same contract. Canonical types live in `perplexity.ts` (`SearchResult`, `SearchResponse`, `SearchOptions`) and are `import type`d by all other providers — do not redefine them.

- `export function isXAvailable(): boolean`
- `export async function searchWithX(query: string, options: SearchOptions): Promise<SearchResponse>`

Documented deviations: `isOpenAISearchAvailable(ctx?)` / `isXaiSearchAvailable(ctx?)` / `isKimiSearchAvailable(ctx?)` are async because they need Pi `ctx`; `searchWithExa` returns `ExaSearchResult` instead of `SearchResponse`; several providers extend `SearchOptions` (`TavilySearchOptions`, `KagiSearchOptions`, …).

Formal error classification is in `gemini-search.ts`: `SearchProviderErrorKind` (union of `transient|quota|network|credential|config|auth|invalid-request|invalid-response|unsupported|aborted|unknown`) and `class SearchProviderError`. Aggregation is also there: `AttributedSearchResponse`, `search()` dispatcher, `ALL_SEARCH_PROVIDERS`, `normalizeSearchRouting` with `fallbackOn` (`transient`, `quota`, `network`, `invalid-response`, `unsupported`).

Adding a provider means: a new `x.ts` with the two exports above, an entry in `ALL_SEARCH_PROVIDERS` / `getAllowedSearchProviders`, an `isXAvailable` import in `index.ts`, and a `test/x-provider.test.mjs`. Many providers are "explicit-only" (never in the automatic chain): Bright Data, SerpBase, SerpApi, Serper, Serply, You.com, Baizhi, Z.ai, AnySearch, XCrawl, Valyu, xAI, Mistral, Kimi, DuckDuckGo, Parallel MCP.

### Fetch / extract

`extractContent(url, signal, options)` (`extract.ts:524`) is the dispatcher: SSRF preflight → auth-fetch / `raw` short-circuit → image & frame gates → local video → GitHub issue/PR → GitHub repo → YouTube → the `fetchRouting` provider chain. Remote-hosted fetch providers are filtered out unless `fetchRouting.allowRemoteHostedProviders` is true. Three modes flow through `fetch-params.ts`: `readable`, `raw` (exact textual body, no readability, no hosted fallbacks), `answer` (grounded Q&A via `page-query.ts`, which wraps the page in `<untrusted_page_content>` as prompt-injection defense).

### Config

`web-search.json` under the Pi agent dir. `getWebSearchConfigDir()` (`utils.ts:11`) resolves `PI_CODING_AGENT_DIR` → `$XDG_CONFIG_HOME/pi` (only if the file already exists) → legacy `~/.pi` → `~/.pi/agent`, and **memoizes the result for the process lifetime** (`utils.ts:9`). `loadConfig()` re-reads the file on every call; `loadConfigForExtensionInit()` swallows parse errors and returns `{}`.

Precedence worth remembering: an environment variable beats a literal config value for credentials (`credential-source.ts:191`); per-call `proxy` beats config `proxy`; `NO_PROXY`, localhost, and `127.0.0.1` are never proxied (proxying shells out to `curl`, not undici).

### Cross-cutting safety

- `ssrf-protection.ts`: `validateRemoteUrl` allows HTTP(S) only, blocks localhost and private/reserved v4+v6 ranges, re-validates every redirect (max 5), downgrades POST→GET on 301/302/303. Rusty toggle: `ssrf.allowRanges` (CIDR) and `ssrf.trustEnvProxy` (skip local DNS preflight for proxied hosts).
- `data-uri-sanitize.ts`: replaces inline `data:` URIs with bounded markers + sha256 so base64 payloads never reach model output, the fetch cache, or session persistence.
- `auth-fetch.ts`: HTTPS only, host allowlist, same-origin redirects only; never sends cookies to hosted providers. Browser cookie extraction stays opt-in (`allowBrowserCookies` / `PI_ALLOW_BROWSER_COOKIES`).
- `storage.ts`: in-memory map + `web-search-cache` dir (`PI_WEB_ACCESS_CACHE_ROOT` overrides location), 1 h TTL, 128 entries / 128 MiB, LRU prune, `O_NOFOLLOW` symlink defenses, `0600`/`0700` modes, atomic writes.
- Timeouts/deadlines: `pLimit` caps batch search at 3 concurrent; the Brave queue honors `X-RateLimit-*`; the summary draft has a bounded deadline (`SUMMARY_GENERATION_DEADLINE_MS`) with a deterministic fallback in `summary-review.ts`.
- `render-search-error.ts:buildSearchErrorPlan()` is a pure, pi-tui-free renderer returning `{expanded, collapsed, expandHint}` — keep it dependency-free so it stays directly testable.

### Curator

`curator-server.ts:startCuratorServer()` binds port 0 (ephemeral) on `127.0.0.1` by default (`curatorRemote: true` → `0.0.0.0` + hostname), serves `http://<host>:<port>/?session=<token>`, and checks a caller-generated `randomUUID()` token on every POST and SSE endpoint. `curator-page.ts` generates the entire self-contained HTML page. Default curator timeout is 20 s local / 60 s remote, capped at 600 s; on timeout it auto-submits and falls back to a deterministic summary.

## Testing conventions

Tests are `.mjs` files in `test/` run by Node's built-in runner, importing `.ts` modules directly (native type stripping — no jiti/tsx, no transpile step). Two import styles:

1. **In-process** for pure modules: `import { resolveCredential } from "../credential-source.ts"`.
2. **Subprocess** for modules that capture config at import time: `spawnSync(process.execPath, ["--input-type=module"], { input: script, env: childEnv })` with `await import(...)` inside the script and JSON on stdout (see `test/duckduckgo-provider.test.mjs:11`). Required because `getWebSearchConfigPath()` runs at module scope in `index.ts`, `ssrf-protection.ts`, and `feature-config.ts` — env vars must be set *before* the import.

Mocking: prefer the module's existing injectable seams (`runCommand`, `lookup`, `now`/`sleep`, `setGeminiFetchOverrideForTests`); otherwise stub `globalThis.fetch` inside the child process and point `HOME`/`PI_CODING_AGENT_DIR` at an `mkdtemp` dir containing a written `web-search.json`. `test/isolate-env.mjs` only deletes `PI_WEB_ACCESS_CACHE_ROOT` so a shell-exported cache root cannot leak into tests.

## Invariants that are easy to break

- Config path, `feature-config`, and SSRF config are computed **at import time**; any test touching them must set env vars before importing.
- Memoized singletons with no invalidation hook: config dir (`utils.ts:9`), `cachedSearchConfig` (`gemini-search.ts:128`), `extractModulePromise` (`index.ts:108`).
- Tool registration is a snapshot taken at init. Later config edits only affect per-call `loadConfig()` paths, never the set of registered tools — Pi must be restarted for registration changes.
- `web_enable` is a reserved tool name (`resolveToolNames` rejects duplicates).
- `abortable.ts` is intentionally not imported by `index.ts`; it exists for the cold-start `awaitWithAbort` pattern used in `page-query.ts` and `query-rewrite.ts`.
- Some tests assert call shapes by regex and occurrence count (e.g. `test/summary-model-scope.test.mjs:317`, `test/auto-summary-source.test.mjs:22` count `generateSummaryDraft(` occurrences). Reordering arguments breaks them.
- `README.md` is the user-facing spec (113 KB) and ends with a `Files` table mapping every module to its purpose; `CHANGELOG.md` is maintained per release with an `[Unreleased]` section at the top. Update both when behavior changes.
