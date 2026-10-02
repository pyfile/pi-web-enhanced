import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import initializeExtension from "../index.ts";
import { getActiveProxy, installGlobalProxyFetch, runWithProxy } from "../utils.ts";

const originalFetch = globalThis.fetch;
const originalPath = process.env.PATH;
const originalNoProxy = process.env.NO_PROXY;
const originalNoProxyLower = process.env.no_proxy;
const utilsUrl = new URL("../utils.ts", import.meta.url).href;
const ssrfProtectionUrl = new URL("../ssrf-protection.ts", import.meta.url).href;
const indexUrl = new URL("../index.ts", import.meta.url).href;

function runConfigProbe(dir, script) {
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { getActiveProxy, hasScopedProxyDecision, runWithProxy } = await import(${JSON.stringify(utilsUrl)});
			const { validateRemoteUrl } = await import(${JSON.stringify(ssrfProtectionUrl)});
			${script}
		`,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: dir },
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout);
}

async function withFakeCurl(t, routes, fn) {
	const dir = await mkdtemp(join(tmpdir(), "pi-proxy-test-"));
	const logPath = join(dir, "curl-args.jsonl");
	const curlPath = join(dir, "curl");
	await writeFile(curlPath, `#!/usr/bin/env node
const fs = require("node:fs");
const routes = JSON.parse(process.env.PI_PROXY_TEST_ROUTES);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PI_PROXY_TEST_LOG, JSON.stringify(args) + "\\n");
function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}
const url = args[args.length - 1];
const route = routes[url];
if (!route) throw new Error("unexpected url " + url);
fs.writeFileSync(valueAfter("-D"), "HTTP/1.1 " + route.status + " " + route.statusText + "\\r\\n" + (route.location ? "Location: " + route.location + "\\r\\n" : "") + "\\r\\n");
fs.writeFileSync(valueAfter("--output"), route.body || "");
process.stdout.write(JSON.stringify({ url_effective: url, num_redirects: 0 }));
`);
	await chmod(curlPath, 0o755);
	process.env.PATH = `${dir}:${originalPath ?? ""}`;
	process.env.PI_PROXY_TEST_LOG = logPath;
	process.env.PI_PROXY_TEST_ROUTES = JSON.stringify(routes);
	process.env.NO_PROXY = "";
	process.env.no_proxy = "";
	globalThis.fetch = originalFetch;
	installGlobalProxyFetch();
	t.after(async () => {
		globalThis.fetch = originalFetch;
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		if (originalNoProxy === undefined) delete process.env.NO_PROXY;
		else process.env.NO_PROXY = originalNoProxy;
		if (originalNoProxyLower === undefined) delete process.env.no_proxy;
		else process.env.no_proxy = originalNoProxyLower;
		delete process.env.PI_PROXY_TEST_LOG;
		delete process.env.PI_PROXY_TEST_ROUTES;
		await rm(dir, { recursive: true, force: true });
	});
	const result = await fn(logPath);
	return result;
}

async function readCurlCalls(logPath) {
	return (await readFile(logPath, "utf8"))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function headerValues(args) {
	const values = [];
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "-H") values.push(args[index + 1]);
	}
	return values;
}

function registerSourceCheck() {
	const tools = [];
	initializeExtension({
		registerTool(tool) { tools.push(tool); },
		registerCommand() {},
		registerShortcut() {},
		on() {},
		appendEntry() {},
	});
	return tools.find((tool) => tool.name === "source_check");
}

function registerFetchContent() {
	const tools = [];
	initializeExtension({
		registerTool(tool) { tools.push(tool); },
		registerCommand() {},
		registerShortcut() {},
		on() {},
		appendEntry() {},
	});
	return tools.find((tool) => tool.name === "fetch_content");
}

function proxyArg(args) {
	const index = args.indexOf("-x");
	return index === -1 ? undefined : args[index + 1];
}

test("extension initialization preserves fetch identity and installs proxy transport on first proxied tool call", async (t) => {
	await withFakeCurl(t, {
		"https://example.com/page": {
			status: 200,
			statusText: "OK",
			body: "<html><title>Proxy page</title><body>Fetched lazily through the requested proxy.</body></html>",
		},
	}, async (logPath) => {
		const configDir = dirname(logPath);
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: `
				const hostFetch = globalThis.fetch;
				const tools = [];
				const initializeExtension = (await import(${JSON.stringify(indexUrl)})).default;
				initializeExtension({
					registerTool(tool) { tools.push(tool); },
					registerCommand() {},
					registerShortcut() {},
					on() {},
					appendEntry() {},
				});
				const unchangedAfterInit = globalThis.fetch === hostFetch;
				const tool = tools.find((candidate) => candidate.name === "fetch_content");
				const result = await tool.execute("call", {
					url: "https://example.com/page",
					proxy: "http://call-proxy.example:8080",
				});
				console.log(JSON.stringify({
					unchangedAfterInit,
					installedAfterProxyCall: globalThis.fetch !== hostFetch,
					successful: result.details.successful,
				}));
			`,
			encoding: "utf8",
			env: { ...process.env, PI_CODING_AGENT_DIR: configDir },
			maxBuffer: 2 * 1024 * 1024,
		});

		assert.equal(child.status, 0, child.stderr);
		assert.deepEqual(JSON.parse(child.stdout.trim()), {
			unchangedAfterInit: true,
			installedAfterProxyCall: true,
			successful: 1,
		});
		const calls = await readCurlCalls(logPath);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].at(-1), "https://example.com/page");
		assert.ok(["http://call-proxy.example:8080", "http://call-proxy.example:8080/"].includes(proxyArg(calls[0])));
	});
});

test("proxy curl redirects strip caller headers across origins", async (t) => {
	await withFakeCurl(t, {
		"https://origin.example/start": { status: 302, statusText: "Found", location: "https://other.example/final" },
		"https://other.example/final": { status: 200, statusText: "OK", body: "ok" },
	}, async (logPath) => {
		const response = await runWithProxy("http://proxy.example:8080", () => fetch("https://origin.example/start", {
			headers: {
				Authorization: "Bearer secret",
				Cookie: "session=secret",
				"X-Api-Key": "secret",
				Accept: "text/html",
			},
		}));

		assert.equal(await response.text(), "ok");
		assert.equal(response.url, "https://other.example/final");
		assert.equal(response.redirected, true);
		const calls = await readCurlCalls(logPath);
		assert.equal(calls.length, 2);
		assert.ok(headerValues(calls[0]).some((header) => /^authorization:/i.test(header)));
		assert.deepEqual(headerValues(calls[1]), []);
		assert.ok(calls.every((args) => !args.includes("--location")));
	});
});

test("configured proxy is scoped to web operations while empty string forces direct access", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-proxy-config-test-"));
	await writeFile(join(dir, "web-search.json"), JSON.stringify({ proxy: "http://global-proxy.example:8080" }));
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	assert.deepEqual(runConfigProbe(dir, `
		console.log(JSON.stringify([
			getActiveProxy(),
			runWithProxy(undefined, () => getActiveProxy()),
			runWithProxy("", () => getActiveProxy()),
			runWithProxy("http://call-proxy.example:8080", () => getActiveProxy()),
			getActiveProxy(),
		]));
	`), [
		null,
		"http://global-proxy.example:8080/",
		null,
		"http://call-proxy.example:8080/",
		null,
	]);
});

test("omitted proxy preserves trusted environment proxy routing when no proxy is configured", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-proxy-env-trust-test-"));
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	assert.deepEqual(runConfigProbe(dir, `
		for (const key of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"]) {
			delete process.env[key];
		}
		process.env.HTTPS_PROXY = "http://env-proxy.example:8080";
		let lookups = 0;
		await runWithProxy(undefined, () => validateRemoteUrl("https://public.example.test/", {
			trustEnvProxy: true,
			lookup: async () => {
				lookups++;
				return [{ address: "10.0.0.10", family: 4 }];
			},
		}));
		console.log(JSON.stringify({ lookups, scoped: hasScopedProxyDecision() }));
	`), { lookups: 0, scoped: false });
});

test("fetch_content lets a trusted configured proxy resolve hostnames that local DNS cannot", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-proxy-trusted-dns-test-"));
	await writeFile(join(dir, "web-search.json"), JSON.stringify({ proxy: "http://configured-proxy.example:3128", ssrf: { trustEnvProxy: true } }));
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
	});
	// `.test` never resolves, so success proves no local DNS preflight ran.
	const url = "https://unresolvable.example.test/page";

	await withFakeCurl(t, {
		[url]: { status: 200, statusText: "OK", body: "<html><title>Proxied</title><body>Resolved by the proxy.</body></html>" },
	}, async (logPath) => {
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: `
				const { default: initializeExtension } = await import(${JSON.stringify(indexUrl)});
				const tools = [];
				initializeExtension({ registerTool(tool) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
				const tool = tools.find((tool) => tool.name === "fetch_content");
				const omitted = await tool.execute("omitted", { url: ${JSON.stringify(url)} });
				const explicit = await tool.execute("explicit", { url: ${JSON.stringify(url)}, proxy: "http://configured-proxy.example:3128" });
				console.log(JSON.stringify([omitted.details.successful, explicit.details.successful]));
			`,
			encoding: "utf8",
			env: { ...process.env, PI_CODING_AGENT_DIR: dir },
			maxBuffer: 2 * 1024 * 1024,
		});
		assert.equal(child.status, 0, child.stderr);
		assert.deepEqual(JSON.parse(child.stdout.trim().split("\n").at(-1)), [1, 1]);
		const pageCalls = (await readCurlCalls(logPath)).filter((args) => args.at(-1) === url);
		assert.equal(pageCalls.length, 2);
		assert.ok(pageCalls.every((args) => ["http://configured-proxy.example:3128", "http://configured-proxy.example:3128/"].includes(proxyArg(args))));
	});
});

test("configured proxy DNS trust never extends to a different per-call proxy", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-proxy-trust-scope-test-"));
	await writeFile(join(dir, "web-search.json"), JSON.stringify({ proxy: "http://configured-proxy.example:3128" }));
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
	});
	const probe = (trustEnvProxy) => `
		const privateLookup = async () => [{ address: "10.0.0.10", family: 4 }];
		const outcome = async (fn) => { try { await fn(); return "trusted"; } catch (error) { return error.message; } };
		const validate = (options = {}) => validateRemoteUrl("https://internal.example.test/", { trustEnvProxy: ${trustEnvProxy}, lookup: privateLookup, ...options });
		console.log(JSON.stringify([
			await runWithProxy(undefined, () => outcome(() => validate())),
			await runWithProxy("http://model-proxy.example:3128", () => outcome(() => validate())),
			await runWithProxy(undefined, () => outcome(() => validate({ proxy: "http://model-proxy.example:3128" }))),
			await runWithProxy(undefined, () => outcome(() => validate({ lookup: async () => { throw new Error("getaddrinfo ENOTFOUND"); } }))),
		]));
	`;

	const [trusted, perCall, pinned] = runConfigProbe(dir, probe(true));
	assert.equal(trusted, "trusted");
	assert.match(perCall, /Blocked internal address/);
	assert.match(pinned, /Blocked internal address/);

	const untrusted = runConfigProbe(dir, probe(false));
	assert.match(untrusted[0], /Blocked internal address/);
	assert.match(untrusted[3], /^Failed to resolve internal\.example\.test: getaddrinfo ENOTFOUND\. If your configured proxy resolves hostnames, set ssrf\.trustEnvProxy to true/);
});

test("invalid configured proxy fails closed instead of direct fetching", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-proxy-invalid-config-test-"));
	await writeFile(join(dir, "web-search.json"), JSON.stringify({ proxy: "ftp://proxy.example:21" }));
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	assert.match(runConfigProbe(dir, `
		let message = "";
		try {
			runWithProxy(undefined, () => getActiveProxy());
		} catch (error) {
			message = error.message;
		}
		console.log(JSON.stringify(message));
	`), /proxy.*must use the http:\/\/, https:\/\/, or socks scheme/);
});

test("invalid configured proxy reaches background fetch rejection handling", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-proxy-background-config-test-"));
	const configPath = join(dir, "web-search.json");
	await writeFile(configPath, JSON.stringify({ provider: "tavily", tavilyApiKey: "proxy-background-test-key" }));
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { writeFileSync } = await import("node:fs");
			const configPath = ${JSON.stringify(configPath)};
			const messages = [];
			globalThis.fetch = async (url) => {
				if (String(url) !== "https://api.tavily.com/search") {
					throw new Error("Unexpected fetch: " + url);
				}
				writeFileSync(configPath, JSON.stringify({ provider: "tavily", tavilyApiKey: "proxy-background-test-key", proxy: "ftp://proxy.example:21" }));
				return new Response(JSON.stringify({
					answer: "Search answer",
					results: [{ title: "Source", url: "https://example.com/source", content: "snippet" }],
				}), { status: 200, headers: { "content-type": "application/json" } });
			};
			const tools = [];
			const handlers = new Map();
			const pi = {
				registerTool(tool) { tools.push(tool); },
				registerCommand() {},
				registerShortcut() {},
				on(event, handler) { handlers.set(event, handler); },
				appendEntry() {},
				sendMessage(message) { messages.push(message); },
			};
			const initializeExtension = (await import(${JSON.stringify(indexUrl)})).default;
			initializeExtension(pi);
			await handlers.get("session_start")({}, { sessionManager: { getBranch: () => [] } });
			const tool = tools.find((candidate) => candidate.name === "web_search");
			const result = await tool.execute("background-proxy-test", {
				query: "proxy cleanup",
				provider: "tavily",
				includeContent: true,
			});
			await new Promise((resolve) => setImmediate(resolve));
			console.log(JSON.stringify({
				result: result.content[0].text,
				errors: messages.filter((message) => message.customType === "web-search-error").map((message) => message.content),
			}));
		`,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: dir, TAVILY_API_KEY: "proxy-background-test-key" },
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.result, /Content fetching in background/);
	assert.equal(output.errors.length, 1, JSON.stringify(output));
	assert.match(output.errors[0], /proxy.*must use the http:\/\/, https:\/\/, or socks scheme/);
});

