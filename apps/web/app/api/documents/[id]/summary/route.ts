import { requireUser } from "@/lib/auth";

export const runtime = "nodejs";

type StoredDocumentData = {
  sections?: { sectionId: string; heading: string }[];
};

/**
 * Section 10.0. Returns the document's sections (for "jump to this part")
 * and the latest Summaries row's keyPoints + version. Never fullText/
 * rawContent here -- the renderer only needs headings to build the jump
 * links; the expand endpoint is what actually reads fullText server-side.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser(request);

  if (!auth.authenticated) {
    return auth.response;
  }

  const { payload } = auth;
  const { id } = await context.params;

  let document;

  try {
    document = await payload.findByID({
      collection: "documents",
      id,
      depth: 0,
    });
  } catch {
    return Response.json({ error: "Document not found." }, { status: 404 });
  }

  const stored = document.data as StoredDocumentData | null;
  const sections = (stored?.sections ?? []).map((section) => ({
    sectionId: section.sectionId,
    heading: section.heading,
  }));

  const summaries = await payload.find({
    collection: "summaries",
    where: { document: { equals: Number(id) } },
    limit: 1,
    depth: 0,
    sort: "-version,-createdAt",
  });

  const latest = summaries.docs[0];

  if (!latest) {
    return Response.json(
      { error: "No summary exists for this document yet." },
      { status: 404 },
    );
  }

  return Response.json({
    documentId: String(id),
    version: latest.version,
    keyPoints: latest.keyPoints ?? [],
    sections,
  });
}
