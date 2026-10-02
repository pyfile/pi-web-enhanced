// Weighted provider selection for `web_search` balanced mode.
//
// Config form in web-search.json:
//   "provider": [["exa", 3], ["brave", 2], ["tavily", 1]]
//
// Each entry is `[providerName, integerWeight]`. A provider is picked with
// probability exp(wᵢ) / Σ exp(wⱼ), computed with the maximum weight factored
// out so large weights cannot overflow `Math.exp`. Providers without usable
// credentials are dropped before sampling, so the remaining entries keep the
// intended relative weights.
import type { ResolvedSearchProvider } from "./gemini-search.ts";

export interface ProviderWeight {
	provider: ResolvedSearchProvider;
	weight: number;
}

// exp(±50) is ~5e21, comfortably inside double range even after summing.
const MAX_WEIGHT_MAGNITUDE = 50;

export function providerWeightNames(weights: readonly ProviderWeight[]): ResolvedSearchProvider[] {
	return weights.map((entry) => entry.provider);
}

/**
 * Returns the parsed weight table when `value` is the `[name, weight]` tuple
 * form, or `null` when it is anything else (so callers can fall through to the
 * plain string / string-array provider selection). Throws on a malformed tuple.
 */
export function parseProviderWeights(
	value: unknown,
	allowedProviders: readonly ResolvedSearchProvider[],
	label = "provider",
): ProviderWeight[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	if (!value.every((entry) => Array.isArray(entry))) return null;

	const weights: ProviderWeight[] = [];
	const seen = new Set<ResolvedSearchProvider>();
	for (const entry of value) {
		const pair = entry as unknown[];
		if (pair.length !== 2) {
			throw new Error(`${label} entries must be [providerName, weight] pairs`);
		}
		const [rawName, rawWeight] = pair;
		if (typeof rawName !== "string") {
			throw new Error(`${label} provider names must be strings`);
		}
		const provider = rawName.trim().toLowerCase();
		if (!allowedProviders.includes(provider as ResolvedSearchProvider)) {
			throw new Error(`${label} contains an invalid provider: ${rawName}`);
		}
		if (typeof rawWeight !== "number" || !Number.isSafeInteger(rawWeight)) {
			throw new Error(`${label} weight for "${provider}" must be an integer`);
		}
		if (seen.has(provider as ResolvedSearchProvider)) {
			throw new Error(`${label} must not contain duplicates: ${provider}`);
		}
		seen.add(provider as ResolvedSearchProvider);
		const magnitude = Math.min(Math.abs(rawWeight), MAX_WEIGHT_MAGNITUDE);
		weights.push({
			provider: provider as ResolvedSearchProvider,
			weight: rawWeight < 0 ? -magnitude : magnitude,
		});
	}
	return weights;
}

/**
 * Picks one provider from `weights`, restricted to the entries for which
 * `isAvailable` returns true. Returns `null` when none is available.
 */
export async function sampleWeightedProvider(
	weights: readonly ProviderWeight[],
	isAvailable: (provider: ResolvedSearchProvider) => boolean | Promise<boolean>,
	random: () => number = Math.random,
): Promise<ResolvedSearchProvider | null> {
	const candidates: ProviderWeight[] = [];
	for (const entry of weights) {
		if (await isAvailable(entry.provider)) candidates.push(entry);
	}
	if (candidates.length === 0) return null;
	if (candidates.length === 1) return candidates[0].provider;

	const maxWeight = Math.max(...candidates.map((entry) => entry.weight));
	const exponentials = candidates.map((entry) => Math.exp(entry.weight - maxWeight));
	const total = exponentials.reduce((sum, value) => sum + value, 0);

	let threshold = random() * total;
	for (let index = 0; index < candidates.length; index++) {
		threshold -= exponentials[index];
		if (threshold <= 0) return candidates[index].provider;
	}
	return candidates[candidates.length - 1].provider;
}
