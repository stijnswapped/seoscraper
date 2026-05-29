import type { ExtractedField } from "../types/productCheck.js";

/**
 * Confidence constants per extraction source, ordered by how authoritative the
 * source is. Structured data and explicit metadata rank highest; DOM heuristics
 * rank lowest because they guess.
 */
export const CONFIDENCE = {
  jsonLd: 0.95,
  titleTag: 0.95,
  metaDescription: 0.9,
  canonicalLink: 0.95,
  ogTag: 0.85,
  twitterTag: 0.8,
  /** Generic semantic DOM element (h1, main, article). */
  domSemantic: 0.6,
  /** Label-based heuristic (matched "omschrijving" etc. near text). */
  domLabelHeuristic: 0.5,
  /** Last-resort guess. */
  domFallback: 0.35,
  /** Nothing found. */
  none: 0,
} as const;

export function field<T>(
  value: T,
  source: string,
  confidence: number,
  warnings: string[] = [],
): ExtractedField<T> {
  return { value, source, confidence, warnings };
}

export function emptyField<T extends null>(
  warning: string,
): ExtractedField<T> {
  return {
    value: null as T,
    source: "none",
    confidence: CONFIDENCE.none,
    warnings: [warning],
  };
}
