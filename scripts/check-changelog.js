#!/usr/bin/env node
// Guards the release against a changelog Pi would replay at startup.
//
// Pi reads the published CHANGELOG.md of every installed package and prints the
// entries whose version is numerically newer than the last version it recorded
// for that package (that is the package version it saw installed). It then
// records the installed version, so an entry that outranks package.json either
// spams every launch or is silently unreachable. Keep this file monotonic and
// keep upstream history out of it (see CHANGELOG-upstream.md).
import { readFileSync } from "node:fs";

const HEADING_RE = /^##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/;

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = pkg.version;

const entries = [];
for (const [index, line] of readFileSync("CHANGELOG.md", "utf8").split("\n").entries()) {
	const match = line.match(HEADING_RE);
	if (match) entries.push({ line: index + 1, version: `${match[1]}.${match[2]}.${match[3]}` });
}

function fail(message) {
	console.error(`changelog check failed: ${message}`);
	process.exit(1);
}

function compare(a, b) {
	const left = a.split(".").map(Number);
	const right = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if (left[i] !== right[i]) return left[i] - right[i];
	}
	return 0;
}

if (entries.length === 0) {
	fail("CHANGELOG.md has no '## [x.y.z]' entries");
}

for (const entry of entries) {
	if (compare(entry.version, version) > 0) {
		fail(
			`CHANGELOG.md:${entry.line} is ${entry.version}, newer than package.json ${version}. ` +
				"Move upstream entries to CHANGELOG-upstream.md instead of bumping past them.",
		);
	}
}

if (compare(entries[0].version, version) !== 0) {
	fail(
		`CHANGELOG.md:${entries[0].line} is ${entries[0].version} but package.json is ${version}. ` +
			"The newest entry must describe the version being released.",
	);
}

for (let i = 1; i < entries.length; i++) {
	if (compare(entries[i].version, entries[i - 1].version) >= 0) {
		fail(
			`CHANGELOG.md:${entries[i].line} is ${entries[i].version}, not older than ` +
				`${entries[i - 1].version} on line ${entries[i - 1].line}`,
		);
	}
}

console.log(`changelog OK: ${entries.length} entries, newest ${entries[0].version}`);
