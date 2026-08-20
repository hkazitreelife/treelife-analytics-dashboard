import type { Payload, TypedUser } from "payload";

import { getPayloadClient } from "./payload";

export type UserRole = "admin" | "analyst" | "viewer";

export type AuthResult =
  | { authenticated: true; payload: Payload; user: TypedUser & { role?: string; isActive?: boolean } }
  | { authenticated: false; response: Response };

type CachedAuth = {
  user: TypedUser & { role?: string; isActive?: boolean };
  expiresAt: number;
};

const tokenAuthCache = new Map<string, CachedAuth>();

const getAuthTokenKey = (headers: Headers): string | null => {
  const cookieHeader = headers.get("cookie") || "";
  const match = cookieHeader.match(/payload-token=([^;]+)/);
  if (match && match[1]) return match[1];
  const authHeader = headers.get("authorization") || "";
  if (authHeader.startsWith("JWT ") || authHeader.startsWith("Bearer ")) {
    return authHeader.slice(authHeader.indexOf(" ") + 1).trim();
  }
  return null;
};

/**
 * Access control is enforced here, in Payload, rather than in prompts or in the
 * client. Checks both authentication and active status on every protected route.
 */
export const requireUser = async (
  request: Request,
  allowedRoles?: UserRole[],
): Promise<AuthResult> => {
  const payload = await getPayloadClient();
  const tokenKey = getAuthTokenKey(request.headers);

  let typedUser: (TypedUser & { role?: string; isActive?: boolean }) | null = null;

  if (tokenKey) {
    const cached = tokenAuthCache.get(tokenKey);
    if (cached && Date.now() < cached.expiresAt) {
      typedUser = cached.user;
    }
  }

  if (!typedUser) {
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

    typedUser = user as TypedUser & { role?: string; isActive?: boolean };

    if (tokenKey) {
      tokenAuthCache.set(tokenKey, {
        user: typedUser,
        expiresAt: Date.now() + 15_000, // 15-second TTL
      });
    }
  }

  // Explicit deactivation check: deactivated users are locked out immediately
  if (typedUser.isActive === false) {
    return {
      authenticated: false,
      response: Response.json(
        { error: "Account has been deactivated. Please contact an administrator." },
        { status: 403 },
      ),
    };
  }

  if (allowedRoles && allowedRoles.length > 0) {
    const role = (typedUser.role ?? "viewer") as UserRole;
    if (!allowedRoles.includes(role)) {
      return {
        authenticated: false,
        response: Response.json(
          { error: "Forbidden: You do not have permission to access this resource." },
          { status: 403 },
        ),
      };
    }
  }

  return { authenticated: true, payload, user: typedUser };
};

/**
 * Convenience helper requiring admin privileges for user management and system settings.
 */
export const requireAdmin = async (request: Request): Promise<AuthResult> =>
  requireUser(request, ["admin"]);

/**
 * Permission check helpers
 */
export const canManageUsers = (user: { role?: string }): boolean =>
  user.role === "admin";

export const canEditContent = (user: { role?: string }): boolean =>
  user.role === "admin" || user.role === "analyst";

export const canUploadData = (user: { role?: string }): boolean =>
  user.role === "admin" || user.role === "analyst";

