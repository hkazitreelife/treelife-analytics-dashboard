/**
 * Section 10.0. Which MIME types are candidates for the narrative-document
 * pipeline (worker/src/processors/documentIngestion.ts) rather than the
 * Section 14 table pipeline (spreadsheetParser.ts's resolveDeterministicType,
 * xlsx/csv only, untouched by this file). Checked before
 * resolveDeterministicType ever runs, so a PDF/PPTX/DOCX never reaches it.
 */

const DOCUMENT_CANDIDATE_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // pptx
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // docx
]);

export const isDocumentCandidateMimeType = (mimeType: string): boolean =>
  DOCUMENT_CANDIDATE_MIME_TYPES.has(mimeType.toLowerCase());

/** Maps a document-candidate MIME type to the SupportedFileType literal stored on sourceFile.type. */
export const resolveDocumentSourceType = (
  mimeType: string,
): "pdf" | "pptx" | "docx" => {
  const normalized = mimeType.toLowerCase();

  if (normalized === "application/pdf") {
    return "pdf";
  }

  if (
    normalized ===
    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ) {
    return "pptx";
  }

  return "docx";
};
