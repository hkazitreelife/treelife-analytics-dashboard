import { LegacyRedirect } from "@/components/shell/LegacyRedirect";

export const dynamic = "force-dynamic";

export default async function DocumentSummaryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return <LegacyRedirect lookupUrl={`/api/documents/${id}/session`} label="document" />;
}
