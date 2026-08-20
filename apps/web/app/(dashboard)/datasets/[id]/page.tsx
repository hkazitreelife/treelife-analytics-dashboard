import { LegacyRedirect } from "@/components/shell/LegacyRedirect";

export const dynamic = "force-dynamic";

export default async function DatasetDashboardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return <LegacyRedirect lookupUrl={`/api/datasets/${id}/session`} label="dataset" />;
}
