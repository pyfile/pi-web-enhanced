import assert from "node:assert/strict";
import { test } from "node:test";

import {
	parseProviderWeights,
	providerWeightNames,
	sampleWeightedProvider,
} from "../search-provider-weights.ts";

const ALLOWED = ["exa", "tavily", "anysearch", "tinyfish", "serpapi", "firecrawl", "brave", "duckduckgo", "querit"];

// Deterministic LCG so a fixed seed always yields the same draw.
function seededRandom(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

test("parseProviderWeights returns null for the plain string and string-array forms", () => {
	assert.equal(parseProviderWeights("exa", ALLOWED), null);
	assert.equal(parseProviderWeights(["exa", "brave"], ALLOWED), null);
	assert.equal(parseProviderWeights(undefined, ALLOWED), null);
	assert.equal(parseProviderWeights({ exa: 3 }, ALLOWED), null);
});

test("parseProviderWeights normalizes names and preserves positive integer weights", () => {
	assert.deepEqual(parseProviderWeights([["Exa", 3], [" brave ", 2]], ALLOWED), [
		{ provider: "exa", weight: 3 },
		{ provider: "brave", weight: 2 },
	]);
	assert.deepEqual(providerWeightNames(parseProviderWeights([["exa", 1], ["tavily", 1]], ALLOWED)), ["exa", "tavily"]);
	assert.deepEqual(parseProviderWeights([["querit", 2]], ALLOWED), [{ provider: "querit", weight: 2 }]);
});

test("parseProviderWeights preserves large positive weights without clamping", () => {
	assert.deepEqual(parseProviderWeights([["exa", 100000]], ALLOWED), [{ provider: "exa", weight: 100000 }]);
});

test("parseProviderWeights rejects malformed entries", () => {
	const label = "provider in /tmp/web-search-enhanced.json";
	assert.throws(() => parseProviderWeights([["nope", 1]], ALLOWED, label), /invalid provider: nope/);
	assert.throws(() => parseProviderWeights([["exa", 1.5]], ALLOWED, label), /weight for "exa" must be a positive integer/);
	assert.throws(() => parseProviderWeights([["exa", "3"]], ALLOWED, label), /weight for "exa" must be a positive integer/);
	assert.throws(() => parseProviderWeights([["exa", 0]], ALLOWED, label), /weight for "exa" must be a positive integer/);
	assert.throws(() => parseProviderWeights([["exa", -2]], ALLOWED, label), /weight for "exa" must be a positive integer/);
	assert.throws(() => parseProviderWeights([["exa", 3], ["exa", 1]], ALLOWED, label), /must not contain duplicates: exa/);
	assert.throws(() => parseProviderWeights([[3, 1]], ALLOWED, label), /provider names must be strings/);
	assert.throws(() => parseProviderWeights([["exa", 1, 2]], ALLOWED, label), /\[providerName, weight\] pairs/);
});

test("sampleWeightedProvider follows linear weight probabilities", async () => {
	const weights = parseProviderWeights([["exa", 1], ["brave", 2], ["tavily", 3]], ALLOWED);
	const total = 1 + 2 + 3;
	const expected = {
		exa: 1 / total,
		brave: 2 / total,
		tavily: 3 / total,
	};

	const random = seededRandom(20261002);
	const counts = { exa: 0, brave: 0, tavily: 0 };
	const draws = 20000;
	for (let index = 0; index < draws; index++) {
		counts[await sampleWeightedProvider(weights, () => true, random)]++;
	}
	for (const provider of ["exa", "brave", "tavily"]) {
		assert.ok(
			Math.abs(counts[provider] / draws - expected[provider]) < 0.02,
			`${provider}: observed ${counts[provider] / draws}, expected ${expected[provider]}`,
		);
	}
});

test("sampleWeightedProvider renormalizes over available providers only", async () => {
	const weights = parseProviderWeights([["exa", 5], ["brave", 1]], ALLOWED);
	// exa has no credentials: every draw must land on brave, never on exa.
	const isAvailable = (provider) => provider === "brave";
	for (let index = 0; index < 50; index++) {
		assert.equal(await sampleWeightedProvider(weights, isAvailable, seededRandom(index + 1)), "brave");
	}
});

test("sampleWeightedProvider returns null when nothing in the list is usable", async () => {
	assert.equal(await sampleWeightedProvider(parseProviderWeights([["exa", 1]], ALLOWED), () => false), null);
});

test("sampleWeightedProvider is deterministic for a fixed RNG", async () => {
	const weights = parseProviderWeights([["exa", 2], ["brave", 1], ["tavily", 3]], ALLOWED);
	const first = [];
	const second = [];
	for (let index = 0; index < 20; index++) first.push(await sampleWeightedProvider(weights, () => true, seededRandom(index + 7)));
	for (let index = 0; index < 20; index++) second.push(await sampleWeightedProvider(weights, () => true, seededRandom(index + 7)));
	assert.deepEqual(first, second);
});

test("a single usable provider is always returned without consuming randomness", async () => {
	const weights = parseProviderWeights([["exa", 1]], ALLOWED);
	let calls = 0;
	const random = () => { calls++; return 0.5; };
	assert.equal(await sampleWeightedProvider(weights, () => true, random), "exa");
	assert.equal(calls, 0);
});
