import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const searchModuleUrl = new URL("../search.ts", import.meta.url).href;

async function createConfig(config) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-enhanced-search-retry-"));
	await writeFile(join(home, "web-search-enhanced.json"), JSON.stringify(config) + "\n", "utf8");
	return home;
}

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of ["PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "EXA_API_KEY", "BRAVE_API_KEY", "TAVILY_API_KEY", "TINYFISH_API_KEY", "FIRECRAWL_BASE_URL", "FIRECRAWL_API_KEY", "QUERIT_API_KEY", "ANYSEARCH_API_KEY", "SERPAPI_KEY", "DUCKDUCKGO_API_KEY"]) {
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

// Re-runs a weighted draw from a fixed random sequence so a retry can land on a
// different provider deterministically.
const queuedRandom = (values) => `
	let __rc = 0;
	const __values = ${JSON.stringify(values)};
	Math.random = () => __values[Math.min(__rc++, __values.length - 1)];
`;

test("a retry re-samples and can succeed on a later weighted attempt", async () => {
	const home = await createConfig({
		provider: [["brave", 1], ["tavily", 1]],
		retry: 3,
		braveApiKey: "brave-test-key",
		tavilyApiKey: "tavily-test-key",
	});
	const child = runChild(`
		${queuedRandom([0.1, 0.9])}
		const calls = [];
		globalThis.fetch = async (url) => {
			const target = String(url);
			calls.push(target);
			if (target.startsWith("https://api.search.brave.com/")) throw new TypeError("fetch failed");
			if (target === "https://api.tavily.com/search") {
				return new Response(JSON.stringify({ answer: "tavily recovered", results: [] }), { status: 200 });
			}
			throw new Error("Unexpected fetch " + target);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("retry query");
		console.log(JSON.stringify({ provider: result.provider, answer: result.answer, calls }));
	`, { PI_CODING_AGENT_DIR: home });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "tavily");
	assert.equal(output.answer, "tavily recovered");
	assert.equal(output.calls.filter((url) => url.startsWith("https://api.search.brave.com/")).length, 1);
	assert.equal(output.calls.filter((url) => url === "https://api.tavily.com/search").length, 1);
});

test("retry counts total attempts and then falls back to searchRouting", async () => {
	const home = await createConfig({
		provider: [["brave", 1]],
		retry: 2,
		searchRouting: { providers: ["tavily"], fallbackOn: ["network"] },
		braveApiKey: "brave-test-key",
		tavilyApiKey: "tavily-test-key",
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const target = String(url);
			calls.push(target);
			if (target.startsWith("https://api.search.brave.com/")) throw new TypeError("fetch failed");
			if (target === "https://api.tavily.com/search") {
				return new Response(JSON.stringify({ answer: "routing fallback", results: [] }), { status: 200 });
			}
			throw new Error("Unexpected fetch " + target);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("routing fallback query");
		console.log(JSON.stringify({ provider: result.provider, answer: result.answer, calls }));
	`, { PI_CODING_AGENT_DIR: home });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "tavily");
	assert.equal(output.answer, "routing fallback");
	assert.equal(output.calls.filter((url) => url.startsWith("https://api.search.brave.com/")).length, 2);
	assert.equal(output.calls.filter((url) => url === "https://api.tavily.com/search").length, 1);
});

test("a plain string provider also retries and then falls back to searchRouting", async () => {
	const home = await createConfig({
		provider: "brave",
		retry: 2,
		searchRouting: { providers: ["tavily"], fallbackOn: ["network"] },
		braveApiKey: "brave-test-key",
		tavilyApiKey: "tavily-test-key",
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const target = String(url);
			calls.push(target);
			if (target.startsWith("https://api.search.brave.com/")) throw new TypeError("fetch failed");
			if (target === "https://api.tavily.com/search") {
				return new Response(JSON.stringify({ answer: "string provider fallback", results: [] }), { status: 200 });
			}
			throw new Error("Unexpected fetch " + target);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("string provider query");
		console.log(JSON.stringify({ provider: result.provider, answer: result.answer, calls }));
	`, { PI_CODING_AGENT_DIR: home });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "tavily");
	assert.equal(output.calls.filter((url) => url.startsWith("https://api.search.brave.com/")).length, 2);
	assert.equal(output.calls.filter((url) => url === "https://api.tavily.com/search").length, 1);
});

test("an omitted retry keeps the single-attempt error", async () => {
	const home = await createConfig({
		provider: [["brave", 1]],
		braveApiKey: "brave-test-key",
	});
	const child = runChild(`
		let calls = 0;
		globalThis.fetch = async (url) => {
			calls++;
			if (String(url).startsWith("https://api.search.brave.com/")) throw new TypeError("fetch failed");
			throw new Error("Unexpected fetch " + url);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		let error = "";
		try { await search("single attempt"); } catch (err) { error = String(err); }
		console.log(JSON.stringify({ calls, error }));
	`, { PI_CODING_AGENT_DIR: home });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.calls, 1);
	assert.match(output.error, /fetch failed/);
	assert.doesNotMatch(output.error, /Balanced search failed/);
});

test("exhausted retries without searchRouting report every attempt", async () => {
	const home = await createConfig({
		provider: [["brave", 1]],
		retry: 3,
		braveApiKey: "brave-test-key",
	});
	const child = runChild(`
		let calls = 0;
		globalThis.fetch = async (url) => {
			calls++;
			throw new TypeError("fetch failed");
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		let error = "";
		try { await search("exhausted"); } catch (err) { error = String(err); }
		console.log(JSON.stringify({ calls, error }));
	`, { PI_CODING_AGENT_DIR: home });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.calls, 3);
	assert.match(output.error, /Balanced search failed after 3 attempts/);
});

test("retry must be a positive integer", async () => {
	for (const [retry, pattern] of [[0, /retry in .*web-search-enhanced\.json must be a positive integer/], [-1, /must be a positive integer/], [1.5, /must be a positive integer/], ["2", /must be a positive integer/]]) {
		const home = await createConfig({ provider: [["brave", 1]], retry, braveApiKey: "brave-test-key" });
		const child = runChild(`
			globalThis.fetch = async () => { throw new Error("must not fetch"); };
			const { search } = await import(${JSON.stringify(searchModuleUrl)});
			let error = "";
			try { await search("invalid retry"); } catch (err) { error = String(err); }
			console.log(JSON.stringify({ error }));
		`, { PI_CODING_AGENT_DIR: home });

		assert.equal(child.status, 0, child.stderr);
		assert.match(JSON.parse(child.stdout.trim()).error, pattern, `retry=${JSON.stringify(retry)}`);
	}
});
