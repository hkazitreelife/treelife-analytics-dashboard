import { resolveMetricReferences } from "./claudeConfigContract";
import { quoteExistsInText } from "./documentContract";
import type {
  ResolvedSessionChatAnswerShape,
  SessionChatAnswerShape,
} from "./schemas/sessionChat";
import type { SessionDatasetSource, SessionDocumentSource } from "./sessionSynthesisContract";

/**
 * Prompt 15.0 Part 2. Verifies a multi-source session chat answer the same
 * way sessionSynthesisContract.ts verifies a finding -- reusing
 * resolveMetricReferences and quoteExistsInText, never a third method --
 * except metrics and citations are independent here, not required to pair.
 */
export const resolveSessionChatAnswer = (
  answer: SessionChatAnswerShape,
  datasets: Map<string, SessionDatasetSource>,
  documents: Map<string, SessionDocumentSource>,
): { resolved: ResolvedSessionChatAnswerShape | null; errors: string[] } => {
  const errors: string[] = [];
  const resolvedMetrics: ResolvedSessionChatAnswerShape["metrics"] = [];

  answer.metrics.forEach((entry, index) => {
    const dataset = datasets.get(entry.datasetId);

    if (!dataset) {
      errors.push(`metric #${index} references unknown datasetId "${entry.datasetId}".`);
      return;
    }

    const { resolved, errors: metricErrors } = resolveMetricReferences(
      [entry.metric],
      dataset.tables,
    );

    if (metricErrors.length > 0) {
      errors.push(`metric #${index}: ${metricErrors.join("; ")}`);
      return;
    }

    resolvedMetrics.push({
      datasetId: entry.datasetId,
      datasetName: dataset.name,
      metric: resolved[0]!,
    });
  });

  const resolvedCitations: ResolvedSessionChatAnswerShape["citations"] = [];

  answer.citations.forEach((entry, index) => {
    const document = documents.get(entry.documentId);

    if (!document) {
      errors.push(`citation #${index} references unknown documentId "${entry.documentId}".`);
      return;
    }

    const knownSectionIds = new Set(document.sections.map((section) => section.sectionId));

    if (!quoteExistsInText(entry.citation.quote, document.fullText)) {
      errors.push(
        `citation #${index} quote is not a verbatim substring of document "${document.name}"'s fullText: "${entry.citation.quote}"`,
      );
      return;
    }

    if (!knownSectionIds.has(entry.citation.sectionId)) {
      errors.push(
        `citation #${index} references unknown section "${entry.citation.sectionId}" in document "${document.name}".`,
      );
      return;
    }

    resolvedCitations.push({ ...entry, documentName: document.name });
  });

  if (errors.length > 0) {
    return { resolved: null, errors };
  }

  return {
    resolved: {
      directAnswer: answer.directAnswer,
      metrics: resolvedMetrics,
      citations: resolvedCitations,
      caveats: answer.caveats,
    },
    errors: [],
  };
};