test("proxy transport does not spawn curl for pre-aborted requests", async (t) => {
	await withFakeCurl(t, {
		"https://origin.example/abort": { status: 200, statusText: "OK", body: "late" },
	}, async (logPath) => {
		const controller = new AbortController();
		controller.abort();

		await assert.rejects(
			runWithProxy("http://proxy.example:8080", () => fetch("https://origin.example/abort", { signal: controller.signal })),
			/error.*abort/i,
		);
		await assert.rejects(readFile(logPath, "utf8"), /ENOENT/);
	});
});

test("proxy transport errors redact proxy credentials", async (t) => {
	await withFakeCurl(t, {}, async () => {
		await assert.rejects(
			runWithProxy("http://user:secret@proxy.example:8080", () => fetch("https://origin.example/missing")),
			(error) => {
				assert.match(error.message, /http:\/\/redacted:redacted@proxy\.example:8080\//);
				assert.doesNotMatch(error.message, /user:secret/);
				return true;
			},
		);
	});
});

test("proxy curl redirects keep caller headers on the same origin", async (t) => {
	await withFakeCurl(t, {
		"https://origin.example/start": { status: 302, statusText: "Found", location: "/final" },
		"https://origin.example/final": { status: 200, statusText: "OK", body: "ok" },
	}, async (logPath) => {
		await runWithProxy("http://proxy.example:8080", () => fetch("https://origin.example/start", {
			headers: { Authorization: "Bearer secret" },
		}));

		const calls = await readCurlCalls(logPath);
		assert.equal(calls.length, 2);
		assert.ok(headerValues(calls[1]).some((header) => /^authorization:/i.test(header)));
	});
});

test("proxy curl keeps manual redirects as redirect responses", async (t) => {
	await withFakeCurl(t, {
		"https://origin.example/start": { status: 302, statusText: "Found", location: "https://other.example/final" },
	}, async (logPath) => {
		const response = await runWithProxy("http://proxy.example:8080", () => fetch("https://origin.example/start", { redirect: "manual" }));

		assert.equal(response.status, 302);
		assert.equal(response.headers.get("location"), "https://other.example/final");
		assert.equal((await readCurlCalls(logPath)).length, 1);
	});
});

test("source_check fetchContent uses the explicit proxy for result pages", async (t) => {
	const previousKey = process.env.TAVILY_API_KEY;
	process.env.TAVILY_API_KEY = "source-check-proxy-test-key";
	t.after(() => {
		if (previousKey === undefined) delete process.env.TAVILY_API_KEY;
		else process.env.TAVILY_API_KEY = previousKey;
	});

	await withFakeCurl(t, {
		"https://api.tavily.com/search": {
			status: 200,
			statusText: "OK",
			body: JSON.stringify({
				answer: "",
				results: [{ title: "API docs", url: "https://example.com/api", content: "snippet" }],
			}),
		},
		"https://example.com/api": { status: 200, statusText: "OK", body: "<html><title>API docs</title><body>The API docs are available.</body></html>" },
	}, async (logPath) => {
		const tool = registerSourceCheck();
		assert.ok(tool);
		const response = await tool.execute("call", {
			claim: "API docs",
			provider: "tavily",
			fetchContent: true,
			proxy: "http://call-proxy.example:8080",
		}, undefined, undefined, { modelRegistry: {} });

		assert.equal(response.details.sourceCount, 1);
		const calls = await readCurlCalls(logPath);
		const apiCall = calls.find((args) => args.at(-1) === "https://api.tavily.com/search");
		const pageCall = calls.find((args) => args.at(-1) === "https://example.com/api");
		assert.ok(apiCall);
		assert.ok(pageCall);
		assert.ok(["http://call-proxy.example:8080", "http://call-proxy.example:8080/"].includes(proxyArg(apiCall)));
		assert.ok(["http://call-proxy.example:8080", "http://call-proxy.example:8080/"].includes(proxyArg(pageCall)));
	});
});

test("fetch_content passes the explicit proxy through queued extraction", async (t) => {
	await withFakeCurl(t, {
		"https://example.com/page": {
			status: 200,
			statusText: "OK",
			body: "<html><title>Proxy page</title><body>Fetched through the requested proxy.</body></html>",
		},
	}, async (logPath) => {
		const tool = registerFetchContent();
		assert.ok(tool);
		const response = await tool.execute("call", {
			url: "https://example.com/page",
			proxy: "http://call-proxy.example:8080",
		});

		assert.equal(response.details.successful, 1);
		const pageCall = (await readCurlCalls(logPath)).find((args) => args.at(-1) === "https://example.com/page");
		assert.ok(pageCall);
		assert.ok(["http://call-proxy.example:8080", "http://call-proxy.example:8080/"].includes(proxyArg(pageCall)));
	});
});
