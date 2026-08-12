import { z } from "zod";

/**
 * The chat agent's response contract, Section 17.4 / 20.9. Deliberately
 * thin: unlike the dashboard config contract, there is no structural
 * cross-reference to validate (a free-text answer has no table/column names
 * to check against the dataset), so this only enforces shape -- that Claude
 * actually returned an answer and that sources, if present, is a list of
 * strings. It cannot and does not attempt to verify the answer's factual
 * content; see claudeChatClient.ts for why that's a prompting concern, not a
 * code-level one.
 */
export const chatAnswerSchema = z
  .object({
    answer: z.string().min(1),
    sources: z.array(z.string()),
  })
  .strict();

export type ChatAnswerShape = z.infer<typeof chatAnswerSchema>;
