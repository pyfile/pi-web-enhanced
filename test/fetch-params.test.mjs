import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeFetchContentParams } from "../fetch-params.ts";

test("fetch_content params fall back to url when urls is an empty array", () => {
	const normalized = normalizeFetchContentParams({
		url: "https://example.com/docs",
		urls: [],
	});

	assert.deepEqual(normalized.urlList, ["https://example.com/docs"]);
});

test("fetch_content params keep non-empty urls precedence over url", () => {
	const normalized = normalizeFetchContentParams({
		url: "https://example.com/fallback",
		urls: ["https://example.com/primary"],
	});

	assert.deepEqual(normalized.urlList, ["https://example.com/primary"]);
});

test("fetch_content params ignore blank optional strings and blank urls", () => {
	const normalized = normalizeFetchContentParams({
		url: "  https://example.com/one  ",
		urls: ["", " https://example.com/two ", "https://example.com/one"],
		prompt: "",
	});

	assert.deepEqual(normalized.urlList, ["https://example.com/two", "https://example.com/one"]);
	assert.equal(normalized.options.prompt, undefined);
	assert.equal(normalizeFetchContentParams({ prompt: "  " }).options.prompt, undefined);
});

test("fetch_content params preserve forceClone only for boolean values", () => {
	assert.equal(normalizeFetchContentParams({ forceClone: true }).options.forceClone, true);
	assert.equal(normalizeFetchContentParams({ forceClone: false }).options.forceClone, false);
	assert.equal(normalizeFetchContentParams({ forceClone: "true" }).options.forceClone, undefined);
});

test("fetch_content params preserve forceClone only for boolean values", () => {
	assert.equal(normalizeFetchContentParams({ forceClone: true }).options.forceClone, true);
	assert.equal(normalizeFetchContentParams({ forceClone: false }).options.forceClone, false);
	assert.equal(normalizeFetchContentParams({ forceClone: "true" }).options.forceClone, undefined);
});

test("fetch_content params validate fetch and answer modes", () => {
	assert.deepEqual(
		normalizeFetchContentParams({ mode: "answer", answerModel: " test/page-model " }).options,
		{ mode: "answer", answerModel: "test/page-model" },
	);
	assert.throws(() => normalizeFetchContentParams({ mode: "invalid" }), /mode must be/);
});

test("fetch_content params validate auth profile input", () => {
	assert.equal(normalizeFetchContentParams({ auth: true }).options.auth, true);
	assert.equal(normalizeFetchContentParams({ auth: " work " }).options.auth, "work");
	assert.equal(normalizeFetchContentParams({ auth: false }).options.auth, undefined);
	assert.throws(() => normalizeFetchContentParams({ auth: " " }), /auth must be/);
	assert.throws(() => normalizeFetchContentParams({ auth: 1 }), /auth must be/);
});
