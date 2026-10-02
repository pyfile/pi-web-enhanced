import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;

async function createConfig(config = {
	provider: "tavily",
	tavilyApiKey: "tavily-test-key",
	braveApiKey: "brave-test-key",
}) {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-provider-precedence-"));
	const agentDir = join(root, "agent-dir");
	await mkdir(agentDir, { recursive: true });
	if (config) {
		await writeFile(join(agentDir, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	}
	return agentDir;
}

function runTool(agentDir, provider) {
	const providerSource = provider === undefined ? "undefined" : JSON.stringify(provider);
	const childEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir, OPENAI_API_KEY: "openai-test-key" };
	for (const key of ["BRAVE_API_KEY", "PARALLEL_API_KEY", "TINYFISH_API_KEY", "SEARCH1API_KEY", "SEARCHINFINITY_API_KEY", "QUERIT_API_KEY", "TAVILY_API_KEY", "FIRECRAWL_BASE_URL", "FIRECRAWL_API_KEY", "JINA_API_KEY", "SERPDIVE_API_KEY", "KAGI_API_KEY", "OLLAMA_API_KEY", "SERPBASE_API_KEY", "ANYSEARCH_API_KEY", "XAI_API_KEY", "BRIGHTDATA_API_KEY", "BRIGHTDATA_SERP_ZONE", "SEARXNG_BASE_URL", "EXA_API_KEY", "GEMINI_API_KEY", "PERPLEXITY_API_KEY"]) {
		delete childEnv[key];
	}
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
		const calls = [];
		globalThis.fetch = async (url) => {
			const urlText = String(url);
			calls.push(urlText);
			if (urlText.startsWith("https://api.search.brave.com/")) {
				return new Response(JSON.stringify({ web: { results: [{ title: "Brave source", url: "https://brave.example/source", description: "brave result" }] } }), { status: 200 });
			}
			if (urlText === "https://api.tavily.com/search") {
				return new Response(JSON.stringify({ answer: "tavily answer", results: [{ title: "Tavily source", url: "https://tavily.example/source", content: "tavily result" }] }), { status: 200 });
			}
			throw new Error("Unexpected fetch: " + urlText);
		};
		const tools = [];
		const pi = {
			registerTool(tool) { tools.push(tool); },
			registerShortcut() {},
			registerCommand() {},
			on() {},
			appendEntry() {},
			sendMessage() {},
		};
		const extension = (await import(${JSON.stringify(indexUrl)})).default;
		extension(pi);
		const tool = tools.find((candidate) => candidate.name === "web_search");
		const params = { query: "provider precedence" };
		if (${providerSource} !== undefined) params.provider = ${providerSource};
		await tool.execute("provider-precedence-test", params, undefined, undefined, undefined);
		console.log(JSON.stringify(calls));
	`,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

test("configured provider is used when tool omits provider", async () => {
	const calls = runTool(await createConfig());
	assert.deepEqual(calls, ["https://api.tavily.com/search"]);
});

test("configured provider array is used when the tool omits provider", async () => {
	const calls = runTool(await createConfig({
		provider: ["tavily", "brave"],
		tavilyApiKey: "tavily-test-key",
		braveApiKey: "brave-test-key",
	}));
	assert.deepEqual(calls.sort(), [
		"https://api.search.brave.com/res/v1/web/search?q=provider+precedence&count=5",
		"https://api.tavily.com/search",
	].sort());
});

test("explicit named provider overrides configured provider", async () => {
	const calls = runTool(await createConfig(), "tavily");
	assert.deepEqual(calls, ["https://api.tavily.com/search"]);
});

test("explicit provider array overrides configured provider and runs only the selected providers", async () => {
	const calls = runTool(await createConfig(), ["tavily", "brave"]);
	assert.deepEqual(calls.sort(), [
		"https://api.search.brave.com/res/v1/web/search?q=provider+precedence&count=5",
		"https://api.tavily.com/search",
	].sort());
});

test("explicit auto uses configured provider", async () => {
	const calls = runTool(await createConfig(), "auto");
	assert.deepEqual(calls, ["https://api.tavily.com/search"]);
});

test("auto still uses provider fallback when no provider is configured", async () => {
	const calls = runTool(await createConfig(null), "auto");
	assert.deepEqual(calls, ["https://mcp.exa.ai/mcp?tools=web_search_exa"]);
});

test("configured explicit-only SerpApi fails instead of falling back", async () => {
	const agentDir = await createConfig({ provider: "serpapi" });
	const childEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir, OPENAI_API_KEY: "openai-test-key" };
	for (const key of ["BRAVE_API_KEY", "PARALLEL_API_KEY", "TINYFISH_API_KEY", "SEARCH1API_KEY", "SEARCHINFINITY_API_KEY", "QUERIT_API_KEY", "TAVILY_API_KEY", "FIRECRAWL_BASE_URL", "FIRECRAWL_API_KEY", "JINA_API_KEY", "SERPDIVE_API_KEY", "KAGI_API_KEY", "OLLAMA_API_KEY", "SERPBASE_API_KEY", "ANYSEARCH_API_KEY", "XAI_API_KEY", "BRIGHTDATA_API_KEY", "BRIGHTDATA_SERP_ZONE", "SEARXNG_BASE_URL", "EXA_API_KEY", "GEMINI_API_KEY", "PERPLEXITY_API_KEY"]) {
		delete childEnv[key];
	}
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
		globalThis.fetch = async (url) => { throw new Error("Unexpected fallback fetch: " + url); };
		const tools = [];
		const pi = {
			registerTool(tool) { tools.push(tool); },
			registerShortcut() {},
			registerCommand() {},
			on() {},
			appendEntry() {},
			sendMessage() {},
		};
		const extension = (await import(${JSON.stringify(indexUrl)})).default;
		extension(pi);
		const tool = tools.find((candidate) => candidate.name === "web_search");
		const result = await tool.execute("serpapi-no-fallback-test", { query: "provider precedence" });
		console.log(JSON.stringify(result));
	`,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout.trim());
	assert.match(result.content[0].text, /SerpApi API key not found/);
	assert.doesNotMatch(result.content[0].text, /Unexpected fallback fetch/);
});

