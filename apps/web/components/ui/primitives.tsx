"use client";

import * as TabsPrimitive from "@radix-ui/react-tabs";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Small shadcn-idiom primitive set: Radix under the hood for accessibility,
 * Tailwind for styling. Nothing here knows anything about any dataset.
 */

export const Card = ({
  className,
  children,
  ...props
}: ComponentProps<"section">) => (
  <section
    className={cn(
      "flex min-h-0 flex-col overflow-hidden rounded-lg border border-[color:var(--color-cloud)] bg-white shadow-sm",
      className,
    )}
    {...props}
  >
    {children}
  </section>
);

export const CardHeader = ({ children }: { children: ReactNode }) => (
  <header className="border-b border-[color:var(--color-cloud)] px-4 py-3">
    {children}
  </header>
);

export const CardTitle = ({ children }: { children: ReactNode }) => (
  <h3 className="text-sm font-semibold text-[color:var(--color-forest)]">
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
      "flex flex-wrap gap-1 rounded-lg border border-[color:var(--color-cloud)] bg-white p-1",
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
      "rounded-md px-3 py-1.5 text-sm font-medium text-[color:var(--color-steel)] transition-colors",
      "hover:bg-[color:var(--color-cloud)]",
      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-cobalt)]",
      "data-[state=active]:bg-[color:var(--color-forest)] data-[state=active]:text-white",
      className,
    )}
    {...props}
  />
);

export const TabsContent = TabsPrimitive.Content;

export const Skeleton = ({ className }: { className?: string }) => (
  <div
    className={cn(
      "animate-pulse rounded-md bg-[color:var(--color-cloud)]",
      className,
    )}
  />
);

export const EmptyState = ({ message }: { message: string }) => (
  <div className="flex h-full min-h-24 items-center justify-center rounded-md border border-dashed border-[color:var(--color-cloud)] p-4 text-center text-sm text-[color:var(--color-steel)]">
    {message}
  </div>
);

export const ErrorState = ({
  title,
  detail,
}: {
  title: string;
  detail?: string | null;
}) => (
  <div
    role="alert"
    className="rounded-lg border border-[color:var(--color-risk-high)] bg-white p-4"
  >
    <p className="text-sm font-semibold text-[color:var(--color-risk-high)]">
      {title}
    </p>
    {detail ? (
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs text-[color:var(--color-steel)]">
        {detail}
      </pre>
    ) : null}
  </div>
);
