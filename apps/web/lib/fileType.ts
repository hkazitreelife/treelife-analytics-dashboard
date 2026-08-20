/**
 * Prompt 12.0. The sidebar/Context card type badge (xlsx/csv/pdf/pptx/docx).
 * Read from the related Files upload's own filename extension, not from
 * dataset.data or document.data -- inspecting a real stored dataset showed
 * `data` there only ever has `tables`/`relationships`, sourceFile is not
 * persisted onto Datasets.data, so reading `data.sourceFile.type` silently
 * returned null for every dataset. Files.filename is a reserved Payload
 * upload field, always present, and this is generic (extension parsing),
 * never a hardcoded dataset name or extension list.
 */
export const fileTypeFromFilename = (filename: string | null | undefined): string | null => {
  if (!filename) {
    return null;
  }

  const lastDot = filename.lastIndexOf(".");

  if (lastDot < 0 || lastDot === filename.length - 1) {
    return null;
  }

  return filename.slice(lastDot + 1).toLowerCase();
};
