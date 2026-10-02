import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const searchUrl = new URL("../search.ts", import.meta.url).href;

function homeWith(config) {
  const home = mkdtempSync(join(tmpdir(), "pi-web-enhanced-allowed-"));
  if (config !== undefined) writeFileSync(join(home, "web-search-enhanced.json"), JSON.stringify(config) + "\n");
  return home;
}

function child(config, script, extraEnv = {}) {
  const home = homeWith(config);
  const env = { ...process.env, PI_CODING_AGENT_DIR: home, XDG_CONFIG_HOME: "", HOME: join(home, "home"), USERPROFILE: join(home, "home"), ...extraEnv };
  return spawnSync(process.execPath, ["--input-type=module"], { input: script, encoding: "utf8", env });
}

const braveResponse = `new Response(JSON.stringify({ web: { results: [{ title: "Brave", url: "https://example.com/brave", description: "answer" }] } }), { status: 200 })`;
const tavilyResponse = `new Response(JSON.stringify({ answer: "Tavily answer", results: [{ title: "Tavily", url: "https://example.com/tavily", content: "answer" }] }), { status: 200 })`;

test("Brave-only policy constrains schema and generated description", () => {
  const result = child({ webSearch: { allowedProviders: ["brave"] } }, `
    const tools = [];
    (await import(${JSON.stringify(indexUrl)})).default({ registerTool(t) { tools.push(t); }, registerCommand() {}, registerShortcut() {}, on() {} });
    const search = tools.find(t => t.name === "web_search");
    const source = tools.find(t => t.name === "source_check");
    console.log(JSON.stringify({ description: search.description, searchProvider: search.parameters.properties.provider, sourceProvider: source.parameters.properties.provider }));
  `);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.match(output.description, /Search the web with Brave\./);
  assert.doesNotMatch(output.description, /Tavily/);
  for (const schema of [output.searchProvider, output.sourceProvider]) {
    assert.deepEqual(schema.anyOf[0].enum, ["auto", "all", "brave"]);
    assert.deepEqual(schema.anyOf[1].items.enum, ["brave"]);
  }
});

test("disabled scalar and array selections fail before provider requests", () => {
  const result = child({ webSearch: { allowedProviders: ["brave"] }, braveApiKey: "b" }, `
    let calls = 0; globalThis.fetch = async () => { calls++; throw new Error("must not fetch"); };
    const { search } = await import(${JSON.stringify(searchUrl)});
    const errors = [];
    for (const provider of ["tavily", ["brave", "tavily"]]) try { await search("q", { provider }); } catch (e) { errors.push(String(e)); }
    console.log(JSON.stringify({ calls, errors }));
  `, { TAVILY_API_KEY: "t" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.calls, 0);
  assert.equal(output.errors.length, 2);
  assert.ok(output.errors.every(error => /disabled provider/.test(error)));
});

test("web_search rejects disabled providers before availability or requests", () => {
  const result = child({ webSearch: { allowedProviders: ["brave"] } }, `
    let calls = 0; globalThis.fetch = async () => { calls++; throw new Error("must not fetch"); };
    const tools = [];
    (await import(${JSON.stringify(indexUrl)})).default({ registerTool(t) { tools.push(t); }, registerCommand() {}, registerShortcut() {}, on() {} });
    const tool = tools.find(t => t.name === "web_search");
    const ctx = { modelRegistry: new Proxy({}, { get() { throw new Error("availability must not run"); } }) };
    let error; try { await tool.execute("call", { query: "q", provider: "tavily" }, undefined, undefined, ctx); } catch (e) { error = String(e); }
    console.log(JSON.stringify({ calls, error }));
  `, { TAVILY_API_KEY: "t" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.calls, 0);
  assert.match(output.error, /disabled provider/);
  assert.doesNotMatch(output.error, /availability must not run/);
});

test("auto and all filter to allowed providers", () => {
  for (const provider of ["auto", "all"]) {
    const result = child({ webSearch: { allowedProviders: ["brave"] }, braveApiKey: "b" }, `
      const calls = []; globalThis.fetch = async url => { calls.push(String(url)); if (String(url).startsWith("https://api.search.brave.com/")) return ${braveResponse}; throw new Error("disabled request " + url); };
      const { search } = await import(${JSON.stringify(searchUrl)});
      const output = await search("q", { provider: ${JSON.stringify(provider)} });
      console.log(JSON.stringify({ provider: output.provider, calls }));
    `, { TAVILY_API_KEY: "t", EXA_API_KEY: "e" });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.calls.length, 1);
    assert.ok(output.calls[0].startsWith("https://api.search.brave.com/"));
    assert.equal(output.provider, provider === "all" ? "all" : "brave");
  }
});

test("allowlisting an explicit-only provider does not opt it into auto or all", () => {
  for (const provider of ["auto", "all"]) {
    const result = child({ webSearch: { allowedProviders: ["serpapi"] }, serpapiApiKey: "s" }, `
      let calls = 0; globalThis.fetch = async () => { calls++; throw new Error("must not fetch"); };
      const { search } = await import(${JSON.stringify(searchUrl)});
      let error; try { await search("q", { provider: ${JSON.stringify(provider)} }); } catch (e) { error = String(e); }
      console.log(JSON.stringify({ calls, error }));
    `);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.calls, 0);
    assert.match(output.error, /No search provider available|No configured search provider available/);
  }
});

