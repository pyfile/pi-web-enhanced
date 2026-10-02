// Weighted provider selection for `web_search` balanced mode.
//
// Config form in web-search-enhanced.json:
//   "provider": [["exa", 60], ["brave", 30], ["tavily", 10]]
//
// Each entry is `[providerName, weight]` where the weight is a positive integer
// (typically a provider's request budget over a common window). A provider is
// picked with probability wᵢ / Σ wⱼ. Providers without usable credentials are
// dropped before sampling, so the remaining entries keep the intended relative
// weights.
import type { ResolvedSearchProvider } from "./search.ts";

export interface ProviderWeight {
	provider: ResolvedSearchProvider;
	weight: number;
}

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
		if (typeof rawWeight !== "number" || !Number.isSafeInteger(rawWeight) || rawWeight <= 0) {
			throw new Error(`${label} weight for "${provider}" must be a positive integer`);
		}
		if (seen.has(provider as ResolvedSearchProvider)) {
			throw new Error(`${label} must not contain duplicates: ${provider}`);
		}
		seen.add(provider as ResolvedSearchProvider);
		weights.push({ provider: provider as ResolvedSearchProvider, weight: rawWeight });
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

	const total = candidates.reduce((sum, entry) => sum + entry.weight, 0);
	let threshold = random() * total;
	for (const entry of candidates) {
		threshold -= entry.weight;
		if (threshold < 0) return entry.provider;
	}
	return candidates[candidates.length - 1].provider;
}
