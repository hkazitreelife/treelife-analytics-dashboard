/**
 * Prompt 12.0. One small badge, reused by every sidebar entry and Context
 * card: a status word gets a colour from the same risk palette the rest of
 * the app already uses (InsightsPanel, WidgetRenderer), never a new one.
 * "ready" reads as low risk, "processing"/"updating" as medium (in
 * progress, not wrong), "failed" as high.
 *
 * Impeccable critique 2026-08-13, P2 contrast finding: the dot (decorative,
 * aria-hidden) keeps the original risk hue; the label -- the only part a
 * screen reader or a low-vision user actually reads -- uses the darkened
 * -text token variants (see globals.css) so it clears WCAG AA's 4.5:1 on
 * white. risk-high needs no variant; it already passes at 5.44:1.
 */

const STATUS_DOT_COLOR: Record<string, string> = {
  ready: "var(--color-risk-low)",
  completed: "var(--color-risk-low)",
  processing: "var(--color-risk-med)",
  updating: "var(--color-risk-med)",
  queued: "var(--color-risk-med)",
  validating: "var(--color-risk-med)",
  generating_config: "var(--color-risk-med)",
  synthesizing: "var(--color-risk-med)",
  failed: "var(--color-risk-high)",
};

const STATUS_TEXT_COLOR: Record<string, string> = {
  ready: "var(--color-risk-low-text)",
  completed: "var(--color-risk-low-text)",
  processing: "var(--color-risk-med-text)",
  updating: "var(--color-risk-med-text)",
  queued: "var(--color-risk-med-text)",
  validating: "var(--color-risk-med-text)",
  generating_config: "var(--color-risk-med-text)",
  synthesizing: "var(--color-risk-med-text)",
  failed: "var(--color-risk-high)",
};

const STATUS_LABEL: Record<string, string> = {
  ready: "Ready",
  completed: "Ready",
  processing: "Processing",
  updating: "Updating",
  queued: "Queued",
  validating: "Validating",
  generating_config: "Generating",
  synthesizing: "Synthesizing",
  failed: "Failed",
};

export const StatusBadge = ({ status }: { status: string }) => {
  const dotColor = STATUS_DOT_COLOR[status] ?? "var(--color-steel)";
  const textColor = STATUS_TEXT_COLOR[status] ?? "var(--color-steel)";
  const label = STATUS_LABEL[status] ?? status;

  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium leading-none">
      <span
        aria-hidden="true"
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ background: dotColor }}
      />
      <span style={{ color: textColor }}>{label}</span>
    </span>
  );
};
