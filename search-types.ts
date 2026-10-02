// Canonical search types shared by every search provider.
//
// These previously lived in `perplexity.ts`, which was the first provider
// module and became the de facto home for the shared contract. With the
// provider list trimmed, they get a module of their own so provider modules
// can be added and removed without moving the shared types.
import type { ExtractedContent } from "./extract.ts";

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchResponse {
	answer: string;
	results: SearchResult[];
	inlineContent?: ExtractedContent[];
}

export interface SearchOptions {
	numResults?: number;
	recencyFilter?: "day" | "week" | "month" | "year";
	domainFilter?: string[];
	signal?: AbortSignal;
}
