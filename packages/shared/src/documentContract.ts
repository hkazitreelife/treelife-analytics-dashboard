import type { KeyPointShape } from "./schemas/documentSummary";
import type { DocumentSectionShape } from "./schemas/normalizedDocument";

/**
 * Section 10.0. Shared between the worker (initial summary generation,
 * worker/src/services/claudeDocumentSummary.ts) and the web process
 * (Step 4's expand endpoint, apps/web/lib/claudeDocumentExpandClient.ts) --
 * the same anti-fabrication discipline claudeConfigContract.ts already
 * applies to insight metrics, applied here to a keyPoint's quote and section
 * references.
 */

/**
 * Whitespace-collapsing, case-insensitive normalization so a quote spanning
 * a line break or using different spacing than the source PDF's text layer
 * still matches, without loosening the check to "roughly similar" -- it
 * must still be the same sequence of words, verbatim.
 */
const normalizeForQuoteMatch = (text: string): string =>
  text.toLowerCase().replace(/\s+/g, " ").trim();

/** Whether `quote` is a real, verbatim (case/whitespace-tolerant) substring of `fullText`. */
export const quoteExistsInText = (quote: string, fullText: string): boolean =>
  normalizeForQuoteMatch(fullText).includes(normalizeForQuoteMatch(quote));

/**
 * Validation-only: every keyPoint whose quote is not a real substring of
 * fullText, or whose supportingSectionIds names a section that doesn't
 * exist. Empty means every keyPoint checks out. A failure here earns the
 * same retry-once discipline as a schema violation, never a silent drop of
 * the offending keyPoint.
 */
export const findUnverifiableKeyPoints = (
  keyPoints: KeyPointShape[],
  fullText: string,
  sections: DocumentSectionShape[],
): string[] => {
  const knownSectionIds = new Set(sections.map((section) => section.sectionId));
  const problems: string[] = [];

  for (const point of keyPoints) {
    if (!quoteExistsInText(point.quote, fullText)) {
      problems.push(
        `keyPoint "${point.pointId}": quote is not a verbatim substring of fullText: "${point.quote}"`,
      );
    }

    for (const sectionId of point.supportingSectionIds) {
      if (!knownSectionIds.has(sectionId)) {
        problems.push(
          `keyPoint "${point.pointId}" references unknown section "${sectionId}"`,
        );
      }
    }
  }

  return problems;
};

/**
 * Section 10.0 Step 4. A follow-up request must not repeat a point already
 * surfaced -- checked by pointId, since the model is given the existing
 * list specifically so it doesn't repeat itself, but is not trusted to have
 * actually avoided it.
 */
export const findDuplicateKeyPointIds = (
  existingKeyPoints: KeyPointShape[],
  newKeyPoints: KeyPointShape[],
): string[] => {
  const existingIds = new Set(existingKeyPoints.map((point) => point.pointId));

  return newKeyPoints
    .filter((point) => existingIds.has(point.pointId))
    .map((point) => `keyPoint "${point.pointId}" duplicates an id already in the stored summary`);
};
