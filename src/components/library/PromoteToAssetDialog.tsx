import { useEffect, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  promoteReferenceToAsset,
  buildPromotedAssetRecord,
  recordReferencePromotion,
  enqueuePendingPromote,
  urlToVisionBase64,
  urlToStorageImageBase64,
  type PromoteAssetType,
  type ReferenceItem,
} from "@/lib/referenceLibrary";
import { getCachedActiveId } from "@/lib/workspaceClient";
import { analyzeForPromote, type PromoteAnalysis } from "@/components/assets/vision";
import { useT } from "@/lib/uiLanguage";

/** AI 추천 태그명. `ai_suggestions.asset_candidate` 는 "에셋 후보 여부/이유" 를
 *  담는 서술형 문장이라 태그명으로는 부적합(과거엔 이걸 그대로 써서 한 문장이
 *  통째로 들어갔음). 짧은 `suggested_tags[0]` → 없으면 제목으로 폴백하고,
 *  멘션 토큰이므로 공백은 _ 로, 길이는 40자로 제한한다. */
const deriveTagName = (reference: ReferenceItem): string => {
  const sugg = (reference.ai_suggestions as { suggested_tags?: unknown } | null | undefined)?.suggested_tags;
  const firstTag = Array.isArray(sugg)
    ? sugg.find((s): s is string => typeof s === "string" && s.trim().length > 0)
    : undefined;
  const base = (firstTag || reference.title || "asset").trim().replace(/^@/, "");
  return base.replace(/\s+/g, "_").slice(0, 40) || "asset";
};

// Assets 탭의 하위 탭 순서(캐릭터 / 아이템 / 배경)와 동일하게 맞춘다.
const ASSET_TYPE_KEYS: Array<{ id: PromoteAssetType; labelKey: string; hintKey: string }> = [
  { id: "character", labelKey: "library.promoteToAsset.types.character.label", hintKey: "library.promoteToAsset.types.character.hint" },
  { id: "item", labelKey: "library.promoteToAsset.types.item.label", hintKey: "library.promoteToAsset.types.item.hint" },
  { id: "background", labelKey: "library.promoteToAsset.types.background.label", hintKey: "library.promoteToAsset.types.background.hint" },
];

interface PromoteToAssetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reference: ReferenceItem | null;
  /** 어느 프로젝트의 자산으로 만들지. Library 페이지에서 returnTo 가 project URL
   *  이어야만 활성화되므로, null 일 때는 진입 자체가 막혀있다 — 이중 안전장치. */
  projectId: string | null;
  /** 대상 프로젝트가 속한 워크스페이스. 현재 활성 워크스페이스와 다르면 에셋을
   *  즉시 insert 할 수 없어(FK 실패) 큐에 적재 후 전환한다. */
  targetWorkspaceId?: string | null;
  onCompleted?: (result: { assetId: string; reference: ReferenceItem; assetType: PromoteAssetType }) => void;
}

