import { serve } from "inngest/next";

import { inngest } from "@/lib/inngest";
import {
  ingestDatasetFunction,
  ingestDocumentFunction,
  upgradeDatasetConfigFunction,
  upgradeSessionOverviewFunction,
} from "@/lib/inngestFunctions";

export const runtime = "nodejs";

// upgradeSessionOverviewFunction is Phase B for combined sessions (the
// counterpart of upgradeDatasetConfigFunction): POST /api/sessions writes
// the deterministic fallback and returns fast, then fires
// session/synthesis-requested for THIS function to attempt the AI upgrade
// decoupled from any HTTP request.
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    ingestDatasetFunction,
    ingestDocumentFunction,
    upgradeDatasetConfigFunction,
    upgradeSessionOverviewFunction,
  ],
});
