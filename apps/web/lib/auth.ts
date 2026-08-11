import type { Payload, TypedUser } from "payload";

import { getPayloadClient } from "./payload";

export type AuthResult =
  | { authenticated: true; payload: Payload; user: TypedUser }
  | { authenticated: false; response: Response };

/**
 * Access control is enforced here, in Payload, rather than in prompts or in the
 * client. Every route in this app is admin-only for v1.
 */
export const requireUser = async (request: Request): Promise<AuthResult> => {
  const payload = await getPayloadClient();
  const { user } = await payload.auth({ headers: request.headers });

  if (!user) {
    return {
      authenticated: false,
      response: Response.json(
        { error: "Authentication required." },
        { status: 401 },
      ),
    };
  }

  return { authenticated: true, payload, user };
};
