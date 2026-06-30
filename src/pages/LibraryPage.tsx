import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type MouseEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useSettingsModal } from "@/lib/settingsModal";
import { Star, Plus, X, HardDrive, FolderInput, Settings as SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type Modifier,
} from "@dnd-kit/core";
import { getEventCoordinates } from "@dnd-kit/utilities";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { BrandLogo } from "@/components/common/BrandLogo";
import { TopbarToastCarveOut } from "@/components/common/TopbarToastCarveOut";
import { useActiveWorkspaceName } from "@/lib/workspaceLabel";
import { activateWorkspace, ensureWorkspacesLoaded, getCachedActive, getCachedActiveId } from "@/lib/workspaceClient";
import {
  clearPendingPackPath,
  packKindFromPath,
  readPendingPackPath,
  subscribePendingPack,
} from "@/lib/packOpen";
import { WindowControls } from "@/components/common/WindowControls";
import { useT, useUiLanguage } from "@/lib/uiLanguage";
import {
  getAiOutputLanguageMode,
  getAiTagLanguageMode,
  resolveAiOutputLanguage,
  resolveAiTagLanguage,
  setAiOutputLanguageMode,
  subscribeAiOutputLanguage,
  type AiOutputLanguage,
  type AiOutputLanguageMode,
  type AiTagLanguageMode,
} from "@/lib/aiOutputLanguage";
import { SidebarResizeHandle } from "@/components/SidebarResizeHandle";
import { usePageActive } from "@/components/PageShell";
import {
  DEFAULT_LIBRARY_INSPECTOR_WIDTH,
  DEFAULT_LIBRARY_SIDEBAR_WIDTH,
  LIBRARY_INSPECTOR_WIDTH_CHANGED_EVENT,
  LIBRARY_SIDEBAR_WIDTH_CHANGED_EVENT,
  clampLibraryInspectorWidth,
  clampLibrarySidebarWidth,
  readLibraryInspectorWidth,
  readLibrarySidebarWidth,
  saveLibraryInspectorWidth,
  saveLibrarySidebarWidth,
} from "@/lib/libraryPreferences";
import { EagleImportDialog } from "@/components/library/EagleImportDialog";
import { LibraryAddMenu } from "@/components/library/LibraryAddMenu";
import { LibraryPreviewPanel } from "@/components/library/LibraryPreviewPanel";
import type { GifExportOptions } from "@/lib/gifExportPreferences";
import {
  LibrarySidebar,
  type LibraryFilterRow,
  type LibraryFolderRow,
  type QuickFilter,
} from "@/components/library/LibrarySidebar";
import { DuplicateMergeDialog } from "@/components/library/DuplicateMergeDialog";
import { ExportPackDialog } from "@/components/library/ExportPackDialog";
import { HtmlExportDialog } from "@/components/library/HtmlExportDialog";
import { FolderAiSettingsDialog } from "@/components/library/FolderAiSettingsDialog";
import { FolderDeleteDialog } from "@/components/library/FolderDeleteDialog";
import {
  listFolderAiSettings,
  removeFolderAiSettings,
  renameFolderAiSettings,
  subscribeFolderAiSettings,
  type FolderAiSettings as FolderAiSettingsType,
} from "@/lib/folderAiSettings";
import { enqueueClassify, isItemEnqueued, subscribeClassifyQueue, type ClassifyQueueSnapshot } from "@/lib/classifyQueue";
import { lookupSeedKoTag, mergeUserTagAliasIntoAi } from "@/lib/libraryAiBackfill";
import { FolderEditDialog } from "@/components/library/FolderEditDialog";
import { FolderPickerDialog } from "@/components/library/FolderPickerDialog";
import { LibraryGrid } from "@/components/library/LibraryGrid";
import { LibraryInspector } from "@/components/library/LibraryInspector";
import { BriefMatchFlyout } from "@/components/library/BriefMatchFlyout";
import { KoreanSuggestRow } from "@/components/library/KoreanSuggestRow";
import {
  containsHangul,
  hashInventory as hashKoreanInventory,
  rememberKoreanQuery,
  suggestEnglishTagsForKorean,
  type KoreanSuggestSpec,
  type SuggestionInventory,
} from "@/lib/koreanSearchSuggest";
import {
  buildKoreanTagAliasIndex,
  type KoreanTagAliasIndex,
} from "@/lib/koreanTagAliasIndex";
import { KOREAN_TAG_SEED } from "@/lib/koreanTagSeedDictionary";
import {
  readKoreanAliasOverrides,
  koreanAliasOverridesToSeedEntries,
  mergeKoreanAliasOverrides,
  getExpandedEnSet,
  readKoreanAliasAutoExpand,
  KOREAN_ALIAS_OVERRIDES_CHANGED_EVENT,
  KOREAN_ALIAS_OVERRIDES_KEY,
} from "@/lib/koreanTagAliasOverrides";
import {
  buildReferenceTokenInventory,
  buildReferenceTokenIdf,
  scoreReferences,
  type BriefSignals,
} from "@/lib/referenceRecommender";
import { type MoodFilterSpec } from "@/lib/moodSearch";
import { rerankReferencesForBrief } from "@/lib/briefReferenceRerank";
import { LibraryCanvas } from "@/components/library/LibraryCanvas";
import { OrphanCleanupDialog } from "@/components/library/OrphanCleanupDialog";
import { PackImportDialog } from "@/components/library/PackImportDialog";
import { PasteUrlDialog } from "@/components/library/PasteUrlDialog";
import { PromoteToAssetDialog } from "@/components/library/PromoteToAssetDialog";
import { RenameReferenceDialog } from "@/components/library/RenameReferenceDialog";
import { VariationFlyout, type VariationSubmit, type VariationInjectedRef } from "@/components/library/VariationFlyout";
import {
  EMPTY_NOTE_FILTER,
  LibraryToolbar,
  aspectBuckets,
  emptyMulti,
  matchMulti,
  matchMultiAny,
  multiFilterActive,
  type LibrarySortKey,
  type LibrarySortOrder,
  type LibraryViewMode,
  type MultiFilter,
  type NoteFilterState,
  type RatingValue,
  type ShapeValue,
} from "@/components/library/LibraryToolbar";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { importEagleLibrary, pickLibraryFolder, scanLibraryFolder, selectEagleLibrary, type EagleImportResult, type EaglePreview } from "@/lib/eagleImport";
import { addUserFolderPath, getUserFolderPaths, normalizeLibraryFolderPath, removeUserFolderPath, renameUserFolderPath } from "@/lib/folderCache";
import {
  cascadeDeleteFolderPrefs,
  cascadeRenameFolderPrefs,
  getAllFolderMeta,
  getFolderMeta,
  setFolderMeta,
} from "@/lib/folderPreferences";
import {
  cascadeDeleteFolderManualOrder,
  cascadeRenameFolderManualOrder,
  getAllFolderManualOrder,
  getFolderSiblingOrder,
  parentPathOf,
  reorderFoldersBefore,
  reorderFoldersAfter,
  setFolderSiblingOrder,
} from "@/lib/folderManualOrder";
import {
  cascadeDeleteCanvasLayout,
  cascadeDuplicateCanvasLayout,
  cascadeRenameCanvasLayout,
} from "@/lib/canvasLayout";
import type { PackPreview, PackScope } from "@/lib/preflowPack";
import { previewPackFromPath } from "@/lib/preflowPackClient";
import { acceptReferenceAiSuggestions, expandEnTagsToKorean, friendlyClassifyError, type ClassifyProgress, type ClassifyStage, type ReferenceAiSuggestions } from "@/lib/referenceAi";
import { setLibraryDropHandlers } from "@/lib/libraryDragChannel";
import { BRIEF_MATCH_ROOT, createProjectFromPending, isBriefMatchPath } from "@/lib/briefMatch";
import {
  getBriefMatchEntry,
  setBriefMatchEntry,
  hasBriefContent,
  cascadeRenameBriefMatchEntries,
  cascadeDuplicateBriefMatchEntries,
  cascadeDeleteBriefMatchEntries,
  BRIEF_MATCH_STORE_CHANGED_EVENT,
  type BriefMatchEntry,
} from "@/lib/briefMatchStore";
import {
  getBriefMatchImages,
  setBriefMatchImages,
  cascadeRenameBriefMatchImages,
  cascadeDuplicateBriefMatchImages,
  cascadeDeleteBriefMatchImages,
  type BriefImage,
} from "@/lib/briefMatchImageStore";
import { setPendingBriefMatchProject } from "@/lib/pendingBriefMatchProject";
import {
  BriefMatchExportDialog,
  type BriefMatchExportResult,
} from "@/components/library/BriefMatchExportDialog";
import { getStorageUsage, previewOrphanCleanup, type StorageUsage } from "@/lib/storageMaintenance";
import { cn } from "@/lib/utils";
import {
  MANUAL_ORDER_CHANGED_EVENT,
  deriveLibraryContextKey,
  getManualOrder,
  manualOrderIndex,
  reorderManyBefore,
  setManualOrder,
} from "@/lib/manualOrder";
import {
  GRID_HIDDEN_CHANGED_EVENT,
  loadGridHidden,
  saveGridHidden,
} from "@/lib/gridHiddenPreference";
import {
  PALETTE_UPDATED_EVENT,
  type PaletteUpdatedDetail,
} from "@/lib/colorPalette";
import { COLOR_FILTER_THRESHOLD, scoreItemByColor } from "@/lib/colorMatch";
import { scheduleThumbnailAutoBackfill } from "@/lib/thumbnailAutoBackfill";
import { scheduleAnimatedPreviewAutoBackfill } from "@/lib/animatedPreviewAutoBackfill";
import type { ThumbnailBackfillItemEvent, AnimatedPreviewBackfillItemEvent } from "@/lib/referenceLibrary";
import {
  addReferencesToFolder,
  backfillReferencePalettes,
  createLinkReference,
  deleteReference,
  createVariation,
  deleteFolder,
  duplicateFolder,
  duplicateReference,
  folderTag,
  getReferenceUsageCounts,
  linkReferenceToProject,
  listSavedFilters,
  listReferences,
  mergeReferences,
  moveReferencesToFolder,
  moveReferenceToTrash,
  getImageSearchSourceUrl,
  searchByImage,
  downloadImageAsReference,
  normalizeFolderPath,
  openReferenceWithDefaultApp,
  openReferenceSourceUrl,
  regenerateReferenceThumbnail,
  removeReferencesFromFolder,
  renameFolder,
  resolveReferenceFilePath,
  restoreReference,
  saveCanvasFrameAsReference,
  saveCroppedImageAsNewReference,
  overwriteReferenceImage,
  saveVideoFrameAsReference,
  setReferenceCoverFromBlob,
  setReferenceCoverFromCanvas,
  setReferenceCoverFromVideo,
  showReferenceInFolder,
  toggleReferencePin,
  updateReference,
  uploadReferenceFile,
  detectDocSubtype,
  referenceToRefItem,
  buildAnnotationFromLibrary,
  withReferenceVersion,
  type ReferenceItem,
  type ReferenceKind,
  type RegionRect,
  type SavedFilter,
  type TimestampNote,
  type UploadReferenceOptions,
} from "@/lib/referenceLibrary";
import { docSubtypeOf } from "@/lib/docPresentation";
import { DEFAULT_IMAGE_SEARCH_ENGINE, type ImageSearchEngineId } from "@/lib/imageSearchEngines";
import { CONVERT_CANCELLED_FLAG, REFERENCE_UPLOAD_MAX_BYTES, VIDEO_CONVERT_TARGET_BYTES, VIDEO_CONVERT_THRESHOLD_BYTES } from "@shared/constants";
import { MAX_DURATION_SEC } from "@/lib/videoFrames";
import { probeVideoMeta, transcodeVideoFile, TranscodeCancelledError } from "@/lib/videoTranscode";
import { VideoConvertDialog } from "@/components/library/VideoConvertDialog";
import { attachLibraryItemToProject, type AttachTarget } from "@/lib/attachLibraryItemToProject";
import { appendAgentChatImages, CHAT_IMAGE_MAX, type ChatImage } from "@/components/agent/agentTypes";
import { buildAgentAttachmentForRef } from "@/lib/agentAttach";
import { appendLibraryRefItemToProject } from "@/components/BriefTab";
import { appendCompareLibraryEntries, makeCompareLibraryEntry } from "@/lib/compareLibraryStore";
import { ProjectPickerDialog } from "@/components/library/ProjectPickerDialog";
import { getRecentProjects } from "@/lib/recentProjectsCache";
import {
  mergeUsageCounts,
  scanAllUsageFromLocalStorage,
  recordPromotedRefUsage,
  countPromotedAssetsForRef,
  type BriefRefUsageLocation,
} from "@/lib/briefRefUsageScan";
import { extensionFromItem } from "@/lib/linkPlatform";
import { computeTypeCounts, matchTypeFilter } from "@/lib/typeFilter";

const REFERENCE_LOAD_LIMIT = 10_000;

/* ── Library 진입 캐시 ──────────────────────────────────────────────
 * DashboardPage 의 dashboardCache 와 같은 패턴. listReferences 는
 * `select("*")` + limit 10_000 + includeTrashed:true 라 cold start 비용이
 * 크고, 사용자가 Dashboard ↔ Library 를 반복 전환할 때마다 빈 그리드 →
 * 거대한 setState 단발 페인트가 끊김으로 체감된다. 모듈-레벨 + session
 * storage 양쪽에 저장해 같은 세션 내 재진입 시 첫 페인트를 즉시 그리고
 * 백그라운드에서 refetch → diff 로 합류시킨다.
 *
 * - 같은 윈도우 내: module-level 변수 → 0ms 접근
 * - 새 윈도우 / 리로드: sessionStorage 에서 1회 hydrate
 * - 영구화 X (localStorage): 휴지통 정책 / 권한 변경 등이 누적 stale 되는
 *   사고를 피하기 위해 세션 한정. */
const LIBRARY_CACHE_KEY = "preflow.library.cache.v1";
/** 캐시 TTL — 같은 세션 안에서 Dashboard ↔ Library 왕복이 잦은 패턴을
 *  타깃. 30초 이내 재진입은 supabase 재요청 자체를 skip 해 setItems(rows)
 *  로 인한 9개 useMemo cascade(filteredItems / activeItems / counts /
 *  linkPlatformCounts / folders / tagsList / duplicateCounts / dragSourceById /
 *  justifiedRows) 를 통째로 회피한다. 외부에서 라이브러리 콘텐츠가 바뀔
 *  현실적 빈도를 고려해 30초가 jank 제거 vs 신선도 사이의 균형점.
 *
 *  TTL 우회는 항상 가능: 사용자 mutation(업로드/삭제/이동/이름변경/팔레트
 *  backfill 도착 등) 이 발생하면 mutation 핸들러들이 별도 setItems 로
 *  로컬 갱신 + writeLibraryCache 가 따라잡으므로, "캐시가 stale" 인 채로
 *  사용자 의도와 어긋나는 시나리오는 발생하지 않는다. */
const LIBRARY_CACHE_TTL_MS = 30_000;
/** 캐시 엔트리는 어느 워크스페이스의 데이터인지를 함께 기록한다.
 *  활성 워크스페이스가 전환된 직후 옛 데이터가 새 워크스페이스의 첫
 *  페인트에 묻어 나오는 사고(50개 reference 가 잘못 표시되고 thumbnail
 *  fetch 가 다른 워크스페이스의 storage 경로로 날아가 404 폭주) 를
 *  workspaceId 비교 한 줄로 차단한다. */
type LibraryCache = { workspaceId: string; items: ReferenceItem[]; loadedAt: number };
let libraryCache: LibraryCache | null = null;

const readLibraryCache = (): LibraryCache | null => {
  // 활성 워크스페이스 ID 가 아직 로딩되지 않았으면 캐시도 사용하지 않는다.
  // "잘못된 데이터로 첫 페인트" 보다 "잠시 빈 그리드 후 진짜 데이터" 가
  // 항상 더 정직.
  const activeId = getCachedActiveId();
  if (!activeId) return null;

  if (libraryCache && libraryCache.workspaceId === activeId) return libraryCache;
  // 다른 워크스페이스의 in-memory 캐시는 즉시 폐기 — SPA navigate 만으로
  // 모듈 전역이 살아남는 경로(예: <Navigate /> redirect) 에서도 안전.
  if (libraryCache && libraryCache.workspaceId !== activeId) libraryCache = null;

  try {
    const raw = sessionStorage.getItem(LIBRARY_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LibraryCache>;
    if (!Array.isArray(parsed?.items)) return null;
    if (parsed.workspaceId !== activeId) {
      // 다른 워크스페이스의 sessionStorage 캐시는 정리해 둔다 — 다음 진입
      // 시 stale read 가 아예 발생하지 않게.
      sessionStorage.removeItem(LIBRARY_CACHE_KEY);
      return null;
    }
    libraryCache = {
      workspaceId: parsed.workspaceId,
      items: parsed.items,
      loadedAt: parsed.loadedAt ?? Date.now(),
    };
    return libraryCache;
  } catch {
    return null;
  }
};

const writeLibraryCache = (items: ReferenceItem[]): void => {
  const activeId = getCachedActiveId();
  // 활성 워크스페이스가 아직 미로딩이면 캐시 write 를 보류 — 잘못된 scope
  // 로 저장돼 다음 진입의 첫 페인트가 오염되는 것을 막는다.
  if (!activeId) return;
  libraryCache = { workspaceId: activeId, items, loadedAt: Date.now() };
  try {
    sessionStorage.setItem(LIBRARY_CACHE_KEY, JSON.stringify(libraryCache));
  } catch {
    // Cache is best-effort only — quota exceeded / private mode 등 무시.
  }
};

/** requestIdleCallback fallback. Electron(Chromium) 은 모두 지원하지만
 *  안전하게 setTimeout 폴백을 둔다. timeout 은 최대 대기 상한. */
const runIdle = (cb: () => void, timeout = 1500): number => {
  const idle = (window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
  }).requestIdleCallback;
  if (idle) return idle(cb, { timeout });
  return window.setTimeout(cb, 0) as unknown as number;
};

const cancelIdle = (handle: number): void => {
  const cancel = (window as unknown as {
    cancelIdleCallback?: (id: number) => void;
  }).cancelIdleCallback;
  if (cancel) cancel(handle);
  else window.clearTimeout(handle);
};

/** 네비바 브레드크럼에 노출되는 Quick Filter 라벨. LibrarySidebar 의
 *  QUICK_FILTERS 와 "동일한 i18n 키" 를 가리켜, 좌측 사이드바 빠른 필터의
 *  네이밍을 단일 기준(single source) 으로 삼는다. 이렇게 하면 상단 표기와
 *  사이드바 표기가 절대 어긋나지 않고 1:1 로 매칭된다. */
const QUICK_FILTER_LABEL_KEYS: Record<QuickFilter, string> = {
  all: "library.sidebar.all",
  favorites: "library.sidebar.favorites",
  untagged: "library.sidebar.untagged",
  recentlyUsed: "library.sidebar.recentlyUsed",
  unclassified: "library.sidebar.unclassified",
  variations: "library.sidebar.variations",
  duplicates: "library.sidebar.duplicates",
  trash: "library.sidebar.trash",
};

type ExportDialogState = {
  scope: PackScope;
  scopeLabel: string;
  ids?: string[];
  folderTag?: string;
  projectId?: string | null;
  itemCount: number;
} | null;

/* HtmlExportDialog state — Export pack 과 구조는 같지만 viewer 패키지
 *  진입점이라 별도 슬롯으로 분리. ExportDialogState 와 달리 projectLinked
 *  scope 는 받지 않는다(viewer 공유 시나리오 아님). */
type HtmlExportDialogState = {
  scope: Exclude<PackScope, "projectLinked">;
  scopeLabel: string;
  ids?: string[];
  folderTag?: string;
  itemCount: number;
  /** 범위 내 아이템 file_size 합(바이트) — single-html 용량 사전 표기용. */
  sizeBytes?: number;
  /** 뷰어 폴더 트리를 한정할 폴더 경로 목록(다중 폴더 선택 또는 활성 폴더에서
   *  선택 export 시). 비면 항목들이 속한 모든 폴더가 트리에 노출된다. */
  folderScope?: string[];
} | null;

type FolderEditState = {
  mode: "create" | "rename";
  parentPath?: string | null;
  row?: LibraryFolderRow | null;
} | null;

type FolderPickerState = {
  mode: "add" | "move";
  item: ReferenceItem;
} | null;

type DuplicateMergeState = {
  keep: ReferenceItem;
  mergeItems: ReferenceItem[];
} | null;

/**
 * Windows / macOS 절대경로를 `file://` URL 로 변환. 메인 윈도가
 * `webSecurity: false` 이므로 별도 IPC 없이 `fetch` 가 직접 읽을 수 있다.
 * 경로 세그먼트는 encodeURIComponent 로 안전하게 인코딩 — 공백/한글/
 * 특수문자가 섞인 경로도 그대로 전달 가능. Windows 의 `C:` 같은 드라이브
 * 라벨은 인코딩 없이 보존해야 file:/// 가 깨지지 않는다.
 */
function pathToFileUrl(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  const encoded = normalized
    .split("/")
    .map((segment) => (/^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join("/");
  return normalized.startsWith("/") ? `file://${encoded}` : `file:///${encoded}`;
}

/** 크롭용 이미지 로더 — crossOrigin anonymous 로 받아 canvas tainting 을 피한다. */
function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image for cropping."));
    img.src = src;
  });
}

const FILENAME_MIME_MAP: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

/** Blob 의 type 이 비어 있을 때(특히 file:// fetch) 확장자로 보정. */
function guessMimeFromName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return FILENAME_MIME_MAP[ext] ?? "application/octet-stream";
}

/** Pre-Flow 자체 패키지 (.preflowlib / .preflowpack) 인지 확장자로 판별. */
function isPackFile(name: string): boolean {
  return /\.(preflowlib|preflowpack)$/i.test(name);
}

function formatBytes(value?: number | null): string {
  if (!value || !Number.isFinite(value)) return "Unknown";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

function parseTags(value: string): string[] {
  return [...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean))];
}

function tagCounts(items: ReferenceItem[], predicate: (tag: string) => boolean): LibraryFilterRow[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const tag of item.tags) {
      if (!predicate(tag)) continue;
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([id, count]) => ({ id, label: id, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Tags 칩용 확장 카운터 — `item.tags` 와 `ai_suggestions.suggested_tags`
 *  를 같은 카운트 공간에 합쳐 돌려준다.
 *
 *  설계:
 *    - 사용자 머지 태그: 입력 그대로의 case 를 보존해 row.id 로 사용 (기존
 *      `tagCounts` 동작 100% 호환). 사용자가 "Neon" 으로 단 적이 있으면
 *      picker 에 "Neon" 으로 노출되고, filter set 도 같은 case 로 들어가
 *      `matchMultiAny` 가 그대로 잡는다.
 *    - AI 제안 태그(`suggested_tags`): 항상 lowercase canonical (referenceAi.ts
 *      의 safeJson 가 강제). 사용자가 어디에서도 직접 머지하지 않은 토큰만
 *      별도 row 로 추가하고 source="ai" 로 마킹. 이 정보는 LibraryToolbar
 *      의 sparkle 마커로 노출된다.
 *    - 같은 토큰이 user / ai 양쪽에 존재하면 user row 에 카운트만 합산
 *      (자료 단위 dedup) — 두 row 로 갈라지는 UX 노이즈 방지.
 *    - 한글이 섞인 AI 토큰은 제외 — Tags 칩은 EN canonical 공간이며,
 *      한글 검색은 별도 koreanAliasIndex 가 다룬다.
 *
 *  per-item dedup 은 lowercase 키로 한다 — 같은 자료에서 user="Neon" 와
 *  ai="neon" 이 동시에 보고되면 사용자 토큰이 항상 우선되어 1 카운트만
 *  올라간다(자연스럽게 source="user" 로 귀결). */
function tagCountsWithAi(
  items: ReferenceItem[],
  predicate: (tag: string) => boolean,
): LibraryFilterRow[] {
  /* canonicalIds: lowercase → 사용자 머지 태그의 *원본 case* (없으면 미정).
     1차 패스에서 user-tag 의 case 만 모아 두고, 2차 패스에서 AI 토큰을
     합칠 때 같은 lowercase 가 user-tag 에 존재하면 그 case 로 카운트한다. */
  const userIdByLower = new Map<string, string>();
  for (const item of items) {
    for (const tag of item.tags) {
      if (!predicate(tag)) continue;
      const low = tag.toLowerCase();
      if (!userIdByLower.has(low)) userIdByLower.set(low, tag);
    }
  }

  /* row id → { count, source }. source 는 "처음 user 로 잡혔으면 user,
     끝까지 AI 로만 잡혔으면 ai" 의 monotonic 업데이트. */
  const cells = new Map<string, { count: number; source: "user" | "ai" }>();

  const bump = (id: string, source: "user" | "ai") => {
    const cell = cells.get(id);
    if (cell) {
      cell.count += 1;
      if (source === "user") cell.source = "user";
    } else {
      cells.set(id, { count: 1, source });
    }
  };

  for (const item of items) {
    /* 자료 단위 dedup — user 와 AI 가 같은 lowercase 토큰을 함께 갖고 있을 때
       1 카운트만 올라가고 source 는 user 로 굳어진다. */
    const seen = new Set<string>();
    for (const tag of item.tags) {
      if (!predicate(tag)) continue;
      const low = tag.toLowerCase();
      if (seen.has(low)) continue;
      seen.add(low);
      const id = userIdByLower.get(low) ?? tag;
      bump(id, "user");
    }
    const ai = item.ai_suggestions as Partial<ReferenceAiSuggestions> | null | undefined;
    const aiTags = ai?.suggested_tags;
    if (!Array.isArray(aiTags)) continue;
    for (const rawTag of aiTags) {
      if (typeof rawTag !== "string") continue;
      const trimmed = rawTag.trim();
      if (!trimmed) continue;
      /* AI 토큰은 EN canonical 만 노출 — 한글 토큰은 ai_suggestions_ko 에
         이미 별도로 들어가 있고, Tags 칩은 영어 토큰 공간이므로 한글이
         섞인 토큰은 picker 노이즈로 가지 않게 컷한다. */
      if (containsHangul(trimmed)) continue;
      const low = trimmed.toLowerCase();
      if (!predicate(low)) continue;
      if (seen.has(low)) continue;
      seen.add(low);
      const id = userIdByLower.get(low) ?? low;
      bump(id, "ai");
    }
  }

  return [...cells.entries()]
    .map(([id, { count, source }]) => ({ id, label: id, count, source }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Moods 칩용 카운터 — `ai.mood_labels` 와 `ai.mood_labels_ko` 평행 배열을
 *  자료 단위 dedup 으로 카운트한다.
 *
 *  단일 진실원 / 다국어 표시:
 *    - row.id = lowercase EN canonical. picker 의 filter set / matchMultiAny
 *      / koreanAliasIndex.lookupMoods 가 모두 같은 키 공간을 쓴다.
 *    - row.label = `tagLanguage` 가 "ko" 이고 평행 KO 가 존재하면 KO,
 *      그렇지 않으면 EN 그대로. 이렇게 하면 한국어 사용자에게는 자연스러운
 *      한국어 라벨이 보이지만 검색·매칭은 EN canonical 한 줄로 통일된다.
 *    - per-item dedup 은 lowercase 키. mood_labels 는 일반적으로 자료당
 *      2-4 개이므로 사실상 영향이 적지만 일관성을 위해 적용.
 *
 *  KO 라벨 매핑은 자료별로 다를 수 있다(같은 EN "tense" 에 대해 자료 A 는
 *  "긴장감", 자료 B 는 "긴장된" 으로 KO 가 다를 수 있음). 빈도가 가장 높은
 *  KO 라벨을 canonical 로 채택. */
function moodCountsList(
  items: ReferenceItem[],
  tagLanguage: AiOutputLanguage,
): LibraryFilterRow[] {
  /* enLow → { count, koByFreq } 로 누적. 같은 EN 라벨에 여러 KO 별칭이
     매핑될 수 있어 빈도 desc 로 canonical 을 결정한다. */
  const cells = new Map<
    string,
    { count: number; koByFreq: Map<string, number> }
  >();

  for (const item of items) {
    const ai = item.ai_suggestions as Partial<ReferenceAiSuggestions> | null | undefined;
    const labels = ai?.mood_labels;
    if (!Array.isArray(labels)) continue;
    const koLabels = Array.isArray(ai?.mood_labels_ko) ? ai!.mood_labels_ko! : [];

    const seen = new Set<string>();
    for (let i = 0; i < labels.length; i += 1) {
      const raw = labels[i];
      if (typeof raw !== "string") continue;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      /* 한글이 섞인 EN canonical 은 입력 오염 — referenceAi.ts 의 컨트랙트
         (canonical=영어) 위반이라 picker 에서는 컷한다. */
      if (containsHangul(trimmed)) continue;
      const enLow = trimmed.toLowerCase();
      if (seen.has(enLow)) continue;
      seen.add(enLow);

      let cell = cells.get(enLow);
      if (!cell) {
        cell = { count: 0, koByFreq: new Map<string, number>() };
        cells.set(enLow, cell);
      }
      cell.count += 1;

      const koRaw = i < koLabels.length ? koLabels[i] : undefined;
      if (typeof koRaw === "string") {
        const koTrim = koRaw.trim();
        /* parallel 컨트랙트가 깨지는 케이스 (KO 자리에 EN 만 들어옴) 는
           무시 — UI 에 잘못된 KO 라벨이 채택되면 사용자 혼란만 키운다. */
        if (koTrim && containsHangul(koTrim)) {
          cell.koByFreq.set(koTrim, (cell.koByFreq.get(koTrim) ?? 0) + 1);
        }
      }
    }
  }

  return [...cells.entries()]
    .map(([id, { count, koByFreq }]) => {
      let label = id;
      if (tagLanguage === "ko" && koByFreq.size > 0) {
        let bestKo = "";
        let bestFreq = -1;
        for (const [ko, freq] of koByFreq) {
          if (freq > bestFreq || (freq === bestFreq && ko.localeCompare(bestKo) < 0)) {
            bestKo = ko;
            bestFreq = freq;
          }
        }
        if (bestKo) label = bestKo;
      }
      return { id, label, count };
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function folderRows(items: ReferenceItem[], userFolderPaths: string[] = []): LibraryFolderRow[] {
  const counts = new Map(tagCounts(items, (tag) => tag.startsWith("folder:")).map((row) => [row.id, row.count]));
  for (const path of userFolderPaths) {
    if (path) counts.set(folderTag(path), counts.get(folderTag(path)) ?? 0);
  }
  // Sidebar 의 walk 알고리즘은 자식 행을 트리에 포함하려면 부모 행이
  // folderRows 에 함께 존재해야 한다. 깊은 폴더 태그(`folder:8/purple/2`)
  // 만 있고 중간 부모(`folder:8/purple`)가 어떤 아이템에도 안 잡혀
  // 있으면 그 가지 전체가 walk 에서 누락돼 사이드바에 안 보인다
  // (pack import recreate / 외부 sync 등에서 발생). 모든 ancestor
  // 경로를 count=0 placeholder 로 채워 트리가 끊기지 않게 한다.
  for (const tag of [...counts.keys()]) {
    const path = tag.replace(/^folder:/, "");
    const parts = path.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i += 1) {
      const ancestorTag = folderTag(parts.slice(0, i).join("/"));
      if (!counts.has(ancestorTag)) counts.set(ancestorTag, 0);
    }
  }
  // 폴더별 max(last_used_at) — Sidebar 의 "Recently used" 정렬 키.
  // 직속 항목만 본다(자손 합산은 호출 측 사이드바에서 합산 카운트와
  // 동일한 방식으로 계산할지 별도 결정). 단순 사용자 모델: "이 폴더
  // 자체가 최근에 사용됨" = 직속 항목이 최근에 사용됨.
  const lastUsed = new Map<string, string>();
  for (const item of items) {
    if (!item.last_used_at) continue;
    for (const tag of item.tags) {
      if (!tag.startsWith("folder:")) continue;
      const prev = lastUsed.get(tag);
      if (!prev || prev < item.last_used_at) {
        lastUsed.set(tag, item.last_used_at);
      }
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => {
      const path = tag.replace(/^folder:/, "");
      const parts = path.split("/").filter(Boolean);
      return {
        id: tag,
        count,
        tag,
        label: parts[parts.length - 1] ?? path,
        depth: Math.max(0, parts.length - 1),
        lastUsedAt: lastUsed.get(tag) ?? null,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function getSavedFilterTokens(filter: SavedFilter | null): string[] {
  if (!filter) return [];
  const queryText = JSON.stringify(filter.query ?? {}).toLowerCase();
  const tokens = new Set<string>();
  for (const match of queryText.matchAll(/"([^"]{2,80})"/g)) {
    const token = match[1].trim();
    if (!token || ["and", "or", "tags", "folders", "name", "ext", "kind", "type", "rule", "rules"].includes(token)) continue;
    tokens.add(token);
  }
  return [...tokens].slice(0, 16);
}

/* Item 의 *모든* 노트 본문을 하나의 문자열로 합친다.
 *
 *   - item.notes              — Inspector 의 "노트 추가" 본문(자료 전체에
 *                                딸린 자유 메모)
 *   - timestamp_notes[*].text — 영역 노트(이미지) / 타임스탬프 노트(영상)
 *                                / 프레임 노트(GIF) 의 본문. 세 종류 모두
 *                                같은 배열에 들어가고, 종류 구분은 atSec /
 *                                frameIndex / region 의 존재 여부로만 이루어
 *                                지므로 검색에서는 한꺼번에 합쳐도 무방.
 *   - timestamp_notes[*].rangeText — 사용자가 노트 행에 같이 적어둔 시간
 *                                범위 자유 텍스트("00:12-00:20" 같은 라벨).
 *                                이 자체로도 검색 의미가 있어 같이 흡수.
 *
 * 결과는 항상 lowercase. 노트가 하나도 없으면 빈 문자열을 반환해 호출
 * 측의 includes / trim 검사에서 자연스럽게 폴백되도록 한다. */
function gatherNoteText(item: ReferenceItem): string {
  const parts: string[] = [];
  if (item.notes) parts.push(item.notes);
  for (const note of item.timestamp_notes ?? []) {
    if (note.text) parts.push(note.text);
    if (note.rangeText) parts.push(note.rangeText);
  }
  return parts.join(" ").toLowerCase();
}

function matchesSavedFilter(item: ReferenceItem, filter: SavedFilter | null): boolean {
  const tokens = getSavedFilterTokens(filter);
  if (tokens.length === 0) return true;
  const haystack = [
    item.title,
    item.kind,
    item.mime_type,
    item.notes,
    item.source_url,
    ...item.tags,
    /* 노트 검색은 자료 본문 메모뿐 아니라 영역/타임스탬프/프레임 노트
       본문까지 포함 — Saved Filter 도 그리드 검색과 동일한 범위로
       매칭한다(사용자가 저장한 검색식이 같은 자료를 동일하게 잡아
       내야 자연스럽다). */
    gatherNoteText(item),
  ].filter(Boolean).join(" ").toLowerCase();
  return tokens.some((token) => haystack.includes(token));
}

/** "최근 사용" 빠른 필터의 슬라이딩 윈도우(일). last_used_at 이 이 기간보다
 *  오래되면 목록에서 자동 만료된다. */
const RECENTLY_USED_WINDOW_DAYS = 30;

function getReturnTo(search: string): string {
  const params = new URLSearchParams(search);
  return params.get("returnTo") || sessionStorage.getItem("preflow.library.returnTo") || "/dashboard";
}

function getReturnProjectId(search: string): string | null {
  const returnTo = getReturnTo(search);
  const match = returnTo.match(/\/project\/([^/?#]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/** 라이브러리에서 *프로젝트로 보낸* 마지막 대상 — 프로젝트에서 진입하지 않은
 *  상태(returnProjectId 없음)에서도 사이드바에 "브리프/콘티로 이동" 버튼을
 *  띄우기 위한 컨텍스트. sessionStorage 에 영속화해 라이브러리 재진입에도 유지. */
type LastSentTarget = {
  projectId: string;
  title: string;
  workspaceId: string | null;
  target: "brief" | "conti";
};

const LAST_SENT_TARGET_KEY = "preflow.library.lastSentTarget";

function readLastSentTarget(): LastSentTarget | null {
  try {
    const raw = sessionStorage.getItem(LAST_SENT_TARGET_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastSentTarget>;
    if (!parsed || typeof parsed.projectId !== "string") return null;
    if (parsed.target !== "brief" && parsed.target !== "conti") return null;
    return {
      projectId: parsed.projectId,
      title: typeof parsed.title === "string" ? parsed.title : parsed.projectId.slice(0, 8),
      workspaceId: typeof parsed.workspaceId === "string" ? parsed.workspaceId : null,
      target: parsed.target,
    };
  } catch {
    return null;
  }
}

/* ━━━━━ 라이브러리 사이드바 프로젝트 즐겨찾기(핀) ━━━━━
 * 사용자가 자주 가는 프로젝트를 최대 3개 핀해두고, 클릭하면 (cross-workspace
 * 포함) 그 프로젝트로 바로 이동한다(대시보드 클릭과 동일 동작). localStorage
 * 영속이라 워크스페이스/세션 무관하게 유지. */
const PINNED_PROJECTS_KEY = "preflow.library.pinnedProjects";
const PINNED_PROJECTS_MAX = 3;
type PinnedProject = { projectId: string; workspaceId: string | null; title: string };

function readPinnedProjects(): PinnedProject[] {
  try {
    const raw = localStorage.getItem(PINNED_PROJECTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is PinnedProject => !!p && typeof (p as any).projectId === "string")
      .map((p) => ({
        projectId: p.projectId,
        workspaceId: typeof p.workspaceId === "string" ? p.workspaceId : null,
        title: typeof p.title === "string" && p.title.trim() ? p.title : p.projectId.slice(0, 8),
      }))
      .slice(0, PINNED_PROJECTS_MAX);
  } catch {
    return [];
  }
}

function writePinnedProjects(list: PinnedProject[]): void {
  try {
    localStorage.setItem(PINNED_PROJECTS_KEY, JSON.stringify(list.slice(0, PINNED_PROJECTS_MAX)));
  } catch {
    /* private mode / quota — in-memory state 만으로도 이번 세션 동작 */
  }
}

/** Brief → Library 역방향 점프에서 사용. URL ?focus=<refId> 가 있으면
 *  LibraryPage 가 첫 로드 후 해당 자료를 selectedId 로 잡고, 인스펙터 패널을
 *  띄운다 ("이게 어디서 왔는지 보기"). returnTo 처럼 sessionStorage 폴백은
 *  굳이 두지 않음 — Brief 측에서 한 번에 새 URL 로 navigate 하기 때문. */
function getFocusReferenceId(search: string): string | null {
  const params = new URLSearchParams(search);
  const raw = params.get("focus");
  return raw ? decodeURIComponent(raw) : null;
}

/* ─── DnD modifier: DragOverlay 의 top-left 를 cursor 위치에 anchor. ───
 * dnd-kit 기본 DragOverlay 는 active draggable 의 *원래 위치* 에서 시작해
 * cursor 이동량만큼 평행이동한다 → 사용자가 카드의 좌상단이 아니라 카드
 * 한가운데를 잡으면 chip 라벨이 cursor 에서 "카드 절반만큼" 떨어져 보인다.
 *
 * 이를 고치려면 overlay 위치 = cursor + 작은 offset 으로 다시 잡아야 한다.
 *   overlay.left = draggingNodeRect.left + transform.x  (dnd-kit 의 합산식)
 *   목표:        = activator.x + 14                       (cursor 우하단 14 px)
 *   → transform.x += activator.x - draggingNodeRect.left + 14
 *
 * activator coordinates 는 드래그가 시작된 시점의 cursor 좌표라서,
 * (cursor 의 현재 위치 - 초기 위치) 만큼은 이미 transform 에 들어가 있다.
 * 따라서 "원래 카드 좌상단 → 초기 cursor" 만큼만 보정해 주면 chip 이
 * cursor 를 평생 따라간다. */
const snapTopLeftToCursor: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  if (!draggingNodeRect || !activatorEvent) return transform;
  const coords = getEventCoordinates(activatorEvent);
  if (!coords) return transform;
  return {
    ...transform,
    x: transform.x + coords.x - draggingNodeRect.left + 14,
    y: transform.y + coords.y - draggingNodeRect.top + 14,
  };
};

/* 라이브러리 → Agent 첨부 빌더는 [src/lib/agentAttach.ts] 로 이동(LibraryImportDialog 와 공용). */

/* 토스트/안내에 폴더 경로를 표시할 때, 브리프 매치 루트 세그먼트(`브리프 매치`)를
   UI 라벨(`스마트 브리프 매치`)로 치환한다. 실제 폴더 path/태그는 그대로 두고
   표시만 바꾼다(데이터 마이그레이션 없이 명칭 일관성 확보). */
function prettyBriefMatchPath(path: string, briefMatchLabel: string): string {
  const norm = normalizeFolderPath(path);
  if (norm === BRIEF_MATCH_ROOT) return briefMatchLabel;
  if (norm.startsWith(`${BRIEF_MATCH_ROOT}/`)) {
    return `${briefMatchLabel}/${norm.slice(BRIEF_MATCH_ROOT.length + 1)}`;
  }
  return norm;
}

/** 자동 구도 베리에이션을 다중 생성할 때 장별로 덧붙이는 앵글/샷 지시.
 *  COUNT 최대 4 라 4종이면 충분하며, 출력끼리도 서로 다른 구도가 나오게 한다. */
const VARIATION_ANGLE_DIRECTIVES = [
  "Use a wide establishing shot with the subject small in the frame and ample negative space.",
  "Use a tight close-up on the face from a three-quarter front angle.",
  "Use a dramatic low-angle hero shot looking up at the subject.",
  "Use a high-angle shot looking down with an off-center, rule-of-thirds composition.",
];

const LibraryPage = () => {
  const navigate = useNavigate();
  const { openSettings } = useSettingsModal();
  const location = useLocation();
  const t = useT();
  const { language: uiLanguage } = useUiLanguage();
  /* PageShell 의 keep-mount 정책상 LibraryPage 는 첫 진입 후 unmount 되지
     않고 `display: none` 으로만 hide 된다. 비싼 외부 subscription (특히
     백그라운드에서 자주 발화하는 classify 큐) 이 hidden 상태에서도 계속
     setState 를 트리거하면 사용자가 /project 에서 작업 중일 때 메인스레드를
     점유당해 "라이브러리가 살아있어서 앱이 무겁다" 는 체감을 만든다.
     usePageActive 가 PageShell 의 active 를 그대로 전달 — 기본값이 true 라
     PageShell 밖(테스트 등) 에서 단독 마운트해도 회귀 없음. */
  const isActive = usePageActive();
  /* AI 언어 정책 — 두 축
     1) Display Mode: 분석 결과를 어떤 언어로 보여줄지 (auto/en/ko).
        Inspector 의 토글로 즉시 전환 가능 (분석 재호출 없이).
     2) Tag Mode: Accept 시 item.tags 에 머지할 언어 (follow/auto/en/ko).
        "follow" 면 Display 와 같이 움직임.
     subscribeAiOutputLanguage 는 두 키 모두 감지해 같은 윈도우에서도 즉시
     반영되도록 CustomEvent 까지 받는다. */
  const [aiLangMode, setAiLangModeState] = useState<AiOutputLanguageMode>(() => getAiOutputLanguageMode());
  const [aiTagLangMode, setAiTagLangModeState] = useState<AiTagLanguageMode>(() => getAiTagLanguageMode());
  useEffect(() => {
    const unsubscribe = subscribeAiOutputLanguage(() => {
      setAiLangModeState(getAiOutputLanguageMode());
      setAiTagLangModeState(getAiTagLanguageMode());
    });
    return unsubscribe;
  }, []);
  /** Display 모드를 LibraryPage 에서 직접 set 할 일은 없지만, 향후 빠른
   *  단축키 등으로 라이브러리 헤더에서도 토글하고 싶을 때를 대비해 setter
   *  를 노출. 인스펙터의 토글이 setAiOutputLanguageMode 를 호출하면 위
   *  subscribe 가 자동 반영. */
  const _setAiLangMode = useCallback((mode: AiOutputLanguageMode) => {
    setAiLangModeState(mode);
    setAiOutputLanguageMode(mode);
  }, []);
  void _setAiLangMode;
  const effectiveAiLanguage = useMemo(
    () => resolveAiOutputLanguage(aiLangMode, uiLanguage),
    [aiLangMode, uiLanguage],
  );
  const effectiveAiTagLanguage = useMemo(
    () => resolveAiTagLanguage(aiTagLangMode, aiLangMode, uiLanguage),
    [aiTagLangMode, aiLangMode, uiLanguage],
  );
  /* useCallback dependency 폭발을 피하려고 ref 로 미러링 — classify/accept
     호출 시점에 항상 "최신" 언어를 읽지만, 콜백 자체가 재생성되지는 않는다. */
  const effectiveAiLanguageRef = useRef(effectiveAiLanguage);
  const effectiveAiTagLanguageRef = useRef(effectiveAiTagLanguage);
  useEffect(() => {
    effectiveAiLanguageRef.current = effectiveAiLanguage;
  }, [effectiveAiLanguage]);
  useEffect(() => {
    effectiveAiTagLanguageRef.current = effectiveAiTagLanguage;
  }, [effectiveAiTagLanguage]);
  const { toast } = useToast();

  /* ── Undo bar 헬퍼 ──────────────────────────────────────────────
   *
   *  라이브러리에서 *되돌릴 수 있는 결과* 들 — 휴지통 이동 / 폴더 이동·
   *  추가·제거 — 을 Eagle 풍 상단 중앙 컴팩트 바 + Undo 버튼으로 통일한다.
   *  `onUndo` 가 throw 하면 우측 하단 시스템 토스트로 실패 메시지를 띄우고,
   *  성공 시 같은 자리에 짧은 "Undone" 확인 바를 띄워 되돌리기가 정말
   *  처리됐다는 것을 사용자가 확인할 수 있게 한다.
   *
   *  의존성: useToast() 결과와 useT() 결과 두 개뿐이라 본 컴포넌트의
   *  거의 모든 핸들러보다 앞에 둘 수 있다. 위치를 위로 둬야 trash /
   *  folder 핸들러들이 같은 헬퍼를 참조해도 TDZ 사고가 안 난다. */
  const showUndoBar = useCallback(
    (params: { title: string; onUndo: () => Promise<void> | void }) => {
      const { title, onUndo } = params;
      /* toast() 의 반환값(handle) 은 action 의 onClick 클로저보다 *나중* 에
       * 결정되므로 박스 객체에 담아 사후 주입한다. ReturnType 으로 핸들 통째를
       * 보관해 update / dismiss 두 메서드 모두 사용 가능.
       *
       * description 슬롯은 *의도적으로 사용하지 않는다* — bar variant 의 토스트
       * 는 navbar 에 인라인으로 떠 있어 *한 줄* 표시가 핵심이고, 폴더명 같은
       * 가변 정보는 title 문장 안에 인라인으로 합쳐서(uiCopy: itemMovedTo 등)
       * 두 줄로 쪼개지는 것을 막는다. */
      const handleBox: { handle?: ReturnType<typeof toast> } = {};

      /* 되돌리기 본 흐름을 *한 wrapper* 로 추출 — 토스트 버튼 onClick 과
       * 글로벌 Ctrl+Z 단축키(latestUndoActionRef → tryRunLatestUndo) 두
       * 경로가 같은 함수를 호출해 성공/실패 분기 + toast in-place update +
       * 실패 시 destructive toast 까지 정확히 동일한 시각 피드백을 보장한다.
       * 양쪽 진입점 어느 쪽에서 발동되어도 사용자에겐 "한 번 되돌렸다" 는
       * 결과가 똑같이 보이도록. */
      const runUndo = async (): Promise<void> => {
        try {
          await onUndo();
          handleBox.handle?.update({
            title: t("library.toast.undone"),
            description: undefined,
            action: undefined,
            duration: 2500,
          });
        } catch (err) {
          handleBox.handle?.dismiss();
          /* 실패 메시지도 *상단 중앙* 에 띄움. position 은 이제 기본
           * 값이라 명시 불필요. destructive variant 만 박아 빨간 surface
           * 로 critical 표시. */
          toast({
            variant: "destructive",
            duration: 5000,
            title: t("library.toast.undoFailed"),
            description: err instanceof Error ? err.message : String(err),
          });
        }
      };

      /* 가장 최근 액션 슬롯 갱신 — TTL 은 토스트의 duration(6000ms) 과
       * 정확히 일치시켜 "화면에 보이는 동안 = 단축키 발동 가능" 관계를
       * 유지한다. 새 액션이 들어오면 자연히 이전 슬롯을 덮어쓰므로 항상
       * *직전 액션* 하나만 되돌릴 수 있다 (단일 슬롯 정책). */
      latestUndoActionRef.current = {
        run: runUndo,
        expiresAt: Date.now() + 6000,
      };

      const handle = toast({
        /* position/variant 는 모두 기본값 (top-center compact bar) 으로
         * 두면 충분 — useToast 의 기본 위치가 top-center 고, default variant
         * 가 컴팩트 바 스타일이라 별도 지정 불필요. duration 만 일반 토스트
         * (5s) 보다 길게(6s) 잡아 사용자가 Undo 누를 시간을 충분히 준다. */
        duration: 6000,
        title,
        action: (
          <ToastAction
            altText={t("library.toast.undo")}
            /* Radix Toast.Action 의 기본 onClick 은 auto-close 를 트리거한다.
             * preventDefault 로 그 자동 닫힘을 끊고, await onUndo() 끝난 *뒤*
             * 같은 토스트 인스턴스를 in-place 로 update — 내용/duration 만
             * 갈아끼우면 Radix 가 새 duration 으로 timer 를 재시작해서 별도
             * setTimeout 없이 깔끔하게 자동 닫힘.
             *
             * 이렇게 하면 viewport 안에 토스트가 *항상 1개* 라 새 토스트가
             * 끼어들 때 발생하던 레이아웃 시프트(옛 토스트가 한 칸 아래로
             * 밀려나며 transition-all 로 슬라이드되는 현상) 가 사라진다 —
             * 그게 사용자가 "아래에서 올라온다" 고 느낀 원인.
             *
             * ref 슬롯도 *consume* — 같은 액션이 단축키로 한 번 더 발동
             * 되지 않게 즉시 비운다. */
            onClick={(event) => {
              event.preventDefault();
              latestUndoActionRef.current = null;
              void runUndo();
            }}
          >
            {t("library.toast.undo")}
          </ToastAction>
        ),
      });
      handleBox.handle = handle;
    },
    [t, toast],
  );

  const libraryWorkspaceName = useActiveWorkspaceName("library");
  const fileInputRef = useRef<HTMLInputElement>(null);
  /* "Custom thumbnail (Select file)" 전용 file input — Reference 추가용 fileInputRef
     와 별개로 두어 accept 필터(image/*) 와 onChange 처리(우클릭한 항목의 cover
     로 적용) 가 분리된다. 동일 input 을 공유하면 Reference 추가 모드에서 cover
     설정이 끼어들거나, cover 적용 시 새 라이브러리 항목이 함께 만들어지는
     실수가 발생할 수 있어 의도적으로 분리. */
  const coverFileInputRef = useRef<HTMLInputElement>(null);
  /* file dialog 가 비동기로 닫히는 동안 어떤 자료의 cover 를 설정할지 기억.
     컨텍스트 메뉴의 onSelect 시점에 ref 에 저장 → input change 콜백이 읽어
     해당 항목에 적용. selected 를 그대로 쓰면 사용자가 그 사이 다른 카드를
     선택했을 때 엉뚱한 자료의 cover 가 덮이는 사고가 생긴다. */
  const pendingCoverItemRef = useRef<ReferenceItem | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const loadSeqRef = useRef(0);
  /* Library 진입 시 idle 에 한 번 도는 thumbnail 자동 백필의 cancel 핸들.
     loadReferences 가 다시 호출될 때(=새 진입/새 데이터) 이전 잡을 abort 하고
     새 rows 로 다시 스케줄. unmount cleanup 에서도 호출되어 페이지 이탈 즉시
     백그라운드 fetch/decode 가 멈춘다. */
  const thumbAutoBackfillCancelRef = useRef<(() => void) | null>(null);
  const animatedPreviewAutoBackfillCancelRef = useRef<(() => void) | null>(null);
  /* 가장 최근 `showUndoBar` 가 띄운 *되돌리기 가능 액션* 의 단일 슬롯.
     - `run()`: toast 의 "되돌리기" 버튼 onClick 과 *완전히 같은* 흐름을 한
       함수에 묶어둔 wrapper. 성공/실패 분기, toast in-place update, 실패 시
       error toast 까지 그대로 재현하므로 어느 진입점에서 호출돼도 시각
       피드백이 일관된다.
     - `expiresAt`: 토스트 가시 TTL(6 초)과 정확히 일치. 만료 후 진입은
       no-op — 토스트가 화면에 없는데 단축키만 살아 있는 시점을 정책으로
       끊는다 ("화면에 보이는 것 = 되돌릴 수 있는 것").

     단일 슬롯인 이유: showUndoBar 가 *기존 토스트를 in-place update* 하는
     설계라 toast viewport 에 항상 1개 만 있고, 멘탈 모델도 *직전 액션 한
     건* 만 되돌릴 수 있어야 자연스럽다. 무한 undo stack 은 별도 후속 작업. */
  const latestUndoActionRef = useRef<{ run: () => Promise<void>; expiresAt: number } | null>(null);
  /** 글로벌 keydown + LibraryCanvas viewport keydown 두 군데에서 *같은* 슬롯을
   *  소비한다. 가장 먼저 호출된 쪽이 ref 를 null 로 비워 두 번째 호출은
   *  자연스럽게 false 를 받아 자기 자신의 다른 동작(예: canvas layout undo)
   *  으로 폴백한다. */
  const tryRunLatestUndo = useCallback((): boolean => {
    const pending = latestUndoActionRef.current;
    if (!pending || pending.expiresAt < Date.now()) {
      latestUndoActionRef.current = null;
      return false;
    }
    latestUndoActionRef.current = null;
    void pending.run();
    return true;
  }, []);
  /* 라이브러리 진입 캐시 — 같은 세션 내 재진입 시 빈 그리드 → 페인트 jank
     를 없애는 핵심. 첫 진입은 cache 없음 → 기존 경로(loading=true) 그대로
     동작하고, 재진입부터 즉시 paint. background refetch 결과로 자연스럽게
     덮어쓰인다. */
  const initialCache = readLibraryCache();
  const [items, setItems] = useState<ReferenceItem[]>(initialCache?.items ?? []);
  /* "방금 업로드된" 항목 우선순위 — id → upload timestamp(ms).
     sortKey/sortOrder 가 무엇이든, 그리고 manual 모드에서 신규 항목이
     MAX_SAFE_INTEGER 로 끝쪽으로 빠지는 케이스에서도, 사용자가 방금 끌어다
     놓거나 클립보드 붙여넣기 한 항목이 시야에 보이도록 sort 비교 첫 단계에서
     이 timestamp 가 큰 쪽이 위로 올라간다. 핀(pinned) 보다는 약한 우선순위라
     의도적으로 박은 핀의 위치는 보존. 새로고침 시 자연스럽게 비워지는 세션
     상태이며, 다음 reload 후에는 정상 정렬 규칙(created_at desc 등)이 다시
     동작한다. */
  const [freshlyUploadedAt, setFreshlyUploadedAt] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(!initialCache);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  /* 검색 입력은 즉시 반영(setQuery)해 타이핑 응답성을 유지하되, 1만 항목
   * 9-단계 필터 cascade(filteredItems)의 *입력*은 디퍼한다. useDeferredValue
   * 는 타이핑이 몰릴 때 무거운 재계산을 낮은 우선순위로 미뤄, 글자마다 전체
   * cascade 가 동기로 도는 jank 를 제거한다(데이터가 쌓일수록 효과 큼). */
  const deferredQuery = useDeferredValue(query);
  const [urlInput, setUrlInput] = useState("");
  const [pasteUrlOpen, setPasteUrlOpen] = useState(false);
  const [eagleImportOpen, setEagleImportOpen] = useState(false);
  // ── 툴바 필터(Eagle 스타일 다중 + include/exclude). 사이드바의 단일
  // activeTag/quickFilter 와 AND 결합으로 적용된다(아래 filteredItems 참조).
  /* 계층형 Types 필터 — 카테고리(image/video/doc/url) + 리프(포맷/플랫폼/기타)를
     단일 MultiFilter<string> 로 표현한다(typeFilter.ts). 카테고리 id="image",
     리프 id="image/png" 식. activeTag/quickFilter 와 AND 결합. */
  const [typeFilter, setTypeFilter] = useState<MultiFilter<string>>(() => emptyMulti());
  const [tagsFilter, setTagsFilter] = useState<MultiFilter<string>>(() => emptyMulti());
  /* Moods 칩(B 단계) — `ai.mood_labels` 기반 multi-select 필터. row.id /
     filter set 은 항상 lowercase EN canonical (referenceAi.ts safeJson 의
     컨트랙트). picker label 은 effectiveAiTagLanguage 에 따라 EN/KO 로
     렌더되지만 매칭 좌표계는 EN 한 줄로 통일. tagsFilter 와 동일하게
     세션 한정. */
  const [moodsFilter, setMoodsFilter] = useState<MultiFilter<string>>(() => emptyMulti());
  const [foldersFilter, setFoldersFilter] = useState<MultiFilter<string>>(() => emptyMulti());
  /* ── B2: 한글 검색 → 영어 태그 추천 ─────────────────────────────
     - koreanSuggestion: LLM 응답 (또는 null = 아직 호출 전)
     - koreanSuggestLoading: 디바운스 후 in-flight 동안 true
     - dismissedKoreanQueries: 사용자가 "× 닫기" 한 쿼리 — 세션 한정.
       같은 쿼리를 다시 쳐도 추천 행이 안 뜬다. */
  const [koreanSuggestion, setKoreanSuggestion] = useState<KoreanSuggestSpec | null>(null);
  const [koreanSuggestLoading, setKoreanSuggestLoading] = useState(false);
  const [dismissedKoreanQueries, setDismissedKoreanQueries] = useState<Set<string>>(() => new Set());
  const [ratingsFilter, setRatingsFilter] = useState<ReadonlySet<RatingValue>>(() => new Set());
  const [shapesFilter, setShapesFilter] = useState<ReadonlySet<ShapeValue>>(() => new Set());
  const [noteFilterState, setNoteFilterState] = useState<NoteFilterState>(EMPTY_NOTE_FILTER);
  /* Color 필터 — 단일 hex 값 또는 null. 활성 시 filteredItems 가 LAB 거리로
     가까운 자료만 통과시키고, 정렬도 자동으로 "거리 오름차순" 으로 전환된다
     (sortKey 무시). 다른 필터들과 동일하게 세션 한정. */
  const [colorFilter, setColorFilter] = useState<string | null>(null);
  /* Mood AI 필터(Phase C) — 자연어를 LLM 이 BriefSignals 로 확장한 결과를
     들고 있다가, filteredItems 단계에서 scoreReferences 로 매칭한다. null
     이면 비활성. 활성 시 정렬이 score desc 로 자동 전환되어 sortKey 가
     무시된다(Color 필터와 같은 정책). */
  const [moodFilter, setMoodFilter] = useState<MoodFilterSpec | null>(null);
  // ── Brief Match (라이브러리 브리프 매치 플라이아웃) ──
  const [briefMatchOpen, setBriefMatchOpen] = useState(false);
  const [briefAnchorIds, setBriefAnchorIds] = useState<string[]>([]);
  /** 라이브러리 카드를 브리프 이미지 드롭존에 떨군 것 — 브리프(분석 입력)로 사용. */
  const [briefImageIds, setBriefImageIds] = useState<string[]>([]);
  /** 일반 폴더 → 스마트 브리프 매치 이동 시, 브리프가 비어 있어 입력을 받아야 하는
   *  보류 이동(드롭 게이트). 값이 있으면 브리프 매치 플라이아웃이 attach 모드로 열려
   *  라이브러리 드래그&드롭으로 브리프/레퍼런스를 입력받는다(LLM 스킵). */
  const [briefAttachTarget, setBriefAttachTarget] = useState<
    { sourceRow: LibraryFolderRow; newParentPath: string | null } | null
  >(null);
  /* LLM 의미 기반 재정렬 결과. map=id→fit(0-100). 있으면 그리드를 토큰 매칭
     대신 이 순위로 정렬/필터한다(ranked id 만 통과). loading 중에는 토큰 기반
     1차 결과(moodScoreMap)를 보여 체감 지연을 줄인다. */
  const [briefRerank, setBriefRerank] = useState<{
    map: Map<string, number>;
    loading: boolean;
  } | null>(null);
  const briefRerankSeqRef = useRef(0);
  // 브리프 매치 폴더 → 프로젝트 내보내기 다이얼로그(로켓 버튼).
  const [briefMatchExport, setBriefMatchExport] = useState<{
    path: string;
    members: ReferenceItem[];
    defaultTitle: string;
  } | null>(null);
  const briefMatchOpenRef = useRef(false);
  useEffect(() => {
    briefMatchOpenRef.current = briefMatchOpen;
  }, [briefMatchOpen]);
  // 무드 필터가 해제되면(AI 검색/브리프 매치 종료) 재정렬 결과도 비운다.
  // (분석 후 플라이아웃이 닫혀도 moodFilter 는 유지되므로 그리드 순위가 남는다.)
  useEffect(() => {
    if (!moodFilter) setBriefRerank(null);
  }, [moodFilter]);
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");
  // 그리드뷰 전용 숨김(전역) — 캔버스 숨김과 독립. localStorage 영속.
  const [gridHiddenIds, setGridHiddenIds] = useState<Set<string>>(() => loadGridHidden());
  const [showHidden, setShowHidden] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);

  /** selectedIds 의 최신값을 ref 로 미러링 — render body 에서 *동기적으로*
   *  갱신해 commit 지연 race 를 피한다. useEffect 패턴은 React 18 concurrent
   *  rendering 에서 effect 가 지연되는 동안 stale 한 값을 보일 수 있음.
   *
   *  selection-aware 핸들러 (다중 attach, 폴더 이동, export 등) 가 이 ref 를
   *  truth-of-source 로 사용한다. */
  const selectedIdsRef = useRef<Set<string>>(selectedIds);
  selectedIdsRef.current = selectedIds;

  /** 우클릭 시점의 selection snapshot. selection state 는 메뉴 클릭 시점에
   *  비워지는 race 가 관찰됐다 (Radix Portal close + focus restore 사이 어딘가).
   *  contextmenu 분기에서 이 ref 에 *그 순간의* selection 을 그대로 저장해 두면,
   *  메뉴 항목이 fire 될 때 그 snapshot 으로 일관된 selection-aware 동작이 가능. */
  const selectionSnapshotRef = useRef<Set<string>>(new Set());
  const [previewMode, setPreviewMode] = useState(false);
  /* 인스펙터의 timestamp 노트 클릭으로 큰 프리뷰가 열리는 직후, 비디오 메타가
     로드되면 이 값으로 1회 자동 시크된다. LibraryPreviewPanel 의
     onLoadedMetadata 가 적용 후 onInitialSeekConsumed() 로 null 로 클리어. */
  const [pendingSeekSec, setPendingSeekSec] = useState<number | null>(null);
  /* GIF 자료의 인스펙터 노트 클릭 → 큰 프리뷰 → GifFramePlayer 가 디코드를
     끝낸 시점에 1회 자동 점프할 프레임 인덱스. 영상의 pendingSeekSec 와 같은
     패턴 — 큐잉된 값이 소비되면 onInitialFrameConsumed() 로 null 로 클리어. */
  const [pendingFrameIndex, setPendingFrameIndex] = useState<number | null>(null);
  /* PDF 자료의 인스펙터 슬라이드 노트 클릭 → 큰 프리뷰 → PdfViewer 가 1회
     이동할 페이지(1-based). GIF 의 pendingFrameIndex 와 같은 큐잉 패턴 —
     소비되면 onInitialPageConsumed() 로 null 로 클리어. */
  const [pendingPageIndex, setPendingPageIndex] = useState<number | null>(null);
  /* 정지 이미지/PSD 의 인스펙터 영역 노트 클릭 → 큰 프리뷰 → RegionOverlay 가
     해당 영역을 잠깐 하이라이트할 노트 id. 소비(타임아웃)되면 null 로 클리어. */
  const [pendingRegionNoteId, setPendingRegionNoteId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editTags, setEditTags] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editSourceUrl, setEditSourceUrl] = useState("");
  const [editRating, setEditRating] = useState("0");
  const [timestampText, setTimestampText] = useState("");
  const [playbackRate, setPlaybackRate] = useState("1");
  const [saving, setSaving] = useState(false);
  const [eagleRoot, setEagleRoot] = useState("");
  const [eaglePreview, setEaglePreview] = useState<EaglePreview | null>(null);
  const [eagleResult, setEagleResult] = useState<EagleImportResult | null>(null);
  const [eagleBusy, setEagleBusy] = useState(false);
  /* Phase E — manual AI 트리거도 classifyQueue 를 공유한다. 그래서 자료
     전환·재요청 시 in-flight 를 abort 하던 옛 흐름은 폐기 (큐는 동시 N 개
     실행이라 의미가 없고, 다른 자료를 보고 있어도 백그라운드 진행이 그대로
     이어져야 한다). 각 자료의 sampling/analyzing 단계와 ClassifyProgress 는
     id → 상태 Map 으로 보관해 인스펙터가 *현재 선택된* 자료의 progress 만
     꺼내 본다. 자동 큐 잡(폴더 import 시) 은 onStage/onProgress 를 안 넘기므로
     Map 에 진입하지 않아 비용 0. */
  const [itemClassifyProgress, setItemClassifyProgress] = useState<
    Map<string, { stage: ClassifyStage; progress: ClassifyProgress | null }>
  >(() => new Map());
  /* Accept(자동 tag 적용) 호출은 짧고 1자료에만 일어나므로 단일 플래그.
     선택된 자료가 어떤 자료든 한 번에 하나만 진행. */
  const [acceptingSuggestions, setAcceptingSuggestions] = useState(false);
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([]);
  const [activeSavedFilterId, setActiveSavedFilterId] = useState<string | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  /* 사이드바 다중 폴더 선택(Ctrl/Shift) 의 단일 진실원. activeTag 는 그 중
   *  "앵커(마지막 클릭)" 로 유지돼 캔버스/업로드/브레드크럼/recursive/드롭 등
   *  단일 폴더 의존 기능을 그대로 보존한다. 불변식: 비면 activeTag=null,
   *  1개 이상이면 activeTag 는 항상 selectedFolderTags 의 멤버. 모든 폴더
   *  선택 변경은 아래 3개 헬퍼로만 일어난다(setActiveTag 직접 호출 금지). */
  const [selectedFolderTags, setSelectedFolderTags] = useState<string[]>([]);
  /** 전체 해제(루트/All Items 로 복귀). */
  const resetFolderSelection = useCallback(() => {
    setSelectedFolderTags([]);
    setActiveTag(null);
  }, []);
  /** 단일 폴더(또는 비폴더 태그) 선택 — 브레드크럼/Pinned/캔버스 복귀/
   *  recursive 토글/리네임·이동 리맵에서 사용. null 이면 전체 해제와 동일. */
  const selectSingleFolder = useCallback((tag: string | null) => {
    setSelectedFolderTags(tag ? [tag] : []);
    setActiveTag(tag);
  }, []);
  /** 다중 선택 — 사이드바 FolderRow 클릭 핸들러 전용. anchor 는 집합의
   *  멤버이거나(앵커) 비었을 때 null. */
  const applyFolderSelection = useCallback((tags: string[], anchor: string | null) => {
    setSelectedFolderTags(tags);
    setActiveTag(anchor);
  }, []);
  const [gridSize, setGridSize] = useState(() => Number(localStorage.getItem("preflow.library.gridSize")) || 180);
  const [viewMode, setViewMode] = useState<LibraryViewMode>("grid");
  /* 캔버스 모드 허용 조건 — 단일 폴더 컨텍스트에서만 의미가 있다.
   *  · 폴더가 아닌 컨텍스트(All/Smart/Tag/Trash) → 비허용.
   *  · 단일 폴더 선택 → 허용(하위 폴더 보유 여부 무관).
   *  · 다중 선택 → 기본 비허용. 단, 선택이 "한 폴더의 하위트리"
   *    (선택된 조상 1개 + 그 자손 폴더들)로만 이루어진 경우는 허용 —
   *    서로 무관한 폴더를 다중 선택했을 때만 캔버스를 막는다. */
  const canvasAllowed = useMemo(() => {
    const folderTags = selectedFolderTags.filter((tag) => tag.startsWith("folder:"));
    if (folderTags.length === 0) return false;
    if (folderTags.length === 1) return true;
    return folderTags.some((root) =>
      folderTags.every((tag) => tag === root || tag.startsWith(`${root}/`)),
    );
  }, [selectedFolderTags]);
  /* Canvas 뷰는 폴더 컨텍스트(`folder:` 접두) 에서만 의미가 있다. 사용자가
   *  Canvas 인 채로 사이드바의 All/Smart/Tag/Trash 등 폴더가 아닌 컨텍스트로
   *  이동하거나, 무관한 폴더를 다중 선택하면 즉시 grid 로 폴백 — Toolbar 도
   *  Canvas 항목을 숨기므로 사용자가 다시 캔버스로 돌아오려면 단일 폴더(또는
   *  한 폴더의 하위트리) 선택 후 다시 켜야 한다. */
  useEffect(() => {
    if (viewMode === "canvas" && !canvasAllowed) {
      setViewMode("grid");
    }
  }, [viewMode, canvasAllowed]);
  /** Immersive(몰입) 모드 — 좌측 사이드바 + 상단 LibraryToolbar + 우측
   *  LibraryInspector 를 모두 숨겨 캔버스 또는 preview 만 풀 화면으로 보여준다.
   *  PureRef 의 캔버스 풀화면 제스처와 유사한 UX. 단축키는 백틱(`).
   *  - canvas 또는 previewMode 인 경우에만 토글 가능. 그 외 컨텍스트에선 ` 가
   *    별 동작 없이 input 위 표준 입력으로 흐름.
   *  - viewMode 가 canvas 가 아니게 되면 자동으로 false 로 — 회수 가시성 보장.
   *  - 영구화 안 함(localStorage 미저장) — reload 시 항상 OFF (덜 깜짝).
   */
  const [immersiveCanvas, setImmersiveCanvas] = useState(false);
  useEffect(() => {
    if (immersiveCanvas && viewMode !== "canvas" && !previewMode) {
      // viewMode 전환으로 immersive 의미가 사라진 경우 자동 종료.
      // (previewMode 가 켜져 있으면 그 안에서도 immersive 유지하므로 둘 다
      // 거짓일 때만 끔.)
      setImmersiveCanvas(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, immersiveCanvas]);
  const [sortKey, setSortKey] = useState<LibrarySortKey>(
    () => (localStorage.getItem("preflow.library.sortKey") as LibrarySortKey | null) ?? "recent",
  );
  const [sortOrder, setSortOrder] = useState<LibrarySortOrder>(
    () => (localStorage.getItem("preflow.library.sortOrder") as LibrarySortOrder | null) ?? "desc",
  );
  const [copiedTags, setCopiedTags] = useState<string[] | null>(null);
  const [usageCounts, setUsageCounts] = useState<Record<string, number>>({});
  /** LS 스캔(Brief 드래프트 + Conti Compare Library) 으로 얻은 사용 위치.
   *  cross-workspace 케이스에서 DB FK 가 silent fail 해 link 행이 없어도
   *  여기서 잡아준다. 인스펙터의 "사용 위치" 패널과 그리드 카운트 머지
   *  양쪽에서 사용. 각 location 은 `target: "brief" | "conti"` 를 가져
   *  Inspector 의 라벨 분기 (· 브리프 · / · 콘티 ·) 에 사용된다.
   *  자세한 정책은 `briefRefUsageScan.ts` 참고. */
  const [usageLocations, setUsageLocations] = useState<Record<string, BriefRefUsageLocation[]>>({});
  const [promoteTarget, setPromoteTarget] = useState<ReferenceItem | null>(null);
  /** Promote dialog 의 projectId — picker 로 직접 고른 경우 returnProjectId 가
   *  없을 수 있어 별도 보관. 다이얼로그 닫힐 때 같이 초기화. */
  const [promoteProjectId, setPromoteProjectId] = useState<string | null>(null);
  /** Library 우클릭 → Project picker 가 열려 있을 때의 pending state.
   *
   *  두 모드를 함께 표현한다:
   *   - `single` : 우클릭 단건 (또는 multi-select 가 1개 이하인 케이스).
   *                pick 시 `performAttachToProject` 로 단건 attach.
   *   - `bulk`   : multi-select 2개 이상인 케이스. pick 시 target 에 따라
   *                `sendItemsToBrief` 또는 `sendItemsToConti` 로 일괄 attach.
   *
   *  bulk picker 도입 이유: 라이브러리에 직접 진입한 상태 (returnProjectId 없음)
   *  에서 다중 자료를 우클릭 → Brief/Conti 로 보내고 싶을 때, 과거에는 토스트로
   *  거절(`bulkRequiresActiveProject`) 했지만 사용자 입장에서 "선택은 다 했는데
   *  왜 안 보내지냐" 가 자연스러운 의문이라 picker 로 안내. */
  const [projectPicker, setProjectPicker] = useState<
    | { kind: "single"; item: ReferenceItem; target: AttachTarget | "promote" }
    | { kind: "bulk"; items: ReferenceItem[]; target: AttachTarget }
    | null
  >(null);
  /** 라이브러리에서 마지막으로 Brief/Conti 로 보낸 프로젝트 — 진입 프로젝트가
   *  없을 때(returnProjectId X) 사이드바에 "브리프/콘티로 이동" 버튼을 띄운다. */
  const [lastSentTarget, setLastSentTarget] = useState<LastSentTarget | null>(() => readLastSentTarget());
  /** 사이드바 프로젝트 즐겨찾기(최대 3). 클릭 시 그 프로젝트로 바로 이동. */
  const [pinnedProjects, setPinnedProjects] = useState<PinnedProject[]>(() => readPinnedProjects());
  const [favoritePickerOpen, setFavoritePickerOpen] = useState(false);
  const [userFolderPaths, setUserFolderPaths] = useState<string[]>(() => getUserFolderPaths());
  /* Phase D: 폴더 단위 AI 설정 — localStorage 영속. dictionary 전체를
     매번 새로 들고 있다가 storage 이벤트로 sync. autoClassify=true 인
     폴더 path 만 모은 ReadonlySet 으로 사이드바에 sparkles 인디케이터를
     렌더한다. */
  const [folderAiSettingsMap, setFolderAiSettingsMap] = useState<
    Record<string, FolderAiSettingsType>
  >(() => listFolderAiSettings());
  const [folderAiSettingsTarget, setFolderAiSettingsTarget] = useState<string | null>(null);
  useEffect(() => {
    return subscribeFolderAiSettings(() => {
      setFolderAiSettingsMap(listFolderAiSettings());
    });
  }, []);
  const folderAiAutoClassifySet = useMemo<ReadonlySet<string>>(() => {
    const out = new Set<string>();
    for (const [path, value] of Object.entries(folderAiSettingsMap)) {
      if (value.autoClassify) out.add(path);
    }
    return out;
  }, [folderAiSettingsMap]);
  /* Phase D5: 분류 큐 상태 — Toolbar 우측 pill 에 노출. snapshot 이 0/0
     일 때는 자동으로 null 처럼 렌더되어 자리를 차지하지 않는다.
     ───────────────────────────────────────────────────────────────────
     ⚠️ keep-mount 가드 — LibraryPage 가 hidden 일 때 (`isActive=false`)
     는 구독 자체를 걸지 않는다. classify 큐는 백그라운드 import / 사용자
     수동 트리거로 가장 자주 발화하는 외부 subscription 이고, snapshot 변경
     → setState → 9-stage useMemo cascade 재실행이 hidden 상태에서도 메인
     스레드를 잡아 사용자가 작업 중인 /project 페이지에 jank 를 만든다.
     `subscribeClassifyQueue` 는 등록 즉시 현재 snapshot 으로 callback 을
     한 번 호출하므로, 사용자가 라이브러리로 돌아와 `isActive=true` 로
     전환되는 순간 자동으로 최신 큐 상태로 동기화된다 (별도 sync 호출 불필요).
     hidden 동안 사용자가 보는 정보는 어차피 0개라 stale 도 의미 없음. */
  const [classifyQueueSnapshot, setClassifyQueueSnapshot] =
    useState<ClassifyQueueSnapshot>({ pending: 0, running: 0 });
  useEffect(() => {
    if (!isActive) return;
    return subscribeClassifyQueue((snap) => setClassifyQueueSnapshot(snap));
  }, [isActive]);
  const [exportDialog, setExportDialog] = useState<ExportDialogState>(null);
  const [htmlExportDialog, setHtmlExportDialog] = useState<HtmlExportDialogState>(null);
  const [importPackOpen, setImportPackOpen] = useState(false);
  /* 300MB 초과 영상 변환 — convertCandidates 가 non-null 이면 확인 다이얼로그가
     열린다. "변환 후 업로드" 를 누르면 다이얼로그를 닫고 백그라운드(진행 토스트)
     로 변환하므로 변환 중에도 라이브러리를 계속 쓸 수 있다. abortRef 로 취소. */
  const [convertCandidates, setConvertCandidates] = useState<File[] | null>(null);
  const convertAbortRef = useRef<AbortController | null>(null);
  /* Add → Choose Files / 드래그-드랍에서 미리 만든 PackPreview 를 들고 있다가
     PackImportDialog 가 열릴 때 1회 흡수. 같은 파일을 다시 픽하면 새 객체로
     교체되어 useEffect 가 다시 트리거. */
  const [initialPackPreview, setInitialPackPreview] = useState<PackPreview | null>(null);
  const [storageUsage, setStorageUsage] = useState<StorageUsage | null>(null);
  // Orphan / 잔여 썸네일 등 회수 가능한 바이트 — 우상단 칩 끝에 작게
  // "· {n} cleanable" 로 노출. 실패는 silent (best-effort).
  const [cleanableBytes, setCleanableBytes] = useState<number | null>(null);
  const [folderEdit, setFolderEdit] = useState<FolderEditState>(null);
  const [folderDeleteTarget, setFolderDeleteTarget] = useState<LibraryFolderRow | null>(null);
  const [folderPicker, setFolderPicker] = useState<FolderPickerState>(null);
  // 폴더 자체를 다른 부모 아래로 옮기는 흐름. reference-item 단위로
  // 폴더를 고르는 folderPicker 와 의도가 달라 별도 state 로 둔다.
  // 활성 시 FolderPickerDialog 두 번째 인스턴스를 띄워 destination 을
  // 받고, renameFolder("oldPath", "${dest}/${leaf}") 로 처리한다.
  const [folderMoveTarget, setFolderMoveTarget] = useState<LibraryFolderRow | null>(null);
  // 사이드바의 "Show subfolder content" 체크. 사용자별 글로벌 선호로
  // localStorage 에 영구화 — 폴더 사이를 이동해도, 앱을 다시 켜도 마지막
  // 선호가 유지된다. 디폴트(키 부재) 는 true (Eagle 식 trunk 뷰가 직관) —
  // 사용자가 명시적으로 OFF 로 저장한 경우에만 false 로 시작. 키 부재와
  // "true" 를 모두 true 로 해석하므로 기존 사용자가 처음 마주치는 동작은
  // ON 으로 통일된다. 값 변경 시 같은 useEffect 가 자동으로 저장.
  const [recursiveActiveFolder, setRecursiveActiveFolder] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      return window.localStorage.getItem("preflow.library.recursiveActiveFolder") !== "false";
    } catch {
      return true;
    }
  });
  const [orphanCleanupOpen, setOrphanCleanupOpen] = useState(false);
  const [duplicateMerge, setDuplicateMerge] = useState<DuplicateMergeState>(null);
  const [renameTarget, setRenameTarget] = useState<ReferenceItem | null>(null);
  const [variationTarget, setVariationTarget] = useState<ReferenceItem | null>(null);
  // 진행 중인 베리에이션 생성 수(병렬). 0보다 크면 플라이아웃에 진행 표시만 하고
  // 추가 생성을 막지 않는다.
  const [variationInFlight, setVariationInFlight] = useState(0);
  // 현재 변형 생성 중인 *원본* id 별 진행 카운트 — 그 카드에 로딩 오버레이를 띄운다.
  const [variationGeneratingCounts, setVariationGeneratingCounts] = useState<Record<string, number>>({});
  const variationGeneratingIds = useMemo(
    () => new Set(Object.keys(variationGeneratingCounts).filter((id) => variationGeneratingCounts[id] > 0)),
    [variationGeneratingCounts],
  );
  const bumpVariationGenerating = useCallback((id: string, delta: number) => {
    setVariationGeneratingCounts((prev) => {
      const next = { ...prev };
      const v = (next[id] ?? 0) + delta;
      if (v > 0) next[id] = v;
      else delete next[id];
      return next;
    });
  }, []);
  // 변형 플라이아웃에 라이브러리 카드 드래그로 주입된 참조 id 들.
  const [variationInjectIds, setVariationInjectIds] = useState<string[]>([]);
  // 글로벌 드래그 트래커 콜백이 최신 "플라이아웃 열림" 상태를 읽기 위한 ref.
  const variationFlyoutOpenRef = useRef(false);
  useEffect(() => {
    variationFlyoutOpenRef.current = variationTarget !== null;
  }, [variationTarget]);
  // 플라이아웃이 닫히면 주입 참조도 비운다.
  useEffect(() => {
    if (!variationTarget) setVariationInjectIds([]);
  }, [variationTarget]);
  // 주입 id → 플라이아웃이 쓰는 {id,url,preview,name} 로 해석(원본 자기 자신 제외).
  const variationInjected = useMemo<VariationInjectedRef[]>(() => {
    if (!variationTarget) return [];
    const byId = new Map(items.map((it) => [it.id, it]));
    return variationInjectIds
      .filter((id) => id !== variationTarget.id)
      .map((id) => byId.get(id))
      .filter((it): it is ReferenceItem => Boolean(it && it.file_url))
      .map((it) => ({
        id: it.id,
        url: it.file_url as string,
        preview: withReferenceVersion(it.thumbnail_url ?? it.file_url, it),
        name: it.title ?? it.id,
      }));
  }, [variationTarget, variationInjectIds, items]);
  const [permanentDeleteTargets, setPermanentDeleteTargets] = useState<ReferenceItem[]>([]);
  // 사이드바 폭 — Project Dashboard 와 동일하게 드래그/더블클릭으로 갱신.
  // 영구화는 SidebarResizeHandle 의 mouseup/dblclick 시점에서만 한 번 수행.
  const [sidebarWidth, setSidebarWidth] = useState<number>(readLibrarySidebarWidth);
  // 우측 인스펙터 패널 폭 — 동일한 패턴(state + storage event sync).
  // 그리드와 인스펙터 사이의 SidebarResizeHandle(side="right") 가 갱신.
  const [inspectorWidth, setInspectorWidth] = useState<number>(readLibraryInspectorWidth);

  // ── Manual order ─────────────────────────────────────────────
  // localStorage 변경 알림용 카운터 — 다른 탭/윈도우에서 순서가 바뀌어도
  // 같은 contextKey 의 sort 가 즉시 갱신되도록 useMemo 의존성으로 사용.
  const [manualOrderVersion, setManualOrderVersion] = useState(0);
  useEffect(() => {
    const sync = () => setManualOrderVersion((v) => v + 1);
    const onStorage = (event: StorageEvent) => {
      if (event.key === "preflow.library.manualOrder") sync();
    };
    window.addEventListener(MANUAL_ORDER_CHANGED_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(MANUAL_ORDER_CHANGED_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // 색팔레트가 백그라운드 추출에서 채워졌을 때 items 상태에 반영.
  // referenceLibrary.ts 의 createReference / updateReference / backfill 경로
  // 모두 추출 완료 시 PALETTE_UPDATED_EVENT 를 dispatch 하므로 한 곳에서
  // listen 하면 모든 케이스가 한 번에 커버된다.
  useEffect(() => {
    const onPaletteUpdated = (event: Event) => {
      const detail = (event as CustomEvent<PaletteUpdatedDetail>).detail;
      if (!detail || !detail.id) return;
      setItems((current) =>
        current.map((item) =>
          item.id === detail.id ? { ...item, color_palette: detail.palette } : item,
        ),
      );
    };
    window.addEventListener(PALETTE_UPDATED_EVENT, onPaletteUpdated);
    return () => window.removeEventListener(PALETTE_UPDATED_EVENT, onPaletteUpdated);
  }, []);

  // ── DnD 상태 ──────────────────────────────────────────────────
  // LibrarySidebar 내부에 갇혀 있던 DndContext 를 페이지로 끌어올렸다.
  // 이렇게 해야 그리드의 reference 카드를 사이드바의 폴더 행으로 그대로
  // 떨어뜨릴 수 있다 (서로 다른 컨텍스트로는 collision detection 이
  // 동작하지 않음). activeDrag 의 종류를 같이 기억해 FolderRow 가
  // disabled 판정을 정확히 하도록 한다 (폴더 cycle 방지 vs reference 항상 허용).
  const [activeDrag, setActiveDrag] = useState<{
    kind: "folder" | "reference";
    id: string;
    /** reference drag 일 때 함께 옮겨질 id 들. 단일 카드 드래그면 [id] 한 개. */
    ids?: string[];
    /** DragOverlay 미리보기에 쓸 첫 번째 항목의 메타. reference 만 의미 있음. */
    item?: ReferenceItem;
  } | null>(null);

  /* 자동 thumbnail 백필이 한 자료를 끝낼 때마다 호출되어 in-memory items
     의 해당 행의 thumbnail_url 만 in-place 로 교체한다. 같은 세션 안에서
     스크롤로 새로 화면에 들어오는 카드가 이미 최적화된 webp 를 받게 되어,
     사용자가 효과를 즉시 체감한다.

     concurrency=1 + 자료당 1~3 초 페이스 → setItems 가 트리거하는 9-memo
     cascade 도 그 페이스로만 발사된다. 그래도 사용자 인터랙션(스크롤/필터)
     과 겹치지 않도록 `startTransition` 으로 감싸 interruptible 하게 만든다.
     실패/skipped 케이스는 thumbnail_url 변경이 없어 setItems 자체를 건너뛴다. */
  const handleThumbnailBackfillItem = useCallback((event: ThumbnailBackfillItemEvent) => {
    if (event.result !== "success" || !event.thumbnailUrl) return;
    const id = event.item.id;
    const newUrl = event.thumbnailUrl;
    startTransition(() => {
      setItems((prev) => {
        const idx = prev.findIndex((row) => row.id === id);
        if (idx < 0) return prev;
        const cur = prev[idx];
        if (cur.thumbnail_url === newUrl) return prev;
        const next = prev.slice();
        next[idx] = { ...cur, thumbnail_url: newUrl };
        return next;
      });
    });
  }, []);

  /* Animated-preview 백필 성공 시 카드 preview_url 을 in-place 교체 — 그리드가
     무거운 원본 대신 경량 프리뷰로 재생을 전환한다. thumbnail 백필과 동일한
     startTransition + 동일 값이면 skip 패턴. */
  const handleAnimatedPreviewBackfillItem = useCallback((event: AnimatedPreviewBackfillItemEvent) => {
    if (event.result !== "success" || !event.previewUrl) return;
    const id = event.item.id;
    const newUrl = event.previewUrl;
    startTransition(() => {
      setItems((prev) => {
        const idx = prev.findIndex((row) => row.id === id);
        if (idx < 0) return prev;
        const cur = prev[idx];
        if (cur.preview_url === newUrl) return prev;
        const next = prev.slice();
        next[idx] = { ...cur, preview_url: newUrl };
        return next;
      });
    });
  }, []);

  const loadReferences = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    /* 캐시 fresh-skip — 같은 세션 안에서 Dashboard ↔ Library 를 자주
       왕복하는 시나리오에서 가장 큰 jank 의 원인이던 *두 번째 setItems
       (refetch 결과)* 자체를 제거. 30초 이내 재진입은 캐시된 데이터를
       그대로 신뢰하고 supabase 재요청도 하지 않는다. usageCounts 는
       useState 라 mount 마다 빈 객체로 리셋되므로 idle 시점에 한 번
       다시 채워준다(rows.id 기반 가벼운 쿼리 — select(*) 의 대규모
       페이로드와는 비용 차이가 큼). 팔레트 backfill 도 같은 idle 안에서
       다시 enqueue — 큐 안에서 dedupe 되지 않더라도 이미 채워진 항목은
       내부 가드(`color_palette.length > 0`) 로 즉시 skip 된다. */
    if (
      libraryCache
      && Date.now() - libraryCache.loadedAt < LIBRARY_CACHE_TTL_MS
    ) {
      const cachedRows = libraryCache.items;
      setLoading(false);
      runIdle(() => {
        if (seq !== loadSeqRef.current) return;
        // LS 스캔은 sync 라 await/Promise 분기 밖에서 먼저 한 번 — DB
        // 응답을 기다리지 않고 인스펙터 "사용 위치" 가 즉시 채워진다.
        // Brief 드래프트 + Conti Compare Library 한 번에 스캔.
        const ls = scanAllUsageFromLocalStorage();
        setUsageLocations(ls.byRefId);
        getReferenceUsageCounts(cachedRows.map((row) => row.id))
          .then((counts) => {
            if (seq !== loadSeqRef.current) return;
            setUsageCounts(mergeUsageCounts(counts, ls.countsByRefId));
          })
          .catch((err) => {
            console.warn("[library] usage counts failed", err);
            // DB 실패 시에도 LS 카운트만이라도 노출 — 0 이 더 답답함.
            if (seq !== loadSeqRef.current) return;
            setUsageCounts(ls.countsByRefId);
          });
        backfillReferencePalettes(cachedRows);
      });
      /* Library 진입 시 idle 백그라운드 thumbnail 자동 백필 스케줄.
         스케줄러 자체가 4 초 delay + idle 가드 + per-item AbortSignal 을
         가지고 있어 첫 페인트/스크롤과 절대 겹치지 않는다. 사용자가 보는
         앞에서 카드 thumbnail 이 점진적으로 최적화된 webp 로 교체된다.
         이전 스케줄이 살아 있으면 abort — 새 데이터 셋으로 갱신. */
      thumbAutoBackfillCancelRef.current?.();
      thumbAutoBackfillCancelRef.current = scheduleThumbnailAutoBackfill(cachedRows, {
        onItem: handleThumbnailBackfillItem,
      });
      /* GIF animated 프리뷰 백필 — 레거시/Eagle GIF 의 preview.webp 를 채운다.
         thumbnail 백필과 별도 processed set + 동시성 1 idle 스케줄. */
      animatedPreviewAutoBackfillCancelRef.current?.();
      animatedPreviewAutoBackfillCancelRef.current = scheduleAnimatedPreviewAutoBackfill(cachedRows, {
        onItem: handleAnimatedPreviewBackfillItem,
      });
      return;
    }

    /* 캐시가 살아 있는 동안은 loading 스피너를 띄우지 않는다 — 그리드는
       이미 캐시된 항목으로 채워져 있고, 결과가 도착하면 자연스럽게
       diff 가 setItems 로 합류된다. 첫 진입(캐시 없음) 만 기존 경로
       그대로 loading=true 로 빈 그리드 → 결과 표시 흐름을 유지. */
    if (!libraryCache) setLoading(true);
    setError(null);
    try {
      // Library page presents Trash as a quickFilter, so we need active+trashed
      // in a single in-memory list. ReferencePickerDrawer / Brief sync paths use
      // the default (trash-excluded) shape.
      const rows = await listReferences({ limit: REFERENCE_LOAD_LIMIT, includeTrashed: true });
      if (seq !== loadSeqRef.current) return;
      // 캐시 갱신은 setItems 와 같은 tick 에서 수행해 둔다. 다음 진입의
      // 첫 페인트가 가장 최신 데이터로 즉시 그려진다.
      writeLibraryCache(rows);
      /* startTransition — 1만 항목 setItems 가 트리거하는 9개 useMemo
         cascade(filteredItems, activeItems, counts, linkPlatformCounts,
         folders, tagsList, duplicateCounts, dragSourceById, justifiedRows)
         를 *interruptible* 로 만든다. 이 cascade 자체를 막을 수는 없으나
         (정확한 그리드를 그리려면 어차피 모두 계산되어야 함), React 18
         scheduler 가 사용자 입력(스크롤/클릭/드래그) 을 가운데에 끼워 넣을
         수 있어 체감 멈춤이 사라진다. setSelectedId 도 rows 와 의미상
         같은 transition 에 묶어 깜빡임을 방지. */
      startTransition(() => {
        setItems(rows);
        /* 라이브러리 진입 시 자동으로 첫 아이템을 선택하지 않는다 — 빈 캔버스
           처럼 인스펙터/프리뷰가 비어 있어야 사용자가 어떤 카드를 의도적으로
           눌렀는지 분명해진다(beta 2.0.0 UX). 단, reload 가 사용자의 명시적
           선택 도중에 일어나는 경우(예: 업로드/이동 후) current 가 여전히
           rows 에 있으면 그대로 보존하고, 사라졌다면 null 로 떨어뜨린다. */
        setSelectedId((current) => {
          const next = current && rows.some((row) => row.id === current) ? current : null;
          setSelectedIds(next ? new Set([next]) : new Set());
          setLastSelectedId(next);
          return next;
        });
      });
      /* 후속 사이드워크들은 모두 idle 타임에 미룬다 — 그리드 첫 페인트와
         스크롤 응답이 절대적으로 우선. 모두 best-effort 라 실패해도 라이브
         러리 자체는 동작한다.
           1) getReferenceUsageCounts: 카드 배지(사용 횟수) 채움
           2) backfillReferencePalettes: 빈 팔레트 + 썸네일 있는 항목들 한해
              canvas/getImageData 로 8 swatch 추출(1장당 10~30ms × 동시성 4).
              Eagle 1000장 일괄 import 직후 진입 시 메인스레드 점유의 가장
              큰 원인이었음 — idle 로 미루면 첫 페인트 jank 가 사라진다. */
      runIdle(() => {
        if (seq !== loadSeqRef.current) return;
        const ls = scanAllUsageFromLocalStorage();
        setUsageLocations(ls.byRefId);
        getReferenceUsageCounts(rows.map((row) => row.id))
          .then((counts) => {
            if (seq !== loadSeqRef.current) return;
            setUsageCounts(mergeUsageCounts(counts, ls.countsByRefId));
          })
          .catch((err) => {
            console.warn("[library] usage counts failed", err);
            if (seq !== loadSeqRef.current) return;
            setUsageCounts(ls.countsByRefId);
          });
        backfillReferencePalettes(rows);
      });
      /* Cache 경로와 동일 — idle thumbnail 자동 백필 스케줄. 신규 진입(캐시
         miss) 의 경우에도 4 초 delay 안에 첫 페인트 + useMemo cascade 가
         가라앉아 사용자 입력과 겹치지 않는다. */
      thumbAutoBackfillCancelRef.current?.();
      thumbAutoBackfillCancelRef.current = scheduleThumbnailAutoBackfill(rows, {
        onItem: handleThumbnailBackfillItem,
      });
      animatedPreviewAutoBackfillCancelRef.current?.();
      animatedPreviewAutoBackfillCancelRef.current = scheduleAnimatedPreviewAutoBackfill(rows, {
        onItem: handleAnimatedPreviewBackfillItem,
      });
    } catch (err) {
      if (seq !== loadSeqRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, [handleThumbnailBackfillItem, handleAnimatedPreviewBackfillItem]);

  useEffect(() => {
    void loadReferences();
    return () => {
      loadSeqRef.current += 1;
      /* 페이지 unmount 또는 workspace 전환 시 백그라운드 thumbnail 백필을
         즉시 정지. 진행 중인 자료는 끝까지 완료되고 그 다음부터 스케줄링
         중단(AbortSignal 정책) — 부분 진행 상태도 processed-ID set 에 저장
         되므로 다음 진입에서 자연 재개. */
      thumbAutoBackfillCancelRef.current?.();
      thumbAutoBackfillCancelRef.current = null;
      animatedPreviewAutoBackfillCancelRef.current?.();
      animatedPreviewAutoBackfillCancelRef.current = null;
    };
  }, [loadReferences]);

  /* items 가 setItems(current => ...) 흐름(업로드, 이름변경, 휴지통 등)
     으로 변할 때마다 다음 진입을 위한 캐시를 따라잡는다. 사용자가 자주
     라이브러리를 들락거리는 시나리오에서 캐시가 stale 인 채로 남으면
     다시 진입할 때 시각적 점프(낡은 데이터 → 새 데이터)가 생기므로,
     로컬 변경분도 캐시에 반영한다. 첫 진입 직후의 setItems(rows) 는 이미
     loadReferences 안에서 동기적으로 writeLibraryCache 한 뒤이므로 이
     effect 는 사실상 mutation 이후의 갱신만 담당한다.
     ──────────────────────────────────────────────────────────────────
     비용 관리:
     1) debounce 1500ms — 빠른 연속 mutation 을 모아 1회만 쓰기.
        500ms 였을 때 사용자가 그리드를 빠르게 만지는 동안 의도치 않게
        화면 한가운데에서 캐시 쓰기가 발사되던 케이스 차단.
     2) JSON.stringify(items) 가 1万 항목 × ~1KB ≈ 5–15MB string 이라
        직렬화 자체가 50–200ms 메인스레드 점유를 만들 수 있다.
        runIdle 로 한 번 더 감싸 사용자 인터랙션과 겹치지 않게 미룬다.
     3) sessionStorage.setItem 도 동기 I/O 라 idle 안에서 처리 — 직렬화
        와 같은 유휴 슬롯에서 끝나야 효과가 있음. */
  useEffect(() => {
    if (items.length === 0) return;
    let idleHandle: number | null = null;
    const timeoutHandle = window.setTimeout(() => {
      idleHandle = runIdle(() => {
        writeLibraryCache(items);
      });
    }, 1500);
    return () => {
      window.clearTimeout(timeoutHandle);
      if (idleHandle !== null) cancelIdle(idleHandle);
    };
  }, [items]);

  /* saved filters 는 LibraryToolbar 의 우상단 드롭다운에서만 사용되어
     첫 페인트 critical path 가 아니다. idle 로 미루고, 사용자가 실제로
     필터 메뉴를 열기 전에 결과가 도착해 있을 가능성이 매우 높다. */
  useEffect(() => {
    const handle = runIdle(() => {
      listSavedFilters()
        .then(setSavedFilters)
        .catch((err) => {
          console.warn("[library] saved filters failed to load", err);
        });
    });
    return () => cancelIdle(handle);
  }, []);

  const refreshStorageUsage = useCallback(async () => {
    try {
      setStorageUsage(await getStorageUsage());
    } catch (err) {
      console.warn("[library] storage usage failed", err);
    }
    // 같은 갱신 주기에 cleanable 도 같이 fetch — 두 숫자가 함께 보이는 게
    // 사용자 경험상 일관됨. 실패는 silent — 칩이 cleanable suffix 만 안 뜨고
    // 본문 사용량은 계속 표시됨.
    try {
      const preview = await previewOrphanCleanup();
      setCleanableBytes(preview.bytes_reclaimable ?? 0);
    } catch (err) {
      console.warn("[library] orphan preview failed", err);
    }
  }, []);

  /* 스토리지 사용량 / orphan preview 는 둘 다 백엔드 파일시스템 walk 라
     비용이 있고, 결과는 우상단 칩에만 노출되어 critical path 가 아니다.
     첫 페인트 이후 idle 시점에 1회 fetch — Dashboard 의 getStorageUsageByProject
     패턴과 동일. mount 시 명시적 refetch 트리거(refreshStorageUsage)는
     사용자 액션(cleanup 등) 이후 그대로 즉시 동작. */
  useEffect(() => {
    const handle = runIdle(() => {
      void refreshStorageUsage();
    });
    return () => cancelIdle(handle);
  }, [refreshStorageUsage]);

  useEffect(() => {
    localStorage.setItem("preflow.library.gridSize", String(gridSize));
  }, [gridSize]);

  useEffect(() => {
    localStorage.setItem("preflow.library.sortKey", sortKey);
    localStorage.setItem("preflow.library.sortOrder", sortOrder);
  }, [sortKey, sortOrder]);

  // "Show subfolder content" 선호 영구화. 디폴트(=true) 일 땐 *키를 삭제* 해
  // localStorage 가 잡다해지지 않게 두고, 사용자가 OFF 로 변경한 경우에만
  // "false" 를 명시 저장. 다음 세션이 같은 디폴트 동작을 자연스럽게 받음.
  useEffect(() => {
    try {
      if (recursiveActiveFolder) {
        localStorage.removeItem("preflow.library.recursiveActiveFolder");
      } else {
        localStorage.setItem("preflow.library.recursiveActiveFolder", "false");
      }
    } catch {
      /* 저장 실패는 in-memory state 만 유지하면 충분 — 다음 변경 때 재시도 */
    }
  }, [recursiveActiveFolder]);

  useEffect(() => {
    const refresh = () => setUserFolderPaths(getUserFolderPaths());
    window.addEventListener("preflow-library-folders-changed", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("preflow-library-folders-changed", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  // 다른 윈도우/탭에서 사이드바·인스펙터 폭이 바뀐 경우 동기화.
  // - 같은 윈도우 안의 다른 인스턴스: CustomEvent 채널 (각 폭마다 별도)
  // - 다른 BrowserWindow: storage 이벤트 (key 로 분기)
  useEffect(() => {
    const syncSidebar = () => setSidebarWidth(readLibrarySidebarWidth());
    const syncInspector = () => setInspectorWidth(readLibraryInspectorWidth());
    const onStorage = (event: StorageEvent) => {
      if (event.key === "preflow.library.sidebarWidth") syncSidebar();
      else if (event.key === "preflow.library.inspectorWidth") syncInspector();
    };
    window.addEventListener(LIBRARY_SIDEBAR_WIDTH_CHANGED_EVENT, syncSidebar);
    window.addEventListener(LIBRARY_INSPECTOR_WIDTH_CHANGED_EVENT, syncInspector);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(LIBRARY_SIDEBAR_WIDTH_CHANGED_EVENT, syncSidebar);
      window.removeEventListener(LIBRARY_INSPECTOR_WIDTH_CHANGED_EVENT, syncInspector);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // "Show subfolder content" 토글은 폴더 사이를 이동해도 *리셋하지 않는다* —
  // 사용자 글로벌 선호가 localStorage 에 영구화돼 있어서, 다른 폴더로 이동
  // 하거나 앱을 재시작해도 마지막 선택이 그대로 유지된다. (과거에는 폴더
  // 전환 시마다 디폴트로 강제 리셋했지만, 매번 같은 선호를 다시 켜야 하는
  // 수고가 발생해 영구화 정책으로 변경.)

  const upsertUploadedItem = useCallback((item: ReferenceItem) => {
    setItems((current) => [item, ...current.filter((row) => row.id !== item.id)]);
    setSelectedId(item.id);
    setSelectedIds(new Set([item.id]));
    setLastSelectedId(item.id);
    /* 방금 업로드 도장 — Date.now() 가 클수록 최신. 같은 id 가 다시
       업서트되면(예: classify 후 재업서트) timestamp 가 갱신돼 자연스럽게
       다시 위로 올라간다. */
    setFreshlyUploadedAt((current) => ({ ...current, [item.id]: Date.now() }));
  }, []);

  // 다른 윈도우/탭에서 그리드 숨김이 바뀌면 동기화.
  useEffect(() => {
    const sync = () => setGridHiddenIds(loadGridHidden());
    window.addEventListener(GRID_HIDDEN_CHANGED_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(GRID_HIDDEN_CHANGED_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  /** 그리드 숨김 토글 — 우클릭한 항목이 현재 선택에 포함되면 선택 전체를,
   *  아니면 그 항목 하나만 대상으로 한다(다른 그리드 액션과 동일 정책).
   *  selectedIds 대신 우클릭 시점에 캡처된 selectionSnapshotRef 를 본다 —
   *  Radix 메뉴 오픈/클릭 사이 selectedIds 가 1개로 좁혀져 다중 숨김이
   *  단건으로 떨어지던 회귀(Trash 등에서 이미 수정된 것과 동일)를 차단. */
  const mutateGridHidden = useCallback(
    (item: ReferenceItem, hide: boolean) => {
      const snapshot = selectionSnapshotRef.current;
      const targetIds = snapshot.size > 0 && snapshot.has(item.id) ? [...snapshot] : [item.id];
      setGridHiddenIds((prev) => {
        const next = new Set(prev);
        for (const id of targetIds) {
          if (hide) next.add(id);
          else next.delete(id);
        }
        saveGridHidden(next);
        return next;
      });
    },
    [],
  );
  const handleHideFromGrid = useCallback((item: ReferenceItem) => mutateGridHidden(item, true), [mutateGridHidden]);
  const handleUnhideFromGrid = useCallback((item: ReferenceItem) => mutateGridHidden(item, false), [mutateGridHidden]);

  /* Phase D: 새 import 한 자료가 AI 자동 분류 폴더에 속해 있으면 분류 큐에
     넣는다. 같은 자료가 여러 폴더 태그를 동시에 갖고 있어도, 가장 깊은
     (= 가장 구체적인) 폴더 설정을 우선시한다 — 사용자 직관상 "내가 가장
     명시적으로 옮긴 곳" 이 의도와 가깝다. 큐가 완료되면 결과 item 으로
     로컬 상태도 함께 갱신. */
  const maybeAutoClassifyImport = useCallback(
    (item: ReferenceItem) => {
      if (!item || !item.id) return;
      // AI 베리에이션 결과는 "깨끗한 상태(태그/AI 분석 없음)" 로 들어와야 하므로,
      // 폴더의 autoClassify 설정이 켜져 있어도 자동 분류 큐에 넣지 않는다.
      if (item.variation_of) return;
      const folderTags = item.tags.filter((tag) => tag.startsWith("folder:"));
      if (folderTags.length === 0) return;
      let resolved: { path: string; settings: FolderAiSettingsType } | null = null;
      for (const tag of folderTags) {
        const path = tag.replace(/^folder:/, "");
        const settings = folderAiSettingsMap[path];
        if (!settings || !settings.autoClassify) continue;
        /* 가장 긴 path = 가장 깊은 폴더. tie 가 있어도 첫 등장 우선
           으로 안정. */
        if (!resolved || path.length > resolved.path.length) {
          resolved = { path, settings };
        }
      }
      if (!resolved) return;
      enqueueClassify(item, {
        autoApplyTags: resolved.settings.autoApplyTags,
        language: effectiveAiLanguageRef.current,
        tagLanguage: effectiveAiTagLanguageRef.current,
        onSettled: ({ item: settled }) => {
          if (settled) {
            /* 큐 완료 시 그리드/인스펙터에 즉시 반영. 단순 replace —
               freshness timestamp 는 유지하기 위해 upsertUploadedItem
               이 아니라 가벼운 patch 만 적용. */
            setItems((current) =>
              current.map((row) => (row.id === settled.id ? settled : row)),
            );
          }
        },
      });
    },
    [folderAiSettingsMap],
  );

  // Shape 필터를 위한 dimension lazy backfill — LibraryGrid 가 <img>/<video>
  // 의 자연 해상도를 처음 보고할 때(ref) 호출된다. DB 의 width/height 가
  // 이미 채워진 항목은 건너뛰고, 비어 있는 항목만 updateReference 로
  // 영구화한 뒤 로컬 items 도 즉시 patch 한다. 같은 세션에서 같은 항목이
  // 반복 마운트되어도 한 번만 처리(ref Set dedupe).
  const measuredItemsRef = useRef<Set<string>>(new Set());
  const handleItemDimensionsMeasured = useCallback((id: string, w: number, h: number) => {
    if (!w || !h) return;
    if (measuredItemsRef.current.has(id)) return;
    measuredItemsRef.current.add(id);
    let needsPersist = false;
    setItems((current) => {
      const idx = current.findIndex((row) => row.id === id);
      if (idx < 0) return current;
      const row = current[idx];
      if (row.width && row.height) return current;
      needsPersist = true;
      const next = current.slice();
      next[idx] = { ...row, width: w, height: h };
      return next;
    });
    if (!needsPersist) return;
    void updateReference(id, { width: w, height: h }).catch(() => {
      // 백필은 best-effort — 네트워크/권한 오류 발생 시 사용자에게 노이즈를
      // 만들지 않는다. 다음 세션에 또 시도된다(ref Set 은 세션 한정).
    });
  }, []);

  // 현재 활성 폴더(`folder:...`) 가 있으면 새로 만들어지는 reference 에
  // 자동으로 그 폴더 태그를 부여한다. Quick filter / 일반 태그 / Smart
  // Folder 컨텍스트에서는 이 값이 null 이라 일반 라이브러리(태그 없음)로
  // 들어간다. drop / file-picker / paste / URL submit 네 경로 모두 동일.
  const uploadFolderTag = activeTag?.startsWith("folder:") ? activeTag : null;
  const uploadFolderLabel = uploadFolderTag
    ? uploadFolderTag.replace(/^folder:/, "").split("/").filter(Boolean).pop() ?? null
    : null;
  /* Favorites quick filter 에서 추가한 항목은 처음부터 별표(★) 가 켜진
     상태로 들어가야 자연스럽다 — uploadFolderTag 와 동일하게 어떤 진입점
     (file/url/folder/pack) 에서든 이 옵션이 일관 적용된다. */
  const uploadAsFavorite = quickFilter === "favorites";

  /** 업로드 옵션 — UploadReferenceOptions 의 tags 와 isFavorite 를 채워
   *  둔다. createLinkRef / createYoutubeRef / uploadReferenceFile 모두 동일
   *  옵션 인터페이스를 공유하므로 그대로 재사용. */
  const uploadOptions = useMemo(
    () => {
      const opts: UploadReferenceOptions = {};
      if (uploadFolderTag) opts.tags = [uploadFolderTag];
      if (uploadAsFavorite) opts.isFavorite = true;
      return opts;
    },
    [uploadAsFavorite, uploadFolderTag],
  );

  /* 자료 추가가 의미 없는 quick filter 뷰에서는 그리드 영역의 업로드
     어포던스(드래그 오버레이 + empty state Files/Folder 버튼)를 숨긴다.
     사이드바 Add 메뉴는 그대로 유지 — 사용자가 명시적으로 추가하려는
     의도라면 막지 않음. Favorites / 폴더 / Smart Folder / All 은 추가가
     자연스럽게 의미 있으므로 허용. */
  const viewSupportsUpload = !(
    quickFilter === "untagged"
    || quickFilter === "recentlyUsed"
    || quickFilter === "unclassified"
    || quickFilter === "variations"
    || quickFilter === "duplicates"
    || quickFilter === "trash"
  );

  /**
   * .preflowlib / .preflowpack 패키지 파일을 PackImportDialog 흐름으로
   * 라우팅. Add → Choose Files / 드래그-드랍 양쪽에서 공통 사용. 이미
   * 미리보기까지 만들어 둔 뒤 다이얼로그를 열기 때문에 사용자는 Choose
   * Pack 단계 없이 바로 import strategy 선택 화면을 본다. 파일 절대경로는
   * preload 의 webUtils.getPathForFile 로 받아 backend 의 임시 디렉터리로
   * 복사된 다음 미리보기를 만든다.
   */
  const handlePackFile = useCallback(async (file: File): Promise<boolean> => {
    const filePath = window.preflowWindow?.getPathForFile?.(file) ?? "";
    if (!filePath) {
      toast({
        variant: "destructive",
        title: t("library.toast.cannotReadPack", { name: file.name }),
        description: t("library.toast.cannotReadPackDesc"),
      });
      return false;
    }
    try {
      const preview = await previewPackFromPath(filePath);
      setInitialPackPreview(preview);
      setImportPackOpen(true);
      return true;
    } catch (err) {
      toast({
        variant: "destructive",
        title: t("library.toast.packPreviewFailed", { name: file.name }),
        description: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }, [toast, t]);

  /* 팩 파일(.preflowlib) 더블클릭 임포트 — 활성 워크스페이스가 라이브러리일 때만
     소비한다. 워크스페이스 종류 전환은 App 의 PackOpenRouter 가 담당하고, 전환이
     끝나 라이브러리가 활성이 된 시점에 이 effect 가 pending 을 집어 미리보기 →
     PackImportDialog(확인/import) 흐름으로 연결한다. */
  useEffect(() => {
    const consume = async () => {
      const pending = readPendingPackPath();
      if (!pending || packKindFromPath(pending) !== "library") return;
      await ensureWorkspacesLoaded();
      if (getCachedActive()?.kind !== "library") return;
      clearPendingPackPath();
      try {
        const preview = await previewPackFromPath(pending);
        setInitialPackPreview(preview);
        setImportPackOpen(true);
      } catch (err) {
        const name = pending.split(/[\\/]/).pop() ?? pending;
        toast({
          variant: "destructive",
          title: t("library.toast.packPreviewFailed", { name }),
          description: err instanceof Error ? err.message : String(err),
        });
      }
    };
    void consume();
    return subscribePendingPack(() => {
      void consume();
    });
  }, [toast, t]);

  /**
   * Electron 네이티브 다이얼로그 / 폴더 드래그-드랍에서 받은 절대경로
   * 목록을 브라우저 File 객체로 변환. webSecurity:false 인 메인 윈도에서
   * `file://` fetch 가 직접 동작하므로 별도 IPC 없이 동기적으로 읽어
   * 기존 `handleFiles` ingest 파이프와 그대로 호환되게 만든다. 동시
   * fetch 가 폭주하지 않도록 4 개씩 묶어 처리.
   */
  const filesFromPaths = useCallback(async (paths: string[]): Promise<File[]> => {
    const out: File[] = [];
    const failures: Array<{ name: string; message: string }> = [];
    const PARALLEL = 4;
    for (let i = 0; i < paths.length; i += PARALLEL) {
      const slice = paths.slice(i, i + PARALLEL);
      const batch = await Promise.all(
        slice.map(async (full) => {
          const url = pathToFileUrl(full);
          const name = full.split(/[\\/]/).pop() || "reference";
          try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            const type = blob.type || guessMimeFromName(name);
            return new File([blob], name, { type });
          } catch (err) {
            failures.push({ name, message: err instanceof Error ? err.message : String(err) });
            return null;
          }
        }),
      );
      for (const f of batch) {
        if (f) out.push(f);
      }
    }
    for (const fail of failures.slice(0, 3)) {
      toast({ variant: "destructive", title: t("library.toast.readFailed", { name: fail.name }), description: fail.message });
    }
    if (failures.length > 3) {
      toast({
        variant: "destructive",
        title: t("library.toast.moreFilesUnreadable", { n: failures.length - 3 }),
        description: t("library.toast.seeConsole"),
      });
      for (const fail of failures.slice(3)) {
        console.warn("[library] read-from-path failed", fail.name, fail.message);
      }
    }
    return out;
  }, [toast, t]);

  /* 변환 없이 원본 그대로 업로드하는 공통 루프 — 진행 토스트 + 성공/실패
     집계. handleFiles 의 즉시 업로드 경로와 "원본 업로드" 선택 경로가 함께
     쓴다. uploadReferenceFile 이 영상은 자체적으로 포스터(렌더러 또는 ffmpeg)
     를 만들어 thumbnail_url 을 채운다. */
  const uploadFilesDirect = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    let successCount = 0;
    const failures: Array<{ name: string; message: string }> = [];
    const total = files.length;
    const loadingToast = toast({
      title: t("library.toast.importProgress", { done: 0, total }),
      duration: 600_000,
    });
    let processed = 0;
    for (const file of files) {
      try {
        const item = await uploadReferenceFile(file, uploadOptions);
        upsertUploadedItem(item);
        maybeAutoClassifyImport(item);
        successCount += 1;
      } catch (err) {
        failures.push({ name: file.name, message: err instanceof Error ? err.message : String(err) });
      }
      processed += 1;
      loadingToast.update({ title: t("library.toast.importProgress", { done: processed, total }) });
    }
    loadingToast.dismiss();
    if (successCount > 0) {
      toast({
        title: uploadFolderLabel ? t("library.toast.savedTo", { folder: uploadFolderLabel }) : t("library.toast.referenceSaved"),
        description: t("library.toast.nItemsAdded", { n: successCount, s: successCount > 1 ? "s" : "" }),
      });
    }
    for (const fail of failures.slice(0, 3)) {
      toast({ variant: "destructive", title: t("library.toast.failedName", { name: fail.name }), description: fail.message });
    }
    if (failures.length > 3) {
      toast({
        variant: "destructive",
        title: t("library.toast.moreFailures", { n: failures.length - 3 }),
        description: t("library.toast.seeConsole"),
      });
      for (const fail of failures.slice(3)) {
        console.warn("[library] upload failed", fail.name, fail.message);
      }
    }
  }, [maybeAutoClassifyImport, toast, uploadFolderLabel, uploadOptions, upsertUploadedItem, t]);

  const handleFiles = useCallback(async (fileList: FileList | File[]) => {
    const all = Array.from(fileList);
    if (all.length === 0) return;

    /* .preflowlib / .preflowpack 은 일반 미디어 ingest 파이프를 타면 안 된다
       (uploadReferenceFile 의 detectReferenceKind 가 거부) — 별도 라우팅으로
       PackImportDialog 를 띄운다. 한 batch 안에 여러 패키지가 있어도
       다이얼로그가 한 번에 하나만 떠야 의미 있으므로 첫 번째 패키지만
       처리하고 나머지는 토스트로 안내. */
    const packFiles = all.filter((file) => isPackFile(file.name));
    const mediaFiles = all.filter((file) => !isPackFile(file.name));

    if (packFiles.length > 0) {
      void handlePackFile(packFiles[0]);
      if (packFiles.length > 1) {
        toast({
          title: t("library.toast.morePackSkipped", { n: packFiles.length - 1 }),
          description: t("library.toast.morePackSkippedDesc"),
        });
      }
    }

    if (mediaFiles.length === 0) return;

    // 사전 분류:
    //   - 비영상 또는 ≤300MB 영상       → directFiles (즉시 업로드)
    //   - 300MB 초과 영상, 길이 ≤ 10분   → convertCands (변환/원본 선택 다이얼로그)
    //   - 길이 > 10분                    → tooLong (변환·원본 모두 불가, 거부)
    //  (1GB 초과 원본은 저장 불가지만 변환은 가능 — 다이얼로그에서 "원본 업로드"
    //   버튼이 비활성/변환 경로로 처리한다.)
    const isOversizeVideo = (f: File) =>
      (f.type.startsWith("video/") || /\.(mp4|mov|webm)$/i.test(f.name)) &&
      f.size > VIDEO_CONVERT_THRESHOLD_BYTES;

    const directFiles: File[] = [];
    const convertCands: File[] = [];
    const tooLong: Array<{ name: string; durationSec: number }> = [];
    for (const file of mediaFiles) {
      if (!isOversizeVideo(file)) {
        directFiles.push(file);
        continue;
      }
      // 길이는 변환으로 줄일 수 없으므로 한도 초과는 변환 대상에서 제외.
      let durationSec = 0;
      try {
        durationSec = (await probeVideoMeta(file)).durationSec;
      } catch {
        // 알 수 없으면(<video>.duration Infinity 등) 변환 시도 — main(ffmpeg)이 길이 재검증.
        durationSec = 0;
      }
      if (durationSec > MAX_DURATION_SEC) tooLong.push({ name: file.name, durationSec });
      else convertCands.push(file);
    }

    // 길이 초과 — 변환 불가, 전용 toast.
    for (const tl of tooLong) {
      toast({
        variant: "destructive",
        title: t("library.toast.videoTooLong"),
        description: t("library.toast.videoTooLongDesc", {
          limit: MAX_DURATION_SEC / 60,
          min: Math.ceil(tl.durationSec / 60),
        }),
      });
    }

    // 바로 업로드 가능한 파일(≤300MB 또는 비영상) — 진행 토스트와 함께.
    await uploadFilesDirect(directFiles);

    // 300MB 초과 영상 — 다중 드랍이어도 한 번만 확인 다이얼로그를 띄운다.
    if (convertCands.length > 0) {
      setConvertCandidates(convertCands);
    }
  }, [handlePackFile, toast, uploadFilesDirect, t]);

  /* 확인 다이얼로그에서 "변환 후 업로드" 를 누르면 호출 — 후보를 순차 변환해
     업로드한다. ffmpeg 부하 때문에 병렬이 아닌 1개씩. 진행 표시는 *비차단
     토스트* 로 띄워 변환 중에도 라이브러리를 계속 쓸 수 있게 하고, 토스트의
     "취소" 액션으로 큐 전체를 중단한다(AbortController). */
  const runVideoConversions = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    const abort = new AbortController();
    convertAbortRef.current = abort;
    const total = files.length;

    const progressToast = toast({
      title: t("library.videoConvert.running", { name: files[0].name, index: 1, total, pct: 0 }),
      duration: 600_000,
      action: (
        <ToastAction altText={t("library.videoConvert.cancel")} onClick={() => convertAbortRef.current?.abort()}>
          {t("library.videoConvert.cancel")}
        </ToastAction>
      ),
    });

    let succeeded = 0;
    const failures: Array<{ name: string; message: string }> = [];
    for (let i = 0; i < files.length; i++) {
      if (abort.signal.aborted) break;
      const file = files[i];
      const setTitle = (pct: number) =>
        progressToast.update({
          title: t("library.videoConvert.running", { name: file.name, index: i + 1, total, pct }),
        });
      setTitle(0);
      try {
        const converted = await transcodeVideoFile({
          file,
          targetBytes: VIDEO_CONVERT_TARGET_BYTES,
          signal: abort.signal,
          onProgress: (ratio) => setTitle(Math.round(ratio * 100)),
        });
        const item = await uploadReferenceFile(converted, uploadOptions);
        upsertUploadedItem(item);
        maybeAutoClassifyImport(item);
        succeeded += 1;
      } catch (err) {
        if (err instanceof TranscodeCancelledError || abort.signal.aborted) break;
        failures.push({ name: file.name, message: err instanceof Error ? err.message : String(err) });
      }
    }
    const aborted = abort.signal.aborted;
    convertAbortRef.current = null;
    progressToast.dismiss();

    if (succeeded > 0) {
      toast({
        title: uploadFolderLabel ? t("library.toast.savedTo", { folder: uploadFolderLabel }) : t("library.toast.referenceSaved"),
        description: t("library.toast.nItemsAdded", { n: succeeded, s: succeeded > 1 ? "s" : "" }),
      });
    }
    for (const fail of failures.slice(0, 3)) {
      toast({ variant: "destructive", title: t("library.toast.failedName", { name: fail.name }), description: fail.message });
    }
    if (aborted) {
      toast({ title: t("library.toast.convertCancelled") });
    }
  }, [maybeAutoClassifyImport, toast, uploadFolderLabel, uploadOptions, upsertUploadedItem, t]);

  /* 워크스페이스 전환(=location.reload) 직전 — 변환 진행 중이면 reload 너머로
     "취소됨" 안내를 전달하기 위해 localStorage 플래그를 남긴다. ffmpeg 프로세스
     자체는 메인의 did-start-navigation 훅이 정리한다. 새 페이지(App)가 마운트
     시 이 플래그를 읽어 토스트를 띄운다. */
  useEffect(() => {
    const onPageHide = () => {
      if (!convertAbortRef.current) return;
      try {
        localStorage.setItem(CONVERT_CANCELLED_FLAG, "1");
      } catch {
        /* localStorage 불가 환경 — 토스트 안내만 생략(변환 정리는 메인이 수행) */
      }
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  const handleUrlSubmit = useCallback(async (event?: FormEvent) => {
    event?.preventDefault();
    const url = urlInput.trim();
    if (!url) return;
    try {
      const item = await createLinkReference(url, uploadOptions);
      upsertUploadedItem(item);
      maybeAutoClassifyImport(item);
      setUrlInput("");
      setPasteUrlOpen(false);
      toast({
        title: uploadFolderLabel ? t("library.toast.savedTo", { folder: uploadFolderLabel }) : t("library.toast.referenceSaved"),
        description: item.kind === "youtube" ? t("library.toast.youtubeAdded") : t("library.toast.linkAdded"),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast({ variant: "destructive", title: t("library.toast.urlSaveFailed"), description: message });
    }
  }, [maybeAutoClassifyImport, toast, uploadFolderLabel, uploadOptions, upsertUploadedItem, urlInput, t]);

  /**
   * Add 메뉴 → Choose Files → Folder. 사용자가 고른 폴더가 Eagle Library
   * 라면 EagleImportDialog 를 미리보기와 함께 띄우고, 일반 폴더라면 안에
   * 들어 있는 미디어를 한 번에 ingest 한다. 폴더 드래그-드랍에서도 동일
   * 흐름으로 재사용.
   */
  const ingestScannedFolder = useCallback(
    async (scan: { rootPath: string; isEagleLibrary: boolean; eaglePreview: EaglePreview | null; mediaFiles: string[] }) => {
      if (scan.isEagleLibrary && scan.eaglePreview) {
        setEagleRoot(scan.rootPath);
        setEaglePreview(scan.eaglePreview);
        setEagleResult(null);
        setEagleImportOpen(true);
        return;
      }
      if (scan.mediaFiles.length === 0) {
        toast({
          title: t("library.toast.noMediaInFolder"),
          description: t("library.toast.noMediaInFolderDesc"),
        });
        return;
      }
      const files = await filesFromPaths(scan.mediaFiles);
      if (files.length > 0) await handleFiles(files);
    },
    [filesFromPaths, handleFiles, toast, t],
  );

  /* 드롭/붙여넣은 외부 URL 저장 — 이미지 직링크면 메인이 받아 *실제 이미지
     자료* 로 다운로드하고(외부 검색 결과를 끌어 담는 핵심 경로), 그 외(일반
     페이지/핀 URL)거나 이미지 다운로드가 실패하면 기존 링크 북마크로 폴백. */
  const importDroppedUrl = useCallback(
    async (rawUrl: string, addedDescKey: string, failTitleKey: string) => {
      const url = rawUrl.trim();
      if (!url) return;
      const finish = (item: ReferenceItem) => {
        upsertUploadedItem(item);
        maybeAutoClassifyImport(item);
        toast({
          title: uploadFolderLabel ? t("library.toast.savedTo", { folder: uploadFolderLabel }) : t("library.toast.referenceSaved"),
          description: t(addedDescKey),
        });
      };
      let looksLikeImage = false;
      try {
        looksLikeImage = /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(new URL(url).pathname);
      } catch {
        looksLikeImage = false;
      }
      if (looksLikeImage) {
        try {
          finish(await downloadImageAsReference(url, uploadOptions));
          return;
        } catch {
          /* 이미지 다운로드 실패(차단/비이미지 응답) → 링크 북마크로 폴백 */
        }
      }
      try {
        finish(await createLinkReference(url, uploadOptions));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast({ variant: "destructive", title: t(failTitleKey), description: message });
      }
    },
    [maybeAutoClassifyImport, toast, uploadFolderLabel, uploadOptions, upsertUploadedItem, t],
  );

  const handleDrop = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setIsDragging(false);

    /* dataTransfer.items 를 우선 사용 — `webkitGetAsEntry` 로 폴더와 파일을
       분리해서 처리한다. Electron 32+ 에선 `File.path` 가 사라졌기 때문에
       폴더의 절대경로는 preload.getPathForFile 으로 받아온 다음, backend
       의 `/library/scan-folder` 로 Eagle 여부 + 미디어 목록을 한 번에
       물어본다. items API 가 없는 환경(웹 빌드 등)에서는 기존
       dataTransfer.files 폴백 경로로 떨어진다. */
    const items = Array.from(event.dataTransfer.items ?? []);
    const directFiles: File[] = [];
    const droppedFolders: File[] = [];
    let usedItemsApi = false;

    for (const item of items) {
      if (item.kind !== "file") continue;
      usedItemsApi = true;
      const entry = item.webkitGetAsEntry?.();
      const file = item.getAsFile();
      if (!file) continue;
      if (entry?.isDirectory) droppedFolders.push(file);
      else directFiles.push(file);
    }

    if (!usedItemsApi && event.dataTransfer.files.length > 0) {
      void handleFiles(event.dataTransfer.files);
      return;
    }

    if (directFiles.length === 0 && droppedFolders.length === 0) {
      const text = event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain");
      if (text.trim()) {
        void importDroppedUrl(text.trim(), "library.toast.droppedUrlAdded", "library.toast.dropFailed");
      }
      return;
    }

    void (async () => {
      if (directFiles.length > 0) await handleFiles(directFiles);
      for (const folderFile of droppedFolders) {
        const folderPath = window.preflowWindow?.getPathForFile?.(folderFile) ?? "";
        if (!folderPath) {
          toast({
            variant: "destructive",
            title: t("library.toast.cannotReadFolder", { msg: folderFile.name }),
            description: t("library.toast.cannotReadFolderDesc"),
          });
          continue;
        }
        try {
          const scan = await scanLibraryFolder(folderPath);
          await ingestScannedFolder(scan);
        } catch (err) {
          toast({
            variant: "destructive",
            title: t("library.toast.folderImportFailed", { msg: folderFile.name }),
            description: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();
  }, [handleFiles, importDroppedUrl, ingestScannedFolder, toast, t]);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length > 0) {
        event.preventDefault();
        void handleFiles(files);
        return;
      }
      const text = event.clipboardData?.getData("text/plain")?.trim();
      if (text && /^https?:\/\//i.test(text)) {
        event.preventDefault();
        void importDroppedUrl(text, "library.toast.pastedUrlAdded", "library.toast.pasteFailed");
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [handleFiles, importDroppedUrl]);

  const activeSavedFilter = useMemo(
    () => savedFilters.find((filter) => filter.id === activeSavedFilterId) ?? null,
    [activeSavedFilterId, savedFilters],
  );

  /* AI 검색 토큰 IDF(down-weight) map — 라이브러리에서 흔한 토큰("night"/
     "city" 등)의 변별력을 자동으로 낮춘다. items 변동 시에만 재계산. 작은
     라이브러리(<30)는 buildReferenceTokenIdf 가 빈 map 을 돌려 사실상 비활성. */
  const referenceTokenIdf = useMemo(
    () => buildReferenceTokenIdf(items),
    [items],
  );

  /* Mood 필터 활성 시 한 번만 점수 계산. scoreReferences 는 items 전체에
     대해 doable — minScore 미만은 자동 탈락된다(빈 신호도 자동 0점).
     반환은 RecommendedReference[] 라 lookup 편의를 위해 id→score Map 으로
     접어 둔다. filteredItems 단계에서 has(id) 로 빠르게 통과/탈락 결정. */
  const moodScoreMap = useMemo<Map<string, number> | null>(() => {
    if (!moodFilter) return null;
    // 신호가 전부 비면(LLM 토큰 부족 등으로 추출 실패) scoreReferences 가 []
    // 를 돌려줘 그리드가 통째로 비어 버린다. 이 경우 필터를 적용하지 않아
    // (null 반환) 사용자가 자료를 계속 볼 수 있게 한다.
    const sig = moodFilter.signals;
    const hasAnySignal =
      !!sig &&
      (Object.keys(sig) as (keyof typeof sig)[]).some(
        (k) => Array.isArray(sig[k]) && sig[k].length > 0,
      );
    if (!hasAnySignal) return null;
    const map = new Map<string, number>();
    /* 라이브러리 전체에 대해 한 번에 점수 산정. 기본 limit(12) 는 필터링
       용도엔 너무 작아 명시적으로 items.length 로 풀어 둔다. allowedKinds
       기본값에 포함되지 않는 자료(image/gif/video/youtube 외) 는 자연
       탈락 — 이는 추천기 정책상 의도된 동작이다.
       strict 게이트는 제거됨 — 항상 점수 기반(완화) 매칭으로, minScore 슬라이더
       하나로만 표본 폭을 조절한다. 커버리지/핵심토큰(primary) 게이트를 끄면
       슬라이더를 내릴수록 표본이 매끄럽게 늘어 사용자가 폭을 직관적으로 통제. */
    const scored = scoreReferences(moodFilter.signals, items, {
      minScore: moodFilter.minScore,
      limit: items.length || 1,
      strict: false,
      /* IDF 는 항상 적용 — 흔한 토큰 감점은 정렬/minScore 효과를 개선한다. */
      idf: referenceTokenIdf,
      /* 게이트 없이 점수 기반만 사용(완화). */
      minCoverage: 0,
      requirePrimary: false,
    });
    for (const r of scored) map.set(r.item.id, r.score);
    /* Brief Match 앵커는 사용자가 명시적으로 고른 자료라 점수와 무관하게
       항상 그리드에 포함(상단 고정). 플라이아웃이 열려 있을 때만 적용해
       일반 AI 검색에는 영향이 없게 한다. */
    if (briefMatchOpen) {
      for (const id of briefAnchorIds) {
        if (!map.has(id)) map.set(id, Number.POSITIVE_INFINITY);
      }
    }
    return map;
  }, [items, moodFilter, briefMatchOpen, briefAnchorIds, referenceTokenIdf]);

  /* 브리프 매치 "분석 & 매칭" 시 플라이아웃이 호출 — 토큰 기반 1차 정렬
     (onApplyMoodFilter) 직후, LLM 으로 의미 기반 재정렬을 백그라운드 실행한다.
     완료되면 briefRerank.map 을 세팅해 그리드를 적합도 순으로 정렬/필터한다.
     in-flight 경합은 seq 토큰으로 최신 요청만 반영. */
  const handleRequestBriefRerank = useCallback(
    async (input: { briefText?: string; signals?: BriefSignals }) => {
      const seq = ++briefRerankSeqRef.current;
      setBriefRerank({ map: new Map(), loading: true });
      try {
        const ranked = await rerankReferencesForBrief(input, items, { maxCandidates: 60 });
        if (briefRerankSeqRef.current !== seq) return; // 더 최신 요청이 있음
        const map = new Map<string, number>();
        for (const r of ranked) map.set(r.id, r.fit);
        setBriefRerank({ map, loading: false });
        if (ranked.length === 0) {
          toast({
            title: t("briefMatch.rerankEmptyTitle"),
            description: t("briefMatch.rerankEmptyDesc"),
          });
        }
      } catch (e) {
        if (briefRerankSeqRef.current !== seq) return;
        console.warn("[LibraryPage] briefRerank failed:", (e as Error).message);
        setBriefRerank(null); // 실패 시 토큰 기반 결과로 폴백
      }
    },
    [items, t, toast],
  );

  /* 그리드 필터/정렬에 실제 적용할 점수 맵.
     - 재정렬 완료(briefRerank.map 보유) → 의미 기반 fit 맵(앵커는 항상 포함).
     - 그 외(재정렬 전/진행 중/실패) → 토큰 기반 moodScoreMap.
     이로써 분석 직후엔 토큰 결과를 즉시 보여 주고, 재정렬이 끝나면 더 정확한
     의미 순위로 자연스럽게 교체된다. */
  const effectiveMoodMap = useMemo<Map<string, number> | null>(() => {
    if (briefRerank && !briefRerank.loading && briefRerank.map.size > 0) {
      const m = new Map(briefRerank.map);
      if (briefMatchOpen) {
        for (const id of briefAnchorIds) {
          if (!m.has(id)) m.set(id, Number.POSITIVE_INFINITY);
        }
      }
      return m;
    }
    return moodScoreMap;
  }, [briefRerank, moodScoreMap, briefMatchOpen, briefAnchorIds]);

  /* AI Search 칩 노출용 토큰 인벤토리.
     LLM 은 라이브러리 인벤토리를 모른 채 mood/keywords/lighting/... 등으로
     토큰을 자유롭게 emit 하기 때문에, "stylish" 처럼 추정은 합리적이지만
     실제 매치 가능한 자료가 0건인 토큰이 칩으로 노출돼 사용자가 결과 없는
     필터를 클릭하는 회귀가 있었다. 여기서 한 번 union Set 을 만들어
     MoodFilterChip 으로 prop drilling 하면 칩 렌더 단에서 0건 토큰을
     숨길 수 있다 — 점수/필터 계산엔 전혀 영향이 없다. items 변동 시에만
     재계산되도록 useMemo 로 캐싱. */
  const moodInventoryTokens = useMemo(
    () => buildReferenceTokenInventory(items),
    [items],
  );

  /* B2: 한글 추천용 영어 토큰 inventory. activeItems 가 아닌 items 전체에서
     수집한다 — 현재 필터/active 폴더가 좁아도 라이브러리 전체의 영어
     태그를 추천해야 사용자가 폴더 안에서 비어 보이는 결과를 만나도 다른
     곳에 있는 자료까지 자연스럽게 점프할 수 있다.
     - tags: 사용자 태그 + AI suggested_tags 합집합 (folder:/source: 제외).
     - moodLabels: AI mood_labels 만 모은 별도 카테고리. */
  const koreanInventory = useMemo<SuggestionInventory>(() => {
    const tagSet = new Set<string>();
    const moodSet = new Set<string>();
    for (const item of items) {
      for (const tag of item.tags) {
        if (!tag || tag.startsWith("folder:") || tag.startsWith("source:")) continue;
        /* 한글이 섞인 사용자 태그는 inventory 에서 제외 — 영어 추천이라는
           컨트랙트를 깨면 자기 자신을 추천하는 꼴이 되어 UX 가 어색해진다. */
        if (containsHangul(tag)) continue;
        tagSet.add(tag.toLowerCase());
      }
      const ai = item.ai_suggestions as Partial<ReferenceAiSuggestions> | null;
      for (const tag of ai?.suggested_tags ?? []) {
        if (!tag) continue;
        if (containsHangul(tag)) continue;
        tagSet.add(tag.toLowerCase());
      }
      for (const mood of ai?.mood_labels ?? []) {
        if (!mood) continue;
        if (containsHangul(mood)) continue;
        moodSet.add(mood.toLowerCase());
      }
    }
    return {
      tags: Array.from(tagSet).sort(),
      moodLabels: Array.from(moodSet).sort(),
    };
  }, [items]);
  const koreanInventoryHash = useMemo(
    () => hashKoreanInventory(koreanInventory),
    [koreanInventory],
  );
  /* 한국어 검색어 확장 오버라이드 — 음역(하프톤) 등 사용자/AI 확장 별칭.
     워크스페이스별 localStorage 에 저장되며, 설정의 "한국어 검색어 확장"
     또는 자동 확장 훅이 갱신할 때마다 CustomEvent 로 재읽어 인덱스 재빌드. */
  const [aliasOverrides, setAliasOverrides] = useState<Record<string, string[]>>(
    () => readKoreanAliasOverrides(),
  );
  useEffect(() => {
    const sync = () => setAliasOverrides(readKoreanAliasOverrides());
    const onStorage = (e: StorageEvent) => {
      if (e.key && e.key.startsWith(KOREAN_ALIAS_OVERRIDES_KEY)) sync();
    };
    window.addEventListener(KOREAN_ALIAS_OVERRIDES_CHANGED_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(KOREAN_ALIAS_OVERRIDES_CHANGED_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  /* 로컬 EN↔KO 별칭 인덱스 — 네 가지 소스를 같은 키 공간에 마운트.
     (1) 라이브러리 `ai.suggested_tags[i] ↔ suggested_tags_ko[i]` 평행 페어
     (2) 정적 시드 사전 (`KOREAN_TAG_SEED`, 영상/디자인 도메인 ~500 쌍) —
         라이브러리에 한 번도 분류된 적 없는 보편 명사("자동차" → `car`,
         "한복" → `hanbok` → `hanbok-portrait`) 도 잡힌다.
     (3) 한국어 검색어 확장 오버라이드(`aliasOverrides`) — 음역/동의어 보강.
     lookup 단계에서 라이브러리 인벤토리(`koreanInventory`) 와 intersect 되
     므로 클릭해도 결과가 없는 dead-end 후보는 자동으로 컷된다. 시드 EN
     이 인벤토리에 정확히 일치하지 않으면 단어 경계 기반 가족 매칭으로
     변형(`hanbok` → `hanbok-portrait`) 을 찾아 후보로 대체.
     filteredItems 보다 위에 정의되어, 사이드바 검색바의 자료 그리드 필터
     단계에서도 한글→영어 후보 확장을 그대로 사용한다. */
  const koreanAliasIndex = useMemo<KoreanTagAliasIndex>(
    () => {
      /* 카테고리별 인벤토리 가드를 *분리* 전달해, 같은 EN 토큰이 한쪽
         카테고리(예: tag) 에만 존재할 때 다른 카테고리(예: mood) 의 추천
         후보로 leak 되지 않게 한다. 과거에는 두 셋의 합집합을 단일
         inventoryFilter 로 넘겨, 시드의 `family: "mood" / en: "cute"` 가
         tag 인벤토리("cute" tag 존재) 때문에 통과 → 사용자가 추천 무드
         "cute" 클릭 → moodsFilter.include 에 "cute" 추가 → 그러나 mood 칩
         피커에서는 "cute" 라벨이 없는 상태가 되어 사라진 듯한 회귀가
         있었다. */
      const tagInventoryFilter = new Set<string>(koreanInventory.tags);
      const moodInventoryFilter = new Set<string>(koreanInventory.moodLabels);
      return buildKoreanTagAliasIndex(items, {
        /* 정적 시드 + 사용자/AI 확장 오버라이드를 같은 seedDictionary 로 합쳐
           전달. 오버라이드 항목은 tag/mood 버킷 양쪽에 등록되고 inventoryFilter
           가 알맞은 카테고리만 남긴다(koreanTagAliasOverridesToSeedEntries). */
        seedDictionary: [
          ...KOREAN_TAG_SEED,
          ...koreanAliasOverridesToSeedEntries(aliasOverrides),
        ],
        tagInventoryFilter,
        moodInventoryFilter,
        expandToInventoryFamily: true,
      });
    },
    [items, koreanInventory, aliasOverrides],
  );

  /* 새 자료 자동 확장(하이브리드) — "새 자료 자동 확장" 토글이 켜져 있을 때만.
     인벤토리에 새로 등장한 EN 태그/무드 중 *아직 확장 시도하지 않은* 것만
     골라 백그라운드로 한국어 검색 별칭(음역 포함) 을 생성한다. 이미 확장한
     토큰은 getExpandedEnSet 로 dedupe 되어 중복 LLM 호출이 없다. best-effort
     — 실패하면 조용히 넘어가고 다음 인벤토리 변화 때 재시도(실패 토큰은
     마킹되지 않음). 디바운스로 잦은 재빌드/import 직후 폭주를 방지. */
  const aliasAutoRunningRef = useRef(false);
  useEffect(() => {
    if (!readKoreanAliasAutoExpand()) return;
    const inventory = [...koreanInventory.tags, ...koreanInventory.moodLabels];
    if (inventory.length === 0) return;
    const timer = window.setTimeout(() => {
      void (async () => {
        if (aliasAutoRunningRef.current) return;
        const expanded = getExpandedEnSet();
        const fresh = inventory.filter((en) => !expanded.has(en));
        if (fresh.length === 0) return;
        aliasAutoRunningRef.current = true;
        try {
          const result = await expandEnTagsToKorean(fresh);
          if (Object.keys(result).length > 0) {
            setAliasOverrides(mergeKoreanAliasOverrides(result));
          }
        } catch {
          /* best-effort — 다음 기회에 재시도 */
        } finally {
          aliasAutoRunningRef.current = false;
        }
      })();
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [koreanInventory]);

  /** 필터 무관 살아있는 항목 id 집합. LibraryCanvas reconciliation 이
   *  *영구 삭제* (DB row 자체가 사라져 items 배열에서 빠진) 항목만 layout
   *  에서 정리한다. 단순한 *trash* (`deleted_at` 만 설정된 soft-delete) 도
   *  items 안에는 그대로 살아 있으므로 layout entry 가 보존되고, 사용자가
   *  toast 의 되돌리기 / Ctrl+Z 로 restore 했을 때 "원래 자리" 로 정확히
   *  복귀한다. 필터로 잠시 가려진 항목 (하위폴더 토글 OFF, 검색, type 필터
   *  등) 의 위치 / 노트 / 연결도 같은 이유로 보존.
   *
   *  ⚠️ 의미 변경 이력 (이전 이름: `allLiveItemIds`):
   *  과거엔 `deleted_at` 도 제외하던 정의여서 trash 직후 reconciliation 이
   *  layout entry 를 즉시 지웠고, 그 결과 restore 시 *새 위치* 로 자동 배치
   *  되는 회귀가 있었다. 이제는 "있다고 알려진(known) 모든 id" 로 의미를
   *  맞추고 LibraryCanvas 의 prune 기준으로 사용. */
  const allKnownItemIds = useMemo(() => {
    // 폴더 스코프 prune — 캔버스는 폴더 컨텍스트에서만 쓰이므로, 정리 기준을
    // *현재 폴더 소속 ref* (태그 기준, 하위폴더 포함) 로 좁힌다. 그래야:
    //   · 다른 폴더로 이동(태그 변경)한 ref 는 옛 폴더 layout 에서 정리됨(유령 제거)
    //   · 휴지통(deleted_at)이지만 여전히 이 폴더 태그인 항목 → 보존(복원 시 제자리)
    //   · 필터(검색/타입/하위폴더 토글)로 가려졌지만 태그는 그대로인 항목 → 보존
    // activeTag 가 폴더 태그가 아니면(캔버스 미사용 컨텍스트) 기존 전역 동작.
    if (activeTag && activeTag.startsWith("folder:")) {
      const prefix = `${activeTag}/`;
      const scoped = new Set<string>();
      for (const it of items) {
        if (it.tags.some((tg) => tg === activeTag || tg.startsWith(prefix))) {
          scoped.add(it.id);
        }
      }
      return scoped;
    }
    return new Set(items.map((it) => it.id));
  }, [items, activeTag]);

  /* content_hash → 활성(미삭제) 항목 수. "duplicates" quickFilter 와
   * 인스펙터의 "중복 후보" 뱃지가 공유하는 단일 출처.
   *
   * 과거에는 filteredItems 안에서 `items.filter(...).length` 를 매 항목마다
   * 돌려 O(n²) 였다(1만 항목이면 ~1억 비교 × 매 키 입력/리렌더). 이 맵을
   * 한 번 O(n) 으로 만들어 두고 `get(hash)` O(1) 조회로 대체한다. */
  const duplicateCounts = useMemo(() => {
    // 휴지통 항목은 카운트에서 제외 — merge/trash 직후에도 살아남은 카드가
    // 여전히 "Duplicate candidate" 로 잡히는 것을 방지.
    const counts = new Map<string, number>();
    for (const item of items) {
      if (!item.content_hash || item.deleted_at) continue;
      counts.set(item.content_hash, (counts.get(item.content_hash) ?? 0) + 1);
    }
    return counts;
  }, [items]);

  const filteredItems = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    const noteKeyword = noteFilterState.keyword.trim().toLowerCase();
    /* color 필터가 활성일 때 각 통과 항목의 *정렬 점수* (rankScore) 를 모아
       둔다. 정렬 단계에서 sortKey 와 무관하게 이 점수 오름차순으로 자동
       정렬한다. distance 와 rankScore 가 다른 이유:
        - distance: ΔE 최소값. 필터 통과 판정에만 사용 (작은 면적의
          정확한 매칭도 잡혀야 한다는 본래 정책 보존).
        - rankScore: 면적 큰 swatch 가 매칭됐을 때 보너스만큼 차감된 값.
          "썸네일의 지배색이 target 과 가까울수록 위로" 라는 직관을
          정렬에만 반영. 작은 면적 swatch 에는 페널티 없음.
       비활성이면 map 자체를 만들지 않아 비용 0. */
    const colorRankScores: Map<string, number> | null = colorFilter
      ? new Map<string, number>()
      : null;
    /* "최근 사용" 자동 만료 — last_used_at 이 최근 30일 이내인 자료만 노출.
       무기한 누적되면 목록이 의미 없이 비대해지므로 슬라이딩 윈도우로 정리. */
    const recentlyUsedCutoffMs = Date.now() - RECENTLY_USED_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const result = items.filter((item) => {
      if (quickFilter === "trash") {
        if (!item.deleted_at) return false;
      } else if (item.deleted_at) {
        return false;
      }
      // 그리드뷰 전용 숨김 — 캔버스 뷰에는 적용하지 않아 캔버스와 독립을 보장한다.
      // "숨긴 항목 표시"(showHidden) ON 이면 숨긴 항목도 노출(흐릿하게).
      if (viewMode !== "canvas" && !showHidden && gridHiddenIds.has(item.id)) return false;
      if (quickFilter === "favorites" && !item.is_favorite) return false;
      if (quickFilter === "untagged" && item.tags.length > 0) return false;
      if (quickFilter === "recentlyUsed") {
        if (!item.last_used_at) return false;
        const usedMs = new Date(item.last_used_at).getTime();
        if (!Number.isFinite(usedMs) || usedMs < recentlyUsedCutoffMs) return false;
      }
      if (quickFilter === "unclassified" && item.classification_status !== "unclassified") return false;
      if (quickFilter === "variations" && !item.variation_of) return false;
      if (quickFilter === "duplicates" && (!item.content_hash || (duplicateCounts.get(item.content_hash) ?? 0) < 2)) return false;

      // 사이드바 폴더 선택(단일/다중) — 다중이면 선택 폴더들의 합집합.
      // 툴바의 tagsFilter / foldersFilter 와 AND 결합으로 적용된다.
      if (selectedFolderTags.length > 0) {
        const only = selectedFolderTags.length === 1 ? selectedFolderTags[0] : null;
        if (only && only.startsWith("folder:") && recursiveActiveFolder) {
          // 단일 폴더 + recursive 토글: 하위 폴더 항목까지 포함.
          const matched = item.tags.some((tag) => tag === only || tag.startsWith(`${only}/`));
          if (!matched) return false;
        } else if (only && !only.startsWith("folder:")) {
          // 비폴더 태그가 단일로 들어온 경로 보존(정확 일치).
          if (!item.tags.includes(only)) return false;
        } else {
          // 다중(또는 recursive off 단일): 선택 폴더에 직접 소속된 항목의 합집합.
          if (!selectedFolderTags.some((tag) => item.tags.includes(tag))) return false;
        }
      }
      if (activeSavedFilter && !matchesSavedFilter(item, activeSavedFilter)) return false;

      // 툴바 필터: Types / Tags / Folders / Ratings / Shapes / Note.
      // 계층형 Types 필터(카테고리/포맷/플랫폼/기타) — typeFilter.ts 가 자료의
      // 카테고리·리프 id 를 계산해 include/exclude 를 적용한다.
      if (!matchTypeFilter(item, typeFilter.include, typeFilter.exclude)) return false;
      // tags 와 folder-tags 를 분리해 둘 필터에 각각 던진다. 같은 item.tags
      // 배열에 두 종류가 섞여 있지만 의미상 다른 차원이므로, Tags 칩에는
      // 일반 태그만, Folder 칩에는 `folder:` 접두 태그만 보낸다.
      const regularTags = item.tags.filter((tag) => !tag.startsWith("folder:"));
      const folderTagsOfItem = item.tags.filter((tag) => tag.startsWith("folder:"));
      /* AI 제안 태그까지 매칭 후보에 합류 — Tags 칩이 AI 만 알고 있는
         미수락 토큰까지 row 로 노출하므로, 매칭 단계도 그 토큰을 인식해야
         한다. AI 토큰은 lowercase canonical (referenceAi.ts safeJson) 이고
         picker 의 row.id 도 lowercase 로 통일되어 있어 case fold 없이 그대로
         합류 가능. tagsFilter 에 사용자 머지 case ("Neon") 가 들어 있는
         경우는 regularTags 가 그대로 case 보존이라 기존 매칭 경로로 잡힌다.
         exclude 동작도 자연스럽게 확장된다 — "neon" 을 빼면 ai-only 자료도
         탈락(원하는 동작). */
      const aiTagsForMatch: string[] = [];
      const aiAtItem = item.ai_suggestions as Partial<ReferenceAiSuggestions> | null;
      if (Array.isArray(aiAtItem?.suggested_tags)) {
        for (const rawTag of aiAtItem.suggested_tags) {
          if (typeof rawTag !== "string") continue;
          const trimmed = rawTag.trim();
          if (!trimmed) continue;
          aiTagsForMatch.push(trimmed.toLowerCase());
        }
      }
      const tagsHaystack = aiTagsForMatch.length > 0
        ? [...regularTags, ...aiTagsForMatch]
        : regularTags;
      if (!matchMultiAny(tagsHaystack, tagsFilter)) return false;
      if (!matchMultiAny(folderTagsOfItem, foldersFilter)) return false;

      /* Moods 칩 — ai.mood_labels (lowercase EN canonical) 와 picker filter set
         (lowercase EN) 을 직접 매칭. exclude 가 있으면 mood_labels 가 아예
         없는 자료는 통과(include 가 비어 있을 때) — Tags 와 동일한 의미의
         multi 필터. mood_labels 가 없는 자료(분류 미실행/실패) 는 include 시
         자동 탈락. */
      if (multiFilterActive(moodsFilter)) {
        const moodsForMatch: string[] = [];
        if (Array.isArray(aiAtItem?.mood_labels)) {
          for (const raw of aiAtItem.mood_labels) {
            if (typeof raw !== "string") continue;
            const trimmed = raw.trim();
            if (!trimmed) continue;
            moodsForMatch.push(trimmed.toLowerCase());
          }
        }
        if (!matchMultiAny(moodsForMatch, moodsFilter)) return false;
      }

      if (ratingsFilter.size > 0) {
        const r = item.rating ?? 0;
        const bucket: RatingValue = r >= 1 && r <= 5 ? (r as RatingValue) : "none";
        if (!ratingsFilter.has(bucket)) return false;
      }

      if (shapesFilter.size > 0) {
        // 한 항목이 여러 버킷에 동시에 들어갈 수 있으므로 some() 으로 OR
        // 매칭. 측정 안 된 항목은 ["custom"] 만 돌려주므로 4:3/16:9 등
        // 좁은 필터에 잘못 잡히지 않는다(이전 버킷 폴백 버그의 핵심).
        const buckets = aspectBuckets(item);
        if (!buckets.some((b) => shapesFilter.has(b))) return false;
      }

      // Note: 모드 + 키워드는 AND 결합. 키워드가 있으면 자동으로 "노트가
      // 존재하면서 키워드 포함" 을 요구한다(직관적인 expected behavior).
      // *모든 종류* 의 노트 본문(자료 메모 + 영역/타임스탬프/프레임 노트)
      // 을 한 문자열로 합쳐 매칭한다. 사용자가 영상 안에 적은 타임스탬프
      // 노트, GIF 의 프레임 노트, 이미지 위 영역 노트도 "있음/없음" 판정
      // 과 키워드 검색에 모두 잡힌다.
      if (noteFilterState.mode !== "all" || noteKeyword) {
        const noteHaystack = gatherNoteText(item);
        const hasAnyNote = noteHaystack.trim().length > 0;
        if (noteFilterState.mode === "with" && !hasAnyNote) return false;
        if (noteFilterState.mode === "without" && hasAnyNote) return false;
        if (noteKeyword && !noteHaystack.includes(noteKeyword)) return false;
      }

      /* Color 필터 — 자료의 color_palette (8개 dominant 색) 중 선택된 hex 와
         가장 가까운 swatch 의 ΔE 가 임계값 이하면 통과. palette 가 비어 있는
         항목(backfill 대기 중) 은 자연스럽게 탈락 — 백그라운드에서 채워지면
         다시 등장한다. 통과한 항목의 정렬 점수는 colorRankScores 에 기록해
         사용 (면적 보너스 반영).
         ⚠️ doc 자료(PDF/문서/오디오 등) 는 color 필터에서 *항상 제외*. 문서
         썸네일은 흰 배경 + 텍스트 색이라 우연히 매칭되는 false-positive 가
         많고, 사용자가 "색으로 찾기" 직관과도 어긋남(문서를 색으로 분류하는
         경우 없음). */
      if (colorFilter && colorRankScores) {
        if (item.kind === "doc") return false;
        const score = scoreItemByColor(item.color_palette, colorFilter);
        // 필터 통과 판정은 *unweighted* distance — 작은 면적의 정확한
        // 매칭이 보너스 없이도 통과되어 본래 시맨틱이 유지된다.
        if (!score || score.distance > COLOR_FILTER_THRESHOLD) return false;
        // 정렬에는 면적 보너스 반영된 rankScore 사용 — 같은 거리대 안에서
        // 지배색이 더 일치하는 자료가 위로 올라온다.
        colorRankScores.set(item.id, score.rankScore);
      }

      /* Mood AI 필터(C) — score >= minScore 인 자료만 통과. scoreReferences
         가 이미 minScore 컷을 통과한 항목만 map 에 넣어 두므로 단순 has()
         체크로 충분. 다른 필터(Types/Tags/Folders/Color/Quick) 와는 AND. */
      if (effectiveMoodMap && !effectiveMoodMap.has(item.id)) return false;

      if (!q) return true;
      /* 검색 haystack 에 AI 분류 메타 + 한국어 parallel(_ko) 까지 모두 합류
         → 어떤 언어로 분석됐든 한/영 어느 쪽 키워드로도 매칭. ai_suggestions
         가 두 언어 모두 저장하는 구조이기 때문에 가능한 양방향 검색. AI 가
         비활성/실패한 자료는 ai 가 null 이라 영향이 없다. */
      const ai = item.ai_suggestions as Partial<ReferenceAiSuggestions> | null;
      /* doc 자료 — mime/확장자/sub-type 라벨도 검색 대상에 합류. 예: 사용자가
         "pdf" 또는 "ppt" 만 쳐도 해당 자료들이 그리드에 모이도록. ai 분류가
         없는 자료(대부분의 doc) 도 의미있는 결과를 보여 주는 데 결정적. */
      const docTokens: string[] = [];
      if (item.kind === "doc") {
        const sub = detectDocSubtype(item.mime_type ?? "", item.title ?? "");
        docTokens.push(sub);
        const ext = (item.title ?? "").match(/\.([a-z0-9]+)$/i)?.[1];
        if (ext) docTokens.push(ext.toLowerCase());
      }
      const haystack = [
        item.title,
        item.notes,
        /* 영역/타임스탬프/프레임 노트 본문도 검색 대상에 합류 — 사용자가
           영상의 특정 시점에 남긴 메모, GIF 의 프레임 메모, 이미지 영역
           메모를 모두 같은 검색창에서 찾을 수 있도록. notes 와 별도
           라인으로 두는 이유는 .filter(Boolean) 의 문자열 빈값 제거가
           item.notes(string|null) 와 gatherNoteText(string) 양쪽을 모두
           안전하게 통과시키기 때문. */
        gatherNoteText(item),
        item.source_url,
        item.mime_type,
        ...docTokens,
        ...item.tags,
        ...(ai?.suggested_tags ?? []),
        ...(ai?.suggested_tags_ko ?? []),
        ...(ai?.mood_labels ?? []),
        ...(ai?.mood_labels_ko ?? []),
        ...(ai?.use_cases ?? []),
        ...(ai?.use_cases_ko ?? []),
        /* scene_description 은 *객관적 명사 묘사* 라 사용자가 검색창에 "헬멧",
           "공장", "EV4" 같은 구체적 키워드를 쳤을 때 직접 잡히는 1차 신호원.
           visual_style 은 해석/평가형 텍스트라 명사 검색에 약하다. */
        ai?.scene_description,
        ai?.scene_description_ko,
        ai?.visual_style,
        ai?.visual_style_ko,
        ai?.motion_notes,
        ai?.motion_notes_ko,
        ai?.shot_type,
        ai?.shot_type_ko,
        ai?.color_notes,
        ai?.color_notes_ko,
        ai?.brief_fit,
        ai?.brief_fit_ko,
        ai?.content_type,
        ai?.content_type_ko,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (haystack.includes(q)) return true;
      /* 한글 쿼리 별칭 폴백 — KoreanSuggestRow 칩(B2) 가 별도로 띄우는
         "이 한글이 어떤 영어 태그와 연결돼" 를 자료 그리드 필터 단계에도
         그대로 적용. 사용자가 "한복" 만 쳐도 `hanbok-portrait` 태그 자료가
         그리드에 즉시 노출되어 dead-end UX(빈 그리드 → 칩 클릭 필요) 가
         사라진다. lookupTags / lookupMoods 는 inventoryFilter + family
         확장을 거쳐 라이브러리에 실제 존재하는 EN 토큰만 돌려준다. */
      if (containsHangul(q) && koreanAliasIndex.hasData) {
        for (const m of koreanAliasIndex.lookupTags(q)) {
          if (haystack.includes(m.tag)) return true;
        }
        for (const m of koreanAliasIndex.lookupMoods(q)) {
          if (haystack.includes(m.tag)) return true;
        }
      }
      return false;
    });
    /* "방금 업로드" 우선순위 — 핀 다음, 다른 모든 정렬 규칙 앞.
       두 항목 모두 freshness 기록이 없으면 0 을 반환해 자연스럽게 다음 비교
       단계로 fall through 한다. timestamp 가 큰 쪽(=더 최근 업로드)이 위로. */
    const freshCmp = (a: ReferenceItem, b: ReferenceItem): number => {
      const fa = freshlyUploadedAt[a.id] ?? 0;
      const fb = freshlyUploadedAt[b.id] ?? 0;
      if (fa === fb) return 0;
      return fb - fa;
    };

    /* Color 필터 활성 시 sortKey 무시 — Eagle 패리티. rankScore 오름차순
       정렬: 같은 hue 안에서도 면적이 큰 매칭(=썸네일 지배색이 target 과
       유사) 이 위로 온다. 작은 면적 매칭은 통과는 되지만 더 뒤로 밀림 —
       페널티가 아니라 보너스를 못 받는 효과(monotone). 핀 고정은 다른
       정렬에서와 동일하게 항상 위로 유지(컬러 매칭과 직교하는 강한 신호). */
    if (colorFilter && colorRankScores) {
      const cmp = (a: ReferenceItem, b: ReferenceItem): number => {
        const pinA = a.pinned_at ? 1 : 0;
        const pinB = b.pinned_at ? 1 : 0;
        if (pinA !== pinB) return pinB - pinA;
        const fc = freshCmp(a, b);
        if (fc !== 0) return fc;
        const sa = colorRankScores.get(a.id) ?? Number.POSITIVE_INFINITY;
        const sb = colorRankScores.get(b.id) ?? Number.POSITIVE_INFINITY;
        return sa - sb;
      };
      return [...result].sort(cmp);
    }

    /* Mood 필터 활성 시 sortKey 무시 — score 내림차순으로 가장 관련성 높은
       자료가 위로. Color 와 동일한 정책. 핀 / 방금 업로드는 그래도 앞쪽에
       유지(사용자 의도가 직교하는 강한 신호). */
    if (effectiveMoodMap) {
      const cmp = (a: ReferenceItem, b: ReferenceItem): number => {
        const pinA = a.pinned_at ? 1 : 0;
        const pinB = b.pinned_at ? 1 : 0;
        if (pinA !== pinB) return pinB - pinA;
        const fc = freshCmp(a, b);
        if (fc !== 0) return fc;
        const sa = effectiveMoodMap.get(a.id) ?? 0;
        const sb = effectiveMoodMap.get(b.id) ?? 0;
        return sb - sa;
      };
      return [...result].sort(cmp);
    }
    if (quickFilter === "recentlyUsed") {
      /* recentlyUsed 는 last_used_at 기반인데, 방금 업로드된 항목은 아직
         used 되지 않았어도 사용자 시야에 있어야 자연스럽다(방금 등록한 직후
         "어 이거 어디 갔지?" 가 안 생기게). freshness 우선 비교를 같이 둠. */
      return [...result].sort((a, b) => {
        const fc = freshCmp(a, b);
        if (fc !== 0) return fc;
        return new Date(b.last_used_at ?? 0).getTime() - new Date(a.last_used_at ?? 0).getTime();
      });
    }
    // 사용자가 선택한 정렬 키를 적용. 핀고정은 어떤 키를 골라도 항상 위로
    // 끌어올린다 — 핀은 "이 항목을 절대 시야에서 놓치지 마" 의도라서 정렬과
    // 직교하는 강한 신호.
    if (sortKey === "manual") {
      // 컨텍스트별 순서를 한 번만 lookup. 새로 추가된 항목(인덱스 없음)은
      // MAX_SAFE_INTEGER 로 빠져 자연스럽게 끝쪽에 모이고, 두 항목이 모두
      // 등록 안 된 상태면 created_at desc 로 안정 정렬해 "새로 들어온 것
      // 부터 위" 라는 가벼운 규칙을 유지한다. 다만 manual 모드에서 "끝쪽에
      // 모임" 이 새 업로드의 가시성을 떨어뜨리는 문제가 있어, freshness 가
      // 있는 항목은 manual 인덱스 비교보다 먼저 처리해 핀 바로 아래로
      // 끌어올린다(세션 한정).
      const contextKey = deriveLibraryContextKey(activeTag, quickFilter);
      const idxMap = manualOrderIndex(getManualOrder(contextKey));
      const cmp = (a: ReferenceItem, b: ReferenceItem): number => {
        const pinA = a.pinned_at ? 1 : 0;
        const pinB = b.pinned_at ? 1 : 0;
        if (pinA !== pinB) return pinB - pinA;
        const fc = freshCmp(a, b);
        if (fc !== 0) return fc;
        const ai = idxMap.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const bi = idxMap.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        if (ai !== bi) return ai - bi;
        const ta = new Date(a.created_at ?? 0).getTime();
        const tb = new Date(b.created_at ?? 0).getTime();
        return tb - ta;
      };
      return [...result].sort(cmp);
    }
    const orderMul = sortOrder === "asc" ? 1 : -1;
    const cmp = (a: ReferenceItem, b: ReferenceItem): number => {
      const pinA = a.pinned_at ? 1 : 0;
      const pinB = b.pinned_at ? 1 : 0;
      if (pinA !== pinB) return pinB - pinA;
      const fc = freshCmp(a, b);
      if (fc !== 0) return fc;
      switch (sortKey) {
        case "name": {
          return a.title.localeCompare(b.title) * orderMul;
        }
        case "rating": {
          return ((a.rating ?? 0) - (b.rating ?? 0)) * orderMul;
        }
        case "size": {
          return ((a.file_size ?? 0) - (b.file_size ?? 0)) * orderMul;
        }
        case "dimensions": {
          // 총 픽셀 수(width * height) 기준 — width 든 height 든 한쪽이
          // 비어 있으면 0 으로 떨어져 desc 정렬 시 최하단으로. 같은 픽셀
          // 수면 title 로 안정 정렬해 매번 같은 결과가 나오게 한다.
          const pa = (a.width ?? 0) * (a.height ?? 0);
          const pb = (b.width ?? 0) * (b.height ?? 0);
          if (pa !== pb) return (pa - pb) * orderMul;
          return a.title.localeCompare(b.title);
        }
        case "extension": {
          // MIME subtype / 파일 확장자 / platform 라벨 순으로 폴백되는
          // 같은 헬퍼를 그리드 카드와 공유해, 컬럼에 보이는 값과 정렬
          // 결과가 일치한다. extensionFromItem 의 반환이 "webp" (lowercase
          // 파일 확장자) 와 "YouTube" (TitleCase platform) 가 섞이므로
          // case-insensitive 로 비교해야 자연스러운 알파벳 순서가 나온다.
          // 같은 확장자 안에서는 title 로 2차 정렬.
          const ea = extensionFromItem(a).toLowerCase();
          const eb = extensionFromItem(b).toLowerCase();
          const cmp = ea.localeCompare(eb);
          if (cmp !== 0) return cmp * orderMul;
          return a.title.localeCompare(b.title);
        }
        case "lastUsed": {
          const ta = new Date(a.last_used_at ?? 0).getTime();
          const tb = new Date(b.last_used_at ?? 0).getTime();
          return (ta - tb) * orderMul;
        }
        case "recent":
        default: {
          const ta = new Date(a.created_at ?? 0).getTime();
          const tb = new Date(b.created_at ?? 0).getTime();
          return (ta - tb) * orderMul;
        }
      }
    };
    return [...result].sort(cmp);
    // manualOrderVersion 은 다른 윈도우에서 순서가 바뀌었을 때 useMemo 를
    // 재실행시키기 위한 참조용 — 본문 안에서 직접 쓰지 않아도 deps 에 둔다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeSavedFilter,
    activeTag,
    selectedFolderTags,
    colorFilter,
    duplicateCounts,
    foldersFilter,
    freshlyUploadedAt,
    gridHiddenIds,
    items,
    koreanAliasIndex,
    manualOrderVersion,
    effectiveMoodMap,
    moodsFilter,
    noteFilterState,
    deferredQuery,
    quickFilter,
    ratingsFilter,
    recursiveActiveFolder,
    shapesFilter,
    showHidden,
    sortKey,
    sortOrder,
    tagsFilter,
    typeFilter,
    viewMode,
  ]);

  const selectedFromAll = selectedId ? items.find((item) => item.id === selectedId) ?? null : null;
  const selected = selectedId ? filteredItems.find((item) => item.id === selectedId) ?? null : null;
  const selectedItems = useMemo(
    () => filteredItems.filter((item) => selectedIds.has(item.id)),
    [filteredItems, selectedIds],
  );
  // 현재 라이브러리에 살아있는(미삭제) 항목 중 그리드 숨김된 개수 — 툴바 토글 배지.
  const gridHiddenCount = useMemo(
    () => items.reduce((n, it) => (!it.deleted_at && gridHiddenIds.has(it.id) ? n + 1 : n), 0),
    [items, gridHiddenIds],
  );
  /* 그리드 숨김 토글 — 키보드(H) 등 *현재 선택* 으로 직접 진입하는 경로.
     우클릭(snapshot) 경로의 mutateGridHidden 과 달리 selectedItems/selected
     를 그대로 본다. 선택 중 하나라도 보이면 전부 숨기고, 모두 숨겨져 있으면
     전부 해제 — 캔버스 H 토글과 동일 정책. 휴지통 항목은 제외. */
  const toggleGridHiddenForSelection = useCallback(() => {
    const targets = (selectedItems.length > 0 ? selectedItems : selected ? [selected] : [])
      .filter((it) => !it.deleted_at);
    if (targets.length === 0) return;
    const anyVisible = targets.some((it) => !gridHiddenIds.has(it.id));
    setGridHiddenIds((prev) => {
      const next = new Set(prev);
      for (const it of targets) {
        if (anyVisible) next.add(it.id);
        else next.delete(it.id);
      }
      saveGridHidden(next);
      return next;
    });
  }, [selectedItems, selected, gridHiddenIds]);
  const selectedHiddenByFilters = Boolean(selectedFromAll && !selected);
  const selectedSuggestions = selected?.ai_suggestions as Partial<ReferenceAiSuggestions> | undefined;
  /* Phase E — 인스펙터는 지금 선택된 자료의 분류 진행만 본다. 다른 자료가
     백그라운드에서 동시에 처리되더라도 UI 는 currently-selected 의 stage/
     progress 만 노출 (선택 전환 시 즉시 그 자료의 상태로 갱신). aiBusy 는
     classify in-flight + accept in-flight 의 OR — 두 액션은 같은 자료의 DB
     row 를 건드리므로 동시에 트리거되지 않게 막아야 한다. */
  const selectedItemProgressEntry = selected ? itemClassifyProgress.get(selected.id) : undefined;
  const selectedClassifying = Boolean(selected) && (selectedItemProgressEntry !== undefined || isItemEnqueued(selected!.id));
  const selectedAiBusy = selectedClassifying || acceptingSuggestions;
  const selectedClassifyStage: ClassifyStage = selectedItemProgressEntry?.stage ?? "idle";
  const selectedClassifyProgress: ClassifyProgress | null = selectedItemProgressEntry?.progress ?? null;
  /* 빈 선택 시 우측 인스펙터의 "Library Overview" 패널이 쓰는 합계.
     filteredItems 가 이미 quickFilter / 폴더 / Types / 검색 등 모든 필터
     적용 후의 결과라, 사용자가 보고 있는 그리드와 1:1 로 일치한다.
     reduce 한 번이면 충분 — useMemo 로 묶을 만큼 비싸지 않지만
     filteredItems 자체가 1만 항목 cascade 의 출구라 동일 의존성 안에
     같이 두는 게 자연스럽다. */
  const scopeTotalSize = useMemo(
    () => filteredItems.reduce((sum, item) => sum + (item.file_size ?? 0), 0),
    [filteredItems],
  );
  const selectedDuplicateCount = selected?.content_hash ? duplicateCounts.get(selected.content_hash) ?? 0 : 0;
  /** 선택된 자료의 사용 위치 (Brief + Conti) — `usageLocations` (LS
   *  스캔 결과) 의 raw 행을 사용자에게 보여줄 *프로젝트 제목*과 함께
   *  묶어 인스펙터로 넘긴다. 제목은 `recentProjectsCache` (워크스페이스
   *  무관 LS) 에서 조회. 캐시에 없는 projectId 는 fallback 으로 짧은 id
   *  일부를 표시 — Phase 2 에서 cross-workspace project lookup 보강 시
   *  자연 해결.
   *
   *  각 location 의 `target` 필드를 그대로 통과시켜 Inspector 의 라벨
   *  분기 (· 브리프 · / · 콘티 ·) 가 가능하게 한다. */
  const selectedUsageLocations = useMemo(() => {
    if (!selected) return [];
    const raw = usageLocations[selected.id];
    if (!raw || raw.length === 0) return [];
    // recentProjectsCache 는 cheap LS read 라 매번 호출해도 무방, 단 같은
    // 렌더 안에서 두 번 읽지는 않도록 Map 으로 한 번만 변환.
    const titleByProjectId = new Map<string, { title: string; workspaceId: string }>();
    for (const rp of getRecentProjects(200)) {
      // 동일 projectId 가 두 워크스페이스에 있는 케이스는 거의 없지만,
      // 있더라도 가장 최근 (lastSeenAt 내림차순 첫 항목) 을 우선.
      if (!titleByProjectId.has(rp.projectId)) {
        titleByProjectId.set(rp.projectId, { title: rp.title, workspaceId: rp.workspaceId });
      }
    }
    return raw.map((loc) => {
      const meta = titleByProjectId.get(loc.projectId);
      return {
        projectId: loc.projectId,
        title: meta?.title,
        workspaceId: meta?.workspaceId,
        count: loc.count,
        target: loc.target,
        assetTypes: loc.assetTypes,
      };
    });
  }, [selected, usageLocations]);
  /** 인스펙터 "N개 생성됨" 카운트 — DB 의 promoted_asset_ids(cross-workspace 라
   *  에셋 삭제 시 갱신 불가)가 아니라, 삭제 시 정리되는 LS 추적을 단일 진실원으로
   *  쓴다. usageLocations 가 바뀔 때(로드/refresh) 같이 재계산. */
  const selectedPromotedAssetCount = useMemo(
    () => (selected ? countPromotedAssetsForRef(selected.id) : 0),
    [selected, usageLocations],
  );
  const selectedRegularTags = selected?.tags.filter((tag) => !tag.startsWith("folder:")) ?? [];
  const selectedItemFolderTags = selected?.tags.filter((tag) => tag.startsWith("folder:")) ?? [];
  const activeItems = useMemo(() => items.filter((item) => !item.deleted_at), [items]);
  /* 계층형 Types 필터의 카운트 — 카테고리 id(image/video/doc/url) 와 리프 id
     (image/png, url/youtube, video/etc …) 별 항목 수. TypesHierarchyPicker 가
     ReadonlyMap 으로 받아 각 행 우측에 표시한다. activeItems 기준(사이드바/
     quickFilter 적용 후 현 컨텍스트). */
  const typeCounts = useMemo(() => computeTypeCounts(activeItems), [activeItems]);
  const folders = useMemo(() => folderRows(activeItems, userFolderPaths), [activeItems, userFolderPaths]);
  /* 브리프 매치 폴더는 일반 '폴더' 트리에서 분리해 전용 섹션에만 노출한다.
     일반 폴더와 동일하게 FolderRow 로 렌더하므로 LibraryFolderRow 그대로 전달. */
  const briefMatchFolders = useMemo(
    () => folders.filter((row) => normalizeFolderPath(row.id).startsWith(`${BRIEF_MATCH_ROOT}/`)),
    [folders],
  );
  /* 스마트 브리프 매치 폴더는 기본 빨간색. 색을 명시 지정한 적 없는 폴더
     (예전에 만든 것 포함)는 한 번 red 로 백필해 영구화한다 — 렌더 시 fallback
     에만 의존하지 않도록. */
  useEffect(() => {
    for (const row of briefMatchFolders) {
      const p = normalizeFolderPath(row.id);
      if (!getFolderMeta(p).color) setFolderMeta(p, { color: "red" });
    }
  }, [briefMatchFolders]);
  const regularFolders = useMemo(
    () => folders.filter((row) => !isBriefMatchPath(normalizeFolderPath(row.id))),
    [folders],
  );
  /* 로켓 버튼 → 내보내기 다이얼로그 오픈. 직접 생성 대신 대상 워크스페이스/폴더/
     제목/화면비율/레퍼런스 선택을 받고, 확인 시 handleConfirmBriefMatchExport 로 넘긴다. */
  const handleCreateProjectFromBriefMatch = useCallback(
    (path: string) => {
      const tag = folderTag(path);
      // 휴지통(deleted_at)에 있는 자료는 제외 — 폴더 태그는 남아 있어도 활성 자료가
      // 아니며, 크로스-워크스페이스 해석 시 deleted_at IS NULL 로 걸러져 등록도 안 된다.
      const members = items.filter(
        (it) => !it.deleted_at && it.tags.some((tg) => tg === tag || tg.startsWith(`${tag}/`)),
      );
      const leaf = normalizeFolderPath(path).split("/").pop() ?? "Brief Match";
      setBriefMatchExport({ path, members, defaultTitle: leaf });
    },
    [items],
  );

  /* 인스펙터(빈 선택)에서 보여줄 "현재 브리프 매치 폴더의 브리프 내용".
     활성(앵커) 폴더가 브리프 매치 경로일 때만 채워지고, 그 외엔 null 이라
     일반 폴더에서는 브리프 섹션이 노출되지 않는다. */
  const briefMatchFolderPath = useMemo<string | null>(() => {
    if (!activeTag || !activeTag.startsWith("folder:")) return null;
    const path = activeTag.replace(/^folder:/, "");
    return isBriefMatchPath(path) ? path : null;
  }, [activeTag]);
  /* briefMatchStore 는 localStorage 라 React 가 변경을 모른다 — 전용 이벤트로
     tick 을 bump 해 엔트리를 다시 읽는다(다른 윈도우의 storage 이벤트 포함). */
  const [briefStoreVersion, setBriefStoreVersion] = useState(0);
  useEffect(() => {
    const bump = () => setBriefStoreVersion((v) => v + 1);
    const onStorage = (event: StorageEvent) => {
      if (event.key && event.key.includes("briefMatchStore")) bump();
    };
    window.addEventListener(BRIEF_MATCH_STORE_CHANGED_EVENT, bump);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(BRIEF_MATCH_STORE_CHANGED_EVENT, bump);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  const briefMatchEntry = useMemo<BriefMatchEntry | null>(() => {
    if (!briefMatchFolderPath) return null;
    return getBriefMatchEntry(briefMatchFolderPath);
    // briefStoreVersion 은 의도적 의존 — store 변경 시 재조회.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [briefMatchFolderPath, briefStoreVersion]);
  /* 첨부 이미지는 IndexedDB(briefMatchImageStore)에 있어 비동기 로드한다.
     폴더/스토어 변경 시 다시 읽고, 언마운트/경로 변경 race 는 cancelled 플래그로 차단. */
  const [briefMatchImages, setBriefMatchImagesState] = useState<BriefImage[]>([]);
  useEffect(() => {
    if (!briefMatchFolderPath) {
      setBriefMatchImagesState([]);
      return;
    }
    let cancelled = false;
    getBriefMatchImages(briefMatchFolderPath)
      .then((imgs) => {
        if (!cancelled) setBriefMatchImagesState(imgs);
      })
      .catch(() => {
        if (!cancelled) setBriefMatchImagesState([]);
      });
    return () => {
      cancelled = true;
    };
  }, [briefMatchFolderPath, briefStoreVersion]);

  /* 다이얼로그 확인 → (reload 전, 라이브러리 활성 상태에서) 선택 레퍼런스를 사전 분석한
     뒤 pending 으로 stash 하고 대상 워크스페이스로 전환(reload)한다. 대상이 현재 활성
     워크스페이스면 전환 없이 즉시 생성/이동한다(프로젝트 WS 에서 /library 를 보는 경우). */
  const handleConfirmBriefMatchExport = useCallback(
    async (result: BriefMatchExportResult) => {
      const ctx = briefMatchExport;
      if (!ctx) return;
      const libraryWsId = getCachedActiveId() ?? "";
      const entry = getBriefMatchEntry(ctx.path);
      // 이미지는 IndexedDB 에서 로드(레거시 localStorage 이미지도 자동 마이그레이션/폴백).
      const briefImages = await getBriefMatchImages(ctx.path);

      // 분석은 다이얼로그에서 블로킹하지 않는다 — 생성 후 BriefTab 진입 시 그쪽
      // 로딩바로 자동 실행(autoAnalyze)된다. 여기서는 콘텐츠/레퍼런스만 stash.
      const payload = {
        targetWsId: result.targetWsId,
        libraryWsId,
        title: result.title,
        folderId: result.folderId,
        videoFormat: result.videoFormat,
        deadline: result.deadline,
        client: result.client,
        openInBrief: result.openInBrief,
        refIds: result.selectedRefIds,
        briefText: entry?.briefText ?? "",
        ideaNote: entry?.ideaNote,
        briefImages,
        pdfText: entry?.pdfText,
        autoAnalyze: true,
        lang: uiLanguage,
      };

      // 대상이 이미 활성 워크스페이스면 전환 없이 즉시 생성.
      if (result.targetWsId === libraryWsId) {
        const projectId = await createProjectFromPending(payload);
        setBriefMatchExport(null);
        if (result.openInBrief) {
          try {
            sessionStorage.setItem("preflow.return.sourceTab", "brief");
          } catch {
            /* private mode */
          }
          navigate(
            `/project/${encodeURIComponent(projectId)}?tab=brief&ws=${encodeURIComponent(result.targetWsId)}`,
          );
        }
        return;
      }

      setPendingBriefMatchProject(payload);
      await activateWorkspace(result.targetWsId, false, "/#/dashboard");
      // activateWorkspace 성공 시 reload — 이 줄 이후는 실행되지 않는다.
    },
    [briefMatchExport, navigate, uiLanguage],
  );
  /* Tags 칩의 옵션 행 — 사용자 머지 태그(`item.tags`) + AI 제안 미수락 태그
     (`ai.suggested_tags` 중 어디에도 머지된 적 없는 토큰) 를 한 공간에 합쳐
     노출한다. Accept 강제 없이도 AI 어휘로 즉시 검색이 가능해진다.
     row.source === "ai" 인 항목은 toolbar 칩에서 sparkle 마커로 구분된다. */
  const tagsList = useMemo(
    () => tagCountsWithAi(activeItems, (tag) => !tag.startsWith("folder:") && !tag.startsWith("source:")),
    [activeItems],
  );
  /* Moods 칩 — `ai.mood_labels`(EN canonical) 의 빈도 카운트 + (선택적)
     평행 KO 라벨 표시. activeItems 기반이라 사이드바·quickFilter 적용 후의
     현재 컨텍스트 빈도가 반영된다. */
  const moodsList = useMemo(
    () => moodCountsList(activeItems, effectiveAiTagLanguage),
    [activeItems, effectiveAiTagLanguage],
  );
  /* B2: 한글 쿼리 → 영어 태그 추천. 두 단계로 동작.
     1) 로컬 별칭 인덱스 즉시 응답 — `ai.suggested_tags ↔ suggested_tags_ko`
        평행 배열을 집약한 인메모리 인덱스로 0ms 에 후보 칩을 그린다.
        라이브러리에 같은 개념이 이미 분류돼 있는 경우 LLM 호출 전 사용자가
        바로 클릭할 수 있어 체감 지연이 사라진다.
     2) 400ms 디바운스 후 LLM 호출 — 로컬 후보가 충분(>=3)하면 스킵하여
        토큰 비용을 아낀다. 응답이 오면 로컬 + LLM 결과를 dedupe merge
        (로컬 우선) 해 같은 상태에 그대로 반영.
     - 한글이 없으면 즉시 null 로 리셋 (영어 모드).
     - dismissed 쿼리는 호출 자체를 스킵.
     - 같은 쿼리 + 같은 inventory hash 는 lib 의 LRU 가 cache hit 으로
       0ms 에 돌려준다. */
  useEffect(() => {
    const q = query.trim();
    if (!q || !containsHangul(q)) {
      setKoreanSuggestion(null);
      setKoreanSuggestLoading(false);
      return;
    }
    if (dismissedKoreanQueries.has(q)) {
      setKoreanSuggestion(null);
      setKoreanSuggestLoading(false);
      return;
    }

    /* 1) 로컬 즉시 응답 — 인덱스가 비어 있어도 안전하게 빈 배열을 돌려준다.
       쿼리가 바뀔 때마다 *항상* setKoreanSuggestion 으로 덮어써, 이전 쿼리의
       칩이 새 쿼리에 잠깐 잔존하는 stale UX 를 차단한다 (KoreanSuggestRow 는
       빈 결과 + loading=false 일 때 자동 숨김). */
    const localTags = koreanAliasIndex.lookupTags(q).map((m) => m.tag).slice(0, 5);
    const localMoods = koreanAliasIndex.lookupMoods(q).map((m) => m.tag).slice(0, 3);
    setKoreanSuggestion({
      rawQuery: q,
      suggestedTags: localTags,
      suggestedMoods: localMoods,
    });

    /* 로컬 후보가 충분하면 LLM 호출을 스킵해 무비용 응답을 유지.
       기준 3 은 KoreanSuggestRow 가 한 줄에 보여주는 칩 수 하한과 일치 —
       사용자가 즉시 클릭할 수 있는 옵션이 그 정도면 LLM 의 추가 가치가
       작다. (라이브러리에 자료가 새로 추가돼 인덱스가 갱신되면 다시 더
       풍부한 결과가 자동으로 잡힌다.) */
    if (localTags.length >= 3) {
      setKoreanSuggestLoading(false);
      return;
    }
    if (koreanInventory.tags.length === 0 && koreanInventory.moodLabels.length === 0) {
      /* LLM 인벤토리도 비었으면 더 할 일이 없다. 로컬 결과만 노출 (또는
         로컬도 비어 있다면 자동 숨김). */
      setKoreanSuggestLoading(false);
      return;
    }

    const controller = new AbortController();
    setKoreanSuggestLoading(true);
    const timer = window.setTimeout(() => {
      void suggestEnglishTagsForKorean(q, koreanInventory, {
        inventoryHash: koreanInventoryHash,
        signal: controller.signal,
      })
        .then((spec) => {
          if (controller.signal.aborted) return;
          /* 로컬 + LLM dedupe merge — 로컬을 앞쪽으로, LLM 이 채워주는
             novel 토큰을 뒤로 이어 붙인다. 같은 토큰이 양쪽에 있으면 한
             번만. */
          const tags: string[] = [];
          const seenTags = new Set<string>();
          for (const t of localTags) {
            if (!seenTags.has(t)) {
              seenTags.add(t);
              tags.push(t);
            }
          }
          for (const t of spec.suggestedTags) {
            if (!seenTags.has(t)) {
              seenTags.add(t);
              tags.push(t);
            }
          }
          const moods: string[] = [];
          const seenMoods = new Set<string>();
          for (const m of localMoods) {
            if (!seenMoods.has(m)) {
              seenMoods.add(m);
              moods.push(m);
            }
          }
          for (const m of spec.suggestedMoods) {
            if (!seenMoods.has(m)) {
              seenMoods.add(m);
              moods.push(m);
            }
          }
          setKoreanSuggestion({
            rawQuery: q,
            suggestedTags: tags,
            suggestedMoods: moods,
            error: spec.error,
          });
          setKoreanSuggestLoading(false);
        })
        .catch(() => {
          /* AbortError 만 도달 — 다음 effect 실행에서 새 호출이 자리를
             잡으므로 여기서는 조용히 무시. */
        });
    }, 400);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, koreanInventory, koreanInventoryHash, koreanAliasIndex, dismissedKoreanQueries]);
  // Export 다이얼로그(handleExportFiltered) 의 scopeLabel 로만 사용된다.
  // 표시용 타이틀/서브타이틀은 상단 네비바 브레드크럼이 대체했고,
  // LibraryToolbar 의 좌측 헤더 슬롯도 함께 제거되었다.
  const toolbarTitle = activeTag?.startsWith("folder:")
    ? activeTag.replace(/^folder:/, "")
    : activeTag ?? activeSavedFilter?.name ?? (quickFilter === "trash" ? t("library.page.trash") : t("library.page.allReferences"));
  /** 상단 네비바에 표시할 브레드크럼 세그먼트. 루트("Reference Library")
   *  는 항상 별도로 렌더되므로 여기엔 포함하지 않는다.
   *  - 폴더 활성: `folder:Sports/0` → `[Sports, 0]`. 각 세그먼트는 부모
   *    폴더 태그(`folder:Sports`) 로 점프하는 클릭 핸들러를 같이 들고
   *    오므로, 깊이 N 단계에서도 자연스러운 상위 이동이 가능하다.
   *  - 일반 태그/Smart Folder/Quick Filter: leaf 1단계. `tag` 가 null
   *    이면 그 세그먼트는 활성(현재 위치) 으로 간주해 클릭 액션은 비활성.
   *  - 4단계 이상으로 깊어지면 중간을 `…` 로 collapse 해 우측 Storage/
   *    Settings 칩 영역과 충돌하지 않도록 한다. */
  type BreadcrumbSegment = {
    label: string;
    /** 클릭 시 점프할 폴더 태그(`folder:...`). null 이면 비활성(현재 위치). */
    folderTag: string | null;
    /** UI 에서 ellipsis 표시용 가짜 세그먼트인지 */
    ellipsis?: boolean;
  };
  const breadcrumbSegments = useMemo<BreadcrumbSegment[]>(() => {
    if (activeTag?.startsWith("folder:")) {
      const path = activeTag.replace(/^folder:/, "");
      const parts = path.split("/").filter(Boolean);
      let segs: BreadcrumbSegment[] = parts.map((part, i) => {
        const isLast = i === parts.length - 1;
        return {
          label: part,
          folderTag: isLast ? null : `folder:${parts.slice(0, i + 1).join("/")}`,
        };
      });
      // 스마트 브리프 매치 폴더는 루트("브리프 매치") 세그먼트를 라벨에서 숨겨
      // 일반 폴더처럼 "워크스페이스 / 폴더명" 으로 보이게 한다. 하위 세그먼트의
      // folderTag 는 전체 경로를 그대로 들고 있어 클릭/점프는 정상 동작.
      if (isBriefMatchPath(path) && segs.length > 1) {
        segs = segs.slice(1);
      }
      // 다중 폴더 선택 시: 마지막(앵커) 세그먼트 라벨에 "외 N개" 를 붙여
      // 여러 폴더가 함께 선택돼 있음을 한 줄로 표기(클릭 비활성). (A안)
      if (selectedFolderTags.length > 1 && segs.length > 0) {
        const lastIdx = segs.length - 1;
        segs[lastIdx] = {
          label: t("library.page.foldersSelectedSuffix", {
            label: segs[lastIdx].label,
            n: selectedFolderTags.length - 1,
          }),
          folderTag: null,
        };
      }
      // 4단계 이상이면 중간을 ellipsis 한 칸으로 collapse:
      // [first, …, parent, leaf]. 첫 세그먼트는 컨텍스트 유지를 위해 살림.
      if (segs.length > 3) {
        return [segs[0], { label: "…", folderTag: null, ellipsis: true }, segs[segs.length - 2], segs[segs.length - 1]];
      }
      return segs;
    }
    if (activeTag) {
      return [{ label: activeTag, folderTag: null }];
    }
    if (activeSavedFilter) {
      return [{ label: activeSavedFilter.name, folderTag: null }];
    }
    return [{ label: t(QUICK_FILTER_LABEL_KEYS[quickFilter]), folderTag: null }];
  }, [activeTag, activeSavedFilter, quickFilter, selectedFolderTags, t]);
  const returnProjectId = useMemo(() => getReturnProjectId(location.search), [location.search]);
  const focusRefId = useMemo(() => getFocusReferenceId(location.search), [location.search]);

  /* Brief 의 라이브러리 배지 → 역방향 점프. URL ?focus=<refId> 가 있으면
     items 가 도착한 직후 한 번만 selection 을 그 자료로 강제 + 인스펙터 패널
     자동 표시. quickFilter / activeTag 가 그 자료를 가린다면 quickFilter 를
     "all" 로 리셋해 화면에 보이도록 한다.
     useRef 로 1회성 처리 — 사용자가 그 자료를 다른 데서 선택 변경한 후에도
     re-render 마다 다시 점프하면 안 됨. */
  const focusAppliedRef = useRef(false);
  useEffect(() => {
    if (focusAppliedRef.current) return;
    if (!focusRefId) return;
    if (items.length === 0) return;
    const found = items.find((row) => row.id === focusRefId);
    if (!found) return;
    focusAppliedRef.current = true;
    /* 필터가 자료를 가리는 경우 사용자가 자료를 못 본다 → 안전하게 "all" 로
       리셋. 폴더/태그 필터도 같은 이유로 해제. */
    setQuickFilter("all");
    resetFolderSelection();
    setActiveSavedFilterId(null);
    setSelectedId(found.id);
    setSelectedIds(new Set([found.id]));
    setLastSelectedId(found.id);
  }, [focusRefId, items, resetFolderSelection]);

  /** Toolbar 우측 칩에 표시할 현재 활성 프로젝트.
   *
   *  returnTo URL 에는 `?tab=<id>&ws=<id>` query 가 포함될 수 있다 (BriefTab 의
   *  handleGoToLibrary 가 만든 형식). 칩 클릭 시 그 워크스페이스로 전환하면서
   *  같은 탭으로 복귀해야 한다 — 단순 `<a href>` 만으로는 라이브러리 워크스페이스
   *  에서 `/project/<id>` 가 라이브러리로 fallback 되어 무한 루프가 생긴다.
   *
   *  title 보강: recentProjectsCache 에 있으면 그걸, 없으면 projectId 단축 표시.
   *  ws 가 returnTo 에 없으면 cache 에서 추정 (Dashboard 한 번이라도 보면 채워짐). */
  const activeProjectChip = useMemo(() => {
    if (!returnProjectId) return null;
    const returnToFull = getReturnTo(location.search);
    const queryPart = returnToFull.includes("?") ? returnToFull.split("?")[1] : "";
    const params = new URLSearchParams(queryPart);
    const wsFromUrl = params.get("ws");

    const recent = getRecentProjects(200).find((p) => p.projectId === returnProjectId);
    const workspaceId = wsFromUrl ?? recent?.workspaceId ?? null;
    const title = recent?.title ?? returnProjectId.slice(0, 8);

    return {
      projectId: returnProjectId,
      title,
      workspaceId,
      returnTo: returnToFull,
    };
  }, [returnProjectId, location.search]);

  /** 칩 클릭 핸들러 — 워크스페이스 전환 + 원래 탭(brief/assets/...) 으로 복귀.
   *
   *  HashRouter 의 함정 (시행착오 메모):
   *  1) path-only nextUrl (`/project/x?tab=brief`) → hash 비워져 Index 라우트가
   *     `/dashboard` 로 redirect. ProjectPage 마운트 안 됨.
   *  2) hash-only nextUrl (`#/project/x?...`) → 현재 path 와 동일 → hash change
   *     만 발생, 페이지 reload 가 안 됨. 라이브러리 페이지 잔류.
   *  3) hash 후 명시적 `location.reload()` → 환경에 따라 reload 가 hash 를 그대로
   *     쓰지 않거나, result.ok 가 false 였을 때 fallthrough 가 막혀 머무름.
   *
   *  최종 해결: nextUrl 을 `/#${returnTo}` 형식으로 — path 가 명시적으로 `/` 로
   *  바뀌므로 (`/library` → `/`) vite 가 index.html 을 새로 서빙하면서 full
   *  reload 가 일어나고, hash 안의 `/project/x?tab=brief&ws=...` 가 그대로
   *  살아남아 HashRouter 가 ProjectPage 라우트를 정확히 매칭한다. */
  const handleActiveProjectChipClick = useCallback(async () => {
    if (!activeProjectChip) return;
    const { workspaceId, returnTo } = activeProjectChip;

    // returnTo 의 ?tab=... 을 sessionStorage 에 *매번* 백업. ProjectPage 가
    // 마운트 시 sourceTab 을 consume(remove) 하므로, 두 번째 라이브러리 진입
    // 후에도 동일 fallback 이 작동하려면 클릭마다 다시 채워 줘야 한다.
    try {
      const queryPart = returnTo.includes("?") ? returnTo.split("?")[1] : "";
      const params = new URLSearchParams(queryPart);
      const sourceTab = params.get("tab");
      if (sourceTab) {
        sessionStorage.setItem("preflow.return.sourceTab", sourceTab);
      }
    } catch {
      /* private mode 등 — 흐름 자체는 진행 */
    }

    const currentWsId = getCachedActiveId();
    if (workspaceId && workspaceId !== currentWsId) {
      try {
        await activateWorkspace(workspaceId, false, `/#${returnTo}`);
        return;
      } catch (err) {
        console.error("[library] return-to-project workspace switch failed:", err);
      }
    }
    // 같은 워크스페이스 or 전환 실패 fallback — 직접 navigate (HashRouter 안이라
    // prefix 불필요).
    navigate(returnTo);
  }, [activeProjectChip, navigate]);

  /** 임의 프로젝트로 이동(즐겨찾기 클릭 / 토스트 '이동' 액션 공용). tabId 가 있으면
   *  그 탭으로, 없으면 대시보드 클릭처럼 기본 진입. 워크스페이스가 다르면 전환 후
   *  복귀(handleActiveProjectChipClick 과 동일 메커니즘). */
  const openProjectInLibrary = useCallback(
    async (
      projectId: string,
      workspaceId: string | null | undefined,
      tabId?: "brief" | "assets" | "agent" | "storyboard",
      assetType?: string | null,
    ) => {
      const parts: string[] = [];
      if (tabId) parts.push(`tab=${tabId}`);
      // assets 탭으로 갈 때 에셋 타입(character/item/background)을 함께 넘겨
      // AssetsTab 이 해당 서브탭으로 바로 열리게 한다(?assetType=).
      if (tabId === "assets" && assetType) parts.push(`assetType=${encodeURIComponent(assetType)}`);
      if (workspaceId) parts.push(`ws=${encodeURIComponent(workspaceId)}`);
      const query = parts.length ? `?${parts.join("&")}` : "";
      const returnTo = `/project/${encodeURIComponent(projectId)}${query}`;
      if (tabId) {
        try {
          sessionStorage.setItem("preflow.return.sourceTab", tabId);
        } catch {
          /* private mode */
        }
      }
      const currentWsId = getCachedActiveId();
      if (workspaceId && workspaceId !== currentWsId) {
        try {
          await activateWorkspace(workspaceId, false, `/#${returnTo}`);
          return;
        } catch (err) {
          console.error("[library] openProject workspace switch failed:", err);
        }
      }
      navigate(returnTo);
    },
    [navigate],
  );

  const addPinnedProject = useCallback((p: { projectId: string; workspaceId: string; title: string }) => {
    setPinnedProjects((prev) => {
      if (prev.some((x) => x.projectId === p.projectId)) return prev;
      const next = [...prev, { projectId: p.projectId, workspaceId: p.workspaceId, title: p.title }].slice(0, PINNED_PROJECTS_MAX);
      writePinnedProjects(next);
      return next;
    });
  }, []);

  const removePinnedProject = useCallback((projectId: string) => {
    setPinnedProjects((prev) => {
      const next = prev.filter((x) => x.projectId !== projectId);
      writePinnedProjects(next);
      return next;
    });
  }, []);

  /** 전송 토스트의 '이동' 액션(빨간 글씨) — 클릭 시 대상 프로젝트의 해당 탭으로.
   *  brief→brief, conti→storyboard, agent→agent. 워크스페이스는 recent cache 에서. */
  const goToProjectToastAction = useCallback(
    (projectId: string, target: AttachTarget) => {
      const tabId: "brief" | "agent" | "storyboard" =
        target === "brief" ? "brief" : target === "agent" ? "agent" : "storyboard";
      const labelKey =
        target === "brief"
          ? "library.toast.goToBrief"
          : target === "agent"
            ? "library.toast.goToAgent"
            : "library.toast.goToConti";
      const wsId = getRecentProjects(200).find((p) => p.projectId === projectId)?.workspaceId ?? null;
      return (
        <ToastAction
          altText={t(labelKey)}
          onClick={() => {
            void openProjectInLibrary(projectId, wsId, tabId);
          }}
        >
          {t(labelKey)}
        </ToastAction>
      );
    },
    [t, openProjectInLibrary],
  );

  /** 인스펙터 "사용 위치" 뱃지 클릭 — 해당 프로젝트의 탭으로 이동.
   *  brief→brief, conti→storyboard, asset→assets. */
  const handleOpenUsageLocation = useCallback(
    (
      projectId: string,
      workspaceId: string | null | undefined,
      target: "brief" | "conti" | "asset",
      assetType?: string | null,
    ) => {
      const tabId: "brief" | "storyboard" | "assets" =
        target === "brief" ? "brief" : target === "conti" ? "storyboard" : "assets";
      void openProjectInLibrary(projectId, workspaceId, tabId, assetType);
    },
    [openProjectInLibrary],
  );

  /** 전송 성공 시 "마지막 보낸 대상" 기록 — title/workspaceId 가 없으면 recent
   *  cache 에서 보강한다(activeProjectChip 과 동일 소스). sessionStorage 에도
   *  같이 영속화. */
  const recordLastSentTarget = useCallback(
    (projectId: string, target: "brief" | "conti", title?: string, workspaceId?: string | null) => {
      const recent = getRecentProjects(200).find((p) => p.projectId === projectId);
      const entry: LastSentTarget = {
        projectId,
        title: title || recent?.title || projectId.slice(0, 8),
        workspaceId: workspaceId ?? recent?.workspaceId ?? null,
        target,
      };
      setLastSentTarget(entry);
      try {
        sessionStorage.setItem(LAST_SENT_TARGET_KEY, JSON.stringify(entry));
      } catch {
        /* private mode 등 — in-memory state 만으로도 이번 세션 동작엔 충분 */
      }
    },
    [],
  );

  /** 사이드바 "브리프/콘티로 이동" 클릭 — 마지막 전송 대상 프로젝트의 해당 탭
   *  으로 이동. 워크스페이스가 다르면 전환 후 복귀(돌아가기 버튼과 동일 메커니즘).
   *  Conti 의 ProjectPage 탭 id 는 `storyboard` 임에 주의. */
  const handleGoToLastSentTarget = useCallback(async () => {
    if (!lastSentTarget) return;
    const { projectId, workspaceId, target } = lastSentTarget;
    const tabId = target === "conti" ? "storyboard" : "brief";
    const wsQuery = workspaceId ? `&ws=${encodeURIComponent(workspaceId)}` : "";
    const returnTo = `/project/${encodeURIComponent(projectId)}?tab=${tabId}${wsQuery}`;

    // ProjectPage 가 마운트 시 sourceTab 을 consume 하므로 매 클릭마다 백업.
    try {
      sessionStorage.setItem("preflow.return.sourceTab", tabId);
    } catch {
      /* private mode — 흐름 자체는 진행 */
    }

    const currentWsId = getCachedActiveId();
    if (workspaceId && workspaceId !== currentWsId) {
      try {
        await activateWorkspace(workspaceId, false, `/#${returnTo}`);
        return;
      } catch (err) {
        console.error("[library] go-to-sent-target workspace switch failed:", err);
      }
    }
    navigate(returnTo);
  }, [lastSentTarget, navigate]);

  // 라이브러리 화면이 다루는 자산은 `references` 버킷에만 들어가므로
  // 프로젝트(`assets`/`contis`/`mood`/`style-presets` 등)와 분리해서 노출.
  // by_bucket 이 비어 있을 수 있어(legacy 응답) 0 으로 폴백.
  const referencesBytes = storageUsage?.by_bucket?.references ?? 0;
  const storageUsageLabel = storageUsage ? formatBytes(referencesBytes) : undefined;

  useEffect(() => {
    if (!selected) {
      setEditTitle("");
      setEditTags("");
      setEditNotes("");
      setEditSourceUrl("");
      setEditRating("0");
      setTimestampText("");
      return;
    }
    setEditTitle(selected.title);
    setEditTags(selected.tags.join(", "));
    setEditNotes(selected.notes ?? "");
    setEditSourceUrl(selected.source_url ?? "");
    setEditRating(String(selected.rating ?? 0));
    setTimestampText("");
    /* Phase E — 선택 전환 시 *전역* stage/progress 를 더 이상 리셋하지 않는다.
       자료별 stage/progress 는 itemClassifyProgress Map 에 보관돼 있고,
       인스펙터가 selected.id 키로 자신의 진행만 읽어 가므로 자동으로 분리된다.
       이전 자료의 in-flight 큐 잡은 abort 하지 않고 백그라운드에서 계속 진행
       — 사용자가 다른 자료를 보고 있어도 잠시 후 토스트/카드 갱신으로 결과
       를 받게 된다. */
  }, [selected?.id, selected]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = Number(playbackRate);
  }, [playbackRate, selected?.id]);

  useEffect(() => {
    if (!selected) setPreviewMode(false);
  }, [selected]);

  const replaceItem = useCallback((next: ReferenceItem) => {
    setItems((current) => current.map((item) => (item.id === next.id ? next : item)));
    setSelectedId(next.id);
    setSelectedIds((current) => {
      const updated = new Set(current);
      if (updated.size === 0) updated.add(next.id);
      return updated;
    });
    setLastSelectedId(next.id);
  }, []);

  /* onBlur 가 변경 없는 포커스 해제에서도 호출되므로(타이틀·노트·URL 클릭
     후 곧장 다른 곳 클릭), 실제로 바뀐 필드가 없으면 updateReference / 토스트
     까지 도달하지 않도록 dirty 체크를 먼저 한다. 칩 추가/제거·별점·URL X 는
     자체 핸들러에서 즉시 커밋하므로 여기 dirty 체크에 영향 없음. */
  const handleSaveMetadata = useCallback(async () => {
    if (!selected) return;
    const ratingNumber = Math.max(0, Math.min(5, Number(editRating) || 0));
    const nextRating = ratingNumber > 0 ? ratingNumber : null;
    const nextTitle = editTitle;
    const nextNotes = editNotes.trim() || null;
    const nextSourceUrl = editSourceUrl.trim() || null;
    const nextTags = parseTags(editTags);
    const currentTags = selected.tags;
    const tagsEqual =
      currentTags.length === nextTags.length
      && currentTags.every((tag, idx) => tag === nextTags[idx]);
    const isDirty =
      nextTitle !== selected.title
      || nextNotes !== (selected.notes ?? null)
      || nextSourceUrl !== (selected.source_url ?? null)
      || nextRating !== (selected.rating ?? null)
      || !tagsEqual;
    if (!isDirty) return;
    setSaving(true);
    try {
      const next = await updateReference(selected.id, {
        title: nextTitle,
        tags: nextTags,
        notes: nextNotes,
        source_url: nextSourceUrl,
        rating: nextRating,
      });
      replaceItem(next);
      toast({ title: t("library.toast.referenceUpdated"), description: t("library.toast.referenceUpdatedDesc") });
    } catch (err) {
      toast({ variant: "destructive", title: t("library.toast.saveFailed"), description: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  }, [editNotes, editRating, editSourceUrl, editTags, editTitle, replaceItem, selected, toast, t]);

  const handleCopyText = useCallback(async (value: string, label: string) => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    toast({ title: t("library.toast.copySuffix", { label }), description: value });
  }, [toast, t]);

  const handleToggleFavorite = useCallback(async () => {
    if (!selected) return;
    const next = await updateReference(selected.id, { is_favorite: !selected.is_favorite });
    replaceItem(next);
  }, [replaceItem, selected]);

  /* Eagle-style 인라인 편집 — 칩(X / +), 별 평점, URL X 버튼은
     editXxx 임시 상태를 거치지 않고 바로 updateReference 호출하여
     즉시 커밋. selected 가 갱신되면 useEffect 가 editXxx 를 다시
     동기화하므로 인라인 input 들과의 정합성은 자동으로 유지된다. */
  const handleAddTagToSelected = useCallback(async (tag: string) => {
    if (!selected) return;
    const trimmed = tag.trim();
    if (!trimmed) return;
    /* L1 즉시 시드 매칭 — 한글 입력일 때 시드 사전(`koreanTagSeedDictionary`)
       에 정확 매핑이 있으면 EN canonical 로 자동 정규화하면서 alias 메타
       (`ai_suggestions.user_tag_aliases_ko`) 에 원본 한글을 보존한다.
       시드 미스 한글은 그대로 등록되어 다음 "Settings → 라이브러리 AI 정리"
       batch 에서 LLM 으로 마저 정리. EN 입력은 변환 없이 그대로. */
    const seedHit = lookupSeedKoTag(trimmed);
    const finalTag = seedHit ? seedHit.en : trimmed;
    if (selected.tags.includes(finalTag)) return;
    const patch: Parameters<typeof updateReference>[1] = {
      tags: [...selected.tags, finalTag],
    };
    if (seedHit) {
      patch.ai_suggestions = mergeUserTagAliasIntoAi(
        selected.ai_suggestions as Record<string, unknown> | null | undefined,
        seedHit,
      );
    }
    try {
      const next = await updateReference(selected.id, patch);
      replaceItem(next);
    } catch (err) {
      toast({ variant: "destructive", title: t("library.toast.tagAddFailed"), description: err instanceof Error ? err.message : String(err) });
    }
  }, [replaceItem, selected, toast, t]);

  const handleRemoveTagFromSelected = useCallback(async (tag: string) => {
    if (!selected) return;
    if (!selected.tags.includes(tag)) return;
    try {
      const next = await updateReference(selected.id, { tags: selected.tags.filter((t) => t !== tag) });
      replaceItem(next);
    } catch (err) {
      toast({ variant: "destructive", title: t("library.toast.tagRemoveFailed"), description: err instanceof Error ? err.message : String(err) });
    }
  }, [replaceItem, selected, toast, t]);

  const handleAddFolderToSelected = useCallback(async (folderPath: string) => {
    if (!selected) return;
    if (!folderPath.trim()) return;
    try {
      const updated = await addReferencesToFolder([selected.id], folderPath);
      const next = updated.find((it) => it.id === selected.id);
      if (next) replaceItem(next);
    } catch (err) {
      toast({ variant: "destructive", title: t("library.toast.folderAddFailed"), description: err instanceof Error ? err.message : String(err) });
    }
  }, [replaceItem, selected, toast, t]);

  const handleRemoveFolderFromSelected = useCallback(async (folderPath: string) => {
    if (!selected) return;
    try {
      const updated = await removeReferencesFromFolder([selected.id], folderPath);
      const next = updated.find((it) => it.id === selected.id);
      if (next) replaceItem(next);
    } catch (err) {
      toast({ variant: "destructive", title: t("library.toast.folderRemoveFailed"), description: err instanceof Error ? err.message : String(err) });
    }
  }, [replaceItem, selected, toast, t]);

  const handleSetSelectedRating = useCallback(async (rating: number | null) => {
    if (!selected) return;
    const clamped = rating === null ? null : Math.max(0, Math.min(5, Math.round(rating)));
    const stored = clamped && clamped > 0 ? clamped : null;
    try {
      // touch:false — 별점은 메타데이터 변경이므로 updated_at 을 보존해 썸네일
      // 재로드(깜빡임/GIF 첫프레임 리셋)를 막는다.
      const next = await updateReference(selected.id, { rating: stored }, { touch: false });
      replaceItem(next);
    } catch (err) {
      toast({ variant: "destructive", title: t("library.toast.ratingSaveFailed"), description: err instanceof Error ? err.message : String(err) });
    }
  }, [replaceItem, selected, toast, t]);

  /* 숫자키 0~5 단축키용 — 현재 선택(다중 포함)에 별점을 일괄 적용한다.
     selectedItems(다중)이 있으면 그 전체, 없으면 단일 selected. rating=null
     (0 입력)이면 별점 해제(디폴트로 복귀). */
  const handleSetRatingForSelected = useCallback(async (rating: number | null) => {
    const targets = selectedItems.length > 0 ? selectedItems : selected ? [selected] : [];
    if (targets.length === 0) return;
    const clamped = rating === null ? null : Math.max(0, Math.min(5, Math.round(rating)));
    const stored = clamped && clamped > 0 ? clamped : null;
    try {
      // touch:false — updated_at 보존으로 썸네일 캐시버스터가 안 바뀌게 해
      // 선택 카드(특히 GIF/animated-WebP)가 깜빡이거나 리셋되지 않게 한다.
      const updated = await Promise.all(targets.map((it) => updateReference(it.id, { rating: stored }, { touch: false })));
      for (const next of updated) replaceItem(next);
    } catch (err) {
      toast({ variant: "destructive", title: t("library.toast.ratingSaveFailed"), description: err instanceof Error ? err.message : String(err) });
    }
  }, [selectedItems, selected, replaceItem, toast, t]);

  const handleClearSelectedSourceUrl = useCallback(async () => {
    if (!selected) return;
    setEditSourceUrl("");
    try {
      const next = await updateReference(selected.id, { source_url: null });
      replaceItem(next);
    } catch (err) {
      toast({ variant: "destructive", title: t("library.toast.urlClearFailed"), description: err instanceof Error ? err.message : String(err) });
    }
  }, [replaceItem, selected, toast, t]);

  const handleTogglePin = useCallback(async (item: ReferenceItem) => {
    const next = await toggleReferencePin(item);
    replaceItem(next);
    toast({ title: next.pinned_at ? t("library.toast.pinned") : t("library.toast.unpinned"), description: next.title });
  }, [replaceItem, toast, t]);

  /* ★ 우클릭/단축키 시점에 캡처된 selection snapshot 을 사용한다.
     Radix 컨텍스트 메뉴가 열렸다 항목이 클릭되는 사이에 selectedIds state 가
     1개로 좁혀져, 다중 선택 일괄 처리(분류/제안적용/병합/폴더이동/내보내기 등)가
     단건으로 떨어지던 고질 버그를 차단한다. snapshot 은 세 진입점이 모두 갱신:
       · grid 우클릭 → handleSelectGridItem(contextmenu)
       · canvas 우클릭 → runCanvasItemAction
       · 키보드 단축키 → keydown 핸들러(액션 발화 직전)
     snapshot 이 비었거나 대상 카드가 그 안에 없으면 단건으로 폴백
     (Finder 식 "선택 외 우클릭은 단건"). idsForRightClickAction 과 동일 정책. */
  const selectedIdsForItem = useCallback((item: ReferenceItem): string[] => {
    const snapshot = selectionSnapshotRef.current;
    if (snapshot.size > 0 && snapshot.has(item.id)) return [...snapshot];
    return [item.id];
  }, []);

  const permanentlyDeleteItems = useCallback(async (targets: ReferenceItem[]) => {
    if (targets.length === 0) return;
    const targetIds = new Set(targets.map((item) => item.id));
    for (const item of targets) {
      await deleteReference(item.id);
    }
    setItems((current) => current.filter((item) => !targetIds.has(item.id)));
    setSelectedId(null);
    setSelectedIds(new Set());
    setLastSelectedId(null);
    toast({
      title: targets.length === 1 ? t("library.toast.refPermDeleted") : t("library.toast.refsPermDeleted"),
      description: t("library.toast.permDeletedDesc", { n: targets.length }),
    });
    // 영구 삭제 직후엔 디스크 용량이 실제로 줄어들었으므로 우상단 칩을
    // 즉시 갱신. cleanable 도 같이 다시 계산되어 차이가 자연스럽게 좁혀짐.
    void refreshStorageUsage();
  }, [refreshStorageUsage, toast, t]);

  const handleDeleteSelected = useCallback(async () => {
    const targets = selectedItems.length > 1 ? selectedItems : selected ? [selected] : [];
    if (targets.length === 0) return;
    if (targets.every((item) => item.deleted_at)) {
      await permanentlyDeleteItems(targets);
      return;
    }
    const activeTargets = targets.filter((item) => !item.deleted_at);
    const updated: ReferenceItem[] = [];
    for (const item of activeTargets) {
      updated.push(await moveReferenceToTrash(item.id));
    }
    setItems((current) => current.map((item) => updated.find((next) => next.id === item.id) ?? item));
    setSelectedId(null);
    setSelectedIds(new Set());
    setLastSelectedId(null);
    /* soft-delete 라 Undo = restoreReference 한 번씩. 영구 삭제는
     * 위 early-return 으로 분리되므로 본 경로는 항상 정직한 약속.
     *
     * NOTE: `applyUpdatedItems` 는 컴포넌트 하단에 선언돼 TDZ 에 걸리므로
     * 원본과 동일한 inline setItems 패턴을 그대로 사용한다. */
    const undoIds = activeTargets.map((row) => row.id);
    showUndoBar({
      title: activeTargets.length === 1
        ? t("library.toast.itemRemoved")
        : t("library.toast.itemsRemoved", { n: activeTargets.length }),
      onUndo: async () => {
        const restored: ReferenceItem[] = [];
        for (const id of undoIds) restored.push(await restoreReference(id));
        setItems((current) => current.map((row) => restored.find((next) => next.id === row.id) ?? row));
      },
    });
  }, [permanentlyDeleteItems, selected, selectedItems, showUndoBar, t]);

  /* 우클릭 시점에 캡처된 selection snapshot 을 우선 사용 — Radix 메뉴 오픈/
     클릭 사이에 selectedIds state 가 어떤 이유로 1개로 좁혀져 다중 처리가
     단건으로 떨어지던 회귀를 차단. handleSelectGridItem(contextmenu) 가
     selectionSnapshotRef 를 항상 갱신해 두므로 우클릭 진입 시 fresh.
     snapshot 이 비어 있거나 우클릭 카드가 그 안에 없으면(예: 외부 트리거
     경로) 단건 [item.id] 로 폴백 — Finder 식 "선택 외 우클릭은 단건". */
  const idsForRightClickAction = useCallback((item: ReferenceItem): string[] => {
    const snapshot = selectionSnapshotRef.current;
    if (snapshot.size > 0 && snapshot.has(item.id)) return [...snapshot];
    return [item.id];
  }, []);

  /* 캔버스 카드 우클릭 액션 — 캔버스는 grid 처럼 contextmenu 시점에
     selectionSnapshotRef 를 갱신하지 않으므로, 액션 실행 직전에 현재 선택
     (selectedIds) 을 snapshot 으로 박아 grid 와 동일한 "선택 전체 or 단건"
     정책(Brief/Agent/Conti/Promote/Trash 다중 처리)을 그대로 재사용한다.
     우클릭 카드가 선택 밖이면 그 카드 단건. */
  const runCanvasItemAction = useCallback(
    (item: ReferenceItem, action: (it: ReferenceItem) => void) => {
      selectionSnapshotRef.current = selectedIds.has(item.id)
        ? new Set(selectedIds)
        : new Set([item.id]);
      action(item);
    },
    [selectedIds],
  );

  const handleMoveToTrash = useCallback(async (item: ReferenceItem) => {
    const ids = idsForRightClickAction(item);
    const targets = items.filter((row) => ids.includes(row.id) && !row.deleted_at);
    const updated: ReferenceItem[] = [];
    for (const target of targets) {
      updated.push(await moveReferenceToTrash(target.id));
    }
    setItems((current) => current.map((row) => updated.find((next) => next.id === row.id) ?? row));
    setSelectedId(null);
    setSelectedIds(new Set());
    setLastSelectedId(null);
    const undoIds = targets.map((row) => row.id);
    showUndoBar({
      title: targets.length === 1
        ? t("library.toast.itemRemoved")
        : t("library.toast.itemsRemoved", { n: targets.length }),
      onUndo: async () => {
        const restored: ReferenceItem[] = [];
        for (const id of undoIds) restored.push(await restoreReference(id));
        setItems((current) => current.map((row) => restored.find((next) => next.id === row.id) ?? row));
      },
    });
  }, [items, idsForRightClickAction, showUndoBar, t]);

  const handleRestoreReference = useCallback(async (item: ReferenceItem) => {
    const ids = idsForRightClickAction(item);
    const targets = items.filter((row) => ids.includes(row.id) && row.deleted_at);
    const updated: ReferenceItem[] = [];
    for (const target of targets) {
      updated.push(await restoreReference(target.id));
    }
    setItems((current) => current.map((row) => updated.find((next) => next.id === row.id) ?? row));
    setSelectedId(null);
    setSelectedIds(new Set());
    setLastSelectedId(null);
    toast({
      title: targets.length === 1 ? t("library.toast.refRestored") : t("library.toast.refsRestored"),
      description: t("library.toast.restoredDesc", { n: targets.length }),
    });
  }, [items, idsForRightClickAction, toast, t]);

  const handleRestoreSelected = useCallback(async () => {
    const targets = (selectedItems.length > 1 ? selectedItems : selected ? [selected] : []).filter((item) => item.deleted_at);
    if (targets.length === 0) return;
    const updated: ReferenceItem[] = [];
    for (const target of targets) {
      updated.push(await restoreReference(target.id));
    }
    setItems((current) => current.map((row) => updated.find((next) => next.id === row.id) ?? row));
    setSelectedId(null);
    setSelectedIds(new Set());
    setLastSelectedId(null);
    toast({
      title: targets.length === 1 ? t("library.toast.refRestored") : t("library.toast.refsRestored"),
      description: t("library.toast.restoredDesc", { n: targets.length }),
    });
  }, [selected, selectedItems, toast, t]);

  const handlePermanentlyDelete = useCallback((item: ReferenceItem) => {
    const ids = idsForRightClickAction(item);
    const targets = items.filter((row) => ids.includes(row.id) && row.deleted_at);
    setPermanentDeleteTargets(targets.length > 0 ? targets : [item]);
  }, [items, idsForRightClickAction]);

  const confirmPermanentDelete = useCallback(async () => {
    const targets = permanentDeleteTargets;
    setPermanentDeleteTargets([]);
    await permanentlyDeleteItems(targets);
  }, [permanentDeleteTargets, permanentlyDeleteItems]);

  const handleOpenDefault = useCallback(async (item: ReferenceItem) => {
    try {
      await openReferenceWithDefaultApp(item);
    } catch (err) {
      toast({ variant: "destructive", title: t("library.toast.openFailed"), description: err instanceof Error ? err.message : String(err) });
    }
  }, [toast, t]);

  /** link/youtube 더블클릭 시 OS 기본 브라우저로 원본 페이지를 띄운다 — Eagle 의
   *  더블클릭 동작과 동일. file_url 이 없는 link 레퍼런스는 인앱 프리뷰가 의미
   *  없으므로 외부로 위임하는 것이 자연스러움. */
  const handleOpenSourceUrl = useCallback(async (item: ReferenceItem) => {
    try {
      await openReferenceSourceUrl(item);
    } catch (err) {
      toast({ variant: "destructive", title: t("library.toast.openInBrowserFailed"), description: err instanceof Error ? err.message : String(err) });
    }
  }, [toast, t]);

  const handleShowInFolder = useCallback(async (item: ReferenceItem) => {
    try {
      await showReferenceInFolder(item);
    } catch (err) {
      toast({ variant: "destructive", title: t("library.toast.showInFolderFailed"), description: err instanceof Error ? err.message : String(err) });
    }
  }, [toast, t]);

  const handleCopyFilePath = useCallback(async (item: ReferenceItem) => {
    try {
      const filePath = await resolveReferenceFilePath(item);
      await navigator.clipboard.writeText(filePath);
      toast({ title: t("library.toast.filePathCopied"), description: filePath });
    } catch (err) {
      toast({ variant: "destructive", title: t("library.toast.copyPathFailed"), description: err instanceof Error ? err.message : String(err) });
    }
  }, [toast, t]);

  /* Eagle 식 Ctrl/Cmd+C — 자료 종류별로 가장 자연스러운 클립보드 페이로드를 선택.
       - URL(link / youtube) : source_url 텍스트
       - PNG / JPEG (단일)   : ClipboardItem(원본 비트맵) — 포토샵·Discord·
                               Slack 등 클립보드 이미지 페이스트 대상에서 즉시
                               사용. Chromium ClipboardItem 의 sanitized write
                               허용 MIME 은 사실상 png/jpeg 만 신뢰할 수 있다
                               (gif/webp 는 silently 폴백되거나 정적 프레임이
                               되어 의미가 없다).
       - GIF / WebP / 동영상 / 기타 미디어 (단일·다중) : **OS file copy**
                               — Electron 메인 프로세스가 PowerShell
                               `Set-Clipboard -Path` (Win) / `osascript`
                               (mac) 로 표준 CF_HDROP / NSFilenames pasteboard
                               를 채워, 탐색기/Finder/Discord/Slack 어디든
                               파일 페이스트가 동작한다.
       - 위 경로가 모두 실패하면 파일 경로 텍스트로 폴백 — 사용자 입장에선
         항상 "뭔가는 복사된다". */
  const handleCopySelectionToClipboard = useCallback(async () => {
    /* 우클릭/단축키 snapshot 우선 — 메뉴 상호작용 중 selectedIds 가 좁혀져도
       "복사 N개" 가 단건으로 떨어지지 않게 한다. snapshot 이 없으면 live
       selection 으로 폴백. */
    const snapshot = selectionSnapshotRef.current;
    const snapshotItems = snapshot.size > 0 ? items.filter((it) => snapshot.has(it.id)) : [];
    const targets =
      snapshotItems.length > 0
        ? snapshotItems
        : selectedItems.length > 0
          ? selectedItems
          : selected
            ? [selected]
            : [];
    if (targets.length === 0) return;

    const isUrlKind = (it: ReferenceItem): boolean =>
      it.kind === "link" || it.kind === "youtube";

    // 클립보드 이미지 데이터로 *안전하게* 페이스트되는 MIME 만 ClipboardItem
    // 으로 보낸다. 그 외는 OS file copy.
    const detectMime = (it: ReferenceItem, blob?: Blob | null): string => {
      const m = (blob?.type || it.mime_type || "").toLowerCase();
      if (m) return m;
      // 마지막 추정 — kind 만 보고
      if (it.kind === "image") return "image/png";
      return "";
    };
    const isClipboardPasteableImage = (mime: string): boolean =>
      mime === "image/png" || mime === "image/jpeg" || mime === "image/jpg";

    const copyFilesNative = window.preflowWindow?.copyFilesToClipboard;

    const collectFilePaths = async (items: ReferenceItem[]): Promise<string[]> => {
      const paths: string[] = [];
      for (const it of items) {
        if (!it.file_url && !it.thumbnail_url) continue;
        try {
          paths.push(await resolveReferenceFilePath(it));
        } catch {
          /* 일부만 path 가 나와도 그것만 복사 */
        }
      }
      return paths;
    };

    const tryOsFileCopy = async (items: ReferenceItem[]): Promise<string[] | null> => {
      if (!copyFilesNative) return null;
      const paths = await collectFilePaths(items);
      if (paths.length === 0) return null;
      const ok = await copyFilesNative(paths).catch(() => false);
      return ok ? paths : null;
    };

    try {
      // ── 단일 선택 ──────────────────────────────────────────────
      if (targets.length === 1) {
        const item = targets[0];

        // 1) URL 자료 → source_url 텍스트
        if (isUrlKind(item) && item.source_url) {
          await navigator.clipboard.writeText(item.source_url);
          toast({ title: t("library.toast.urlCopied"), description: item.source_url });
          return;
        }

        // 2) PNG / JPEG → ClipboardItem (비트맵 페이스트)
        if (item.file_url) {
          const mimeHint = detectMime(item).toLowerCase();
          if (isClipboardPasteableImage(mimeHint)) {
            try {
              const res = await fetch(item.file_url);
              if (res.ok) {
                const raw = await res.blob();
                const actual = (raw.type || mimeHint).toLowerCase();
                if (
                  isClipboardPasteableImage(actual)
                  && typeof ClipboardItem !== "undefined"
                  && navigator.clipboard?.write
                ) {
                  await navigator.clipboard.write([new ClipboardItem({ [actual]: raw })]);
                  toast({
                    title: t("library.toast.imageCopied"),
                    description: `${item.title} (${actual})`,
                  });
                  return;
                }
              }
            } catch {
              /* fall through to OS file copy */
            }
          }
        }

        // 3) GIF / WebP / 영상 / 기타 — OS 네이티브 파일 복사
        const osCopied = await tryOsFileCopy([item]);
        if (osCopied) {
          toast({
            title: t("library.toast.fileCopiedToClipboard"),
            description: t("library.toast.pasteInExplorer", { name: item.title }),
          });
          return;
        }

        // 4) 마지막 폴백 — 경로/URL/제목 텍스트
        try {
          const filePath = await resolveReferenceFilePath(item);
          await navigator.clipboard.writeText(filePath);
          toast({ title: t("library.toast.pathCopied"), description: filePath });
          return;
        } catch {
          /* no file path */
        }
        const fallback = item.source_url || item.title;
        await navigator.clipboard.writeText(fallback);
        toast({ title: t("library.toast.copiedToClipboard"), description: fallback });
        return;
      }

      // ── 다중 선택 ──────────────────────────────────────────────
      // 우선 file 자료는 OS file copy 로, URL-only(youtube 등 file_url 없는
      // 자료) 만 text 로 분리한다.
      const fileTargets: ReferenceItem[] = [];
      const urlOnly: ReferenceItem[] = [];
      for (const it of targets) {
        if (isUrlKind(it) && !it.file_url) urlOnly.push(it);
        else fileTargets.push(it);
      }

      const fileCopied = fileTargets.length > 0 ? await tryOsFileCopy(fileTargets) : null;
      if (fileCopied && urlOnly.length === 0) {
        toast({
          title: t("library.toast.nFilesCopied", { n: fileCopied.length }),
          description: t("library.toast.pasteAsFiles"),
        });
        return;
      }

      // OS file copy 가 안 됐거나 URL 자료가 섞여 있으면 텍스트로 합쳐서 복사
      const lines: string[] = [];
      if (fileCopied) {
        lines.push(...fileCopied);
      } else {
        for (const it of fileTargets) {
          try {
            lines.push(await resolveReferenceFilePath(it));
          } catch {
            if (it.source_url) lines.push(it.source_url);
            else lines.push(it.title);
          }
        }
      }
      for (const it of urlOnly) {
        if (it.source_url) lines.push(it.source_url);
        else lines.push(it.title);
      }
      const payload = lines.join("\n");
      await navigator.clipboard.writeText(payload);
      toast({
        title: t("library.toast.copiedNItems", { n: targets.length }),
        description: lines[0] + (lines.length > 1 ? " " + t("library.toast.plusMore", { n: lines.length - 1 }) : ""),
      });
    } catch (err) {
      toast({
        variant: "destructive",
        title: t("library.toast.copyFailed"),
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }, [items, selected, selectedItems, toast, t]);

  const handleCopyTags = useCallback((item: ReferenceItem) => {
    setCopiedTags(item.tags);
    toast({ title: t("library.toast.tagsCopied"), description: t("library.toast.tagsCopiedDesc", { n: item.tags.length }) });
  }, [toast, t]);

  const handlePasteTags = useCallback(async (item: ReferenceItem) => {
    if (!copiedTags) return;
    const next = await updateReference(item.id, { tags: [...new Set([...item.tags, ...copiedTags])] });
    replaceItem(next);
    toast({ title: t("library.toast.tagsPasted"), description: next.title });
  }, [copiedTags, replaceItem, toast, t]);

  const handleDuplicateReference = useCallback(async (item: ReferenceItem) => {
    try {
      const next = await duplicateReference(item);
      upsertUploadedItem(next);
      toast({ title: t("library.toast.refDuplicated"), description: next.title });
    } catch (err) {
      toast({ variant: "destructive", title: t("library.toast.duplicateFailed"), description: err instanceof Error ? err.message : String(err) });
    }
  }, [toast, upsertUploadedItem, t]);

  const handleCreateVariation = useCallback((item: ReferenceItem) => {
    if (!(item.kind === "image" || item.kind === "webp") || !item.file_url) {
      toast({ variant: "destructive", title: t("library.toast.variationUnavailable"), description: t("library.toast.variationImageOnly") });
      return;
    }
    setVariationTarget(item);
  }, [toast, t]);

  const handleVariationSubmit = useCallback((params: VariationSubmit) => {
    const source = variationTarget;
    if (!source) return;
    const count = Math.max(1, params.count);
    // 자동 구도 모드에서 다중 생성 시 장별로 서로 다른 앵글 지시를 덧붙여
    // 출력끼리도 다양해지게 한다(커스텀 프롬프트면 사용자 의도를 건드리지 않음).
    const promptForIndex = (i: number): string => {
      if (!params.autoComposition || count <= 1) return params.prompt;
      return `${params.prompt} ${VARIATION_ANGLE_DIRECTIVES[i % VARIATION_ANGLE_DIRECTIVES.length]}`;
    };
    // 병렬 생성 — 한 번의 제출 안에서도 동시에 돌리고, 제출 자체도 detached 라
    // "생성 중에 또 생성"이 가능하다. 진행 중에는 원본 카드에 로딩 오버레이.
    setVariationInFlight((n) => n + count);
    bumpVariationGenerating(source.id, 1);
    void (async () => {
      const results = await Promise.allSettled(
        Array.from({ length: count }, (_, i) =>
          createVariation(source, {
            prompt: promptForIndex(i),
            model: params.model,
            quality: params.quality,
            referenceImageUrls: params.referenceImageUrls,
            imageSize: params.imageSize,
          }),
        ),
      );
      let created = 0;
      let lastError: unknown = null;
      for (const r of results) {
        if (r.status === "fulfilled") {
          upsertUploadedItem(r.value);
          created += 1;
        } else {
          lastError = r.reason;
        }
      }
      setVariationInFlight((n) => Math.max(0, n - count));
      bumpVariationGenerating(source.id, -1);
      if (created > 0) {
        toast({ title: t("library.toast.variationDone"), description: t("library.toast.variationDoneDesc", { n: created }) });
      } else {
        toast({
          variant: "destructive",
          title: t("library.toast.variationFailed"),
          description: lastError instanceof Error ? lastError.message : String(lastError ?? ""),
        });
      }
    })();
  }, [variationTarget, upsertUploadedItem, toast, t, bumpVariationGenerating]);

  const handleMergeDuplicates = useCallback(async (item: ReferenceItem) => {
    if (!item.content_hash) {
      toast({ variant: "destructive", title: t("library.toast.mergeUnavailable"), description: t("library.toast.noContentHash") });
      return;
    }
    const ids = selectedIdsForItem(item);
    const selectedOthers = items.filter((row) => ids.includes(row.id) && row.id !== item.id);
    // 우클릭한 카드 외 추가로 선택된 카드가 있으면 그 selection 을 후보로,
    // 없으면 라이브러리 전체에서 같은 content_hash 의 살아있는 카드를 자동 후보로 채운다.
    const mergeItems = selectedOthers.length > 0
      ? selectedOthers
      : items.filter((row) =>
          row.id !== item.id
          && !row.deleted_at
          && row.content_hash === item.content_hash);
    if (mergeItems.length === 0) {
      toast({ variant: "destructive", title: t("library.toast.noDuplicatesFound"), description: t("library.toast.noOtherRefsSameHash") });
      return;
    }
    // 명시적 multi-select 인 경우엔 hash 가 다른 카드가 끼어 있으면 차단(원래 가드 유지).
    if (selectedOthers.length > 0 && mergeItems.some((row) => row.content_hash !== item.content_hash)) {
      toast({ variant: "destructive", title: t("library.toast.mergeUnavailable"), description: t("library.toast.selectDuplicatesSameHash") });
      return;
    }
    setDuplicateMerge({
      keep: item,
      mergeItems,
    });
  }, [items, selectedIdsForItem, toast, t]);

  const confirmDuplicateMerge = useCallback(async () => {
    if (!duplicateMerge) return;
    try {
      const result = await mergeReferences(duplicateMerge.keep.id, duplicateMerge.mergeItems.map((mergeItem) => mergeItem.id));
      setItems((current) => current.map((row) => {
        if (row.id === result.keep.id) return result.keep;
        return result.trashed.find((trashed) => trashed.id === row.id) ?? row;
      }));
      setSelectedIds(new Set([result.keep.id]));
      setSelectedId(result.keep.id);
      toast({ title: t("library.toast.duplicatesMerged"), description: t("library.toast.duplicatesMergedDesc", { n: result.trashed.length }) });
    } catch (err) {
      toast({ variant: "destructive", title: t("library.toast.mergeFailed"), description: err instanceof Error ? err.message : String(err) });
    }
  }, [duplicateMerge, toast, t]);

  const handleRenameReference = useCallback(async (item: ReferenceItem) => {
    setRenameTarget(item);
  }, []);

  const confirmRenameReference = useCallback(async (title: string) => {
    if (!renameTarget || title === renameTarget.title) return;
    try {
      const next = await updateReference(renameTarget.id, { title });
      replaceItem(next);
      toast({ title: t("library.toast.refRenamed"), description: next.title });
    } catch (err) {
      toast({ variant: "destructive", title: t("library.toast.renameFailed"), description: err instanceof Error ? err.message : String(err) });
    }
  }, [renameTarget, replaceItem, toast, t]);

  const handleSearchByImage = useCallback(
    (item: ReferenceItem, engineId: ImageSearchEngineId = DEFAULT_IMAGE_SEARCH_ENGINE) => {
      const img = getImageSearchSourceUrl(item);
      if (!img) {
        toast({ variant: "destructive", title: t("library.toast.searchUnavailable"), description: t("library.toast.searchByImageNoImage") });
        return;
      }
      // 메인이 이미지를 Imgur 에 업로드한 뒤 선택 엔진의 by-URL 검색을 외부
      // 브라우저로 연다. 로컬 파일도 검색 가능. 업로드에 1~3초가 걸리므로 진행 토스트.
      toast({ title: t("library.toast.searchPreparing") });
      void (async () => {
        try {
          await searchByImage(img, engineId);
        } catch {
          toast({ variant: "destructive", title: t("library.toast.searchUnavailable"), description: t("library.toast.searchByImageFailed") });
        }
      })();
    },
    [toast, t],
  );

  /* Phase E — 자료 한 건을 큐에 넣고, 인스펙터/카드가 보는 자료별 진행 Map
     (itemClassifyProgress) 을 업데이트하는 단일 진입점. silent 옵션은 bulk
     호출에서 자료별 토스트 폭주를 막기 위한 스위치. 반환값은 enqueue 가
     실제로 성공했는지 (중복 잡이면 false). */
  const enqueueClassifyForItem = useCallback((item: ReferenceItem, opts: { silent?: boolean } = {}): boolean => {
    const { silent = false } = opts;
    /* 토스트 문구와 실제 동작이 절대 어긋나지 않도록 autoApplyTags 를 상수로
       끌어올린다. true 면 분류 직후 추천 태그가 자동 등록되므로 완료 토스트도
       "자동 등록됨" 문구를 써야 한다 (이전엔 "검토 후 적용" 으로 거짓 안내됨). */
    const AUTO_APPLY_TAGS = true;
    const ok = enqueueClassify(item, {
      language: effectiveAiLanguageRef.current,
      /* AI 분석 후 추천 태그를 항상 자동 등록한다. 큐 워커가 분류 직후
         acceptReferenceAiSuggestions 로 suggested_tags 를 item.tags 에 병합. */
      autoApplyTags: AUTO_APPLY_TAGS,
      tagLanguage: effectiveAiTagLanguageRef.current,
      onStage: (stage) => {
        setItemClassifyProgress((prev) => {
          const next = new Map(prev);
          const cur = next.get(item.id) ?? { stage: "idle" as ClassifyStage, progress: null };
          next.set(item.id, { ...cur, stage });
          return next;
        });
      },
      onProgress: (progress) => {
        setItemClassifyProgress((prev) => {
          const next = new Map(prev);
          const cur = next.get(item.id) ?? { stage: "idle" as ClassifyStage, progress: null };
          next.set(item.id, { ...cur, progress });
          return next;
        });
      },
      onSettled: ({ item: result, error }) => {
        setItemClassifyProgress((prev) => {
          if (!prev.has(item.id)) return prev;
          const next = new Map(prev);
          next.delete(item.id);
          return next;
        });
        if (result) replaceItem(result);
        if (silent) return;
        if (error) {
          const friendly = friendlyClassifyError(error);
          if (friendly) {
            toast({ variant: "destructive", title: t("library.toast.aiClassifyFailed"), description: friendly });
            loadReferences();
          }
        } else if (result) {
          toast(
            AUTO_APPLY_TAGS
              ? { title: t("library.toast.aiClassifyDoneAutoTagged"), description: t("library.toast.aiClassifyDoneAutoTaggedDesc") }
              : { title: t("library.toast.aiClassifyReady"), description: t("library.toast.aiClassifyReadyDesc") },
          );
        }
      },
    });
    if (ok) {
      /* 큐 워커가 sampling 콜백을 보내기 전까지 stepper 가 ghost 만 보여주는
         지연을 줄이려고, enqueue 직후 즉시 sampling stage seed 를 박는다. */
      setItemClassifyProgress((prev) => {
        const next = new Map(prev);
        next.set(item.id, { stage: "idle", progress: { stage: "sampling" } });
        return next;
      });
    }
    return ok;
  }, [loadReferences, replaceItem, t, toast]);

  const handleClassifyReference = useCallback((item: ReferenceItem) => {
    /* 우클릭 → AI 분류 흐름. multi-select 가 활성이면 선택된 모든 자료를
       묶어 한 번에 큐에 넣고 bulk 토스트만 한 번 띄운다. 단일 자료라면
       기존 흐름(자료 선택 + 완료 토스트) 을 그대로 유지. */
    const ids = selectedIdsForItem(item);
    if (ids.length > 1) {
      const targets = items.filter((row) => ids.includes(row.id) && !row.deleted_at);
      let enqueued = 0;
      for (const target of targets) {
        if (enqueueClassifyForItem(target, { silent: true })) enqueued += 1;
      }
      if (enqueued > 0) {
        toast({
          title: t("library.toast.aiClassifyQueued"),
          description: t("library.toast.aiClassifyQueuedDesc", { n: enqueued }),
        });
      }
      return;
    }
    setSelectedId(item.id);
    enqueueClassifyForItem(item);
  }, [enqueueClassifyForItem, items, selectedIdsForItem, t, toast]);

  /* 우클릭 → 이미 분석된 AI 제안 태그를 실제 태그에 적용. acceptReferenceAiSuggestions
     는 LLM 을 호출하지 않고 저장된 ai_suggestions.suggested_tags 를 item.tags 에
     머지(+dedupe)만 하므로 비용 0·멱등. multi-select 면 선택 전체에 일괄 적용하고,
     ai_suggestions 가 없는(=아직 분석 안 된) 자료는 건너뛴다. 머지 언어는 다른
     accept 경로와 동일하게 Settings 의 effective 태그 언어를 따른다. */
  const handleAcceptSuggestionsReference = useCallback(async (item: ReferenceItem) => {
    const ids = selectedIdsForItem(item);
    const targets = items.filter((row) => ids.includes(row.id) && !row.deleted_at);
    const withSuggestions = targets.filter((row) => {
      const s = row.ai_suggestions as Partial<ReferenceAiSuggestions> | null | undefined;
      return !!s && Array.isArray(s.suggested_tags) && s.suggested_tags.length > 0;
    });
    if (withSuggestions.length === 0) {
      toast({ title: t("library.toast.noSuggestionsToApply") });
      return;
    }
    const updated: ReferenceItem[] = [];
    let failed = 0;
    for (const it of withSuggestions) {
      try {
        const next = await acceptReferenceAiSuggestions(it, {
          tagLanguage: effectiveAiTagLanguageRef.current,
        });
        updated.push(next);
      } catch {
        failed += 1;
      }
    }
    if (updated.length > 0) {
      const byId = new Map(updated.map((u) => [u.id, u] as const));
      setItems((current) => current.map((row) => byId.get(row.id) ?? row));
    }
    if (ids.length > 1) {
      toast({
        title: t("library.toast.aiSuggestionsAppliedN", { n: updated.length }),
        description: failed > 0 ? t("library.toast.acceptFailed") : undefined,
      });
    } else {
      toast({
        title: t("library.toast.aiSuggestionsApplied"),
        description: t("library.toast.aiSuggestionsAppliedDesc"),
      });
    }
  }, [items, selectedIdsForItem, t, toast]);

  const handleRegenerateThumbnail = useCallback(async (item: ReferenceItem) => {
    try {
      const next = await regenerateReferenceThumbnail(item);
      replaceItem(next);
      toast({ title: t("library.toast.thumbnailRegenerated"), description: next.title });
    } catch (err) {
      toast({ variant: "destructive", title: t("library.toast.thumbnailFailed"), description: err instanceof Error ? err.message : String(err) });
    }
  }, [replaceItem, toast, t]);

  /** Attach 성공 시 자료의 last_used_at 을 *현재 시각으로* in-memory 갱신.
   *  linkReferenceToProject 는 DB 의 reference_items.last_used_at 도 갱신하지만,
   *  여기서 state 를 같이 바꿔주지 않으면 "최근 사용" 사이드바 필터가 페이지를
   *  새로 로드하기 전까지 비어있어 "내가 분명히 브리프에 넣었는데 안 잡힌다"
   *  는 사용자 증상이 발생한다. Cross-workspace 케이스(다른 워크스페이스의 자료를
   *  현재 워크스페이스 프로젝트로 attach)는 DB 갱신이 silently 0-row 가 되지만,
   *  사용자 입장에선 "방금 사용한 자료" 로 인지되는 게 정확하므로 같은 방식으로
   *  in-memory 만이라도 즉시 반영. */
  const markItemAsUsed = useCallback((id: string) => {
    const now = new Date().toISOString();
    /* 1) 낙관적 in-memory 갱신 — 그리드/필터가 즉시 반응. */
    setItems((current) => current.map((row) => (row.id === id ? { ...row, last_used_at: now } : row)));
    /* 2) DB 영속 — reference 본체는 *현재 활성 라이브러리 워크스페이스 DB* 에
       있으므로, cross-workspace 프로젝트 첨부(link row 가 FK 로 실패하는
       케이스) 에서도 last_used_at 은 정상 기록된다. 이게 빠지면 새로고침/
       워크스페이스 전환 후 "최근 사용" 에서 사라지는(=리셋되는) 회귀가 난다.
       best-effort — 실패해도 in-memory 갱신은 이번 세션 동안 유지. */
    void updateReference(id, { last_used_at: now }).catch(() => {
      /* 네트워크/권한 등 — 다음 사용 시 재기록 */
    });
  }, []);

  /** Brief / Conti attach 직후 LS 가 막 갱신된 시점에서 "사용 위치 /
   *  카운트" 를 re-scan 해 인스펙터/그리드를 즉시 따라잡게 한다. DB
   *  카운트와는 per-refId max 머지라 LS 단독 증가도 안전하게 반영. */
  const refreshUsageLocations = useCallback(() => {
    const ls = scanAllUsageFromLocalStorage();
    setUsageLocations(ls.byRefId);
    setUsageCounts((prev) => mergeUsageCounts(prev, ls.countsByRefId));
  }, []);

  // 인스펙터에서 자료를 새로 선택할 때마다 LS 사용추적을 재스캔. 다른 화면
  // (프로젝트 Assets 탭)에서 에셋이 삭제되면 LS 가 바뀌는데, 라이브러리 페이지는
  // keep-mounted 라 load effect 가 다시 안 돈다. 선택 시점에 재스캔해 "사용
  // 위치(에셋)" 라인이 stale 하게 남지 않도록 한다(생성됨 카운트는 별도 live memo).
  useEffect(() => {
    if (!selected?.id) return;
    refreshUsageLocations();
  }, [selected?.id, refreshUsageLocations]);

  /** *Project 가 이미 결정된 경우* 의 실제 attach 실행기. picker / context-menu
   *  (returnProjectId 보유) / 미래의 drag-drop 등 모든 경로의 종점. */
  const performAttachToProject = useCallback(async (item: ReferenceItem, projectId: string, target: AttachTarget) => {
    const result = await attachLibraryItemToProject(item, projectId, target);
    if (!result.ok) {
      const baseDesc =
        result.errorCode === "reference-deleted"
          ? t("library.toast.refDeleted")
          : result.errorCode === "kind-not-allowed"
            ? t("library.toast.projectImportAccepts")
            : result.errorCode === "missing-file-url"
              ? t("library.toast.refNoStoredFile")
              : t("library.toast.linkFailed");
      // link-failed 일 때 실제 underlying error 도 함께 노출 (디버깅 도움)
      const desc = result.errorMessage ? `${baseDesc} (${result.errorMessage})` : baseDesc;
      toast({ variant: "destructive", title: t("library.toast.addToTargetFailed", { target }), description: desc });
      return;
    }
    // target 별 후속 처리
    if (target === "brief") {
      // base64 변환 후 BriefTab 의 모듈-레벨 helper 로 append.
      // 라이브러리의 노트/태그를 RefAnnotation 으로 같이 전파해 Brief AI 에게
      // 풍부한 컨텍스트를 전달 (timestamp 노트의 시점 정보는 Brief 의 단일
      // annotation 모델에 맞춰 텍스트로 직렬화 — 자세한 매핑은 helper 참조).
      try {
        const refItem = await referenceToRefItem(item, buildAnnotationFromLibrary(item));
        const appendResult = appendLibraryRefItemToProject(projectId, refItem);
        if (appendResult === "duplicate") {
          // 중복은 silent skip 이 아니라 사용자에게 명시 — "이미 있다" 정보가
          // 행동을 가이드 (예: Brief 에서 자료를 빼고 다시 넣고 싶었다면).
          toast({
            title: t("library.toast.alreadyInBrief"),
            description: t("library.toast.alreadyInBriefDesc", { n: item.title }),
          });
          return;
        }
        markItemAsUsed(item.id);
        refreshUsageLocations();
        recordLastSentTarget(projectId, "brief");
        toast({
          title: t("library.toast.addedTo", { target: t("library.toast.target.brief") }),
          description: t("library.toast.addedToDesc", { n: item.title, target: t("library.toast.target.brief") }),
          action: goToProjectToastAction(projectId, "brief"),
        });
      } catch (err) {
        toast({
          variant: "destructive",
          title: t("library.toast.addToTargetFailed", { target: "brief" }),
          description: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    if (target === "agent") {
      // 라이브러리 자료를 아이데이션(Agent) 채팅 첨부로 전달 — 정지 썸네일 1장
      // (영상/GIF 는 poster + 좌상단 뱃지). AI 분석 요약(caption)은 화면엔 안 보이고
      // LLM 에만 동봉. 원본 base64 를 그대로 넣으면 큰 파일이 localStorage 쿼터를
      // 초과해 조용히 누락되므로 항상 다운스케일한다.
      try {
        const img = await buildAgentAttachmentForRef(item, uiLanguage !== "en");
        if (!img) {
          toast({
            variant: "destructive",
            title: t("library.toast.addToTargetFailed", { target: t("library.toast.target.agent") }),
            description: t("library.toast.agentNoEligible"),
          });
          return;
        }
        appendAgentChatImages(projectId, [img]);
        markItemAsUsed(item.id);
        refreshUsageLocations();
        toast({
          title: t("library.toast.addedTo", { target: t("library.toast.target.agent") }),
          description: t("library.toast.addedToChatDesc", { n: item.title }),
          action: goToProjectToastAction(projectId, "agent"),
        });
      } catch (err) {
        toast({
          variant: "destructive",
          title: t("library.toast.addToTargetFailed", { target: t("library.toast.target.agent") }),
          description: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    if (target === "conti-inpaint") {
      // "Conti 에 추가" 의 실제 다운스트림 = 해당 프로젝트의 Conti Studio
      // > Compare > 라이브러리 풀에 자료 *스냅샷 entry* append.
      //
      // 스냅샷 형태로 저장하는 이유: 각 워크스페이스는 독립 SQLite + 독립
      // storage 경로라, id 만 저장하면 사용자가 프로젝트 워크스페이스로 돌아
      // 갔을 때 본체/파일 모두 조회 불가능 → 그리드가 빈다. 그래서 attach
      // 시점에 (=라이브러리 워크스페이스 활성) 정적 poster 를 base64 로
      // 인라인한 entry 를 만들어 cross-workspace 안전성을 확보한다.
      //
      // 중복은 silent skip 이 아니라 사용자에게 명시 — "이미 있다" 정보가
      // 다음 행동을 가이드한다(Brief alreadyInBrief 와 동일 정책).
      try {
        const entry = await makeCompareLibraryEntry(item);
        const appendResult = appendCompareLibraryEntries(projectId, [entry]);
        if (appendResult.duplicate.length > 0 && appendResult.added.length === 0) {
          toast({
            title: t("library.toast.alreadyInCompareLibrary"),
            description: t("library.toast.alreadyInCompareLibraryDesc", { n: item.title }),
          });
          return;
        }
        // 같은 탭의 ContiStudio 가 마운트돼 있을 수 있으니 custom 이벤트로
        // refresh 트리거. 다른 탭/창은 storage 이벤트로 자연 반응.
        try {
          window.dispatchEvent(
            new CustomEvent("preflow:compare-library-changed", { detail: { projectId } }),
          );
        } catch {
          /* CustomEvent 미지원 환경 — 무시(다음 ContiStudio 마운트 시 재 read) */
        }
        markItemAsUsed(item.id);
        // Conti Compare Library LS 가 막 갱신됐으니 인스펙터 "사용 위치"
        // 와 그리드 배지 카운트를 즉시 따라잡게 한다 (Brief 흐름과 동일).
        refreshUsageLocations();
        recordLastSentTarget(projectId, "conti");
        toast({
          title: t("library.toast.addedTo", { target: t("library.toast.target.conti") }),
          description: t("library.toast.addedAsCompareLibraryRefDesc", { n: item.title }),
          action: goToProjectToastAction(projectId, "conti-inpaint"),
        });
      } catch (err) {
        toast({
          variant: "destructive",
          title: t("library.toast.addToTargetFailed", { target: t("library.toast.target.conti") }),
          description: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    if (target === "conti-scene" || target === "conti-sketch") {
      // Phase 4 에서 활성. 현재는 inpaint 로 redirect 되거나 menu 에 노출 안 됨.
      toast({ title: t("library.toast.notYetWired") });
      return;
    }
  }, [toast, t, setPromoteTarget, markItemAsUsed, refreshUsageLocations, recordLastSentTarget, uiLanguage, goToProjectToastAction]);

  /** 사용자가 메뉴를 클릭했을 때의 entry point — returnProjectId 가 있으면
   *  바로 실행, 없으면 ProjectPickerDialog 를 띄워 사용자가 프로젝트 선택.
   *  cross-workspace 흐름을 양방향으로 자연스럽게 풀어준다. */
  const handleAddToProjectTarget = useCallback((item: ReferenceItem, target: AttachTarget) => {
    // 어느 경로로 라이브러리에 들어왔든 *항상* 프로젝트 picker 를 먼저 띄운다.
    // (returnProjectId 자동 타겟 제거 — 즉시 이동은 attach 후 토스트 '이동'으로만.)
    setProjectPicker({ kind: "single", item, target });
  }, []);

  /** 다중 자료를 한 번에 Brief 로 attach.
   *
   *  결과 집계가 4분기 (성공 / 중복-skip / 실패 / 부분) 로 늘어났고, base64
   *  변환이 자료당 무거워(영상은 fetch + thumbnail base64화) 진행 중에도
   *  사용자에게 N/M progress 를 보여줄 필요가 있다.
   *
   *  토스트 전략:
   *    1) 진행 토스트를 *하나* 띄워 두고 매 자료마다 `update()` 로 갱신.
   *    2) 마지막에 같은 토스트를 최종 요약으로 swap (success/partial/fail).
   *  use-toast 의 update() 는 동일 id 위에 덮어 그리므로 토스트 폭주 없음.
   *
   *  호출처:
   *    - returnProjectId 기반 진입: `handleAddToBrief` 가 activeProjectChip
   *      을 직접 넘긴다.
   *    - picker 기반 진입: `handlePickProject` 가 picker 에서 선택된
   *      RecentProject 를 넘긴다 (라이브러리 직접 진입 + multi-select 흐름).
   *  `project` 파라미터를 명시적으로 받음으로써 cross-workspace picker 흐름과
   *  현재 프로젝트 흐름을 한 함수로 통합 처리. */
  const sendItemsToBrief = useCallback(async (
    candidates: ReferenceItem[],
    project: { projectId: string; title: string },
  ) => {
    if (candidates.length === 0) return;
    const projectId = project.projectId;
    const projectTitle = project.title;

    let ok = 0;
    let dup = 0;
    let fail = 0;
    let firstError: string | undefined;

    // 진행 토스트 — 자료당 갱신. 1건짜리 호출에서도 동일 코드 패스로 안전
    // (i=1/n=1 → 거의 즉시 final 로 swap).
    const progress = toast({
      title: t("library.toast.bulkAttachInProgress", { name: projectTitle }),
      description: t("library.toast.bulkAttachProgressDesc", {
        i: 0,
        n: candidates.length,
        title: candidates[0]?.title ?? "",
      }),
    });

    for (let idx = 0; idx < candidates.length; idx++) {
      const item = candidates[idx];
      progress.update({
        id: progress.id,
        title: t("library.toast.bulkAttachInProgress", { name: projectTitle }),
        description: t("library.toast.bulkAttachProgressDesc", {
          i: idx + 1,
          n: candidates.length,
          title: item.title,
        }),
      });
      try {
        const result = await attachLibraryItemToProject(item, projectId, "brief");
        if (!result.ok) {
          fail++;
          firstError = firstError ?? result.errorMessage ?? result.errorCode;
          continue;
        }
        // performAttachToProject 의 brief 후속 처리와 동일 — base64 변환 +
        // 라이브러리 메타를 RefAnnotation 으로 같이 전파, 그 다음 모듈-레벨
        // helper 로 append.
        const refItem = await referenceToRefItem(item, buildAnnotationFromLibrary(item));
        const appendResult = appendLibraryRefItemToProject(projectId, refItem);
        if (appendResult === "duplicate") {
          dup++;
          continue;
        }
        // "최근 사용" 사이드바 필터에 즉시 반영되도록 in-memory state 갱신.
        markItemAsUsed(item.id);
        ok++;
      } catch (err) {
        fail++;
        firstError = firstError ?? (err instanceof Error ? err.message : String(err));
      }
    }

    // 진행 토스트 완료 직후 LS 가 N건 추가됐을 수 있으니 한 번에 re-scan.
    // 자료당 호출하면 동기 enumeration 비용이 N배 들어 idle 밖에서 점프함.
    if (ok > 0) {
      refreshUsageLocations();
      recordLastSentTarget(projectId, "brief", projectTitle);
    }

    // 최종 요약 — 진행 토스트 id 위에 덮어쓴다. variant 도 같이 갱신.
    if (fail === 0 && dup === 0) {
      progress.update({
        id: progress.id,
        action: goToProjectToastAction(project.projectId, "brief"),
        title: t("library.toast.bulkAttachedToBrief", { n: ok, name: projectTitle }),
        description: undefined,
      });
    } else if (fail === 0 && ok > 0) {
      progress.update({
        id: progress.id,
        action: goToProjectToastAction(project.projectId, "brief"),
        title: t("library.toast.bulkAttachedToBriefWithDup", { ok, dup, name: projectTitle }),
        description: undefined,
      });
    } else if (ok === 0 && dup === 0) {
      progress.update({
        id: progress.id,
        variant: "destructive",
        title: t("library.toast.bulkAttachFailed"),
        description: firstError ?? "",
      });
    } else if (ok === 0 && dup > 0 && fail === 0) {
      // 전부 중복이었던 케이스 — 실패는 아니지만 success 토스트도 거짓말이라
      // 단일 자료 alreadyInBrief 와 동일한 톤으로 안내.
      progress.update({
        id: progress.id,
        title: t("library.toast.alreadyInBrief"),
        description: t("library.toast.alreadyInBriefDesc", { n: candidates[0]?.title ?? "" }),
      });
    } else {
      progress.update({
        id: progress.id,
        title: t("library.toast.bulkAttachPartialWithDup", { ok, dup, fail }),
        description: firstError ?? "",
      });
    }
  }, [toast, t, markItemAsUsed, refreshUsageLocations, recordLastSentTarget, goToProjectToastAction]);

  /** 우클릭 메뉴의 "Brief 에 추가" 진입점.
   *
   *  핵심: multi-select 가 있으면 *우클릭한 카드가 selection 안이든 밖이든*
   *  selection 전체를 처리. 우클릭은 단지 *명령 트리거* 역할이고, 명령 대상은
   *  selection. 이게 사용자 의도와 일치 (selection 외 카드를 우클릭한 거라면
   *  그건 selection 을 해제하고 단건 의도였다는 뜻이 되는데, 라이브러리 grid
   *  의 우클릭은 selection 을 건드리지 않기 때문에 그 패턴은 불가능 — 따라서
   *  multi-select 가 있으면 항상 selection 우선).
   *
   *  진행 흐름 (4 case):
   *   - selection ≤ 1 + returnProjectId 있음 → 단건 즉시 attach.
   *   - selection ≤ 1 + returnProjectId 없음 → 단건 picker.
   *   - selection > 1 + activeProjectChip 있음 → 즉시 bulk attach.
   *   - selection > 1 + activeProjectChip 없음 → bulk picker (신규 — 과거엔
   *     bulkRequiresActiveProject 토스트로 거절했음). */
  const handleAddToBrief = useCallback((item: ReferenceItem) => {
    // 우클릭 시점에 캡처해 둔 snapshot 을 사용 — state race 회피.
    const snapshot = selectionSnapshotRef.current;
    if (snapshot.size > 1) {
      const candidates = items.filter((it) => snapshot.has(it.id) && !it.deleted_at);
      if (candidates.length === 0) return;
      // 항상 picker — pick 시 handlePickProject 가 sendItemsToBrief 호출.
      setProjectPicker({ kind: "bulk", items: candidates, target: "brief" });
      return;
    }
    // 단건 — 항상 picker.
    handleAddToProjectTarget(item, "brief");
  }, [items, handleAddToProjectTarget]);

  /** 다중 자료를 한 번에 아이데이션(Agent) 채팅 첨부로 보낸다. brief/conti 의
   *  bulk 흐름과 동일 정책 — 단, 채팅 첨부는 image/webp/gif 만, 최대
   *  CHAT_IMAGE_MAX(4) 장. 각 이미지는 크기 제한 webp 로 재인코딩해 LS 쿼터
   *  초과로 조용히 누락되는 것을 막는다. */
  const sendItemsToAgent = useCallback(async (
    candidates: ReferenceItem[],
    project: { projectId: string; title: string },
  ) => {
    // image/webp/gif/video 모두 허용(영상/GIF 는 프레임 추출 구조라 첨부 가능).
    const eligible = candidates.filter(
      (it) =>
        !it.deleted_at &&
        (it.kind === "image" || it.kind === "webp" || it.kind === "gif" || it.kind === "video") &&
        (Boolean(it.file_url) || Boolean(it.thumbnail_url)),
    );
    if (eligible.length === 0) {
      toast({
        variant: "destructive",
        title: t("library.toast.addToTargetFailed", { target: t("library.toast.target.agent") }),
        description: t("library.toast.agentNoEligible"),
      });
      return;
    }
    // 채팅칸은 총 4장 cap. 자료당 썸네일 1장.
    const prefKo = uiLanguage !== "en";
    const images: ChatImage[] = [];
    for (const it of eligible.slice(0, CHAT_IMAGE_MAX)) {
      const img = await buildAgentAttachmentForRef(it, prefKo);
      if (!img) continue;
      images.push(img);
      markItemAsUsed(it.id);
    }
    if (images.length === 0) {
      toast({
        variant: "destructive",
        title: t("library.toast.addToTargetFailed", { target: t("library.toast.target.agent") }),
        description: t("library.toast.agentNoEligible"),
      });
      return;
    }
    appendAgentChatImages(project.projectId, images);
    refreshUsageLocations();
    toast({
      title: t("library.toast.addedTo", { target: t("library.toast.target.agent") }),
      description: t("library.toast.addedToChatBulkDesc", { n: images.length, max: CHAT_IMAGE_MAX }),
      action: goToProjectToastAction(project.projectId, "agent"),
    });
  }, [toast, t, markItemAsUsed, refreshUsageLocations, uiLanguage, goToProjectToastAction]);

  const handleAddToAgent = useCallback((item: ReferenceItem) => {
    // 다중 선택이면 선택 전체를(최대 4장), 단건이면 단건 — 항상 picker 먼저.
    const snapshot = selectionSnapshotRef.current;
    if (snapshot.size > 1) {
      const candidates = items.filter((it) => snapshot.has(it.id) && !it.deleted_at);
      if (candidates.length === 0) return;
      setProjectPicker({ kind: "bulk", items: candidates, target: "agent" });
      return;
    }
    handleAddToProjectTarget(item, "agent");
  }, [items, handleAddToProjectTarget]);

  /** 다중 자료를 한 번에 Conti(Compare > 라이브러리 풀) 로 attach.
   *
   *  `sendItemsToBrief` 와 정책·UX 동일 — 진행 토스트 1개를 매 자료마다
   *  `update()` 로 갱신하고 마지막에 최종 요약으로 swap. 다만 후속 처리는
   *  base64 brief refItem 대신 `makeCompareLibraryEntry` (정적 poster
   *  data URL 인라인) + `appendCompareLibraryEntries`. 자세한 cross-workspace
   *  스냅샷 정책은 `compareLibraryStore.ts` 헤더 참고.
   *
   *  호출처:
   *    - returnProjectId 기반 진입: `handleAddToConti` 가 activeProjectChip
   *      을 직접 넘긴다.
   *    - picker 기반 진입: `handlePickProject` 가 picker 에서 선택된
   *      RecentProject 를 넘긴다 (라이브러리 직접 진입 + multi-select 흐름). */
  const sendItemsToConti = useCallback(async (
    candidates: ReferenceItem[],
    project: { projectId: string; title: string },
  ) => {
    if (candidates.length === 0) return;
    const projectId = project.projectId;
    const projectTitle = project.title;

    let ok = 0;
    let dup = 0;
    let fail = 0;
    let firstError: string | undefined;
    const newEntries: Awaited<ReturnType<typeof makeCompareLibraryEntry>>[] = [];

    const progress = toast({
      title: t("library.toast.bulkAttachToContiInProgress", { name: projectTitle }),
      description: t("library.toast.bulkAttachProgressDesc", {
        i: 0,
        n: candidates.length,
        title: candidates[0]?.title ?? "",
      }),
    });

    for (let idx = 0; idx < candidates.length; idx++) {
      const item = candidates[idx];
      progress.update({
        id: progress.id,
        title: t("library.toast.bulkAttachToContiInProgress", { name: projectTitle }),
        description: t("library.toast.bulkAttachProgressDesc", {
          i: idx + 1,
          n: candidates.length,
          title: item.title,
        }),
      });
      try {
        const result = await attachLibraryItemToProject(item, projectId, "conti-inpaint");
        if (!result.ok) {
          fail++;
          firstError = firstError ?? result.errorMessage ?? result.errorCode;
          continue;
        }
        // performAttachToProject 의 conti-inpaint 후속 처리와 동일 — 정적
        // poster 를 base64 인라인한 스냅샷 entry 를 만들어 둔다. append 는
        // 루프 밖에서 한 번에 (중간 LS write race 방지 + dedup 한꺼번에).
        const entry = await makeCompareLibraryEntry(item);
        newEntries.push(entry);
        // "최근 사용" 사이드바 필터 즉시 반영. 실제 dedup 결과는 append
        // 직후 보정 — 일단 낙관적으로 ok 카운트 / last_used 갱신.
        markItemAsUsed(item.id);
        ok++;
      } catch (err) {
        fail++;
        firstError = firstError ?? (err instanceof Error ? err.message : String(err));
      }
    }

    // 모은 entries 를 한 번에 append. dedup 은 store 가 알아서.
    if (newEntries.length > 0) {
      const appendResult = appendCompareLibraryEntries(projectId, newEntries);
      // 위에서 일괄 ok++ 했으므로, dedup 으로 빠진 개수만큼 ok→dup 로 재배정.
      const dedupedFromOk = appendResult.duplicate.length;
      if (dedupedFromOk > 0) {
        ok -= dedupedFromOk;
        dup += dedupedFromOk;
      }
      if (appendResult.added.length > 0) {
        // 같은 탭의 ContiStudio 가 마운트돼 있을 수 있으니 custom 이벤트로
        // refresh 트리거 (단건 흐름과 동일 정책).
        try {
          window.dispatchEvent(
            new CustomEvent("preflow:compare-library-changed", { detail: { projectId } }),
          );
        } catch {
          /* CustomEvent 미지원 환경 — 무시 */
        }
        // Conti LS 가 N건 추가됐으니 인스펙터 "사용 위치"/카드 배지를
        // 한 번에 따라잡게 한다. 자료당 호출하면 동기 enumeration 비용이
        // N배 들어 idle 밖에서 점프함 — append 한 번 후 마지막에 한 번만.
        refreshUsageLocations();
        recordLastSentTarget(projectId, "conti", projectTitle);
      }
    }

    // 최종 요약 — 진행 토스트 id 위에 덮어쓴다. variant 도 같이 갱신.
    if (fail === 0 && dup === 0) {
      progress.update({
        id: progress.id,
        action: goToProjectToastAction(project.projectId, "conti-inpaint"),
        title: t("library.toast.bulkAttachedToConti", { n: ok, name: projectTitle }),
        description: undefined,
      });
    } else if (fail === 0 && ok > 0) {
      progress.update({
        id: progress.id,
        action: goToProjectToastAction(project.projectId, "conti-inpaint"),
        title: t("library.toast.bulkAttachedToContiWithDup", { ok, dup, name: projectTitle }),
        description: undefined,
      });
    } else if (ok === 0 && dup === 0) {
      progress.update({
        id: progress.id,
        variant: "destructive",
        title: t("library.toast.bulkAttachToContiFailed"),
        description: firstError ?? "",
      });
    } else if (ok === 0 && dup > 0 && fail === 0) {
      // 전부 중복이었던 케이스 — 단건 alreadyInCompareLibrary 와 동일 톤.
      progress.update({
        id: progress.id,
        title: t("library.toast.alreadyInCompareLibrary"),
        description: t("library.toast.alreadyInCompareLibraryDesc", { n: candidates[0]?.title ?? "" }),
      });
    } else {
      progress.update({
        id: progress.id,
        title: t("library.toast.bulkAttachPartialWithDup", { ok, dup, fail }),
        description: firstError ?? "",
      });
    }
  }, [toast, t, markItemAsUsed, refreshUsageLocations, recordLastSentTarget, goToProjectToastAction]);

  /** 우클릭 메뉴의 "Conti 에 추가" 진입점.
   *
   *  `handleAddToBrief` 와 동일 정책 — 4-case 분기 (selection × project context).
   *  selection 2개 이상 + project context 없음 → bulk picker. */
  const handleAddToConti = useCallback((item: ReferenceItem) => {
    const snapshot = selectionSnapshotRef.current;
    if (snapshot.size > 1) {
      const candidates = items.filter((it) => snapshot.has(it.id) && !it.deleted_at);
      if (candidates.length === 0) return;
      setProjectPicker({ kind: "bulk", items: candidates, target: "conti-inpaint" });
      return;
    }
    // 단건 — 항상 picker. (Phase 1 default = conti-inpaint: image 교체 X, 추가만)
    handleAddToProjectTarget(item, "conti-inpaint");
  }, [items, handleAddToProjectTarget]);

  /** Picker 에서 프로젝트 선택 시 실제 attach 실행.
   *
   *  - single 모드: 기존대로 `performAttachToProject` 로 단건 처리.
   *  - bulk 모드: target 에 따라 `sendItemsToBrief` / `sendItemsToConti` 로
   *    일괄 처리. picker 에서 받은 RecentProject 의 title 을 progress/요약
   *    토스트의 `{name}` 자리에 그대로 사용한다.
   *
   *  주의: picker 가 닫히는 *시점* 은 dialog 의 onPick → onOpenChange(false)
   *  순서로 ProjectPickerDialog 내부에서 자체 처리되므로 여기서 추가로
   *  setProjectPicker(null) 호출만 하면 된다. (bulk attach 가 await 로
   *  N 자료를 도는 동안 dialog 가 닫혀 있는 게 자연스러움 — toast 가
   *  progress 를 책임짐.) */
  const handlePickProject = useCallback(
    async (project: { projectId: string; title: string }) => {
      if (!projectPicker) return;
      const pending = projectPicker;
      setProjectPicker(null);
      if (pending.kind === "single") {
        if (pending.target === "promote") {
          // 프로젝트 선택 완료 → 승격 다이얼로그 오픈(에셋은 단건만).
          setPromoteTarget(pending.item);
          setPromoteProjectId(project.projectId);
          return;
        }
        await performAttachToProject(pending.item, project.projectId, pending.target);
        return;
      }
      // bulk — target 별 분기.
      if (pending.target === "brief") {
        await sendItemsToBrief(pending.items, project);
        return;
      }
      if (pending.target === "conti-inpaint") {
        await sendItemsToConti(pending.items, project);
        return;
      }
      if (pending.target === "agent") {
        await sendItemsToAgent(pending.items, project);
        return;
      }
    },
    [projectPicker, performAttachToProject, sendItemsToBrief, sendItemsToConti, sendItemsToAgent],
  );

  const handleOpenPromoteDialog = useCallback((item: ReferenceItem) => {
    // 정지 이미지(image/webp)는 원본, 그 외(gif/video/link/youtube)는 썸네일을
    // 에셋 사진으로 쓴다. 둘 다 없으면 승격 불가.
    const isStillImage = item.kind === "image" || item.kind === "webp";
    const hasUsableImage = isStillImage || Boolean(item.thumbnail_url);
    if (!hasUsableImage || !(item.thumbnail_url || item.file_url)) {
      toast({ variant: "destructive", title: t("library.toast.cannotPromote"), description: t("library.toast.promoteOnlyImages") });
      return;
    }
    // 어느 경로로 들어왔든 항상 프로젝트 picker 후 승격 다이얼로그 오픈.
    setProjectPicker({ kind: "single", item, target: "promote" });
  }, [toast, t]);

  /** 프로젝트가 속한 워크스페이스 ID 추정 — returnProjectId 경로면 URL ?ws=
   *  (activeProjectChip)를, picker 경로면 recent cache 를 본다. 다이얼로그의
   *  cross-workspace 판단과 handlePromoteCompleted 의 전환 판단이 *동일 소스* 를
   *  쓰도록 한 군데로 모은다. */
  const resolveProjectWorkspaceId = useCallback(
    (pid: string | null): string | null => {
      if (!pid) return null;
      if (activeProjectChip?.projectId === pid && activeProjectChip.workspaceId) {
        return activeProjectChip.workspaceId;
      }
      return getRecentProjects(200).find((p) => p.projectId === pid)?.workspaceId ?? null;
    },
    [activeProjectChip],
  );

  const handlePromoteCompleted = useCallback((result: { assetId: string; reference: ReferenceItem; assetType: "character" | "item" | "background" }) => {
    // promote 가 reference.last_used_at 을 직접 갱신하진 않으므로 "최근 사용"
    // 사이드바 필터에 반영되려면 promote 성공 시점에 in-memory 만이라도 찍어
    // 준다. (브리프 attach 와 동일한 정책.)
    const now = new Date().toISOString();
    replaceItem({ ...result.reference, last_used_at: now });
    toast({
      title: t("library.toast.assetCreated"),
      description: t("library.toast.assetCreatedDesc", { title: result.reference.title }),
    });
    // 승격 직후 대상 프로젝트의 Assets 탭으로 다이렉트 이동. 워크스페이스가
    // 다르면 전환 후 복귀(handleGoToLastSentTarget 와 동일 메커니즘). cross-
    // workspace 의 경우 에셋 row 는 LS 큐에 적재돼 있고, 전환 후 AssetsTab 이
    // mount 시 drain 해 그 DB 에 insert 한다.
    const targetProjectId = promoteProjectId;
    if (!targetProjectId) return;
    // 인스펙터 "사용 위치"/"생성됨"/타입 뱃지에 에셋 연결을 표시하기 위한 LS 기록
    // (cross-workspace 안전). assetId + assetType 까지 기록해 삭제 시 정확히 그
    // 항목만 끊고, '에셋(캐릭터)' 등 타입 뱃지를 그릴 수 있게 한다.
    recordPromotedRefUsage(targetProjectId, result.reference.id, result.assetId, result.assetType);
    const workspaceId = resolveProjectWorkspaceId(targetProjectId);
    const wsQuery = workspaceId ? `&ws=${encodeURIComponent(workspaceId)}` : "";
    // 승격한 타입의 하위 탭(캐릭터/아이템/배경)으로 바로 열리도록 URL 에 실어 보낸다.
    const typeQuery = `&assetType=${encodeURIComponent(result.assetType)}`;
    const returnTo = `/project/${encodeURIComponent(targetProjectId)}?tab=assets${typeQuery}${wsQuery}`;
    try {
      sessionStorage.setItem("preflow.return.sourceTab", "assets");
    } catch {
      /* private mode */
    }
    const currentWsId = getCachedActiveId();
    if (workspaceId && workspaceId !== currentWsId) {
      activateWorkspace(workspaceId, false, `/#${returnTo}`).catch((err) => {
        console.error("[library] promote → assets workspace switch failed:", err);
        navigate(returnTo);
      });
      return;
    }
    navigate(returnTo);
  }, [replaceItem, toast, t, promoteProjectId, navigate, resolveProjectWorkspaceId]);

  // 커스텀 썸네일 핸들러는 이 키보드 useEffect 보다 *아래* 에 정의돼 deps 에 직접
  // 넣으면 TDZ 가 난다. 최신 참조를 ref 로 들고 키 핸들러에서 ref.current 로 읽는다.
  const lateShortcutRef = useRef<{
    setCoverFile: ((item: ReferenceItem) => void) | null;
    setCoverClipboard: ((item: ReferenceItem) => void | Promise<void>) | null;
  }>({ setCoverFile: null, setCoverClipboard: null });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      // 백틱(`) — Immersive(몰입) 모드 토글. canvas 또는 preview 컨텍스트에서만
      // 의미가 있으므로 그 외에선 무시(텍스트 입력에 영향 없음 — 위쪽 가드).
      // event.code === "Backquote" 는 키 자체를 보고 IME / shift 영향 회피.
      if (event.code === "Backquote" && (viewMode === "canvas" || previewMode)) {
        event.preventDefault();
        setImmersiveCanvas((v) => !v);
        return;
      }
      if (event.key === "Escape" && previewMode) {
        // Preview 가 가장 최근에 연 화면이므로 먼저 닫고, immersive 는 유지.
        // 다음 Esc 가 캔버스 viewport 로 흘러가면 LibraryCanvas 의
        // cancelOrDeselect 가 drag/selection 을 unwind 한 뒤 immersive 까지
        // 단계별로 끈다. 이렇게 두면 "preview 진입 시에도 immersive 유지"
        // 라는 사용자 의도를 그대로 따른다.
        event.preventDefault();
        setPreviewMode(false);
        return;
      }
      if (event.key === "Escape" && immersiveCanvas) {
        // canvas viewport 가 focus 일 때는 LibraryCanvas 의 cancelOrDeselect 가
        // stopPropagation 으로 먼저 처리하므로 이 분기엔 잘 도달하지 않는다.
        // preview 가 닫혀 있고 다른 컨테이너 focus 일 때의 안전망.
        event.preventDefault();
        setImmersiveCanvas(false);
        return;
      }
      /* Ctrl/Cmd+Z — *가장 최근 undoBar* 가 살아 있으면 그 액션을 즉시 발동.
         그리드와 캔버스 양쪽에서 동일하게 동작하도록 글로벌 핸들러에 둔다.
         LibraryCanvas viewport 의 키 핸들러도 같은 ref 를 소비하므로(아래
         tryRunLatestUndo prop 으로 전달) canvas focus 상태에서도 *동일한
         pending undoBar* 가 먼저 가로채고, 없으면 canvas layout undo 로 폴백.
         Shift 조합(redo)은 별도 — undoBar 는 redo 개념이 없으므로 캔버스의
         layout redo 가 그대로 처리. */
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "z") {
        if (tryRunLatestUndo()) {
          event.preventDefault();
          return;
        }
      }
      // Ctrl/Cmd + 1/2/3 — 뷰 전환(그리드 / 리스트 / 캔버스). 선택 여부와 무관.
      // 캔버스는 폴더 컨텍스트에서만 의미가 있어 그 경우에만 전환한다.
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
        if (event.key === "1") {
          event.preventDefault();
          setViewMode("grid");
          return;
        }
        if (event.key === "2") {
          event.preventDefault();
          setViewMode("list");
          return;
        }
        if (event.key === "3" && canvasAllowed) {
          event.preventDefault();
          setViewMode("canvas");
          return;
        }
      }
      // 숫자키 0~5 — 선택한 자료(다중 포함)에 별점 즉시 적용. 0 은 별점 해제
      // (디폴트로 복귀). 우측 숫자패드(Numpad0~5) 와 상단 숫자열(Digit0~5) 둘 다
      // 허용 — 맥북처럼 숫자패드가 없는 키보드도 상단 숫자키로 매길 수 있다.
      // event.code 는 레이아웃 독립(물리 키 기준)이라 한/영·각국 배열에서도 안전.
      // 수정자 키가 눌려 있으면 무시(Ctrl+1/2/3 뷰 전환 등과 충돌 방지).
      const ratingKey = /^(?:Numpad|Digit)([0-5])$/.exec(event.code);
      if (
        ratingKey
        && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
      ) {
        if (selectedItems.length > 0 || selected) {
          event.preventDefault();
          const n = Number(ratingKey[1]);
          void handleSetRatingForSelected(n === 0 ? null : n);
          return;
        }
      }
      // 우클릭 메뉴 액션 단축키 — 알파벳 단독 대신 수정자 조합(Eagle 스타일).
      // 선택 항목이 있을 때만. 매핑 안 된 키는 아래 Enter/Delete/화살표 체인으로.
      if (selected) {
        // H(수정자 없음) — 그리드 숨김 토글(선택 전체). 캔버스는 자체 H
        // 핸들러(숨김/모두표시)가 있어 여기선 제외. 그리드/리스트 뷰 전용.
        if (
          viewMode !== "canvas"
          && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
          && event.key.toLowerCase() === "h"
        ) {
          event.preventDefault();
          toggleGridHiddenForSelection();
          return;
        }
        // Alt + 문자 (좌측 Alt 전용 — AltGr 은 ctrlKey 가 함께 켜져 자동 제외).
        if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
          const k = event.key.toLowerCase();
          const altAction: ((item: ReferenceItem) => void | Promise<void>) | undefined = {
            p: handleTogglePin,
            v: handleCreateVariation,
            s: handleSearchByImage,
            b: handleAddToBrief,
            a: handleAddToAgent,
            c: handleAddToConti,
            t: handleCopyTags,
            r: handleClassifyReference,
            g: handleRegenerateThumbnail,
            m: handleMergeDuplicates,
            e: handleOpenPromoteDialog,
          }[k];
          if (altAction) {
            event.preventDefault();
            /* 단축키도 우클릭과 동일하게 "지금 선택 전체" 를 snapshot 으로 박아,
               selection-aware 핸들러(분류/병합/Brief 등)가 다중 선택을 일괄
               처리하게 한다. 발화 직전 캡처라 메뉴-상호작용 narrowing 과 무관.
               selectedIdsRef 는 동기 미러라 항상 최신. */
            selectionSnapshotRef.current =
              selectedIdsRef.current.size > 0 ? new Set(selectedIdsRef.current) : new Set([selected.id]);
            void altAction(selected);
            return;
          }
          if (k === "u" && lateShortcutRef.current.setCoverFile) {
            event.preventDefault();
            lateShortcutRef.current.setCoverFile(selected);
            return;
          }
        }
        // Ctrl(Cmd)+Alt + 문자 — 보조 액션(경로 복사 / 태그 붙여넣기 / 클립보드 커버).
        if ((event.ctrlKey || event.metaKey) && event.altKey && !event.shiftKey) {
          const k = event.key.toLowerCase();
          if (k === "c") {
            event.preventDefault();
            void handleCopyFilePath(selected);
            return;
          }
          if (k === "t") {
            event.preventDefault();
            void handlePasteTags(selected);
            return;
          }
          if (k === "u" && lateShortcutRef.current.setCoverClipboard) {
            event.preventDefault();
            void lateShortcutRef.current.setCoverClipboard(selected);
            return;
          }
        }
        // Shift+Enter — 기본 앱으로 열기 / Ctrl(Cmd)+Enter — 파일 위치 열기.
        if (event.key === "Enter" && !event.altKey) {
          if (event.shiftKey && !event.ctrlKey && !event.metaKey) {
            event.preventDefault();
            void handleOpenDefault(selected);
            return;
          }
          if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
            event.preventDefault();
            void handleShowInFolder(selected);
            return;
          }
        }
      }
      if (event.key === "Enter" && selected) {
        event.preventDefault();
        setPreviewMode(true);
      } else if (event.key === "Delete" && selected) {
        event.preventDefault();
        const targets = selectedItems.length > 1 ? selectedItems : [selected];
        if (targets.every((item) => item.deleted_at)) {
          setPermanentDeleteTargets(targets);
        } else {
          void handleDeleteSelected();
        }
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d" && selected) {
        event.preventDefault();
        void handleDuplicateReference(selected);
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && selected) {
        /* Eagle 식 copy — 단일 이미지면 비트맵을, 그 외엔 파일 경로 텍스트를
           OS 클립보드에 올린다. Ctrl/Cmd+C 는 OS 가 가로채는 단축키가
           아니므로 별도 사용자 제스처 없이 동작. input/textarea 위에서는
           위쪽 가드(target?.closest) 가 이미 막아 텍스트 편집을 방해하지
           않는다. */
        event.preventDefault();
        /* 우클릭과 동일하게 발화 직전 live selection 을 snapshot 에 박아
           "복사 N개" 가 단건으로 떨어지지 않게 한다. */
        selectionSnapshotRef.current =
          selectedIdsRef.current.size > 0 ? new Set(selectedIdsRef.current) : new Set([selected.id]);
        void handleCopySelectionToClipboard();
      } else if (event.key === "F2" && selected) {
        event.preventDefault();
        void handleRenameReference(selected);
      } else if (
        selected
        && (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown")
        // 수식키 조합 화살표는 영상 프리뷰의 시킹/배속용으로 양보 — 순수 화살표만 항목 이동.
        && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey
      ) {
        /* 화살표 내비게이션.
           - 큰 프리뷰: ←/→ 는 보기 페이지 이동(기존). ↑/↓ 은 무시(그리드를
             보고 있지 않아 행 개념이 무의미).
           - 그리드 모드:
              · ←/→ 는 filteredItems 순서로 한 칸 이동 — 사이드바 필터·검색·
                정렬이 적용된 시각 순서를 그대로 따른다.
              · ↑/↓ 은 실제 DOM bounding rect 로 위/아래 행을 찾고, 그 행의
                카드 중 가로 중심이 현재 카드와 가장 가까운 것을 고른다.
                justified-rows 라 카드 폭이 가변이라도 시각적으로 자연스러운
                칼럼 추적이 된다. List 뷰에서도 한 행에 카드 하나뿐이라
                ↑/↓ 이 그대로 prev/next 동작이 된다.
           handlePreviewSelect 가 이 useEffect 보다 아래 라인에 정의되어 있어
           deps 에 넣으면 TDZ 에러가 나므로 setter 들을 직접 호출 — React 가
           setState 들의 안정성을 보장한다. */
        const isHorizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
        if (!isHorizontal && previewMode) return;

        let target: ReferenceItem | null = null;

        if (isHorizontal) {
          const idx = filteredItems.findIndex((it) => it.id === selected.id);
          if (idx < 0) return;
          if (event.key === "ArrowLeft" && idx > 0) target = filteredItems[idx - 1];
          else if (event.key === "ArrowRight" && idx < filteredItems.length - 1) target = filteredItems[idx + 1];
        } else {
          const currentNode = document.querySelector(`[data-library-card-id="${selected.id}"]`);
          if (!(currentNode instanceof HTMLElement)) return;
          const currentRect = currentNode.getBoundingClientRect();
          const currentCenterX = currentRect.left + currentRect.width / 2;
          const isDown = event.key === "ArrowDown";
          // 같은 행 판단의 허용 오차. justified-rows 는 한 행 내 카드의
          // top 이 거의 같지만 sub-pixel 노이즈가 있어 약간의 fuzz 가 안전.
          const ROW_FUZZ = 4;
          const allNodes = Array.from(document.querySelectorAll<HTMLElement>("[data-library-card-id]"));
          type Cand = { id: string; top: number; centerX: number };
          const cands: Cand[] = [];
          for (const node of allNodes) {
            const id = node.getAttribute("data-library-card-id");
            if (!id || id === selected.id) continue;
            const rect = node.getBoundingClientRect();
            const inDirection = isDown
              ? rect.top > currentRect.top + ROW_FUZZ
              : rect.top < currentRect.top - ROW_FUZZ;
            if (!inDirection) continue;
            cands.push({ id, top: rect.top, centerX: rect.left + rect.width / 2 });
          }
          if (cands.length === 0) return;
          // 바로 인접한 행만 후보로: down 이면 가장 작은 top, up 이면 가장 큰 top.
          const targetRowTop = isDown
            ? cands.reduce((m, c) => Math.min(m, c.top), Number.POSITIVE_INFINITY)
            : cands.reduce((m, c) => Math.max(m, c.top), Number.NEGATIVE_INFINITY);
          const rowCands = cands.filter((c) => Math.abs(c.top - targetRowTop) <= ROW_FUZZ);
          let bestId: string | null = null;
          let bestDist = Number.POSITIVE_INFINITY;
          for (const c of rowCands) {
            const dist = Math.abs(c.centerX - currentCenterX);
            if (dist < bestDist) {
              bestDist = dist;
              bestId = c.id;
            }
          }
          if (bestId) target = filteredItems.find((it) => it.id === bestId) ?? null;
        }

        if (target) {
          event.preventDefault();
          const targetId = target.id;
          setSelectedIds(new Set([targetId]));
          setSelectedId(targetId);
          setLastSelectedId(targetId);
          if (!previewMode) {
            // 새로 선택된 카드를 다음 paint 에 부드럽게 화면 안으로. nearest
            // 옵션이라 이미 보이는 카드면 스크롤이 일어나지 않는다.
            requestAnimationFrame(() => {
              const node = document.querySelector(`[data-library-card-id="${targetId}"]`);
              if (node instanceof HTMLElement) {
                node.scrollIntoView({ block: "nearest", behavior: "smooth" });
              }
            });
          }
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTag, canvasAllowed, filteredItems, handleCopySelectionToClipboard, handleDeleteSelected, handleDuplicateReference, handleRenameReference, handleTogglePin, handleCreateVariation, handleAddToBrief, handleAddToAgent, handleAddToConti, handleSearchByImage, handleOpenDefault, handleShowInFolder, handleCopyFilePath, handleCopyTags, handlePasteTags, handleClassifyReference, handleRegenerateThumbnail, handleMergeDuplicates, handleOpenPromoteDialog, handleSetRatingForSelected, immersiveCanvas, previewMode, selected, selectedItems, toggleGridHiddenForSelection, tryRunLatestUndo, viewMode]);

  /* timestamp 노트 추가 — 인자가 모두 비어 있으면 인스펙터의 timestampText
     state + 현재 video.currentTime 를 사용(인스펙터의 인라인 Add 행 동작).
     다이얼로그(큰 프리뷰의 Add Note) 처럼 본문 / 시각을 명시적으로 전달
     하면 그 값을 그대로 사용해 stale state 이슈를 피한다.

     v2 — region 코멘트 / GIF 프레임 anchor 지원:
       - regionOverride: 자료 위에 드래그로 그린 영역. 영상=시점 anchored,
         GIF=프레임 anchored, 이미지=항상 표시.
       - frameIndexOverride: GIF 자료에서 노트가 가리키는 정확한 프레임 인덱스.
         GIF 의 프레임 duration 이 균등하지 않을 수 있어 atSec 보다 정밀.
     자료 종류별 anchor 우선순위:
       - video: atSec
       - gif:   frameIndex (atSec 은 무시)
       - image: 둘 다 undefined (region 만 있는 노트) */
  const handleAddTimestampNote = useCallback(
    async (
      textOverride?: string,
      atOverride?: number,
      regionOverride?: RegionRect,
      frameIndexOverride?: number,
      pageIndexOverride?: number,
    ) => {
      if (!selected) return;
      /* PDF doc 는 슬라이드 노트(pageIndex + region), PSD doc 는 이미지처럼
         영역 노트(region only) 를 지원. 그 외 doc(audio/html/문서 등) 은 노트
         개념이 없어 제외. */
      const isPdfDoc = selected.kind === "doc" && docSubtypeOf(selected) === "pdf";
      const isPsdDoc = selected.kind === "doc" && Boolean(selected.ai_suggestions?.psdPreview);
      if (
        selected.kind !== "video"
        && selected.kind !== "gif"
        && selected.kind !== "image"
        && selected.kind !== "webp"
        && !isPdfDoc
        && !isPsdDoc
      ) return;
      const rawText = textOverride !== undefined ? textOverride : timestampText;
      const text = rawText.trim();
      if (!text) return;
      // video 만 atSec 을 자동으로 video.currentTime 에서 끌어온다(인스펙터의
      // 인라인 Add 행이 그렇게 동작). GIF/이미지는 video element 가 없으므로
      // 명시적으로 인자가 들어오지 않으면 anchor 가 없는 노트가 됨.
      const rawAt = selected.kind === "video"
        ? (atOverride !== undefined ? atOverride : videoRef.current?.currentTime)
        : atOverride;
      const atSec = selected.kind === "video" && Number.isFinite(rawAt)
        ? (rawAt as number)
        : undefined;
      const frameIndex = selected.kind === "gif" && Number.isFinite(frameIndexOverride)
        ? (frameIndexOverride as number)
        : undefined;
      const pageIndex = isPdfDoc && Number.isFinite(pageIndexOverride)
        ? (pageIndexOverride as number)
        : undefined;
      const note: TimestampNote = {
        id: crypto.randomUUID().replace(/-/g, ""),
        atSec,
        frameIndex,
        pageIndex,
        text,
        region: regionOverride,
      };
      const next = await updateReference(selected.id, {
        timestamp_notes: [...selected.timestamp_notes, note],
      });
      replaceItem(next);
      if (textOverride === undefined) setTimestampText("");
    },
    [replaceItem, selected, timestampText],
  );

  /* timestamp 노트 삭제 — Inspector / 프리뷰 양쪽의 노트 행에 달린 X 버튼
     으로 호출. 단순히 해당 id 만 빼서 저장 후 그리드 상태에 반영. */
  const handleDeleteTimestampNote = useCallback(
    async (noteId: string) => {
      if (!selected) return;
      const next = await updateReference(selected.id, {
        timestamp_notes: selected.timestamp_notes.filter((note) => note.id !== noteId),
      });
      replaceItem(next);
    },
    [replaceItem, selected],
  );

  /* timestamp 노트 본문 수정 — Inspector 의 노트 행 텍스트를 클릭해 진입
     하는 인라인 편집기에서 호출. atSec / id 는 그대로, text 만 갱신. */
  const handleEditTimestampNote = useCallback(
    async (noteId: string, nextText: string) => {
      if (!selected) return;
      const trimmed = nextText.trim();
      if (!trimmed) {
        await handleDeleteTimestampNote(noteId);
        return;
      }
      const next = await updateReference(selected.id, {
        timestamp_notes: selected.timestamp_notes.map((note) =>
          note.id === noteId ? { ...note, text: trimmed } : note,
        ),
      });
      replaceItem(next);
    },
    [handleDeleteTimestampNote, replaceItem, selected],
  );

  const handleSetCover = useCallback(async () => {
    if (!selected || !videoRef.current) return;
    setSaving(true);
    try {
      const next = await setReferenceCoverFromVideo(selected, videoRef.current);
      replaceItem(next);
      toast({ title: t("library.toast.coverUpdated"), description: t("library.toast.coverFromVideoFrame") });
    } catch (err) {
      toast({ variant: "destructive", title: t("library.toast.coverFailed"), description: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  }, [replaceItem, selected, toast, t]);

  /* Eagle 식 "Custom thumbnail (Select file)" — 카드 우클릭 컨텍스트 메뉴에서
     호출. 숨겨진 <input type="file"> 를 클릭해 OS 파일 다이얼로그를 띄우고,
     어떤 항목의 cover 인지는 pendingCoverItemRef 에 저장해 두었다가 input
     change 핸들러가 읽어 적용한다. trash 상태인 항목은 호출 자체를 차단. */
  const handleSetCoverFromFile = useCallback((item: ReferenceItem) => {
    if (!item || item.deleted_at) return;
    pendingCoverItemRef.current = item;
    coverFileInputRef.current?.click();
  }, []);

  const handleCoverFileSelected = useCallback(
    async (file: File | null) => {
      const item = pendingCoverItemRef.current;
      pendingCoverItemRef.current = null;
      if (!file || !item) return;
      if (!file.type.startsWith("image/")) {
        toast({
          variant: "destructive",
          title: t("library.toast.thumbnailFailed"),
          description: t("library.toast.pickImageFile"),
        });
        return;
      }
      setSaving(true);
      try {
        const next = await setReferenceCoverFromBlob(item, file);
        replaceItem(next);
        toast({ title: t("library.toast.thumbnailUpdated"), description: t("library.toast.coverSetFromFile", { name: file.name }) });
      } catch (err) {
        toast({
          variant: "destructive",
          title: t("library.toast.thumbnailFailed"),
          description: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setSaving(false);
      }
    },
    [replaceItem, toast, t],
  );

  /* Eagle 식 "Custom thumbnail (From clipboard)" — 현재 OS 클립보드에서 첫
     image/* 항목을 꺼내 cover 로 박는다. 두 경로를 순서대로 시도:
       1) Electron 네이티브 `clipboard.readImage()` (preload IPC) — 컨텍스트
          메뉴 클릭 직후의 포커스/권한 이슈가 없다. PNG 바이트로 반환.
       2) `navigator.clipboard.read()` 폴백 — 웹 빌드 / preload 미노출 환경.
     둘 다 비면 "No image in clipboard." 토스트. */
  const handleSetCoverFromClipboard = useCallback(async (item: ReferenceItem) => {
    if (!item || item.deleted_at) return;
    setSaving(true);
    try {
      let imageBlob: Blob | null = null;

      const readNative = window.preflowWindow?.readClipboardImage;
      if (readNative) {
        const bytes = await readNative().catch(() => null);
        if (bytes && bytes.byteLength > 0) {
          imageBlob = new Blob([bytes], { type: "image/png" });
        }
      }

      if (!imageBlob && navigator.clipboard?.read) {
        try {
          const clipboardItems = await navigator.clipboard.read();
          for (const clipItem of clipboardItems) {
            const imageType = clipItem.types.find((t) => t.startsWith("image/"));
            if (imageType) {
              imageBlob = await clipItem.getType(imageType);
              break;
            }
          }
        } catch {
          /* 권한/포커스 거부 — native 경로가 비었으면 아래에서 안내 */
        }
      }

      if (!imageBlob) {
        throw new Error(t("library.toast.noImageInClipboard"));
      }
      const next = await setReferenceCoverFromBlob(item, imageBlob);
      replaceItem(next);
      toast({ title: t("library.toast.thumbnailUpdated"), description: t("library.toast.coverFromClipboard") });
    } catch (err) {
      toast({
        variant: "destructive",
        title: t("library.toast.thumbnailFailed"),
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  }, [replaceItem, toast, t]);

  // 키보드 단축키(Alt+U / Ctrl+Alt+U)가 ref 로 최신 커스텀 썸네일 핸들러를 읽게 한다
  // (이 핸들러들이 키보드 useEffect 보다 아래에 정의돼 deps 직접 참조가 불가).
  useEffect(() => {
    lateShortcutRef.current = {
      setCoverFile: handleSetCoverFromFile,
      setCoverClipboard: handleSetCoverFromClipboard,
    };
  }, [handleSetCoverFromFile, handleSetCoverFromClipboard]);

  const handleSaveFrame = useCallback(async () => {
    if (!selected || !videoRef.current) return;
    setSaving(true);
    try {
      const frame = await saveVideoFrameAsReference(selected, videoRef.current);
      upsertUploadedItem(frame);
      toast({ title: t("library.toast.frameSaved"), description: t("library.toast.frameSavedDescVideo") });
    } catch (err) {
      toast({ variant: "destructive", title: t("library.toast.frameSaveFailed"), description: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  }, [selected, toast, upsertUploadedItem, t]);

  /* 정지 이미지 크롭 저장 — LibraryPreviewPanel 의 8핸들 오버레이가 확정한
     정규화 rect 를 받아, 원본을 실제 픽셀로 잘라 저장한다.
       - "new": 원본을 두고 새 reference 로 (같은 폴더 상속)
       - "overwrite": 원본 reference 의 이미지를 교체 (파괴적)
     handleSaveFrame 과 동일한 책임 분리 — UI(panel)는 영역만, 저장/toast 는 부모. */
  const handleCropImage = useCallback(
    async (rect: RegionRect, mode: "new" | "overwrite") => {
      if (!selected) return;
      /* PSD 는 file_url 이 .psd(브라우저 디코드 불가)라 풀해상도 프리뷰
         WebP(ai_suggestions.psdPreview)를 크롭 소스로 쓴다. 또한 원본을
         크롭 PNG 로 덮어쓸 수 없으므로 항상 새 이름으로만 저장한다. */
      const psdPreview =
        selected.kind === "doc"
          ? ((selected.ai_suggestions?.psdPreview as string | undefined) ?? null)
          : null;
      const effectiveMode: "new" | "overwrite" = psdPreview ? "new" : mode;
      const src = psdPreview || selected.file_url || selected.thumbnail_url;
      if (!src) return;
      setSaving(true);
      try {
        const img = await loadHtmlImage(src);
        const nw = img.naturalWidth;
        const nh = img.naturalHeight;
        const sx = Math.max(0, Math.round(rect.x * nw));
        const sy = Math.max(0, Math.round(rect.y * nh));
        const sw = Math.max(1, Math.min(nw - sx, Math.round(rect.w * nw)));
        const sh = Math.max(1, Math.min(nh - sy, Math.round(rect.h * nh)));
        const canvas = document.createElement("canvas");
        canvas.width = sw;
        canvas.height = sh;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Failed to create crop canvas.");
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
        if (!blob) throw new Error("Failed to encode cropped image.");
        const saved = effectiveMode === "overwrite"
          ? await overwriteReferenceImage(selected, blob, sw, sh)
          : await saveCroppedImageAsNewReference(selected, blob, sw, sh);
        upsertUploadedItem(saved);
        toast({
          title: t("library.toast.cropSaved"),
          description: mode === "overwrite"
            ? t("library.toast.cropOverwritten")
            : t("library.toast.cropSavedNew"),
        });
      } catch (err) {
        toast({
          variant: "destructive",
          title: t("library.toast.cropFailed"),
          description: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setSaving(false);
      }
    },
    [selected, toast, upsertUploadedItem, t],
  );

  /* 영상 loop 구간을 GIF / WebP 애니메이션으로 변환해 새 ReferenceItem 으로 저장.
     LibraryPreviewPanel 의 SaveLoopAsGifDialog 가 인코딩까지 마치고 Blob 을
     이쪽으로 넘기면 (Blob → File → uploadReferenceFile → upsert + toast).
     handleSaveFrame 의 책임 분리와 동일한 패턴. 제목 형식은 i18n 의
     library.gifTitleSuffix 를 따라 "원본 (loop 0:01–0:03)". tags 에 자동
     "from-video" 를 붙여 라이브러리에서 필터 가능. format 에 따라 확장자/MIME
     를 분기 — Dialog 가 options.format 을 두 번째 인자로 넘긴다. */
  const handleSaveLoopAsGif = useCallback(
    async (
      blob: Blob,
      options: GifExportOptions,
      startSec: number,
      endSec: number,
    ) => {
      if (!selected) return;
      const formatStamp = (sec: number) => {
        const total = Math.max(0, Math.floor(sec));
        const mm = Math.floor(total / 60).toString().padStart(2, "0");
        const ss = (total % 60).toString().padStart(2, "0");
        return `${mm}:${ss}`;
      };
      /* blob 의 MIME 으로 더블 체크 — 가끔 인코더가 잘못된 type 으로 wrap
         했을 가능성 대비. options.format 이 정답이지만 safety net 으로 둔다. */
      const isWebp =
        options.format === "webp" ||
        (typeof blob.type === "string" && blob.type.includes("webp"));
      const ext = isWebp ? "webp" : "gif";
      const mime = isWebp ? "image/webp" : "image/gif";
      const formatLabel = isWebp ? "WebP" : "GIF";

      const suffix = t("library.gifTitleSuffix", {
        start: formatStamp(startSec),
        end: formatStamp(endSec),
      });
      const baseTitle = (selected.title || "Untitled").trim();
      const title = `${baseTitle} ${suffix}`;
      /* 파일명은 ASCII 우선 — 일부 OS 에서 한글/이모지 포함 파일명이 zip
         export 시 깨지는 사례가 있어 안전한 영문 슬러그를 만들고 확장자만
         포맷에 맞게 분기한다. */
      const slug = baseTitle
        .replace(/[^A-Za-z0-9._-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 80) || "reference";
      const file = new File([blob], `${slug}-loop.${ext}`, { type: mime });
      try {
        const next = await uploadReferenceFile(file, {
          ...uploadOptions,
          title,
          tags: Array.from(new Set([...(uploadOptions.tags ?? []), "from-video"])),
          sourceUrl: selected.source_url ?? undefined,
        });
        upsertUploadedItem(next);
        toast({
          title: t("library.gifSaved", { format: formatLabel }),
          description: t("library.gifSavedDescription", {
            title: baseTitle,
            start: formatStamp(startSec),
            end: formatStamp(endSec),
          }),
        });
      } catch (err) {
        toast({
          variant: "destructive",
          title: t("library.gifFailed"),
          description: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
    [selected, t, toast, uploadOptions, upsertUploadedItem],
  );

  /* GIF (또는 임의의 캔버스 기반 자료) 프레임을 cover/새 reference 로 저장.
     영상의 handleSetCover/handleSaveFrame 와 동일한 정책이지만 input 이
     <video> 가 아니라 임의의 <canvas> 라는 점만 다르다. GifFramePlayer 의
     Set Cover/Save Frame 아이콘이 자신의 canvas 를 인자로 호출. */
  const handleSetCoverFromCanvas = useCallback(
    async (canvas: HTMLCanvasElement, atSec: number | null = null) => {
      if (!selected) return;
      setSaving(true);
      try {
        const next = await setReferenceCoverFromCanvas(selected, canvas, atSec);
        replaceItem(next);
        toast({ title: t("library.toast.coverUpdated"), description: t("library.toast.coverFromCurrentFrame") });
      } catch (err) {
        toast({ variant: "destructive", title: t("library.toast.coverFailed"), description: err instanceof Error ? err.message : String(err) });
      } finally {
        setSaving(false);
      }
    },
    [replaceItem, selected, toast, t],
  );

  const handleSaveFrameFromCanvas = useCallback(
    async (canvas: HTMLCanvasElement, atSec: number = 0) => {
      if (!selected) return;
      setSaving(true);
      try {
        const frame = await saveCanvasFrameAsReference(selected, canvas, atSec);
        upsertUploadedItem(frame);
        toast({ title: t("library.toast.frameSaved"), description: t("library.toast.frameSavedDesc") });
      } catch (err) {
        toast({ variant: "destructive", title: t("library.toast.frameSaveFailed"), description: err instanceof Error ? err.message : String(err) });
      } finally {
        setSaving(false);
      }
    },
    [selected, toast, upsertUploadedItem, t],
  );

  const handleSelectEagle = useCallback(async () => {
    setEagleBusy(true);
    setEagleResult(null);
    try {
      const result = await selectEagleLibrary();
      if (!result.canceled && result.rootPath && result.preview) {
        setEagleRoot(result.rootPath);
        setEaglePreview(result.preview);
      }
    } catch (err) {
      toast({ variant: "destructive", title: t("library.toast.eaglePreviewFailed"), description: err instanceof Error ? err.message : String(err) });
    } finally {
      setEagleBusy(false);
    }
  }, [toast, t]);

  const handleImportEagle = useCallback(async () => {
    if (!eagleRoot) return;
    setEagleBusy(true);
    setEagleResult(null);
    try {
      const result = await importEagleLibrary(eagleRoot);
      setEagleResult(result);
      toast({ title: t("library.toast.eagleImportComplete"), description: t("library.toast.eagleImportDesc", { added: result.imported, skipped: result.skipped }) });
      loadReferences();
    } catch (err) {
      toast({ variant: "destructive", title: t("library.toast.eagleImportFailed"), description: err instanceof Error ? err.message : String(err) });
    } finally {
      setEagleBusy(false);
    }
  }, [eagleRoot, loadReferences, toast, t]);

  const handleChooseFolder = useCallback(async () => {
    setEagleBusy(true);
    try {
      const picked = await pickLibraryFolder();
      if (picked.canceled || !picked.rootPath) return;
      await ingestScannedFolder(picked);
    } catch (err) {
      toast({
        variant: "destructive",
        title: t("library.toast.folderImportFailedTitle"),
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setEagleBusy(false);
    }
  }, [ingestScannedFolder, toast, t]);

  /* AI 탭의 Run AI 버튼 — 현재 선택된 자료 한 건을 큐에 넣는다.
     enqueueClassifyForItem 가 dedupe / 진행 Map 기록 / 완료 토스트까지 다
     처리하므로 여기는 위임만. */
  const handleClassifySelected = useCallback(() => {
    if (!selected) return;
    enqueueClassifyForItem(selected);
  }, [enqueueClassifyForItem, selected]);

  const handleAcceptSuggestions = useCallback(async () => {
    if (!selected) return;
    setAcceptingSuggestions(true);
    try {
      const next = await acceptReferenceAiSuggestions(selected, {
        tagLanguage: effectiveAiTagLanguageRef.current,
      });
      replaceItem(next);
      toast({ title: t("library.toast.aiSuggestionsApplied"), description: t("library.toast.aiSuggestionsAppliedDesc") });
    } catch (err) {
      toast({ variant: "destructive", title: t("library.toast.acceptFailed"), description: err instanceof Error ? err.message : String(err) });
    } finally {
      setAcceptingSuggestions(false);
    }
  }, [replaceItem, selected, t, toast]);

  const clearFilters = useCallback(() => {
    setQuery("");
    setQuickFilter("all");
    setActiveSavedFilterId(null);
    resetFolderSelection();
    setTypeFilter(emptyMulti());
    setTagsFilter(emptyMulti());
    setMoodsFilter(emptyMulti());
    setFoldersFilter(emptyMulti());
    setRatingsFilter(new Set());
    setShapesFilter(new Set());
    setNoteFilterState(EMPTY_NOTE_FILTER);
    setColorFilter(null);
    setMoodFilter(null);
  }, [resetFolderSelection]);

  const handleSelectGridItem = useCallback((id: string, event?: MouseEvent<HTMLElement>) => {
    const isContextMenu = event?.type === "contextmenu";
    if (isContextMenu) {
      // 우클릭 = *현재 selection 의 snapshot 캡처* + selection 자체는 변경 X.
      // 메뉴 항목이 클릭될 때 selectedIds state 가 어떤 이유로 비워지더라도
      // snapshot 에는 우클릭 그 순간의 selection 이 남아 있다.
      //
      // 우클릭한 카드가 selection 밖이면 *그 카드 단건* 으로 snapshot (macOS
      // Finder 식 — 선택 외 우클릭은 그 카드만 대상).
      const snapshot = selectedIds.has(id) ? new Set(selectedIds) : new Set([id]);
      selectionSnapshotRef.current = snapshot;
      setSelectedId(id);
      return;
    }
    if (event?.shiftKey && lastSelectedId) {
      const start = filteredItems.findIndex((item) => item.id === lastSelectedId);
      const end = filteredItems.findIndex((item) => item.id === id);
      if (start >= 0 && end >= 0) {
        const [from, to] = start < end ? [start, end] : [end, start];
        const range = filteredItems.slice(from, to + 1).map((item) => item.id);
        setSelectedIds(new Set(range));
        setSelectedId(id);
        return;
      }
    }
    if (event?.metaKey || event?.ctrlKey) {
      setSelectedIds((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        if (next.size === 0) {
          setSelectedId(null);
          setLastSelectedId(null);
        } else {
          setSelectedId(id);
          setLastSelectedId(id);
        }
        return next;
      });
      return;
    }
    setSelectedIds(new Set([id]));
    setSelectedId(id);
    setLastSelectedId(id);
  }, [filteredItems, lastSelectedId, selectedIds]);

  const handlePreviewSelect = useCallback((id: string) => {
    setSelectedIds(new Set([id]));
    setSelectedId(id);
    setLastSelectedId(id);
  }, []);

  const handleGridDoubleClick = useCallback((id: string) => {
    // 모든 kind 가 인앱 큰 프리뷰로 진입한다 — LibraryPreviewPanel 이 자료
    // 종류별로 분기:
    //   - image/video/gif: 기존 캔버스/플레이어
    //   - youtube: iframe 임베드
    //   - link / doc.html: <webview> 게스트 (메인의 webviewTag 가드 적용)
    //   - doc.pdf: pdfjs 캔버스 뷰어
    //   - doc.audio: native <audio controls>
    //   - 그 외 doc: 아이콘 카드 (브라우저로 인앱 렌더 어려운 자료)
    // OS 기본 브라우저 / 기본 앱으로 열기는 우클릭 컨텍스트 메뉴의 "Open in
    // Browser" / "Open With Default App" 으로 별도 노출되므로, 더블클릭은
    // 항상 인앱 프리뷰로 통일해 직관을 단순화한다.
    handlePreviewSelect(id);
    setPreviewMode(true);
  }, [handlePreviewSelect]);

  /* 인스펙터의 타임스탬프 노트 클릭 진입점. 이미 큰 프리뷰 상태면 비디오를
     바로 시크해 사용자 흐름이 끊기지 않게 하고, 아니면 pendingSeekSec 을
     세팅한 뒤 previewMode 를 켜서 메타 로드 시점에 1회 자동 시크한다.

     v3 — GIF 도 지원: frameIndex 가 들어오면 pendingFrameIndex 를 큐잉해
     GifFramePlayer 가 디코드 완료 시점에 그 프레임으로 1회 점프한다. 큰
     프리뷰가 이미 열려 있어도 GifFramePlayer 의 initialFrameIndex 갱신을
     통해 같은 경로로 점프(별도의 imperative ref 가 없어 큐잉 방식이 더 단순). */
  const handleJumpToTimestamp = useCallback((atSec?: number, frameIndex?: number, pageIndex?: number, regionNoteId?: string) => {
    // 영역 노트 하이라이트 — image/gif/video 공통. 큰 프리뷰를 켜고 해당 노트를
    // 잠깐 하이라이트한다. image/PSD 는 시점/프레임 anchor 가 없어 여기서 끝나고
    // (아래 블록들이 모두 no-op), gif/video 는 아래의 frame/time 점프까지 이어져
    // "해당 프레임/시점으로 이동 + 영역 강조" 가 함께 일어난다.
    if (regionNoteId) {
      setPendingRegionNoteId(regionNoteId);
      if (!previewMode) setPreviewMode(true);
    }
    // PDF 슬라이드 노트 — pageIndex 우선. 큰 프리뷰가 닫혀 있으면 켜고,
    // pendingPageIndex 를 세팅해 PdfViewer 의 initialPageIndex 가 갱신되어
    // 해당 페이지로 1회 이동한다(consumed 시 즉시 null 로 되돌림).
    if (Number.isFinite(pageIndex)) {
      setPendingPageIndex(pageIndex as number);
      if (!previewMode) setPreviewMode(true);
      return;
    }
    // GIF 노트 — frameIndex 우선. 큰 프리뷰가 닫혀 있으면 켜기. 켜져 있어도
    // pendingFrameIndex 를 세팅해 GifFramePlayer 의 initialFrameIndex 가 새
    // 값으로 갱신되도록 한다(consumed 시 즉시 null 로 되돌림).
    if (Number.isFinite(frameIndex)) {
      setPendingFrameIndex(frameIndex as number);
      if (!previewMode) setPreviewMode(true);
      return;
    }
    // 영상 노트 — atSec 사용.
    if (!Number.isFinite(atSec)) return;
    if (previewMode && videoRef.current) {
      videoRef.current.currentTime = atSec as number;
      /* region 노트 하이라이트 진입이면 일시정지 — 재생 중에는 region 박스가
         숨겨지므로(LibraryPreviewPanel.visibleRegionNotes) 정지해야 박스+강조가
         보인다. 시점-only 노트(regionNoteId 없음)는 재생 상태를 건드리지 않음. */
      if (regionNoteId) videoRef.current.pause();
      return;
    }
    setPendingSeekSec(atSec as number);
    setPreviewMode(true);
  }, [previewMode]);

  const handleMarqueeSelect = useCallback((ids: string[], mode: "replace" | "add") => {
    const orderedIds = filteredItems.map((item) => item.id).filter((id) => ids.includes(id));
    if (mode === "add") {
      setSelectedIds((current) => {
        const next = new Set(current);
        orderedIds.forEach((id) => next.add(id));
        const primary = orderedIds[orderedIds.length - 1] ?? selectedId;
        if (primary) {
          setSelectedId(primary);
          setLastSelectedId(primary);
        }
        return next;
      });
      return;
    }
    const next = new Set(orderedIds);
    const primary = orderedIds[orderedIds.length - 1] ?? null;
    setSelectedIds(next);
    setSelectedId(primary);
    setLastSelectedId(primary);
  }, [filteredItems, selectedId]);

  const folderCount = useCallback((tag: string): number => {
    return activeItems.filter((item) => item.tags.some((candidate) => candidate === tag || candidate.startsWith(`${tag}/`))).length;
  }, [activeItems]);

  /* 폴더(하위 포함) 내 아이템 file_size 합 — HTML single-html export 용량
   *  사전 표기에만 사용. file_size 누락은 0 으로 무시. */
  const folderSizeBytes = useCallback((tag: string): number => {
    return activeItems
      .filter((item) => item.tags.some((candidate) => candidate === tag || candidate.startsWith(`${tag}/`)))
      .reduce((acc, item) => acc + (item.file_size ?? 0), 0);
  }, [activeItems]);

  /* 주어진 id 집합의 file_size 합. */
  const sizeBytesForIds = useCallback((ids: string[]): number => {
    const idSet = new Set(ids);
    return activeItems
      .filter((item) => idSet.has(item.id))
      .reduce((acc, item) => acc + (item.file_size ?? 0), 0);
  }, [activeItems]);

  /* 선택한 폴더들에 *직접* 소속된(옵션 A — 하위폴더 미포함) 아이템 id 의
   *  합집합. 폴더 우클릭 다중 export(옵션 2) 가 scope="selected" 로 변환할 때
   *  사용한다. tag 는 "folder:" 접두 풀 태그. */
  const unionIdsForFolders = useCallback((tags: string[]): string[] => {
    if (tags.length === 0) return [];
    const tagSet = new Set(tags);
    return activeItems
      .filter((item) => item.tags.some((candidate) => tagSet.has(candidate)))
      .map((item) => item.id);
  }, [activeItems]);

  const handleCreateFolder = useCallback((parentPath?: string) => {
    setFolderEdit({ mode: "create", parentPath: parentPath ?? null });
  }, []);

  const confirmCreateFolder = useCallback((path: string) => {
    addUserFolderPath(path);
    setUserFolderPaths(getUserFolderPaths());
    toast({ title: t("library.toast.folderCreated"), description: prettyBriefMatchPath(path, t("library.sidebar.briefMatch")) });
  }, [toast, t]);

  const handleRenameFolder = useCallback((row: LibraryFolderRow) => {
    setFolderEdit({ mode: "rename", row });
  }, []);

  const confirmRenameFolder = useCallback(async (newPath: string) => {
    const row = folderEdit?.row;
    if (!row) return;
    const oldPath = normalizeFolderPath(row.tag);
    if (!newPath || newPath === oldPath) return;
    try {
      const result = await renameFolder(oldPath, newPath);
      renameUserFolderPath(oldPath, newPath);
      // Folder UI prefs (color/icon/expanded) 도 같은 path 변경을
      // 따라가게 한다. referenceLibrary 는 Project 쪽도 import 하는
      // 공용 모듈이라 cascade 책임을 호출자(LibraryPage)에 둠 — 옵션 A.
      cascadeRenameFolderPrefs(oldPath, newPath);
      // 폴더 형제 수동 순서도 같은 path 변경을 따라가야 사용자가 박아둔
      // 위치가 rename 후에도 유지된다.
      cascadeRenameFolderManualOrder(oldPath, newPath);
      /* Phase D: 폴더 단위 AI 설정도 같은 path 변경을 따라가게.
         (자손 폴더 cascade 까지는 일단 생략 — 직접 설정한 폴더만 옮긴다.) */
      renameFolderAiSettings(oldPath, newPath);
      // Canvas 뷰의 폴더별 배치(자식 폴더 트리 포함) 도 새 prefix 로 따라가게.
      // 빠뜨리면 사용자가 정성껏 잡아둔 캔버스 레이아웃이 rename 직후 "리셋된"
      // 것처럼 보인다(빈 layout 으로 시작 → reconciliation 이 자동 배치).
      cascadeRenameCanvasLayout(oldPath, newPath);
      // 보관된 브리프 내용도 함께 이동 — 이름만 바꿔도 브리프가 날아가던 누락 보완.
      cascadeRenameBriefMatchEntries(oldPath, newPath);
      void cascadeRenameBriefMatchImages(oldPath, newPath);
      setUserFolderPaths(getUserFolderPaths());
      setItems((current) => current.map((item) => result.items.find((updated) => updated.id === item.id) ?? item));
      // 선택 집합/앵커의 경로도 oldPath→newPath 로 치환(자손 포함).
      {
        const oldTag = folderTag(oldPath);
        const newTag = folderTag(newPath);
        const remap = (tag: string) =>
          tag === oldTag ? newTag : tag.startsWith(`${oldTag}/`) ? newTag + tag.slice(oldTag.length) : tag;
        applyFolderSelection(selectedFolderTags.map(remap), activeTag ? remap(activeTag) : null);
      }
      toast({ title: t("library.toast.folderRenamed"), description: t("library.toast.refsUpdated", { n: result.updated }) });
    } catch (err) {
      toast({ variant: "destructive", title: t("library.toast.renameFailed"), description: err instanceof Error ? err.message : String(err) });
    }
  }, [activeTag, selectedFolderTags, applyFolderSelection, folderEdit, toast, t]);

  const handleDeleteFolder = useCallback((row: LibraryFolderRow) => {
    setFolderDeleteTarget(row);
  }, []);

  const confirmDeleteFolder = useCallback(async (opts: { mode: "removeTagOnly" | "trashItems"; recursive: boolean }) => {
    const row = folderDeleteTarget;
    if (!row) return;
    const folderPath = normalizeFolderPath(row.tag);
    try {
      const result = await deleteFolder(folderPath, opts);
      removeUserFolderPath(folderPath);
      // 메타도 같이 정리해 dangling prefs / manual order 가 localStorage 에
      // 무한정 쌓이지 않게 한다. 옵션 A — 호출자에서만 수행.
      cascadeDeleteFolderPrefs(folderPath);
      cascadeDeleteFolderManualOrder(folderPath);
      /* Phase D: 폴더 단위 AI 설정도 함께 정리. */
      removeFolderAiSettings(folderPath);
      // Canvas 레이아웃도 같이 정리 — 폴더 삭제 후 localStorage 에 dangling
      // 으로 무한 누적되지 않게.
      cascadeDeleteCanvasLayout(folderPath);
      // 보관된 브리프 내용(텍스트=localStorage, 이미지=IndexedDB)도 함께 정리해
      // 폴더 삭제 후 고아 데이터가 남지 않게 한다.
      cascadeDeleteBriefMatchEntries(folderPath);
      void cascadeDeleteBriefMatchImages(folderPath);
      setUserFolderPaths(getUserFolderPaths());
      setItems((current) => current.map((item) => result.items.find((updated) => updated.id === item.id) ?? item));
      // 선택 집합에서 삭제된 폴더(및 자손)를 제거하고, 앵커가 영향받으면 남은 첫 폴더로.
      {
        const remaining = selectedFolderTags.filter((t) => t !== row.tag && !t.startsWith(`${row.tag}/`));
        const anchorAffected = activeTag === row.tag || (activeTag?.startsWith(`${row.tag}/`) ?? false);
        applyFolderSelection(remaining, anchorAffected ? (remaining[0] ?? null) : activeTag);
      }
      toast({
        title: opts.mode === "trashItems" ? t("library.toast.folderMovedToTrash") : t("library.toast.folderRemoved"),
        description: t("library.toast.refsAffected", { n: result.affected }),
      });
    } catch (err) {
      toast({ variant: "destructive", title: t("library.toast.deleteFolderFailed"), description: err instanceof Error ? err.message : String(err) });
    }
  }, [activeTag, selectedFolderTags, applyFolderSelection, folderDeleteTarget, toast, t]);

  // 폴더 자체 이동(rename) — 사이드바 우클릭 → "Move folder...".
  // 같은 FolderPickerDialog 를 destination 선택 UI 로 재사용. 자기
  // 자신 / 자기 자식 폴더로의 이동은 picker 자체에서 거른다(아래
  // `folders` 산출 시 제외).
  const handleMoveFolder = useCallback((row: LibraryFolderRow) => {
    setFolderMoveTarget(row);
  }, []);

  // 자식(하위 폴더)이 있는 폴더인지 — 있으면 이동 불가(요구사항 2).
  const folderHasChildren = useCallback(
    (path: string) => folders.some((r) => normalizeFolderPath(r.tag).startsWith(`${path}/`)),
    [folders],
  );

  /** 폴더 이동 가능 여부 평가.
   *  - 하위 폴더가 있으면 이동 불가.
   *  - 일반 → 스마트 브리프 매치 진입인데 브리프가 비어 있으면 입력 필요(게이트). */
  const evaluateFolderMove = useCallback(
    (sourcePath: string, newParentPath: string | null): "ok" | "blocked-children" | "needs-brief" => {
      if (folderHasChildren(sourcePath)) return "blocked-children";
      const leaf = sourcePath.split("/").pop() ?? sourcePath;
      const newPath = newParentPath ? normalizeFolderPath(`${newParentPath}/${leaf}`) : leaf;
      const intoBrief = isBriefMatchPath(newPath) && !isBriefMatchPath(sourcePath);
      if (intoBrief && !hasBriefContent(sourcePath)) return "needs-brief";
      return "ok";
    },
    [folderHasChildren],
  );

  // 공통 helper — destPath 가 null 이면 root 로 이동(leaf 만 남김),
  // 그 외엔 `${destPath}/${leaf}` 합성. 다이얼로그 경로(confirmMoveFolder)
  // 와 드래그&드롭 경로(handleDragMoveFolder)에서 동일하게 호출.
  const moveFolderTo = useCallback(
    async (sourceRow: LibraryFolderRow, destPath: string | null) => {
      const oldPath = normalizeFolderPath(sourceRow.tag);
      const leaf = oldPath.split("/").pop() ?? oldPath;
      const newPath = destPath ? normalizeFolderPath(`${destPath}/${leaf}`) : leaf;
      if (!newPath || newPath === oldPath) return;
      // 방어적 가드 — DnD 외 경로(메뉴 '폴더로 이동' 등)에서도 규칙을 지킨다.
      if (folderHasChildren(oldPath)) {
        toast({
          variant: "destructive",
          title: t("briefMatch.move.hasChildrenTitle"),
          description: t("briefMatch.move.hasChildrenDesc"),
        });
        return;
      }
      const intoBrief = isBriefMatchPath(newPath) && !isBriefMatchPath(oldPath);
      if (intoBrief && !hasBriefContent(oldPath)) {
        toast({
          variant: "destructive",
          title: t("briefMatch.move.needBriefTitle"),
          description: t("briefMatch.move.needBriefDesc"),
        });
        return;
      }
      try {
        const result = await renameFolder(oldPath, newPath);
        renameUserFolderPath(oldPath, newPath);
        cascadeRenameFolderPrefs(oldPath, newPath);
        cascadeRenameFolderManualOrder(oldPath, newPath);
        renameFolderAiSettings(oldPath, newPath);
        // Canvas 레이아웃도 같은 path 변경을 따라가게 (rename 과 동일).
        cascadeRenameCanvasLayout(oldPath, newPath);
        // 보관된 브리프 내용도 새 경로로 따라가게 — 브리프 매치 폴더를 옮겨도
        // 최초 등록한 브리프/이미지/PDF 가 보존된다(요구사항 3).
        cascadeRenameBriefMatchEntries(oldPath, newPath);
        void cascadeRenameBriefMatchImages(oldPath, newPath);
        setUserFolderPaths(getUserFolderPaths());
        setItems((current) =>
          current.map((item) => result.items.find((updated) => updated.id === item.id) ?? item),
        );
        // 선택 집합/앵커의 경로도 oldPath→newPath 로 치환(자손 포함).
        {
          const oldTag = folderTag(oldPath);
          const newTag = folderTag(newPath);
          const remap = (tag: string) =>
            tag === oldTag ? newTag : tag.startsWith(`${oldTag}/`) ? newTag + tag.slice(oldTag.length) : tag;
          applyFolderSelection(selectedFolderTags.map(remap), activeTag ? remap(activeTag) : null);
        }
        toast({
          title: t("library.toast.folderMoved"),
          description: t("library.toast.folderMovedDesc", {
            from: prettyBriefMatchPath(oldPath, t("library.sidebar.briefMatch")),
            to: prettyBriefMatchPath(newPath, t("library.sidebar.briefMatch")),
            n: result.updated,
          }),
        });
      } catch (err) {
        toast({
          variant: "destructive",
          title: t("library.toast.moveFolderFailed"),
          description: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [activeTag, selectedFolderTags, applyFolderSelection, folderHasChildren, toast, t],
  );

  /** 다중 폴더 일괄 이동 — 사이드바에서 Ctrl/Shift 로 여러 폴더를 선택한
   *  뒤 그중 하나를 드래그해 다른 폴더로 떨어뜨릴 때 사용. 선택 전체를 같은
   *  목적지(destPath, null 이면 root)로 옮긴다. 단건 moveFolderTo 와 달리
   *  토스트/선택 remap 을 한 번만 수행해 N 번 깜빡이지 않게 한다. */
  const moveFoldersTo = useCallback(
    async (sourceRows: LibraryFolderRow[], destPath: string | null) => {
      // 선택 안에 부모·자손이 함께 있으면 자손은 부모와 함께 따라 이동되므로
      // 중복 이동 대상에서 제외(또한 동일 경로 dedupe).
      const allPaths = sourceRows.map((r) => normalizeFolderPath(r.tag));
      const seen = new Set<string>();
      const targets = sourceRows.filter((r) => {
        const p = normalizeFolderPath(r.tag);
        if (seen.has(p)) return false;
        seen.add(p);
        return !allPaths.some((other) => other !== p && p.startsWith(`${other}/`));
      });

      const moves: { oldTag: string; newTag: string }[] = [];
      let blockedChildren = 0;
      let needsBriefCount = 0;
      let failed = 0;
      const updatedItems: ReferenceItem[] = [];

      for (const row of targets) {
        const oldPath = normalizeFolderPath(row.tag);
        const leaf = oldPath.split("/").pop() ?? oldPath;
        const newPath = destPath ? normalizeFolderPath(`${destPath}/${leaf}`) : leaf;
        // no-op / 사이클(자기 자신·자손으로) 차단.
        if (!newPath || newPath === oldPath) continue;
        if (destPath !== null && (destPath === oldPath || destPath.startsWith(`${oldPath}/`))) continue;
        // 같은 부모로의 이동은 의미 없음.
        const currentParent = oldPath.includes("/") ? oldPath.slice(0, oldPath.lastIndexOf("/")) : "";
        if ((destPath ?? "") === currentParent) continue;
        if (folderHasChildren(oldPath)) {
          blockedChildren += 1;
          continue;
        }
        const intoBrief = isBriefMatchPath(newPath) && !isBriefMatchPath(oldPath);
        if (intoBrief && !hasBriefContent(oldPath)) {
          needsBriefCount += 1;
          continue;
        }
        try {
          const result = await renameFolder(oldPath, newPath);
          renameUserFolderPath(oldPath, newPath);
          cascadeRenameFolderPrefs(oldPath, newPath);
          cascadeRenameFolderManualOrder(oldPath, newPath);
          renameFolderAiSettings(oldPath, newPath);
          cascadeRenameCanvasLayout(oldPath, newPath);
          cascadeRenameBriefMatchEntries(oldPath, newPath);
          void cascadeRenameBriefMatchImages(oldPath, newPath);
          updatedItems.push(...result.items);
          moves.push({ oldTag: folderTag(oldPath), newTag: folderTag(newPath) });
        } catch (err) {
          failed += 1;
          console.warn("[LibraryPage] moveFoldersTo rename failed:", (err as Error).message);
        }
      }

      if (moves.length > 0) {
        setUserFolderPaths(getUserFolderPaths());
        setItems((current) =>
          current.map((item) => updatedItems.find((u) => u.id === item.id) ?? item),
        );
        // 선택 집합/앵커 경로를 모든 이동에 맞춰 한 번에 remap(자손 포함).
        const remap = (tag: string) => {
          for (const { oldTag, newTag } of moves) {
            if (tag === oldTag) return newTag;
            if (tag.startsWith(`${oldTag}/`)) return newTag + tag.slice(oldTag.length);
          }
          return tag;
        };
        applyFolderSelection(selectedFolderTags.map(remap), activeTag ? remap(activeTag) : null);
        toast({
          title: t("library.toast.foldersMoved", { n: moves.length }),
          description: destPath
            ? t("library.toast.foldersMovedDesc", {
                to: prettyBriefMatchPath(destPath, t("library.sidebar.briefMatch")),
              })
            : t("library.toast.foldersMovedToRootDesc"),
        });
      }

      // 일부가 규칙에 막혔으면 알린다(하위 폴더 보유 / 브리프 필요).
      if (blockedChildren > 0) {
        toast({
          variant: "destructive",
          title: t("briefMatch.move.hasChildrenTitle"),
          description: t("briefMatch.move.hasChildrenDesc"),
        });
      }
      if (needsBriefCount > 0) {
        toast({
          variant: "destructive",
          title: t("briefMatch.move.needBriefTitle"),
          description: t("briefMatch.move.needBriefDesc"),
        });
      }
      if (failed > 0) {
        toast({ variant: "destructive", title: t("library.toast.moveFolderFailed") });
      }
    },
    [activeTag, selectedFolderTags, applyFolderSelection, folderHasChildren, toast, t],
  );

  const confirmMoveFolder = useCallback(
    async (destPath: string) => {
      const target = folderMoveTarget;
      if (!target) return;
      try {
        await moveFolderTo(target, destPath || null);
      } finally {
        setFolderMoveTarget(null);
      }
    },
    [folderMoveTarget, moveFolderTo],
  );

  /** 일반 폴더 → 스마트 브리프 매치 이동 attach 확인(플라이아웃) — 입력한 브리프를
   *  폴더에 저장(LLM 스킵)하고 이동을 완료한다. 라이브러리에서 드래그한 레퍼런스
   *  (briefAnchorIds/briefImageIds)는 새 폴더의 멤버로 추가한다.
   *  브리프 내용을 *원본 경로*에 먼저 심어 moveFolderTo 게이트를 통과시키고,
   *  cascade 가 새 경로로 옮긴다. */
  const handleAttachConfirm = useCallback(
    async (content: { briefText: string; images: { base64: string; mediaType: string }[]; pdfText?: string }) => {
      const target = briefAttachTarget;
      if (!target) return;
      const oldPath = normalizeFolderPath(target.sourceRow.tag);
      const leaf = oldPath.split("/").pop() ?? oldPath;
      const newPath = target.newParentPath ? normalizeFolderPath(`${target.newParentPath}/${leaf}`) : leaf;
      // 이미지는 이미 플라이아웃에서 다운스케일됨. 텍스트/PDF 는 localStorage,
      // 이미지는 IndexedDB 에 원본 경로로 먼저 저장한 뒤, 이동 cascade 가
      // 두 저장소 모두 새 경로로 옮긴다.
      setBriefMatchEntry(oldPath, {
        briefText: content.briefText,
        pdfText: content.pdfText,
        createdAt: new Date().toISOString(),
        imageCount: content.images.length > 0 ? content.images.length : undefined,
      });
      if (content.images.length > 0) {
        await setBriefMatchImages(oldPath, content.images);
      }
      await moveFolderTo(target.sourceRow, target.newParentPath);
      // 드래그로 추가한 라이브러리 레퍼런스를 새 폴더 멤버로 편입.
      const memberIds = Array.from(new Set([...briefAnchorIds, ...briefImageIds]));
      if (memberIds.length > 0) {
        try {
          const updated = await addReferencesToFolder(memberIds, newPath);
          setItems((current) => current.map((item) => updated.find((u) => u.id === item.id) ?? item));
        } catch (err) {
          console.warn("[LibraryPage] attach addReferencesToFolder failed:", (err as Error).message);
        }
      }
      setBriefAttachTarget(null);
      setBriefAnchorIds([]);
      setBriefImageIds([]);
    },
    [briefAttachTarget, briefAnchorIds, briefImageIds, moveFolderTo],
  );

  // 폴더 복제 — referenceLibrary.duplicateFolder 가 DB row 만 사본으로
  // 새 prefix(${leaf} (Copy)) 에 만든다. 디스크 파일은 안 복사.
  // prefs(색·아이콘·접힘·핀) 는 새 path 트리로 복사해 사용자 시각이
  // 그대로 따라가게 한다 — cascadeRenameFolderPrefs 를 재활용하기엔
  // "원본을 옮긴 게 아니라 추가로 복제" 라 의미가 맞지 않으므로,
  // 같은 발상의 path-prefix-rewrite 로직을 인라인으로 둔다.
  const handleDuplicateFolder = useCallback(
    async (row: LibraryFolderRow) => {
      const oldPath = normalizeFolderPath(row.tag);
      try {
        const result = await duplicateFolder(oldPath);
        // 사본 폴더 path 를 user-folder 목록에도 등록 — 비어있는
        // 사본(원본에 항목이 없을 때)도 사이드바에서 사라지지 않게.
        addUserFolderPath(result.newPath);
        setUserFolderPaths(getUserFolderPaths());

        // prefs 카피 — 원본 path 트리의 prefs 를 새 prefix 로 그대로 복제.
        const allPrefs = getAllFolderMeta();
        for (const [path, meta] of Object.entries(allPrefs)) {
          if (path === oldPath) {
            setFolderMeta(result.newPath, meta);
          } else if (path.startsWith(`${oldPath}/`)) {
            const suffix = path.slice(oldPath.length + 1);
            setFolderMeta(`${result.newPath}/${suffix}`, meta);
          }
        }
        // 폴더 형제 순서도 같은 방식으로 복제 — 사본 트리 내부의 사용자
        // 정렬을 보존. 단, 사본 폴더 자체가 부모의 형제 순서에 어디로
        // 들어갈지는 명시하지 않는다(미등록 → 알파벳 끝쪽). Eagle 도 사본을
        // 끝쪽에 만들어 두므로 패턴 일치.
        const allOrders = getAllFolderManualOrder();
        for (const [parent, children] of Object.entries(allOrders)) {
          let newParent = parent;
          if (parent === oldPath) newParent = result.newPath;
          else if (parent.startsWith(`${oldPath}/`)) newParent = `${result.newPath}/${parent.slice(oldPath.length + 1)}`;
          else continue;
          const newChildren = children.map((child) => {
            if (child === oldPath) return result.newPath;
            if (child.startsWith(`${oldPath}/`)) return `${result.newPath}/${child.slice(oldPath.length + 1)}`;
            return child;
          });
          setFolderSiblingOrder(newParent, newChildren);
        }

        // Canvas 레이아웃 — 노트와 카메라만 복제, ref-별 transform 은 비움.
        // 복제된 폴더에는 새 id 의 ref 들이 들어가는데 duplicateFolder 가
        // oldId→newId 매핑을 노출하지 않으므로 v1 에선 빈 layout 으로 시작 →
        // reconciliation 이 자동 배치. (사용자의 노트와 카메라 상태는 유지.)
        cascadeDuplicateCanvasLayout(oldPath, result.newPath);
        // 보관된 브리프 내용도 사본 트리로 복사(원본 유지).
        cascadeDuplicateBriefMatchEntries(oldPath, result.newPath);
        void cascadeDuplicateBriefMatchImages(oldPath, result.newPath);

        // 새로 생성된 ref 들을 items 상태에 합쳐 그리드에 즉시 반영.
        setItems((current) => {
          const map = new Map(current.map((item) => [item.id, item] as const));
          for (const created of result.items) map.set(created.id, created);
          return [...map.values()];
        });

        toast({
          title: t("library.toast.folderDuplicated"),
          description: t("library.toast.folderMovedDesc", {
            from: prettyBriefMatchPath(oldPath, t("library.sidebar.briefMatch")),
            to: prettyBriefMatchPath(result.newPath, t("library.sidebar.briefMatch")),
            n: result.created,
          }),
        });
      } catch (err) {
        toast({
          variant: "destructive",
          title: t("library.toast.duplicateFolderFailed"),
          description: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [toast, t],
  );

  // 드래그 종료 시 호출. 사이드바에서 사이클 1차 차단을 거치고도 한
  // 번 더 방어적 검증 — 자기 자신 / 자손 / 동일 부모는 noop.
  const handleDragMoveFolder = useCallback(
    (sourceRow: LibraryFolderRow, destPath: string | null) => {
      // 드래그한 폴더가 다중 선택(2개 이상)의 일부면 선택 폴더 전체를 같은
      // 목적지로 일괄 이동한다. 단건 가드/이동 로직은 moveFoldersTo 가 각
      // 폴더별로 다시 평가하므로 여기선 곧장 위임한다.
      if (selectedFolderTags.length > 1 && selectedFolderTags.includes(sourceRow.tag)) {
        const rows = selectedFolderTags
          .map((tag) => folders.find((r) => r.tag === tag))
          .filter((r): r is LibraryFolderRow => Boolean(r));
        void moveFoldersTo(rows, destPath);
        return;
      }
      const sourcePath = normalizeFolderPath(sourceRow.tag);
      if (destPath !== null) {
        if (destPath === sourcePath || destPath.startsWith(`${sourcePath}/`)) return;
      }
      const currentParent = sourcePath.includes("/")
        ? sourcePath.slice(0, sourcePath.lastIndexOf("/"))
        : null;
      if ((destPath ?? null) === currentParent) return;
      void moveFolderTo(sourceRow, destPath);
    },
    [moveFolderTo, moveFoldersTo, selectedFolderTags, folders],
  );

  const applyUpdatedItems = useCallback((updated: ReferenceItem[]) => {
    setItems((current) => current.map((item) => updated.find((next) => next.id === item.id) ?? item));
  }, []);

  // ── reference → 폴더 드래그 드롭 처리 ─────────────────────────
  // Eagle / 파인더의 멘탈 모델대로 "이동"(=기존 folder 태그 교체) 으로
  // 처리. 폴더 다중 소속이 필요하면 우클릭 "Add to folder..." 메뉴를
  // 그대로 쓰면 되도록 두 경로를 분리해 둔다(기존 동작 보존).
  //
  // 위치 주의: useCallback 의존성에 applyUpdatedItems 가 들어가므로 반드시
  // 그 선언(`const applyUpdatedItems = ...`) 뒤에 둔다. JS 의 const 는
  // hoist 되지만 TDZ 에 갇혀 있어, dep array 평가 시점이 선언보다 앞이면
  // ReferenceError 가 난다(첫 페인트에서 ErrorBoundary 까지 폭발).
  const handleDropReferencesToFolder = useCallback(
    async (referenceIds: string[], destPath: string, additive = false) => {
      const ids = [...new Set(referenceIds.filter(Boolean))];
      if (ids.length === 0) return;
      const targetTag = folderTag(destPath);
      // 모든 항목이 이미 그 폴더에 들어 있다면 noop — 시각적으로도
      // toast 안 띄워 사용자를 귀찮게 하지 않음.
      const allAlreadyIn = items
        .filter((row) => ids.includes(row.id))
        .every((row) => row.tags.includes(targetTag));
      if (allAlreadyIn) return;
      /* "추가"(기존 폴더 소속 유지 + 대상 폴더에도 더함) 조건:
       *   1) Ctrl/⌘ 누른 채 드롭 (additive) — 사용자가 명시적으로 다중 소속 요청.
       *   2) 스마트 브리프 매치 폴더로 드롭 — 원래 분류가 사라지지 않게 항상 추가.
       * 그 외 일반 폴더 간 드롭은 기존대로 이동(Eagle/Finder 멘탈모델, 교체). */
      const isAdd = additive || isBriefMatchPath(destPath);
      /* Undo 용으로 *이전 tags 스냅샷* 을 잡아둔다. moveReferencesToFolder 는
       * folder:* 태그를 destTag 로 *전부 교체* 하므로, 원복하려면 항목별
       * 원래 tags 배열 그대로를 다시 써넣어야 한다(폴더 다중 소속 보존). */
      const prevTagsById = new Map<string, string[]>();
      for (const row of items) {
        if (ids.includes(row.id)) prevTagsById.set(row.id, [...row.tags]);
      }
      try {
        const updated = isAdd
          ? await addReferencesToFolder(ids, destPath)
          : await moveReferencesToFolder(ids, destPath);
        applyUpdatedItems(updated);
        showUndoBar({
          title: ids.length === 1
            ? t(isAdd ? "library.toast.itemAddedTo" : "library.toast.itemMovedTo", { path: destPath })
            : t(isAdd ? "library.toast.itemsAddedTo" : "library.toast.itemsMovedTo", { n: ids.length, path: destPath }),
          onUndo: async () => {
            const restored: ReferenceItem[] = [];
            for (const [id, tags] of prevTagsById) {
              restored.push(await updateReference(id, { tags }));
            }
            applyUpdatedItems(restored);
          },
        });
      } catch (err) {
        toast({
          variant: "destructive",
          title: t("library.toast.moveToFolderFailed"),
          description: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [applyUpdatedItems, items, showUndoBar, toast, t],
  );

  // ── reference → reference reorder (수동 순서 갱신) ───────────
  // 같은 그리드 안에서 카드를 다른 카드 *직전* 위치로 떨어뜨리면 드롭한
  // 순간의 가시 항목 순서를 기준으로 새 manual order 를 계산해 저장한다.
  // 사이드 효과로 sortKey 가 "manual" 이 아니면 즉시 그쪽으로 전환 —
  // 그래야 사용자가 한 reorder 가 화면에 그대로 보인다.
  const handleReorderReferences = useCallback(
    (moveIds: string[], targetId: string | null) => {
      const contextKey = deriveLibraryContextKey(activeTag, quickFilter);
      // 현재 화면에서 보이는 *그 정렬 그대로* 의 id 시퀀스를 시드로 사용.
      // pinned 가 위로 빠지는 효과까지 자연스럽게 살아남는다.
      const visibleIds = filteredItems.map((item) => item.id);
      const next = reorderManyBefore(visibleIds, moveIds, targetId);
      if (next.length === visibleIds.length && next.every((id, i) => id === visibleIds[i])) {
        return; // noop
      }
      setManualOrder(contextKey, next);
      setManualOrderVersion((v) => v + 1);
      if (sortKey !== "manual") setSortKey("manual");
      /* 사용자가 명시적으로 위치를 잡아준 항목은 더 이상 "방금 업로드"
         우선순위가 필요 없다 — freshness 가 남아 있으면 manual 인덱스보다
         앞서 비교돼 사용자의 의도를 덮어씀. 이동된 ids 만 정리해 다른 신규
         업로드의 freshness 는 유지. */
      setFreshlyUploadedAt((current) => {
        let mutated = false;
        const nextMap = { ...current };
        for (const id of moveIds) {
          if (id in nextMap) {
            delete nextMap[id];
            mutated = true;
          }
        }
        return mutated ? nextMap : current;
      });
    },
    [activeTag, filteredItems, quickFilter, sortKey],
  );

  /* ── 글로벌 라이브러리 드롭 핸들러 등록 ─────────────────────────
   * `libraryDragChannel.installDragTracker` 가 dragend 시점에 호출하는
   * dispatch 진입점. 사이드바 폴더 hover → onFolderDrop, 같은 그리드의
   * 다른 카드 hover → onCardDrop 으로 라우팅된다. 이 두 콜백은 위에서
   * 정의한 useCallback 들과 동일한 시그니처 — 그대로 위임.
   *
   * unmount 시 null 로 비워 dangling reference 가 옛 props 클로저를 잡아
   * 두지 않게 한다. */
  useEffect(() => {
    setLibraryDropHandlers({
      onFolderDrop: (ids: string[], path: string, additive: boolean) => {
        console.warn("[LibraryPage] onFolderDrop ids=" + ids.length + " path=" + path + " additive=" + additive);
        void handleDropReferencesToFolder(ids, path, additive);
      },
      onCardDrop: (ids: string[], targetCardId: string) => {
        console.warn("[LibraryPage] onCardDrop ids=" + ids.length + " target=" + targetCardId);
        handleReorderReferences(ids, targetCardId);
      },
      onBriefAnchorDrop: (ids: string[]) => {
        // Brief Match 플라이아웃이 열려 있을 때만 앵커로 추가(닫혀 있으면 무시).
        if (!briefMatchOpenRef.current) return;
        setBriefAnchorIds((prev) => Array.from(new Set([...prev, ...ids])));
      },
      onBriefImageDrop: (ids: string[]) => {
        if (!briefMatchOpenRef.current) return;
        setBriefImageIds((prev) => Array.from(new Set([...prev, ...ids])));
      },
      onVariationInjectDrop: (ids: string[]) => {
        // 변형 플라이아웃이 열려 있을 때만 참조로 추가.
        if (!variationFlyoutOpenRef.current) return;
        setVariationInjectIds((prev) => Array.from(new Set([...prev, ...ids])));
      },
    });
    return () => setLibraryDropHandlers(null);
  }, [handleDropReferencesToFolder, handleReorderReferences]);

  // ── 통합 DnD 핸들러 — 폴더↔폴더, reference→폴더 두 케이스를 분기. ──
  // 단일 PointerSensor + pointerWithin 조합은 기존 LibrarySidebar 안의
  // 컨텍스트와 동일한 정책 그대로(짧은 클릭은 onClick 통과).
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const handleDndDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current as
      | { kind?: "folder" | "reference"; ids?: string[]; item?: ReferenceItem }
      | undefined;
    const id = String(event.active.id);
    if (data?.kind === "reference") {
      setActiveDrag({ kind: "reference", id, ids: data.ids ?? [id], item: data.item });
    } else {
      setActiveDrag({ kind: "folder", id });
    }
  }, []);

  const handleDndDragCancel = useCallback(() => setActiveDrag(null), []);

  const handleDndDragEnd = useCallback(
    (event: DragEndEvent) => {
      const drag = activeDrag;
      setActiveDrag(null);
      const overId = event.over?.id != null ? String(event.over.id) : null;
      if (!overId) return;

      const data = event.active.data.current as
        | { kind?: "folder" | "reference"; ids?: string[] }
        | undefined;

      // ─── 폴더 → 폴더 (사이드바 안에서 트리 재배치) ───
      // overId 의 두 가지 형태:
      //   - "folder:X::before"  → X 의 *형제* 로 X 직전 위치에 삽입.
      //                            X 가 다른 부모면 부모도 같이 바뀜(rename),
      //                            같은 부모면 단순 형제 순서 변경(rename 없음).
      //   - "folder:X"          → X 의 자식으로 흡수 — 부모 변경(rename) 만 수행.
      // 사이클 / 자기 자신 / 자식 트리로의 이동은 양쪽 케이스 모두 차단.
      if (data?.kind === "folder" || drag?.kind === "folder") {
        const sourceTag = String(event.active.id);
        const sourceRow = folders.find((r) => r.tag === sourceTag);
        if (!sourceRow) return;
        const sourcePath = sourceTag.replace(/^folder:/, "");
        const sourceCurrentParent = parentPathOf(sourcePath);
        const BEFORE_SUFFIX = "::before";
        const AFTER_SUFFIX = "::after";

        // ── 다중 선택 일괄 이동 ──
        // 사이드바에서 Ctrl/Shift 로 여러 폴더를 고른 뒤 그중 하나를 드래그하면
        // 선택 폴더 전체를 같은 목적지로 옮긴다. before/after/into 모두 "목적지
        // 부모" 로 환원해 moveFoldersTo 에 위임 — per-folder 검증·토스트·선택
        // remap 을 한 곳에서 처리한다(형제 순서 미세 조정은 다중 케이스에선 생략).
        if (selectedFolderTags.length > 1 && selectedFolderTags.includes(sourceTag)) {
          const destParent = overId.endsWith(BEFORE_SUFFIX)
            ? parentPathOf(overId.slice(0, -BEFORE_SUFFIX.length).replace(/^folder:/, ""))
            : overId.endsWith(AFTER_SUFFIX)
              ? parentPathOf(overId.slice(0, -AFTER_SUFFIX.length).replace(/^folder:/, ""))
              : overId.replace(/^folder:/, "");
          const rows = selectedFolderTags
            .map((tag) => folders.find((r) => r.tag === tag))
            .filter((r): r is LibraryFolderRow => Boolean(r));
          void moveFoldersTo(rows, destParent || null);
          return;
        }

        // ── 형제 순서 재배치(::before / ::after) ──
        // before = 타깃 직전, after = 타깃 직후(목록 맨 아래로 내릴 때 사용).
        // 둘 다 "타깃의 형제(=같은 부모)" 로 들어가며, 부모가 바뀌면 rename 까지.
        const isBeforeDrop = overId.endsWith(BEFORE_SUFFIX);
        const isAfterDrop = overId.endsWith(AFTER_SUFFIX);
        if (isBeforeDrop || isAfterDrop) {
          const suffixLen = (isBeforeDrop ? BEFORE_SUFFIX : AFTER_SUFFIX).length;
          const targetTag = overId.slice(0, -suffixLen);
          const targetPath = targetTag.replace(/^folder:/, "");
          if (targetPath === sourcePath) return;
          const newParentPath = parentPathOf(targetPath);
          if (newParentPath === sourcePath || newParentPath.startsWith(`${sourcePath}/`)) return;

          // 부모가 바뀌는 실제 '이동'일 때만 규칙 평가(같은 부모 내 순서 변경은 허용).
          // sibling-order 쓰기 전에 평가해 차단/게이트 시 dangling 상태가 안 남게.
          if (newParentPath !== sourceCurrentParent) {
            const decision = evaluateFolderMove(sourcePath, newParentPath || null);
            if (decision === "blocked-children") {
              toast({
                variant: "destructive",
                title: t("briefMatch.move.hasChildrenTitle"),
                description: t("briefMatch.move.hasChildrenDesc"),
              });
              return;
            }
            if (decision === "needs-brief") {
              setBriefAttachTarget({ sourceRow, newParentPath: newParentPath || null });
              setBriefMatchOpen(true);
              return;
            }
          }

          /* 새 path 를 미리 계산해 manual order 를 *부모 변경 전*에 박는다.
             setFolderSiblingOrder 는 단순 storage 쓰기라 부수효과 없고,
             cascadeRenameFolderManualOrder 는 oldPath 매칭만 보므로 미리
             심어둔 newPath 항목은 건드리지 않는다. 그 후 부모 변경(rename)
             이 일어나면 자연스럽게 일관된 상태가 된다. */
          const leaf = sourcePath.split("/").pop() ?? sourcePath;
          const newSourcePath = newParentPath ? `${newParentPath}/${leaf}` : leaf;

          // 새 부모의 현재 visible 형제 순서(사이드바와 같은 규칙으로 정렬)
          // 를 시드로 잡는다. 다른 부모에서 옮겨오는 경우 source 는 시드에
          // 없고, 같은 부모면 source 가 시드에 있다(사용자가 보고 있는 그대로).
          const sortedSiblingsOfNewParent = (() => {
            const allOrders = getAllFolderManualOrder();
            const order = allOrders[newParentPath] ?? [];
            const indexed = new Map<string, number>();
            order.forEach((p, i) => indexed.set(p, i));
            const siblings = folders
              .map((r) => r.tag.replace(/^folder:/, ""))
              .filter((p) => parentPathOf(p) === newParentPath);
            const known = siblings.filter((p) => indexed.has(p));
            const unknown = siblings.filter((p) => !indexed.has(p));
            known.sort((a, b) => (indexed.get(a) ?? 0) - (indexed.get(b) ?? 0));
            unknown.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
            return [...known, ...unknown];
          })();

          // 다른 부모에서 가져오는 경우엔 시드에 newSourcePath 가 없으니
          // 강제로 끝쪽에 더한 뒤 reorderFolders(Before|After) 로 옮긴다. 같은
          // 부모면 이미 sourcePath(=newSourcePath) 가 시드 안에 있다.
          const seed = sortedSiblingsOfNewParent.includes(newSourcePath)
            ? sortedSiblingsOfNewParent
            : [...sortedSiblingsOfNewParent, newSourcePath];
          const newOrder = isAfterDrop
            ? reorderFoldersAfter(seed, newSourcePath, targetPath)
            : reorderFoldersBefore(seed, newSourcePath, targetPath);
          setFolderSiblingOrder(newParentPath, newOrder);

          // 부모가 다르면 옛 부모의 order 에서도 source 를 빼낸다 — 그러지
          // 않으면 cascade rename 이 단순 prefix 치환이라 옛 부모에 여전히
          // 잘못된 child 항목이 dangling 으로 남는다. 그 후 실제 폴더 path
          // 를 옮긴다(DB rename + 다른 cascade 들 함께 호출).
          if (newParentPath !== sourceCurrentParent) {
            const oldOrder = getFolderSiblingOrder(sourceCurrentParent);
            if (oldOrder.includes(sourcePath)) {
              setFolderSiblingOrder(
                sourceCurrentParent,
                oldOrder.filter((p) => p !== sourcePath),
              );
            }
            handleDragMoveFolder(sourceRow, newParentPath || null);
          }
          return;
        }

        // 폴더-into: 흡수(자식 만들기). 같은 부모면 의미 없음(자기 자신을
        // 자기로 흡수). 사이클 차단은 위와 동일.
        const newParentPath = overId.replace(/^folder:/, "");
        if (newParentPath === sourcePath || newParentPath.startsWith(`${sourcePath}/`)) return;
        if (newParentPath === sourceCurrentParent) return;
        // 이동 규칙 평가 — 하위 폴더 있으면 차단, 브리프매치 진입 시 브리프 필요.
        {
          const decision = evaluateFolderMove(sourcePath, newParentPath || null);
          if (decision === "blocked-children") {
            toast({
              variant: "destructive",
              title: t("briefMatch.move.hasChildrenTitle"),
              description: t("briefMatch.move.hasChildrenDesc"),
            });
            return;
          }
          if (decision === "needs-brief") {
            setBriefAttachTarget({ sourceRow, newParentPath: newParentPath || null });
            setBriefMatchOpen(true);
            return;
          }
        }
        // 새 부모 안에서의 위치는 명시하지 않는다 — 미등록 → 알파벳 끝쪽.
        // 사용자가 흡수 직후 정확한 위치를 원하면 다시 ::before 드롭으로
        // 박으면 된다(Eagle 동일 패턴).
        handleDragMoveFolder(sourceRow, newParentPath || null);
        return;
      }

      // ─── reference 카드 → ??? ───
      // overId 의 형식으로 분기:
      //   - "folder:..." (folder-into, before 는 reference drop 에선 비활성)
      //     → 폴더 안으로 이동 (기존 동작).
      //   - "card::<refId>"
      //     → 그리드 내 reorder. 다른 카드의 *직전* 위치로 들어감.
      //   - 그 외(self, end-droppable 등)
      //     → 무시 / 끝쪽 append.
      if (data?.kind === "reference") {
        const ids = data.ids && data.ids.length > 0 ? data.ids : [String(event.active.id)];
        if (overId.startsWith("folder:")) {
          if (overId.endsWith("::before") || overId.endsWith("::after")) return;
          const path = overId.replace(/^folder:/, "");
          void handleDropReferencesToFolder(ids, path);
          return;
        }
        if (overId.startsWith("card::")) {
          const targetId = overId.slice("card::".length);
          // 자기 자신 위에 떨어뜨리면 의미 없음. reorderManyBefore 가
          // 안에서도 한 번 더 거르지만, 여기서 빠져나가면 sortKey 자동
          // 전환도 안 일어나니 일찍 반환.
          if (ids.includes(targetId)) return;
          handleReorderReferences(ids, targetId);
          return;
        }
        if (overId === "card-grid-end") {
          // 빈 영역 / 끝쪽 sentinel — append.
          handleReorderReferences(ids, null);
          return;
        }
      }
    },
    [
      activeDrag,
      folders,
      selectedFolderTags,
      moveFoldersTo,
      evaluateFolderMove,
      handleDragMoveFolder,
      handleDropReferencesToFolder,
      handleReorderReferences,
      toast,
      t,
    ],
  );

  const handleAddToFolder = useCallback(async (item: ReferenceItem) => {
    setFolderPicker({ mode: "add", item });
  }, []);

  const handleMoveToFolder = useCallback(async (item: ReferenceItem) => {
    setFolderPicker({ mode: "move", item });
  }, []);

  const confirmPickFolder = useCallback(async (path: string) => {
    if (!folderPicker) return;
    const mode = folderPicker.mode;
    try {
      addUserFolderPath(path);
      const ids = selectedIdsForItem(folderPicker.item);
      /* Undo 스냅샷 — add/move 모두 원래 tags 배열을 통째로 보존하면
       * 안전하게 정확히 원복된다. add 모드에서는 사실상 새 folder 태그
       * 하나만 추가되지만, move 모드에서는 기존 folder:* 가 destTag 로
       * 교체되므로 *전체 tags* 스냅샷이 필요. */
      const prevTagsById = new Map<string, string[]>();
      for (const row of items) {
        if (ids.includes(row.id)) prevTagsById.set(row.id, [...row.tags]);
      }
      const updated = mode === "add"
        ? await addReferencesToFolder(ids, path)
        : await moveReferencesToFolder(ids, path);
      applyUpdatedItems(updated);
      setUserFolderPaths(getUserFolderPaths());
      showUndoBar({
        title: mode === "add"
          ? (updated.length === 1
            ? t("library.toast.itemAddedTo", { path })
            : t("library.toast.itemsAddedTo", { n: updated.length, path }))
          : (updated.length === 1
            ? t("library.toast.itemMovedTo", { path })
            : t("library.toast.itemsMovedTo", { n: updated.length, path })),
        onUndo: async () => {
          const restored: ReferenceItem[] = [];
          for (const [id, tags] of prevTagsById) {
            restored.push(await updateReference(id, { tags }));
          }
          applyUpdatedItems(restored);
        },
      });
    } catch (err) {
      toast({ variant: "destructive", title: t("library.toast.folderUpdateFailed"), description: err instanceof Error ? err.message : String(err) });
    }
  }, [applyUpdatedItems, folderPicker, items, selectedIdsForItem, showUndoBar, toast, t]);

  const handleRemoveFromActiveFolder = useCallback(async (item: ReferenceItem) => {
    if (!activeTag?.startsWith("folder:")) return;
    const folderTagAtCall = activeTag;
    try {
      const ids = selectedIdsForItem(item);
      const updated = await removeReferencesFromFolder(ids, folderTagAtCall);
      applyUpdatedItems(updated);
      /* Undo = 같은 폴더로 다시 add. removeReferencesFromFolder 는
       * 해당 태그만 빼므로 다시 addReferencesToFolder 한 번이면 정확히
       * 원상복귀. activeTag 는 "folder:..." 풀 태그라 path 는 prefix 만 떼고 사용. */
      const folderPath = folderTagAtCall.replace(/^folder:/, "");
      const undoIds = updated.map((row) => row.id);
      showUndoBar({
        title: undoIds.length === 1
          ? t("library.toast.itemRemovedFrom", { path: folderPath })
          : t("library.toast.itemsRemovedFrom", { n: undoIds.length, path: folderPath }),
        onUndo: async () => {
          const restored = await addReferencesToFolder(undoIds, folderPath);
          applyUpdatedItems(restored);
        },
      });
    } catch (err) {
      toast({ variant: "destructive", title: t("library.toast.removeFailed"), description: err instanceof Error ? err.message : String(err) });
    }
  }, [activeTag, applyUpdatedItems, selectedIdsForItem, showUndoBar, toast, t]);

  const openExportDialog = useCallback((config: ExportDialogState) => {
    setExportDialog(config);
  }, []);

  const handleExportFolder = useCallback((row: LibraryFolderRow) => {
    openExportDialog({
      scope: "folder",
      scopeLabel: row.tag.replace(/^folder:/, ""),
      folderTag: row.tag,
      itemCount: folderCount(row.tag),
    });
  }, [folderCount, openExportDialog]);

  /* HTML Viewer Export — Export pack 핸들러와 거의 동일하지만 별도
   *  dialog state 슬롯(htmlExportDialog)을 채운다. projectLinked scope 는
   *  viewer 공유 시나리오에서 의미가 없어 진입점도 만들지 않는다. */
  const handleExportFolderAsHtml = useCallback((row: LibraryFolderRow) => {
    // 옵션 2: 우클릭한 폴더가 다중 선택(2개 이상)에 포함돼 있으면, 선택 폴더
    // 전체를 scope="selected"(합집합 ids) + folderScope(선택 폴더만) 로 내보낸다.
    // 그래야 뷰어 트리에 선택한 폴더만 남고 엮인 다른 폴더가 섞이지 않는다.
    if (selectedFolderTags.length > 1 && selectedFolderTags.includes(row.tag)) {
      const ids = unionIdsForFolders(selectedFolderTags);
      setHtmlExportDialog({
        scope: "selected",
        scopeLabel: selectedFolderTags.map((t) => t.replace(/^folder:/, "")).join(", "),
        ids,
        itemCount: ids.length,
        sizeBytes: sizeBytesForIds(ids),
        folderScope: selectedFolderTags,
      });
      return;
    }
    setHtmlExportDialog({
      scope: "folder",
      scopeLabel: row.tag.replace(/^folder:/, ""),
      folderTag: row.tag,
      itemCount: folderCount(row.tag),
      sizeBytes: folderSizeBytes(row.tag),
    });
  }, [folderCount, folderSizeBytes, selectedFolderTags, unionIdsForFolders, sizeBytesForIds]);

  const handleExportSelected = useCallback((item?: ReferenceItem) => {
    const ids = item ? selectedIdsForItem(item) : selectedItems.map((row) => row.id);
    openExportDialog({
      scope: "selected",
      scopeLabel: t("library.page.nSelected", { n: ids.length }),
      ids,
      itemCount: ids.length,
    });
  }, [openExportDialog, selectedIdsForItem, selectedItems, t]);

  const handleExportSelectedAsHtml = useCallback((item?: ReferenceItem) => {
    const ids = item ? selectedIdsForItem(item) : selectedItems.map((row) => row.id);
    setHtmlExportDialog({
      scope: "selected",
      scopeLabel: t("library.page.nSelected", { n: ids.length }),
      ids,
      itemCount: ids.length,
      sizeBytes: sizeBytesForIds(ids),
      /* 선택한 폴더(들)에서 내보내면 뷰어 폴더 트리를 그 폴더(들)로만 한정한다
       *  (자료가 다른 폴더에도 태깅돼 있어도 사이드/형제 폴더가 섞이지 않게).
       *  폴더 선택이 없으면 undefined → 항목들의 폴더 전체. */
      folderScope: selectedFolderTags.some((t) => t.startsWith("folder:"))
        ? selectedFolderTags.filter((t) => t.startsWith("folder:"))
        : undefined,
    });
  }, [selectedFolderTags, selectedIdsForItem, selectedItems, sizeBytesForIds, t]);

  const handleExportFiltered = useCallback(() => {
    openExportDialog({
      scope: "filtered",
      scopeLabel: toolbarTitle,
      ids: filteredItems.map((item) => item.id),
      itemCount: filteredItems.length,
    });
  }, [filteredItems, openExportDialog, toolbarTitle]);

  const handleExportAll = useCallback(() => {
    openExportDialog({
      scope: "all",
      scopeLabel: t("library.page.allReferences"),
      itemCount: activeItems.length,
    });
  }, [activeItems.length, openExportDialog, t]);

  const handleExportProject = useCallback(() => {
    if (!returnProjectId) return;
    openExportDialog({
      scope: "projectLinked",
      scopeLabel: t("library.page.projectLinkedRefs"),
      projectId: returnProjectId,
      itemCount: activeItems.filter((item) => (usageCounts[item.id] ?? 0) > 0).length,
    });
  }, [activeItems, openExportDialog, returnProjectId, usageCounts, t]);

  const handleCleanupOrphans = useCallback(async () => {
    setOrphanCleanupOpen(true);
  }, []);

  return (
    <div className="h-screen overflow-hidden flex flex-col bg-background">
      {/* 상단 네비게이션 — Project Dashboard 의 Navbar 와 픽셀 단위로 동일한
          구조. `app-topbar` 베이스 + `px-8` 브랜드 + `px-8` 컨텍스트 + `gap-6
          px-7` 우측 존 — Dashboard 의 [src/components/Navbar.tsx] 좌표계를
          그대로 승계해 두 화면의 우상단 위치/간격이 정확히 맞물린다.
          'Reference Library' 는 ProjectPage 의 폴더/제목/탭 브레드크럼과
          같은 패턴으로, 루트 + 현재 위치를 한 줄에 노출한다. 루트는 항상
          클릭 가능(All Items 복귀), 폴더 경로의 중간 세그먼트도 클릭으로
          상위 폴더 점프가 가능. */}
      <nav className="app-topbar items-stretch relative">
        {/* Top-center 토스트가 네비바 위에 떠 있을 때 Electron drag region 흡수를
            막는 carve-out. 자세한 설명은 컴포넌트 파일 헤더 주석 참고. */}
        <TopbarToastCarveOut />
        {/* 로고는 단순 표시 영역 — 워크스페이스 이동은 사이드바 풋터의
            WorkspaceSwitcher 가 단일 진입점. */}
        <div className="flex items-center pl-[27px] pr-8 min-w-[260px] flex-shrink-0">
          <BrandLogo variant="library" />
        </div>
        <div className="flex items-center flex-1 px-8 min-w-0">
          <div className="flex items-center min-w-0 overflow-hidden">
            {/* 루트 — 활성 Library 워크스페이스 이름. 클릭 시 All Items
                로 복귀(LibrarySidebar 의 quick filter "all" 클릭과 동일한
                setter 묶음). 현재 위치가 이미 루트(=All References) 일 때는
                강조해 표시한다. */}
            <button
              type="button"
              onClick={() => {
                resetFolderSelection();
                setQuickFilter("all");
                setActiveSavedFilterId(null);
              }}
              className={cn(
                // 대시보드 상단(13px)과 통일. 위계는 색/굵기로만 구분하고
                // 폰트 크기는 모든 세그먼트 균등.
                "flex-shrink-0 transition-colors text-body",
                breadcrumbSegments.length === 0 || (breadcrumbSegments.length === 1 && quickFilter === "all" && !activeTag && !activeSavedFilter)
                  ? "font-semibold text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {libraryWorkspaceName}
            </button>
            {breadcrumbSegments.map((seg, i) => {
              const isLast = i === breadcrumbSegments.length - 1;
              const interactive = !isLast && seg.folderTag !== null && !seg.ellipsis;
              return (
                <span key={`${seg.label}-${i}`} className="flex items-center min-w-0">
                  <span className="text-primary/50 text-body mx-2 flex-shrink-0">/</span>
                  {interactive ? (
                    <button
                      type="button"
                      onClick={() => {
                        selectSingleFolder(seg.folderTag);
                        setQuickFilter("all");
                        setActiveSavedFilterId(null);
                      }}
                      className="text-body text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                    >
                      {seg.label}
                    </button>
                  ) : isLast ? (
                    <span className="text-body font-semibold text-foreground flex-shrink-0 truncate max-w-[220px]">
                      {seg.label}
                    </span>
                  ) : (
                    <span className="text-body text-muted-foreground flex-shrink-0">{seg.label}</span>
                  )}
                </span>
              );
            })}
          </div>
        </div>
        <div className="flex items-center gap-6 pl-7 pr-4 flex-shrink-0">
          {referencesBytes > 0 && (
            // 클릭 가능한 버튼으로 전환 — 우측 끝에 회수 가능한 바이트가 같이
            // 노출되고, 클릭하면 OrphanCleanupDialog 가 즉시 열려 사용자가
            // "왜 카드 합산보다 큰가" 의 이유와 다음 행동(정리)을 한 번에
            // 인지하게 한다. cleanable 이 0 이거나 fetch 실패 시 suffix 만 숨김.
            <button
              type="button"
              onClick={() => setOrphanCleanupOpen(true)}
              title={t("library.assetsStorageActionTooltip")}
              className="hidden sm:inline-flex items-center gap-1.5 text-body tabular-nums text-muted-foreground hover:text-foreground transition-colors"
            >
              <HardDrive size={13} className="opacity-70" />
              <span>{t("library.assetsStorage", { size: formatBytes(referencesBytes) })}</span>
              {cleanableBytes !== null && cleanableBytes > 0 && (
                <span className="text-text-tertiary">
                  {t("library.assetsStorageCleanable", { size: formatBytes(cleanableBytes) })}
                </span>
              )}
            </button>
          )}
          <div className="w-px h-4 bg-border-subtle flex-shrink-0" />
          <button
            /* 설정을 팝업으로 — 라이브러리 화면을 떠나지 않고 현재 위치를 유지한다.
               surface="library" 로 열어 이미지 생성 행이 라이브러리 기능 우선으로
               정렬되게 한다. */
            onClick={() => openSettings({ surface: "library" })}
            className="flex items-center gap-1.5 text-body text-muted-foreground hover:text-foreground transition-colors"
          >
            <SettingsIcon size={13} />
            <span className="hidden sm:block">{t("common.settings")}</span>
          </button>
        </div>
        {/* OS 윈도우 컨트롤(─ □ ×). Win/Linux 에서만 렌더, macOS 는 자동 숨김. */}
        <WindowControls />
      </nav>

      <DndContext
        sensors={dndSensors}
        // pointerWithin: nested droppable (폴더 행 안의 before strip 등) 의
        // 정확도가 rectIntersection 보다 우수. 그리드 카드 → 폴더 행 케이스
        // 에서도 포인터가 실제 폴더 행 영역에 들어와야 hit 으로 잡혀
        // 사용자 의도와 잘 맞는다.
        collisionDetection={pointerWithin}
        onDragStart={handleDndDragStart}
        onDragEnd={handleDndDragEnd}
        onDragCancel={handleDndDragCancel}
      >
      <div className="relative flex flex-1 min-h-0 overflow-hidden">
        {/* Immersive 모드 — 좌측 사이드바 숨김. 컴포넌트 자체를 unmount 하지
            않고 display:none 으로 숨겨 DnD 컨텍스트 구독과 내부 state 가
            토글마다 다시 mount 되지 않도록 한다. */}
        <div style={{ display: immersiveCanvas ? "none" : "contents" }}>
        <LibrarySidebar
          width={sidebarWidth}
          query={query}
          onQueryChange={setQuery}
          searchSuggestSlot={(() => {
            /* 한글 + (in-flight OR 결과 있음) 인 경우에만 행을 그린다.
               빈 결과는 KoreanSuggestRow 가 자동 숨김 처리하지만, 한글이
               아예 없으면 사이드바 헤더 라인을 늘리지 않게 여기서 짧게
               return null. */
            const trimmed = query.trim();
            if (!trimmed || !containsHangul(trimmed)) return null;
            if (dismissedKoreanQueries.has(trimmed)) return null;
            const hasResults =
              !!koreanSuggestion &&
              (koreanSuggestion.suggestedTags.length > 0 || koreanSuggestion.suggestedMoods.length > 0);
            if (!koreanSuggestLoading && !hasResults) return null;
            const applyTag = (raw: string) => {
              const tag = raw.trim().toLowerCase();
              if (!tag) return;
              setTagsFilter((prev) => {
                const include = new Set(prev.include);
                const exclude = new Set(prev.exclude);
                include.add(tag);
                exclude.delete(tag);
                return { include, exclude };
              });
              rememberKoreanQuery(trimmed);
            };
            /* mood 칩은 *무드 필터* 로 흘려보낸다 — 과거에는 tagsFilter 로
               같이 떨어져 "무드를 골랐는데 태그 필터로 잡힘" 회귀가 있었다.
               koreanSuggestion.suggestedMoods 자체가 `ai.mood_labels` 인덱스
               에서 추론된 토큰이므로, 매칭 좌표계도 moodsFilter (= mood_labels
               기반 multi 필터) 와 일치한다. */
            const applyMood = (raw: string) => {
              const mood = raw.trim().toLowerCase();
              if (!mood) return;
              setMoodsFilter((prev) => {
                const include = new Set(prev.include);
                const exclude = new Set(prev.exclude);
                include.add(mood);
                exclude.delete(mood);
                return { include, exclude };
              });
              rememberKoreanQuery(trimmed);
            };
            return (
              <KoreanSuggestRow
                loading={koreanSuggestLoading}
                suggestedTags={koreanSuggestion?.suggestedTags ?? []}
                suggestedMoods={koreanSuggestion?.suggestedMoods ?? []}
                onApplyTag={applyTag}
                onApplyMood={applyMood}
                onDismiss={() => {
                  setDismissedKoreanQueries((prev) => {
                    const next = new Set(prev);
                    next.add(trimmed);
                    return next;
                  });
                }}
              />
            );
          })()}
          ingestSlot={(
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                /* accept 화이트리스트는 더 이상 *허용 종류* 의 진실이 아니다.
                   Eagle 식 "어떤 파일이든 받기" 로 doc 카테고리를 흡수하기
                   위해 비워 두고, 진실은 detectReferenceKind / deny-list /
                   uploadReferenceFile 의 3중 가드에서 결정한다. .preflow*
                   pack 확장자는 dragdrop 으로도 import 되지만 file picker
                   에서도 보이도록 명시 유지. */
                accept="*/*,.preflowlib,.preflowpack"
                className="hidden"
                onChange={(event) => {
                  if (event.currentTarget.files) void handleFiles(event.currentTarget.files);
                  event.currentTarget.value = "";
                }}
              />
              {/* "Custom thumbnail (Select file)" 전용 input — image/* 만 받고
                  multi 비활성. onChange 가 새 라이브러리 항목을 만드는 대신
                  현재 selected 의 cover 만 갱신한다. */}
              <input
                ref={coverFileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                className="hidden"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0] ?? null;
                  void handleCoverFileSelected(file);
                  event.currentTarget.value = "";
                }}
              />
              <LibraryAddMenu
                folderBusy={eagleBusy}
                onChooseFiles={() => fileInputRef.current?.click()}
                onChooseFolder={() => void handleChooseFolder()}
                onPasteUrl={() => setPasteUrlOpen(true)}
              />
              {/* 프로젝트 즐겨찾기(최대 3) — 자주 가는 프로젝트를 핀해두고 클릭하면
                  (cross-workspace 포함) 그 프로젝트로 바로 이동(대시보드 클릭과 동일).
                  과거의 "돌아가기/이동" 버튼을 대체한다. */}
              <div className="mt-2 flex items-stretch gap-1.5">
                {pinnedProjects.map((p) => (
                  <div key={p.projectId} className="group relative min-w-0 flex-1">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void openProjectInLibrary(p.projectId, p.workspaceId);
                      }}
                      className="h-9 w-full gap-1.5 px-2 text-caption border-primary/40 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
                      style={{ borderRadius: 0 }}
                      title={p.title}
                    >
                      <Star className="h-3.5 w-3.5 shrink-0 fill-primary" />
                      <span className="truncate">{p.title}</span>
                    </Button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        removePinnedProject(p.projectId);
                      }}
                      className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center border border-border bg-background text-muted-foreground hover:text-destructive group-hover:flex"
                      style={{ borderRadius: 0 }}
                      title={t("library.sidebar.removeFavorite")}
                      aria-label={t("library.sidebar.removeFavorite")}
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </div>
                ))}
                {pinnedProjects.length < PINNED_PROJECTS_MAX && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setFavoritePickerOpen(true);
                    }}
                    className={`h-9 gap-1.5 text-caption border-border-subtle ${pinnedProjects.length === 0 ? "w-full" : "w-9 px-0"}`}
                    style={{ borderRadius: 0 }}
                    title={t("library.sidebar.addFavorite")}
                  >
                    <Plus className="h-4 w-4 shrink-0" />
                    {pinnedProjects.length === 0 && <span className="truncate">{t("library.sidebar.addFavorite")}</span>}
                  </Button>
                )}
              </div>
              {/* 업로드 진행 패널은 제거 — 결과는 우하단 토스트로 안내한다.
                  (handleFiles / handleDrop / handleUrlSubmit / paste effect) */}
            </>
          )}
          quickFilter={quickFilter}
          // Quick Filter / Smart Folder 를 누르면 폴더 선택을 함께
          // 해제 — 사이드바에서 한 번에 한 가지 "주 필터" 만 활성처럼
          // 보이게 해, 폴더 안에서 다른 메뉴를 선택했을 때 사용자가
          // 의도한 대로 그 메뉴로 컨텍스트가 넘어간다.
          onQuickFilterChange={(filter) => {
            setQuickFilter(filter);
            resetFolderSelection();
          }}
          savedFilters={savedFilters}
          activeSavedFilterId={activeSavedFilterId}
          onSavedFilterChange={(id) => {
            setActiveSavedFilterId(id);
            resetFolderSelection();
          }}
          folderRows={regularFolders}
          activeTag={activeTag}
          selectedFolderTags={selectedFolderTags}
          anchorTag={activeTag}
          // 폴더를 선택하면 Quick Filter / Smart Folder 도 기본값으로
          // 리셋 — 사이드바 전체가 "한 번에 한 가지 주 필터" 로 보이게.
          // null(= 같은 폴더 다시 눌러서 해제) 케이스도 동일하게
          // 기본값으로 두면, 다음에 어디 들어가든 일관된 출발점.
          // 단일 선택용(Pinned 단축/내부 fallback) — 다중 선택은 onFolderSelectionChange.
          onTagChange={(tag) => {
            selectSingleFolder(tag);
            setQuickFilter("all");
            setActiveSavedFilterId(null);
          }}
          // Ctrl/Shift 다중 선택 — 사이드바가 모디파이어→집합을 계산해 넘긴다.
          onFolderSelectionChange={(tags, anchor) => {
            applyFolderSelection(tags, anchor);
            setQuickFilter("all");
            setActiveSavedFilterId(null);
          }}
          recursiveActiveFolder={recursiveActiveFolder}
          onToggleRecursiveActiveFolder={(row) => {
            // 활성 폴더가 이 행과 다르면 먼저 활성화한 뒤 토글이
            // 의미 있게 켜진다. 같은 폴더면 단순 토글.
            if (activeTag !== row.tag) {
              selectSingleFolder(row.tag);
              setRecursiveActiveFolder(true);
            } else {
              setRecursiveActiveFolder((prev) => !prev);
            }
          }}
          onCreateFolder={handleCreateFolder}
          onRenameFolder={handleRenameFolder}
          onMoveFolder={handleMoveFolder}
          onDeleteFolder={handleDeleteFolder}
          onExportFolder={handleExportFolder}
          onExportFolderAsHtml={handleExportFolderAsHtml}
          onDuplicateFolder={handleDuplicateFolder}
          onOpenFolderAiSettings={(row) => {
            setFolderAiSettingsTarget(row.tag.replace(/^folder:/, ""));
          }}
          folderAiAutoClassify={folderAiAutoClassifySet}
          /* native HTML5 DnD — LibraryCard 의 OS-수준 드래그가 폴더 행에
             떨어졌을 때 FolderRow 가 직접 native dragover/drop 이벤트로
             받아 이 콜백을 호출. dnd-kit 시절의 통합 onDragEnd 분기를
             대체한다. */
          onDropReferencesToFolder={(ids, path) => {
            void handleDropReferencesToFolder(ids, path);
          }}
          onOpenBriefMatch={() => setBriefMatchOpen(true)}
          briefMatchFolders={briefMatchFolders}
          onCreateProjectFromBriefMatch={handleCreateProjectFromBriefMatch}
          activeDragId={activeDrag?.id ?? null}
          activeDragKind={activeDrag?.kind ?? null}
        />

        {/* 사이드바 ↔ 메인 사이의 리사이즈 핸들. 더블클릭 시 기본값(260 px)
            으로 복원. Dashboard 와 동일한 구현체를 props 주입 방식으로 공유. */}
        <SidebarResizeHandle
          width={sidebarWidth}
          onWidthChange={setSidebarWidth}
          defaultWidth={DEFAULT_LIBRARY_SIDEBAR_WIDTH}
          clamp={clampLibrarySidebarWidth}
          onCommit={saveLibrarySidebarWidth}
        />
        </div>

        {/* Brief Match 플라이아웃 — 사이드바 오른쪽에 도킹(absolute, 행 안에 클립).
            그리드는 그대로 살아있어 거기서 직접 선택한다. */}
        <BriefMatchFlyout
          open={briefMatchOpen}
          leftOffset={sidebarWidth}
          items={items}
          selectedItems={selectedItems}
          anchorIds={briefAnchorIds}
          onAnchorIdsChange={setBriefAnchorIds}
          briefImageIds={briefImageIds}
          onBriefImageIdsChange={setBriefImageIds}
          onApplyMoodFilter={setMoodFilter}
          onRequestBriefRerank={handleRequestBriefRerank}
          attachFolderName={
            briefAttachTarget ? normalizeFolderPath(briefAttachTarget.sourceRow.tag).split("/").pop() ?? "" : null
          }
          onAttachConfirm={(content) => handleAttachConfirm(content)}
          onClose={() => {
            setBriefMatchOpen(false);
            setBriefAttachTarget(null);
          }}
          onSaved={() => {
            void loadReferences();
          }}
          onCreated={(path) => {
            // 매칭된 레퍼런스가 담긴 폴더로 이동 → 결과를 폴더 내용으로 표시.
            // 휘발성 AI 필터를 쓰지 않으므로 다른 레퍼런스도 폴더에서 나가면 바로 보인다.
            setMoodFilter(null);
            selectSingleFolder(folderTag(path));
            setQuickFilter("all");
            setActiveSavedFilterId(null);
          }}
        />

        {/* 브리프 매치 폴더 → 프로젝트 내보내기 다이얼로그(로켓 버튼). */}
        {briefMatchExport && (
          <BriefMatchExportDialog
            open={!!briefMatchExport}
            onClose={() => setBriefMatchExport(null)}
            defaultTitle={briefMatchExport.defaultTitle}
            members={briefMatchExport.members}
            onConfirm={handleConfirmBriefMatchExport}
          />
        )}

        <main className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* Immersive 캔버스 모드일 때는 상단 툴바를 숨겨 전체 화면 작업 공간 확보. */}
          {immersiveCanvas ? null : (
          <LibraryToolbar
            filteredCount={filteredItems.length}
            totalCount={items.length}
            isCapped={items.length >= REFERENCE_LOAD_LIMIT}
            gridSize={gridSize}
            onGridSizeChange={setGridSize}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            showHidden={showHidden}
            onToggleShowHidden={() => setShowHidden((v) => !v)}
            hiddenCount={gridHiddenCount}
            activeFolderTag={canvasAllowed && activeTag?.startsWith("folder:") ? activeTag : null}
            typeFilter={typeFilter}
            onTypeFilterChange={setTypeFilter}
            typeCounts={typeCounts}
            tagsFilter={tagsFilter}
            onTagsFilterChange={setTagsFilter}
            moodsFilter={moodsFilter}
            onMoodsFilterChange={setMoodsFilter}
            moodRows={moodsList}
            foldersFilter={foldersFilter}
            onFoldersFilterChange={setFoldersFilter}
            ratingsFilter={ratingsFilter}
            onRatingsFilterChange={setRatingsFilter}
            shapesFilter={shapesFilter}
            onShapesFilterChange={setShapesFilter}
            noteFilter={noteFilterState}
            onNoteFilterChange={setNoteFilterState}
            colorFilter={colorFilter}
            onColorFilterChange={setColorFilter}
            moodFilter={moodFilter}
            onMoodFilterChange={setMoodFilter}
            moodInventoryTokens={moodInventoryTokens}
            tagRows={tagsList}
            folderRows={folders}
            koreanAliasIndex={koreanAliasIndex}
            sortKey={sortKey}
            onSortKeyChange={setSortKey}
            sortOrder={sortOrder}
            onSortOrderChange={setSortOrder}
            onClearFilters={clearFilters}
            selectedCount={selectedItems.length}
            storageUsageLabel={storageUsageLabel}
            canExportProject={Boolean(returnProjectId)}
            onRefreshStorageUsage={refreshStorageUsage}
            onCleanupOrphans={handleCleanupOrphans}
            onImportPack={() => setImportPackOpen(true)}
            onExportSelected={() => handleExportSelected()}
            onExportFiltered={handleExportFiltered}
            onExportAll={handleExportAll}
            onExportProject={handleExportProject}
            classifyQueue={classifyQueueSnapshot}
          />
          )}

          {/* Main(그리드/프리뷰) ↔ Inspector 사이를 SidebarResizeHandle 로
              분리 — 좌측 LibrarySidebar 와 동일한 패턴이지만 side="right"
              라 마우스를 *왼쪽* 으로 끌수록 인스펙터가 커진다. 기존
              CSS Grid (1fr / 360px) 는 핸들의 음수 마진 트릭이 grid item
              에서는 통하지 않아 flex 로 전환. 각 자식 컴포넌트 (<section>,
              <aside>) 는 부모의 flex-1/shrink-0 + 명시적 width 만 받으면
              내부 h-full 로직이 그대로 동작한다. */}
          <div className="flex-1 flex min-h-0 overflow-hidden">
            {/* main(<section>) 자식이 h-full 을 신뢰성 있게 받도록 wrapper 를
                flex column 으로 둔다 — 단순 block 일 때 percentage height 가
                일부 브라우저/조건에서 auto 로 떨어져 자식 영역이 부모를 밀어내
                상단 toolbar(Back to Grid) 까지 잘리는 문제를 차단한다. */}
            <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            {previewMode && selected ? (
              <LibraryPreviewPanel
                item={selected}
                items={filteredItems}
                videoRef={videoRef}
                playbackRate={playbackRate}
                onPlaybackRateChange={setPlaybackRate}
                onSelect={handlePreviewSelect}
                onBack={() => setPreviewMode(false)}
                onSetCover={handleSetCover}
                onSaveFrame={handleSaveFrame}
                onSaveLoopAsGif={handleSaveLoopAsGif}
                onCropImage={handleCropImage}
                onSetCoverFromCanvas={handleSetCoverFromCanvas}
                onSaveFrameFromCanvas={handleSaveFrameFromCanvas}
                saving={saving}
                timestampText={timestampText}
                onTimestampTextChange={setTimestampText}
                onAddTimestampNote={handleAddTimestampNote}
                onDeleteTimestampNote={handleDeleteTimestampNote}
                onEditTimestampNote={handleEditTimestampNote}
                initialSeekSec={pendingSeekSec}
                onInitialSeekConsumed={() => setPendingSeekSec(null)}
                initialFrameIndex={pendingFrameIndex}
                onInitialFrameConsumed={() => setPendingFrameIndex(null)}
                initialPageIndex={pendingPageIndex}
                onInitialPageConsumed={() => setPendingPageIndex(null)}
                highlightRegionNoteId={pendingRegionNoteId}
                onHighlightRegionConsumed={() => setPendingRegionNoteId(null)}
                onOpenInDefaultApp={handleOpenDefault}
              />
            ) : viewMode === "canvas" && canvasAllowed && activeTag?.startsWith("folder:") ? (
              /* Canvas 뷰 — 같은 filteredItems 를 받지만 grid/list 와 달리
                 자유 배치 + transform. doc 은 내부에서 자동 제외.
                 selectedIds 는 부모와 양방향 공유 — Inspector 가 같은
                 선택 상태를 그대로 본다.

                 key={folderContextKey} 로 강제 remount: 폴더 전환 시 같은
                 render 사이클 안에서 reload / camera / reconciliation / save
                 effect 가 *이전 폴더의 state* 를 본 채로 *새 폴더 키* 로 발동
                 되어 잘못된 layout 이 영구화되던 race 가 있었다. key 가 바뀌면
                 React 가 인스턴스를 완전히 unmount + 새로 mount 하므로 모든
                 state/effect 가 깨끗하게 초기화 — 이전 폴더의 마지막 변경은
                 unmount 직전에 save effect 가 이미 영구화한 상태라 손실 없음. */
              <LibraryCanvas
                key={deriveLibraryContextKey(activeTag, quickFilter)}
                items={filteredItems}
                // 필터 무관 *라이브러리 전체에 존재하는* 항목 id (trash 포함) —
                // reconciliation 이 *영구 삭제된* (items 배열 자체에서 빠진)
                // 항목만 layout 에서 정리하도록 한다. trash 는 items 안에
                // 그대로 남아 있어 toast 되돌리기 / Ctrl+Z 로 복구 시 원래
                // 자리 그대로 복귀. 필터로 일시 가려진 항목의 위치/노트/연결도
                // 같은 이유로 보존.
                allKnownItemIds={allKnownItemIds}
                // 캔버스 viewport 가 focus 인 상태에서 Ctrl/Cmd+Z 가 눌렸을 때
                // *페이지 단위* 가장 최근 undoBar 액션을 먼저 가로채도록 한다.
                // 슬롯이 비었으면 false 가 돌아와 캔버스 자체의 layout undo 로
                // 자연스럽게 폴백. 두 동작 모두 같은 ref 슬롯을 공유하므로
                // 더블 발동 위험 없음 — 누가 먼저 호출하든 즉시 consume.
                tryRunLatestUndo={tryRunLatestUndo}
                folderContextKey={deriveLibraryContextKey(activeTag, quickFilter)}
                selectedIds={selectedIds}
                onSelect={handleSelectGridItem}
                onMarqueeSelect={handleMarqueeSelect}
                onDoubleClick={handleGridDoubleClick}
                immersive={immersiveCanvas}
                onToggleImmersive={() => setImmersiveCanvas((v) => !v)}
                // 그리드 우클릭과 동일한 프로젝트 연동 액션을 캔버스 카드 메뉴에서도
                // 재사용. runCanvasItemAction 이 현재 선택을 snapshot 으로 박아
                // 다중/단건을 grid 와 동일 정책으로 결정한다.
                onAddToBrief={(item) => runCanvasItemAction(item, handleAddToBrief)}
                onAddToAgent={(item) => runCanvasItemAction(item, handleAddToAgent)}
                onAddToConti={(item) => runCanvasItemAction(item, handleAddToConti)}
                onPromoteToAsset={(item) => runCanvasItemAction(item, handleOpenPromoteDialog)}
                onMoveToTrash={(item) => void runCanvasItemAction(item, handleMoveToTrash)}
                onCreateVariation={(item) => runCanvasItemAction(item, handleCreateVariation)}
                generatingIds={variationGeneratingIds}
                onItemCreated={upsertUploadedItem}
                variationFlyoutOpen={variationTarget !== null}
                onInjectToVariation={(ids) => {
                  // 캔버스에서 이미지를 변형 플라이아웃 참조 드롭존 위로 끌어다
                  // 놓았을 때 — 플라이아웃이 열려 있을 때만 참조로 추가.
                  if (!variationFlyoutOpenRef.current) return;
                  setVariationInjectIds((prev) => Array.from(new Set([...prev, ...ids])));
                }}
                onCanvasFileDrop={(files) => void handleFiles(files)}
                onCanvasUrlDrop={(url) => {
                  /* 캔버스에 URL 드롭 — grid 의 URL 드롭과 동일 파이프.
                     uploadOptions 가 폴더 컨텍스트 태그를 자동 attach 하므로
                     생성된 link 가 즉시 같은 폴더에 소속되어 reconciliation
                     이 캔버스의 드롭 좌표 anchor 로 자동 배치한다. */
                  createLinkReference(url, uploadOptions)
                    .then((item) => {
                      upsertUploadedItem(item);
                      maybeAutoClassifyImport(item);
                      toast({
                        title: uploadFolderLabel
                          ? t("library.toast.savedTo", { folder: uploadFolderLabel })
                          : t("library.toast.referenceSaved"),
                        description: t("library.toast.droppedUrlAdded"),
                      });
                    })
                    .catch((err) => {
                      const message = err instanceof Error ? err.message : String(err);
                      toast({
                        variant: "destructive",
                        title: t("library.toast.dropFailed"),
                        description: message,
                      });
                    });
                }}
              />
            ) : (
              <LibraryGrid
                items={filteredItems}
                selectedId={selectedId}
                selectedIds={selectedIds}
                duplicateCounts={duplicateCounts}
                usageCounts={usageCounts}
                loading={loading}
                error={error}
                isDragging={isDragging}
                gridSize={gridSize}
                viewMode={viewMode}
                sortKey={sortKey}
                sortOrder={sortOrder}
                onSortKeyChange={setSortKey}
                onSortOrderChange={setSortOrder}
                viewSupportsUpload={viewSupportsUpload}
                quickFilter={quickFilter}
                onSelect={handleSelectGridItem}
                onDoubleClick={handleGridDoubleClick}
                /* native HTML5 DnD 카드-간 재정렬 — LibraryCard 의 onDrop 이
                   호출. 이전엔 dnd-kit 의 통합 onDragEnd 분기였다. */
                onReorderReferences={(ids, targetId) =>
                  handleReorderReferences(ids, targetId)
                }
                onMarqueeSelect={handleMarqueeSelect}
                onChooseFiles={() => fileInputRef.current?.click()}
                onChooseFolder={() => void handleChooseFolder()}
                onDragStateChange={setIsDragging}
                onDrop={handleDrop}
                hasCopiedTags={Boolean(copiedTags)}
                onOpenDefault={handleOpenDefault}
                onOpenSourceUrl={handleOpenSourceUrl}
                onShowInFolder={handleShowInFolder}
                onCopyFilePath={handleCopyFilePath}
                onCopySelection={handleCopySelectionToClipboard}
                onCopyTags={handleCopyTags}
                onPasteTags={handlePasteTags}
                folderRows={folders}
                activeFolderTag={activeTag?.startsWith("folder:") ? activeTag : null}
                onAddToFolder={handleAddToFolder}
                onMoveToFolder={handleMoveToFolder}
                onRemoveFromActiveFolder={handleRemoveFromActiveFolder}
                onExportSelected={handleExportSelected}
                onExportSelectedAsHtml={handleExportSelectedAsHtml}
                onTogglePin={handleTogglePin}
                onDuplicate={handleDuplicateReference}
                onCreateVariation={handleCreateVariation}
                generatingIds={variationGeneratingIds}
                onRename={handleRenameReference}
                onSearchByImage={handleSearchByImage}
                onClassify={handleClassifyReference}
                onAcceptSuggestions={handleAcceptSuggestionsReference}
                onRegenerateThumbnail={handleRegenerateThumbnail}
                onSetCoverFromFile={handleSetCoverFromFile}
                onSetCoverFromClipboard={handleSetCoverFromClipboard}
                onMergeDuplicates={handleMergeDuplicates}
                onMoveToTrash={handleMoveToTrash}
                onRestore={handleRestoreReference}
                onPermanentlyDelete={handlePermanentlyDelete}
                onAddToBrief={handleAddToBrief}
                onAddToAgent={handleAddToAgent}
                onAddToConti={handleAddToConti}
                onPromoteToAsset={handleOpenPromoteDialog}
                gridHiddenIds={gridHiddenIds}
                onHideFromGrid={handleHideFromGrid}
                onUnhideFromGrid={handleUnhideFromGrid}
                // returnProjectId 가 없어도 picker 가 떠 직접 선택 가능 → 항상 true.
                // 자료 kind / deleted_at 게이트는 LibraryGrid 가 항목별로 계속 적용.
                canAddToProject={true}
                onItemDimensionsMeasured={handleItemDimensionsMeasured}
              />
            )}
            </div>

            {/* Immersive 모드 — 우측 인스펙터 + resize handle 숨김. unmount
                대신 display:none 으로 보존(편집 중인 메타데이터 등 state). */}
            <div style={{ display: immersiveCanvas ? "none" : "contents" }}>
            <SidebarResizeHandle
              width={inspectorWidth}
              onWidthChange={setInspectorWidth}
              defaultWidth={DEFAULT_LIBRARY_INSPECTOR_WIDTH}
              clamp={clampLibraryInspectorWidth}
              onCommit={saveLibraryInspectorWidth}
              side="right"
              ariaLabel={t("library.page.resizeInspector")}
            />

            <div className="shrink-0 min-h-0" style={{ width: inspectorWidth }}>
            <LibraryInspector
              selected={selected}
              selectedItems={selectedItems}
              hideMediaPreview={previewMode}
              selectedHiddenByFilters={selectedHiddenByFilters}
              selectedDuplicateCount={selectedDuplicateCount}
              scopeLabel={toolbarTitle}
              scopeItemCount={filteredItems.length}
              scopeTotalSize={scopeTotalSize}
              selectedUsageCount={selected ? usageCounts[selected.id] ?? 0 : 0}
              selectedUsageLocations={selectedUsageLocations}
              onOpenUsageLocation={handleOpenUsageLocation}
              selectedPromotedAssetCount={selectedPromotedAssetCount}
              selectedSuggestions={selectedSuggestions}
              videoRef={videoRef}
              playbackRate={playbackRate}
              onPlaybackRateChange={setPlaybackRate}
              saving={saving}
              aiBusy={selectedAiBusy}
              classifyStage={selectedClassifyStage}
              classifyProgress={selectedClassifyProgress}
              editTitle={editTitle}
              editTags={editTags}
              editNotes={editNotes}
              editRating={editRating}
              editSourceUrl={editSourceUrl}
              timestampText={timestampText}
              onEditTitleChange={setEditTitle}
              onEditTagsChange={setEditTags}
              onEditNotesChange={setEditNotes}
              onEditRatingChange={setEditRating}
              onEditSourceUrlChange={setEditSourceUrl}
              onTimestampTextChange={setTimestampText}
              onSaveMetadata={handleSaveMetadata}
              onToggleFavorite={handleToggleFavorite}
              onSetCover={handleSetCover}
              onSaveFrame={handleSaveFrame}
              onAddTimestampNote={handleAddTimestampNote}
              onDeleteTimestampNote={handleDeleteTimestampNote}
              onEditTimestampNote={handleEditTimestampNote}
              onClassify={handleClassifySelected}
              onAcceptSuggestions={handleAcceptSuggestions}
              onDelete={handleDeleteSelected}
              onRestoreSelected={handleRestoreSelected}
              onCopyText={handleCopyText}
              onExportSelected={() => handleExportSelected()}
              onPromoteToAsset={
                /* Promote to Asset 은 정지 이미지(image/webp)이거나 썸네일이
                   있는 자료(gif/video/URL 포함)에서 노출. 비-이미지 kind 는
                   썸네일을 에셋 사진으로 쓴다. 사용 가능한 이미지가 없으면
                   콜백을 undefined 로 내려 버튼을 숨긴다. */
                selected && (selected.kind === "image" || selected.kind === "webp" || Boolean(selected.thumbnail_url))
                  ? () => handleOpenPromoteDialog(selected)
                  : undefined
              }
              availableFolders={folders}
              onAddTag={handleAddTagToSelected}
              onRemoveTag={handleRemoveTagFromSelected}
              onAddFolder={handleAddFolderToSelected}
              onRemoveFolder={handleRemoveFolderFromSelected}
              onSetRating={handleSetSelectedRating}
              onClearSourceUrl={handleClearSelectedSourceUrl}
              onJumpToTimestamp={handleJumpToTimestamp}
              canPromoteToAsset={Boolean(
                returnProjectId
                && selected
                && (selected.kind === "image" || selected.kind === "webp" || Boolean(selected.thumbnail_url))
                && Boolean(selected.thumbnail_url || selected.file_url)
                && !selected.deleted_at,
              )}
              briefMatchEntry={briefMatchEntry}
              briefMatchImages={briefMatchImages}
              onCreateProjectFromBrief={
                briefMatchFolderPath
                  ? () => handleCreateProjectFromBriefMatch(briefMatchFolderPath)
                  : undefined
              }
            />
            </div>
            </div>
          </div>
        </main>
      </div>

      {/* DragOverlay — reference 카드를 드래그할 때만 보이는 가벼운 chip.
          폴더 드래그는 사이드바 안에서 시각이 명확하므로 별도 overlay 없이
          기본 ghost 만으로 충분. dropAnimation null 로 두면 떨어뜨리는 위치
          위에서 자연스럽게 사라진다. modifiers 에 snapTopLeftToCursor 를
          넣어 chip 이 항상 cursor 우하단에 붙도록 한다. */}
      <DragOverlay dropAnimation={null} modifiers={[snapTopLeftToCursor]}>
        {activeDrag?.kind === "reference" ? (
          <div
            className="pointer-events-none flex items-center gap-2 rounded-none border border-primary/60 bg-popover px-2.5 py-1.5 text-xs text-foreground shadow-lg"
          >
            <FolderInput className="h-3.5 w-3.5 text-primary" />
            <span className="line-clamp-1 max-w-[240px]">
              {activeDrag.item?.title ?? t("library.page.referenceFallback")}
            </span>
            {activeDrag.ids && activeDrag.ids.length > 1 ? (
              <span className="ml-1 inline-flex h-4 min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-2xs font-semibold tabular-nums text-primary-foreground">
                {activeDrag.ids.length}
              </span>
            ) : null}
          </div>
        ) : null}
      </DragOverlay>
      </DndContext>

      <PasteUrlDialog
        open={pasteUrlOpen}
        value={urlInput}
        onOpenChange={setPasteUrlOpen}
        onValueChange={setUrlInput}
        onSubmit={handleUrlSubmit}
      />
      <EagleImportDialog
        open={eagleImportOpen}
        busy={eagleBusy}
        root={eagleRoot}
        preview={eaglePreview}
        result={eagleResult}
        onOpenChange={setEagleImportOpen}
        onSelectLibrary={handleSelectEagle}
        onRunImport={handleImportEagle}
      />
      <PromoteToAssetDialog
        open={Boolean(promoteTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setPromoteTarget(null);
            setPromoteProjectId(null);
          }
        }}
        reference={promoteTarget}
        projectId={promoteProjectId ?? returnProjectId}
        targetWorkspaceId={resolveProjectWorkspaceId(promoteProjectId ?? returnProjectId)}
        onCompleted={handlePromoteCompleted}
      />
      <ProjectPickerDialog
        open={Boolean(projectPicker)}
        onOpenChange={(open) => {
          if (!open) setProjectPicker(null);
        }}
        actionLabel={
          projectPicker
            ? projectPicker.target === "brief"
              ? t("library.toast.target.brief")
              : projectPicker.target === "agent"
                ? t("library.toast.target.agent")
                : projectPicker.target === "promote"
                  ? t("library.promoteToAsset.title")
                  : t("library.toast.target.conti")
            : ""
        }
        onPick={handlePickProject}
      />
      <ProjectPickerDialog
        open={favoritePickerOpen}
        onOpenChange={setFavoritePickerOpen}
        actionLabel={t("library.sidebar.pickFavorite")}
        excludeProjectIds={pinnedProjects.map((p) => p.projectId)}
        onPick={(p) => addPinnedProject(p)}
      />
      {exportDialog ? (
        <ExportPackDialog
          open={Boolean(exportDialog)}
          onOpenChange={(open) => {
            if (!open) setExportDialog(null);
          }}
          scope={exportDialog.scope}
          scopeLabel={exportDialog.scopeLabel}
          ids={exportDialog.ids}
          folderTag={exportDialog.folderTag}
          projectId={exportDialog.projectId}
          itemCount={exportDialog.itemCount}
        />
      ) : null}
      {htmlExportDialog ? (
        <HtmlExportDialog
          open={Boolean(htmlExportDialog)}
          onOpenChange={(open) => {
            if (!open) setHtmlExportDialog(null);
          }}
          scope={htmlExportDialog.scope}
          scopeLabel={htmlExportDialog.scopeLabel}
          ids={htmlExportDialog.ids}
          folderTag={htmlExportDialog.folderTag}
          itemCount={htmlExportDialog.itemCount}
          sizeBytes={htmlExportDialog.sizeBytes}
          folderScope={htmlExportDialog.folderScope}
        />
      ) : null}
      <VideoConvertDialog
        open={convertCandidates != null}
        files={convertCandidates ?? []}
        targetBytes={VIDEO_CONVERT_TARGET_BYTES}
        maxOriginalBytes={REFERENCE_UPLOAD_MAX_BYTES}
        onConfirm={() => {
          const files = convertCandidates ?? [];
          setConvertCandidates(null);
          void runVideoConversions(files);
        }}
        onUploadOriginal={() => {
          const files = convertCandidates ?? [];
          setConvertCandidates(null);
          // 1GB 이하만 원본 업로드, 초과분은 원본 저장 불가라 변환 경로로.
          const originals = files.filter((f) => f.size <= REFERENCE_UPLOAD_MAX_BYTES);
          const mustConvert = files.filter((f) => f.size > REFERENCE_UPLOAD_MAX_BYTES);
          if (originals.length > 0) void uploadFilesDirect(originals);
          if (mustConvert.length > 0) void runVideoConversions(mustConvert);
        }}
        onCancel={() => setConvertCandidates(null)}
      />
      <PackImportDialog
        open={importPackOpen}
        onOpenChange={(next) => {
          setImportPackOpen(next);
          if (!next) setInitialPackPreview(null);
        }}
        onComplete={loadReferences}
        onFoldersCreated={(paths) => {
          for (const p of paths) addUserFolderPath(p);
          setUserFolderPaths(getUserFolderPaths());
        }}
        initialPreview={initialPackPreview}
        destinationFolderPath={uploadFolderTag ? uploadFolderTag.replace(/^folder:/, "") : null}
        folderLabel={uploadFolderLabel}
        forceFavorite={uploadAsFavorite}
      />
      <FolderEditDialog
        open={Boolean(folderEdit)}
        mode={folderEdit?.mode ?? "create"}
        parentPath={folderEdit?.parentPath}
        initialPath={folderEdit?.row ? normalizeFolderPath(folderEdit.row.tag) : null}
        onOpenChange={(open) => {
          if (!open) setFolderEdit(null);
        }}
        onSubmit={(path) => {
          if (folderEdit?.mode === "rename") void confirmRenameFolder(path);
          else confirmCreateFolder(path);
        }}
      />
      <FolderAiSettingsDialog
        folderPath={folderAiSettingsTarget}
        onOpenChange={(open) => {
          if (!open) setFolderAiSettingsTarget(null);
        }}
      />
      <FolderDeleteDialog
        open={Boolean(folderDeleteTarget)}
        folderPath={folderDeleteTarget ? normalizeFolderPath(folderDeleteTarget.tag) : null}
        affectedCount={folderDeleteTarget ? folderCount(folderDeleteTarget.tag) : 0}
        onOpenChange={(open) => {
          if (!open) setFolderDeleteTarget(null);
        }}
        onConfirm={(opts) => void confirmDeleteFolder(opts)}
      />
      <FolderPickerDialog
        open={Boolean(folderPicker)}
        title={folderPicker?.mode === "move" ? t("library.page.moveToFolder") : t("library.page.addToFolder")}
        description={t("library.page.selectedRefsCount", { n: folderPicker ? selectedIdsForItem(folderPicker.item).length : 0 })}
        folders={folders}
        onOpenChange={(open) => {
          if (!open) setFolderPicker(null);
        }}
        onPick={(path) => void confirmPickFolder(path)}
      />
      {/* 폴더 자체를 다른 부모 아래로 옮기는 두 번째 picker 인스턴스.
          후보 목록에서 자기 자신과 자기 자손을 제외 — 자기 안으로
          이동하는 cycle 방지. ref-item 단위로 폴더를 고르는 위쪽
          dialog 와 의도가 달라 같은 컴포넌트를 별 인스턴스로 둠. */}
      <FolderPickerDialog
        open={Boolean(folderMoveTarget)}
        title={folderMoveTarget ? t("library.page.movePathTitle", { path: normalizeFolderPath(folderMoveTarget.tag).split("/").pop() ?? "" }) : t("library.page.moveFolderTitle")}
        description={t("library.page.pickParentDesc")}
        folders={folderMoveTarget
          ? folders.filter((row) => {
              const candidate = normalizeFolderPath(row.tag);
              const self = normalizeFolderPath(folderMoveTarget.tag);
              return candidate !== self && !candidate.startsWith(`${self}/`);
            })
          : folders}
        onOpenChange={(open) => {
          if (!open) setFolderMoveTarget(null);
        }}
        onPick={(path) => void confirmMoveFolder(path)}
      />
      <OrphanCleanupDialog
        open={orphanCleanupOpen}
        onOpenChange={setOrphanCleanupOpen}
        onComplete={(result) => {
          toast({ title: t("library.toast.orphanCleanupComplete"), description: t("library.toast.orphanCleanupDesc", { n: result.filesDeleted, size: formatBytes(result.bytesFreed) }) });
          void refreshStorageUsage();
        }}
      />
      <DuplicateMergeDialog
        open={Boolean(duplicateMerge)}
        keep={duplicateMerge?.keep ?? null}
        mergeItems={duplicateMerge?.mergeItems ?? []}
        onOpenChange={(open) => {
          if (!open) setDuplicateMerge(null);
        }}
        onConfirm={() => void confirmDuplicateMerge()}
      />
      <RenameReferenceDialog
        open={Boolean(renameTarget)}
        reference={renameTarget}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
        onSubmit={(title) => void confirmRenameReference(title)}
      />
      <VariationFlyout
        source={variationTarget}
        anchorId={variationTarget?.id ?? null}
        inFlight={variationInFlight}
        libraryInjected={variationInjected}
        onRemoveLibraryInjected={(id) =>
          setVariationInjectIds((prev) => prev.filter((x) => x !== id))
        }
        onClose={() => setVariationTarget(null)}
        onSubmit={(params) => handleVariationSubmit(params)}
      />
      <AlertDialog
        open={permanentDeleteTargets.length > 0}
        onOpenChange={(open) => {
          if (!open) setPermanentDeleteTargets([]);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("library.page.permDeleteTitle", { n: permanentDeleteTargets.length, s: permanentDeleteTargets.length === 1 ? "" : "s" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("library.page.permDeleteDesc", { s: permanentDeleteTargets.length === 1 ? "" : "s" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmPermanentDelete()} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {t("library.page.permDeleteAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default LibraryPage;
