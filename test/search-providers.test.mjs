import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const braveModuleUrl = new URL("../brave.ts", import.meta.url).href;
const exaModuleUrl = new URL("../exa.ts", import.meta.url).href;
const openaiModuleUrl = new URL("../openai-search.ts", import.meta.url).href;
const perplexityModuleUrl = new URL("../perplexity.ts", import.meta.url).href;
const tavilyModuleUrl = new URL("../tavily.ts", import.meta.url).href;
const searxngModuleUrl = new URL("../searxng.ts", import.meta.url).href;
const searchModuleUrl = new URL("../search.ts", import.meta.url).href;
const indexModuleUrl = new URL("../index.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR",
		"XDG_CONFIG_HOME",
		"OPENAI_API_KEY",
		"BRAVE_API_KEY",
		"BRAVE_BASE_URL",
		"PARALLEL_API_KEY",
		"TINYFISH_API_KEY",
		"SEARCH1API_KEY",
		"SEARCHINFINITY_API_KEY",
		"QUERIT_API_KEY",
		"TAVILY_API_KEY",
		"TAVILY_BASE_URL",
		"FIRECRAWL_BASE_URL",
		"FIRECRAWL_API_KEY",
		"JINA_API_KEY",
		"SEARXNG_BASE_URL",
		"EXA_API_KEY",
		"EXA_BASE_URL",
		"PERPLEXITY_API_KEY",
		"GEMINI_API_KEY",
	]) {
		delete childEnv[key];
	}
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

