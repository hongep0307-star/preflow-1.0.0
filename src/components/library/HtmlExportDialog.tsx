import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { exportPackAsHtml } from "@/lib/preflowPackClient";
import type { HtmlExportFormat, PackScope } from "@/lib/preflowPack";
import { useToast } from "@/hooks/use-toast";
import { useUiLanguage } from "@/lib/uiLanguage";
import { formatBytes } from "@/lib/storageMaintenance";

/* single-html 은 모든 미디어를 base64(4/3 오버헤드)로 인라인 + 뷰어 셸
 *  (~600KB). 합산 file_size 로 결과 용량을 사전 추정한다. */
const SINGLE_HTML_SHELL_BYTES = 600 * 1024;
const SINGLE_HTML_LIMIT_BYTES = 200 * 1024 * 1024;
function estimateSingleHtmlBytes(totalFileBytes: number): number {
  return Math.round(totalFileBytes * (4 / 3)) + SINGLE_HTML_SHELL_BYTES;
}

/**
 * HTML Viewer Export 다이얼로그.
 *
 * .preflowlib 와 달리 받는 사람이 앱 없이 **그냥 더블클릭**해 보는 정적
 * 뷰어 패키지를 만든다. 두 포맷 — ZIP 묶음 / 단일 HTML — 모두 같은 뷰어
 * 번들을 쓰지만 미디어 배치만 다르다.
 *
 * ExportPackDialog 와 거의 같은 props/흐름이지만 다음이 다르다:
 *   - includeFiles 토글이 없다(원본 미포함이면 viewer 가 아무것도 못 보여줌)
 *   - projectId scope (projectLinked) 는 받지 않는다(공유 시나리오 아님)
 *   - viewer 헤더 제목(title) 입력 1줄 추가
 *   - 포맷 라디오 (ZIP / single-html)
 */

interface HtmlExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: Exclude<PackScope, "projectLinked">;
  scopeLabel: string;
  ids?: string[];
  folderTag?: string;
  itemCount: number;
  /** 범위 내 아이템 file_size 합(바이트) — single-html 용량 사전 표기용. */
  sizeBytes?: number;
  /** 뷰어 폴더 트리를 한정할 폴더 경로 목록(다중 폴더 선택 또는 선택 export 시). */
  folderScope?: string[];
}

