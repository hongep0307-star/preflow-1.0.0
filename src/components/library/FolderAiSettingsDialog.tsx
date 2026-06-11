/**
 * FolderAiSettingsDialog (Phase D2)
 *
 * 폴더 우클릭 → "AI settings…" 가 여는 토글 2개짜리 작은 다이얼로그.
 * 저장은 `folderAiSettings` 영속 모듈이 책임 — 이 컴포넌트는 read/write
 * 와 dependency rule (autoApplyTags → autoClassify) 만 다룬다.
 *
 * Dependency rule:
 *   - autoApplyTags 는 autoClassify=false 일 때 의미가 없다. UI 상으론
 *     비활성(disabled) 으로 두고, 토글 값 자체는 사용자가 마지막에 켰던
 *     상태를 보존한다 — autoClassify 를 다시 켜면 그 자리 그대로 살아남게.
 *   - 저장은 사용자가 "Done" 을 눌렀을 때만 commit. Cancel 은 변경 폐기.
 */
import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/uiLanguage";
import {
  getFolderAiSettings,
  setFolderAiSettings,
  type FolderAiSettings,
} from "@/lib/folderAiSettings";

export interface FolderAiSettingsDialogProps {
  /** 다이얼로그가 열려 있는 동안 대상 폴더 path (`folder:` 접두 없는
   *  순수 path). null 이면 닫힘. */
  folderPath: string | null;
  onOpenChange: (open: boolean) => void;
}

export function FolderAiSettingsDialog({
  folderPath,
  onOpenChange,
}: FolderAiSettingsDialogProps) {
  const t = useT();
  const [draft, setDraft] = useState<FolderAiSettings>({
    autoClassify: false,
    autoApplyTags: false,
  });

  /* 다이얼로그가 열릴 때마다 현재 저장값을 다시 읽어 draft 초기화. 사용자가
     Cancel 후 다시 열면 변경 전 값으로 돌아간다. */
  useEffect(() => {
    if (!folderPath) return;
    setDraft(getFolderAiSettings(folderPath));
  }, [folderPath]);

  const commit = () => {
    if (!folderPath) return;
    setFolderAiSettings(folderPath, draft);
    onOpenChange(false);
  };

  /* autoClassify 가 꺼지면 autoApplyTags 도 자동으로 disabled 로 보이지만
     값 자체는 보존 — 사용자가 다시 켰을 때 마지막 의도가 복원된다. */
  const applyDisabled = !draft.autoClassify;

  return (
    <Dialog open={folderPath !== null} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-amber-400" aria-hidden />
            {t("library.folderAi.title")}
          </DialogTitle>
          <DialogDescription>
            {t("library.folderAi.subtitle", { path: folderPath ?? "" })}
          </DialogDescription>
        </DialogHeader>

        {folderPath ? (
          <div className="space-y-3 py-1">
            <div className="rounded-none border border-border-subtle bg-surface-panel px-2.5 py-2 text-caption">
              <div className="text-muted-foreground">
                {t("library.folderAi.folderPathLabel")}
              </div>
              <div className="truncate font-mono text-meta text-text-secondary">
                {folderPath}
              </div>
            </div>

            <label className="flex items-start justify-between gap-3 rounded-none border border-border-subtle bg-surface-panel px-3 py-2.5">
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="text-meta font-medium text-foreground">
                  {t("library.folderAi.autoClassify")}
                </div>
                <p className="text-caption text-muted-foreground">
                  {t("library.folderAi.autoClassifyDesc")}
                </p>
              </div>
              <Switch
                checked={draft.autoClassify}
                onCheckedChange={(checked) =>
                  setDraft((prev) => ({ ...prev, autoClassify: checked }))
                }
                className="mt-0.5 shrink-0"
              />
            </label>

            <label
              className={cn(
                "flex items-start justify-between gap-3 rounded-none border border-border-subtle bg-surface-panel px-3 py-2.5 transition-opacity",
                applyDisabled && "opacity-60",
              )}
            >
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="text-meta font-medium text-foreground">
                  {t("library.folderAi.autoApplyTags")}
                </div>
                <p className="text-caption text-muted-foreground">
                  {t("library.folderAi.autoApplyTagsDesc")}
                </p>
                {applyDisabled ? (
                  <p className="pt-0.5 text-2xs italic text-muted-foreground">
                    {t("library.folderAi.requiresAutoClassify")}
                  </p>
                ) : null}
              </div>
              <Switch
                checked={draft.autoApplyTags}
                disabled={applyDisabled}
                onCheckedChange={(checked) =>
                  setDraft((prev) => ({ ...prev, autoApplyTags: checked }))
                }
                className="mt-0.5 shrink-0"
              />
            </label>
          </div>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            style={{ borderRadius: 0 }}
            onClick={() => onOpenChange(false)}
          >
            {t("common.cancel")}
          </Button>
          <Button style={{ borderRadius: 0 }} onClick={commit}>
            {t("common.done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
