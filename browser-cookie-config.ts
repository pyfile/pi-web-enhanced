import { existsSync, readFileSync } from "node:fs";
import { getWebSearchConfigPath } from "./utils.ts";

const CONFIG_PATH = getWebSearchConfigPath();

const BROWSER_COOKIE_PRESETS = ["helium", "chrome", "brave", "arc", "chromium", "edge"] as const;
export type BrowserCookiePreset = typeof BROWSER_COOKIE_PRESETS[number];

export function isBrowserCookieAccessAllowed(): boolean {
	if (process.env.PI_ALLOW_BROWSER_COOKIES === "1" || process.env.FEYNMAN_ALLOW_BROWSER_COOKIES === "1") {
		return true;
	}
	if (!existsSync(CONFIG_PATH)) return false;

	const rawText = readFileSync(CONFIG_PATH, "utf-8");
	let raw: { allowBrowserCookies?: unknown };
	try {
		raw = JSON.parse(rawText) as { allowBrowserCookies?: unknown };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
	return raw.allowBrowserCookies === true;
}
