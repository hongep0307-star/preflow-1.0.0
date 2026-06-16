/* 300MB 초과 영상 일괄 변환 *확인* 다이얼로그.
 *
 * 변환 대상 목록(파일명 + 현재 용량 → 목표 용량) + [변환 후 업로드] / [취소].
 * "변환 후 업로드" 를 누르면 부모(LibraryPage)가 다이얼로그를 닫고 변환을
 * 백그라운드(진행 토스트)로 진행한다 — 변환 중에도 라이브러리를 계속 쓸 수
 * 있도록 진행 표시는 이 다이얼로그가 아니라 토스트가 담당한다.
 */
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useUiLanguage } from "@/lib/uiLanguage";

function formatMB(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

interface VideoConvertDialogProps {
  open: boolean;
  files: File[];
  targetBytes: number;
  onConfirm: () => void;
  onCancel: () => void;
}

export function VideoConvertDialog({
  open,
  files,
  targetBytes,
  onConfirm,
  onCancel,
}: VideoConvertDialogProps) {
  const { t } = useUiLanguage();
  const targetLabel = formatMB(targetBytes);

  const handleOpenChange = (next: boolean) => {
    if (!next) onCancel();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t("library.videoConvert.title")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-caption text-muted-foreground">
            {t("library.videoConvert.desc", { n: files.length, target: targetLabel })}
          </p>
          <ul className="max-h-48 space-y-1 overflow-y-auto">
            {files.map((f, i) => (
              <li
                key={`${f.name}-${i}`}
                className="flex items-center justify-between gap-3 text-meta"
              >
                <span className="truncate">{f.name}</span>
                <span className="shrink-0 text-muted-foreground">
                  {formatMB(f.size)} → ~{targetLabel}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            className="h-8 px-3 text-meta"
            style={{ borderRadius: 0 }}
            onClick={onCancel}
          >
            {t("library.videoConvert.cancel")}
          </Button>
          <Button
            className="h-8 px-3 text-meta"
            style={{ borderRadius: 0 }}
            onClick={onConfirm}
          >
            {t("library.videoConvert.convertAll")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
