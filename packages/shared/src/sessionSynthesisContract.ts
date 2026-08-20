import { resolveMetricReferences } from "./claudeConfigContract";
import { quoteExistsInText } from "./documentContract";
import type { NormalizedTableShape } from "./schemas/normalizedDataset";
import type { DocumentSectionShape } from "./schemas/normalizedDocument";
import type {
  ResolvedSessionFindingShape,
  SessionFindingShape,
} from "./schemas/sessionSynthesis";

/**
 * Session synthesis's verification step. Reuses the exact same two
 * primitives every other pathway in this app already trusts for this job --
 * resolveMetricReferences (Section 9.1) and quoteExistsInText (Section
 * 10.2) -- rather than inventing a third way to check a model's claim.
 *
 * A finding is valid only if BOTH its metric resolves against the named
 * dataset's real tables AND its citation is a real, verbatim quote from the
 * named document's real fullText, with a real sectionId. Either side
 * failing invalidates the whole finding; there is no partial credit.
 */

export type SessionDatasetSource = {
  name: string;
  tables: NormalizedTableShape[];
};

export type SessionDocumentSource = {
  name: string;
  fullText: string;
  sections: DocumentSectionShape[];
};

export const resolveSessionFindings = (
  findings: SessionFindingShape[],
  datasets: Map<string, SessionDatasetSource>,
  documents: Map<string, SessionDocumentSource>,
): { resolved: ResolvedSessionFindingShape[]; errors: string[] } => {
  const resolved: ResolvedSessionFindingShape[] = [];
  const errors: string[] = [];

  findings.forEach((finding, index) => {
    const dataset = datasets.get(finding.datasetId);
    const document = documents.get(finding.documentId);
    const label = finding.finding.slice(0, 60);

    if (!dataset) {
      errors.push(
        `finding #${index} ("${label}") references datasetId "${finding.datasetId}", which is not one of this session's datasets.`,
      );
      return;
    }

    if (!document) {
      errors.push(
        `finding #${index} ("${label}") references documentId "${finding.documentId}", which is not one of this session's documents.`,
      );
      return;
    }

    const { resolved: resolvedMetrics, errors: metricErrors } = resolveMetricReferences(
      [finding.metric],
      dataset.tables,
    );

    if (metricErrors.length > 0) {
      errors.push(`finding #${index} ("${label}") metric: ${metricErrors.join("; ")}`);
      return;
    }

    const knownSectionIds = new Set(document.sections.map((section) => section.sectionId));

    if (!quoteExistsInText(finding.citation.quote, document.fullText)) {
      errors.push(
        `finding #${index} ("${label}") citation quote is not a verbatim substring of document "${document.name}"'s fullText: "${finding.citation.quote}"`,
      );
      return;
    }

    if (!knownSectionIds.has(finding.citation.sectionId)) {
      errors.push(
        `finding #${index} ("${label}") citation references unknown section "${finding.citation.sectionId}" in document "${document.name}".`,
      );
      return;
    }

    resolved.push({
      finding: finding.finding,
      whyItMatters: finding.whyItMatters,
      datasetId: finding.datasetId,
      datasetName: dataset.name,
      metric: resolvedMetrics[0]!,
      documentId: finding.documentId,
      documentName: document.name,
      citation: finding.citation,
    });
  });

  return { resolved, errors };
};