export function HtmlExportDialog({
  open,
  onOpenChange,
  scope,
  scopeLabel,
  ids,
  folderTag,
  itemCount,
  sizeBytes,
  folderScope,
}: HtmlExportDialogProps) {
  const { toast } = useToast();
  const { t, language } = useUiLanguage();
  const [format, setFormat] = useState<HtmlExportFormat>("zip");
  const [includeSubfolders, setIncludeSubfolders] = useState(true);
  const [viewerTitle, setViewerTitle] = useState(scopeLabel);
  const [packName, setPackName] = useState(scopeLabel);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setFormat("zip");
      setIncludeSubfolders(true);
      setViewerTitle(scopeLabel);
      setPackName(scopeLabel);
    }
  }, [open, scopeLabel]);

  /* single-html 예상 용량 — 합산 file_size 가 있을 때만 실측 추정. 200MB
   *  초과면 경고 톤 + ZIP 권장. (sizeBytes 부재 시 표기 생략.) */
  const estimatedBytes = useMemo(
    () => (typeof sizeBytes === "number" ? estimateSingleHtmlBytes(sizeBytes) : null),
    [sizeBytes],
  );
  const estimatedLabel = estimatedBytes !== null ? formatBytes(estimatedBytes) : null;
  const overLimit = estimatedBytes !== null && estimatedBytes > SINGLE_HTML_LIMIT_BYTES;
  const showSingleHtmlWarning = format === "single-html" && overLimit;

  const description = useMemo(
    () =>
      t("htmlExport.description", {
        n: itemCount.toLocaleString(),
        s: itemCount === 1 ? "" : "s",
        scope: scopeLabel,
      }),
    [itemCount, scopeLabel, t],
  );

  const runExport = async () => {
    setBusy(true);
    try {
      const hasFolderScope = (folderScope?.length ?? 0) > 0;
      const result = await exportPackAsHtml({
        scope,
        ids,
        folderTag,
        // folder scope export 또는 다중 폴더 선택 export 에서 하위폴더 포함 여부를 전달.
        includeSubfolders: scope === "folder" || hasFolderScope ? includeSubfolders : undefined,
        suggestedName: packName,
        title: viewerTitle,
        format,
        language,
        folderScope,
      });
      if (result.canceled) return;
      toast({
        title: t("library.toast.htmlExported"),
        description: result.saved_path
          ? t("library.toast.htmlExportedDescPath", {
              n: result.item_count,
              path: result.saved_path,
            })
          : t("library.toast.htmlExportedDesc", { n: result.item_count }),
      });
      if (result.skipped.length > 0) {
        toast({
          title: t("library.toast.someFilesSkipped"),
          description: t("library.toast.missingFilesReported", {
            n: result.skipped.length,
          }),
        });
      }
      onOpenChange(false);
    } catch (err) {
      toast({
        variant: "destructive",
        title: t("library.toast.exportFailed"),
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t("htmlExport.title")}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="mb-1 block text-caption font-mono text-muted-foreground">
              {t("htmlExport.viewerTitle")}
            </Label>
            <Input
              value={viewerTitle}
              onChange={(event) => setViewerTitle(event.target.value)}
              className="h-9 text-meta"
              placeholder={t("htmlExport.viewerTitlePlaceholder")}
            />
          </div>
          <div>
            <Label className="mb-1 block text-caption font-mono text-muted-foreground">
              {t("htmlExport.fileName")}
            </Label>
            <Input
              value={packName}
              onChange={(event) => setPackName(event.target.value)}
              className="h-9 text-meta"
            />
          </div>
          <div>
            <Label className="mb-2 block text-caption font-mono text-muted-foreground">
              {t("htmlExport.formatLabel")}
            </Label>
            <RadioGroup
              value={format}
              onValueChange={(v) => setFormat(v as HtmlExportFormat)}
              className="gap-2"
            >
              <div className="flex items-start gap-2">
                <RadioGroupItem id="html-export-format-zip" value="zip" className="mt-0.5" />
                <Label
                  htmlFor="html-export-format-zip"
                  className="cursor-pointer text-meta font-normal"
                >
                  <div>{t("htmlExport.formatZip")}</div>
                  <div className="mt-0.5 text-2xs text-muted-foreground">
                    {t("htmlExport.formatZipHint")}
                  </div>
                </Label>
              </div>
              <div className="flex items-start gap-2">
                <RadioGroupItem
                  id="html-export-format-single"
                  value="single-html"
                  className="mt-0.5"
                />
                <Label
                  htmlFor="html-export-format-single"
                  className="cursor-pointer text-meta font-normal"
                >
                  <div className="flex items-center gap-2">
                    <span>{t("htmlExport.formatSingleHtml")}</span>
                    {estimatedLabel ? (
                      <span
                        className={cn(
                          "font-mono text-2xs",
                          overLimit ? "text-amber-600" : "text-muted-foreground",
                        )}
                      >
                        {t("htmlExport.estimatedSize", { size: estimatedLabel })}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 text-2xs text-muted-foreground">
                    {t("htmlExport.formatSingleHtmlHint")}
                  </div>
                </Label>
              </div>
            </RadioGroup>
          </div>
          {scope === "folder" || (folderScope?.length ?? 0) > 0 ? (
            <label className="flex items-center gap-2 text-meta">
              {/* 다이얼로그 전체가 rounded-none 정책이라 Checkbox 의 기본
                  rounded-sm 도 0 으로 덮어쓴다. Checkbox 컴포넌트는
                  data-[state=checked]:bg-primary 라서 자동으로 테마의
                  primary(빨강) 색을 따라가 OS-기본 파란색이 사라진다. */}
              <Checkbox
                className="rounded-none"
                checked={includeSubfolders}
                onCheckedChange={(checked) => setIncludeSubfolders(checked === true)}
              />
              {t("htmlExport.includeSubfolders")}
            </label>
          ) : null}
          {showSingleHtmlWarning ? (
            <div
              className="border border-amber-500/40 bg-amber-500/10 p-3 text-caption text-amber-600"
              style={{ borderRadius: 0 }}
            >
              {t("htmlExport.tooLargeHint", { limit: formatBytes(SINGLE_HTML_LIMIT_BYTES) })}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            style={{ borderRadius: 0 }}
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t("common.cancel")}
          </Button>
          <Button
            style={{ borderRadius: 0 }}
            onClick={runExport}
            disabled={busy || itemCount === 0}
          >
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {t("htmlExport.saveButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
