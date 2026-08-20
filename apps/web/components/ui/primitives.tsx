"use client";

import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import React from "react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Small shadcn-idiom primitive set: Radix under the hood for accessibility,
 * Tailwind for styling. Impeccable high-craft visual tokens.
 */

export const Card = ({
  className,
  children,
  ...props
}: ComponentProps<"section">) => (
  <section
    className={cn(
      "flex min-h-0 flex-col overflow-hidden rounded-xl border border-[color:var(--color-cloud)] bg-white shadow-xs transition-all duration-150",
      className,
    )}
    {...props}
  >
    {children}
  </section>
);

export const CardHeader = ({ className, children }: { className?: string; children: ReactNode }) => (
  <header className={cn("border-b border-[color:var(--color-cloud)]/80 px-4 py-3 bg-[color:var(--color-cloud-light)]/40", className)}>
    {children}
  </header>
);

export const CardTitle = ({ className, children }: { className?: string; children: ReactNode }) => (
  <h3 className={cn("text-sm font-semibold tracking-tight text-[color:var(--color-forest)]", className)}>
    {children}
  </h3>
);

export const CardBody = ({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) => <div className={cn("min-h-0 flex-1 p-4", className)}>{children}</div>;

export const Tabs = TabsPrimitive.Root;

export const TabsList = ({
  className,
  ...props
}: ComponentProps<typeof TabsPrimitive.List>) => (
  <TabsPrimitive.List
    className={cn(
      "flex max-w-full overflow-x-auto items-center gap-1.5 rounded-2xl border border-[color:var(--color-cloud)] bg-[color:var(--color-cloud-light)]/80 p-1.5 shadow-2xs backdrop-blur-xs",
      className,
    )}
    {...props}
  />
);

export const TabsTrigger = ({
  className,
  ...props
}: ComponentProps<typeof TabsPrimitive.Trigger>) => (
  <TabsPrimitive.Trigger
    className={cn(
      "inline-flex shrink-0 items-center justify-center gap-2 rounded-xl px-4 py-2 text-xs font-bold text-[color:var(--color-steel)] transition-all duration-200 cursor-pointer select-none",
      "hover:text-[color:var(--color-forest)] hover:bg-white/70",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-forest-bright)]/30",
      "data-[state=active]:bg-white data-[state=active]:text-[color:var(--color-forest)] data-[state=active]:shadow-xs data-[state=active]:ring-1 data-[state=active]:ring-black/5",
      className,
    )}
    {...props}
  />
);

export const TabsContent = TabsPrimitive.Content;

export const Badge = ({
  className,
  variant = "default",
  children,
  ...props
}: ComponentProps<"span"> & {
  variant?: "default" | "forest" | "cobalt" | "warning" | "negative" | "positive";
}) => {
  const variantStyles = {
    default: "bg-[color:var(--color-cloud)] text-[color:var(--color-steel)]",
    forest: "bg-[color:var(--color-forest-surface)] text-[color:var(--color-forest)] border-transparent",
    cobalt: "bg-[color:var(--color-cobalt-surface)] text-[color:var(--color-cobalt-text)] border-transparent",
    warning: "bg-[color:var(--color-risk-med-surface)] text-[color:var(--color-risk-med-text)] border-transparent",
    negative: "bg-[color:var(--color-risk-high-surface)] text-[color:var(--color-risk-high)] border-transparent",
    positive: "bg-[color:var(--color-risk-low-surface)] text-[color:var(--color-risk-low-text)] border-transparent",
  }[variant];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide border border-[color:var(--color-cloud)]/60",
        variantStyles,
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
};

export const Skeleton = ({ className }: { className?: string }) => (
  <div
    className={cn(
      "animate-pulse rounded-lg bg-[color:var(--color-cloud)]/80",
      className,
    )}
  />
);

export const EmptyState = ({ message, className }: { message: string; className?: string }) => (
  <div className={cn("flex h-full min-h-28 items-center justify-center rounded-xl border border-dashed border-[color:var(--color-cloud)] bg-white/60 p-6 text-center text-xs font-medium text-[color:var(--color-steel)]", className)}>
    {message}
  </div>
);

export const Collapsible = CollapsiblePrimitive.Root;
export const CollapsibleTrigger = CollapsiblePrimitive.Trigger;
export const CollapsibleContent = CollapsiblePrimitive.Content;

export const ErrorState = ({
  title,
  detail,
}: {
  title: string;
  detail?: string | null;
}) => (
  <div
    role="alert"
    className="rounded-xl border border-[color:var(--color-risk-high)]/30 bg-[color:var(--color-risk-high-surface)] p-4 shadow-xs"
  >
    <div className="flex items-center gap-2">
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[color:var(--color-risk-high)] text-white text-xs font-bold">!</span>
      <p className="text-sm font-semibold text-[color:var(--color-risk-high)]">
        {title}
      </p>
    </div>
    {detail ? (
      <details className="mt-2.5 pl-7">
        <summary className="cursor-pointer text-xs font-medium text-[color:var(--color-steel)] hover:text-[color:var(--color-ink)]">
          Technical details
        </summary>
        <pre className="mt-1.5 max-h-64 overflow-auto rounded-lg bg-white/80 p-2.5 text-xs text-[color:var(--color-steel)] whitespace-pre-wrap break-words border border-[color:var(--color-cloud)]">
          {detail}
        </pre>
      </details>
    ) : null}
  </div>
);
