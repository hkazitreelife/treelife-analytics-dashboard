"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Lock, Mail, ArrowRight, Sparkles, ShieldCheck } from "lucide-react";

import { TreelifeLogo } from "@/components/ui/BrandLogo";

/**
 * Section 20/24's admin auth:
 * Premium Obsidian-Emerald Executive Glass Portal with 3D Parallax Landscape.
 */

type LoginPhase =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "error"; message: string };

type LoginResponseBody = {
  message?: string;
  errors?: { message: string }[];
};

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phase, setPhase] = useState<LoginPhase>({ kind: "idle" });

  const handleSubmit = async (
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();

    if (phase.kind === "pending") {
      return;
    }

    setPhase({ kind: "pending" });

    try {
      const response = await fetch("/api/users/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const body = (await response.json()) as LoginResponseBody;

      if (!response.ok) {
        setPhase({
          kind: "error",
          message:
            body.errors?.[0]?.message ??
            `Login failed (status ${response.status}).`,
        });
        return;
      }

      // Fast immediate redirect ensuring cookies are committed cleanly without soft-routing lag
      window.location.href = "/";
    } catch (error: unknown) {
      setPhase({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <div className="fixed inset-0 h-screen w-screen overflow-hidden bg-[#071912] flex items-center justify-center select-none">
      {/* High-Performance Ambient Glowing Emerald Canvas */}
      <div className="absolute inset-0 bg-[#06140e] overflow-hidden pointer-events-none">
        <div className="absolute -top-[20%] -left-[10%] w-[60vw] h-[60vw] rounded-full bg-emerald-600/10 blur-[120px] animate-pulse" />
        <div className="absolute top-[40%] -right-[15%] w-[55vw] h-[55vw] rounded-full bg-teal-500/10 blur-[140px]" />
        <div className="absolute -bottom-[20%] left-[20%] w-[50vw] h-[50vw] rounded-full bg-emerald-800/15 blur-[100px]" />
        {/* Subtle grid texture */}
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#10b98108_1px,transparent_1px),linear-gradient(to_bottom,#10b98108_1px,transparent_1px)] bg-[size:4rem_4rem] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_50%,#000_70%,transparent_100%)]" />
      </div>

      {/* Ambient Vignette & Emerald Atmospheric Glow */}
      <div className="pointer-events-none absolute inset-0 z-20 bg-[radial-gradient(ellipse_at_center,rgba(0,0,0,0.1)_0%,rgba(7,25,18,0.7)_75%,rgba(4,15,10,0.95)_100%)]" />

      {/* Top Floating Glass Badge */}
      <div className="pointer-events-none absolute top-6 left-6 z-30 hidden sm:flex items-center gap-2.5 rounded-full border border-white/5 bg-white/[0.02] px-4 py-2 text-xs font-semibold text-emerald-200 backdrop-blur-md shadow-lg">
        <span className="flex h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
        <span className="tracking-wide">Treelife AI Executive Workspace</span>
      </div>

      {/* Ultra-Premium Obsidian-Emerald Authentication Card */}
      <main className="relative z-40 w-full max-w-[420px] mx-3 sm:mx-4 overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-b from-[#0e271c]/25 via-[#0a1f16]/30 to-[#06140e]/35 p-6 sm:p-10 shadow-[0_30px_70px_rgba(0,0,0,0.6)] backdrop-blur-xl ring-1 ring-emerald-500/10 select-auto">
        {/* Subtle top inner glow line */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 h-[1px] w-3/4 bg-gradient-to-r from-transparent via-emerald-400/25 to-transparent" />

        <div className="mb-6 sm:mb-8 flex flex-col items-center text-center">
          <TreelifeLogo size="lg" showTagline={false} variant="light" className="max-w-[220px] sm:max-w-[280px]" />
          <h1 className="mt-4 sm:mt-5 text-xl sm:text-2xl font-black tracking-tight text-white">
            Executive Portal
          </h1>
          <p className="mt-1 text-xs text-emerald-200/70 font-medium">
            Sign in to access analytics & multi-source insights.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="login-email"
              className="block text-[11px] font-bold uppercase tracking-wider text-emerald-200/80 mb-1.5"
            >
              Email Address
            </label>
            <div className="relative">
              <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-emerald-300/60" />
              <input
                id="login-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                autoComplete="email"
                disabled={phase.kind === "pending"}
                className="w-full rounded-xl border border-emerald-500/10 bg-emerald-950/20 pl-10 pr-3.5 py-2.5 text-sm text-white placeholder-emerald-200/20 transition-all duration-200 focus:border-emerald-400/40 focus:bg-emerald-950/30 focus:outline-none focus:ring-2 focus:ring-emerald-400/20 disabled:opacity-50"
                placeholder="admin@treelife.com"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="login-password"
              className="block text-[11px] font-bold uppercase tracking-wider text-emerald-200/80 mb-1.5"
            >
              Password
            </label>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-emerald-300/60" />
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                autoComplete="current-password"
                disabled={phase.kind === "pending"}
                className="w-full rounded-xl border border-emerald-500/10 bg-emerald-950/20 pl-10 pr-3.5 py-2.5 text-sm text-white placeholder-emerald-200/20 transition-all duration-200 focus:border-emerald-400/40 focus:bg-emerald-950/30 focus:outline-none focus:ring-2 focus:ring-emerald-400/20 disabled:opacity-50"
                placeholder="••••••••"
              />
            </div>
          </div>

          {phase.kind === "error" ? (
            <div
              role="alert"
              className="rounded-xl border border-red-500/30 bg-red-950/50 p-3 text-xs font-semibold text-red-200 shadow-inner"
            >
              {phase.message}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={phase.kind === "pending"}
            className="group relative mt-2 flex w-full items-center justify-center gap-2 overflow-hidden rounded-xl border border-emerald-500/20 bg-emerald-500/10 hover:bg-emerald-500/15 py-3 text-sm font-bold text-emerald-100 shadow-[0_4px_20px_rgba(16,185,129,0.15)] backdrop-blur-md transition-all duration-200 hover:scale-[1.01] active:scale-[0.99] disabled:opacity-50 cursor-pointer"
          >
            {/* Shimmer sweep effect */}
            <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/10 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
            
            <span>{phase.kind === "pending" ? "Authenticating…" : "Sign In to Workspace"}</span>
            <ArrowRight className="h-4 w-4 transition-transform duration-150 group-hover:translate-x-1" />
          </button>
        </form>

        {/* Security badge footer */}
        <div className="mt-6 flex items-center justify-center gap-1.5 text-[11px] text-emerald-200/50">
          <ShieldCheck className="h-3.5 w-3.5 text-emerald-400/70" />
          <span>Encrypted 256-bit Executive Session</span>
        </div>
      </main>
    </div>
  );
}
