# Pi Web Enhanced - Changelog

All notable changes to this project will be documented in this file.

This project is a trimmed fork of [pi-web-access](https://github.com/nicobailon/pi-web-access).
The version line starts at `0.1.0`; upstream history lives in `CHANGELOG-upstream.md`
and is not shipped. Every version here must be at most the `package.json` version,
because Pi prints any entry newer than the installed version as an extension update.

## [0.1.1] - 2026-11-02

### Fixed

- Pi no longer reprints the whole upstream changelog on every startup. The fork version line starts at `0.1.0`, but `CHANGELOG.md` still carried the upstream `0.2.0`–`0.35.0` sections; Pi treats every entry newer than the installed version as new, so it printed all 50 entries, then recorded the installed `0.1.0` and printed them again on the next launch. Upstream history now lives in `CHANGELOG-upstream.md`, which is outside the published `files` list and is never parsed by Pi.

### Added

- `scripts/check-changelog.js`, run from `prepublishOnly`, rejects a release when the newest `CHANGELOG.md` entry is not the `package.json` version, when any entry is newer than the package version, or when versions are not strictly descending.

## [0.1.0] - 2026-10-02

### Added

- `web_search_enhanced`, a second search tool that queries every provider in the configured provider list at once and merges the deduplicated results.
- Weighted provider selection for `web_search`: set `"provider": [["exa", 60], ["brave", 30], ["tavily", 10]]` and each call samples one provider with probability `wᵢ / Σ wⱼ`. Weights must be positive integers (typically a provider's request budget over a common window, so the mix tracks each provider's allowance); providers without credentials are dropped before sampling, and duplicates, unknown names, or non-positive/non-integer weights are rejected with a config-path error.
- `"retry": N` for balanced search: up to `N` total attempts (default `1`). Each attempt re-samples a weighted provider, so a retry can land on a different provider.
- Use of `searchRouting` as the balanced-mode fallback: once the retry attempts are exhausted, the configured routing rotation (`searchRouting.providers` in order, honouring `fallbackOn`) runs as a last resort. `searchRouting` keeps its original role too — it is the primary resolution when no `provider`/`searchProvider` is configured.

### Changed

- The global config is now `~/.pi/agent/web-search-enhanced.json` instead of `~/.pi/agent/web-search.json`, so this fork can coexist with upstream pi-web-access. The filename is centralized as `CONFIG_FILE_NAME` in `utils.ts`.
- Search providers are now limited to Exa, Tavily, AnySearch, TinyFish, SerpApi, Firecrawl, Brave, DuckDuckGo, and Querit. AnySearch, SerpApi, DuckDuckGo, and Querit remain explicit-only. The automatic chain is Exa → Brave → Tavily → Firecrawl → TinyFish.
- `fetch_content` providers are now `http`, `firecrawl`, `tinyfish`, and `querit`.
- PDF extraction is local `unpdf` only; the Datalab and Gemini PDF engines are gone, so `pdf.provider`, `pdf.datalabMode`, and `pdf.datalabTimeoutMs` no longer exist.
- The package is named `pi-web-enhanced` and depends on `undici` no longer.
- The version is reset to `0.1.0` and the `repository`, `bugs`, and `homepage` fields now point at `https://github.com/pyfile/pi-web-enhanced` instead of upstream.

### Removed

- The `summary-review` and `auto-summary` workflows, the whole curator subsystem (`/websearch`, `/curator`, the curate shortcut, `curator-server.ts`, `curator-page.ts`, `curator-run.ts`), and generated summaries. `web_search` has no `workflow` parameter.
- YouTube, local video, and frame extraction. `fetch_content` no longer accepts `timestamp`, `frames`, or `model`.
- The `/google-account` command.
- All removed search and fetch providers, and the Gemini search/fetch/PDF integrations.
- The last Gemini-named leftovers: `gemini-search.ts` was never Gemini-specific (it is the provider dispatcher), so it is now `search.ts`; `gemini-web-config.ts` is now `browser-cookie-config.ts`; and `chrome-cookies.ts` no longer carries the unused `getGoogleCookies` entry point, its Google cookie-name list, or Gemini-worded diagnostics. The orphaned `browserCookies` config existed only to feed the deleted Gemini Web provider and is no longer parsed.

### Migration

Rename an existing `web-search.json` to `web-search-enhanced.json` — this fork no longer reads the upstream filename. An existing `web-search-enhanced.json` that names a removed provider now fails loudly at search time with a message naming the file and the offending provider. Update `provider`, `searchProvider`, `searchRouting.providers`, and `webSearch.allowedProviders` to use the nine supported providers.
