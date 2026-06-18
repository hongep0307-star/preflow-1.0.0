/* 300MB 초과 영상 업로드 *선택* 다이얼로그.
 *
 * 대상 목록(파일명 + 현재 용량 → 처리 방식) + [변환 후 업로드] / [원본 업로드]
 * / [취소]. 처리는 부모(LibraryPage)가 다이얼로그를 닫고 백그라운드(진행
 * 토스트)로 진행한다 — 변환/업로드 중에도 라이브러리를 계속 쓸 수 있도록
 * 진행 표시는 이 다이얼로그가 아니라 토스트가 담당한다.
 *
 * 원본 상한(maxOriginalBytes, 보통 1GB)을 넘는 파일은 원본 저장이 불가하므로
 * 행 라벨에 "변환 필요" 로 표시하고, "원본 업로드" 를 눌러도 그 파일만큼은
 * 부모가 변환 경로로 돌린다.
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
  /** 원본 저장 절대 상한(보통 1GB). 이 값을 넘는 파일은 원본 업로드 불가. */
  maxOriginalBytes: number;
  onConfirm: () => void;
  onUploadOriginal: () => void;
  onCancel: () => void;
}

export function VideoConvertDialog({
  open,
  files,
  targetBytes,
  maxOriginalBytes,
  onConfirm,
  onUploadOriginal,
  onCancel,
}: VideoConvertDialogProps) {
  const { t } = useUiLanguage();
  const targetLabel = formatMB(targetBytes);
  // 전부 1GB 초과면 원본 업로드가 의미 없으므로 버튼 자체를 숨긴다.
  const anyUploadableAsOriginal = files.some((f) => f.size <= maxOriginalBytes);

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
            {files.map((f, i) => {
              const overMax = f.size > maxOriginalBytes;
              return (
                <li
                  key={`${f.name}-${i}`}
                  className="flex items-center justify-between gap-3 text-meta"
                >
                  <span className="truncate">{f.name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {formatMB(f.size)}
                    {overMax
                      ? ` → ${t("library.videoConvert.mustConvert")}`
                      : ` → ~${targetLabel} / ${t("library.videoConvert.orOriginal")}`}
                  </span>
                </li>
              );
            })}
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
          {anyUploadableAsOriginal ? (
            <Button
              variant="outline"
              className="h-8 px-3 text-meta"
              style={{ borderRadius: 0 }}
              onClick={onUploadOriginal}
            >
              {t("library.videoConvert.uploadOriginal")}
            </Button>
          ) : null}
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
