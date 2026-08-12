import { DashboardRenderer } from "@/components/dashboard/DashboardRenderer";

export const dynamic = "force-dynamic";

export default async function DatasetDashboardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <main className="mx-auto max-w-[1600px] p-6">
      <DashboardRenderer datasetId={id} />
    </main>
  );
}
