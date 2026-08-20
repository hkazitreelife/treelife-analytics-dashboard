import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SessionShellPage } from "@/components/shell/SessionShellPage";

export const dynamic = "force-dynamic";

export default async function SessionPage({
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

  return <SessionShellPage sessionId={id} />;
}
