import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getPayloadClient } from "@/lib/payload";
import { AppShell } from "@/components/shell/AppShell";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const cookieStore = await cookies();
  const token = cookieStore.get("payload-token")?.value;

  if (!token) {
    redirect("/login");
  }

  try {
    const payload = await getPayloadClient();
    const userRes = await payload.auth({ headers: await headers() });
    if (!userRes.user) {
      redirect("/login");
    }

    const recent = await payload.find({
      collection: "sessions",
      limit: 1,
      sort: "-updatedAt",
      depth: 0,
    });

    const mostRecent = recent.docs[0];
    if (mostRecent) {
      redirect(`/sessions/${mostRecent.id}`);
    }
  } catch (error) {
    if ((error as any)?.digest?.startsWith("NEXT_REDIRECT") || (error as any)?.message === "NEXT_REDIRECT") {
      throw error;
    }
  }

  return (
    <AppShell>
      <div className="mx-auto flex max-w-md flex-col items-center gap-2 py-24 text-center">
        <h1 className="text-lg font-semibold text-[color:var(--color-forest)]">Nothing here yet</h1>
        <p className="text-sm text-[color:var(--color-steel)]">
          Click New in the top bar to upload your first file.
        </p>
      </div>
    </AppShell>
  );
}
