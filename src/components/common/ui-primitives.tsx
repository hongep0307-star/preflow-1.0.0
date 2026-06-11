import { useState, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import { HelpCircle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/uiLanguage";

type Tone = "default" | "active" | "success" | "warning";

const metaPillClass = (tone: Tone = "default", className?: string) =>
  cn(
    "meta-pill",
    tone === "active" && "meta-pill-active",
    tone === "success" && "border-success/40 bg-success/10 text-success",
    tone === "warning" && "border-warning/40 bg-warning/10 text-warning",
    className,
  );

export const MetaPill = ({
  tone = "default",
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) => (
  <span className={metaPillClass(tone, className)} {...props} />
);

export const SurfacePanel = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("surface-panel rounded-none", className)} {...props} />
);

export const SectionLabel = ({ className, ...props }: HTMLAttributes<HTMLSpanElement>) => (
  <span
    className={cn(
      "mb-3 block font-mono text-2xs uppercase tracking-[0.2em] text-muted-foreground",
      className,
    )}
    {...props}
  />
);

export const HelpTooltip = ({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) => {
  const [open, setOpen] = useState(false);
  const t = useT();

  return (
    <Tooltip open={open}>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-4 w-4 items-center justify-center rounded-full border border-border-subtle text-2xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary",
            className,
          )}
          aria-label={t("common.moreInfo")}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          onFocus={() => setOpen(false)}
          onClick={(event) => event.preventDefault()}
        >
          <HelpCircle className="h-3 w-3" strokeWidth={1.75} />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[260px] rounded-none border-border-subtle bg-popover text-caption leading-relaxed text-popover-foreground">
        {children}
      </TooltipContent>
    </Tooltip>
  );
};

export const ModalTitle = ({
  icon,
  children,
  help,
  className,
}: {
  icon?: ReactNode;
  children: ReactNode;
  help?: ReactNode;
  className?: string;
}) => (
  <div className={cn("flex items-center gap-2 text-title font-semibold text-foreground", className)}>
    {icon}
    <span>{children}</span>
    {help && <HelpTooltip>{help}</HelpTooltip>}
  </div>
);

export const ModalActions = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />
);

export const OverlayActionButton = ({
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button
    className={cn(
      "inline-flex h-8 items-center gap-1.5 rounded-none px-3 text-xs text-muted-foreground transition-colors hover:bg-surface-panel hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
      className,
    )}
    {...props}
  />
);
