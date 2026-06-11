import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  /** Icon element rendered above the title (already sized — recommended w-10 h-10). */
  icon?: ReactNode;
  title: string;
  /** Optional secondary line shown beneath the title. */
  description?: string;
  /** Optional action area (button, link). */
  action?: ReactNode;
  className?: string;
  /** Use compact spacing for narrow panels (history sidebar, etc.). */
  compact?: boolean;
}

/**
 * Unified empty-state visual: vertically centered icon + title + (optional)
 * description + (optional) action. Used so every "no items yet" surface
 * matches the same rhythm and color tokens.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  compact = false,
}: EmptyStateProps) {
  return (
    <div
      role="status"
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-1.5 py-6" : "min-h-[240px] gap-2 py-10",
        className,
      )}
    >
      {icon ? (
        <div className={cn("text-border", compact ? "mb-1" : "mb-2")}>{icon}</div>
      ) : null}
      <p className={cn("text-foreground/80", compact ? "text-xs" : "text-sm font-medium")}>
        {title}
      </p>
      {description ? (
        <p
          className={cn(
            "text-muted-foreground/70",
            compact ? "text-2xs" : "text-xs mt-0.5",
          )}
        >
          {description}
        </p>
      ) : null}
      {action ? <div className={compact ? "mt-1" : "mt-3"}>{action}</div> : null}
    </div>
  );
}
