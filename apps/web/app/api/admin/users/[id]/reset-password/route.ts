import { randomBytes } from "node:crypto";

import { requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";

const generateTempPassword = (): string => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*";
  const bytes = randomBytes(16);
  let result = "";
  for (let i = 0; i < 14; i++) {
    result += chars[bytes[i]! % chars.length];
  }
  // Ensure character diversity
  return `${result}1A!`;
};

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireAdmin(request);

  if (!auth.authenticated) {
    return auth.response;
  }

  const { payload } = auth;
  const { id } = await context.params;

  let customPassword: string | undefined;
  try {
    const body = await request.json().catch(() => ({}));
    if (typeof body.password === "string" && body.password.length >= 8) {
      customPassword = body.password;
    }
  } catch {
    // default to generated
  }

  const tempPassword = customPassword || generateTempPassword();

  try {
    const updated = await payload.update({
      collection: "users",
      id,
      data: {
        password: tempPassword,
      },
    });

    return Response.json({
      success: true,
      email: updated.email,
      temporaryPassword: tempPassword,
      message: "Password reset successfully.",
    });
  } catch (error: unknown) {
    payload.logger.error({ err: error }, `Failed to reset password for user ${id}.`);
    return Response.json(
      { error: "Failed to reset password.", detail: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