test("Brave search applies domain filters in the query and returned results", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-brave-"));
	const child = runChild(`
		let capturedUrl = "";
		let capturedHeaders = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = init.headers;
			return new Response(JSON.stringify({
				web: { results: [
					{ title: "GitHub", url: "https://github.com/nicobailon/pi-web-access", description: "repo" },
					{ title: "Gist", url: "https://gist.github.com/nicobailon/abc", description: "gist" },
					{ title: "Example", url: "https://example.com/nope", description: "example" },
				] },
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { searchWithBrave } = await import(${JSON.stringify(braveModuleUrl)});
		const result = await searchWithBrave("sdk docs", {
			domainFilter: ["github.com", "-gist.github.com"],
			numResults: 2,
		});
		const parsedUrl = new URL(capturedUrl);
		console.log(JSON.stringify({
			q: parsedUrl.searchParams.get("q"),
			count: parsedUrl.searchParams.get("count"),
			token: capturedHeaders["X-Subscription-Token"],
			results: result.results,
		}));
	`, {
		HOME: home,
		USERPROFILE: home,
		BRAVE_API_KEY: "brave-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.q, /site:github\.com/);
	assert.match(output.q, /NOT site:gist\.github\.com/);
	assert.equal(output.count, "20");
	assert.equal(output.token, "brave-test-key");
	assert.deepEqual(output.results.map((result) => result.url), ["https://github.com/nicobailon/pi-web-access"]);
});

test("Tavily search uses bearer auth and maps filters/content", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-tavily-"));
	const child = runChild(`
		let capturedUrl = "";
		let capturedHeaders = null;
		let capturedBody = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = init.headers;
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({
				answer: "Tavily answer",
				results: [{
					title: "Tavily Docs",
					url: "https://docs.tavily.com/search",
					content: "Search docs snippet",
					raw_content: "# Tavily Docs\\nFull content",
				}],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { searchWithTavily } = await import(${JSON.stringify(tavilyModuleUrl)});
		const result = await searchWithTavily("tavily search docs", {
			domainFilter: ["https://docs.tavily.com/search", "-reddit.com"],
			recencyFilter: "week",
			numResults: 4,
			includeContent: true,
		});
		console.log(JSON.stringify({ capturedUrl, capturedHeaders, capturedBody, result }));
	`, {
		HOME: home,
		USERPROFILE: home,
		TAVILY_API_KEY: "tvly-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.capturedUrl, "https://api.tavily.com/search");
	assert.equal(output.capturedHeaders.Authorization, "Bearer tvly-test-key");
	assert.deepEqual(output.capturedBody, {
		query: "tavily search docs",
		search_depth: "basic",
		max_results: 4,
		include_answer: "basic",
		include_raw_content: "markdown",
		time_range: "week",
		include_domains: ["docs.tavily.com"],
		exclude_domains: ["reddit.com"],
	});
	assert.equal(output.result.answer, "Tavily answer");
	assert.deepEqual(output.result.results, [{ title: "Tavily Docs", url: "https://docs.tavily.com/search", snippet: "Search docs snippet" }]);
	assert.deepEqual(output.result.inlineContent, [{ url: "https://docs.tavily.com/search", title: "Tavily Docs", content: "# Tavily Docs\nFull content", error: null }]);
});

test("Brave, keyed Exa, and Tavily honor base URL overrides without leaking credentials across origins", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-provider-base-url-"));
	await writeFile(join(home, "web-search-enhanced.json"), JSON.stringify({
		braveApiKey: "brave-config-key",
		braveBaseUrl: "https://gateway.example.com/brave/res/v1/",
		exaApiKey: "exa-config-key",
		exaBaseUrl: "https://gateway.example.com/exa/",
		tavilyApiKey: "tavily-config-key",
		tavilyBaseUrl: "https://gateway.example.com/tavily/",
	}) + "\n");

	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			const target = String(url);
			const headers = new Headers(init.headers);
			calls.push({
				target,
				credential: headers.get("x-subscription-token") ?? headers.get("x-api-key") ?? headers.get("authorization"),
				redirect: init.redirect,
				method: init.method,
				hasBody: init.body !== undefined,
				contentType: headers.get("content-type"),
			});
			if (target.startsWith("https://gateway.example.com/")) {
				return new Response(null, {
					status: target.includes("/tavily/") ? 302 : 307,
					headers: { location: target.replace("gateway.example.com", "redirect.example.com") },
				});
			}
			if (target.includes("/brave/res/v1/web/search?")) {
				return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
			}
			if (target.endsWith("/exa/search")) {
				return new Response(JSON.stringify({ results: [] }), { status: 200 });
			}
			if (target.endsWith("/tavily/search")) {
				return new Response(JSON.stringify({ answer: "answer", results: [] }), { status: 200 });
			}
			throw new Error("Unexpected fetch " + target);
		};

		const { searchWithBrave } = await import(${JSON.stringify(braveModuleUrl)});
		const { searchWithExa } = await import(${JSON.stringify(exaModuleUrl)});
		const { searchWithTavily } = await import(${JSON.stringify(tavilyModuleUrl)});
		await searchWithBrave("configured");
		await searchWithExa("default search");
		await searchWithTavily("configured");

		process.env.BRAVE_BASE_URL = "https://env.example.com/brave/res/v1/";
		process.env.EXA_BASE_URL = "https://env.example.com/exa/";
		process.env.TAVILY_BASE_URL = "https://env.example.com/tavily/";
		await searchWithBrave("environment");
		await searchWithExa("environment");
		await searchWithTavily("environment");

		process.env.BRAVE_BASE_URL = "not-a-url";
		let invalidError = "";
		try {
			await searchWithBrave("invalid");
		} catch (error) {
			invalidError = error.message;
		}
		process.env.BRAVE_BASE_URL = "http://gateway.example.com/brave/res/v1";
		let plaintextError = "";
		try {
			await searchWithBrave("plaintext");
		} catch (error) {
			plaintextError = error.message;
		}
		console.log(JSON.stringify({ calls, invalidError, plaintextError }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls.map((call) => call.target), [
		"https://gateway.example.com/brave/res/v1/web/search?q=configured&count=5",
		"https://redirect.example.com/brave/res/v1/web/search?q=configured&count=5",
		"https://gateway.example.com/exa/search",
		"https://redirect.example.com/exa/search",
		"https://gateway.example.com/tavily/search",
		"https://redirect.example.com/tavily/search",
		"https://env.example.com/brave/res/v1/web/search?q=environment&count=5",
		"https://env.example.com/exa/search",
		"https://env.example.com/tavily/search",
	]);
	assert.deepEqual(output.calls.map((call) => call.credential), [
		"brave-config-key", null,
		"exa-config-key", null,
		"Bearer tavily-config-key", null,
		"brave-config-key", "exa-config-key", "Bearer tavily-config-key",
	]);
	assert.ok(output.calls.every((call) => call.redirect === "manual"));
	assert.deepEqual(output.calls.slice(4, 6).map(({ method, hasBody, contentType }) => ({ method, hasBody, contentType })), [
		{ method: "POST", hasBody: true, contentType: "application/json" },
		{ method: "GET", hasBody: false, contentType: null },
	]);
	assert.match(output.invalidError, /^BRAVE_BASE_URL must be an absolute HTTP\(S\) URL$/);
	assert.match(output.plaintextError, /^BRAVE_BASE_URL must be an absolute HTTPS URL$/);
});

test("provider base URLs allow HTTP only on exact loopback hosts", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-loopback-base-url-"));
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			const target = String(url);
			const credential = new Headers(init.headers).get("x-subscription-token");
			calls.push({ target, credential });
			if (new URL(target).searchParams.get("q") === "redirect") {
				return new Response(null, {
					status: 307,
					headers: { location: "https://remote.example.com/redirected" },
				});
			}
			return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
		};

		const { searchWithBrave } = await import(${JSON.stringify(braveModuleUrl)});
		process.env.BRAVE_BASE_URL = "http://localhost:8080/api";
		await searchWithBrave("redirect");

		const accepted = [
			"http://localhost:8080/api/",
			"http://LOCALHOST:8080/api",
			"http://localhost.:8080/api",
			"http://127.0.0.1:8080/api",
			"http://127.42.3.4:8080/api",
			"http://[::1]:8080/api",
			"http://[0:0:0:0:0:0:0:1]:8080/api",
			"https://gateway.example.com/api",
		];
		for (const [index, baseUrl] of accepted.entries()) {
			process.env.BRAVE_BASE_URL = baseUrl;
			await searchWithBrave("accepted-" + index);
		}

		const rejected = [
			"http://example.com/api",
			"http://localhost.example/api",
			"http://foo.localhost/api",
			"http://10.0.0.1/api",
			"http://169.254.169.254/api",
			"http://0.0.0.0/api",
			"http://[::]/api",
			"http://[::ffff:127.0.0.1]/api",
		];
		const rejectedErrors = [];
		for (const baseUrl of rejected) {
			process.env.BRAVE_BASE_URL = baseUrl;
			try {
				await searchWithBrave("rejected");
				rejectedErrors.push(null);
			} catch (error) {
				rejectedErrors.push(error.message);
			}
		}

		const invalid = [
			"http://user:secret@localhost:8080/api",
			"http://localhost:8080/api?debug=true",
			"http://localhost:8080/api#fragment",
		];
		const invalidErrors = [];
		for (const baseUrl of invalid) {
			process.env.BRAVE_BASE_URL = baseUrl;
			try {
				await searchWithBrave("invalid");
				invalidErrors.push(null);
			} catch (error) {
				invalidErrors.push(error.message);
			}
		}
		console.log(JSON.stringify({ calls, rejectedErrors, invalidErrors }));
	`, {
		HOME: home,
		USERPROFILE: home,
		BRAVE_API_KEY: "brave-loopback-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls.slice(0, 2), [
		{ target: "http://localhost:8080/api/web/search?q=redirect&count=5", credential: "brave-loopback-key" },
		{ target: "https://remote.example.com/redirected", credential: null },
	]);
	assert.equal(output.calls.length, 10);
	assert.ok(output.calls.slice(2).every((call) => call.credential === "brave-loopback-key"));
	assert.deepEqual(output.rejectedErrors, Array(8).fill("BRAVE_BASE_URL must be an absolute HTTPS URL"));
	assert.deepEqual(output.invalidErrors, [
		"BRAVE_BASE_URL must not include credentials",
		"BRAVE_BASE_URL must not include query parameters or fragments",
		"BRAVE_BASE_URL must not include query parameters or fragments",
	]);
});

test("auto provider falls through to Tavily after unavailable earlier providers", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-tavily-auto-"));
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			const urlText = String(url);
			calls.push(urlText);
			if (urlText.startsWith("https://mcp.exa.ai/mcp")) {
				return new Response("Exa unavailable", { status: 503 });
			}
			if (urlText === "https://api.tavily.com/search") {
				return new Response(JSON.stringify({
					answer: "Auto Tavily answer",
					results: [{ title: "Tavily Auto", url: "https://docs.tavily.com/auto", content: "auto snippet" }],
				}), { status: 200, headers: { "content-type": "application/json" } });
			}
			throw new Error("Unexpected fetch " + urlText);
		};

		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("auto tavily docs", { provider: "auto" });
		console.log(JSON.stringify({ calls, result }));
	`, {
		HOME: home,
		USERPROFILE: home,
		TAVILY_API_KEY: "tvly-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.ok(output.calls.some((call) => call.startsWith("https://mcp.exa.ai/mcp")));
	assert.ok(output.calls.includes("https://api.tavily.com/search"));
	assert.equal(output.result.provider, "tavily");
	assert.equal(output.result.answer, "Auto Tavily answer");
});

