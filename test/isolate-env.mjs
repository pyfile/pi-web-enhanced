// Loaded by `npm test` before the runner spawns test files.
//
// 1. Tests write and prune the fetched-content cache, so a cache root exported
//    in the shell must never reach them.
// 2. Tests that run in-process must never read the developer's real
//    `~/.pi/agent/web-search-enhanced.json`; a stray provider there would change what the
//    shared config path resolves to. Pin a private, empty config dir instead.
//    (Tests that need a specific config spawn a child with their own
//    PI_CODING_AGENT_DIR.)
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

delete process.env.PI_WEB_ACCESS_CACHE_ROOT;
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-web-enhanced-test-config-"));
