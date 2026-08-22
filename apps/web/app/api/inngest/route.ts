import { serve } from "inngest/next";

import { inngest } from "@/lib/inngest";
import { ingestDatasetFunction, ingestDocumentFunction } from "@/lib/inngestFunctions";

export const runtime = "nodejs";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [ingestDatasetFunction, ingestDocumentFunction],
});
