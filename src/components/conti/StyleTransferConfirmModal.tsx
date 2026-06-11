import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { ModalTitle } from "@/components/common/ui-primitives";
import { useT } from "@/lib/uiLanguage";

export const StyleTransferConfirmModal = ({
  styleName,
  styleThumb,
  sceneCount,
  selectedCount,
  onClose,
  onConfirm,
}: {
  styleName: string;
  styleThumb: string | null;
  sceneCount: number;
  selectedCount: number;
  onClose: () => void;
  onConfirm: (mode: "all" | "selected") => void;
}) => {
  const t = useT();

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg" >
        <DialogHeader>
          <DialogTitle asChild>
            <ModalTitle help={t("conti.styleTransferHelp")}>
              {t("conti.styleTransfer")}
            </ModalTitle>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {/* Preset style info */}
          <div className="flex w-full items-center gap-3 p-3 rounded-none border border-border bg-background">
            {styleThumb ? (
              <img src={styleThumb} className="w-16 h-10 object-cover shrink-0"  loading="lazy" decoding="async" />
            ) : (
              <div className="w-16 h-10 bg-muted shrink-0 flex items-center justify-center" >
                <SlidersHorizontal className="w-4 h-4 text-muted-foreground" />
              </div>
            )}
            <div className="min-w-0">
              <div className="text-sm font-semibold text-foreground truncate">{styleName}</div>
              <div className="text-caption text-muted-foreground">{t("conti.selectedStyle")}</div>
            </div>
          </div>

          <p className="text-sm text-muted-foreground leading-relaxed">
            {selectedCount > 0
              ? t("conti.transferSelectedOrAll", { selected: selectedCount, total: sceneCount })
              : t("conti.transferAllScenes", { total: sceneCount })}
          </p>
        </div>
        <DialogFooter className="gap-2 sm:flex-row sm:flex-wrap sm:justify-end sm:space-x-0">
          <Button variant="ghost" className="text-sm h-9" onClick={onClose}>{t("common.cancel")}</Button>
          <Button
            variant="outline"
            className="h-9 px-4 gap-1.5 text-sm"
            style={{ color: "hsl(var(--muted-foreground))", borderColor: "hsl(var(--border))" }}
            onClick={() => { onConfirm("all"); onClose(); }}
          >
            {t("conti.transferAll", { count: sceneCount })}
          </Button>
          {selectedCount > 0 && (
            <Button
              className="h-9 px-4 gap-1.5 text-sm"
              onClick={() => { onConfirm("selected"); onClose(); }}
            >
              {t("conti.selectedCount", { count: selectedCount })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
