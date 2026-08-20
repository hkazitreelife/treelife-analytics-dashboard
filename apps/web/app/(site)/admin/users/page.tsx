"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { fetchJsonCached, invalidateClientCache } from "@/lib/clientCache";

type UserItem = {
  id: string | number;
  email: string;
  firstName: string;
  lastName: string;
  role: "admin" | "analyst" | "viewer";
  isActive: boolean;
  lastLogin: string | null;
  createdAt: string;
};

export default function AdminUsersPage() {
  const [users, setUsers] = useState<UserItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Modal states
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editUser, setEditUser] = useState<UserItem | null>(null);
  const [resetPassUser, setResetPassUser] = useState<UserItem | null>(null);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionSuccessMessage, setActionSuccessMessage] = useState<string | null>(null);

  // Form states
  const [createForm, setCreateForm] = useState({
    email: "",
    password: "",
    firstName: "",
    lastName: "",
    role: "analyst" as "admin" | "analyst" | "viewer",
    isActive: true,
  });

  const fetchUsers = async (forceFresh = false) => {
    setLoading(true);
    setError(null);
    try {
      if (forceFresh) {
        invalidateClientCache("/api/admin/users");
      }
      const data = await fetchJsonCached<{ users: UserItem[]; total: number }>(
        "/api/admin/users",
        forceFresh ? 0 : 30_000,
      );
      setUsers(data.users || []);
    } catch (err: any) {
      if (err.message?.includes("401") || err.message?.includes("Authentication required")) {
        window.location.href = "/login";
        return;
      }
      if (err.message?.includes("403") || err.message?.includes("Forbidden")) {
        setError("Access Denied: You must be an Administrator to manage users.");
        return;
      }
      setError(err.message || "Failed to load users.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchUsers();
  }, []);

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionLoading(true);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(createForm),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to create user.");
      }
      setCreateModalOpen(false);
      setCreateForm({
        email: "",
        password: "",
        firstName: "",
        lastName: "",
        role: "analyst",
        isActive: true,
      });
      setActionSuccessMessage(`User ${data.user.email} created successfully.`);
      setTimeout(() => setActionSuccessMessage(null), 4000);
      await fetchUsers(true);
    } catch (err: any) {
      alert(err.message || "Failed to create user.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editUser) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/admin/users/${editUser.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          firstName: editUser.firstName,
          lastName: editUser.lastName,
          role: editUser.role,
          isActive: editUser.isActive,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to update user.");
      }
      setEditUser(null);
      setActionSuccessMessage("User updated successfully.");
      setTimeout(() => setActionSuccessMessage(null), 4000);
      await fetchUsers(true);
    } catch (err: any) {
      alert(err.message || "Failed to update user.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleToggleActive = async (user: UserItem) => {
    try {
      const nextActive = !user.isActive;
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ isActive: nextActive }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Failed to toggle user status.");
        return;
      }
      setUsers((prev) =>
        prev.map((u) => (u.id === user.id ? { ...u, isActive: nextActive } : u)),
      );
    } catch (err: any) {
      alert(err.message || "Failed to toggle user status.");
    }
  };

  const handleResetPassword = async (userId: string | number) => {
    setActionLoading(true);
    setTempPassword(null);
    try {
      const res = await fetch(`/api/admin/users/${userId}/reset-password`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to reset password.");
      }
      setTempPassword(data.temporaryPassword);
    } catch (err: any) {
      alert(err.message || "Failed to reset password.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteUser = async (user: UserItem) => {
    if (!confirm(`Are you sure you want to permanently delete ${user.email}?`)) {
      return;
    }
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Failed to delete user.");
        return;
      }
      setUsers((prev) => prev.filter((u) => u.id !== user.id));
      invalidateClientCache("/api/admin/users");
      setActionSuccessMessage(`User ${user.email} removed.`);
      setTimeout(() => setActionSuccessMessage(null), 4000);
    } catch (err: any) {
      alert(err.message || "Failed to delete user.");
    }
  };

  const filteredUsers = users.filter((u) => {
    const q = searchQuery.toLowerCase();
    const fullName = `${u.firstName} ${u.lastName}`.toLowerCase();
    return u.email.toLowerCase().includes(q) || fullName.includes(q) || u.role.includes(q);
  });

  return (
    <AppShell>
      <div className="mx-auto max-w-6xl space-y-6 py-6 px-4">
        {/* Breadcrumb & Navigation */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold text-[color:var(--color-steel)]">
            <Link href="/" className="hover:text-[color:var(--color-forest)] transition-colors">
              Dashboard
            </Link>
            <span>/</span>
            <span className="text-[color:var(--color-forest)]">User Management</span>
          </div>

          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="rounded-xl border border-[color:var(--color-cloud)] px-3 py-1.5 text-xs font-bold text-[color:var(--color-ink)] hover:bg-[color:var(--color-cloud-light)] shadow-2xs"
            >
              ← Back to App
            </Link>
          </div>
        </div>

        {/* Header Banner */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between rounded-2xl border border-[color:var(--color-cloud)] bg-white p-5 shadow-xs">
          <div>
            <div className="inline-flex items-center gap-1.5 rounded-full bg-[color:var(--color-forest-surface)] px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-forest)] border border-[color:var(--color-forest-bright)]/20">
              Admin Portal
            </div>
            <h1 className="mt-1 text-2xl font-extrabold text-[color:var(--color-forest)] tracking-tight">
              User Management & Access Control
            </h1>
            <p className="text-xs text-[color:var(--color-steel)] mt-0.5">
              Provision accounts, assign permissions (Admin, Analyst, Viewer), and manage authentication credentials.
            </p>
          </div>

          <button
            type="button"
            onClick={() => setCreateModalOpen(true)}
            className="inline-flex items-center gap-2 rounded-xl bg-[color:var(--color-forest)] px-4 py-2.5 text-xs font-bold text-white shadow-xs hover:bg-[color:var(--color-forest)]/90 active:scale-95 transition-all self-start sm:self-auto"
          >
            <span>+</span>
            <span>Create New User</span>
          </button>
        </div>

        {actionSuccessMessage ? (
          <div role="status" className="rounded-xl border border-[color:var(--color-risk-low)]/30 bg-[color:var(--color-risk-low-surface)] p-3 text-xs font-semibold text-[color:var(--color-risk-low-text)] shadow-2xs flex items-center gap-2">
            <span>✓</span>
            <span>{actionSuccessMessage}</span>
          </div>
        ) : null}

        {error ? (
          <div role="alert" className="rounded-xl border border-[color:var(--color-risk-high)]/30 bg-[color:var(--color-risk-high-surface)] p-4 text-xs font-semibold text-[color:var(--color-risk-high)] shadow-2xs">
            {error}
          </div>
        ) : null}

        {/* Filter bar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="relative flex-1 max-w-sm w-full">
            <input
              type="text"
              placeholder="Search users by name, email, or role…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-xl border border-[color:var(--color-cloud)] bg-white px-3.5 py-2 text-xs text-[color:var(--color-ink)] placeholder-[color:var(--color-steel)] shadow-2xs focus:border-[color:var(--color-forest)] focus:outline-none"
            />
          </div>

          <div className="text-xs text-[color:var(--color-steel)] font-medium">
            Showing <strong className="text-[color:var(--color-forest)]">{filteredUsers.length}</strong> of {users.length} user{users.length === 1 ? "" : "s"}
          </div>
        </div>

        {/* Users Table */}
        <div className="overflow-hidden rounded-2xl border border-[color:var(--color-cloud)] bg-white shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-[color:var(--color-ink)]">
              <thead className="border-b border-[color:var(--color-cloud)] bg-[color:var(--color-cloud-light)] text-[11px] font-bold uppercase tracking-wider text-[color:var(--color-steel)]">
                <tr>
                  <th className="py-3 px-4">User</th>
                  <th className="py-3 px-4">Role</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Last Login</th>
                  <th className="py-3 px-4">Created</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-cloud)]">
                {loading ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-xs text-[color:var(--color-steel)]">
                      Loading users…
                    </td>
                  </tr>
                ) : filteredUsers.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-xs text-[color:var(--color-steel)]">
                      No users found.
                    </td>
                  </tr>
                ) : (
                  filteredUsers.map((user) => {
                    const fullName = `${user.firstName} ${user.lastName}`.trim();
                    return (
                      <tr key={user.id} className="hover:bg-[color:var(--color-cloud-light)]/40 transition-colors">
                        <td className="py-3 px-4">
                          <div className="flex flex-col">
                            <span className="font-bold text-[color:var(--color-forest)]">
                              {fullName || "—"}
                            </span>
                            <span className="text-[11px] text-[color:var(--color-steel)] font-mono">
                              {user.email}
                            </span>
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wider ${
                              user.role === "admin"
                                ? "bg-[color:var(--color-forest-surface)] text-[color:var(--color-forest)] border border-[color:var(--color-forest-bright)]/30"
                                : user.role === "analyst"
                                  ? "bg-[color:var(--color-cobalt-surface)] text-[color:var(--color-cobalt-text)] border border-[color:var(--color-cobalt)]/30"
                                  : "bg-[color:var(--color-cloud-light)] text-[color:var(--color-steel)] border border-[color:var(--color-cloud)]"
                            }`}
                          >
                            {user.role}
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          <button
                            type="button"
                            onClick={() => void handleToggleActive(user)}
                            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-bold transition-all ${
                              user.isActive
                                ? "bg-[color:var(--color-risk-low-surface)] text-[color:var(--color-risk-low-text)] border border-[color:var(--color-risk-low)]/30 hover:opacity-80"
                                : "bg-[color:var(--color-risk-high-surface)] text-[color:var(--color-risk-high)] border border-[color:var(--color-risk-high)]/30 hover:opacity-80"
                            }`}
                          >
                            <span className={`h-1.5 w-1.5 rounded-full ${user.isActive ? "bg-[color:var(--color-risk-low)]" : "bg-[color:var(--color-risk-high)]"}`} />
                            <span>{user.isActive ? "Active" : "Deactivated"}</span>
                          </button>
                        </td>
                        <td className="py-3 px-4 text-[11px] text-[color:var(--color-steel)]">
                          {user.lastLogin ? new Date(user.lastLogin).toLocaleDateString() : "Never"}
                        </td>
                        <td className="py-3 px-4 text-[11px] text-[color:var(--color-steel)]">
                          {new Date(user.createdAt).toLocaleDateString()}
                        </td>
                        <td className="py-3 px-4 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => setEditUser(user)}
                              className="rounded-lg border border-[color:var(--color-cloud)] bg-white px-2.5 py-1 text-[11px] font-bold text-[color:var(--color-ink)] hover:bg-[color:var(--color-cloud-light)] shadow-2xs"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setResetPassUser(user);
                                void handleResetPassword(user.id);
                              }}
                              className="rounded-lg border border-[color:var(--color-cobalt)]/30 bg-[color:var(--color-cobalt-surface)] px-2.5 py-1 text-[11px] font-bold text-[color:var(--color-cobalt-text)] hover:opacity-90 shadow-2xs"
                            >
                              Reset Pass
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDeleteUser(user)}
                              className="rounded-lg border border-[color:var(--color-risk-high)]/20 px-2 py-1 text-[11px] font-bold text-[color:var(--color-risk-high)] hover:bg-[color:var(--color-risk-high-surface)]"
                            >
                              ✕
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* CREATE USER MODAL */}
      {createModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-2xl border border-[color:var(--color-cloud)] bg-white p-6 shadow-xl space-y-4 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-[color:var(--color-cloud)] pb-3">
              <h3 className="text-base font-bold text-[color:var(--color-forest)]">
                Create New User
              </h3>
              <button
                type="button"
                onClick={() => setCreateModalOpen(false)}
                className="text-xs font-bold text-[color:var(--color-steel)] hover:text-[color:var(--color-ink)]"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateSubmit} className="space-y-3.5 text-xs">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-bold text-[color:var(--color-forest)] mb-1">First Name</label>
                  <input
                    type="text"
                    value={createForm.firstName}
                    onChange={(e) => setCreateForm({ ...createForm, firstName: e.target.value })}
                    className="w-full rounded-xl border border-[color:var(--color-cloud)] p-2"
                  />
                </div>
                <div>
                  <label className="block font-bold text-[color:var(--color-forest)] mb-1">Last Name</label>
                  <input
                    type="text"
                    value={createForm.lastName}
                    onChange={(e) => setCreateForm({ ...createForm, lastName: e.target.value })}
                    className="w-full rounded-xl border border-[color:var(--color-cloud)] p-2"
                  />
                </div>
              </div>

              <div>
                <label className="block font-bold text-[color:var(--color-forest)] mb-1">Email Address *</label>
                <input
                  type="email"
                  required
                  value={createForm.email}
                  onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
                  className="w-full rounded-xl border border-[color:var(--color-cloud)] p-2"
                  placeholder="analyst@example.com"
                />
              </div>

              <div>
                <label className="block font-bold text-[color:var(--color-forest)] mb-1">Initial Password *</label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={createForm.password}
                  onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })}
                  className="w-full rounded-xl border border-[color:var(--color-cloud)] p-2 font-mono"
                  placeholder="Min 8 characters"
                />
              </div>

              <div>
                <label className="block font-bold text-[color:var(--color-forest)] mb-1">Role Permission *</label>
                <select
                  value={createForm.role}
                  onChange={(e) => setCreateForm({ ...createForm, role: e.target.value as any })}
                  className="w-full rounded-xl border border-[color:var(--color-cloud)] p-2 bg-white font-medium"
                >
                  <option value="admin">Admin (Full Access & User Provisioning)</option>
                  <option value="analyst">Analyst (Uploads, Prompt Edits & Chat)</option>
                  <option value="viewer">Viewer (Read-only Dashboard & Exports)</option>
                </select>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <input
                  type="checkbox"
                  id="create-isActive"
                  checked={createForm.isActive}
                  onChange={(e) => setCreateForm({ ...createForm, isActive: e.target.checked })}
                  className="rounded border-[color:var(--color-cloud)]"
                />
                <label htmlFor="create-isActive" className="font-semibold text-[color:var(--color-ink)]">
                  Account is Active (can authenticate immediately)
                </label>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-[color:var(--color-cloud)]">
                <button
                  type="button"
                  onClick={() => setCreateModalOpen(false)}
                  className="rounded-xl border border-[color:var(--color-cloud)] px-4 py-2 font-bold text-[color:var(--color-steel)] hover:bg-[color:var(--color-cloud-light)]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="rounded-xl bg-[color:var(--color-forest)] px-4 py-2 font-bold text-white shadow-xs hover:bg-[color:var(--color-forest)]/90 disabled:opacity-50"
                >
                  {actionLoading ? "Creating…" : "Create User"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* EDIT USER MODAL */}
      {editUser ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-2xl border border-[color:var(--color-cloud)] bg-white p-6 shadow-xl space-y-4 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-[color:var(--color-cloud)] pb-3">
              <h3 className="text-base font-bold text-[color:var(--color-forest)]">
                Edit User: {editUser.email}
              </h3>
              <button
                type="button"
                onClick={() => setEditUser(null)}
                className="text-xs font-bold text-[color:var(--color-steel)] hover:text-[color:var(--color-ink)]"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleEditSubmit} className="space-y-3.5 text-xs">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-bold text-[color:var(--color-forest)] mb-1">First Name</label>
                  <input
                    type="text"
                    value={editUser.firstName}
                    onChange={(e) => setEditUser({ ...editUser, firstName: e.target.value })}
                    className="w-full rounded-xl border border-[color:var(--color-cloud)] p-2"
                  />
                </div>
                <div>
                  <label className="block font-bold text-[color:var(--color-forest)] mb-1">Last Name</label>
                  <input
                    type="text"
                    value={editUser.lastName}
                    onChange={(e) => setEditUser({ ...editUser, lastName: e.target.value })}
                    className="w-full rounded-xl border border-[color:var(--color-cloud)] p-2"
                  />
                </div>
              </div>

              <div>
                <label className="block font-bold text-[color:var(--color-forest)] mb-1">Role Permission</label>
                <select
                  value={editUser.role}
                  onChange={(e) => setEditUser({ ...editUser, role: e.target.value as any })}
                  className="w-full rounded-xl border border-[color:var(--color-cloud)] p-2 bg-white font-medium"
                >
                  <option value="admin">Admin (Full Access & User Provisioning)</option>
                  <option value="analyst">Analyst (Uploads, Prompt Edits & Chat)</option>
                  <option value="viewer">Viewer (Read-only Dashboard & Exports)</option>
                </select>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <input
                  type="checkbox"
                  id="edit-isActive"
                  checked={editUser.isActive}
                  onChange={(e) => setEditUser({ ...editUser, isActive: e.target.checked })}
                  className="rounded border-[color:var(--color-cloud)]"
                />
                <label htmlFor="edit-isActive" className="font-semibold text-[color:var(--color-ink)]">
                  Account is Active
                </label>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-[color:var(--color-cloud)]">
                <button
                  type="button"
                  onClick={() => setEditUser(null)}
                  className="rounded-xl border border-[color:var(--color-cloud)] px-4 py-2 font-bold text-[color:var(--color-steel)] hover:bg-[color:var(--color-cloud-light)]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="rounded-xl bg-[color:var(--color-forest)] px-4 py-2 font-bold text-white shadow-xs hover:bg-[color:var(--color-forest)]/90 disabled:opacity-50"
                >
                  {actionLoading ? "Saving…" : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* RESET PASSWORD MODAL */}
      {resetPassUser ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-2xl border border-[color:var(--color-cloud)] bg-white p-6 shadow-xl space-y-4 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-[color:var(--color-cloud)] pb-3">
              <h3 className="text-base font-bold text-[color:var(--color-forest)]">
                Password Reset: {resetPassUser.email}
              </h3>
              <button
                type="button"
                onClick={() => setResetPassUser(null)}
                className="text-xs font-bold text-[color:var(--color-steel)] hover:text-[color:var(--color-ink)]"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <p className="text-[color:var(--color-steel)]">
                A new high-entropy temporary password has been generated for this user.
              </p>

              {tempPassword ? (
                <div className="rounded-xl bg-[color:var(--color-cloud-light)] border border-[color:var(--color-cloud)] p-3.5 space-y-2">
                  <span className="text-[11px] font-bold text-[color:var(--color-forest)] uppercase tracking-wider block">
                    Temporary Password
                  </span>
                  <div className="flex items-center justify-between gap-2">
                    <code className="font-mono text-sm font-extrabold text-[color:var(--color-ink)] select-all">
                      {tempPassword}
                    </code>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(tempPassword);
                        alert("Copied to clipboard!");
                      }}
                      className="rounded-lg bg-[color:var(--color-forest)] px-2.5 py-1 text-[11px] font-bold text-white shadow-2xs hover:bg-[color:var(--color-forest)]/90"
                    >
                      Copy
                    </button>
                  </div>
                </div>
              ) : actionLoading ? (
                <div className="py-4 text-center text-[color:var(--color-steel)]">
                  Generating secure password…
                </div>
              ) : null}

              <div className="flex justify-end pt-2">
                <button
                  type="button"
                  onClick={() => setResetPassUser(null)}
                  className="rounded-xl bg-[color:var(--color-forest)] px-4 py-2 text-xs font-bold text-white shadow-xs"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}
