import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  BookmarkPlus,
  BoxSelect,
  Camera,
  Check,
  CheckCircle2,
  ExternalLink,
  Film,
  Image as ImageIcon,
  Info,
  Library,
  Link2,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Sparkles,
  Star,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PLAYBACK_RATE_OPTIONS } from "@/components/library/LibraryPreviewPanel";
import { cn } from "@/lib/utils";
import { youtubeEmbedUrl } from "@/lib/youtube";
import { useT, useUiLanguage } from "@/lib/uiLanguage";
import {
  getAiOutputLanguageMode,
  getAiTagLanguageMode,
  resolveAiOutputLanguage,
  resolveAiTagLanguage,
  setAiOutputLanguageMode,
  subscribeAiOutputLanguage,
  type AiOutputLanguageMode,
  type AiTagLanguageMode,
} from "@/lib/aiOutputLanguage";
import type { LibraryFolderRow } from "@/components/library/LibrarySidebar";
import { withReferenceVersion, type ReferenceItem } from "@/lib/referenceLibrary";
import { docExtensionTag, docHueClasses, docPresentationOf } from "@/lib/docPresentation";
import { resolveTypeLabel } from "@/lib/linkPlatform";
import { friendlyClassifyError, type ClassifyProgress, type ClassifyStage, type ReferenceAiSuggestions } from "@/lib/referenceAi";
import type { ExtractedFrame } from "@/lib/videoFrames";

