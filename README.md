# Pi Web Enhanced

**Web search, content extraction, GitHub cloning, and local PDF extraction for the Pi coding agent — a trimmed, opinionated fork of [pi-web-access](https://github.com/nicobailon/pi-web-access).**

Nine search providers (Exa, Tavily, AnySearch, TinyFish, SerpApi, Firecrawl, Brave, DuckDuckGo, Querit), two search tools (`web_search` for weighted balanced search, `web_search_enhanced` for all-provider search), four fetch providers, and local-only PDF parsing. No curator UI, no generated summaries, no video pipeline, no hosted PDF engines.

## Install

```bash
pi install npm:pi-web-enhanced
```

Requires Pi v0.37.3+.

Works immediately with no API keys: Exa runs through its zero-config MCP endpoint, and DuckDuckGo needs no key at all. Add keys to `~/.pi/agent/web-search-enhanced.json` for more providers:

```json
{
  "exaApiKey": "exa-...",
  "braveApiKey": "BSA_...",
  "tavilyApiKey": "tvly-...",
  "tinyfishApiKey": "sk-tinyfish-...",
  "serpapiApiKey": "...",
  "firecrawlBaseUrl": "https://your-firecrawl.example.com",
  "anysearchApiKey": "..."
}
```

## Tools

### web_search — balanced

The default search tool. When `provider` in `web-search-enhanced.json` is a **weighted list**, every call samples exactly one provider from it:

```json
{
  "provider": [["exa", 60], ["brave", 30], ["tavily", 10]],
  "exaApiKey": "exa-...",
  "braveApiKey": "BSA_...",
  "tavilyApiKey": "tvly-..."
}
```

The probability of picking provider *i* is `wᵢ / Σ wⱼ`. Weights are usually a provider's request budget over a common window (requests per minute/hour/day/month), so the mix tracks each provider's allowance. Rules:

- Each weight must be a **positive integer**; zero, negative, and fractional weights are rejected.
- Providers in the list without usable credentials are dropped **before** sampling, so the remaining weights keep their relative proportions.
- Duplicate entries, unknown provider names, and non-positive or non-integer weights are rejected with a message naming the config file.
- If none of the listed providers has credentials, the call falls back to the automatic provider chain instead of failing.

**Retries and routing fallback.** Set `"retry": N` to allow up to `N` total attempts per balanced call (default `1`, i.e. a single attempt). Each retry re-samples the weighted list, so a retry can land on a different provider. If every attempt fails and `searchRouting` is configured, the call then runs the routing rotation (`searchRouting.providers` in order, honouring `fallbackOn`) as a last resort.

A plain string still works and pins one provider: `"provider": "brave"`. Omitting `provider` (or setting it to `"auto"`) uses the automatic chain: Exa → Brave → Tavily → Firecrawl → TinyFish.

`web_search` returns bounded, source-linked results, identifies the provider used for each query, and stores the full results for retrieval by `responseId`. No model call and no browser are involved.

```typescript
web_search({ query: "rust async programming" })
web_search({ queries: ["query 1", "query 2", "query 3"] })
web_search({ query: "latest news", numResults: 10, recencyFilter: "week" })
web_search({ query: "...", domainFilter: ["github.com", "-old.example.com"] })
web_search({ query: "...", provider: "brave" })
web_search({ query: "...", includeContent: true })
```

### web_search_enhanced — all providers at once

Queries **every provider in the configured list simultaneously** and merges the deduplicated results. This is the "search everything" mode: it costs one search per provider, so prefer `web_search` for routine lookups.

```typescript
web_search_enhanced({ query: "...", provider: [["exa", 1], ["brave", 1], ["tavily", 1]] })
```

Without a weighted list it uses the eligible automatic providers. AnySearch, SerpApi, DuckDuckGo, and Querit are explicit-only: they are never part of the automatic chain, but naming them in the list (or in an explicit `provider` array) opts them in.

### fetch_content

Fetches URLs as readable markdown, exact textual HTTP bodies, direct images, or page-grounded answers. GitHub repos and GitHub PRs/issues are cloned or rendered specially; PDFs are parsed locally.

Fetch providers, in order: `http`, `firecrawl`, `tinyfish`, `querit`. Change the order or subset with `fetchRouting.providers`. TinyFish and Querit perform their own fetch on their own infrastructure, so for remote HTTP(S) targets they are skipped unless `fetchRouting.allowRemoteHostedProviders` is `true`.

```typescript
fetch_content({ url: "https://example.com/article" })
fetch_content({ urls: ["url1", "url2", "url3"] })
fetch_content({ url: "https://github.com/owner/repo" })
fetch_content({ url: "https://github.com/owner/repo/pull/123#discussion_r456" })
fetch_content({ url: "https://example.com/api", mode: "raw" })
fetch_content({ url: "https://example.com/guide", mode: "answer", prompt: "What are the installation steps?" })
fetch_content({ url: "https://example.com/diagram.png" })
```

| Parameter | Description |
| ----------- | ------------- |
| `url` / `urls` | Single URL/path or multiple URLs |
| `prompt` | The page-local question required by `mode: "answer"` |
| `mode` | `readable` (default), `raw` for exact textual HTTP bodies, or `answer` for a grounded answer from fetched content |
| `answerModel` | Optional `provider/model-id` override for answer mode |
| `forceClone` | Clone GitHub repos that exceed the 350 MB size threshold |
| `auth` | Opt into an `authFetch` profile for local browser-cookie fetching |
| `proxy` | Per-call HTTP(S)/SOCKS proxy URL; empty string forces direct access |

### get_search_content

Retrieves stored search results and fetched pages from earlier calls. Search answers and results stay available in full and can be paged with `offset`/`limit`, or searched with `findText` (`exact`, `case-insensitive`, or `fuzzy`).

```typescript
get_search_content({ responseId: "abc123", queryIndex: 0, offset: 30000 })
get_search_content({ responseId: "abc123", urlIndex: 0, findText: ["timeout", "retry"], findMode: "fuzzy" })
```

Fetched URL content lives in a private `web-search-cache` directory under the Pi config directory — not in the session JSONL. One-hour lifetime, 128 entries / 128 MiB, oldest-first pruning, `0700`/`0600` permissions. Set `PI_WEB_ACCESS_CACHE_ROOT` to give a process its own cache root.

### source_check

Gathers evidence for a claim and returns a machine-readable artifact with exact passage citations for manual review. Results are deduplicated and capped at 20 sources; `fetchContent` fetches at most 5 pages. The artifact preserves the `supported` / `contradicted` / `unclear` / `missing-evidence` schema, source-quality hints, SHA-256 content hashes, and passage IDs with exact offsets. Nothing is inferred automatically: retrieved passages yield `unclear` for manual review, and no passages yield `missing-evidence`.

## PDFs

PDF text extraction is **local only**, via `unpdf`. PDF bytes never leave the machine and there is no hosted conversion service to configure.

| Setting | Default | Notes |
| --- | --- | --- |
| `pdf.enabled` | `true` | `false` blocks PDF extraction for `fetch_content` |
| `pdf.maxSizeMB` | `20` | Capped at 50 |
| `pdf.maxPages` | `100` | Only the first N pages are extracted |

PDFs are text-extracted only — scanned documents are not OCR'd. An already-aborted `fetch_content` signal aborts extraction before parsing starts.

## Commands

### /search

Browse stored search results interactively. Lists results from the current session with their response IDs.

## Activity Monitor

Toggle with **Ctrl+Shift+W** to see live request/response activity:

```
─── Web Search Activity ────────────────────────────────────
  API  "typescript best practices"     200    2.1s ✓
  GET  docs.example.com/article        200    0.8s ✓
  GET  blog.example.com/post           404    0.3s ✗
────────────────────────────────────────────────────────────
```

## Configuration

Config defaults to `~/.pi/agent/web-search-enhanced.json` when neither `PI_CODING_AGENT_DIR` nor `XDG_CONFIG_HOME` is set. `PI_CODING_AGENT_DIR` takes precedence when set. Every field is optional.

```json
{
  "provider": [["exa", 60], ["brave", 30], ["tavily", 10]],
  "exaApiKey": "exa-...",
  "braveApiKey": "BSA_...",
  "tavilyApiKey": "tvly-...",
  "tinyfishApiKey": "sk-tinyfish-...",
  "serpapiApiKey": "$SERPAPI_KEY",
  "anysearchApiKey": "$ANYSEARCH_API_KEY",
  "firecrawlBaseUrl": "https://your-firecrawl.example.com",
  "firecrawlApiKey": "fc-...",
  "queritApiKey": "...",
  "searchProvider": "auto",
  "retry": 3,
  "searchRouting": {
    "providers": ["exa", "brave"],
    "fallbackOn": ["transient", "quota", "network", "invalid-response", "unsupported"]
  },
  "webSearch": { "allowedProviders": ["exa", "brave", "tavily"] },
  "fetch": { "defaultMode": "readable", "allowedModes": ["readable", "raw", "answer"], "timeout": 30 },
  "fetchRouting": { "providers": ["http", "firecrawl", "tinyfish", "querit"], "allowRemoteHostedProviders": false },
  "pdf": { "enabled": true, "maxSizeMB": 20, "maxPages": 100 },
  "image": { "enabled": true },
  "tools": { "webSearch": { "enabled": true }, "webSearchEnhanced": { "enabled": true } },
  "commands": { "search": { "enabled": true } },
  "toolNames": { "webSearch": "web_search", "webSearchEnhanced": "web_search_enhanced" },
  "toolActivation": "auto",
  "proxy": "http://host:port",
  "maxInlineContentChars": 30000,
  "ssrf": { "allowRanges": ["198.18.0.0/15"], "trustEnvProxy": false }
}
```

Credential values may be a literal, `$ENV_VAR` / `${ENV_VAR}` to read an environment variable, or `!command` to run a command (5 s timeout, 16 KB cap). An environment variable always wins over a literal config value.

`webSearch.allowedProviders` restricts which providers may be selected at all — by the weighted list, by `searchProvider`, or by `searchRouting.providers`. A configured value that names a provider outside the allowlist fails loudly. Setting `tools.webSearch.enabled` to `false` disables both search tools; `tools.webSearchEnhanced.enabled` overrides that for the enhanced tool alone.

`searchRouting` is a provider rotation used in two places: as the primary resolution when no `provider`/`searchProvider` is configured, and as the last-resort fallback for balanced search once `retry` attempts are exhausted. Providers are tried in order; a failure continues to the next provider only when its classified kind is listed in `fallbackOn` (`transient`, `quota`, `network`, `invalid-response`, `unsupported`), otherwise it fails closed. `searchRouting.useCurrentModel` is accepted for compatibility.

`toolActivation` picks how tools become available:

- `"auto"` (default) uses dynamic activation on models that accept tools added mid-conversation, and starts with every enabled tool otherwise.
- `"dynamic"` always starts with the compact `web_enable` loader tool.
- `"eager"` never uses `web_enable`.

Set `"enabled": false` under `tools`, `commands`, `image`, or `pdf` to disable that feature. Pi restart is required for tool and command registration changes. `toolNames` can opt into alternate public tool names.

### Proxy

Every tool accepts an optional `proxy` string. When set, outbound HTTP(S) requests are routed through `curl` instead of Node's built-in fetch, which works around Node fetch ignoring `HTTP(S)_PROXY` and undici `ProxyAgent` TLS failures against common proxies. Localhost, `127.0.0.1`, `[::1]`, and `NO_PROXY` hosts are never proxied. The config-level `proxy` applies only to this extension's tools; the agent's own model calls are untouched.

### Blocked pages

Raw and direct-image requests use the same SSRF validation, hostname domain policy, redirect checks, timeout, and 5 MB streamed response bound as normal extraction. `fetch_content` can opt into local browser-cookie auth with `auth: "profile"`, or `auth: true` when exactly one `authFetch` profile exists:

```json
{ "authFetch": { "work": { "hosts": ["docs.company.com"], "chromeProfile": "Profile 2", "cache": "off" } } }
```

Auth fetch uses only the local direct HTTP path, requires HTTPS, allows only configured hosts and their subdomains, refuses cross-origin redirects, and never sends cookies or authenticated content to hosted extraction providers. Browser cookie extraction stays opt-in via `allowBrowserCookies: true` or `PI_ALLOW_BROWSER_COOKIES=1`; the `/google-account` command is not part of this fork.

## Security

- `validateRemoteUrl` allows HTTP(S) only, blocks localhost plus private/reserved IPv4 and IPv6 ranges, re-validates every redirect (max 5), and downgrades POST→GET on 301/302/303. `ssrf.allowRanges` (CIDR) can exempt a proxy's fake-IP range; `ssrf.trustEnvProxy` skips local DNS preflight for proxied hostnames.
- Inline `data:` URIs are replaced with bounded markers and a SHA-256 digest so base64 payloads never reach model-visible output, the fetch cache, or session persistence.
- `mode: "answer"` wraps page text in `<untrusted_page_content>` so a hostile page cannot impersonate instructions.

Report suspected vulnerabilities through GitHub private vulnerability reporting — see [SECURITY.md](SECURITY.md).

## Limitations

- No curator UI and no generated summaries: `web_search` returns raw results only.
- YouTube, local video, and frame extraction are not supported.
- PDFs are text-extracted only (no OCR).
- AnySearch, SerpApi, DuckDuckGo, and Querit are explicit-only and never join the automatic chain.
- GitHub branch names with slashes may misresolve file paths; the clone still works.
- GitHub wiki, discussion, and other non-code pages fall through to normal web extraction.
- Firecrawl, TinyFish, and Querit extraction each carry their own timeout budget; `fetch.timeout` covers only the direct HTTP attempt.

## Files

| File | Purpose |
| ------ | --------- |
| `index.ts` | Extension entry: tool definitions, commands, widget |
| `search.ts` | Provider registry, routing, fallback chain, error classification |
| `search-provider-weights.ts` | Weighted-list parsing and linear weighted provider sampling |
| `search-types.ts` | Shared `SearchResult` / `SearchResponse` / `SearchOptions` types |
| `exa.ts`, `tavily.ts`, `brave.ts`, `tinyfish.ts`, `serpapi.ts`, `firecrawl.ts`, `anysearch.ts`, `duckduckgo.ts`, `querit.ts` | Search providers |
| `querit.ts` | Querit Contents extraction (and its search client) |
| `brave-rate-limit.ts` | Adaptive Brave rate-limit queue |
| `extract.ts` | URL/file routing, HTTP extraction, fallback orchestration |
| `github-extract.ts`, `github-api.ts` | GitHub clone cache and API fallback |
| `github-issue-pr.ts` | GitHub PR/issue parsing and rendering |
| `pdf-extract.ts` | Local unpdf text extraction to Markdown |
| `rsc-extract.ts` | Next.js RSC flight-data parser |
| `declared-web-links.ts` | `Link`/`rel` discovery relations |
| `content-find.ts` | Bounded exact / case-insensitive / fuzzy passage lookup |
| `page-query.ts` | Grounded page-local answers with model context budgeting |
| `summary-model-scope.ts` | Model registry scope helpers shared with `page-query.ts` |
| `ssrf-protection.ts` | URL, redirect, and DNS validation |
| `auth-fetch.ts` | Browser-cookie auth profile resolution and redirect guard |
| `chrome-cookies.ts`, `browser-cookie-config.ts` | Chromium cookie extraction and its opt-in config |
| `credential-source.ts` | Literal / env / command credential resolution |
| `data-uri-sanitize.ts` | Inline `data:` URI omission |
| `storage.ts` | Session-aware result and fetch-cache storage |
| `activity.ts` | Activity tracking for the observability widget |
| `render-search-error.ts` | Dependency-free error plan renderer |
| `tool-activation.ts` | `web_enable` dynamic tool activation |
| `source-check.ts` | Research artifact construction and passage extraction |
| `utils.ts` | Shared formatting, proxy, and error helpers |