test("an allowlisted explicit-only provider remains directly selectable with its credential", () => {
  const result = child({ webSearch: { allowedProviders: ["serpapi"] }, serpapiApiKey: "s" }, `
    const calls = []; globalThis.fetch = async (url) => {
      const parsed = new URL(String(url));
      calls.push({ url: parsed.origin + parsed.pathname, key: parsed.searchParams.get("api_key") });
      return new Response(JSON.stringify({ organic_results: [{ title: "SerpApi", link: "https://example.com/serpapi", snippet: "answer" }] }), { status: 200 });
    };
    const response = await (await import(${JSON.stringify(searchUrl)})).search("q", { provider: "serpapi" });
    console.log(JSON.stringify({ provider: response.provider, calls }));
  `);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.provider, "serpapi");
  assert.equal(output.calls.length, 1);
  assert.equal(output.calls[0].key, "s");
});

test("source_check cannot bypass policy", () => {
  const result = child({ webSearch: { allowedProviders: ["brave"] } }, `
    let calls = 0; globalThis.fetch = async () => { calls++; throw new Error("must not fetch"); };
    const tools = [];
    (await import(${JSON.stringify(indexUrl)})).default({ registerTool(t) { tools.push(t); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
    const tool = tools.find(t => t.name === "source_check");
    const response = await tool.execute("call", { claim: "claim", provider: "tavily" }, undefined, undefined, { modelRegistry: {} });
    console.log(JSON.stringify({ calls, details: response.details }));
  `, { TAVILY_API_KEY: "t" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.calls, 0);
  assert.match(JSON.stringify(output.details), /disabled provider/);
});

test("an absent config file preserves registration and search behavior", () => {
  const result = child(undefined, `
    const tools = []; const commands = [];
    (await import(${JSON.stringify(indexUrl)})).default({ registerTool(t) { tools.push(t); }, registerCommand(name) { commands.push(name); }, registerShortcut() {}, on() {} });
    const providers = tools.find(t => t.name === "web_search").parameters.properties.provider.anyOf[0].enum;
    globalThis.fetch = async () => ${braveResponse};
    const response = await (await import(${JSON.stringify(searchUrl)})).search("q", { provider: "brave" });
    console.log(JSON.stringify({ tools: tools.map(t => t.name), commands, hasSerpApi: providers.includes("serpapi"), hasQuerit: providers.includes("querit"), provider: response.provider }));
  `, { BRAVE_API_KEY: "b" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    tools: ["web_search", "web_search_enhanced", "source_check", "fetch_content", "get_search_content"],
    commands: ["search"],
    hasSerpApi: true,
    hasQuerit: true,
    provider: "brave",
  });
});

test("invalid allowlists fail tool registration clearly", () => {
  for (const [allowedProviders, pattern] of [
    [[], /must be a non-empty array/],
    [["brave", "BRAVE"], /must not contain duplicates: brave/],
    [["not-a-provider"], /contains an invalid provider: not-a-provider/],
    ["brave", /must be a non-empty array/],
  ]) {
    const result = child({ webSearch: { allowedProviders } }, `
      (await import(${JSON.stringify(indexUrl)})).default({ registerTool() {}, registerCommand() {}, registerShortcut() {}, on() {} });
    `);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, pattern);
    assert.match(result.stderr, /webSearch\.allowedProviders/);
  }
});