export function PromoteToAssetDialog({
  open,
  onOpenChange,
  reference,
  projectId,
  targetWorkspaceId,
  onCompleted,
}: PromoteToAssetDialogProps) {
  const [assetType, setAssetType] = useState<PromoteAssetType>("character");
  const [tagName, setTagName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<PromoteAnalysis | null>(null);
  const t = useT();

  const descForType = (a: PromoteAnalysis | null, type: PromoteAssetType): string => {
    if (!a) return "";
    return type === "character" ? a.outfit : type === "item" ? a.item_description : a.space_description;
  };

  // 매번 reference 가 바뀔 때마다 폼을 초기화 + AI 통합 1콜로 타입 추천/설명 채움.
  useEffect(() => {
    if (!open || !reference) return;
    setError(null);
    setAnalysis(null);
    setTagName(deriveTagName(reference));
    setDescription(reference.notes ?? "");
    setAssetType("character");

    const src = reference.thumbnail_url || reference.file_url;
    if (!src) return;
    let cancelled = false;
    setAnalyzing(true);
    (async () => {
      try {
        const { base64, mediaType } = await urlToVisionBase64(src);
        const result = await analyzeForPromote(base64, mediaType);
        if (cancelled) return;
        setAnalysis(result);
        setAssetType(result.asset_type);
        // 사용자가 아직 손대기 전이면 추천 설명으로 채움(노트가 없을 때만 덮어씀).
        setDescription((prev) => (prev && prev.trim() ? prev : descForType(result, result.asset_type)));
      } catch (e) {
        /* 분석 실패 — 기본값(character) 유지, 사용자가 수동 입력.
           원인 추적을 위해 메시지는 남긴다(과거 무음 catch 로 진단이 어려웠음). */
        console.error("[promote-analyze] failed:", (e as Error)?.message ?? e);
      } finally {
        if (!cancelled) setAnalyzing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, reference]);

  if (!reference) return null;

  // 정지 이미지이거나 썸네일이 있으면 승격 가능(gif/video/link/youtube → 썸네일 사용).
  const hasUsableImage =
    reference.kind === "image" || reference.kind === "webp" || Boolean(reference.thumbnail_url);
  const blockedReason = !hasUsableImage
    ? t("library.promoteToAsset.blockedNotImage")
    : !(reference.thumbnail_url || reference.file_url)
      ? t("library.promoteToAsset.blockedNoFile")
      : !projectId
        ? t("library.promoteToAsset.blockedNoProject")
        : null;

  const handleConfirm = async () => {
    if (!reference || !projectId) return;
    setSubmitting(true);
    setError(null);
    try {
      // 대상 프로젝트가 다른 워크스페이스면 활성 DB 에 곧바로 insert 할 수 없다
      // (assets.project_id FK 가 그 DB 에 없는 프로젝트를 가리켜 실패). 이 경우엔
      // reference 추적 메타만 지금(소스 워크스페이스) 갱신하고, 에셋 row 는 큐에
      // 적재한다 → onCompleted 가 워크스페이스 전환을 트리거하고, 전환 후
      // AssetsTab 이 큐를 drain 해 올바른 DB 에 insert 한다.
      const crossWorkspace = Boolean(targetWorkspaceId) && targetWorkspaceId !== getCachedActiveId();
      if (crossWorkspace) {
        const record = buildPromotedAssetRecord({ reference, projectId, assetType, tagName, description });
        // 스토리지는 워크스페이스별로 분리돼 있어 라이브러리 photo_url 은 프로젝트
        // 워크스페이스에서 깨진다. 라이브러리가 활성인 지금 이미지 바이트를 실어
        // 두면 drain 시점에 프로젝트 스토리지로 업로드된다.
        try {
          const { base64, mediaType } = await urlToStorageImageBase64(record.photo_url);
          record.photo_base64 = base64;
          record.photo_media_type = mediaType;
        } catch {
          /* 캡처 실패 시 원본 URL 로 폴백(깨질 수 있음) */
        }
        let updatedRef = reference;
        try {
          updatedRef = await recordReferencePromotion(reference, record.id);
        } catch {
          /* 추적 메타는 best-effort */
        }
        enqueuePendingPromote(projectId, record);
        onCompleted?.({ assetId: record.id, reference: updatedRef, assetType });
        onOpenChange(false);
        return;
      }
      const result = await promoteReferenceToAsset({
        reference,
        projectId,
        assetType,
        tagName,
        description,
      });
      onCompleted?.({ ...result, assetType });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="2xl">
        <DialogHeader>
          <DialogTitle>{t("library.promoteToAsset.title")}</DialogTitle>
          <DialogDescription>
            {t("library.promoteToAsset.descriptionShort")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-[120px_minmax(0,1fr)] items-start gap-4">
          <div className="aspect-square overflow-hidden border border-border-subtle bg-muted/30" style={{ borderRadius: 0 }}>
            {reference.thumbnail_url || reference.file_url ? (
              <img
                src={reference.thumbnail_url || reference.file_url || ""}
                alt={reference.title}
                className="h-full w-full object-cover"
              />
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Badge variant="outline" className="rounded-none text-2xs">{reference.kind}</Badge>
            <div className="line-clamp-2 text-body font-semibold">{reference.title}</div>
          </div>
        </div>

        {blockedReason ? (
          <div className="border border-amber-500/40 bg-amber-500/10 p-3 text-meta text-amber-500" style={{ borderRadius: 0 }}>
            {blockedReason}
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <Label className="mb-2 flex items-center gap-1.5 text-2xs font-mono tracking-[0.12em] text-muted-foreground">
                {t("library.promoteToAsset.labels.assetType")}
                {analyzing ? (
                  <span className="inline-flex items-center gap-1 text-2xs normal-case tracking-normal">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {t("library.promoteToAsset.analyzing")}
                  </span>
                ) : analysis ? (
                  <Badge
                    variant="outline"
                    className="rounded-none border-primary/50 bg-primary/12 text-micro font-semibold text-primary"
                  >
                    <Sparkles className="mr-1 h-2.5 w-2.5" />
                    {t("library.promoteToAsset.aiSuggested")}
                  </Badge>
                ) : null}
              </Label>
              <div className="grid grid-cols-3 gap-2">
                {ASSET_TYPE_KEYS.map((option) => {
                  const active = option.id === assetType;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => {
                        setAssetType(option.id);
                        // 통합분석 캐시가 있으면 해당 타입 설명으로 즉시 교체(추가 호출 없음).
                        if (analysis) setDescription(descForType(analysis, option.id));
                      }}
                      className={cn(
                        "flex flex-col items-start gap-1 border bg-surface-panel px-3 py-2 text-left transition",
                        active ? "border-primary/80 shadow-[0_0_0_1px_hsl(var(--primary)/0.35)]" : "border-border-subtle hover:border-primary/40",
                      )}
                      style={{ borderRadius: 0 }}
                    >
                      <span className="text-meta font-semibold">{t(option.labelKey)}</span>
                      <span className="w-full overflow-hidden text-ellipsis whitespace-nowrap text-2xs leading-snug text-muted-foreground">{t(option.hintKey)}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <Label htmlFor="promote-tag-name" className="mb-1.5 block text-2xs font-mono tracking-[0.12em] text-muted-foreground">
                {t("library.promoteToAsset.labels.assetTagName")}
              </Label>
              <Input
                id="promote-tag-name"
                value={tagName}
                onChange={(event) => setTagName(event.target.value)}
                maxLength={40}
                className="h-9 rounded-none text-meta"
                placeholder={t("library.promoteToAsset.placeholders.tagName")}
              />
              <p className="mt-1 text-2xs text-muted-foreground">
                {t("library.promoteToAsset.tagHintShort")}<span className="font-mono">@{tagName.trim() || t("library.promoteToAsset.tagFallbackName")}</span>
              </p>
            </div>

            <div>
              <Label htmlFor="promote-description" className="mb-1.5 block text-2xs font-mono tracking-[0.12em] text-muted-foreground">
                {assetType === "background" ? t("library.promoteToAsset.labels.spaceDescription") : assetType === "item" ? t("library.promoteToAsset.labels.itemDescription") : t("library.promoteToAsset.labels.notesOptional")}
              </Label>
              <Textarea
                id="promote-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={assetType === "background" ? t("library.promoteToAsset.placeholders.background") : assetType === "item" ? t("library.promoteToAsset.placeholders.item") : t("library.promoteToAsset.placeholders.notes")}
                className="min-h-[80px] rounded-none text-meta"
              />
            </div>

            {error ? (
              <div className="border border-destructive/40 bg-destructive/10 p-3 text-meta text-destructive" style={{ borderRadius: 0 }}>
                {error}
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" className="h-9 rounded-none px-4 text-meta" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button
            className="h-9 gap-1.5 rounded-none px-5 text-meta"
            onClick={handleConfirm}
            disabled={submitting || Boolean(blockedReason) || !tagName.trim()}
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {t("library.promoteToAsset.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
