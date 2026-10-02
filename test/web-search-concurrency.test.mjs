import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;

test("web_search bounds batch concurrency and preserves query order", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-enhanced-concurrency-"));
	await writeFile(join(home, "web-search-enhanced.json"), JSON.stringify({
		serpapiApiKey: "serpapi-test-key",
	}) + "\n", "utf8");
	const childEnv = { ...process.env, PI_CODING_AGENT_DIR: home };
	for (const key of [
		"OPENAI_API_KEY", "BRAVE_API_KEY", "PARALLEL_API_KEY", "TINYFISH_API_KEY",
		"TAVILY_API_KEY", "JINA_API_KEY", "EXA_API_KEY", "PERPLEXITY_API_KEY", "GEMINI_API_KEY",
	]) {
		delete childEnv[key];
	}

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			let active = 0;
			let maxActive = 0;
			let started = [];
			let completed = [];
			const delays = new Map([["q1", 90], ["q2", 70], ["q3", 50], ["q4", 30], ["q5", 10]]);
			globalThis.fetch = async (url) => {
				const query = new URL(String(url)).searchParams.get("q");
				started.push(query);
				active++;
				maxActive = Math.max(maxActive, active);
				await new Promise(resolve => setTimeout(resolve, delays.get(query)));
				active--;
				completed.push(query);
				return new Response(JSON.stringify({
					organic_results: [{ position: 1, title: query, link: "https://example.com/" + query, snippet: query }],
				}), { status: 200 });
			};
			const tools = [];
			const { default: initializeExtension } = await import(${JSON.stringify(indexUrl)});
			initializeExtension({
				registerTool(tool) { tools.push(tool); },
				registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {}, sendMessage() {},
			});
			const webSearch = tools.find(tool => tool.name === "web_search");
			const updates = [];
			const rawResult = await webSearch.execute(
				"concurrency-test",
				{ queries: ["q1", "q2", "q3", "q4", "q5"], provider: "serpapi" },
				undefined,
				update => updates.push(update.details),
			);
			const raw = { maxActive, started, completed, updates, text: rawResult.content[0].text };
			const queriesDescription = webSearch.parameters.properties.queries.description;
			console.log(JSON.stringify({ raw, queriesDescription }));
		`,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});

	assert.equal(child.status, 0, child.stderr);
	const { raw, queriesDescription } = JSON.parse(child.stdout.trim());
	assert.equal(raw.maxActive, 3);
	assert.deepEqual(raw.started, ["q1", "q2", "q3", "q4", "q5"]);
	assert.notDeepEqual(raw.completed, raw.started);
	let previous = -1;
	for (const query of raw.started) {
		const position = raw.text.indexOf(`## Query: "${query}"`);
		assert.ok(position > previous, `${query} was returned out of order`);
		previous = position;
	}
	assert.equal(raw.updates.at(-1).progress, 1);
	assert.match(queriesDescription, /concurrently \(up to three at a time\)/);
});
