import { DocumentSummaryRenderer } from "@/components/documents/DocumentSummaryRenderer";

export const dynamic = "force-dynamic";

export default async function DocumentSummaryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <main className="mx-auto max-w-[1600px] p-6">
      <DocumentSummaryRenderer documentId={id} />
    </main>
  );
}
