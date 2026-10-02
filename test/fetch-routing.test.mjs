import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const extractUrl = new URL("../extract.ts", import.meta.url).href;
const featureConfigUrl = new URL("../feature-config.ts", import.meta.url).href;

function cleanProviderEnv(root) {
	const childEnv = { ...process.env, PI_CODING_AGENT_DIR: root, HOME: root, USERPROFILE: root };
	for (const key of [
		"CRAWL4AI_BASE_URL", "CRAWL4AI_API_TOKEN", "FIRECRAWL_BASE_URL", "FIRECRAWL_API_KEY", "PARALLEL_API_KEY", "TINYFISH_API_KEY",
		"SEARCH1API_KEY", "SEARCH1API_API_KEY", "QUERIT_API_KEY", "KAGI_API_KEY", "OLLAMA_API_KEY",
		"BRIGHTDATA_API_KEY", "BRIGHTDATA_UNLOCKER_ZONE", "GEMINI_API_KEY", "GOOGLE_GEMINI_API_KEY", "GOOGLE_API_KEY",
	]) delete childEnv[key];
	return childEnv;
}

async function runExtract(config, { tinyfishFails = false } = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-fetch-routing-"));
	await writeFile(join(root, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	const childEnv = cleanProviderEnv(root);
	childEnv.TINYFISH_API_KEY = "tinyfish-test-key";

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const calls = [];
			globalThis.fetch = async (url) => {
				const text = String(url);
				calls.push(text);
				if (text === "https://api.fetch.tinyfish.ai" && !${tinyfishFails}) {
					return new Response(JSON.stringify({ results: [{ url: "https://example.com/routed", final_url: "https://example.com/routed", title: "Routed", text: "# Routed\\n\\n" + "TinyFish routed content. ".repeat(12), format: "markdown" }], errors: [] }), { status: 200 });
				}
				return new Response("blocked", { status: 403 });
			};
			const { extractContent } = await import(${JSON.stringify(extractUrl)});
			const result = await extractContent("https://example.com/routed", undefined, { lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
			console.log(JSON.stringify({ calls, result }));
		`,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

async function runTypedExtract(config, contentType) {
	const root = await mkdtemp(join(tmpdir(), "pi-fetch-routing-typed-"));
	await writeFile(join(root, "web-search.json"), typeof config === "string" ? config : JSON.stringify(config) + "\n", "utf8");
	const childEnv = cleanProviderEnv(root);
	const childEnvWithKey = { ...childEnv, TINYFISH_API_KEY: "tinyfish-test-key" };
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const calls = [];
			globalThis.fetch = async (url) => {
				const text = String(url);
				calls.push(text);
				if (text === "https://example.com/typed") {
					return new Response("typed", { status: 200, headers: { "content-type": ${JSON.stringify(contentType)} } });
				}
				if (text.startsWith("https://r.jina.ai/")) {
					return new Response("Markdown Content:\\n# Bypassed\\n\\n" + "content ".repeat(80), { status: 200 });
				}
				throw new Error("Unexpected fetch " + text);
			};
			const { extractContent } = await import(${JSON.stringify(extractUrl)});
			const result = await extractContent("https://example.com/typed", undefined, { lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
			console.log(JSON.stringify({ calls, result }));
		`,
		encoding: "utf8",
		env: childEnvWithKey,
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

test("fetchRouting.providers can put TinyFish first after explicit remote-hosted opt-in", async () => {
	const output = await runExtract({ fetchRouting: { providers: ["tinyfish", "http"], allowRemoteHostedProviders: true } });
	assert.deepEqual(output.calls, [
		"https://example.com/routed",
		"https://api.fetch.tinyfish.ai",
	]);
	assert.equal(output.result.error, null);
	assert.equal(output.result.title, "Routed");
});

test("remote hosted fetch providers are disabled by default", async () => {
	const output = await runExtract({});
	assert.deepEqual(output.calls, ["https://example.com/routed"]);
	assert.match(output.result.error, /HTTP 403/);
});

test("fetchRouting without providers uses the default order when remote hosted providers are allowed", async () => {
	const output = await runExtract({ fetchRouting: { allowRemoteHostedProviders: true } });
	assert.deepEqual(output.calls, [
		"https://example.com/routed",
		"https://api.fetch.tinyfish.ai",
	]);
	assert.equal(output.result.error, null);
	assert.equal(output.result.title, "Routed");
});

test("blocked-page guidance names the remote-hosted opt-in for TinyFish and Querit", async () => {
	const output = await runExtract({});
	assert.match(output.result.error, /Fallback options:/);
	assert.match(output.result.error, /TinyFish and Querit are hosted services and are disabled for remote HTTP\(S\) targets/);
	assert.match(output.result.error, /set fetchRouting\.allowRemoteHostedProviders to true in .*web-search\.json/);
	assert.match(output.result.error, /target URLs are fetched through their infrastructure/);
	assert.doesNotMatch(output.result.error, /Enable the keyless Jina Reader fallback/);
});

test("disabled image fetching does not fall through to hosted providers", async () => {
	const output = await runTypedExtract({ image: { enabled: false }, fetchRouting: { providers: ["http", "tinyfish"], allowRemoteHostedProviders: true } }, "image/png");
	assert.deepEqual(output.calls, ["https://example.com/typed"]);
	assert.match(output.result.error, /Image fetching is disabled by image\.enabled/);
});

test("disabled PDF extraction does not fall through to hosted providers", async () => {
	const output = await runTypedExtract({ pdf: { enabled: false }, fetchRouting: { providers: ["http", "tinyfish"], allowRemoteHostedProviders: true } }, "application/pdf");
	assert.deepEqual(output.calls, ["https://example.com/typed"]);
	assert.match(output.result.error, /PDF extraction is disabled by pdf\.enabled/);
});

test("malformed config returns a parse error without hosted fallback", async () => {
	const output = await runTypedExtract("{", "image/png");
	assert.deepEqual(output.calls, []);
	assert.match(output.result.error, /Failed to parse .*web-search\.json/);
});

test("the image gate reports a malformed config instead of silently enabling images", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-feature-config-"));
	await writeFile(join(root, "web-search.json"), "{", "utf8");
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(root)};
			const { isImageEnabled } = await import(${JSON.stringify(featureConfigUrl)});
			let parseError = "";
			let enabled;
			try { enabled = isImageEnabled(); } catch (err) { parseError = err instanceof Error ? err.message : String(err); }
			console.log(JSON.stringify({ enabled, parseError }));
		`,
		encoding: "utf8",
		env: cleanProviderEnv(root),
	});
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.parseError, /Failed to parse .*web-search\.json/);
});

test("TinyFish is disabled for remote URLs without hosted-provider opt-in", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-fetch-routing-tinyfish-gate-"));
	await writeFile(join(root, "web-search.json"), JSON.stringify({ tinyfishApiKey: "test-key", fetchRouting: { providers: ["tinyfish", "http"] } }) + "\n", "utf8");
	const childEnv = cleanProviderEnv(root);
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const calls = [];
			globalThis.fetch = async (url) => {
				const text = String(url);
				calls.push(text);
				if (text === "https://example.com/routed") return new Response("blocked", { status: 403 });
				if (text === "https://api.fetch.tinyfish.ai") return new Response(JSON.stringify({ results: [{ url: "https://example.com/routed", final_url: "https://example.com/routed", title: "TinyFish", text: "# remote content", format: "markdown" }], errors: [] }), { status: 200 });
				throw new Error("Unexpected fetch " + text);
			};
			const { extractContent } = await import(${JSON.stringify(extractUrl)});
			const result = await extractContent("https://example.com/routed", undefined, { lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
			console.log(JSON.stringify({ calls, result }));
		`,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls, ["https://example.com/routed"]);
	assert.match(output.result.error, /HTTP 403/);
});

test("hosted providers cannot bypass redirect policy validation", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-fetch-routing-redirect-"));
	await writeFile(join(root, "web-search.json"), JSON.stringify({ fetchRouting: { providers: ["tinyfish"], allowRemoteHostedProviders: true } }) + "\n", "utf8");
	const childEnv = { ...process.env, PI_CODING_AGENT_DIR: root, HOME: root, USERPROFILE: root };
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const calls = [];
			globalThis.fetch = async (url) => {
				const text = String(url);
				calls.push(text);
				if (text === "https://example.com/redirect") {
					return new Response("", { status: 302, headers: { location: "http://127.0.0.1/admin" } });
				}
				if (text.startsWith("https://r.jina.ai/")) {
					return new Response("Markdown Content:\\n# Bypassed\\n\\n" + "content ".repeat(80), { status: 200 });
				}
				throw new Error("Unexpected fetch " + text);
			};
			const { extractContent } = await import(${JSON.stringify(extractUrl)});
			const result = await extractContent("https://example.com/redirect", undefined, { lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
			console.log(JSON.stringify({ calls, result }));
		`,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls, ["https://example.com/redirect"]);
	assert.match(output.result.error, /Blocked internal address/);
});

const readableFiller = "<p>" + "Example.com needs to review the security of your connection before proceeding with this readable article text. ".repeat(8) + "</p>";
const genericMomentPage = `<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><article><h1>Just a moment...</h1>${readableFiller}${readableFiller}</article></body></html>`;
const cloudflareChallengePage = `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body><article><h1>Verifying you are human</h1>${readableFiller}${readableFiller}</article><script>(function(){window._cf_chl_opt={cvId:'3',cType:'managed'};var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=abc';document.head.appendChild(a);}());</script></body></html>`;

async function runChallengeExtract(config, { body, headers = {}, mode } = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-fetch-routing-challenge-"));
	await writeFile(join(root, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const calls = [];
			globalThis.fetch = async (url) => {
				const text = String(url);
				calls.push(text);
				if (text === "https://example.com/challenge") {
					return new Response(${JSON.stringify(body)}, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...${JSON.stringify(headers)} } });
				}
				if (text === "https://api.fetch.tinyfish.ai") {
					return new Response(JSON.stringify({ results: [{ url: "https://example.com/challenge", final_url: "https://example.com/challenge", title: "Routed", text: "# Routed\\n\\n" + "TinyFish routed content. ".repeat(12), format: "markdown" }], errors: [] }), { status: 200 });
				}
				throw new Error("Unexpected fetch " + text);
			};
			const { extractContent } = await import(${JSON.stringify(extractUrl)});
			const result = await extractContent("https://example.com/challenge", undefined, { ${mode ? `mode: ${JSON.stringify(mode)}, ` : ""}lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
			console.log(JSON.stringify({ calls, result }));
		`,
		encoding: "utf8",
		env: { ...cleanProviderEnv(root), TINYFISH_API_KEY: "tinyfish-test-key" },
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

const challengeFallbackRouting = { fetchRouting: { providers: ["http", "tinyfish"], allowRemoteHostedProviders: true } };

test("HTTP 200 with cf-mitigated: challenge falls back to configured providers", async () => {
	const output = await runChallengeExtract(challengeFallbackRouting, { body: genericMomentPage, headers: { "cf-mitigated": "challenge" } });
	assert.deepEqual(output.calls, ["https://example.com/challenge", "https://api.fetch.tinyfish.ai"]);
	assert.equal(output.result.error, null);
	assert.equal(output.result.title, "Routed");
});

test("HTTP 200 cf-mitigated: challenge falls back even when the response is not labeled HTML", async () => {
	const output = await runChallengeExtract(challengeFallbackRouting, { body: "Just a moment...", headers: { "content-type": "text/plain", "cf-mitigated": "challenge" } });
	assert.deepEqual(output.calls, ["https://example.com/challenge", "https://api.fetch.tinyfish.ai"]);
	assert.equal(output.result.error, null);
	assert.equal(output.result.title, "Routed");
});

test("Cloudflare body markers in a non-HTML response are returned as content", async () => {
	const output = await runChallengeExtract(challengeFallbackRouting, { body: cloudflareChallengePage, headers: { "content-type": "text/plain" } });
	assert.deepEqual(output.calls, ["https://example.com/challenge"]);
	assert.equal(output.result.error, null);
	assert.equal(output.result.content, cloudflareChallengePage);
});

test("HTTP 200 Cloudflare challenge body signature falls back to configured providers", async () => {
	const output = await runChallengeExtract(challengeFallbackRouting, { body: cloudflareChallengePage });
	assert.deepEqual(output.calls, ["https://example.com/challenge", "https://api.fetch.tinyfish.ai"]);
	assert.equal(output.result.error, null);
	assert.equal(output.result.title, "Routed");
});

test("generic Just a moment text alone is not treated as a challenge", async () => {
	const output = await runChallengeExtract(challengeFallbackRouting, { body: genericMomentPage });
	assert.deepEqual(output.calls, ["https://example.com/challenge"]);
	assert.equal(output.result.error, null);
	assert.match(output.result.content, /readable article text/);
});

test("HTTP-only routing reports a Cloudflare challenge as an HTTP extraction failure", async () => {
	const output = await runChallengeExtract({}, { body: cloudflareChallengePage, headers: { "cf-mitigated": "challenge" } });
	assert.deepEqual(output.calls, ["https://example.com/challenge"]);
	assert.match(output.result.error, /^HTTP 200: Blocked by Cloudflare challenge page/);
	assert.equal(output.result.content, "");
});

test("raw mode returns Cloudflare challenge bodies verbatim without fallback", async () => {
	const output = await runChallengeExtract(challengeFallbackRouting, { body: cloudflareChallengePage, headers: { "cf-mitigated": "challenge" }, mode: "raw" });
	assert.deepEqual(output.calls, ["https://example.com/challenge"]);
	assert.equal(output.result.error, null);
	assert.equal(output.result.content, cloudflareChallengePage);
});