test("Exa direct API key ignores full legacy usage counter", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-exa-paid-"));
	const child = runChild(`
		const dir = ${JSON.stringify(home)};
		const { readFileSync, writeFileSync } = await import("node:fs");
		writeFileSync(dir + "/web-search-enhanced.json", JSON.stringify({ exaApiKey: "exa-paid-key" }));
		writeFileSync(dir + "/exa-usage.json", JSON.stringify({ month: new Date().toISOString().slice(0, 7), count: 1000 }));

		let capturedUrl = "";
		let capturedHeaders = null;
		let capturedBody = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = init.headers;
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({
				results: [{ title: "Exa Docs", url: "https://exa.ai/docs", highlights: ["Paid Exa answer"] }],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { isExaAvailable, searchWithExa } = await import(${JSON.stringify(exaModuleUrl)});
		const available = isExaAvailable();
		const result = await searchWithExa("paid exa query");
		const usage = JSON.parse(readFileSync(dir + "/exa-usage.json", "utf8"));
		console.log(JSON.stringify({
			available,
			capturedUrl,
			capturedBody,
			apiKey: capturedHeaders["x-api-key"],
			integration: capturedHeaders["x-exa-integration"],
			result,
			usage,
		}));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.available, true);
	assert.equal(output.capturedUrl, "https://api.exa.ai/search");
	assert.deepEqual(output.capturedBody, { query: "paid exa query", type: "auto", numResults: 5, contents: { highlights: true } });
	assert.equal(output.apiKey, "exa-paid-key");
	assert.equal(output.integration, "pi-web-access");
	assert.equal(output.result.answer, "Paid Exa answer\nSource: Exa Docs (https://exa.ai/docs)");
	assert.deepEqual(output.result.results, [{ title: "Exa Docs", url: "https://exa.ai/docs", snippet: "" }]);
	assert.equal(output.usage.count, 1000);
});

test("Exa command source is lazy, overrides stale env, and rotates per request", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-exa-command-"));
	const commandPath = join(home, "read-key.sh");
	const counterPath = join(home, "counter");
	await writeFile(commandPath, `#!/bin/sh\ncount=0\n[ ! -f "$1" ] || count=$(cat "$1")\ncount=$((count + 1))\nprintf '%s' "$count" >"$1"\nprintf 'synthetic-exa-%s\\n' "$count"\n`, "utf8");
	await chmod(commandPath, 0o700);
	await writeFile(join(home, "web-search-enhanced.json"), JSON.stringify({
		exaApiKey: `!${commandPath} ${counterPath}`,
	}) + "\n", "utf8");

	const child = runChild(`
		import { existsSync } from "node:fs";
		const keys = [];
		globalThis.fetch = async (_url, init) => {
			keys.push(init.headers["x-api-key"]);
			return new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};
		const { hasExaApiKey, searchWithExa } = await import(${JSON.stringify(exaModuleUrl)});
		const available = hasExaApiKey();
		const lazy = !existsSync(${JSON.stringify(counterPath)});
		await searchWithExa("first");
		await searchWithExa("second");
		console.log(JSON.stringify({ available, lazy, keys }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
		EXA_API_KEY: "stale-exa-environment-value",
	});

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), {
		available: true,
		lazy: true,
		keys: ["synthetic-exa-1", "synthetic-exa-2"],
	});
});

test("failed Exa command source is redacted and blocks MCP or provider fallback", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-exa-command-failure-"));
	const commandPath = join(home, "fail-key.sh");
	await writeFile(commandPath, "#!/bin/sh\nprintf 'SYNTHETIC_SECRET_MUST_NOT_ESCAPE\\n' >&2\nexit 9\n", "utf8");
	await chmod(commandPath, 0o700);
	await writeFile(join(home, "web-search-enhanced.json"), JSON.stringify({
		exaApiKey: `!${commandPath}`,
	}) + "\n", "utf8");

	const child = runChild(`
		let fetchCalls = 0;
		globalThis.fetch = async () => { fetchCalls += 1; throw new Error("unexpected fetch"); };
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		let message = "";
		try {
			await search("must fail closed", { provider: "auto" });
		} catch (error) {
			message = error.message;
		}
		console.log(JSON.stringify({ fetchCalls, message }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
		EXA_API_KEY: "stale-exa-environment-value",
		TAVILY_API_KEY: "stale-alternate-provider-value",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.fetchCalls, 0);
	assert.match(output.message, /^Exa credential resolution failed: command-failed$/);
	assert.equal(output.message.includes("SYNTHETIC_SECRET_MUST_NOT_ESCAPE"), false);
	assert.equal(output.message.includes(commandPath), false);
});

test("Exa provider errors redact the resolved credential", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-exa-redaction-"));
	const secret = "SYNTHETIC_EXA_SECRET_MUST_NOT_ESCAPE";
	const child = runChild(`
		globalThis.fetch = async () => new Response(${JSON.stringify("provider echoed SYNTHETIC_EXA_SECRET_MUST_NOT_ESCAPE")}, { status: 400 });
		const { searchWithExa } = await import(${JSON.stringify(exaModuleUrl)});
		let message = "";
		try { await searchWithExa("redaction test"); }
		catch (error) { message = error.message; }
		console.log(JSON.stringify({ message }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
		EXA_API_KEY: secret,
	});
	assert.equal(child.status, 0, child.stderr);
	const { message } = JSON.parse(child.stdout.trim());
	assert.equal(message.includes(secret), false);
	assert.equal(message.includes("[redacted]"), true);
});

test("keyless Exa search sends filters to the advanced MCP tool as parameters", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-exa-mcp-advanced-"));
	const child = runChild(`
		let captured = null;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), body: JSON.parse(init.body) };
			return new Response(JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: { content: [{ type: "text", text: JSON.stringify({ results: [{
					title: "Advanced result",
					url: "https://docs.example.com/advanced",
					text: "full page text",
					highlights: ["relevant highlight"],
				}] }) }] },
			}), { status: 200 });
		};

		const { searchWithExa } = await import(${JSON.stringify(exaModuleUrl)});
		const result = await searchWithExa("semantic query", {
			numResults: 3,
			recencyFilter: "week",
			domainFilter: ["docs.example.com", "-spam.example.net"],
			includeContent: true,
		});
		console.log(JSON.stringify({ captured, result }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
	});

	assert.equal(child.status, 0, child.stderr);
	const { captured, result } = JSON.parse(child.stdout.trim());
	assert.equal(captured.url, "https://mcp.exa.ai/mcp?tools=web_search_advanced_exa");
	assert.equal(captured.body.params.name, "web_search_advanced_exa");

	const { startPublishedDate, ...args } = captured.body.params.arguments;
	assert.ok(startPublishedDate);
	assert.deepEqual(args, {
		query: "semantic query",
		type: "auto",
		numResults: 3,
		includeDomains: ["docs.example.com"],
		excludeDomains: ["spam.example.net"],
		enableHighlights: true,
		textMaxCharacters: 50000,
	});

	assert.deepEqual(result.results, [{ title: "Advanced result", url: "https://docs.example.com/advanced", snippet: "" }]);
	assert.match(result.answer, /relevant highlight/);
	assert.deepEqual(result.inlineContent, [{
		url: "https://docs.example.com/advanced",
		title: "Advanced result",
		content: "full page text",
		error: null,
	}]);
});

test("keyless Exa search falls back to the default MCP tool when the advanced tool is missing", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-exa-mcp-fallback-"));
	const child = runChild(`
		const tools = [];
		globalThis.fetch = async (url, init) => {
			const target = String(url);
			tools.push(JSON.parse(init.body).params.name);
			if (target.includes("web_search_advanced_exa")) {
				return new Response(JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					error: { code: -32602, message: "Tool web_search_advanced_exa not found" },
				}), { status: 200 });
			}
			return new Response(JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: { content: [{
					type: "text",
					text: "Title: Basic result\\nURL: https://example.com/basic\\nText: basic text\\n---",
				}] },
			}), { status: 200 });
		};

		const { searchWithExa } = await import(${JSON.stringify(exaModuleUrl)});
		const result = await searchWithExa("fallback query", { domainFilter: ["example.com"] });
		console.log(JSON.stringify({ tools, result }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
	});

	assert.equal(child.status, 0, child.stderr);
	const { tools, result } = JSON.parse(child.stdout.trim());
	assert.deepEqual(tools, ["web_search_advanced_exa", "web_search_exa"]);
	assert.deepEqual(result.results, [{ title: "Basic result", url: "https://example.com/basic", snippet: "" }]);
});

