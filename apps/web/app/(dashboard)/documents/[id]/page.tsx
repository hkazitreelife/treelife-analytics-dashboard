import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LegacyRedirect } from "@/components/shell/LegacyRedirect";

export const dynamic = "force-dynamic";

export default async function DocumentSummaryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const cookieStore = await cookies();
  const token = cookieStore.get("payload-token")?.value;

  if (!token) {
    redirect("/login");
  }

  const { id } = await params;

  return <LegacyRedirect lookupUrl={`/api/documents/${id}/session`} label="document" />;
}
