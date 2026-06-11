import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Plus, RefreshCw } from "lucide-react";
import { useT } from "@/lib/uiLanguage";

export const GenerateAllModal = ({
  totalCount,
  missingCount,
  onClose,
  onConfirm,
}: {
  totalCount: number;
  missingCount: number;
  onClose: () => void;
  onConfirm: (mode: "all" | "missing") => void;
}) => {
  const t = useT();
  const allDone = missingCount === 0;
  const handleConfirm = (mode: "all" | "missing") => {
    onConfirm(mode);
    onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm" >
        <DialogHeader>
          <DialogTitle>{allDone ? t("generateAll.regenerateAllTitle") : t("generateAll.generationModeTitle")}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {allDone
            ? t("generateAll.allDoneDesc", { n: totalCount })
            : t("generateAll.partialDesc", { done: totalCount - missingCount, total: totalCount })}
        </p>
        {!allDone && (
          <div className="space-y-2 mt-1">
            {[
              {
                mode: "missing" as const,
                Icon: Plus,
                title: t("generateAll.missingOnly", { n: missingCount }),
                desc: t("generateAll.keepExisting"),
              },
              {
                mode: "all" as const,
                Icon: RefreshCw,
                title: t("generateAll.regenerateAll", { n: totalCount }),
                desc: t("generateAll.replaceExisting"),
              },
            ].map((opt) => (
              <button
                key={opt.mode}
                onClick={() => handleConfirm(opt.mode)}
                className="w-full flex items-start gap-3 p-3 rounded-none border border-border text-left transition-colors hover:border-primary hover:bg-primary/5"
              >
                <opt.Icon
                  className="w-4 h-4 shrink-0 mt-0.5 text-muted-foreground"
                  strokeWidth={1.75}
                />
                <div>
                  <div className="text-sm font-semibold">{opt.title}</div>
                  <div className="text-caption text-muted-foreground mt-0.5">{opt.desc}</div>
                </div>
              </button>
            ))}
          </div>
        )}
        <DialogFooter>
          {allDone ? (
            <>
              <Button variant="ghost" className="text-sm h-9" onClick={onClose}>{t("common.cancel")}</Button>
              <Button className="text-sm h-9" onClick={() => handleConfirm("all")}>
                {t("generateAll.regenerateAllTitle")}
              </Button>
            </>
          ) : (
            <Button variant="ghost" className="text-sm h-9" onClick={onClose}>{t("common.cancel")}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