test("legacy Gemini Web profile config does not block unrelated configured providers", async () => {
	const calls = runTool(await createConfig({
		provider: "tavily",
		tavilyApiKey: "tavily-test-key",
		allowBrowserCookies: true,
		chromeProfile: "Profile 1",
	}));
	assert.deepEqual(calls, ["https://api.tavily.com/search"]);
});

test("malformed config root fails with an explicit object-shape error", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-invalid-config-root-"));
	const agentDir = join(root, "agent-dir");
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "web-search.json"), "null\n", "utf8");

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			globalThis.fetch = async () => { throw new Error("fetch should not run"); };
			const tools = [];
			const pi = {
				registerTool(tool) { tools.push(tool); },
				registerShortcut() {},
				registerCommand() {},
				on() {},
				appendEntry() {},
				sendMessage() {},
			};
			const extension = (await import(${JSON.stringify(indexUrl)})).default;
			extension(pi);
			const tool = tools.find((candidate) => candidate.name === "web_search");
			await tool.execute("invalid-config-root-test", { query: "x", workflow: "none", provider: "auto" });
		`,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, OPENAI_API_KEY: "openai-test-key" },
	});
	assert.notEqual(child.status, 0);
	assert.match(child.stderr, /Invalid config in .*web-search\.json: expected a JSON object/);
});

test("non-curated search stops after caller cancellation", async () => {
	const agentDir = await createConfig(null);
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			let calls = 0;
			globalThis.fetch = async () => {
				calls += 1;
				throw new DOMException("The operation was aborted", "AbortError");
			};
			const tools = [];
			const pi = {
				registerTool(tool) { tools.push(tool); },
				registerShortcut() {}, registerCommand() {}, on() {}, appendEntry() {}, sendMessage() {},
			};
			const extension = (await import(${JSON.stringify(indexUrl)})).default;
			extension(pi);
			const tool = tools.find((candidate) => candidate.name === "web_search");
			const controller = new AbortController();
			controller.abort();
			let error = "";
			try {
				await tool.execute("cancel-test", { queries: ["first", "second"], provider: "anysearch", workflow: "none" }, controller.signal);
			} catch (err) {
				error = String(err);
			}
			console.log(JSON.stringify({ calls, error }));
		`,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
	});
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.calls, 0);
	assert.match(output.error, /abort/i);
});

test("both search tools resolve the requested provider through the same path", async () => {
	const { readFile } = await import("node:fs/promises");
	const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
	assert.match(source, /const resolvedProvider = resolveRequestedProvider\(params\.provider\);/);
	assert.match(source, /provider: resolvedProvider,\n\s*selectionMode: mode,/);
	assert.match(source, /pi\.registerTool\(createWebSearchTool\("balanced"\)\)/);
	assert.match(source, /pi\.registerTool\(createWebSearchTool\("enhanced"\)\)/);
});
