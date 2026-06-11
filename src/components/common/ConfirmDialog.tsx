import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/lib/uiLanguage";

/**
 * In-app confirmation dialog — a styled replacement for the native
 * `window.confirm`. Uses the shared shadcn `Dialog` so it matches every
 * other modal in the app (dark card, square corners) instead of the OS
 * "preflow-dev" browser popup.
 *
 * Controlled: render with `open` and provide `onConfirm` / `onCancel`.
 * The dialog does NOT auto-close on confirm — the caller closes it by
 * flipping `open` (typically by clearing the confirm state), which keeps
 * the close timing in one place and lets async confirm handlers run.
 */
export const ConfirmDialog = ({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  destructive = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  /** Defaults to the generic "Confirm" label. */
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button for destructive actions (e.g. delete). */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) => {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{title ?? t("common.confirm")}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line">
          {message}
        </p>
        <DialogFooter className="gap-2 sm:justify-end sm:space-x-0">
          <Button variant="ghost" className="h-9 text-sm" onClick={onCancel}>
            {cancelLabel ?? t("common.cancel")}
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            className="h-9 px-4 text-sm"
            onClick={onConfirm}
          >
            {confirmLabel ?? t("common.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
