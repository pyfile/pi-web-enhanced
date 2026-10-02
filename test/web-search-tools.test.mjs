import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;

// Runs the real extension in a child process with an isolated config dir and a
// mocked fetch, then reports which providers were called for one tool call.
function runSearch(config, params, toolName = "web_search", { dropEnv = [] } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-enhanced-search-tools-"));
	try {
		writeFileSync(join(dir, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: `
			const calls = [];
			globalThis.fetch = async (url) => {
				const target = String(url);
				calls.push(target);
				if (target.startsWith("https://api.search.brave.com/")) {
					return new Response(JSON.stringify({ web: { results: [{ title: "Brave", url: "https://example.com/brave", description: "brave" }] } }), { status: 200 });
				}
				if (target === "https://api.tavily.com/search") {
					return new Response(JSON.stringify({ answer: "tavily", results: [{ title: "Tavily", url: "https://example.com/tavily", content: "tavily" }] }), { status: 200 });
				}
				if (target === "https://api.fetch.tinyfish.ai") {
					return new Response(JSON.stringify({ results: [{ url: "https://example.com/tinyfish", final_url: "https://example.com/tinyfish", title: "TinyFish", text: "# TinyFish", format: "markdown" }], errors: [] }), { status: 200 });
				}
				if (target.startsWith("https://api.search.tinyfish.ai")) {
					return new Response(JSON.stringify({ results: [{ title: "TinyFish", url: "https://example.com/tinyfish", snippet: "tinyfish" }] }), { status: 200 });
				}
				if (target.startsWith("https://serpapi.com/search.json")) {
					return new Response(JSON.stringify({ organic_results: [{ title: "SerpApi", link: "https://example.com/serpapi", snippet: "serpapi" }] }), { status: 200 });
				}
				throw new Error("Unexpected fetch: " + target);
			};
			const tools = [];
			const handlers = new Map();
			const pi = {
				registerTool(tool) { tools.push(tool); },
				registerCommand() {}, registerShortcut() {},
				on(event, handler) { handlers.set(event, handler); },
				appendEntry() {}, sendMessage() {},
			};
			const initializeExtension = (await import(${JSON.stringify(indexUrl)})).default;
			initializeExtension(pi);
			await handlers.get("session_start")({}, { sessionManager: { getBranch: () => [] } });
			const tool = tools.find((candidate) => candidate.name === ${JSON.stringify(toolName)});
			const result = await tool.execute("call", ${JSON.stringify(params)});
			console.log(JSON.stringify({
				toolNames: tools.map((candidate) => candidate.name),
				text: result.content[0].text,
				queryProviders: result.details.queryProviders,
				calls,
			}));
			`,
			encoding: "utf8",
			timeout: 30_000,
			env: buildEnv(dir, dropEnv),
		});
		assert.equal(child.status, 0, child.stderr);
		return JSON.parse(child.stdout.trim().split("\n").at(-1));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function buildEnv(dir, dropEnv) {
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: dir,
		XDG_CONFIG_HOME: "",
		HOME: join(dir, "home"),
		USERPROFILE: join(dir, "home"),
		BRAVE_API_KEY: "brave-test-key",
		TAVILY_API_KEY: "tavily-test-key",
		TINYFISH_API_KEY: "tinyfish-test-key",
		SERPAPI_KEY: "serpapi-test-key",
	};
	for (const key of dropEnv) delete env[key];
	return env;
}

const searchHosts = (urls) => urls.map((url) => {
	if (url.startsWith("https://api.search.brave.com/")) return "brave";
	if (url === "https://api.tavily.com/search") return "tavily";
	if (url === "https://api.fetch.tinyfish.ai") return "tinyfish";
	if (url.startsWith("https://api.search.tinyfish.ai")) return "tinyfish";
	if (url.startsWith("https://serpapi.com/search.json")) return "serpapi";
	return url;
});

test("both search tools are registered, with the balanced one keeping the default name", () => {
	const output = runSearch({ provider: "tavily" }, { query: "names" });
	assert.ok(output.toolNames.includes("web_search"));
	assert.ok(output.toolNames.includes("web_search_enhanced"));
});

test("web_search in balanced mode queries exactly one provider from the weighted list", () => {
	const output = runSearch({
		provider: [["brave", 1], ["tavily", 1], ["tinyfish", 1]],
	}, { query: "balanced" });

	assert.equal(searchHosts(output.calls).length, 1);
	const used = searchHosts(output.calls)[0];
	assert.ok(["brave", "tavily", "tinyfish"].includes(used), used);
	assert.equal(output.queryProviders.length, 1);
	assert.deepEqual(output.queryProviders[0].providers, [used]);
});

test("web_search in balanced mode skips weighted providers without credentials", () => {
	// Only tavily has a key here (set by runSearch's env), so the draw must land on it.
	const output = runSearch({
		provider: [["brave", 5], ["tavily", 1]],
	}, { query: "balanced availability" }, "web_search", { dropEnv: ["BRAVE_API_KEY"] });

	assert.deepEqual(searchHosts(output.calls), ["tavily"]);
});

test("web_search_enhanced queries every provider in the configured list", () => {
	const output = runSearch({
		provider: [["brave", 1], ["tavily", 2], ["tinyfish", 3]],
	}, { query: "enhanced" }, "web_search_enhanced");

	assert.deepEqual(searchHosts(output.calls).sort(), ["brave", "tavily", "tinyfish"]);
	assert.deepEqual(
		output.queryProviders[0].providers.slice().sort(),
		["brave", "tavily", "tinyfish"],
	);
	assert.match(output.text, /## Brave/);
	assert.match(output.text, /## Tavily/);
	assert.match(output.text, /## TinyFish/);
});

test("an explicit provider param overrides the weighted selection", () => {
	const output = runSearch({
		provider: [["brave", 1], ["tinyfish", 1]],
	}, { query: "override", provider: "tavily" });

	assert.deepEqual(searchHosts(output.calls), ["tavily"]);
	assert.deepEqual(output.queryProviders[0].providers, ["tavily"]);
});

test("a plain string provider config keeps the non-weighted path", () => {
	const output = runSearch({ provider: "serpapi" }, { query: "string config" });
	assert.deepEqual(searchHosts(output.calls), ["serpapi"]);
	assert.deepEqual(output.queryProviders[0].providers, ["serpapi"]);
});
