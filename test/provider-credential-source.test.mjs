import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const braveModuleUrl = new URL("../brave.ts", import.meta.url).href;
const anysearchModuleUrl = new URL("../anysearch.ts", import.meta.url).href;
const serpapiModuleUrl = new URL("../serpapi.ts", import.meta.url).href;
const tinyfishModuleUrl = new URL("../tinyfish.ts", import.meta.url).href;
const tavilyModuleUrl = new URL("../tavily.ts", import.meta.url).href;

async function createHome(config) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-credential-source-"));
	const agentDir = join(home, "agent");
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return { home, agentDir };
}

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR",
		"XDG_CONFIG_HOME",
		"BRAVE_API_KEY",
		"CLOUDFLARE_API_KEY",
		"GEMINI_API_KEY",
		"GOOGLE_GEMINI_BASE_URL",
		"OPENAI_API_KEY",
		"PARALLEL_API_KEY",
		"TINYFISH_API_KEY",
		"SEARCH1API_KEY",
		"SEARCHINFINITY_API_KEY",
		"QUERIT_API_KEY",
		"PERPLEXITY_API_KEY",
		"TAVILY_API_KEY",
		"JINA_API_KEY",
	]) delete childEnv[key];
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

test("configured providers resolve explicit env and command sources lazily", async () => {
	const tavilyMarker = join(await mkdtemp(join(tmpdir(), "pi-web-enhanced-credential-marker-")), "tavily-ran");
	const tinyfishMarker = join(await mkdtemp(join(tmpdir(), "pi-web-enhanced-credential-marker-")), "tinyfish-ran");
	const { home, agentDir } = await createHome({
		braveApiKey: "${BRAVE_SCOPED_KEY}",
		tinyfishApiKey: `!touch ${tinyfishMarker} && printf tinyfish-command-key`,
		tavilyApiKey: `!touch ${tavilyMarker} && printf tavily-command-key`,
	});
	const child = runChild(`
		import { existsSync } from "node:fs";
		const { isBraveAvailable, searchWithBrave } = await import(${JSON.stringify(braveModuleUrl)});
		const { isTinyFishAvailable, searchWithTinyFish } = await import(${JSON.stringify(tinyfishModuleUrl)});
		const { isTavilyAvailable, searchWithTavily } = await import(${JSON.stringify(tavilyModuleUrl)});
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)) });
			return new Response(JSON.stringify({ web: { results: [{ title: "Brave", url: "https://example.com/brave", description: "result" }] } }), { status: 200 });
		};
		const availableBefore = {
			brave: isBraveAvailable(),
			tinyfish: isTinyFishAvailable(),
			tavily: isTavilyAvailable(),
			tinyfishMarker: existsSync(${JSON.stringify(tinyfishMarker)}),
			tavilyMarker: existsSync(${JSON.stringify(tavilyMarker)}),
		};
		await searchWithBrave("brave", { numResults: 1 });
		globalThis.fetch = async (url, init = {}) => {
			calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)) });
			return new Response(JSON.stringify({ results: [{ url: "https://example.com/tinyfish", final_url: "https://example.com/tinyfish", title: "TinyFish", text: "# TinyFish", format: "markdown" }], errors: [] }), { status: 200 });
		};
		await searchWithTinyFish("tinyfish", { numResults: 1 });
		globalThis.fetch = async (url, init = {}) => {
			calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)) });
			return new Response(JSON.stringify({ answer: "", results: [{ title: "Tavily", url: "https://example.com/tavily", content: "result" }] }), { status: 200 });
		};
		await searchWithTavily("tavily", { numResults: 1 });
		console.log(JSON.stringify({
			availableBefore,
			tinyfishMarkerAfter: existsSync(${JSON.stringify(tinyfishMarker)}),
			tavilyMarkerAfter: existsSync(${JSON.stringify(tavilyMarker)}),
			calls,
		}));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: agentDir,
		BRAVE_SCOPED_KEY: "brave-scoped-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.availableBefore, {
		brave: true,
		tinyfish: true,
		tavily: true,
		tinyfishMarker: false,
		tavilyMarker: false,
	});
	assert.equal(output.tinyfishMarkerAfter, true);
	assert.equal(output.tavilyMarkerAfter, true);
	assert.equal(output.calls[0].headers["x-subscription-token"], "brave-scoped-key");
	assert.equal(output.calls[1].headers["x-api-key"], "tinyfish-command-key");
	assert.equal(output.calls[2].headers.authorization, "Bearer tavily-command-key");
});

test("provider requests can resolve credentials through an inherited 1Password service-account token", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-fake-op-"));
	const fakeOp = join(root, "fake-op.mjs");
	await writeFile(fakeOp, `
		if (process.argv.slice(2).join(" ") !== "read op://Automation/Brave/credential") process.exit(2);
		if (process.env.OP_SERVICE_ACCOUNT_TOKEN !== "synthetic-service-account-token") process.exit(3);
		if (process.env.UNRELATED_SECRET !== undefined) process.exit(4);
		process.stdout.write("synthetic-brave-key");
	`, "utf8");
	const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(fakeOp)} read ${JSON.stringify("op://Automation/Brave/credential")}`;
	const { home, agentDir } = await createHome({ braveApiKey: `!${command}` });
	const child = runChild(`
		const { searchWithBrave } = await import(${JSON.stringify(braveModuleUrl)});
		let request;
		globalThis.fetch = async (url, init = {}) => {
			request = { url: String(url), headers: Object.fromEntries(new Headers(init.headers)), body: String(init.body ?? "") };
			return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
		};
		await searchWithBrave("query", { numResults: 1 });
		console.log(JSON.stringify({ request }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: agentDir,
		OP_SERVICE_ACCOUNT_TOKEN: "synthetic-service-account-token",
		UNRELATED_SECRET: "must-not-reach-command",
	});

	assert.equal(child.status, 0, child.stderr);
	const { request } = JSON.parse(child.stdout.trim());
	assert.equal(request.headers["x-subscription-token"], "synthetic-brave-key");
	assert.equal(JSON.stringify(request).includes("synthetic-service-account-token"), false);
});

test("provider API errors redact resolved credential-source values", async () => {
	const { home, agentDir } = await createHome({
		braveApiKey: "${BRAVE_SCOPED_KEY}",
		anysearchApiKey: "!printf anysearch-redaction-secret",
		serpapiApiKey: "!printf serpapi-redaction-secret",
		tinyfishApiKey: "!printf tinyfish-redaction-secret",
		tavilyApiKey: "!printf tavily-redaction-secret",
	});
	const child = runChild(`
		const modules = {
			brave: await import(${JSON.stringify(braveModuleUrl)}),
			anysearch: await import(${JSON.stringify(anysearchModuleUrl)}),
			serpapi: await import(${JSON.stringify(serpapiModuleUrl)}),
			tinyfish: await import(${JSON.stringify(tinyfishModuleUrl)}),
			tavily: await import(${JSON.stringify(tavilyModuleUrl)}),
		};
		const attempts = [
			["brave", "brave-redaction-secret", () => modules.brave.searchWithBrave("query")],
			["anysearch", "anysearch-redaction-secret", () => modules.anysearch.searchWithAnySearch("query")],
			["serpapi", "serpapi-redaction-secret", () => modules.serpapi.searchWithSerpApi("query")],
			["tinyfish", "tinyfish-redaction-secret", () => modules.tinyfish.searchWithTinyFish("query")],
			["tavily", "tavily-redaction-secret", () => modules.tavily.searchWithTavily("query")],
		];
		const messages = {};
		for (const [name, secret, run] of attempts) {
			globalThis.fetch = async () => new Response(JSON.stringify({ error: secret }), { status: 400 });
			try {
				await run();
				messages[name] = "NO_ERROR";
			} catch (error) {
				messages[name] = error instanceof Error ? error.message : String(error);
			}
		}
		console.log(JSON.stringify({ messages, secrets: Object.fromEntries(attempts.map(([name, secret]) => [name, secret])) }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: agentDir,
		BRAVE_SCOPED_KEY: "brave-redaction-secret",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	for (const [provider, message] of Object.entries(output.messages)) {
		assert.notEqual(message, "NO_ERROR", provider);
		assert.match(message, /\[redacted\]/, provider);
		assert.equal(message.includes(output.secrets[provider]), false, provider);
	}
});