function formatDuration(value?: number | null): string {
  if (!value || !Number.isFinite(value)) return "00:00";
  const total = Math.max(0, Math.floor(value));
  const minutes = Math.floor(total / 60).toString().padStart(2, "0");
  const seconds = (total % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatBytes(value: number | null | undefined, unknownLabel: string): string {
  if (!value || !Number.isFinite(value)) return unknownLabel;
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

function formatDateTime(value: string | null | undefined, unknownLabel: string): string {
  if (!value) return unknownLabel;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return unknownLabel;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatDimensions(width: number | null | undefined, height: number | null | undefined, unknownLabel: string): string {
  if (!width || !height) return unknownLabel;
  return `${width} x ${height}`;
}

/* Info / AI 두 탭 — 사용자 선택을 새로고침에도 보존하기 위한 가벼운
 * localStorage 영속 hook. 키 충돌 방지를 위해 preflow.library 네임스페이스
 * 사용. SSR 환경(window 없음) 에서는 기본값으로 폴백. */
type InspectorTab = "info" | "ai";
const INSPECTOR_TAB_STORAGE_KEY = "preflow.library.inspectorTab";

function readStoredInspectorTab(): InspectorTab {
  if (typeof window === "undefined") return "info";
  try {
    const raw = window.localStorage.getItem(INSPECTOR_TAB_STORAGE_KEY);
    return raw === "ai" ? "ai" : "info";
  } catch {
    return "info";
  }
}

function writeStoredInspectorTab(value: InspectorTab): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(INSPECTOR_TAB_STORAGE_KEY, value);
  } catch {
    /* localStorage quota / private mode — silent. */
  }
}

interface LibraryInspectorProps {
  selected: ReferenceItem | null;
  selectedItems?: ReferenceItem[];
  hideMediaPreview?: boolean;
  selectedHiddenByFilters: boolean;
  selectedDuplicateCount: number;
  /** 선택이 비어 있을 때 우측 사이드바 빈자리에 보여줄 *현재 스코프* 요약.
   *  값이 모두 들어와 있으면 다중 선택 패널과 같은 형식으로 항목 수/총 용량을
   *  Properties 격자에 그린다. 없으면 기존 안내 문구로 폴백. */
  scopeLabel?: string;
  scopeItemCount?: number;
  scopeTotalSize?: number;
  /** 이 자료가 현재 몇 개의 (프로젝트, target) 쌍에 연결돼 있는지. 0 이면 표시 안 함. */
  selectedUsageCount?: number;
  /** LS 스캔 (Brief 드래프트 + Conti Compare Library) 으로 얻은 사용 위치
   *  (cross-workspace 포함). 비어 있으면 패널 자체를 숨김. `title` 은
   *  recentProjectsCache 에 없으면 undefined — 그 경우 fallback 으로
   *  짧은 id 일부 표시. `target` 으로 "· 브리프 ·" / "· 콘티 ·" 라벨
   *  분기를 한다. 같은 프로젝트의 두 target 양쪽에 들어 있는 자료는
   *  두 줄로 표시된다 (projectId × target 키 단위). */
  selectedUsageLocations?: Array<{
    projectId: string;
    title?: string;
    workspaceId?: string;
    count: number;
    target: "brief" | "conti" | "asset";
    /** target="asset" 일 때 distinct asset_type 목록(character|item|background). */
    assetTypes?: string[];
  }>;
  /** 사용 위치 뱃지 클릭 — 해당 프로젝트의 탭(brief/storyboard/assets)으로 이동. */
  onOpenUsageLocation?: (
    projectId: string,
    workspaceId: string | undefined,
    target: "brief" | "conti" | "asset",
    assetType?: string | null,
  ) => void;
  /** 이 자료가 현재 몇 개의 프로젝트 에셋으로 승격돼 있는지(LS 기준, cross-
   *  workspace 안전). Promote 버튼의 "N개 생성됨" 뱃지에 사용 — 프로젝트 쪽에서
   *  에셋이 삭제되면 줄어든다. (DB 의 promoted_asset_ids 는 stale 할 수 있어 미사용) */
  selectedPromotedAssetCount?: number;
  selectedSuggestions?: Partial<ReferenceAiSuggestions>;
  videoRef: RefObject<HTMLVideoElement>;
  playbackRate: string;
  onPlaybackRateChange: (rate: string) => void;
  saving: boolean;
  aiBusy: boolean;
  /* AI 탭 진행 인디케이터 — 호출 중에만 sampling/analyzing 토글되고
     끝나면 ready/failed 로. 미전달 시 idle 로 폴백. */
  classifyStage?: ClassifyStage;
  /* 비디오 sampling 의 세부 진행 (frame 개수, 선택된 미리보기 등). null 이면
     stepper 가 idle 또는 status-only 모드로 동작. */
  classifyProgress?: ClassifyProgress | null;
  editTitle: string;
  editTags: string;
  editNotes: string;
  editRating: string;
  editSourceUrl: string;
  timestampText: string;
  onEditTitleChange: (value: string) => void;
  onEditTagsChange: (value: string) => void;
  onEditNotesChange: (value: string) => void;
  onEditRatingChange: (value: string) => void;
  onEditSourceUrlChange: (value: string) => void;
  onTimestampTextChange: (value: string) => void;
  onSaveMetadata: () => void;
  onToggleFavorite: () => void;
  onSetCover: () => void;
  onSaveFrame: () => void;
  /** v3 — region/frameIndex 인자 추가. Inspector 의 인라인 Add 행은 영상에서만
   *  사용되며 두 인자 모두 비워서 호출 → 부모가 timestampText + 현재
   *  video.currentTime 을 자동 사용. */
  onAddTimestampNote: (
    textOverride?: string,
    atOverride?: number,
    regionOverride?: import("@/lib/referenceLibrary").RegionRect,
    frameIndexOverride?: number,
  ) => void;
  /** 타임스탬프 노트 삭제 — Inspector 노트 행에 X 버튼이 호출. */
  onDeleteTimestampNote?: (noteId: string) => void;
  /** 타임스탬프 노트 본문 인라인 편집 — 노트 텍스트를 클릭해 편집 모드
   *  진입 후 Enter 로 호출. 빈 문자열로 호출하면 삭제로 폴백한다. */
  onEditTimestampNote?: (noteId: string, text: string) => void;
  onClassify: () => void;
  onAcceptSuggestions: () => void;
  onDelete: () => void;
  onRestoreSelected: () => void;
  onCopyText: (value: string, label: string) => void;
  /** 정지 이미지(image/webp) 자료에서만 정의되고, video/gif/URL 에서는
   *  undefined 로 내려와 버튼 자체가 렌더되지 않는다 — kind 게이팅은 부모
   *  (LibraryPage) 가 담당. */
  onPromoteToAsset?: () => void;
  onExportSelected?: () => void;
  /** 위 onPromoteToAsset 이 정의된 상태에서, 프로젝트 컨텍스트 부재 등 부수
   *  조건이 빠지면 false → 버튼 disable. */
  canPromoteToAsset: boolean;
  /* Eagle 픽셀 인터랙션을 위한 직접 콜백들 — editXxx 임시 상태를 거치지
     않고 즉시 updateReference 를 호출. (Tags/Folders chip add·remove,
     Rating 별 클릭, URL X 버튼) */
  availableFolders?: LibraryFolderRow[];
  onAddTag?: (tag: string) => void;
  onRemoveTag?: (tag: string) => void;
  onAddFolder?: (folderPath: string) => void;
  onRemoveFolder?: (folderPath: string) => void;
  onSetRating?: (rating: number | null) => void;
  onClearSourceUrl?: () => void;
  /** 타임스탬프 노트 행 클릭 시 호출 — LibraryPage 가 previewMode 를 켜고
   *  해당 anchor 로 큰 프리뷰를 자동 점프한다(이미 previewMode 면 즉시 점프).
   *  v3 — 영상은 atSec, GIF 는 frameIndex 를 사용. 둘 중 하나만 들어옴. */
  onJumpToTimestamp?: (atSec?: number, frameIndex?: number) => void;
}

export function LibraryInspector({
  selected,
  selectedItems = [],
  hideMediaPreview = false,
  selectedHiddenByFilters,
  selectedDuplicateCount,
  scopeLabel,
  scopeItemCount,
  scopeTotalSize,
  selectedUsageCount = 0,
  selectedUsageLocations = [],
  onOpenUsageLocation,
  selectedPromotedAssetCount = 0,
  selectedSuggestions,
  videoRef,
  playbackRate,
  onPlaybackRateChange,
  saving,
  aiBusy,
  classifyStage = "idle",
  classifyProgress = null,
  editTitle,
  editNotes,
  editRating,
  editSourceUrl,
  timestampText,
  onEditTitleChange,
  onEditNotesChange,
  onEditSourceUrlChange,
  onTimestampTextChange,
  onSaveMetadata,
  onToggleFavorite,
  onSetCover,
  onSaveFrame,
  onAddTimestampNote,
  onDeleteTimestampNote,
  onEditTimestampNote,
  onClassify,
  onAcceptSuggestions,
  onDelete,
  onRestoreSelected,
  onCopyText,
  onPromoteToAsset,
  onExportSelected,
  canPromoteToAsset,
  availableFolders = [],
  onAddTag,
  onRemoveTag,
  onAddFolder,
  onRemoveFolder,
  onSetRating,
  onClearSourceUrl,
  onJumpToTimestamp,
}: LibraryInspectorProps) {
  const t = useT();
  const [inspectorTab, setInspectorTabState] = useState<InspectorTab>(() => readStoredInspectorTab());
  const setInspectorTab = (value: InspectorTab) => {
    setInspectorTabState(value);
    writeStoredInspectorTab(value);
  };
  // 같은 윈도우 안 다른 인스펙터 인스턴스가 값을 바꾸면 그것도 따라가게.
  // 멀티 윈도우 / 멀티 탭 동기화는 storage 이벤트로.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== INSPECTOR_TAB_STORAGE_KEY) return;
      const next = event.newValue === "ai" ? "ai" : "info";
      setInspectorTabState(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const selectedRegularTags = selected?.tags.filter((tag) => !tag.startsWith("folder:") && !tag.startsWith("source:")) ?? [];
  const selectedFolderPaths = selected
    ? selected.tags.filter((tag) => tag.startsWith("folder:")).map((tag) => tag.replace(/^folder:/, ""))
    : [];
  /* 인스펙터(우측 사이드바) 미리보기 URL — 자료 종류별 정적/원본 우선순위.
   *
   *  GIF: 업로드 시점에 `extractStaticPosterFromImageFile()` 로 추출한
   *  정지 첫 프레임(poster.png) 이 `thumbnail_url` 에 들어 있다. 그리드
   *  카드에서는 호버 시 원본을 재생하지만, 우측 사이드바는 자료를 식별
   *  하는 "대표 썸네일" 자리이므로 자동 재생을 끄고 *정지 프레임만* 노출.
   *  레거시 업로드(썸네일 없음) 은 file_url 로 자연 폴백.
   *
   *  WebP: detectAnimatedRasterKind() 에서 ANIM 청크가 잡히면 kind 가
   *  "gif" 로 승격되므로, 이 분기에 도달하는 webp 는 정적이다. 원본
   *  화질을 보존하기 위해 file_url 을 먼저 사용한다(둘은 같은 파일).
   *
   *  Image / 기타: 정적 이미지의 thumbnail_url 은 file_url 과 동일하지만
   *  순서를 thumbnail 우선으로 두어 향후 별도 thumb 가 생겨도 자연스럽게
   *  반영되게 한다. 동일 규칙은 lib/referenceLibrary.ts 의
   *  `getReferencePreviewImageUrl()` 에 한 번 더 명문화돼 있다. */
  const selectedImagePreviewUrl = selected
    ? selected.kind === "gif"
      ? selected.thumbnail_url || selected.file_url || ""
      : selected.kind === "webp"
      ? selected.file_url || selected.thumbnail_url || ""
      : selected.thumbnail_url || selected.file_url || ""
    : "";
  const multiSelected = selectedItems.length > 1;
  const multiSize = selectedItems.reduce((sum, item) => sum + (item.file_size ?? 0), 0);
  /* Kinds 요약 — 툴바 Types 필터의 부모 카테고리(Image / WebP / GIF / Video /
     URL) 와 동일한 단위로 집계한다.
       - URL 계열 (kind=youtube + kind=link 의 모든 플랫폼) 은 "URL" 한 항목으로
         묶음 — multi-select 패널은 한눈에 보기 위한 요약이라 platform 별
         분해보다 Types 필터의 부모 카테고리 단위가 더 자연스럽다.
       - animated WebP (mime image/webp 지만 kind=gif 로 승격된 항목) 은 사용자
         시점에서 "WebP" 자료라 라벨 보정.
       - 출력 순서는 Types 필터와 동일한 시각 순서로 정렬해 일관성 유지. */
  const KIND_LABEL_ORDER = ["Image", "WebP", "GIF", "Video", "URL", "Document"] as const;
  type KindLabelId = typeof KIND_LABEL_ORDER[number] | "Item";
  const aggregateKindLabel = (item: ReferenceItem): KindLabelId => {
    if (item.kind === "youtube" || item.kind === "link") return "URL";
    if (item.kind === "doc") return "Document";
    if (item.kind === "gif" && item.mime_type === "image/webp") return "WebP";
    switch (item.kind) {
      case "image": return "Image";
      case "webp": return "WebP";
      case "gif": return "GIF";
      case "video": return "Video";
      default: return "Item";
    }
  };
  const kindLocalizedLabel = (id: KindLabelId): string => {
    switch (id) {
      case "Image": return t("library.inspector.kindImage");
      case "WebP": return t("library.inspector.kindWebp");
      case "GIF": return t("library.inspector.kindGif");
      case "Video": return t("library.inspector.kindVideo");
      case "URL": return t("library.inspector.kindUrl");
      case "Document": return t("library.inspector.kindDocument");
      default: return t("library.inspector.kindItem");
    }
  };
  const multiKinds = selectedItems.reduce<Record<string, number>>((acc, item) => {
    const label = aggregateKindLabel(item);
    acc[label] = (acc[label] ?? 0) + 1;
    return acc;
  }, {});
  const multiKindEntries = KIND_LABEL_ORDER
    .filter((label) => multiKinds[label] > 0)
    .map((label) => [label, multiKinds[label]] as const);
  const selectedActionItems = multiSelected ? selectedItems : selected ? [selected] : [];
  const allActionItemsTrashed = selectedActionItems.length > 0 && selectedActionItems.every((item) => Boolean(item.deleted_at));
  const deleteActionLabel = allActionItemsTrashed
    ? (multiSelected
        ? t("library.inspector.permDeleteN", { n: selectedActionItems.length })
        : t("library.inspector.permDeleteReference"))
    : (multiSelected
        ? t("library.inspector.moveNToTrash", { n: selectedActionItems.length })
        : t("library.inspector.moveReferenceToTrash"));
  const deleteDialogTitle = allActionItemsTrashed
    ? t("library.inspector.permDeleteTitle")
    : t("library.inspector.moveTrashTitle");
  const deleteDialogDescription = allActionItemsTrashed
    ? t("library.inspector.permDeleteDesc")
    : t("library.inspector.moveTrashDesc");

  return (
    <aside className="h-full min-h-0 overflow-y-auto border-l border-border-subtle bg-surface-sidebar">
      {multiSelected ? (
        <div className="p-5">
          <div className="border border-border-subtle bg-surface-panel p-4" style={{ borderRadius: 0 }}>
            <SectionLabel>{t("library.inspector.multiSelect")}</SectionLabel>
            <div className="mt-2 text-subhead font-semibold">{t("library.inspector.itemsSelected", { n: selectedItems.length })}</div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-caption text-muted-foreground">
              <div className="border border-border-subtle bg-background p-2" style={{ borderRadius: 0 }}>
                <div className="text-2xs text-muted-foreground">{t("library.inspector.totalSize")}</div>
                <div className="mt-1 font-mono text-foreground">{formatBytes(multiSize, t("common.unknown"))}</div>
              </div>
              <div className="border border-border-subtle bg-background p-2" style={{ borderRadius: 0 }}>
                <div className="text-2xs text-muted-foreground">{t("library.inspector.kinds")}</div>
                <div className="mt-1 font-mono text-foreground">
                  {multiKindEntries.map(([label, count]) => `${kindLocalizedLabel(label)}:${count}`).join(" / ")}
                </div>
              </div>
            </div>
            {!allActionItemsTrashed ? (
              <Button
                variant="secondary"
                className="mt-4 h-8 w-full text-meta"
                style={{ borderRadius: 0 }}
                onClick={onExportSelected}
              >
                {t("library.inspector.exportSelectedAsPack")}
              </Button>
            ) : null}
            {allActionItemsTrashed ? (
              <Button variant="outline" className="mt-4 h-8 w-full gap-2 text-meta" style={{ borderRadius: 0 }} onClick={onRestoreSelected}>
                <RotateCcw className="h-3.5 w-3.5" />
                {t("library.inspector.restoreNItems", { n: selectedActionItems.length })}
              </Button>
            ) : null}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" className="mt-2 h-8 w-full gap-2 text-meta" style={{ borderRadius: 0 }}>
                  <Trash2 className="h-3.5 w-3.5" />
                  {deleteActionLabel}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {allActionItemsTrashed
                      ? t("library.inspector.permDeleteNTitle", { n: selectedActionItems.length })
                      : t("library.inspector.moveNToTrashTitle", { n: selectedActionItems.length })}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {allActionItemsTrashed
                      ? t("library.inspector.permDeleteNDesc")
                      : t("library.inspector.moveNToTrashDesc")}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                  <AlertDialogAction onClick={onDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                    {allActionItemsTrashed ? t("library.inspector.permDeleteAction") : t("library.inspector.moveTrashAction")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      ) : selectedHiddenByFilters ? (
        <div className="flex h-full items-center justify-center px-6 text-center text-meta text-muted-foreground">
          {t("library.inspector.hiddenByFilters")}
        </div>
      ) : selected ? (
        (() => {
          /* doc 자료는 AI 분석 결과가 의미 없는 자료(PDF/ZIP/EXE/font 등).
             - 썸네일이 있어도 1페이지/프리뷰만 보여 줘 vision 분류 품질이
               떨어지고, 사용자가 기대하는 "내용 기반 태그/스타일/모션"
               축과 결이 다르다.
             - AI 탭을 노출하면 빈 카드 / 의미 없는 결과만 보여 사용성
               해친다.
             그래서 doc 단일 선택에서는 탭 바를 통째로 숨기고 항상 Info
             만 렌더. 사용자가 저장해 둔 inspectorTab 값("ai") 자체는
             건드리지 않는다 — 다른 자료로 돌아가면 그대로 AI 탭이 복원
             되어 사용자 의도가 보존된다. */
          const isDoc = selected.kind === "doc";
          const effectiveTab: InspectorTab = isDoc ? "info" : inspectorTab;
          return (
        <div className="p-5">
          {/* Step 1 — Info / AI 두 탭. Info 탭은 Eagle 픽셀 디자인을 따라
              인라인 편집·칩·별·Properties 격자로 재구성된다(Step 2).
              AI 탭은 Classify control + AI Suggestions block 만 분리.
              단 doc 자료는 AI 탭 자체를 숨기므로 탭 바를 통째로 생략. */}
          {!isDoc ? (
            <div className="mb-4 flex border border-border-subtle" style={{ borderRadius: 0 }}>
              <button
                type="button"
                onClick={() => setInspectorTab("info")}
                className={cn(
                  "flex h-8 flex-1 items-center justify-center gap-1.5 text-meta font-medium transition-colors",
                  effectiveTab === "info"
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted/50",
                )}
                aria-pressed={effectiveTab === "info"}
              >
                <Info className="h-3.5 w-3.5" />
                {t("library.inspector.infoTab")}
              </button>
              <button
                type="button"
                onClick={() => setInspectorTab("ai")}
                className={cn(
                  "flex h-8 flex-1 items-center justify-center gap-1.5 border-l border-border-subtle text-meta font-medium transition-colors",
                  effectiveTab === "ai"
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted/50",
                )}
                aria-pressed={effectiveTab === "ai"}
              >
                <Sparkles className="h-3.5 w-3.5" />
                {t("library.inspector.aiTab")}
              </button>
            </div>
          ) : null}

          {effectiveTab === "info" ? (
          <>
          {/* 미디어 프리뷰 — 빅 프리뷰 모드(`hideMediaPreview=true`) 에서도
              인스펙터 상단에 *정적 썸네일* 만 유지해 자료 식별감을 보존
              한다. 인터랙티브 비디오/iframe/이미지 줌/영상 toolbar 는
              빅 프리뷰 측에서 제공하므로 여기서 중복하지 않는다.
              Eagle 식 "Custom thumbnail (Select file/From clipboard)" 액션은
              그리드 카드의 우클릭 컨텍스트 메뉴(LibraryGrid 의 LibraryCard)
              에 있다 — 영상 element 의 native context menu 가 인스펙터
              썸네일을 가로채는 문제를 피하고, 자료를 굳이 selected 로
              바꿔야 호출 가능했던 워크플로우 제약도 함께 해소. */}
          {hideMediaPreview ? (
            <div
              className="border border-border-subtle bg-muted/30 flex items-center justify-center overflow-hidden"
              style={{ borderRadius: 0, maxHeight: 200, minHeight: 120 }}
            >
              {selectedImagePreviewUrl || selected.thumbnail_url ? (
                <img
                  src={withReferenceVersion(selectedImagePreviewUrl || selected.thumbnail_url || "", selected)}
                  alt={selected.title}
                  className="max-h-[200px] w-full object-contain"
                />
              ) : selected.kind === "link" ? (
                <Link2 className="h-9 w-9 text-muted-foreground" />
              ) : (
                <Library className="h-9 w-9 text-muted-foreground" />
              )}
            </div>
          ) : (
            <>
              {/* Step 2 — Preview 컨테이너에서 aspect-video 강제를 제거하고
                  원본 비율을 유지(Eagle 식). 단 너무 커지지 않도록 max-height
                  로 캡을 두어 그 아래 Properties 가 한 화면에 들어오는 시각
                  리듬을 보존. video / link / 빈 자료의 경우 최소 높이를
                  보장하기 위해 min-height 도 함께 두었다. */}
              <div
                className="border border-border-subtle bg-muted/30 flex items-center justify-center overflow-hidden"
                style={{ borderRadius: 0, maxHeight: 360, minHeight: 160 }}
              >
                {selected.kind === "video" && selected.file_url ? (
                  <video
                    ref={videoRef}
                    src={selected.file_url}
                    poster={withReferenceVersion(selected.thumbnail_url ?? undefined, selected) || undefined}
                    controls
                    className="max-h-[360px] w-full bg-black object-contain"
                    onLoadedMetadata={(event) => {
                      event.currentTarget.playbackRate = Number(playbackRate);
                    }}
                  />
                ) : selected.kind === "youtube" && youtubeEmbedUrl(selected.source_url) ? (
                  <iframe
                    src={youtubeEmbedUrl(selected.source_url) ?? undefined}
                    title={selected.title}
                    className="aspect-video w-full"
                    referrerPolicy="strict-origin-when-cross-origin"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                  />
                ) : selected.kind === "link" ? (
                  /* link preview — og:image / oEmbed / screenshot 로 받아둔
                     thumbnail_url(또는 애니메이션 file_url) 이 있으면 그것을
                     상단 프리뷰로 보여준다. URL 자체는 바로 아래 URL 행에서
                     이미 노출되므로 여기서 중복 표기하지 않고, 썸네일이 없을
                     때만 링크 아이콘으로 폴백한다. */
                  selectedImagePreviewUrl ? (
                    <img
                      src={withReferenceVersion(selectedImagePreviewUrl, selected)}
                      alt={selected.title}
                      className="max-h-[360px] w-full object-contain"
                    />
                  ) : (
                    <Link2 className="h-9 w-9 text-muted-foreground" />
                  )
                ) : selected.kind === "doc" ? (
                  /* doc 카테고리 preview — thumbnail_url 만 *진짜* 이미지로
                     취급(Phase 2 의 PDF first page / font preview 가 채움).
                     selectedImagePreviewUrl 은 doc 의 file_url(binary) 까지
                     포함하기 때문에 그대로 <img> 로 그리면 broken icon 이
                     된다. 따라서 doc 분기는 thumbnail_url 단독 검사. */
                  (() => {
                    const docPresentation = docPresentationOf(selected);
                    const hueCls = docHueClasses(docPresentation);
                    const DocIcon = docPresentation.Icon;
                    if (selected.thumbnail_url) {
                      return (
                        <img
                          src={withReferenceVersion(selected.thumbnail_url, selected)}
                          alt={selected.title}
                          className="max-h-[360px] w-full object-contain"
                        />
                      );
                    }
                    return (
                      <div className={cn("flex h-full w-full flex-col items-center justify-center gap-3 px-6 py-8", hueCls.surface)}>
                        <DocIcon className={cn("h-12 w-12", hueCls.iconColor)} />
                        <span className={cn("rounded px-2 py-0.5 font-mono text-caption font-semibold tracking-wider", hueCls.badgeBg)}>
                          {docExtensionTag(selected)}
                        </span>
                        <div className="line-clamp-2 max-w-full text-center text-meta text-muted-foreground">
                          {selected.title}
                        </div>
                      </div>
                    );
                  })()
                ) : selectedImagePreviewUrl ? (
                  <img
                    src={withReferenceVersion(selectedImagePreviewUrl, selected)}
                    alt={selected.title}
                    className="max-h-[360px] w-full object-contain"
                  />
                ) : (
                  <Library className="h-9 w-9 text-muted-foreground" />
                )}
              </div>

              {selected.kind === "video" ? (
                /* 영상 toolbar — 배속 select 옆에 Set Cover / Save Frame 두
                   아이콘 버튼. 텍스트 버튼이 가로폭을 거의 다 잡아먹던 이전
                   레이아웃 대신 정사각 32px 아이콘 2개로 줄여, 남는 공간이
                   향후 region 토글 등 다른 액션을 받을 수 있게 한다. tooltip
                   이 라벨 역할을 하므로 의미 식별성은 유지. */
                <div className="mt-3 flex items-center gap-2">
                  <select
                    value={playbackRate}
                    onChange={(event) => onPlaybackRateChange(event.target.value)}
                    className="h-8 w-[88px] shrink-0 border border-border-subtle bg-background px-2 text-meta"
                    style={{ borderRadius: 0 }}
                  >
                    {PLAYBACK_RATE_OPTIONS.map((rate) => (
                      <option key={rate} value={String(rate)}>{`${rate}x`}</option>
                    ))}
                  </select>
                  <div className="flex-1" />
                  <Button
                    variant="outline"
                    className="h-8 w-8 p-0"
                    style={{ borderRadius: 0 }}
                    onClick={onSetCover}
                    disabled={saving}
                    title={t("library.inspector.setCoverTitle")}
                    aria-label={t("library.inspector.setCoverAria")}
                  >
                    <ImageIcon className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="outline"
                    className="h-8 w-8 p-0"
                    style={{ borderRadius: 0 }}
                    onClick={onSaveFrame}
                    disabled={saving}
                    title={t("library.inspector.saveFrameTitle")}
                    aria-label={t("library.inspector.saveFrameAria")}
                  >
                    <Camera className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : selected.kind === "gif" ? (
                /* GIF toolbar — 영상과 동일한 시각 1줄. 단 Inspector 의 GIF
                   미리보기는 정적 썸네일이라 *현재 프레임* 캔버스가 없다.
                   따라서 Set Cover / Save Frame 은 disabled 로 노출하고,
                   tooltip 으로 "Open big preview to set cover/save frame from
                   a frame" 안내. 큰 프리뷰의 GifFramePlayer 가 같은 아이콘
                   2개를 활성 상태로 제공한다. 배속 select 는 큰 프리뷰와
                   상태를 공유하므로 Inspector 에서 미리 조정해두면 큰
                   프리뷰 진입 시 그대로 적용된다. */
                <div className="mt-3 flex items-center gap-2">
                  <select
                    value={playbackRate}
                    onChange={(event) => onPlaybackRateChange(event.target.value)}
                    className="h-8 w-[88px] shrink-0 border border-border-subtle bg-background px-2 text-meta"
                    style={{ borderRadius: 0 }}
                  >
                    {PLAYBACK_RATE_OPTIONS.map((rate) => (
                      <option key={rate} value={String(rate)}>{`${rate}x`}</option>
                    ))}
                  </select>
                  <div className="flex-1" />
                  <Button
                    variant="outline"
                    className="h-8 w-8 p-0"
                    style={{ borderRadius: 0 }}
                    onClick={onSetCover}
                    disabled
                    title={t("library.inspector.setCoverGifTitle")}
                    aria-label={t("library.inspector.setCoverGifAria")}
                  >
                    <ImageIcon className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="outline"
                    className="h-8 w-8 p-0"
                    style={{ borderRadius: 0 }}
                    onClick={onSaveFrame}
                    disabled
                    title={t("library.inspector.saveFrameGifTitle")}
                    aria-label={t("library.inspector.saveFrameGifAria")}
                  >
                    <Camera className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : null}
            </>
          )}

          {/* 컬러 팔레트 — 패널/헤더 없는 슬림 행. Eagle 식으로 썸네일 바로
              아래에 중앙정렬해 시각적으로 자료의 톤을 한눈에 보여준다.
              colorPalette.ts 의 PALETTE_SIZE=8 과 맞물려 대부분의 자료에서
              7개 이상의 dominant 색이 노출(2-pass 추출이 명암 분리 보장).
              클릭 시 hex 가 클립보드로 복사.

              표시 순서: ratio(면적 비중) 내림차순. extract-colors 가 내부
              적으로 매기는 "power"(채도 × 면적 패널티) 순은 작은 액센트
              색이 dominant 파스텔보다 앞에 오는 부작용이 있어 시각적
              직관과 어긋났다. DB 데이터는 raw 보존하고 표시 시점에만
              정렬 (재추출 정책 바뀔 때 손쉽게 복원 가능). 8 항목 한정
              연산이라 매 렌더 정렬해도 비용 0. */}
          {selected.color_palette.length > 0 ? (
            <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
              {[...selected.color_palette]
                .sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0))
                .slice(0, 8)
                .map((swatch, index) => (
                  <button
                    key={`${swatch.color}_${index}`}
                    type="button"
                    title={swatch.color}
                    aria-label={t("library.inspector.copyColor", { color: swatch.color })}
                    onClick={() => onCopyText(swatch.color, t("library.inspector.colorLabel"))}
                    /* 이중 윤곽으로 어느 색 배경에서도 식별 가능:
                       - border-border: 테마 토큰 외곽선 (밝은 swatch 가 어두운
                         패널에 묻히지 않게)
                       - ring-inset ring-white/20: swatch *안쪽* 1px 반투명 흰
                         라인 (검정/짙은 swatch 가 dark inspector 배경에 흡수
                         되지 않게). 밝은 swatch 위에선 옅어져 거슬리지 않음. */
                    className="h-5 w-5 border border-border ring-1 ring-inset ring-white/20 shadow-sm transition-transform hover:scale-110"
                    style={{ backgroundColor: swatch.color, borderRadius: 0 }}
                  />
                ))}
            </div>
          ) : null}

          {/* Step 2 — 인라인 Title. 기존 정적 h2 + 별도 Title input 을 합쳐
              한 줄짜리 invisible-border input 으로. Enter 또는 onBlur 로
              저장(onSaveMetadata 가 editTitle 을 commit). 자물쇠 아이콘 등
              Eagle 의 자잘한 장식은 의도적으로 생략 — 미니멀 보존. */}
          <div className="mt-4 flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <Badge variant="secondary" className="mb-2 text-2xs font-medium">{resolveTypeLabel(selected)}</Badge>
              {/* 인라인 편집 affordance — 평소엔 정적 텍스트처럼 깔끔하게,
                  hover/focus 에서 옅은 배경이 떠올라 "여기는 입력란" 임을
                  알린다. wrapper 가 -mx-2 로 hit area 를 컨텐츠 가장자리
                  까지 확장. Title/Notes/URL 세 입력란이 동일 affordance 를
                  공유한다. */}
              <div className="-mx-2 transition-colors hover:bg-muted/40 focus-within:bg-muted/60">
                <Input
                  value={editTitle}
                  onChange={(event) => onEditTitleChange(event.target.value)}
                  onBlur={onSaveMetadata}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      (event.target as HTMLInputElement).blur();
                    }
                  }}
                  placeholder={t("library.inspector.titlePlaceholder")}
                  className="h-8 border-0 bg-transparent px-2 text-label font-semibold leading-snug shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 md:text-label"
                  style={{ borderRadius: 0 }}
                />
              </div>
              {selectedDuplicateCount > 1 ? (
                <div className="mt-1 text-caption text-muted-foreground">
                  {t("library.inspector.duplicateCandidate", { n: selectedDuplicateCount })}
                </div>
              ) : null}
              {selectedUsageCount > 0 ? (
                <div className="mt-1 text-caption text-muted-foreground">
                  {t("library.inspector.usedInProjects", { n: selectedUsageCount })}
                </div>
              ) : null}
              {selectedUsageLocations.length > 0 ? (
                /* 사용 위치 (Brief + Conti, cross-workspace 포함). DB 카운
                   트와 별개로 LS 스캔에서 발견된 위치를 *프로젝트 제목
                   리스트* 로 나열 — 사용자가 "정확히 어디서 쓰이고 있는
                   지" 를 한 눈에 알 수 있게. 한 줄은 (projectId, target)
                   페어 단위라 같은 프로젝트의 브리프+콘티 양쪽에 있으면
                   두 줄. 클릭/점프는 Phase 1.5 에서. */
                <ul className="mt-1.5 space-y-1 text-caption text-muted-foreground">
                  {selectedUsageLocations.flatMap((loc) => {
                    // 에셋은 타입별로 한 줄씩(에셋(캐릭터)/에셋(배경)/에셋(아이템)).
                    const assetTypes =
                      loc.target === "asset" && loc.assetTypes && loc.assetTypes.length > 0
                        ? loc.assetTypes
                        : [undefined];
                    return assetTypes.map((assetType) => {
                      const titleText =
                        loc.title ?? t("library.inspector.usedInUnknownProject", { id: loc.projectId.slice(0, 8) });
                      const badgeClass =
                        loc.target === "asset"
                          ? "border-primary/50 text-primary"
                          : loc.target === "conti"
                            ? "border-amber-500/50 text-amber-500"
                            : "border-sky-500/50 text-sky-500";
                      const baseLabel = t(`library.inspector.usageTarget.${loc.target}` as const);
                      const label =
                        loc.target === "asset" && assetType
                          ? `${baseLabel}(${t(`library.promoteToAsset.types.${assetType}.label` as const)})`
                          : baseLabel;
                      return (
                        <li key={`${loc.projectId}:${loc.target}:${assetType ?? ""}`}>
                          <button
                            type="button"
                            onClick={() => onOpenUsageLocation?.(loc.projectId, loc.workspaceId, loc.target, assetType)}
                            disabled={!onOpenUsageLocation}
                            className="flex w-full items-center gap-1.5 text-left transition-colors hover:text-foreground disabled:cursor-default"
                            title={loc.title ? `${loc.title} (${loc.projectId})` : loc.projectId}
                          >
                            <Badge
                              variant="outline"
                              className={cn("shrink-0 rounded-none px-1 py-0 text-micro font-medium leading-tight", badgeClass)}
                            >
                              {label}
                            </Badge>
                            <span className="truncate font-mono">{titleText}</span>
                          </button>
                        </li>
                      );
                    });
                  })}
                </ul>
              ) : null}
            </div>
            <button
              onClick={onToggleFavorite}
              className="mt-1 shrink-0 text-muted-foreground transition-colors hover:text-primary"
              title={selected.is_favorite ? t("library.inspector.removeFavorite") : t("library.inspector.addFavorite")}
              aria-label={selected.is_favorite ? t("library.inspector.removeFavorite") : t("library.inspector.addFavorite")}
            >
              <Star className={cn("h-4 w-4", selected.is_favorite && "fill-primary text-primary")} />
            </button>
          </div>

          {/* Step 2 — Notes autosize textarea. 라벨 없는 Eagle 식. onBlur 로
              저장. 스크롤 대신 컨텐츠 길이에 맞춰 자라도록 useLayoutEffect
              로 scrollHeight 측정 후 height 을 동적으로 설정. wrapper 가
              hover/focus 시 옅은 배경을 띄워 입력란 affordance 를 제공. */}
          <div className="mt-4 border-t border-border-subtle pt-3">
            <div className="-mx-2 transition-colors hover:bg-muted/40 focus-within:bg-muted/60">
              <NotesAutosize
                value={editNotes}
                onChange={onEditNotesChange}
                onBlur={onSaveMetadata}
              />
            </div>
          </div>

          {/* Step 2 — URL 행: link 아이콘 + 인라인 input + 외부 링크/X 버튼.
              X 버튼은 onClearSourceUrl 직접 호출(즉시 저장). 빈 값일 땐
              "Add a URL" 만 표시 — onBlur 시 save. 글자 크기는 Notes 와
              동일하게 12px 로 통일. Input 프리미티브의 `md:text-sm` 가
              desktop 에서 14px 로 덮어쓰는 걸 `md:text-meta` 로 명시 차단.
              긴 URL 도 한 줄로 유지되도록 truncate, 마우스 오버 title 로
              풀 URL 노출. wrapper 가 Notes/Title 과 동일한 hover/focus
              affordance 를 제공한다. */}
          <div className="mt-3 flex items-center gap-2 border-t border-border-subtle pt-3">
            <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="-mr-2 flex-1 transition-colors hover:bg-muted/40 focus-within:bg-muted/60">
              <Input
                value={editSourceUrl}
                onChange={(event) => onEditSourceUrlChange(event.target.value)}
                onBlur={onSaveMetadata}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    (event.target as HTMLInputElement).blur();
                  }
                }}
                placeholder={t("library.inspector.urlPlaceholder")}
                title={editSourceUrl || undefined}
                className="h-8 w-full truncate border-0 bg-transparent px-2 text-meta leading-none shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 md:text-meta"
                style={{ borderRadius: 0 }}
              />
            </div>
            {editSourceUrl ? (
              <>
                <a
                  href={editSourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground hover:text-primary"
                  title={t("library.inspector.openInBrowser")}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-destructive"
                  title={t("library.inspector.clearUrl")}
                  onClick={() => onClearSourceUrl?.()}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </>
            ) : null}
          </div>

          {/* Step 2 — Tags 칩. Each chip has X. Trailing "+ Add" inline-add.
              빈 상태에서 "No tags yet" 같은 placeholder 텍스트는 없음 — "+ Add"
              버튼 자체가 충분한 affordance 라 시각적 잡음을 줄이는 쪽이 낫다
              (beta 2.0.0). */}
          <div className="mt-5 border-t border-border-subtle pt-4">
            <SectionLabel className="mb-2">{t("library.inspector.section.tags")}</SectionLabel>
            <ChipList
              chips={selectedRegularTags}
              onRemove={onRemoveTag ? (value) => onRemoveTag(value) : undefined}
              onAdd={onAddTag ? (value) => onAddTag(value) : undefined}
              addPlaceholder={t("library.inspector.tagsPlaceholder")}
            />
          </div>

          {/* Step 2 — Folders 칩. picker 는 LibrarySidebar 의 folders 리스트
              를 받아 자동완성. 마지막 segment 만 라벨로 보여주고 full path
              는 title 에. 빈 상태 placeholder 는 Tags 와 같은 이유로 생략. */}
          <div className="mt-5 border-t border-border-subtle pt-4">
            <SectionLabel className="mb-2">{t("library.inspector.section.folders")}</SectionLabel>
            <FolderChipList
              paths={selectedFolderPaths}
              availableFolders={availableFolders}
              onRemove={onRemoveFolder ? (path) => onRemoveFolder(path) : undefined}
              onAdd={onAddFolder ? (path) => onAddFolder(path) : undefined}
            />
          </div>

          {/* Step 2 — Properties 격자. Eagle 순서대로 Rating·Dimensions·
              Duration·Type·Size·Date Imported·Date Created·Date Modified.
              Used In / File URL 행은 위 헤더(usage 표시) / Advanced 섹션
              으로 흡수되어 여기선 제거. Rating 은 별 5개 인라인 클릭 입력. */}
          <div className="mt-5 border border-border-subtle bg-surface-panel p-3" style={{ borderRadius: 0 }}>
            <SectionLabel className="mb-3">{t("library.inspector.section.properties")}</SectionLabel>
            <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-caption">
              <div className="text-muted-foreground">{t("library.inspector.props.rating")}</div>
              <div className="flex justify-end">
                <RatingStars
                  value={Number(editRating) || 0}
                  onChange={onSetRating}
                />
              </div>
              <div className="text-muted-foreground">{t("library.inspector.props.dimensions")}</div>
              <div className="text-right font-mono">{formatDimensions(selected.width, selected.height, t("common.unknown"))}</div>
              {selected.kind === "video" || selected.duration_sec ? (
                <>
                  <div className="text-muted-foreground">{t("library.inspector.props.duration")}</div>
                  <div className="text-right font-mono">{formatDuration(selected.duration_sec)}</div>
                </>
              ) : null}
              <div className="text-muted-foreground">{t("library.inspector.props.type")}</div>
              <div className="text-right font-mono">{selected.mime_type ?? resolveTypeLabel(selected)}</div>
              <div className="text-muted-foreground">{t("library.inspector.props.size")}</div>
              <div className="text-right font-mono">{formatBytes(selected.file_size, t("common.unknown"))}</div>
              <div className="text-muted-foreground">{t("library.inspector.props.imported")}</div>
              <div className="text-right font-mono">{formatDateTime(selected.imported_at ?? selected.created_at, t("common.unknown"))}</div>
              <div className="text-muted-foreground">{t("library.inspector.props.created")}</div>
              <div className="text-right font-mono">{formatDateTime(selected.created_at, t("common.unknown"))}</div>
              <div className="text-muted-foreground">{t("library.inspector.props.modified")}</div>
              <div className="text-right font-mono">{formatDateTime(selected.updated_at, t("common.unknown"))}</div>
            </div>
          </div>

          {/* TIMESTAMP NOTES — 영상 + GIF + image 세 자료에 노출. Eagle 의
              Comments 와 동일한 역할: 특정 시점/프레임/영역에 텍스트 메모.

              v3 — GIF 도 동일 섹션을 사용. video 와 다른 점:
                - 시간 라벨 자리에 `#N` (frameIndex+1) 표시 — 호버 미리보기는
                  v3 에서는 생략(GIF 는 큰 프리뷰가 더 자연스럽고, 단일 video
                  element 재사용이 GIF 디코딩에 적용되지 않음).
                - Inspector 의 인라인 Add 입력은 영상에서만 의미 있음(현재
                  video.currentTime 을 자동 사용). GIF 는 Inspector 정적 썸네일
                  이라 "현재 프레임" 개념이 없으므로 입력행을 숨기고 안내 문구
                  로 대체. 노트 추가는 큰 프리뷰의 NotebookPen 아이콘에서.

              Phase 4 — image 자료도 동일 섹션 사용. 단 image 노트는 *항상
              region anchored* 이고 시점 개념이 없어, 행에서 시간 라벨 셀을
              아예 렌더하지 않고 텍스트만 표시한다 — 섹션 헤더 "Region Notes"
              가 이미 컨텍스트를 충분히 전달. 인라인 Add 행은 GIF 와 같은
              안내 문구로 대체 — region 입력은 큰 프리뷰의 드래그를 통해서만
              들어온다. note.region 이 있는 video/gif 노트는 라벨 옆에 작은
              BoxSelect 인디케이터를 표시해 시점-only 노트와 시각 구분. */}
          {selected.kind === "video" || selected.kind === "gif" || selected.kind === "image" || selected.kind === "webp" ? (
            <TimestampNotesSection
              selected={selected}
              videoRef={videoRef}
              timestampText={timestampText}
              onTimestampTextChange={onTimestampTextChange}
              onAddTimestampNote={onAddTimestampNote}
              onJumpToTimestamp={onJumpToTimestamp}
              onDeleteTimestampNote={onDeleteTimestampNote}
              onEditTimestampNote={onEditTimestampNote}
            />
          ) : null}

          {/* "프로젝트로 보내기" 묶음 — Promote to Asset / Export Reference.
              둘 다 자료 자체를 변경하지 않고 다른 컨텍스트로 내보내는 동작.
              ADVANCED collapsible 을 없애 버렸으므로 Info 본문 흐름의 끝
              부분에 1차 액션으로 노출된다. */}
          {onPromoteToAsset ? (
            <div className="mt-5 border-t border-border-subtle pt-4">
              <Button
                variant="outline"
                className="h-8 w-full gap-2 text-meta"
                style={{ borderRadius: 0 }}
                onClick={onPromoteToAsset}
                disabled={!canPromoteToAsset}
                title={
                  !canPromoteToAsset
                    ? t("library.inspector.promoteNeedsProject")
                    : t("library.inspector.promoteRegisterLib")
                }
              >
                <BookmarkPlus className="h-3.5 w-3.5" />
                {t("library.inspector.promoteToAsset")}
                {selectedPromotedAssetCount > 0 ? (
                  <Badge variant="secondary" className="ml-1 rounded-none text-2xs">
                    {t("library.inspector.promotedCount", { n: selectedPromotedAssetCount })}
                  </Badge>
                ) : null}
              </Button>
            </div>
          ) : null}

          {/* Export Reference 단일 액션은 상단 툴바의 Export 와 중복되어 제거.
              `onExportSelected` prop 자체는 multi-select 패널의 "Export Selected
              as Pack…" 1차 액션에서 여전히 사용된다. */}

          {/* 휴지통 액션 그룹 — 휴지통 상태에서는 Restore + Permanently Delete
              두 버튼이 함께 묶여 "Trash actions" 섹션을 이룬다. 위쪽 Properties
              패널과는 mt-5 + border-t + pt-3 으로 명확히 분리하고, 그룹
              내부에서는 mt-2 의 짧은 간격으로 두 버튼이 시각적으로 한 덩어리
              임을 드러낸다. 휴지통이 아닌 일반 상태에서는 "Move to Trash" 만
              혼자 노출되므로 동일한 mt-5 + border-t + pt-3 으로 위쪽과 분리.
              Copy File URL 은 외부 링크가 아니라 의미가 없어 제거됨. */}
          {allActionItemsTrashed ? (
            <div className="mt-5 border-t border-border-subtle pt-3">
              <Button
                variant="outline"
                className="h-8 w-full gap-2 text-meta"
                style={{ borderRadius: 0 }}
                onClick={onRestoreSelected}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t("library.inspector.restoreReference")}
              </Button>
            </div>
          ) : null}

          <div
            className={cn(
              allActionItemsTrashed
                ? "mt-2"
                : "mt-5 border-t border-border-subtle pt-3",
            )}
          >
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" className="h-8 w-full gap-2 text-meta" style={{ borderRadius: 0 }}>
                  <Trash2 className="h-3.5 w-3.5" />
                  {deleteActionLabel}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{deleteDialogTitle}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {deleteDialogDescription}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                  <AlertDialogAction onClick={onDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                    {allActionItemsTrashed ? t("library.inspector.permDeleteAction") : t("library.inspector.moveTrashAction")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
          </>
          ) : (
          <AiTabBody
            selected={selected}
            selectedSuggestions={selectedSuggestions}
            aiBusy={aiBusy}
            classifyStage={classifyStage}
            classifyProgress={classifyProgress}
            onClassify={onClassify}
            onAcceptSuggestions={onAcceptSuggestions}
          />
          )}
        </div>
          );
        })()
      ) : (
        /* 빈 선택 — Eagle 처럼 *현재 스코프* 의 항목 수/총 용량 요약을
           Properties 격자로 보여 준다. scope 값이 들어오면 패널을 그리고,
           아직 데이터가 없거나 부모가 prop 을 안 내려보낸 경우엔 기존
           안내 문구로 폴백한다. 다중 선택 패널과 같은 룩(border + bg-
           surface-panel) 을 써서 Inspector 전체의 시각 리듬을 유지.

           시각 위계 (3-zone):
             1) 패널 타이틀 (scopeLabel) — 큰 시멘틱 헤딩.
             2) 속성 섹션 — SectionLabel 에 *bottom divider* 를 붙여 "이
                라벨이 아래 행들의 헤더" 임을 즉시 인지하게 한다. mb 를
                좁혀 헤더-행 사이를 타이트하게 묶고, 위쪽엔 mt 로 타이틀
                과 충분히 떼어 놓아 헤더가 아래에 "속한다" 는 느낌이 명확.
             3) 안내 텍스트 — 상단에 얇은 separator 로 본문과 분리. */
        <div className="p-5">
          {scopeLabel != null && scopeItemCount != null ? (
            <div
              className="border border-border-subtle bg-surface-panel p-3"
              style={{ borderRadius: 0 }}
            >
              <div className="text-meta font-semibold text-foreground" title={scopeLabel}>
                {scopeLabel}
              </div>
              <SectionLabel className="mb-2 mt-4 border-b border-border-subtle pb-1.5">
                {t("library.inspector.section.properties")}
              </SectionLabel>
              <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-caption">
                <div className="text-muted-foreground">
                  {t("library.inspector.props.itemCount")}
                </div>
                <div className="text-right font-mono tabular-nums">
                  {scopeItemCount}
                </div>
                <div className="text-muted-foreground">
                  {t("library.inspector.props.size")}
                </div>
                <div className="text-right font-mono">
                  {formatBytes(scopeTotalSize ?? 0, t("common.unknown"))}
                </div>
              </div>
              <div className="mt-4 border-t border-border-subtle pt-3 text-2xs leading-snug text-muted-foreground">
                {t("library.inspector.selectReferenceHint")}
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center px-1 text-center text-meta text-muted-foreground">
              {t("library.inspector.selectReferenceHint")}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

/* 인스펙터 전체에서 공유하는 섹션 라벨 — Title Case + 일관된 타이포그래피.
   이전에는 `text-2xs font-mono tracking-[0.12em]` UPPERCASE 가 6+ 곳에
   퍼져 있어 라벨/탭/badge 마다 글자 무게·간격이 달라 보였다. 한 곳으로
   통일해 시각 리듬을 맞춘다. icon 슬롯은 옵셔널. */
interface SectionLabelProps {
  children: ReactNode;
  icon?: ReactNode;
  className?: string;
}

function SectionLabel({ children, icon, className }: SectionLabelProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 text-caption font-medium text-muted-foreground",
        className,
      )}
    >
      {icon}
      {children}
    </div>
  );
}

/* ---- 보조 컴포넌트들 ---- */

interface NotesAutosizeProps {
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
}

/* Eagle 식 라벨 없는 Notes — 컨텐츠 길이에 따라 자동 확장.
   비어있을 때는 placeholder 만 보이고, 입력하면 1.4em 라인 단위로 자란다. */
function NotesAutosize({ value, onChange, onBlur }: NotesAutosizeProps) {
  const t = useT();
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = "auto";
    /* min-height 36px = 한 줄+padding 분량. wrapper hover bg 가 텍스트 영역
       에 정확히 맞도록 내부 padding 으로 시각 정렬을 맞춘다. */
    node.style.height = `${Math.max(36, node.scrollHeight)}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onBlur={onBlur}
      placeholder={t("library.inspector.notesPlaceholder")}
      className="block w-full resize-none border-0 bg-transparent px-2 py-1.5 text-meta leading-relaxed text-text-secondary outline-none placeholder:text-muted-foreground focus-visible:ring-0"
      style={{ borderRadius: 0 }}
      rows={1}
    />
  );
}

interface ChipListProps {
  chips: string[];
  onRemove?: (value: string) => void;
  onAdd?: (value: string) => void;
  addPlaceholder: string;
  /* 빈 상태 placeholder 텍스트. 생략하면 "+ Add" 버튼만 보이고 아무 문구도
     렌더되지 않는다 — beta 2.0.0 우측 인스펙터의 Tags / Folders 섹션은 이
     쪽을 사용해 시각적 잡음을 줄임. */
  emptyHint?: string;
}

function ChipList({ chips, onRemove, onAdd, addPlaceholder, emptyHint }: ChipListProps) {
  const t = useT();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);
  const commit = () => {
    const value = draft.trim();
    if (value && onAdd) onAdd(value);
    setDraft("");
    setAdding(false);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.length === 0 && !adding && emptyHint ? (
        <span className="text-caption text-muted-foreground">{emptyHint}</span>
      ) : null}
      {chips.map((chip) => (
        <span
          key={chip}
          className="inline-flex h-6 items-center gap-1 border border-border-subtle bg-surface-panel px-2 text-caption"
          style={{ borderRadius: 0 }}
        >
          {chip}
          {onRemove ? (
            <button
              type="button"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => onRemove(chip)}
              aria-label={t("library.inspector.removeTag", { chip })}
            >
              <X className="h-3 w-3" />
            </button>
          ) : null}
        </span>
      ))}
      {adding ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setDraft("");
              setAdding(false);
            }
          }}
          placeholder={addPlaceholder}
          className="h-6 border border-border-subtle bg-background px-2 text-caption outline-none"
          style={{ borderRadius: 0, minWidth: 96 }}
        />
      ) : onAdd ? (
        <button
          type="button"
          className="inline-flex h-6 items-center gap-1 border border-dashed border-border-subtle px-2 text-caption text-muted-foreground hover:text-foreground"
          style={{ borderRadius: 0 }}
          onClick={() => setAdding(true)}
        >
          <Plus className="h-3 w-3" />
          {t("common.add")}
        </button>
      ) : null}
    </div>
  );
}

interface FolderChipListProps {
  paths: string[];
  availableFolders: LibraryFolderRow[];
  onRemove?: (path: string) => void;
  onAdd?: (path: string) => void;
  /* 빈 상태 placeholder 텍스트. ChipList 와 같은 시그니처. */
  emptyHint?: string;
}

function FolderChipList({ paths, availableFolders, onRemove, onAdd, emptyHint }: FolderChipListProps) {
  const t = useT();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);
  const suggestions = useMemo(() => {
    const lower = draft.trim().toLowerCase();
    const taken = new Set(paths);
    return availableFolders
      .map((row) => row.tag.replace(/^folder:/, ""))
      .filter((path) => !taken.has(path))
      .filter((path) => (lower ? path.toLowerCase().includes(lower) : true))
      .slice(0, 8);
  }, [availableFolders, draft, paths]);
  const commit = (value: string) => {
    const trimmed = value.trim();
    if (trimmed && onAdd) onAdd(trimmed);
    setDraft("");
    setAdding(false);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {paths.length === 0 && !adding && emptyHint ? (
        <span className="text-caption text-muted-foreground">{emptyHint}</span>
      ) : null}
      {paths.map((path) => {
        const segments = path.split("/").filter(Boolean);
        const label = segments[segments.length - 1] ?? path;
        return (
          <span
            key={path}
            className="inline-flex h-6 items-center gap-1 border border-border-subtle bg-surface-panel px-2 text-caption"
            style={{ borderRadius: 0 }}
            title={path}
          >
            {label}
            {onRemove ? (
              <button
                type="button"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => onRemove(path)}
                aria-label={t("library.inspector.removeFromPath", { path })}
              >
                <X className="h-3 w-3" />
              </button>
            ) : null}
          </span>
        );
      })}
      {adding ? (
        <div className="relative">
          <input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              /* blur 시점에 picker 안 항목 클릭이 진행 중일 수 있으니 짧은
                 지연 후 닫음. 빈 값이면 그냥 닫고 commit 하지 않음. */
              setTimeout(() => {
                if (!draft.trim()) {
                  setAdding(false);
                } else {
                  commit(draft);
                }
              }, 120);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit(draft);
              } else if (event.key === "Escape") {
                event.preventDefault();
                setDraft("");
                setAdding(false);
              }
            }}
            placeholder={t("library.inspector.foldersPlaceholder")}
            className="h-6 border border-border-subtle bg-background px-2 text-caption outline-none"
            style={{ borderRadius: 0, minWidth: 160 }}
          />
          {suggestions.length > 0 ? (
            <div
              className="absolute left-0 top-full z-30 mt-1 max-h-48 w-56 overflow-y-auto border border-border-subtle bg-popover shadow-lg"
              style={{ borderRadius: 0 }}
            >
              {suggestions.map((path) => (
                <button
                  key={path}
                  type="button"
                  className="flex w-full items-center px-2 py-1.5 text-left text-caption hover:bg-muted/60"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    commit(path);
                  }}
                  title={path}
                >
                  {path}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : onAdd ? (
        <button
          type="button"
          className="inline-flex h-6 items-center gap-1 border border-dashed border-border-subtle px-2 text-caption text-muted-foreground hover:text-foreground"
          style={{ borderRadius: 0 }}
          onClick={() => setAdding(true)}
        >
          <Plus className="h-3 w-3" />
          {t("common.add")}
        </button>
      ) : null}
    </div>
  );
}

/* ---- AI 결과 Display 토글 ----
   분석 결과(태그/무드/본문) 를 어떤 언어로 표시할지 선택한다. 분석은 항상
   두 언어(영어 canonical + 한국어 parallel) 를 모두 저장하므로 이 토글은
   LLM 재호출 없이 *즉시* 화면을 KO↔EN 으로 전환한다.
   "Auto" 옵션은 Settings → Preferences 에서 결정하고, 인스펙터에서는 즉시
   전환용 KO/EN 만 노출 — 사용자가 두 선택 모두 활용하지 않는 잡음 줄임. */
function AiLanguageToggle({ disabled = false }: { disabled?: boolean }) {
  const t = useT();
  const { language: uiLanguage } = useUiLanguage();
  const [mode, setMode] = useState<AiOutputLanguageMode>(() => getAiOutputLanguageMode());
  useEffect(() => {
    const unsubscribe = subscribeAiOutputLanguage(() => setMode(getAiOutputLanguageMode()));
    return unsubscribe;
  }, []);
  /* 현재 effective 언어 — "auto" 면 UI 언어를 따라가고 있는 상태. KO/EN
     버튼 active 표시는 resolveAiOutputLanguage 의 결과를 기준으로 한다. */
  const resolved = resolveAiOutputLanguage(mode, uiLanguage);
  const apply = (next: "en" | "ko") => {
    if (disabled) return;
    if (next === resolved && mode !== "auto") return;
    setMode(next);
    setAiOutputLanguageMode(next);
  };
  /* KO 를 좌측에 둔다 — 사용자 다수가 한국어를 1차 표시 언어로 사용하는
     워크플로우라 좌측 정렬이 자연스럽다. en/ko 두 값 모두 동등하게 동작
     하므로 시각 순서만의 변경이다. */
  const options: { value: "en" | "ko"; label: string }[] = [
    { value: "ko", label: t("library.aiLanguage.ko") },
    { value: "en", label: t("library.aiLanguage.en") },
  ];
  return (
    <div
      role="radiogroup"
      aria-label={t("library.aiLanguage.displayLabel")}
      title={t("library.aiLanguage.displayHint")}
      className="inline-flex items-center border border-border-subtle bg-surface-panel"
      style={{ borderRadius: 0 }}
    >
      {options.map((opt) => {
        const active = resolved === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => apply(opt.value)}
            className={cn(
              "h-6 px-2 text-2xs tracking-normal transition-colors",
              active
                ? "bg-foreground/10 text-foreground"
                : "text-muted-foreground hover:text-foreground",
              disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
            )}
            style={{ borderRadius: 0 }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/* ---- AI 탭 본체 ----
   3단계 진행 stepper (Sample → Analyze → Done) + 동적 진행 detail + 선택된
   프레임 썸네일 미리보기 + Run AI / Re-analyze 버튼 + AI Suggestions block +
   friendly error block.
   classifyStage 는 in-flight 중에만 의미 있고, 끝나면 selected.classification_status
   ("ready"/"failed") 로 회귀해 표시된다. classifyProgress 는 sampling 의 세부
   진행 (frame 개수, 선택 결과) 을 stepper 와 SampleFramesPreview 가 함께
   사용한다. */
interface AiTabBodyProps {
  selected: ReferenceItem;
  selectedSuggestions?: Partial<ReferenceAiSuggestions>;
  aiBusy: boolean;
  classifyStage: ClassifyStage;
  classifyProgress: ClassifyProgress | null;
  onClassify: () => void;
  onAcceptSuggestions: () => void;
}

function AiTabBody({
  selected,
  selectedSuggestions,
  aiBusy,
  classifyStage,
  classifyProgress,
  onClassify,
  onAcceptSuggestions,
}: AiTabBodyProps) {
  const t = useT();
  const { language: uiLanguage } = useUiLanguage();
  /* Display 언어 — 인스펙터의 토글이 바꾸는 값을 그대로 구독한다. 분석 결과
     자체는 두 언어 모두 저장돼 있기 때문에 LLM 재호출 없이 즉시 전환된다.
     resolveAiOutputLanguage 가 "auto" → uiLanguage 로 펴 줘서 표시 코드는
     항상 "en" | "ko" 하나만 본다. */
  const [displayMode, setDisplayMode] = useState<AiOutputLanguageMode>(() => getAiOutputLanguageMode());
  const [tagMode, setTagMode] = useState<AiTagLanguageMode>(() => getAiTagLanguageMode());
  useEffect(() => {
    /* subscribeAiOutputLanguage 는 display / tag 두 키 변경 모두 fire 하므로
       하나의 구독으로 둘 다 동기화한다. */
    const unsubscribe = subscribeAiOutputLanguage(() => {
      setDisplayMode(getAiOutputLanguageMode());
      setTagMode(getAiTagLanguageMode());
    });
    return unsubscribe;
  }, []);
  const displayLang = resolveAiOutputLanguage(displayMode, uiLanguage);
  /* 태그 표시 언어는 Settings → AI Tag Language 의 결과를 따른다 — 무드/분석
     자유 텍스트와 분리된 별도 축. "follow" 인 경우에만 displayLang 을 추종.
     사용자는 "표시는 한국어, 태그는 영어로 보고 머지하고 싶다" 같은 시나리오
     를 명확히 분리 제어할 수 있다(머지 측의 acceptReferenceAiSuggestions 도
     동일한 effective tag language 를 받는다). */
  const tagLang = resolveAiTagLanguage(tagMode, displayMode, uiLanguage);
  /* 현지화된 parallel 이 있으면 그것을, 없으면 canonical 로 fallback.
     배열 helper 는 길이가 다르면 canonical 로 안전하게 떨어진다(safeJson
     이 길이 가드를 해 주지만 한 번 더 방어). 호출자가 어떤 언어 축(display
     /tag)을 적용할지 명시하도록 인자로 받는다. */
  const pickArrInLang = (
    lang: "en" | "ko",
    canonical?: string[],
    localized?: string[],
  ): string[] => {
    if (lang === "ko" && localized && localized.length === (canonical?.length ?? 0) && localized.length > 0) {
      return localized;
    }
    return canonical ?? [];
  };
  const pickStr = (canonical?: string, localized?: string): string | undefined => {
    if (displayLang === "ko" && localized && localized.trim().length > 0) return localized;
    return canonical;
  };
  const isVideo = selected.kind === "video";
  /* Phase E2 — GIF / animated WebP / APNG 도 video 와 동일한 frame sampling
     경로(classifyGifReference) 를 타므로, 스테퍼의 "Sampling" 단계와 선택된
     프레임 미리보기를 함께 노출한다. 정적 한 컷 GIF 는 분석 측에서 visual
     path 로 폴백되므로 sampled_frames 가 비어 있고 미리보기는 자연스럽게 사라짐. */
  const isAnimated = isVideo || (selected.kind === "gif" && Boolean(selected.file_url));
  const status = selected.classification_status ?? "unclassified";
  /* 표시 단계 결정 — in-flight 중이면 classifyStage 값을, 아니면 DB 의
     classification_status 값을 그대로 보여준다. */
  const displayStage: ClassifyStage = aiBusy
    ? (classifyStage === "ready" || classifyStage === "failed" ? "analyzing" : classifyStage)
    : status === "ready"
    ? "ready"
    : status === "failed"
    ? "failed"
    : "idle";
  const errorMessage = selectedSuggestions?.error
    ? friendlyClassifyError(selectedSuggestions.error)
    : null;
  /* 미리보기에 보여줄 프레임. 우선순위:
     1) in-flight 중에는 classifyProgress.frames (실시간으로 sampling 직후
        채워지고, ready/failed 후에도 같은 메모리에 남는다)
     2) 분석이 이미 끝난 자료를 다시 열거나 자료 전환 후 돌아왔을 때는
        DB 의 ai_suggestions.sampled_frames thumbnail 로 폴백 — 영구 미리보기.
     ExtractedFrame 과 동일한 { t, mediaType, base64 } 구조라 SampleFramesPreview
     가 그대로 받는다(저장본은 가로 128px JPEG 다운스케일). */
  const storedFrames = (selectedSuggestions?.sampled_frames ?? []) as ExtractedFrame[];
  const liveFrames = classifyProgress?.frames ?? [];
  const previewFrames: ExtractedFrame[] = liveFrames.length > 0 ? liveFrames : storedFrames;
  const hasReadySuggestions = selectedSuggestions
    && !selectedSuggestions.error
    && (
      (selectedSuggestions.suggested_tags && selectedSuggestions.suggested_tags.length > 0)
      || (selectedSuggestions.mood_labels && selectedSuggestions.mood_labels.length > 0)
      || selectedSuggestions.scene_description
      || selectedSuggestions.visual_style
      || selectedSuggestions.brief_fit
      || selectedSuggestions.conti_use
      || selectedSuggestions.motion_notes
    );

  const runLabel = aiBusy
    ? t("library.inspector.working")
    : displayStage === "ready" || displayStage === "failed"
    ? t("library.inspector.reanalyze")
    : t("library.inspector.runAi");

  return (
    <>
      <div className="border border-border-subtle bg-surface-panel p-3" style={{ borderRadius: 0 }}>
        {/* 헤더 — "분류" 라벨 한 줄. 언어 토글은 카드 하단으로 옮겨, 시각
            중심이 Run / Re-analyze 버튼에 머물게 한다. */}
        <SectionLabel icon={<Sparkles className="h-3.5 w-3.5" />}>
          {t("library.inspector.classify")}
        </SectionLabel>

        {/* 3단계 progress stepper — idle 도 ghost 상태로 노출해 다음 단계
            기대를 미리 보여준다. video 와 animated raster(GIF/animated WebP
            /APNG) 모두 sampling 단계를 갖는다. */}
        <ClassifyStepper
          stage={displayStage}
          showSampling={isAnimated}
          progress={classifyProgress}
        />

        {/* Run AI / 재분석 — 카드의 1차 액션이라 full-width primary 버튼.
            오른쪽 모서리에 작게 붙어 있던 이전 위치는 stepper 와 hint 사이
            에서 시각 위계가 약했다. */}
        <Button
          className="mt-3 h-9 w-full text-meta font-semibold"
          style={{ borderRadius: 0 }}
          disabled={aiBusy}
          onClick={onClassify}
        >
          {aiBusy ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              {runLabel}
            </>
          ) : (
            <>
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              {runLabel}
            </>
          )}
        </Button>

        {/* 선택된 프레임 썸네일 — sampling 끝나는 순간부터 등장하고,
            analyzing/ready/failed 까지 같은 그리드를 유지한다. video 와
            animated raster 양쪽이 같은 형태의 sampled_frames 를 만든다. */}
        {isAnimated && previewFrames.length > 0 ? (
          <SampleFramesPreview frames={previewFrames} />
        ) : null}

        <div className="mt-3 text-2xs leading-relaxed text-muted-foreground">
          {isAnimated
            ? t("library.inspector.classifyVideoHint")
            : t("library.inspector.classifyVisualHint")}
        </div>

        {/* 표시 언어 토글 — 분석 *결과* 를 보는 언어. 분석을 다시 호출하지
            않고 LLM 응답에 들어있는 _ko parallel 으로 즉시 전환된다.
            카드 하단의 부가 컨트롤로 위치해 1차 액션(Run)과 시각 위계가
            겹치지 않게 한다. */}
        <div className="mt-3 flex items-center justify-between gap-2 border-t border-border-subtle/60 pt-3">
          <span className="text-2xs text-muted-foreground">
            {t("library.aiLanguage.displayLabel")}
          </span>
          <AiLanguageToggle disabled={aiBusy} />
        </div>
      </div>

      {/* 친화적 에러 박스 — 5분/200MB 같이 자주 나오는 케이스를 사람 말로
          치환해 보여준다. raw 메시지는 expand 안에 숨김. */}
      {displayStage === "failed" && errorMessage ? (
        <div
          className="mt-4 border border-destructive/40 bg-destructive/10 p-3 text-caption text-destructive"
          style={{ borderRadius: 0 }}
        >
          <div className="font-semibold">{t("library.inspector.aiFailed")}</div>
          <div className="mt-1">{errorMessage}</div>
        </div>
      ) : null}

      {hasReadySuggestions ? (
        <div className="mt-4 border border-border-subtle bg-surface-panel p-3" style={{ borderRadius: 0 }}>
          <div className="mb-3 flex items-center justify-between gap-2">
            <SectionLabel icon={<Sparkles className="h-3.5 w-3.5" />}>
              {t("library.inspector.aiSuggestions")}
              {selectedSuggestions?.classification_input === "text" ? (
                <span className="ml-1 text-2xs text-muted-foreground">{t("library.inspector.aiTextOnly")}</span>
              ) : null}
            </SectionLabel>
            <Button
              variant="outline"
              className="h-8 px-3 text-meta"
              style={{ borderRadius: 0 }}
              disabled={aiBusy}
              onClick={onAcceptSuggestions}
              title={t("library.inspector.acceptTooltip")}
            >
              {t("library.inspector.accept")}
            </Button>
          </div>
          {/* Tags / Mood / Analysis — 세 카테고리로 명확히 분리.
              ─ Tags(주제/스타일/기법/용도) → outline Badge. 태그 표시 언어는
                Settings 의 AI Tag Language 를 따르므로 displayLang 과 다른 축.
                "표시 KO, 태그 EN" 같은 조합을 그대로 반영한다.
              ─ Mood(감정/톤) → outline Badge (amber 색 제거, Heart 제거)
              ─ Analysis → visual_style / motion / brief_fit / conti_use 텍스트
              Accept 는 suggested_tags 만 머지 — 카테고리 의미와 동작이 일치.
              섹션 사이는 dim divider 로 끊어 시각 그루핑을 강화. */}
          {(() => {
            const tags = pickArrInLang(
              tagLang,
              selectedSuggestions?.suggested_tags,
              selectedSuggestions?.suggested_tags_ko,
            ).slice(0, 12);
            return tags.length > 0 ? (
              <div>
                <SectionLabel className="mb-2">{t("library.inspector.section.tags")}</SectionLabel>
                <div className="flex flex-wrap gap-1.5">
                  {tags.map((tag, i) => (
                    <Badge key={`tag-${i}-${tag}`} variant="outline" className="text-caption">{tag}</Badge>
                  ))}
                </div>
              </div>
            ) : null;
          })()}
          {(() => {
            /* 무드도 태그와 같은 축(Settings 의 AI Tag Language) 으로 표시한다.
               분석 본문(스타일/모션/Brief/Conti) 만 displayLang 을 따르고,
               태그/무드처럼 "사용자가 머지/검색 토큰으로 쓰는 라벨" 은 tag
               language 로 일관되게 묶는다. */
            const moods = pickArrInLang(
              tagLang,
              selectedSuggestions?.mood_labels,
              selectedSuggestions?.mood_labels_ko,
            ).slice(0, 8);
            return moods.length > 0 ? (
              <div className="mt-3 border-t border-border-subtle/60 pt-3">
                <SectionLabel className="mb-2">{t("library.inspector.section.mood")}</SectionLabel>
                <div className="flex flex-wrap gap-1.5">
                  {moods.map((mood, i) => (
                    <Badge
                      key={`mood-${i}-${mood}`}
                      variant="outline"
                      className="text-caption"
                    >
                      {mood}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null;
          })()}
          {/* 구조화된 인사이트 — Notes 가 사용자 전용으로 분리되었으므로
              visual_style / motion_notes / brief_fit / conti_use 는 여기 AI
              탭의 read-only 단일 진실원으로 머문다. Accept 버튼은 태그만
              머지하고 이 텍스트들은 ai_suggestions 안에 그대로 남는다.
              항목별 라벨은 별도 줄 + semibold 10px 로 끌어올려 본문과 시각
              위계를 분리한다 (이전 inline 표시는 "스타일:" 라벨이 본문에
              섞여 구분이 약했다). 이전엔 uppercase 까지 걸려 "고함치는"
              톤이었으나, 라이브러리 전반 톤 정리에 맞춰 케이스는 그대로
              유지하고 weight 와 색만으로 헤더 시그널을 만든다. */}
          {(() => {
            /* scene 은 *객관적 관찰* (style/motion 의 해석 텍스트와 의도적으로
               분리되는 별도 차원) 이라 항상 맨 위에 둔다 — 사용자가 AI 가
               자료에서 "무엇을 보았는지" 를 한눈에 검증할 수 있어야 한다. */
            const scene = pickStr(selectedSuggestions?.scene_description, selectedSuggestions?.scene_description_ko);
            const style = pickStr(selectedSuggestions?.visual_style, selectedSuggestions?.visual_style_ko);
            const motion = pickStr(selectedSuggestions?.motion_notes, selectedSuggestions?.motion_notes_ko);
            const brief = pickStr(selectedSuggestions?.brief_fit, selectedSuggestions?.brief_fit_ko);
            const conti = pickStr(selectedSuggestions?.conti_use, selectedSuggestions?.conti_use_ko);
            const items: { key: string; label: string; body: string }[] = [];
            if (scene) items.push({ key: "scene", label: t("library.inspector.section.scene"), body: scene });
            if (style) items.push({ key: "style", label: t("library.inspector.section.style"), body: style });
            if (motion) items.push({ key: "motion", label: t("library.inspector.section.motion"), body: motion });
            if (brief) items.push({ key: "brief", label: t("library.inspector.section.brief"), body: brief });
            if (conti) items.push({ key: "conti", label: t("library.inspector.section.conti"), body: conti });
            return items.length > 0 ? (
              <div className="mt-3 border-t border-border-subtle/60 pt-3">
                <SectionLabel className="mb-2">{t("library.inspector.section.analysis")}</SectionLabel>
                <div className="space-y-2.5">
                  {items.map((entry) => (
                    <div key={entry.key}>
                      <div className="text-2xs font-semibold tracking-normal text-muted-foreground">
                        {entry.label}
                      </div>
                      <div className="mt-1 text-caption leading-relaxed text-text-secondary">
                        {entry.body}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null;
          })()}
        </div>
      ) : displayStage === "idle" ? (
        <div
          className="mt-4 border border-dashed border-border-subtle bg-background p-4 text-center text-caption text-muted-foreground"
          style={{ borderRadius: 0 }}
        >
          {t("library.inspector.noSuggestionsYet")}
        </div>
      ) : null}
    </>
  );
}

interface ClassifyStepperProps {
  stage: ClassifyStage;
  showSampling: boolean;
  progress: ClassifyProgress | null;
}

/**
 * 3단계 progress stepper — Sample → Analyze → Done. idle 일 때도 ghost (회색
 * outline) 로 그려 다음에 무슨 일이 일어날지 보여준다. video 가 아니면 Sample
 * 단계는 생략된다 (이미지/URL 은 곧장 Analyze 부터 시작).
 *
 * 활성 단계는 spinner + 강조색, 완료 단계는 체크, 실패 지점은 X. 활성/완료
 * 단계 아래에는 동적인 detail (예: "Extracted 12/28 frames", "Scoring scenes…")
 * 을 한 줄로 표시해 사용자에게 무엇이 진행 중인지 명확히 전달한다.
 */
function ClassifyStepper({ stage, showSampling, progress }: ClassifyStepperProps) {
  const t = useT();
  const steps = useMemo(() => {
    const list: Array<{ id: ClassifyStage; label: string; Icon: typeof Sparkles }> = [];
    if (showSampling) list.push({ id: "sampling", label: t("library.inspector.stage.sample"), Icon: Film });
    list.push({ id: "analyzing", label: t("library.inspector.stage.analyze"), Icon: Sparkles });
    list.push({ id: "ready", label: t("library.inspector.stage.done"), Icon: CheckCircle2 });
    return list;
  }, [showSampling, t]);

  const order: ClassifyStage[] = ["sampling", "analyzing", "ready"];
  const failed = stage === "failed";
  const idle = stage === "idle";
  const currentIdx = idle || failed ? -1 : order.indexOf(stage);

  /* 실패한 자리 추론.
     - progress.stage 가 sampling/analyzing 이면 그대로 (실시간 catch 케이스).
     - progress.stage === "failed" 면 다음 휴리스틱으로 결정한다:
         · video 가 아니면 → analyzing (sampling 단계 자체가 없으므로).
         · video 인데 frames 가 이미 채워져 있으면 → sampling 은 끝났고
           analyzing(LLM 호출) 에서 실패한 것.
         · 그 외 → sampling 에서 실패. (대표적으로 "메타 5분 초과", "디코딩
           실패" 같은 sampleFramesWithSceneAwareness 단계 에러)
     이전 로직은 progress.stage === "failed" 일 때 무조건 sampling 으로
     fallback 해서, analyzing 단계의 "Empty AI response" 같은 에러도
     stepper 의 sampling 자리에 X 가 찍히는 버그가 있었다. */
  const failedAtIdx = failed
    ? order.indexOf((() => {
        if (progress?.stage === "sampling" || progress?.stage === "analyzing") {
          return progress.stage;
        }
        if (!showSampling) return "analyzing";
        const hasSampledFrames = (progress?.frames?.length ?? 0) > 0;
        return hasSampledFrames ? "analyzing" : "sampling";
      })())
    : -1;

  /* 활성 단계의 동적 부가 설명. ready/failed 일 때도 의미 있는 한 줄을 보여 줘
     stepper 가 비어 보이지 않게 한다. */
  const detailText = (() => {
    if (idle) {
      return showSampling
        ? t("library.inspector.detail.idleVideo")
        : t("library.inspector.detail.idleImage");
    }
    if (failed) {
      const failedStage = order[failedAtIdx] as ClassifyStage | undefined;
      if (failedStage === "sampling") return t("library.inspector.detail.failSampling");
      if (failedStage === "analyzing") return t("library.inspector.detail.failAnalyzing");
      return t("library.inspector.detail.failGeneric");
    }
    if (stage === "sampling") {
      if (progress?.scoringActive) return t("library.inspector.detail.scoring");
      const total = progress?.candidatesTotal ?? 0;
      const done = progress?.candidatesDone ?? 0;
      if (total > 0) {
        const targetSuffix = progress?.targetFrameCount && progress.targetFrameCount !== total
          ? t("library.inspector.detail.extractedTarget", { n: progress.targetFrameCount })
          : "";
        return t("library.inspector.detail.extracted", { done, total, targetSuffix });
      }
      if (progress?.targetFrameCount) return t("library.inspector.detail.preparingTarget", { n: progress.targetFrameCount });
      return t("library.inspector.detail.preparingVideo");
    }
    if (stage === "analyzing") {
      const n = progress?.targetFrameCount ?? progress?.frames?.length ?? 0;
      if (n === 1) return t("library.inspector.detail.sendingFramesOne");
      if (n > 1) return t("library.inspector.detail.sendingFrames", { n });
      return t("library.inspector.detail.sendingGeneric");
    }
    if (stage === "ready") return t("library.inspector.detail.ready");
    return null;
  })();

  /* 한 step 의 (노드 + 라벨) 을 같은 컬럼에 묶어 그린다.
     이전에는 노드를 한 줄(`flex items-center`), 라벨을 별도 줄
     (`flex justify-between`) 로 그렸는데, 라벨이 자신의 너비대로 좌/중/우
     배치되어 노드 중심과 라벨 중심이 어긋났다(특히 이미지 자료처럼 step 이
     2개일 때 좌/우 끝으로 라벨이 붙는 현상).
     수정: column wrapper 의 가로를 노드와 동일한 `w-7` 로 고정하고, 라벨은
     `whitespace-nowrap text-center` 로 노드 중심을 기준으로 양옆 overflow.
     connector 는 노드 vertical center 에 align 되도록 `mt-[14px]`(노드 h-7
     의 절반). 비디오/이미지 양쪽에서 동일하게 정렬된다. */
  return (
    <div className="mt-2">
      <div className="flex items-start">
        {steps.map((step, i) => {
          const stepIdx = order.indexOf(step.id);
          const isLast = i === steps.length - 1;
          /* stage === "ready" 는 "전체 완료" 를 의미한다 — 마지막 "Done"
             step 까지 모두 completed 로 떨어져야 하고, 어디에도 spinner 가
             남아 있으면 안 된다. 그래서 isActive 계산에서 "ready" 는 명시
             적으로 배제. (이게 빠져 있으면 Done 자리에 Loader2 가 영영
             돈다.) */
          const isActive =
            !idle && !failed && stage !== "ready" && stage === step.id;
          /* "ready" 단계 자체가 활성일 땐 모든 step 이 완료된 상태. */
          const isCompleted = !idle && !failed
            && (currentIdx > stepIdx || (stage === "ready" && stepIdx <= currentIdx));
          const isFailedHere = failed && stepIdx === failedAtIdx;
          const connectorActive = !idle && !failed && currentIdx > stepIdx;
          const nodeClass = isActive
            ? "border-primary bg-primary/15 text-primary"
            : isCompleted
            ? "border-primary/50 bg-primary/10 text-primary"
            : isFailedHere
            ? "border-destructive bg-destructive/15 text-destructive"
            : "border-border-subtle bg-background text-muted-foreground/70";
          const labelClass = isActive
            ? "text-foreground font-medium"
            : isCompleted
            ? "text-foreground/80"
            : isFailedHere
            ? "text-destructive font-medium"
            : "text-muted-foreground";

          return (
            <Fragment key={step.id}>
              <div className="flex w-7 shrink-0 flex-col items-center">
                <div
                  className={cn(
                    "relative flex h-7 w-7 items-center justify-center border transition-colors",
                    nodeClass,
                  )}
                  style={{ borderRadius: 999 }}
                >
                  {isActive ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : isFailedHere ? (
                    <XCircle className="h-3.5 w-3.5" />
                  ) : isCompleted ? (
                    /* 샘플링/분석/완료 모두 단일 `Check` 아이콘으로 통일.
                       이전에는 "완료" step 만 `CheckCircle2` (원 안에 또
                       체크) 라 다른 step 의 단일 `Check` 와 시각 톤이
                       달라 보였다. */
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <step.Icon className="h-3.5 w-3.5" />
                  )}
                </div>
                <span
                  className={cn(
                    "mt-1.5 whitespace-nowrap text-center text-2xs leading-none",
                    labelClass,
                  )}
                >
                  {step.label}
                </span>
              </div>
              {!isLast ? (
                <div
                  className={cn(
                    "mx-1.5 mt-[14px] h-px flex-1 transition-colors",
                    connectorActive ? "bg-primary/50" : "bg-border-subtle",
                  )}
                />
              ) : null}
            </Fragment>
          );
        })}
      </div>

      {detailText ? (
        <div
          className={cn(
            "mt-2 text-caption",
            failed ? "text-destructive" : idle ? "text-muted-foreground" : "text-text-secondary",
          )}
        >
          {detailText}
        </div>
      ) : null}
    </div>
  );
}

interface SampleFramesPreviewProps {
  frames: ExtractedFrame[];
}

/**
 * 분류에 실제로 사용된(또는 사용될) 프레임 N장을 4-column 그리드 썸네일로
 * 보여준다. 각 칸 하단에 영상 내 시점(예: 12.3s) 을 작게 표기.
 *
 * 데이터는 base64 PNG (768px 다운스케일) 이라 그리드에 그대로 박아도
 * 메모리 부담은 무시할 수준 (28장 * 100KB ≈ 2.8MB).
 */
function SampleFramesPreview({ frames }: SampleFramesPreviewProps) {
  const t = useT();
  if (!frames.length) return null;
  return (
    <div className="mt-3 border-t border-border-subtle/60 pt-3">
      <div className="mb-1.5 flex items-center justify-between text-2xs text-muted-foreground">
        <span>{t("library.inspector.selectedFrames")}</span>
        <span className="font-medium text-text-secondary">{frames.length}</span>
      </div>
      <div className="grid grid-cols-4 gap-1">
        {frames.map((frame, idx) => (
          <div
            key={`${idx}-${frame.t}`}
            className="relative aspect-video overflow-hidden border border-border-subtle bg-background"
            style={{ borderRadius: 0 }}
            title={t("library.inspector.frameAt", { time: frame.t.toFixed(2) })}
          >
            <img
              src={`data:${frame.mediaType};base64,${frame.base64}`}
              alt={t("library.inspector.frameAtAlt", { time: frame.t.toFixed(2) })}
              className="h-full w-full object-cover"
              loading="lazy"
              decoding="async"
            />
            <div className="absolute inset-x-0 bottom-0 bg-black/55 px-1 py-0.5 text-micro tabular-nums text-white">
              {frame.t.toFixed(1)}s
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface RatingStarsProps {
  value: number;
  onChange?: (value: number | null) => void;
}

/* Eagle 식 5개 별 — 호버 프리뷰 + 클릭 즉시 저장. 같은 값을 다시 클릭하면
   해제(0). 마우스가 영역을 벗어나면 hover 가 풀린다. */
function RatingStars({ value, onChange }: RatingStarsProps) {
  const t = useT();
  const [hover, setHover] = useState<number | null>(null);
  const display = hover ?? value;
  return (
    <div
      className="flex items-center gap-0.5"
      onMouseLeave={() => setHover(null)}
    >
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = n <= display;
        return (
          <button
            key={n}
            type="button"
            onMouseEnter={() => setHover(n)}
            onClick={() => {
              if (!onChange) return;
              onChange(value === n ? null : n);
            }}
            className={cn(
              "transition-colors",
              filled ? "text-primary" : "text-muted-foreground/40 hover:text-muted-foreground",
            )}
            aria-label={t("library.inspector.ratingN", { n })}
            disabled={!onChange}
          >
            <Star className={cn("h-3.5 w-3.5", filled && "fill-current")} />
          </button>
        );
      })}
    </div>
  );
}

interface TimestampNotesSectionProps {
  selected: ReferenceItem;
  videoRef: RefObject<HTMLVideoElement>;
  timestampText: string;
  onTimestampTextChange: (value: string) => void;
  onAddTimestampNote: (
    textOverride?: string,
    atOverride?: number,
    regionOverride?: import("@/lib/referenceLibrary").RegionRect,
    frameIndexOverride?: number,
  ) => void;
  /** v3 — atSec(영상) 또는 frameIndex(GIF) 둘 중 하나만 들어옴. 자료 종류에
   *  맞춰 큰 프리뷰가 자동 점프한다. */
  onJumpToTimestamp?: (atSec?: number, frameIndex?: number) => void;
  onDeleteTimestampNote?: (noteId: string) => void;
  onEditTimestampNote?: (noteId: string, text: string) => void;
}

/* TIMESTAMP NOTES — 인스펙터 우측 사이드바의 노트 목록 + 추가/편집/삭제
   + 호버 영상 프레임 미리보기. Eagle 의 Comments 패널 인터랙션을 거의 그
   대로 재현한다.

   - 호버 미리보기: 노트가 1개 이상이고 video 자료일 때만 단일 <video>
     를 미리 마운트해두고, 행에 호버할 때 currentTime 만 옮겨 재시크한다.
     매 호버마다 <video> 를 새로 만들면 다시 디코딩이 시작돼 첫 프레임이
     늦게 나오므로 필수. 미리보기는 React Portal 로 document.body 에 직접
     렌더링해 인스펙터의 overflow 클리핑 영역을 벗어나도록 한다(이렇게
     하지 않으면 좌측으로 튀어나간 박스의 일부만 잘려 보인다).
   - 위치 계산: 호버된 행의 viewport 좌표(getBoundingClientRect)를 기준
     으로 미리보기를 행의 LEFT 옆에 띄움. 좌측 공간이 부족하면(192px 미만)
     자동으로 RIGHT 측으로 폴백. 행 높이 중앙에 수직 정렬.
   - 인라인 편집: 행 본문(텍스트) 더블클릭 시 Input 으로 토글, Enter 또는
     blur 로 저장, Escape 로 취소. 빈 문자열로 저장하면 부모가 삭제로
     폴백 처리(handleEditTimestampNote 참고). */

const HOVER_PREVIEW_WIDTH = 192;
const HOVER_PREVIEW_GAP = 8;

interface HoverPreviewPos {
  top: number;
  left: number;
}

function TimestampNotesSection({
  selected,
  videoRef,
  timestampText,
  onTimestampTextChange,
  onAddTimestampNote,
  onJumpToTimestamp,
  onDeleteTimestampNote,
  onEditTimestampNote,
}: TimestampNotesSectionProps) {
  const t = useT();
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const [hoveredNoteId, setHoveredNoteId] = useState<string | null>(null);
  const [hoverPos, setHoverPos] = useState<HoverPreviewPos | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");

  const isGif = selected.kind === "gif";
  const isVideo = selected.kind === "video";
  /* Phase 4 — image / static webp 분기. 이 자료의 노트는 region anchored 만
     의미가 있고 시점/프레임 개념이 없다. label 은 BoxSelect 아이콘. */
  const isStillImage = selected.kind === "image" || selected.kind === "webp";

  /* 노트 목록 정렬 키 — 자료 종류에 따라 다름:
       video: atSec 오름차순(시간 순서)
       gif:   frameIndex 오름차순. frameIndex 가 없는(레거시) 노트는 atSec 또는
              0 으로 fallback 해 맨 위로 모인다.
       image: region 노트는 시점이 없으므로 입력 순서(timestamp_notes 배열의
              원본 순서) 그대로 — 별도 정렬 없음.
     atSec 이 없는 노트는 0 으로 취급해 맨 위로 모인다. */
  const sortedNotes = useMemo(() => {
    if (isStillImage) return [...selected.timestamp_notes];
    const sortKey = (note: { atSec?: number; frameIndex?: number }): number => {
      if (isGif) return note.frameIndex ?? note.atSec ?? 0;
      return note.atSec ?? 0;
    };
    return [...selected.timestamp_notes].sort((a, b) => sortKey(a) - sortKey(b));
  }, [selected.timestamp_notes, isGif, isStillImage]);

  const hoveredNote = useMemo(
    () => sortedNotes.find((note) => note.id === hoveredNoteId) ?? null,
    [hoveredNoteId, sortedNotes],
  );

  /* 호버된 노트가 바뀌면 미리보기 video 의 currentTime 만 갱신.
     metadata 가 아직 로드 안 됐으면(loadedmetadata 전) 한 번만 후속 시크.
     atSec 이 undefined 일 수 있어 fallback 0. */
  useEffect(() => {
    const v = previewVideoRef.current;
    if (!v || !hoveredNote) return;
    const target = Number.isFinite(hoveredNote.atSec) ? Number(hoveredNote.atSec) : 0;
    if (v.readyState >= 1) {
      try { v.currentTime = target; } catch { /* noop */ }
    } else {
      const onLoad = () => {
        try { v.currentTime = target; } catch { /* noop */ }
      };
      v.addEventListener("loadedmetadata", onLoad, { once: true });
      return () => v.removeEventListener("loadedmetadata", onLoad);
    }
  }, [hoveredNote]);

  const handleRowEnter = (noteId: string, event: React.MouseEvent<HTMLElement>) => {
    setHoveredNoteId(noteId);
    const row = event.currentTarget;
    const rect = row.getBoundingClientRect();
    /* 행의 좌측 우선. 좌측 공간이 좁으면 우측으로 폴백. */
    const wantLeft = rect.left - HOVER_PREVIEW_GAP - HOVER_PREVIEW_WIDTH;
    const left = wantLeft >= 8 ? wantLeft : rect.right + HOVER_PREVIEW_GAP;
    /* 미리보기 height 은 aspect-video(16:9) + caption 약 22px ≈ 130px.
       행의 수직 중심에 맞추되 viewport 상하단을 벗어나지 않게 clamp. */
    const approxHeight = (HOVER_PREVIEW_WIDTH * 9) / 16 + 22;
    let top = rect.top + rect.height / 2 - approxHeight / 2;
    top = Math.max(8, Math.min(window.innerHeight - approxHeight - 8, top));
    setHoverPos({ top, left });
  };

  const beginEdit = (noteId: string, currentText: string) => {
    setEditingId(noteId);
    setEditingText(currentText);
  };
  const cancelEdit = () => {
    setEditingId(null);
    setEditingText("");
  };
  const commitEdit = (noteId: string) => {
    if (!onEditTimestampNote) {
      cancelEdit();
      return;
    }
    onEditTimestampNote(noteId, editingText);
    cancelEdit();
  };

  /* hoveredNote 가 있고 자료가 video + file_url 보유 시에만 미리보기를
     띄움. opacity 토글로 자연스럽게 fade. */
  const previewVisible = Boolean(
    hoveredNote
    && hoverPos
    && selected.kind === "video"
    && selected.file_url,
  );

  /* Portal 대상 — SSR 호환 위해 document.body 가 있을 때만 렌더. */
  const portalTarget = typeof document !== "undefined" ? document.body : null;

  /* 섹션 제목 — 자료 종류에 따라 가장 자연스러운 단어 사용:
       video: "Timestamp Notes"
       gif:   "Frame Notes"
       image: "Region Notes" */
  const sectionTitle = isGif
    ? t("library.inspector.frameNotes")
    : isStillImage
      ? t("library.inspector.regionNotes")
      : t("library.inspector.timestampNotes");

  return (
    <div className="mt-5 border-t border-border-subtle pt-4">
      <SectionLabel className="mb-2">{sectionTitle}</SectionLabel>
      {isVideo ? (
        /* 입력박스 글자 크기는 인스펙터의 다른 본문 텍스트(11px)와 통일해
           섹션 헤더의 하위 컨텐츠라는 위계감을 살린다.
           ⚠ Input 컴포넌트(src/components/ui/input.tsx) 의 base 클래스가
           `text-base md:text-sm` 라 md+ 에서는 `md:text-sm`(14px) 가 우리
           `text-caption` 을 덮어쓴다(modifier scope 가 달라 tailwind-merge 도
           양쪽을 보존). 데스크톱(앱은 사실상 항상 md+)에서 11px 가 적용되도록
           `md:text-caption` 을 명시해 base 의 md:text-sm 을 무력화한다. */
        <div className="flex gap-2">
          <Input
            value={timestampText}
            onChange={(event) => onTimestampTextChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onAddTimestampNote();
              }
            }}
            placeholder={t("library.inspector.noteAt", { time: formatDuration(videoRef.current?.currentTime ?? 0) })}
            className="h-8 text-caption md:text-caption"
          />
          <Button variant="outline" className="h-8 px-3 text-caption" style={{ borderRadius: 0 }} onClick={() => onAddTimestampNote()}>
            {t("common.add")}
          </Button>
        </div>
      ) : null /* image / gif 는 인스펙터 정적 썸네일 위에서 직접 추가가
                   불가능하지만, 큰 프리뷰의 region/note 토글 흐름이 이미 자명해
                   별도 안내 dashed div 를 두지 않는다. 빈 상태일 땐 섹션
                   헤더만 보이고 본문 영역은 그대로 비워둔다 — placeholder
                   문구가 헤더보다 시각적으로 더 강하게 보여 위계감을 무너뜨리는
                   문제를 피한다. */}

      {/* Portal 로 띄운 호버 미리보기 — 인스펙터의 overflow 영역과 무관
          하게 viewport 좌표(fixed)로 위치 잡힘. 노트가 있는 동안 상시
          마운트해 두고 opacity 만 토글해 첫 프레임 디코딩 지연을 회피. */}
      {portalTarget && selected.kind === "video" && selected.file_url && selected.timestamp_notes.length > 0
        ? createPortal(
          <div
            className={cn(
              "pointer-events-none fixed z-[60] border border-border-subtle bg-background shadow-xl transition-opacity",
              previewVisible ? "opacity-100" : "opacity-0",
            )}
            style={{
              borderRadius: 0,
              top: hoverPos?.top ?? 0,
              left: hoverPos?.left ?? 0,
              width: HOVER_PREVIEW_WIDTH,
            }}
          >
            <video
              ref={previewVideoRef}
              src={selected.file_url}
              poster={selected.thumbnail_url ?? undefined}
              muted
              preload="metadata"
              playsInline
              className="block aspect-video w-full bg-black object-contain"
            />
            {hoveredNote ? (
              <div className="border-t border-border-subtle bg-surface-panel px-2 py-1 text-center font-mono text-2xs">
                {formatDuration(hoveredNote.atSec)}
              </div>
            ) : null}
          </div>,
          portalTarget,
        )
        : null}

      <div className="relative mt-2 space-y-1.5">

        {sortedNotes.length > 0 ? sortedNotes.map((note) => {
          const isEditing = editingId === note.id;
          const hasRegion = Boolean(note.region);
          /* 자료 종류별 라벨 / 점프 인자:
             - video: `mm:ss` + jump(atSec)
             - gif:   `#N` + jump(undefined, frameIndex). frameIndex 가 없는
                      레거시 GIF 노트는 atSec 으로 fallback (큰 프리뷰가 알아서
                      atSec 기반 점프 처리하지만, GIF 는 atSec 매핑이 없어 0
                      프레임으로 점프됨 — 사용자가 redo 하면 frameIndex 가 박힘).
             - image: 시점 라벨 자리에 BoxSelect 아이콘. 점프 인자 없음
                      (큰 프리뷰는 항상 region 을 표시하므로 단순히 previewMode
                      를 켜기만 한다 — handleJumpToTimestamp 가 둘 다 undefined
                      일 땐 setPreviewMode 만 처리하도록 부모에서 분기됨, 단
                      현재는 그 케이스가 명시적으로 처리되지 않으니 아무것도
                      안 일어나도 OK — 사용자가 자료 클릭으로 자연스레 진입함). */
          const jump = () => {
            if (isStillImage) {
              /* image: 시점 점프 인자가 없어 부모가 무시 — 별도 동작 없음.
                 사용자가 행을 클릭해도 큰 프리뷰가 자동으로 안 켜지므로,
                 자료 카드를 더블클릭해 큰 프리뷰로 진입하도록 안내(title). */
              return;
            }
            if (isGif) onJumpToTimestamp?.(undefined, note.frameIndex);
            else onJumpToTimestamp?.(note.atSec);
          };
          const labelTitle = isStillImage
            ? t("library.inspector.regionNoteOpen")
            : isGif
              ? t("library.inspector.jumpToFrame", { n: (note.frameIndex ?? 0) + 1 })
              : t("library.inspector.jumpToTime", { time: formatDuration(note.atSec) });
          return (
            <div
              key={note.id}
              className="group relative flex items-center border border-border-subtle bg-surface-panel transition-colors hover:bg-muted/40"
              style={{ borderRadius: 0 }}
              onMouseEnter={(event) => handleRowEnter(note.id, event)}
              onMouseLeave={() => setHoveredNoteId(null)}
            >
              {/* 라벨 — video/gif 노트는 시간/프레임 텍스트(+ region 이 있으면
                  BoxSelect 인디케이터). still image 는 섹션 헤더가 이미
                  "Region Notes" 라 행마다 표시할 라벨 자체가 중복이고, image
                  의 jump 도 no-op 이라 라벨 셀 전체를 렌더하지 않는다 — 텍스트
                  가 행 시작 위치에서 바로 시작.
                  라벨/본문 둘 다 같은 `leading-tight` (1.25) + `flex items-center`
                  로 정렬. `leading-none` 을 쓰면 line-box 가 font-size 와 같아져
                  descender('g','y','p') 가 truncate 의 overflow:hidden 박스 밖으로
                  잘리고, 라벨에만 `translate-y-[1px]` 같은 보정을 넣으면 본문과
                  세로 정렬이 어긋난다(시간이 살짝 아래로 보이던 원인). */}
              {!isStillImage ? (
                <button
                  type="button"
                  onClick={jump}
                  className="flex h-7 shrink-0 items-center gap-1 px-2 text-caption leading-tight tabular-nums text-primary"
                  title={labelTitle}
                  style={{ borderRadius: 0 }}
                >
                  <span>{isGif
                    ? (note.frameIndex !== undefined ? `#${note.frameIndex + 1}` : "#?")
                    : formatDuration(note.atSec)}</span>
                  {hasRegion ? (
                    <BoxSelect
                      className="h-3 w-3 text-primary"
                      aria-label={t("library.inspector.hasRegion")}
                    />
                  ) : null}
                </button>
              ) : null}
              {isEditing ? (
                <Input
                  autoFocus
                  value={editingText}
                  onChange={(event) => setEditingText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitEdit(note.id);
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      cancelEdit();
                    }
                  }}
                  onBlur={() => commitEdit(note.id)}
                  className={cn(
                    "h-7 flex-1 border-0 bg-transparent text-caption focus-visible:ring-0",
                    isStillImage ? "px-2" : "px-1",
                  )}
                />
              ) : (
                <button
                  type="button"
                  onClick={jump}
                  onDoubleClick={() => onEditTimestampNote && beginEdit(note.id, note.text)}
                  className={cn(
                    "flex h-7 min-w-0 flex-1 items-center text-left text-caption leading-tight text-text-secondary",
                    /* still image 행은 라벨 셀이 없으니 텍스트가 행 좌측에서
                       2 만큼 들여쓰기 — video/gif 행의 라벨 px-2 와 시각적
                       정렬을 맞춘다. */
                    isStillImage ? "px-2" : "px-1",
                  )}
                  title={onEditTimestampNote ? t("library.inspector.clickSeekDouble") : labelTitle}
                  style={{ borderRadius: 0 }}
                >
                  {/* `truncate` 의 overflow:hidden 이 line-box 만큼만 보여주기
                     때문에, descender 가 line-box 아래로 1~2px 삐져나가는 폰트
                     에서는 'g'/'y'/'p' 의 꼬리가 잘린다. `leading-tight` 로
                     line-box 에 여유를 두는 것 + py-[1px] 로 한 픽셀 더 확보해
                     안전하게 살린다(들여쓰기는 px-* 로 별도 관리되므로 여기는
                     세로 패딩만). */}
                  <span className="block truncate py-px">{note.text}</span>
                </button>
              )}
              {/* 행 우측 액션 — 호버 시에만 노출. 편집 모드일 땐 X 만 노출
                  하면 입력 중 잘못 눌릴 위험이 있어 모두 숨긴다. */}
              {!isEditing ? (
                <div className="flex shrink-0 items-center gap-0.5 pr-1 opacity-0 transition-opacity group-hover:opacity-100">
                  {onEditTimestampNote ? (
                    <button
                      type="button"
                      onClick={() => beginEdit(note.id, note.text)}
                      className="flex h-6 w-6 items-center justify-center text-muted-foreground hover:text-foreground"
                      title={t("library.inspector.editNote")}
                      aria-label={t("library.inspector.editNoteAria")}
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                  ) : null}
                  {onDeleteTimestampNote ? (
                    <button
                      type="button"
                      onClick={() => onDeleteTimestampNote(note.id)}
                      className="flex h-6 w-6 items-center justify-center text-muted-foreground hover:text-destructive"
                      title={t("library.inspector.deleteNote")}
                      aria-label={t("library.inspector.deleteNoteAria")}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        }) : null /* 빈 상태 placeholder("No region notes yet" 등) 는
                       섹션 헤더보다 시각적으로 강하게 보여 위계가 어긋나는
                       이슈가 있어 렌더하지 않는다 — 노트가 없으면 본문 영역
                       자체가 비어 있는 것이 가장 깔끔. */}
      </div>
    </div>
  );
}