test("a configured auto default retains automatic allowlist behavior", () => {
  const result = child({ webSearch: { allowedProviders: ["brave"] }, provider: "auto", braveApiKey: "b" }, `
    const calls = []; globalThis.fetch = async url => { calls.push(String(url)); if (String(url).startsWith("https://api.search.brave.com/")) return ${braveResponse}; throw new Error("disabled request " + url); };
    const response = await (await import(${JSON.stringify(searchUrl)})).search("q");
    console.log(JSON.stringify({ provider: response.provider, calls }));
  `, { TAVILY_API_KEY: "t" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.provider, "brave");
  assert.equal(output.calls.length, 1);
  assert.ok(output.calls[0].startsWith("https://api.search.brave.com/"));
});

test("source_check follows an allowed routing fallback", () => {
  const result = child({
    webSearch: { allowedProviders: ["brave", "tavily"] },
    searchRouting: { providers: ["brave", "tavily"], fallbackOn: ["network"] },
    tavilyApiKey: "t",
  }, `
    const calls = []; globalThis.fetch = async url => {
      calls.push(String(url));
      if (String(url).startsWith("https://api.search.brave.com/")) throw new TypeError("fetch failed");
      if (String(url) === "https://api.tavily.com/search") return ${tavilyResponse};
      throw new Error("disabled request " + url);
    };
    const tools = []; (await import(${JSON.stringify(indexUrl)})).default({ registerTool(t) { tools.push(t); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
    const response = await tools.find(t => t.name === "source_check").execute("call", { claim: "q" }, undefined, undefined, { modelRegistry: {} });
    console.log(JSON.stringify({ provider: response.details.artifact.provider, calls, errors: response.details.artifact.errors || [] }));
  `, { BRAVE_API_KEY: "b" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.provider, "tavily");
  assert.equal(output.errors.length, 0);
  assert.equal(output.calls.length, 2);
  assert.ok(output.calls[0].startsWith("https://api.search.brave.com/"));
  assert.equal(output.calls[1], "https://api.tavily.com/search");
});

test("configured defaults and routing cannot reference disabled providers", () => {
  for (const config of [
    { webSearch: { allowedProviders: ["brave"] }, provider: "tavily" },
    { webSearch: { allowedProviders: ["brave"] }, searchRouting: { providers: ["tavily"], fallbackOn: ["network"] } },
  ]) {
    const result = child(config, `
      let calls = 0; globalThis.fetch = async () => { calls++; throw new Error("must not fetch"); };
      try { await (await import(${JSON.stringify(searchUrl)})).search("q"); } catch (e) { console.log(JSON.stringify({ calls, error: String(e) })); }
    `);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.calls, 0);
    assert.match(output.error, /disabled provider/);
  }
});

test("both configured provider aliases are validated while searchProvider keeps precedence", () => {
  const rejected = child({ webSearch: { allowedProviders: ["brave"] }, searchProvider: "brave", provider: "tavily" }, `
    let calls = 0; globalThis.fetch = async () => { calls++; throw new Error("must not fetch"); };
    try { await (await import(${JSON.stringify(searchUrl)})).search("q"); } catch (e) { console.log(JSON.stringify({ calls, error: String(e) })); }
  `, { TAVILY_API_KEY: "t", BRAVE_API_KEY: "b" });
  assert.equal(rejected.status, 0, rejected.stderr);
  assert.equal(JSON.parse(rejected.stdout).calls, 0);
  assert.match(JSON.parse(rejected.stdout).error, /provider in .* references disabled provider "tavily"/);

  const accepted = child({ webSearch: { allowedProviders: ["brave", "tavily"] }, searchProvider: "brave", provider: "tavily", braveApiKey: "b" }, `
    const calls = []; globalThis.fetch = async url => { calls.push(String(url)); return ${braveResponse}; };
    const response = await (await import(${JSON.stringify(searchUrl)})).search("q");
    console.log(JSON.stringify({ provider: response.provider, calls }));
  `, { TAVILY_API_KEY: "t" });
  assert.equal(accepted.status, 0, accepted.stderr);
  const output = JSON.parse(accepted.stdout);
  assert.equal(output.provider, "brave");
  assert.equal(output.calls.length, 1);
  assert.ok(output.calls[0].startsWith("https://api.search.brave.com/"));
});
