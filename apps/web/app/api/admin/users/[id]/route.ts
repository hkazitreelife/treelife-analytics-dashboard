import { requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireAdmin(request);

  if (!auth.authenticated) {
    return auth.response;
  }

  const { payload, user: currentUser } = auth;
  const { id } = await context.params;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { firstName, lastName, role, isActive, password } = body;

  const updateData: Record<string, any> = {};

  if (typeof firstName === "string") updateData.firstName = firstName.trim();
  if (typeof lastName === "string") updateData.lastName = lastName.trim();
  if (typeof isActive === "boolean") {
    // Prevent admin from deactivating themselves
    if (String(currentUser.id) === String(id) && !isActive) {
      return Response.json({ error: "You cannot deactivate your own admin account." }, { status: 400 });
    }
    updateData.isActive = isActive;
  }
  if (typeof role === "string") {
    const validRoles = ["admin", "analyst", "viewer"];
    if (!validRoles.includes(role)) {
      return Response.json({ error: `Role must be one of: ${validRoles.join(", ")}` }, { status: 400 });
    }
    // Prevent admin from demoting themselves
    if (String(currentUser.id) === String(id) && role !== "admin") {
      return Response.json({ error: "You cannot remove your own admin role." }, { status: 400 });
    }
    updateData.role = role;
  }
  if (typeof password === "string" && password.length >= 8) {
    updateData.password = password;
  }

  try {
    const updated = await payload.update({
      collection: "users",
      id,
      data: updateData,
    });

    return Response.json({
      user: {
        id: updated.id,
        email: updated.email,
        firstName: (updated as any).firstName,
        lastName: (updated as any).lastName,
        role: (updated as any).role,
        isActive: (updated as any).isActive,
        lastLogin: (updated as any).lastLogin,
        updatedAt: updated.updatedAt,
      },
    });
  } catch (error: unknown) {
    payload.logger.error({ err: error }, `Failed to update user ${id}.`);
    return Response.json(
      { error: "Failed to update user.", detail: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireAdmin(request);

  if (!auth.authenticated) {
    return auth.response;
  }

  const { payload, user: currentUser } = auth;
  const { id } = await context.params;

  // Prevent admin from deleting themselves
  if (String(currentUser.id) === String(id)) {
    return Response.json({ error: "You cannot delete your own account." }, { status: 400 });
  }

  try {
    await payload.delete({
      collection: "users",
      id,
    });

    return Response.json({ success: true, deletedId: id });
  } catch (error: unknown) {
    payload.logger.error({ err: error }, `Failed to delete user ${id}.`);
    return Response.json(
      { error: "Failed to delete user.", detail: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
