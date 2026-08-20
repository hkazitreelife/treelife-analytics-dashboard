import { requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireAdmin(request);

  if (!auth.authenticated) {
    return auth.response;
  }

  const { payload } = auth;

  try {
    const users = await payload.find({
      collection: "users",
      limit: 100,
      sort: "-createdAt",
      depth: 0,
    });

    const sanitizedUsers = users.docs.map((doc) => ({
      id: doc.id,
      email: doc.email,
      firstName: (doc as any).firstName ?? "",
      lastName: (doc as any).lastName ?? "",
      role: (doc as any).role ?? "viewer",
      isActive: (doc as any).isActive !== false,
      lastLogin: (doc as any).lastLogin ?? null,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    }));

    return Response.json({ users: sanitizedUsers, total: users.totalDocs });
  } catch (error: unknown) {
    payload.logger.error({ err: error }, "Failed to fetch users list.");
    return Response.json(
      { error: "Failed to fetch users.", detail: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  const auth = await requireAdmin(request);

  if (!auth.authenticated) {
    return auth.response;
  }

  const { payload } = auth;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { email, password, firstName, lastName, role, isActive } = body;

  if (!email || typeof email !== "string" || !email.includes("@")) {
    return Response.json({ error: "A valid email address is required." }, { status: 400 });
  }

  if (!password || typeof password !== "string" || password.length < 8) {
    return Response.json({ error: "Password must be at least 8 characters long." }, { status: 400 });
  }

  const validRoles = ["admin", "analyst", "viewer"];
  if (role && !validRoles.includes(role)) {
    return Response.json({ error: `Role must be one of: ${validRoles.join(", ")}` }, { status: 400 });
  }

  try {
    const existing = await payload.find({
      collection: "users",
      where: { email: { equals: email.trim().toLowerCase() } },
      limit: 1,
    });

    if (existing.totalDocs > 0) {
      return Response.json({ error: "A user with this email already exists." }, { status: 409 });
    }

    const created = await payload.create({
      collection: "users",
      data: {
        email: email.trim().toLowerCase(),
        password,
        firstName: firstName?.trim() || "",
        lastName: lastName?.trim() || "",
        role: role || "viewer",
        isActive: isActive !== false,
      },
    });

    return Response.json(
      {
        user: {
          id: created.id,
          email: created.email,
          firstName: (created as any).firstName,
          lastName: (created as any).lastName,
          role: (created as any).role,
          isActive: (created as any).isActive,
          createdAt: created.createdAt,
        },
      },
      { status: 201 },
    );
  } catch (error: unknown) {
    payload.logger.error({ err: error }, "Failed to create user.");
    return Response.json(
      { error: "Failed to create user.", detail: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
