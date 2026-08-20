import { SessionShellPage } from "@/components/shell/SessionShellPage";

export const dynamic = "force-dynamic";

export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return <SessionShellPage sessionId={id} />;
}
