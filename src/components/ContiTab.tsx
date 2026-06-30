import {
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
  useSyncExternalStore,
  lazy,
  Suspense,
  type Dispatch,
  type SetStateAction,
} from "react";
import { supabase } from "@/lib/supabase";
import { deleteStoredFile, deleteStoredFileIfUnreferenced, normalizeStorageUrl } from "@/lib/storageUtils";
import { generateConti, styleTransfer, IMAGE_SIZE_MAP, buildProjectAssetsCache } from "@/lib/conti";
import type { VideoFormat, BriefAnalysis, GeneratingStage, ProjectAssetsCache } from "@/lib/conti";
import { computeSceneGroups, materializeSequences } from "@/lib/sceneGrouping";
import { getImageModelDefault, getGptQualityDefault, IMAGE_GEN_MODEL_LABELS } from "@/lib/imageGenPreference";
import { generateTransitionFrame } from "@/lib/transitions";
import { DEFAULT_TRANSITION_KEY, TRANSITION_NONE, TRANSITION_MAP, normalizeTransitionKey } from "@/lib/transitionGrammar";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { scrollToScene } from "@/lib/scrollToScene";
import { friendlyGenerationError } from "@/lib/friendlyError";
import { useIsMobile } from "@/hooks/use-mobile";
import { computeRelativeTime } from "@/lib/dashboardCardHelpers";

// ContiStudio is heavy (inpainting canvas, AI calls). Load on demand to keep
// initial Storyboard tab payload small.
const ContiStudio = lazy(() =>
  import("@/components/ContiStudio").then((m) => ({ default: m.ContiStudio })),
);
import {
  Sparkles,
  Film,
  Download,
  RefreshCw,
  Loader2,
  Paintbrush,
  Plus,
  Trash2,
  GripVertical,
  Columns2,
  Upload,
  History,
  RotateCcw,
  X,
  LayoutList,
  LayoutGrid,
  Copy,
  Cpu,
  Minus,
  ImageIcon,
  Eye,
  EyeOff,
  FileText,
  ArrowRightLeft,
  Check,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  Layers,
  Images,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
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
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  DragOverlay,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  horizontalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import {
  Scene,
  Asset,
  ProjectInfo,
  SceneVersion,
  StylePreset,
  Props,
  ViewMode,
  ContiInfoVisibility,
  DEFAULT_CONTI_INFO_VISIBILITY,
  CONTI_INFO_FIELD_ORDER,
  sceneGroupColor,
  KR,
  KR_BG,
  KR_BG2,
  KR_BORDER2,
  NONE_ID,
  ACFG,
  ASSET_ICON,
  ASPECT_CLASS,
  MAX_HISTORY,
  normalizeScenesSketches,
  normalizeGridHistory,
} from "@/components/conti/contiTypes";
import { setCamVarGen } from "@/components/conti/camVarGridState";
import {
  TagChip,
  resolveAsset,
  InlineField,
  LocationField,
  MetaRows,
  DescriptionField,
  SidePanel,
} from "@/components/conti/contiInternals";
import { SortableContiCard } from "@/components/conti/SortableContiCard";
import { RelightModal, type RelightSubmit } from "@/components/conti/RelightModal";
import { CameraVariationsModal } from "@/components/conti/CameraVariationsModal";
import { ChangeAngleModal, type ChangeAngleSubmit } from "@/components/conti/ChangeAngleModal";
import { StyleTransferConfirmModal } from "@/components/conti/StyleTransferConfirmModal";
import { PhotoStar } from "@/components/icons/PhotoStar";
import { GenerateAllModal } from "@/components/conti/GenerateAllModal";
import { SceneImageCropModal } from "@/components/conti/SceneImageCropModal";
import { useT, useUiLanguage } from "@/lib/uiLanguage";

// ─── 모듈 레벨 상태 ────────────────────────────────────────────
// 탭 이동(ContiTab unmount → remount)에도 진행 중인 generation 의 로딩 상태가 보존되도록
// 모든 로딩 관련 상태를 모듈 store로 끌어올리고 useSyncExternalStore 로 구독한다.

type LoadingFields = {
  generatingSceneIds: Set<string>;
  editGeneratingIds: Set<string>;
  uploadingSceneIds: Set<string>;
  styleTransferringIds: Set<string>;
  queuedSceneIds: Set<string>;
  sceneStages: Record<string, GeneratingStage>;
  generatingVersionId: string | null;
  generatingSceneVersionMap: Record<string, string | null>;
  generatingAll: boolean;
  styleTransferring: boolean;
  generateProgress: { done: number; total: number } | null;
  styleTransferProgress: { done: number; total: number } | null;
  // ── Storyboard sheet in-flight state (Phase 3) ──
  // Lifted into the module store so the loading UI survives ContiTab
  // unmount/remount (e.g. visiting another project and coming back). The
  // generation promise keeps running regardless; previously these were local
  // useState so the UI lost track of it and users double-generated.
  storyboardTesting: boolean;
  storyboardPlanning: boolean;
  storyboardApplyingId: string | null;
  sheetRefineProgress: { done: number; total: number } | null;
  /** Which sheet's cuts are currently applied to the conti (drives 적용됨 badge). */
  appliedSheetId: string | null;
};

const _loadingByProject = new Map<string, LoadingFields>();
const _loadingListenersByProject = new Map<string, Set<() => void>>();
const _cacheBustersByProject = new Map<string, Record<number, number>>();
const _sceneStateByProject = new Map<string, { scenes: Scene[]; activeVersionId: string | null }>();
// scene state 모듈 store 에 구독자를 둔다. 탭 이동으로 컴포넌트가 언마운트된 뒤에도
// 계속 돌고 있는 스타일 변형/전체 생성 배치 루프가 saveSceneState 로 최신 상태를 쓰면,
// 리마운트된 인스턴스가 이 구독을 통해 React state 를 동기화해 UI 에 새 이미지를 즉시 반영한다.
const _sceneStateListenersByProject = new Map<string, Set<() => void>>();
// versions 도 모듈 캐시. 버전 탭 바는 versions.length > 0 게이트라, fetch 가
// 도착하기 전엔 바가 아예 안 그려져서 카드 그리드가 위로 올라왔다가 fetch 후
// 바가 들어오며 jolt 가 났다. 첫 mount 이후엔 캐시에서 동기적으로 hydrate.
const _versionsByProject = new Map<string, SceneVersion[]>();
const CONTI_PENDING_GENERATE_KEY_PREFIX = "preflow_conti_pending_generate:";
const CONTI_PENDING_SINGLE_KEY_PREFIX = "preflow_conti_pending_single:";

// 버전 탭 전용 폰트 체인. tailwind 의 font-mono 와 동일한 mono 폴백을 유지하되
// generic `monospace` 앞에 Pretendard 를 끼워, 라틴/숫자(ver. 1)는 그대로 mono 로
// 두면서 한글 글리프(버전·새로 만들기)만 Pretendard 로 렌더되게 한다. (mono 체인엔
// 한글이 없어 기존엔 Windows 시스템 고딕으로 폴백돼 어색했음.)
const VERSION_TAB_FONT_FAMILY =
  '"SF Mono", "Cascadia Mono", "Cascadia Code", "Consolas", "Liberation Mono", "Pretendard Variable", "Pretendard", monospace';

/** export 컨테이너가 쓰는 폰트 패밀리. 앱이 로드하는 실제 폰트 이름은
 *  "Pretendard Variable"(CDN)인데, 과거 export 는 등록돼 있지 않은 `Pretendard`
 *  만 지정해 항상 시스템 폰트로 폴백됐다. macOS(Apple SD Gothic Neo) 폴백에서
 *  html2canvas 가 한글 advance width 를 잘못 측정해 글자가 겹쳐 깨지던 원인. */
const EXPORT_FONT_FAMILY = '"Pretendard Variable", Pretendard, Inter, sans-serif';

/** PDF/PNG/ZIP export 의 html2canvas 캡처 전에 호출 — export 에 쓰는 Pretendard
 *  Variable weight 들을 명시적으로 로드하고 document.fonts.ready 를 기다린다.
 *  CDN 비동기 로드라 캡처 시점에 폰트가 준비 안 돼 있으면(특히 macOS) 폴백
 *  폰트로 렌더돼 한글이 깨진다. 캔버스 노트 렌더러(LibraryCanvas)가 이미 쓰는
 *  것과 같은 안전장치를 export 경로에도 적용. best-effort — 실패해도 export 는 진행. */
async function ensureExportFontsReady(): Promise<void> {
  try {
    if (typeof document === "undefined" || !document.fonts) return;
    await Promise.all([
      document.fonts.load('400 15px "Pretendard Variable"'),
      document.fonts.load('500 15px "Pretendard Variable"'),
      document.fonts.load('600 17px "Pretendard Variable"'),
      document.fonts.load('700 17px "Pretendard Variable"'),
    ]);
    await document.fonts.ready;
  } catch {
    /* 폰트 로드 실패해도 export 자체는 막지 않는다 */
  }
}

// 전체 생성 / 스타일 변형의 동시 실행 상한. 예전에는 상한 없이 전 씬을 한꺼번에
// 병렬로 띄워, 응답들이 비슷한 시점에 돌아오며 (이미지 디코드 + 캔버스 크롭 +
// PNG 인코딩 + 스토어/DB write-back) 메인스레드를 포화시켜 탭/워크스페이스 이동이
// 막히는 체감이 있었다. 동시 개수를 이 값으로 제한해 UI 응답성을 확보한다.
const GENERATE_CONCURRENCY = 8;

// 동시 실행 상한을 둔 워커 풀. items 를 limit 개 슬롯으로 굴리되, 슬롯이 비는 즉시
// 다음 item 을 끌어온다 (batch 가 아니라 sliding window — 가장 느린 한 개를 기다리지
// 않음). worker 는 내부에서 자체 try/catch 로 실패를 흡수하는 계약을 전제로 한다.
const runPool = async <T,>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> => {
  if (items.length === 0) return;
  const max = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const runNext = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor++;
      await worker(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: max }, () => runNext()));
};

type PendingContiGenerateJob = {
  id: string;
  projectId: string;
  versionId: string | null;
  mode: "all" | "missing";
  model: "gpt" | "nano-banana-2";
  sceneIds: string[];
  originalUrls: Record<string, string | null>;
  startedAt: number;
};

const pendingContiGenerateKey = (projectId: string) => `${CONTI_PENDING_GENERATE_KEY_PREFIX}${projectId}`;

// ── Conti view preferences (per-project, localStorage) ──
const contiInfoVisKey = (projectId: string) => `conti.infoVis.${projectId}`;
const contiShowGroupsKey = (projectId: string) => `conti.showGroups.${projectId}`;

function loadContiInfoVis(projectId: string): ContiInfoVisibility {
  if (typeof window === "undefined") return { ...DEFAULT_CONTI_INFO_VISIBILITY };
  try {
    const raw = window.localStorage.getItem(contiInfoVisKey(projectId));
    if (!raw) return { ...DEFAULT_CONTI_INFO_VISIBILITY };
    const parsed = JSON.parse(raw) as Partial<ContiInfoVisibility>;
    // Merge over defaults so newly-added fields default to visible.
    return { ...DEFAULT_CONTI_INFO_VISIBILITY, ...parsed };
  } catch {
    return { ...DEFAULT_CONTI_INFO_VISIBILITY };
  }
}

function loadContiShowGroups(projectId: string): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(contiShowGroupsKey(projectId)) === "1";
}

// Per-version "the user has manually grouped these cuts" flag. Stored in
// localStorage (migration-free) keyed by version id. When set we (a) skip the
// storyboard-sheet self-heal that would overwrite the user's `sequence`, and
// (b) feed the user's sequence grouping directly into the sheet prompt instead
// of the LLM shot plan's grouping.
const groupingLockedKey = (versionId: string) => `conti.groupingLocked.${versionId}`;
function loadGroupingLocked(versionId: string | null | undefined): boolean {
  if (!versionId || typeof window === "undefined") return false;
  return window.localStorage.getItem(groupingLockedKey(versionId)) === "1";
}
function saveGroupingLocked(versionId: string | null | undefined): void {
  if (!versionId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(groupingLockedKey(versionId), "1");
  } catch {
    /* ignore quota / privacy-mode failures */
  }
}

// When a new cut inherits a neighbour scene, carry over only its *background*
// tags (the location chip) — not the neighbour's character/item cast, which is
// per-cut. Keeps the inherited `location` and its bg reference consistent.
function inheritBackgroundTagsFrom(
  scene: { tagged_assets?: string[] } | undefined,
  assetMap: Record<string, Asset>,
): string[] {
  if (!scene?.tagged_assets?.length) return [];
  return scene.tagged_assets.filter(
    (tag) => assetMap[tag.replace(/^@/, "")]?.asset_type === "background",
  );
}

function readPendingContiGenerateJob(projectId: string): PendingContiGenerateJob | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(pendingContiGenerateKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingContiGenerateJob;
    if (!parsed?.startedAt || Date.now() - parsed.startedAt > 60 * 60 * 1000) {
      window.localStorage.removeItem(pendingContiGenerateKey(projectId));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writePendingContiGenerateJob(job: PendingContiGenerateJob) {
  try {
    window.localStorage.setItem(pendingContiGenerateKey(job.projectId), JSON.stringify(job));
  } catch {}
}

function clearPendingContiGenerateJob(projectId: string, id?: string) {
  try {
    const cur = readPendingContiGenerateJob(projectId);
    if (!id || cur?.id === id) window.localStorage.removeItem(pendingContiGenerateKey(projectId));
  } catch {}
}

type PendingContiSingleJob = {
  id: string;
  projectId: string;
  versionId: string | null;
  sceneId: string;
  sceneNumber: number;
  kind: "generate" | "regenerate" | "transition" | "change-angle" | "relight" | "inpaint";
  model?: "gpt" | "nano-banana-2";
  originalUrl: string | null;
  startedAt: number;
  body?: Record<string, any>;
};

const pendingContiSingleKey = (projectId: string) => `${CONTI_PENDING_SINGLE_KEY_PREFIX}${projectId}`;

function readPendingContiSingleJobs(projectId: string): PendingContiSingleJob[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(pendingContiSingleKey(projectId));
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const fresh = parsed.filter((job) => job?.startedAt && Date.now() - job.startedAt < 60 * 60 * 1000);
    if (fresh.length !== parsed.length) window.localStorage.setItem(pendingContiSingleKey(projectId), JSON.stringify(fresh));
    return fresh;
  } catch {
    return [];
  }
}

function writePendingContiSingleJobs(projectId: string, jobs: PendingContiSingleJob[]) {
  try {
    if (jobs.length === 0) window.localStorage.removeItem(pendingContiSingleKey(projectId));
    else window.localStorage.setItem(pendingContiSingleKey(projectId), JSON.stringify(jobs));
  } catch {}
}

function upsertPendingContiSingleJob(job: PendingContiSingleJob) {
  const jobs = readPendingContiSingleJobs(job.projectId).filter((item) => item.id !== job.id && item.sceneId !== job.sceneId);
  writePendingContiSingleJobs(job.projectId, [...jobs, job]);
}

function clearPendingContiSingleJob(projectId: string, id: string) {
  writePendingContiSingleJobs(projectId, readPendingContiSingleJobs(projectId).filter((job) => job.id !== id));
}

function clearPendingContiSingleJobsForScene(projectId: string, sceneId: string) {
  writePendingContiSingleJobs(projectId, readPendingContiSingleJobs(projectId).filter((job) => job.sceneId !== sceneId));
}

function clearContiLoadingForScene(projectId: string, sceneId: string) {
  const loading = getLoading(projectId);
  const generatingSceneIds = new Set(loading.generatingSceneIds);
  const editGeneratingIds = new Set(loading.editGeneratingIds);
  const queuedSceneIds = new Set(loading.queuedSceneIds);
  const generatingSceneVersionMap = { ...loading.generatingSceneVersionMap };
  const sceneStages = { ...loading.sceneStages };
  generatingSceneIds.delete(sceneId);
  editGeneratingIds.delete(sceneId);
  queuedSceneIds.delete(sceneId);
  delete generatingSceneVersionMap[sceneId];
  delete sceneStages[sceneId];
  patchLoading(projectId, {
    generatingSceneIds,
    editGeneratingIds,
    queuedSceneIds,
    generatingSceneVersionMap,
    sceneStages,
  });
}

function restorePendingContiSingleLoading(projectId: string, scenes: Scene[]) {
  const jobs = readPendingContiSingleJobs(projectId);
  const pending = jobs.filter((job) => {
    const scene = scenes.find((s) => s.id === job.sceneId);
    return scene && (scene.conti_image_url ?? null) === job.originalUrl;
  });
  if (pending.length === 0) return [];
  const generateJobs = pending.filter((job) => job.kind === "generate" || job.kind === "regenerate" || job.kind === "transition");
  const editJobs = pending.filter((job) => job.kind === "change-angle" || job.kind === "relight" || job.kind === "inpaint");
  patchLoading(projectId, {
    generatingSceneIds: new Set([...getLoading(projectId).generatingSceneIds, ...generateJobs.map((job) => job.sceneId)]),
    editGeneratingIds: new Set([...getLoading(projectId).editGeneratingIds, ...editJobs.map((job) => job.sceneId)]),
    generatingSceneVersionMap: {
      ...getLoading(projectId).generatingSceneVersionMap,
      ...Object.fromEntries(pending.map((job) => [job.sceneId, job.versionId])),
    },
    sceneStages: {
      ...getLoading(projectId).sceneStages,
      ...Object.fromEntries(pending.map((job) => [job.sceneId, "generating" as GeneratingStage])),
    },
  });
  return pending;
}

function contiTimestampFromName(name: string): number {
  const match = name.match(/[-_](\d{10,})\.[a-z0-9]+$/i);
  return match ? Number(match[1]) : 0;
}

async function findSavedContiUrl(projectId: string, sceneNumber: number, startedAt: number): Promise<string | null> {
  const { data } = await supabase.storage.from("contis").list(projectId, { limit: 1000 });
  const files = Array.isArray(data) ? data : [];
  const escapedScene = String(sceneNumber).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const scenePrefix = new RegExp(`^scene[-_]${escapedScene}[-_]`, "i");
  const candidates = files
    .map((file: { name?: string }) => file.name)
    .filter((name): name is string => !!name && scenePrefix.test(name))
    .map((name) => ({ name, ts: contiTimestampFromName(name) }))
    .filter((item) => item.ts >= startedAt - 5000)
    .sort((a, b) => b.ts - a.ts);
  const latest = candidates[0]?.name;
  return latest ? supabase.storage.from("contis").getPublicUrl(`${projectId}/${latest}`).data.publicUrl : null;
}

function restorePendingContiGenerateLoading(projectId: string, scenes: Scene[]): PendingContiGenerateJob | null {
  const job = readPendingContiGenerateJob(projectId);
  if (!job) return null;
  const pendingScenes = scenes.filter((scene) => {
    if (!job.sceneIds.includes(scene.id)) return false;
    return (scene.conti_image_url ?? null) === (job.originalUrls[scene.id] ?? null);
  });
  if (pendingScenes.length === 0) {
    clearPendingContiGenerateJob(projectId, job.id);
    return null;
  }
  const done = Math.max(0, job.sceneIds.length - pendingScenes.length);
  patchLoading(projectId, {
    generatingAll: true,
    generatingVersionId: job.versionId,
    queuedSceneIds: new Set(pendingScenes.map((scene) => scene.id)),
    generatingSceneIds: new Set(pendingScenes.map((scene) => scene.id)),
    generatingSceneVersionMap: Object.fromEntries(pendingScenes.map((scene) => [scene.id, job.versionId])),
    sceneStages: {
      ...getLoading(projectId).sceneStages,
      ...Object.fromEntries(pendingScenes.map((scene) => [scene.id, "queued" as GeneratingStage])),
    },
    generateProgress: { done, total: job.sceneIds.length },
  });
  return job;
}

function emptyLoading(): LoadingFields {
  return {
    generatingSceneIds: new Set(),
    editGeneratingIds: new Set(),
    uploadingSceneIds: new Set(),
    styleTransferringIds: new Set(),
    queuedSceneIds: new Set(),
    sceneStages: {},
    generatingVersionId: null,
    generatingSceneVersionMap: {},
    generatingAll: false,
    styleTransferring: false,
    generateProgress: null,
    styleTransferProgress: null,
    storyboardTesting: false,
    storyboardPlanning: false,
    storyboardApplyingId: null,
    sheetRefineProgress: null,
    appliedSheetId: null,
  };
}
function getLoading(pid: string): LoadingFields {
  let v = _loadingByProject.get(pid);
  if (!v) {
    v = emptyLoading();
    _loadingByProject.set(pid, v);
  }
  return v;
}
function patchLoading(pid: string, patch: Partial<LoadingFields>) {
  const cur = getLoading(pid);
  _loadingByProject.set(pid, { ...cur, ...patch });
  _loadingListenersByProject.get(pid)?.forEach((fn) => fn());
}
function subscribeLoading(pid: string, fn: () => void) {
  if (!_loadingListenersByProject.has(pid)) _loadingListenersByProject.set(pid, new Set());
  _loadingListenersByProject.get(pid)!.add(fn);
  return () => {
    _loadingListenersByProject.get(pid)?.delete(fn);
  };
}

function getGeneratingScenes(pid: string): Set<string> {
  return getLoading(pid).generatingSceneIds;
}
function isGeneratingAll(pid: string) {
  return getLoading(pid).generatingAll;
}
function getCacheBusters(pid: string): Record<number, number> {
  if (!_cacheBustersByProject.has(pid)) _cacheBustersByProject.set(pid, {});
  return _cacheBustersByProject.get(pid)!;
}
function getSceneState(pid: string) {
  return _sceneStateByProject.get(pid) ?? null;
}
function saveSceneState(pid: string, scenes: Scene[], activeVersionId: string | null) {
  _sceneStateByProject.set(pid, { scenes, activeVersionId });
  _sceneStateListenersByProject.get(pid)?.forEach((fn) => fn());
}
function subscribeSceneState(pid: string, fn: () => void) {
  if (!_sceneStateListenersByProject.has(pid)) _sceneStateListenersByProject.set(pid, new Set());
  _sceneStateListenersByProject.get(pid)!.add(fn);
  return () => {
    _sceneStateListenersByProject.get(pid)?.delete(fn);
  };
}

// TR card prompt building + image generation is delegated to
// `lib/transitions.ts`. That module runs a Claude pre-pass (brief +
// prev / next context + TR directive) to produce a directorial
// transition-beat description, then routes to NB2 inpaint or GPT
// Image 2 generate depending on the user's selected `contiModel`.
// See lib/transitions.ts for the full rationale.

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const VersionCompareModal = ({
  sceneNumber,
  versions,
  activeVersionId,
  videoFormat,
  onClose,
  onImport,
}: {
  sceneNumber: number;
  versions: SceneVersion[];
  activeVersionId: string | null;
  videoFormat: VideoFormat;
  onClose: () => void;
  onImport: (sceneNumber: number, imageUrl: string) => Promise<void>;
}) => {
  const t = useT();
  const aspectClass = ASPECT_CLASS[videoFormat];
  const [importingIdx, setImportingIdx] = useState<number | null>(null);
  const versionScenes = versions
    .map((v) => ({
      versionName: v.version_name || `v${v.version_number}`,
      versionIdx: v.version_number,
      isActive: v.id === activeVersionId,
      scene: (v.scenes as Scene[]).find((s) => s.scene_number === sceneNumber) ?? null,
    }))
    .filter((v) => v.scene !== null);
  if (versionScenes.length === 0) return null;
  const shotLabel = `#${String(sceneNumber).padStart(2, "0")}`;
  const title = versionScenes[0].scene?.title ?? t("conti.shotN", { n: sceneNumber });
  const handleImport = async (versionIdx: number, imageUrl: string) => {
    setImportingIdx(versionIdx);
    try {
      await onImport(sceneNumber, imageUrl);
    } finally {
      setImportingIdx(null);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        style={{ maxWidth: `${Math.min(versionScenes.length * 280 + 80, 1200)}px`, width: "90vw" }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Columns2 className="w-4 h-4" style={{ color: KR }} />
            {t("conti.compareTitle", { shot: shotLabel, title })}
          </DialogTitle>
        </DialogHeader>
        <div className="overflow-x-auto pb-2" style={{ maxHeight: "75vh" }}>
          <div
            className="grid gap-4"
            style={{ gridTemplateColumns: `repeat(${versionScenes.length}, minmax(220px, 1fr))` }}
          >
            {versionScenes.map(({ versionName, versionIdx, isActive, scene }) => (
              <div key={versionIdx} className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span
                    className="text-caption font-bold px-2 py-0.5 rounded-none text-white"
                    style={{ background: KR }}
                  >
                    {`ver.${versionIdx}`}
                  </span>
                  <span className="text-meta text-muted-foreground truncate">{versionName}</span>
                  {isActive && (
                    <span
                      className="text-2xs px-1.5 py-0.5 rounded-none font-semibold"
                      style={{ background: KR_BG, color: KR }}
                    >
                      {t("conti.versionPicker.current")}
                    </span>
                  )}
                </div>
                <div
                  className={`relative ${aspectClass} rounded-none overflow-hidden bg-background border-2`}
                  style={{ borderColor: isActive ? KR : "hsl(var(--border))" }}
                >
                  {scene?.conti_image_url ? (
                    <img src={scene.conti_image_url} className="w-full h-full object-cover" loading="lazy" decoding="async" />
                  ) : (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
                      <Film className="w-6 h-6 text-border" />
                      <span className="text-caption text-muted-foreground/40">{t("conti.versionPicker.noConti")}</span>
                    </div>
                  )}
                </div>
                {scene?.description && (
                  <p className="text-meta text-muted-foreground leading-relaxed line-clamp-3">{scene.description}</p>
                )}
                <Button
                  size="sm"
                  variant={isActive ? "ghost" : "outline"}
                  disabled={isActive || !scene?.conti_image_url || importingIdx !== null}
                  onClick={() => scene?.conti_image_url && handleImport(versionIdx, scene.conti_image_url)}
                  className="w-full gap-1.5 text-xs mt-1"
                >
                  {importingIdx === versionIdx ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      {t("conti.versionPicker.loading")}
                    </>
                  ) : isActive ? (
                    t("conti.versionPicker.current")
                  ) : !scene?.conti_image_url ? (
                    t("conti.versionPicker.noConti")
                  ) : (
                    <>
                      <RefreshCw className="w-3.5 h-3.5" />
                      {t("conti.versionPicker.useThis")}
                    </>
                  )}
                </Button>
              </div>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const HistorySheet = ({
  sceneNumber,
  sceneTitle,
  history,
  aspectClass,
  onClose,
  onRollback,
  onDelete,
}: {
  sceneNumber: number;
  sceneTitle: string | null;
  history: string[];
  aspectClass: string;
  onClose: () => void;
  onRollback: (url: string) => Promise<void>;
  onDelete: (url: string) => void;
}) => {
  const t = useT();
  const [rollingBack, setRollingBack] = useState<number | null>(null);
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-[340px] bg-card border-border overflow-y-auto">
        <SheetHeader className="mb-4">
          <SheetTitle className="flex items-center gap-2 text-label">
            <History className="w-4 h-4" style={{ color: KR }} />
            {t("conti.historyTitle", { n: String(sceneNumber).padStart(2, "0") })}
            {sceneTitle && <span className="text-muted-foreground font-normal">· {sceneTitle}</span>}
          </SheetTitle>
        </SheetHeader>
        {history.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 gap-2">
            <History className="w-8 h-8 text-border" />
            <p className="text-meta text-muted-foreground">{t("conti.history.empty")}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {history.map((url, idx) => (
              <div key={idx} className="rounded-none overflow-hidden border border-border bg-background">
                <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/50">
                  <span className="text-caption text-muted-foreground">{idx === 0 ? t("conti.history.previous") : t("conti.history.nAgo", { n: idx + 1 })}</span>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={rollingBack !== null}
                      onClick={() => onDelete(url)}
                      className="gap-1 text-caption h-6 px-2 text-muted-foreground hover:text-destructive"
                      title="Delete from history"
                    >
                      <X className="w-3 h-3" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={rollingBack !== null}
                      onClick={async () => {
                        setRollingBack(idx);
                        try {
                          await onRollback(url);
                          onClose();
                        } finally {
                          setRollingBack(null);
                        }
                      }}
                      className="gap-1 text-caption h-6 px-2"
                      style={{ color: KR }}
                    >
                      {rollingBack === idx ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <>
                          <RotateCcw className="w-3 h-3" />
                          Restore
                        </>
                      )}
                    </Button>
                  </div>
                </div>
                <div className={`relative ${aspectClass} bg-background`}>
                  <img src={url} className="w-full h-full object-cover" loading="lazy" decoding="async" />
                </div>
              </div>
            ))}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const NewVersionModal = ({
  onClose,
  onCreated,
  versions,
  activeScenes,
  projectId,
}: {
  onClose: () => void;
  onCreated: (newVersionId: string) => void;
  versions: SceneVersion[];
  activeScenes: Scene[];
  projectId: string;
}) => {
  const { toast } = useToast();
  const t = useT();
  const [name, setName] = useState("");
  const [createMethod, setCreateMethod] = useState<"copy" | "fresh">("copy");
  const [isCreating, setIsCreating] = useState(false);
  const methods = [
    {
      id: "copy" as const,
      Icon: Copy,
      title: t("conti.copyCurrentScenes"),
      desc: t("conti.copyCurrentScenesDesc"),
    },
    {
      id: "fresh" as const,
      Icon: Sparkles,
      title: t("conti.startFresh"),
      desc: t("conti.startFreshDesc"),
    },
  ];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t("conti.newVersion")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="text-xs text-muted-foreground mb-1.5 block">{t("conti.versionName")}</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="" autoFocus />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-2 block">{t("conti.startMethod")}</label>
            <div className="space-y-2">
              {methods.map((m) => {
                const isSelected = createMethod === m.id;
                return (
                  <div
                    key={m.id}
                    onClick={() => setCreateMethod(m.id)}
                    className="flex items-start gap-3 p-3 rounded-none cursor-pointer transition-colors border"
                    style={{
                      borderColor: isSelected ? KR : "hsl(var(--border))",
                      background: isSelected ? KR_BG : "transparent",
                    }}
                  >
                    <m.Icon
                      className="w-4 h-4 shrink-0 mt-0.5"
                      style={{ color: isSelected ? KR : "rgba(255,255,255,0.5)" }}
                      strokeWidth={1.75}
                    />
                    <div>
                      <div className="text-body font-semibold">{m.title}</div>
                      <div className="text-caption text-muted-foreground mt-0.5">{m.desc}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" className="text-body h-9" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={isCreating}
            className="text-white text-body h-9"
            style={{ background: KR }}
            onClick={async () => {
              setIsCreating(true);
              try {
                const maxVerNum = versions.reduce((m, v) => Math.max(m, v.version_number), 0);
                const maxOrder = versions.reduce((m, v) => Math.max(m, v.display_order ?? 0), 0);
                const versionName = name.trim() || `ver.${maxVerNum + 1}`;
                const scenesToSave =
                  createMethod === "copy"
                    ? activeScenes.map((s) => ({ ...s, conti_image_url: null, conti_image_history: [] }))
                    : [];
                const { data: inserted } = await supabase
                  .from("scene_versions")
                  .insert({
                    project_id: projectId,
                    version_number: maxVerNum + 1,
                    version_name: versionName,
                    display_order: maxOrder + 1,
                    scenes: scenesToSave as any,
                    is_active: false,
                  })
                  .select("id")
                  .single();
                toast({ title: t("conti.createdToast", { name: versionName }) });
                onCreated(inserted?.id ?? "");
                onClose();
              } catch (err: any) {
                toast({ title: t("conti.creationFailed"), description: err.message, variant: "destructive" });
              } finally {
                setIsCreating(false);
              }
            }}
          >
            {isCreating ? t("conti.creating") : t("conti.createVersion")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const FORMAT_OPTIONS = [
  { id: "pdf" as const, icon: FileText, label: "PDF", descriptionKey: "conti.export.pdfDesc", enabled: true },
  { id: "png" as const, icon: ImageIcon, label: "PNG", descriptionKey: "conti.export.pngDesc", enabled: true },
  { id: "ae" as const, icon: Film, label: "AE", descriptionKey: "conti.export.aeDesc", enabled: false },
];

const ExportModal = ({
  versions,
  currentScenes,
  activeVersionId,
  showInfo,
  videoFormat,
  projectTitle,
  onClose,
  onExportPdf,
  onExportPng,
}: {
  versions: SceneVersion[];
  currentScenes: Scene[];
  activeVersionId: string | null;
  showInfo: boolean;
  videoFormat: string;
  projectTitle: string;
  onClose: () => void;
  onExportPdf: (v: { label: string; scenes: Scene[] }[], includeInfo: boolean, cardsPerRow: number) => void;
  onExportPng: (
    v: { label: string; scenes: Scene[] }[],
    scale: number,
    mode: "page" | "individual",
    includeInfo: boolean,
    cardsPerRow: number,
  ) => void;
}) => {
  const t = useT();
  const [exportFormat, setExportFormat] = useState<"pdf" | "png" | "ae">("pdf");
  const [pngScale, setPngScale] = useState<1 | 2 | 3>(2);
  const [pngMode, setPngMode] = useState<"page" | "individual">("page");
  const [cardsPerRow, setCardsPerRow] = useState<3 | 4 | 5 | 6>(5);
  const [includeInfo, setIncludeInfo] = useState(showInfo);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
    if (activeVersionId && versions.some((v) => v.id === activeVersionId)) {
      return new Set([activeVersionId]);
    }
    return versions.length > 0 ? new Set([versions[0].id]) : new Set(["current"]);
  });
  const toggle = (id: string) =>
    setSelectedIds((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const buildSelected = () => {
    const result: { label: string; scenes: Scene[] }[] = [];
    if (selectedIds.has("current")) result.push({ label: t("export.currentWork"), scenes: currentScenes });
    for (const v of versions)
      if (selectedIds.has(v.id)) {
        const isActive = v.id === activeVersionId;
        const scenes = isActive ? currentScenes : (v.scenes as Scene[]);
        result.push({ label: v.version_name || `v${v.version_number}`, scenes });
      }
    return result;
  };
  const handleExport = () => {
    const selected = buildSelected();
    onClose();
    if (exportFormat === "pdf") {
      onExportPdf(selected, includeInfo, cardsPerRow);
    } else if (exportFormat === "png") {
      onExportPng(selected, pngScale, pngMode, includeInfo, cardsPerRow);
    }
  };

  const scaleOptions: { value: 1 | 2 | 3; label: string; detail: string }[] = [
    { value: 1, label: "1x", detail: "1600px" },
    { value: 2, label: "2x", detail: "3200px" },
    { value: 3, label: "3x", detail: "4800px" },
  ];
  const cardRowOptions: { value: 3 | 4 | 5 | 6; label: string }[] = [
    { value: 3, label: "3" },
    { value: 4, label: "4" },
    { value: 5, label: "5" },
    { value: 6, label: "6" },
  ];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t("export.title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          <div>
            <label className="text-xs text-muted-foreground mb-2 block">{t("export.format")}</label>
            <div className="grid grid-cols-3 gap-2">
              {FORMAT_OPTIONS.map((opt) => {
                const Icon = opt.icon;
                const isSelected = exportFormat === opt.id;
                return (
                  <button
                    key={opt.id}
                    disabled={!opt.enabled}
                    onClick={() => opt.enabled && setExportFormat(opt.id)}
                    className="flex flex-col items-center justify-center gap-1.5 py-4 transition-all"
                    style={{
                      background: isSelected ? "rgba(249,66,58,0.06)" : "rgba(255,255,255,0.03)",
                      border: `1px solid ${isSelected ? KR : "rgba(255,255,255,0.08)"}`,
                      borderRadius: 0,
                      opacity: opt.enabled ? 1 : 0.4,
                      cursor: opt.enabled ? "pointer" : "not-allowed",
                    }}
                  >
                    <Icon className="w-6 h-6" style={{ color: isSelected ? KR : "rgba(255,255,255,0.5)" }} />
                    <span
                      className="text-body font-semibold"
                      style={{ color: isSelected ? KR : "rgba(255,255,255,0.7)" }}
                    >
                      {opt.label}
                    </span>
                    <span className="text-caption" style={{ color: "rgba(255,255,255,0.35)" }}>
                      {t(opt.descriptionKey)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-2 block">{t("export.version")}</label>
            <div className="space-y-2 max-h-[30vh] overflow-y-auto">
              {versions.length === 0 && (
                <label
                  className="flex items-center gap-3 p-3 rounded-none cursor-pointer border"
                  style={{
                    background: "hsl(var(--background))",
                    borderColor: selectedIds.has("current") ? KR : "hsl(var(--border))",
                  }}
                >
                  <Checkbox checked={selectedIds.has("current")} onCheckedChange={() => toggle("current")} />
                  <div className="flex-1">
                    <div className="text-foreground text-body font-semibold">{t("export.currentWork")}</div>
                    <div className="text-muted-foreground/60 text-caption">{currentScenes.length} shots</div>
                  </div>
                </label>
              )}
              {versions.map((v, idx) => (
                <label
                  key={v.id}
                  className="flex items-center gap-3 p-3 rounded-none cursor-pointer border"
                  style={{
                    background: "hsl(var(--background))",
                    borderColor: selectedIds.has(v.id) ? KR : "hsl(var(--border))",
                  }}
                >
                  <Checkbox checked={selectedIds.has(v.id)} onCheckedChange={() => toggle(v.id)} />
                  <div className="flex-1 min-w-0">
                    <div className="text-foreground text-body font-semibold">
                      {`ver.${idx + 1}`} — {v.version_name || `v${v.version_number}`}
                    </div>
                    <div className="text-muted-foreground/60 text-caption">
                      {new Date(v.created_at).toLocaleDateString("en-US")} · {v.scenes.length} shots
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    {v.scenes
                      .slice(0, 3)
                      .map((s: any, i: number) =>
                        s.conti_image_url ? (
                          <img key={i} src={s.conti_image_url} className="w-7 h-5 object-cover rounded" loading="lazy" decoding="async" />
                        ) : (
                          <div key={i} className="w-7 h-5 rounded bg-muted" />
                        ),
                      )}
                  </div>
                </label>
              ))}
            </div>
          </div>

          {exportFormat === "png" && (
            <>
              <div>
                <label className="text-xs text-muted-foreground mb-2 block">{t("export.resolution")}</label>
                <div className="flex gap-2">
                  {scaleOptions.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => setPngScale(opt.value)}
                      className="flex-1 py-2 text-center transition-all"
                      style={{
                        background: pngScale === opt.value ? "rgba(249,66,58,0.06)" : "rgba(255,255,255,0.03)",
                        border: `1px solid ${pngScale === opt.value ? KR : "rgba(255,255,255,0.08)"}`,
                        borderRadius: 0,
                        cursor: "pointer",
                      }}
                    >
                      <div
                        className="text-body font-semibold"
                        style={{ color: pngScale === opt.value ? KR : "rgba(255,255,255,0.7)" }}
                      >
                        {opt.label}
                      </div>
                      <div className="text-2xs" style={{ color: "rgba(255,255,255,0.3)" }}>
                        {opt.detail}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs text-muted-foreground mb-2 block">{t("export.exportMode")}</label>
                <div className="flex gap-2">
                  {[
                    { value: "page" as const, label: t("export.pageLayout"), desc: t("export.pageLayoutDesc") },
                    { value: "individual" as const, label: t("export.individualScenes"), desc: t("export.individualScenesDesc") },
                  ].map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => setPngMode(opt.value)}
                      className="flex-1 py-2.5 px-3 text-left transition-all"
                      style={{
                        background: pngMode === opt.value ? "rgba(249,66,58,0.06)" : "rgba(255,255,255,0.03)",
                        border: `1px solid ${pngMode === opt.value ? KR : "rgba(255,255,255,0.08)"}`,
                        borderRadius: 0,
                        cursor: "pointer",
                      }}
                    >
                      <div
                        className="text-meta font-semibold"
                        style={{ color: pngMode === opt.value ? KR : "rgba(255,255,255,0.7)" }}
                      >
                        {opt.label}
                      </div>
                      <div className="text-2xs mt-0.5" style={{ color: "rgba(255,255,255,0.3)" }}>
                        {opt.desc}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {(exportFormat === "pdf" || (exportFormat === "png" && pngMode === "page")) && (
            <div>
              <label className="text-xs text-muted-foreground mb-2 block">{t("export.cardsPerRow")}</label>
              <div className="flex gap-2">
                {cardRowOptions.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setCardsPerRow(opt.value)}
                    className="flex-1 py-2 text-center transition-all"
                    style={{
                      background: cardsPerRow === opt.value ? "rgba(249,66,58,0.06)" : "rgba(255,255,255,0.03)",
                      border: `1px solid ${cardsPerRow === opt.value ? KR : "rgba(255,255,255,0.08)"}`,
                      borderRadius: 0,
                      cursor: "pointer",
                    }}
                  >
                    <span
                      className="text-body font-semibold"
                      style={{ color: cardsPerRow === opt.value ? KR : "rgba(255,255,255,0.7)" }}
                    >
                      {opt.label}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {(exportFormat === "pdf" || exportFormat === "png") && (
            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox checked={includeInfo} onCheckedChange={(v) => setIncludeInfo(!!v)} />
              <span className="text-meta text-muted-foreground">
                {t("export.includeMetadata")}
              </span>
            </label>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" className="text-body h-9" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={handleExport}
            disabled={selectedIds.size === 0 || !FORMAT_OPTIONS.find((f) => f.id === exportFormat)?.enabled}
            className="text-white text-body h-9"
            style={{ background: KR }}
          >
            {t("export.exportCta", { format: exportFormat.toUpperCase(), count: selectedIds.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const StylePickerModal = ({
  currentStyleId,
  projectId,
  onClose,
  onChanged,
}: {
  currentStyleId: string | null;
  projectId: string;
  onClose: () => void;
  onChanged: (p: StylePreset | null) => void;
}) => {
  const { toast } = useToast();
  const t = useT();
  const [presets, setPresets] = useState<StylePreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<string>(currentStyleId ?? NONE_ID);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [pendingDeletePreset, setPendingDeletePreset] = useState<StylePreset | null>(null);
  const [deletingStyle, setDeletingStyle] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);

  const confirmDeleteStyle = async (preset: StylePreset) => {
    setDeletingStyle(true);
    try {
      const isDeletingSelected = selected === preset.id;
      const isDeletingCurrent = currentStyleId === preset.id;
      const { error: detachProjectsError } = await supabase
        .from("projects")
        .update({ conti_style_id: null })
        .eq("conti_style_id", preset.id);
      if (detachProjectsError) throw detachProjectsError;
      const { error: deleteError } = await supabase
        .from("style_presets")
        .delete()
        .eq("id", preset.id);
      if (deleteError) throw deleteError;
      if (preset.thumbnail_url) {
        const urlPath = preset.thumbnail_url.split("/style-presets/")[1];
        if (urlPath) {
          const { error: storageError } = await supabase.storage
            .from("style-presets")
            .remove([decodeURIComponent(urlPath)]);
          if (storageError) throw storageError;
        }
      }
      if (isDeletingSelected || isDeletingCurrent) setSelected(NONE_ID);
      if (isDeletingCurrent) onChanged(null);
      await fetchStyles();
      toast({ title: t("conti.toast.styleDeleted", { name: preset.name }) });
      setPendingDeletePreset(null);
    } catch (err: any) {
      toast({ title: t("conti.deleteFailed"), description: err.message, variant: "destructive" });
    } finally {
      setDeletingStyle(false);
    }
  };

  const fetchStyles = useCallback(async () => {
    const { data, error } = await supabase
      .from("style_presets")
      .select("id,name,description,thumbnail_url,style_prompt,is_default")
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: true });
    if (error) throw error;
    const nextPresets = (data ?? []) as StylePreset[];
    setPresets(nextPresets);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchStyles().catch(() => setLoading(false));
  }, [fetchStyles]);

  useEffect(() => {
    setSelected(currentStyleId ?? NONE_ID);
  }, [currentStyleId]);

  const handleUploadStyle = async (file: File) => {
    if (!file.type.startsWith("image/")) return;
    setUploading(true);
    try {
      const ext = file.name.split(".").pop() ?? "png";
      const safeName = `custom-style-${Date.now()}.${ext}`.replace(/[^a-zA-Z0-9._-]/g, "_");
      const storagePath = `${projectId}/${safeName}`;
      const { error: upErr } = await supabase.storage.from("style-presets").upload(storagePath, file, { upsert: true });
      if (upErr) throw upErr;
      const { data: urlData } = supabase.storage.from("style-presets").getPublicUrl(storagePath);
      const publicUrl = urlData.publicUrl;
      const { data: inserted, error: insErr } = await supabase
        .from("style_presets")
        .insert({
          name: file.name.replace(/\.[^.]+$/, "").slice(0, 30) || "Custom",
          description: "Uploaded custom style",
          thumbnail_url: publicUrl,
          style_prompt: "Match the visual style, color palette, and artistic treatment of the reference image.",
          is_default: false,
          user_id: (await supabase.auth.getUser()).data.user?.id ?? null,
        })
        .select()
        .single();
      if (insErr) throw insErr;
      const newPreset = inserted as StylePreset;
      setPresets((prev) => [...prev, newPreset]);
      setSelected(newPreset.id);
      toast({ title: t("conti.styleUploaded", { name: newPreset.name }) });
    } catch (err: any) {
      toast({ title: t("conti.uploadFailed"), description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
      if (uploadRef.current) uploadRef.current.value = "";
    }
  };

  const handleApply = async () => {
    setSaving(true);
    try {
      if (selected === NONE_ID) {
        const { error } = await supabase.from("projects").update({ conti_style_id: null }).eq("id", projectId);
        if (error) throw error;
        onChanged(null);
        toast({ title: t("conti.styleRemoved") });
      } else {
        const preset = presets.find((p) => p.id === selected) ?? null;
        const { error } = await supabase.from("projects").update({ conti_style_id: selected }).eq("id", projectId);
        if (error) throw error;
        onChanged(preset);
        toast({ title: t("conti.styleApplied", { name: preset?.name ?? t("projectModal.style") }) });
      }
      onClose();
    } catch (err: any) {
      toast({ title: t("conti.styleChangeFailed"), description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>{t("conti.styleSelect")}</DialogTitle>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2.5 max-h-[60vh] overflow-y-auto py-1">
            <div
              onClick={() => setSelected(NONE_ID)}
              className="overflow-hidden cursor-pointer transition-all h-52 flex flex-col"
              style={{
                borderRadius: 0,
                border: selected === NONE_ID ? `2px solid ${KR}` : "1px solid rgba(255,255,255,0.07)",
                background: selected === NONE_ID ? KR_BG : "rgba(255,255,255,0.03)",
              }}
            >
              <div
                className="relative flex-1 min-h-0 overflow-hidden flex items-center justify-center"
                style={{ background: "rgba(255,255,255,0.03)" }}
              >
                <div className="flex flex-col items-center gap-1.5">
                  <div
                    className="w-8 h-8 flex items-center justify-center"
                    style={{ border: "1px solid rgba(255,255,255,0.1)", borderRadius: 0 }}
                  >
                    <svg
                      width={16}
                      height={16}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="rgba(255,255,255,0.25)"
                      strokeWidth={1.5}
                      strokeLinecap="round"
                    >
                      <line x1="4" y1="4" x2="20" y2="20" />
                    </svg>
                  </div>
                </div>
              </div>
              <div className="p-2 h-16 flex flex-col justify-start">
                <div
                  className="text-caption font-bold"
                  style={{ color: selected === NONE_ID ? KR : "#f0f0f0" }}
                >
                  {t("conti.none")}
                </div>
                <div className="text-2xs mt-0.5 line-clamp-2" style={{ color: "rgba(255,255,255,0.3)" }}>
                  {t("conti.defaultPhotorealistic")}
                </div>
              </div>
            </div>
            {(() => {
              const defaults = presets.filter((p) => p.is_default);
              const customs = presets.filter((p) => !p.is_default);
              const sorted = [...defaults, ...customs];
              return sorted.map((preset) => {
                const isSel = selected === preset.id;
                const isCustom = !preset.is_default;
                return (
                  <div
                    key={preset.id}
                    onClick={() => setSelected(preset.id)}
                    className="relative overflow-hidden cursor-pointer transition-all group h-52 flex flex-col"
                    style={{
                      borderRadius: 0,
                      border: isSel ? `2px solid ${KR}` : "1px solid rgba(255,255,255,0.07)",
                      background: isSel ? KR_BG : "rgba(255,255,255,0.03)",
                    }}
                  >
                    {isCustom && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setPendingDeletePreset(preset);
                        }}
                        className="absolute top-2 right-2 z-10 w-5 h-5 flex items-center justify-center rounded-none opacity-0 group-hover:opacity-100 transition-opacity"
                        style={{ background: "rgba(220,38,38,0.9)" }}
                      >
                        <X className="w-3 h-3 text-white" />
                      </button>
                    )}
                    <div
                      className="relative flex-1 min-h-0 overflow-hidden"
                      style={{ background: "rgba(255,255,255,0.03)" }}
                    >
                      {preset.thumbnail_url ? (
                        <img src={preset.thumbnail_url} className="w-full h-full object-cover" loading="lazy" decoding="async" />
                      ) : (
                        <div className="absolute inset-0 flex items-center justify-center">
                          <PhotoStar className="w-5 h-5" style={{ color: "rgba(255,255,255,0.15)" }} />
                        </div>
                      )}
                      {preset.is_default && (
                        <div
                          className="absolute bottom-1 left-1 font-mono text-nano font-bold uppercase px-1.5 py-0.5"
                          style={{ background: "rgba(0,0,0,0.65)", color: "#fff", borderRadius: 2 }}
                        >
                          {t("mood.default")}
                        </div>
                      )}
                    </div>
                    <div className="p-2 h-16 flex flex-col justify-start">
                      <div className="text-caption font-bold" style={{ color: isSel ? KR : "#f0f0f0" }}>
                        {preset.name}
                      </div>
                      {preset.description && (
                        <div className="text-2xs mt-0.5 line-clamp-2" style={{ color: "rgba(255,255,255,0.3)" }}>
                          {preset.description}
                        </div>
                      )}
                    </div>
                  </div>
                );
              });
            })()}
            <div
              onClick={() => !uploading && uploadRef.current?.click()}
              onDragOver={(e) => {
                if (uploading) return;
                e.preventDefault();
                e.stopPropagation();
                if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
                if (!dragOver) setDragOver(true);
              }}
              onDragEnter={(e) => {
                if (uploading) return;
                e.preventDefault();
                e.stopPropagation();
                setDragOver(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                e.stopPropagation();
                // 자식 요소로 포인터가 들어가는 dragleave 는 무시
                const related = e.relatedTarget as Node | null;
                if (related && (e.currentTarget as Node).contains(related)) return;
                setDragOver(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragOver(false);
                if (uploading) return;
                const file = Array.from(e.dataTransfer?.files ?? []).find((f) =>
                  f.type.startsWith("image/"),
                );
                if (file) {
                  handleUploadStyle(file);
                } else {
                  toast({
                    title: t("conti.onlyImageFiles"),
                    variant: "destructive",
                  });
                }
              }}
              className="overflow-hidden cursor-pointer transition-all h-52 flex flex-col"
              style={{
                borderRadius: 0,
                border: dragOver ? `2px solid ${KR}` : "1px dashed rgba(255,255,255,0.15)",
                background: dragOver ? KR_BG : "rgba(255,255,255,0.02)",
                opacity: uploading ? 0.5 : 1,
              }}
            >
              <input
                ref={uploadRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleUploadStyle(f);
                }}
              />
              <div
                className="relative flex-1 min-h-0 overflow-hidden flex items-center justify-center"
                style={{ background: dragOver ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.03)" }}
              >
                {uploading ? (
                  <Loader2 className="w-5 h-5 animate-spin" style={{ color: "rgba(255,255,255,0.3)" }} />
                ) : (
                  <Upload
                    className="w-5 h-5"
                    style={{ color: dragOver ? KR : "rgba(255,255,255,0.2)" }}
                  />
                )}
              </div>
              <div className="p-2 h-16 flex flex-col justify-start">
                <div
                  className="text-caption font-bold"
                  style={{ color: dragOver ? KR : "#f0f0f0" }}
                >
                  {uploading ? t("conti.uploading") : dragOver ? t("conti.dropImage") : t("conti.upload")}
                </div>
                <div className="text-2xs mt-0.5 line-clamp-2" style={{ color: "rgba(255,255,255,0.3)" }}>
                  {dragOver ? t("conti.releaseToUpload") : t("conti.dragDropClick")}
                </div>
              </div>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" className="text-body h-9" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={saving}
            className="text-white gap-1.5 text-body h-9"
            style={{ background: KR, borderRadius: 0 }}
            onClick={handleApply}
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
            {t("conti.apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
      <AlertDialog
        open={!!pendingDeletePreset}
        onOpenChange={(o) => {
          if (!o && !deletingStyle) setPendingDeletePreset(null);
        }}
      >
        <AlertDialogContent
          size="sm"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("conti.deleteCustomStyle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDeletePreset
                ? t("conti.deleteCustomStyleDesc", { name: pendingDeletePreset.name })
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              className="text-body h-9"
              disabled={deletingStyle}
            >
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="text-white text-body h-9"
              style={{ background: "rgba(220,38,38,0.9)" }}
              disabled={deletingStyle}
              onClick={(e) => {
                e.preventDefault();
                if (pendingDeletePreset) void confirmDeleteStyle(pendingDeletePreset);
              }}
            >
              {deletingStyle ? (
                <Loader2 className="w-3 h-3 animate-spin mr-1.5" />
              ) : null}
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
};

const RenameVersionModal = ({
  version,
  onClose,
  onRenamed,
}: {
  version: SceneVersion;
  onClose: () => void;
  onRenamed: () => void;
}) => {
  const { toast } = useToast();
  const t = useT();
  const [name, setName] = useState(version.version_name || "");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t("conti.renameVersion")}</DialogTitle>
        </DialogHeader>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter")
              supabase
                .from("scene_versions")
                .update({ version_name: name.trim() })
                .eq("id", version.id)
                .then(() => {
                  onRenamed();
                  onClose();
                });
          }}
        />
        <DialogFooter>
          <Button variant="ghost" className="text-body h-9" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            className="text-white text-body h-9"
            style={{ background: KR }}
            onClick={async () => {
              await supabase.from("scene_versions").update({ version_name: name.trim() }).eq("id", version.id);
              toast({ title: t("conti.renamed") });
              onRenamed();
              onClose();
            }}
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const AddSceneCard = ({ onClick }: { onClick: () => void }) => {
  const [hover, setHover] = useState(false);
  const t = useT();
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="cursor-pointer select-none flex items-center justify-center"
      style={{
        borderRadius: 0,
        border: `1.5px dashed ${hover ? "rgba(249,66,58,0.45)" : "rgba(255,255,255,0.1)"}`,
        background: hover ? "rgba(249,66,58,0.04)" : "rgba(255,255,255,0.02)",
        transition: "border-color 0.15s, background 0.15s",
      }}
    >
      <div className="flex flex-col items-center gap-2">
        <div
          className="flex items-center justify-center"
          style={{
            width: 40,
            height: 40,
            borderRadius: 0,
            background: hover ? "rgba(249,66,58,0.12)" : "rgba(255,255,255,0.05)",
            transition: "background 0.15s",
          }}
        >
          <Plus
            style={{ width: 18, height: 18, color: hover ? KR : "rgba(255,255,255,0.25)", transition: "color 0.15s" }}
          />
        </div>
        <span
          className="font-mono text-2xs font-bold tracking-wider"
          style={{ color: hover ? KR : "rgba(255,255,255,0.3)", transition: "color 0.15s" }}
        >
          {t("conti.addScene")}
        </span>
      </div>
    </div>
  );
};

const InsertSceneButton = ({
  onAddScene,
  onAddTransition,
  canTransition,
  groupChoice,
}: {
  onAddScene: (pref?: "before" | "after" | "new") => void;
  onAddTransition: () => void;
  canTransition: boolean;
  /** When the insertion point sits on a scene-group boundary, offer an
   *  explicit "front scene / back scene" choice. Undefined → single add. */
  groupChoice?: { beforeLabel: string; afterLabel: string };
}) => {
  const [hover, setHover] = useState(false);
  const [popOpen, setPopOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  const t = useT();

  useEffect(() => {
    if (!popOpen) return;
    const fn = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setPopOpen(false);
    };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [popOpen]);

  // Popover positioning rationale:
  //   The wrapper (popRef) is anchored at the CARD's LEFT edge (left: -6,
  //   translateX(-50%)) so the + button visually sits on the card's
  //   border-rail. A naive "centered below the button" popover then
  //   extends ~80 px to the left of the card — but the grid container
  //   (`overflow-y-auto`) implicitly clips overflow-x as well, so for the
  //   leftmost card the entire left half of the popover is hidden and the
  //   labels read as a black sliver (the bug we're fixing).
  //   Always pinning the popover to the RIGHT of the + button (offset
  //   +12 px, vertically centered) keeps it fully inside the card area
  //   regardless of where the card sits in the grid, so no per-card
  //   collision detection is needed.
  const popoverPositionStyle: React.CSSProperties = {
    left: "50%",
    top: "50%",
    transform: "translate(12px, -50%)",
  };

  return (
    <div
      ref={popRef}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "absolute",
        left: -6,
        top: 0,
        bottom: 0,
        width: 12,
        zIndex: 20,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transform: "translateX(-50%)",
      }}
    >
      {(hover || popOpen) && (
        <>
          <div
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: "50%",
              width: 2,
              background: `linear-gradient(to bottom, transparent, ${KR} 15%, ${KR} 85%, transparent)`,
              transform: "translateX(-50%)",
            }}
          />
          <button
            onClick={(e) => {
              e.stopPropagation();
              setPopOpen((v) => !v);
            }}
            style={{
              width: 24,
              height: 24,
              minWidth: 24,
              minHeight: 24,
              borderRadius: "9999px",
              aspectRatio: "1 / 1",
              background: KR,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 1,
              border: "none",
              cursor: "pointer",
              padding: 0,
              boxSizing: "border-box",
            }}
          >
            <Plus style={{ width: 14, height: 14, color: "#fff" }} />
          </button>
        </>
      )}
      {popOpen && (
        <div
          style={{
            position: "absolute",
            ...popoverPositionStyle,
            background: "hsl(var(--card))",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 0,
            padding: 4,
            display: "flex",
            flexDirection: "column",
            gap: 2,
            minWidth: 160,
            zIndex: 30,
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {groupChoice ? (
            <>
              {(
                [
                  { pref: "before" as const, label: t("conti.addSceneToFront", { scene: groupChoice.beforeLabel }) },
                  { pref: "after" as const, label: t("conti.addSceneToBack", { scene: groupChoice.afterLabel }) },
                ]
              ).map(({ pref, label }) => (
                <button
                  key={pref}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPopOpen(false);
                    onAddScene(pref);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 10px",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "rgba(255,255,255,0.85)",
                    fontSize: 12,
                    fontWeight: 500,
                    width: "100%",
                    textAlign: "left",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.06)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.background = "none";
                  }}
                >
                  <Plus style={{ width: 13, height: 13, flexShrink: 0 }} />
                  {label}
                </button>
              ))}
            </>
          ) : (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setPopOpen(false);
                onAddScene();
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 10px",
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "rgba(255,255,255,0.85)",
                fontSize: 12,
                fontWeight: 500,
                width: "100%",
                textAlign: "left",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.06)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = "none";
              }}
            >
              <Plus style={{ width: 13, height: 13, flexShrink: 0 }} />
              {t("conti.addScene")}
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setPopOpen(false);
              onAddScene("new");
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 10px",
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "rgba(255,255,255,0.85)",
              fontSize: 12,
              fontWeight: 500,
              width: "100%",
              textAlign: "left",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.06)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = "none";
            }}
          >
            <svg
              width={13}
              height={13}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ flexShrink: 0 }}
            >
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <path d="M5 17h14M12 14v6" />
            </svg>
            {t("conti.insertAsNewScene")}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (!canTransition) return;
              setPopOpen(false);
              onAddTransition();
            }}
            disabled={!canTransition}
            title={!canTransition ? t("conti.transitionNeedsImages") : t("conti.insertTransitionTitle")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 10px",
              background: "none",
              border: "none",
              cursor: canTransition ? "pointer" : "not-allowed",
              color: canTransition ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.25)",
              fontSize: 12,
              fontWeight: 500,
              width: "100%",
              textAlign: "left",
              opacity: canTransition ? 1 : 0.5,
            }}
            onMouseEnter={(e) => {
              if (canTransition) (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.06)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = "none";
            }}
          >
            <svg
              width={13}
              height={13}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ flexShrink: 0 }}
            >
              <path d="M18 8L22 12L18 16" />
              <path d="M2 12H22" />
            </svg>
            {t("conti.addTransition")}
          </button>
        </div>
      )}
    </div>
  );
};

const SortableVersionTab = ({
  id,
  children,
}: {
  id: string;
  children: (listeners: any, attributes: any) => React.ReactNode;
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style: React.CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, 0, 0)` : undefined,
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };
  return (
    <div ref={setNodeRef} style={style}>
      {children(listeners, attributes)}
    </div>
  );
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
/** Row shape for the storyboard Sheet gallery (storyboard_sheets table). */
interface StoryboardSheetRow {
  id: string;
  project_id: string;
  url: string;
  size_used: string | null;
  cut_count: number | null;
  cols: number | null;
  rows: number | null;
  scene_ids: string | null;
  /** Project format the sheet was generated for (horizontal/vertical/square).
   *  Cells are laid out for THIS aspect, so applying the sheet under a
   *  different project format would make the refine reframe/crop content
   *  wrongly. `applyStoryboardSheetToConti` blocks on a mismatch. Null for
   *  legacy rows created before this column existed. */
  video_format: string | null;
  created_at: string | null;
}

// ── Refresh-safety for the sheet AUTO-APPLY (Phase 3) ──
// The sheet GENERATE call isn't resumable (no server-side job), but the
// expensive AUTO-APPLY (slice → NB2 refine per cut → write scene images) IS:
// a stored sheet row carries everything needed to redo it. So on apply start
// we persist the row; if a reload kills the in-flight apply, ContiTab detects
// the leftover job on mount and resumes it. Cleared on apply completion.
// (The earlier symptom: "sheet saved to gallery but cuts never refined" after
// a refresh mid-apply.)
const CONTI_PENDING_SHEET_APPLY_KEY_PREFIX = "preflow_conti_pending_sheet_apply:";
type PendingSheetApplyJob = { projectId: string; row: StoryboardSheetRow; startedAt: number };
const pendingSheetApplyKey = (projectId: string) => `${CONTI_PENDING_SHEET_APPLY_KEY_PREFIX}${projectId}`;

function readPendingSheetApplyJob(projectId: string): PendingSheetApplyJob | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(pendingSheetApplyKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingSheetApplyJob;
    // 1h TTL — a job older than that is almost certainly stale (the refine
    // pipeline takes seconds, not hours), so drop it rather than re-run.
    if (!parsed?.startedAt || Date.now() - parsed.startedAt > 60 * 60 * 1000 || !parsed.row?.id) {
      window.localStorage.removeItem(pendingSheetApplyKey(projectId));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writePendingSheetApplyJob(job: PendingSheetApplyJob) {
  try {
    window.localStorage.setItem(pendingSheetApplyKey(job.projectId), JSON.stringify(job));
  } catch {
    /* quota / serialization — non-fatal, just lose resume capability */
  }
}

function clearPendingSheetApplyJob(projectId: string, rowId?: string) {
  try {
    const cur = readPendingSheetApplyJob(projectId);
    if (!rowId || cur?.row?.id === rowId) window.localStorage.removeItem(pendingSheetApplyKey(projectId));
  } catch {
    /* ignore */
  }
}

// ContiTab — 메인 컴포넌트
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export const ContiTab = ({ projectId, videoFormat, isActive = true }: Props) => {
  const { toast } = useToast();
  const t = useT();
  const { language } = useUiLanguage();
  const isMobile = useIsMobile();
  const formatDefaultShotTitle = (n: number) => (language === "ko" ? `컷 ${n}` : `Shot ${n}`);

  // 모듈 레벨 캐시(_versionsByProject) 가 있으면 lazy initializer 로 동기 hydrate.
  // 처음 진입(캐시 miss) 시에는 [] 로 시작하지만, 이후 재방문 시엔 바가 즉시
  // 그려져 jolt 가 사라진다.
  const [versions, setVersions] = useState<SceneVersion[]>(
    () => _versionsByProject.get(projectId) ?? [],
  );
  const versionsRef = useRef<SceneVersion[]>(_versionsByProject.get(projectId) ?? []);
  const savedSceneState = getSceneState(projectId);
  const [activeVersionId, setActiveVersionIdState] = useState<string | null>(savedSceneState?.activeVersionId ?? null);
  const [activeScenes, setActiveScenesState] = useState<Scene[]>(savedSceneState?.scenes ?? []);
  const projectActiveVersionIdRef = useRef<string | null>(null);
  const switchVersionRequestRef = useRef(0);

  useEffect(() => {
    versionsRef.current = versions;
  }, [versions]);

  const setActiveScenes = useCallback(
    (scenes: Scene[] | ((prev: Scene[]) => Scene[])) => {
      setActiveScenesState((prev) => {
        const next = typeof scenes === "function" ? scenes(prev) : scenes;
        saveSceneState(projectId, next, activeVersionIdRef.current);
        return next;
      });
    },
    [projectId],
  );

  // ⚠️ 모듈 store 구독: 탭 이동 → 리마운트 중에도 background 스타일 변형/일괄 생성 루프가
  // saveSceneState 로 최신 scene 배열을 쓴다. 언마운트된 인스턴스의 setter 는 no-op 이므로
  // 새 인스턴스는 이 구독을 통해 모듈 store 변경을 감지해 activeScenes React state 를 맞춘다.
  // 같은 reference 라면 React 가 자동으로 dedupe 하므로 cycle 걱정 없음.
  useEffect(() => {
    if (!isActive) return;
    const unsub = subscribeSceneState(projectId, () => {
      const stored = _sceneStateByProject.get(projectId);
      if (!stored) return;
      setActiveScenesState(stored.scenes);
      setActiveVersionIdState(stored.activeVersionId);
    });
    return unsub;
  }, [isActive, projectId]);

  useEffect(() => {
    if (!isActive) return;
    const stored = _sceneStateByProject.get(projectId);
    if (!stored) return;
    setActiveScenesState(stored.scenes);
    setActiveVersionIdState(stored.activeVersionId);
  }, [isActive, projectId]);

  const [currentScenes, setCurrentScenes] = useState<Scene[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  // Phase 1 test: single multi-panel storyboard sheet via GPT Image 2.
  // NOTE: the in-flight sheet state (testing/planning/applyingId/refineProgress/
  // appliedSheetId) lives in the module loading store (see below), NOT here, so
  // it survives ContiTab unmount/remount on project navigation.
  const [storyboardImgError, setStoryboardImgError] = useState(false);
  // Storyboard Sheet gallery (persisted in storyboard_sheets table).
  const [storyboardSheets, setStoryboardSheets] = useState<StoryboardSheetRow[]>([]);
  const [storyboardGalleryOpen, setStoryboardGalleryOpen] = useState(false);
  // Lightbox is driven by an index into `storyboardSheets` so the ←/→ keys
  // and prev/next buttons can step through the gallery without re-opening.
  // null = closed. Falls back to the legacy URL-only path for safety.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  // Two-step inline delete confirm (no extra modal): first trash click arms
  // this id, second confirms. Clears on any other interaction.
  const [confirmDeleteSheetId, setConfirmDeleteSheetId] = useState<string | null>(null);
  // Sheet mode: dedicated toolbar state. While on, the conti model toggle /
  // Generate All / Style Transfer are disabled because Sheet runs a fixed
  // pipeline (GPT Image 2 sheet → NB2 per-cut refine → auto-apply).
  const [sheetMode, setSheetMode] = useState(false);

  // ─── 로딩 상태: 모듈 store에 보관해서 ContiTab 언마운트/리마운트 사이에도 유지 ───
  const subscribeFn = useCallback(
    (cb: () => void) => (isActive ? subscribeLoading(projectId, cb) : () => undefined),
    [isActive, projectId],
  );
  const getSnapshotFn = useCallback(() => getLoading(projectId), [projectId]);
  const loadingState = useSyncExternalStore(subscribeFn, getSnapshotFn, getSnapshotFn);
  const {
    generatingSceneIds,
    editGeneratingIds,
    uploadingSceneIds,
    styleTransferringIds,
    queuedSceneIds,
    sceneStages,
    generatingVersionId,
    generatingSceneVersionMap,
    generatingAll,
    styleTransferring,
    generateProgress,
    styleTransferProgress,
    storyboardTesting,
    storyboardPlanning,
    storyboardApplyingId,
    sheetRefineProgress,
    appliedSheetId,
  } = loadingState;

  // Setter들은 모듈 store를 직접 갱신 → 컴포넌트가 언마운트된 뒤에도 in-flight closure가 호출하면 정상 반영됨.
  const makeLoadingSetter = useCallback(
    <K extends keyof LoadingFields>(key: K): Dispatch<SetStateAction<LoadingFields[K]>> =>
      (updater) => {
        const prev = getLoading(projectId)[key];
        const next =
          typeof updater === "function"
            ? (updater as (p: LoadingFields[K]) => LoadingFields[K])(prev)
            : updater;
        patchLoading(projectId, { [key]: next } as Partial<LoadingFields>);
      },
    [projectId],
  );

  const setGeneratingSceneIds = useCallback(makeLoadingSetter("generatingSceneIds"), [makeLoadingSetter]);
  const setEditGeneratingIds = useCallback(makeLoadingSetter("editGeneratingIds"), [makeLoadingSetter]);
  const setUploadingSceneIds = useCallback(makeLoadingSetter("uploadingSceneIds"), [makeLoadingSetter]);
  const setStyleTransferringIds = useCallback(makeLoadingSetter("styleTransferringIds"), [makeLoadingSetter]);
  const setQueuedSceneIds = useCallback(makeLoadingSetter("queuedSceneIds"), [makeLoadingSetter]);
  const setGeneratingVersionId = useCallback(makeLoadingSetter("generatingVersionId"), [makeLoadingSetter]);
  const setGeneratingSceneVersionMap = useCallback(makeLoadingSetter("generatingSceneVersionMap"), [makeLoadingSetter]);
  const setGeneratingAll = useCallback(makeLoadingSetter("generatingAll"), [makeLoadingSetter]);
  const setStyleTransferring = useCallback(makeLoadingSetter("styleTransferring"), [makeLoadingSetter]);
  const setStyleTransferProgress = useCallback(makeLoadingSetter("styleTransferProgress"), [makeLoadingSetter]);
  // Storyboard sheet setters — same store-backed pattern so call sites are
  // unchanged but the state survives unmount.
  const setStoryboardTesting = useCallback(makeLoadingSetter("storyboardTesting"), [makeLoadingSetter]);
  const setStoryboardPlanning = useCallback(makeLoadingSetter("storyboardPlanning"), [makeLoadingSetter]);
  const setStoryboardApplyingId = useCallback(makeLoadingSetter("storyboardApplyingId"), [makeLoadingSetter]);
  const setSheetRefineProgress = useCallback(makeLoadingSetter("sheetRefineProgress"), [makeLoadingSetter]);
  const setAppliedSheetId = useCallback(makeLoadingSetter("appliedSheetId"), [makeLoadingSetter]);

  // ── Phase 1.4 — sceneStages / generateProgress rAF 코얼레싱 ───────────
  // Generate All / Style Transfer 사이클당 setSceneStages 가 4 워커 × 씬당
  // 4~5 stage = 80~100 회, setGenerateProgress 가 씬 수만큼 발사된다. 각각이
  // patchLoading → useSyncExternalStore listener notify 로 즉시 ContiTab
  // 재렌더를 트리거하므로 사용자 입력/스크롤이 끊기는 주요 원인.
  //
  // 두 setter 의 store-write 를 한 프레임 (rAF) 안에서 1 회로 묶는다. UI 는
  // 60fps 기준 16ms 단위로만 갱신되므로 사용자 체감 동일, 재렌더 횟수는
  // 사이클당 ~10 회 수준으로 떨어진다. patchLoading 을 두 키 동시 patch
  // 로 호출해 한 프레임 안의 stages + progress 변경을 단일 listener
  // notify 로 흡수.
  //
  // Functional updater 호환:
  //   - setSceneStages 는 항상 functional 형태 → updater 함수를 누적 합성.
  //   - setGenerateProgress 는 functional/value 둘 다 지원 (방어적).
  // 모듈 store 직접 갱신 보장: rAF callback 도 동일 patchLoading 사용 →
  // 컴포넌트가 unmount 된 뒤에도 module store 는 살아있어 안전.
  const pendingStagesRef = useRef<((prev: Record<string, GeneratingStage>) => Record<string, GeneratingStage>) | null>(null);
  const pendingProgressRef = useRef<{ value: { done: number; total: number } | null; has: boolean }>({ value: null, has: false });
  const flushRafRef = useRef<number | null>(null);

  const flushCoalesced = useCallback(() => {
    flushRafRef.current = null;
    const stagesFn = pendingStagesRef.current;
    const hasProgress = pendingProgressRef.current.has;
    const progressVal = pendingProgressRef.current.value;
    pendingStagesRef.current = null;
    pendingProgressRef.current = { value: null, has: false };
    if (!stagesFn && !hasProgress) return;
    const cur = getLoading(projectId);
    const patch: Partial<LoadingFields> = {};
    if (stagesFn) patch.sceneStages = stagesFn(cur.sceneStages);
    if (hasProgress) patch.generateProgress = progressVal;
    patchLoading(projectId, patch);
  }, [projectId]);

  const scheduleFlush = useCallback(() => {
    if (flushRafRef.current != null) return;
    flushRafRef.current = window.requestAnimationFrame(flushCoalesced);
  }, [flushCoalesced]);

  const setSceneStages = useCallback<Dispatch<SetStateAction<Record<string, GeneratingStage>>>>(
    (updater) => {
      const updaterFn: (prev: Record<string, GeneratingStage>) => Record<string, GeneratingStage> =
        typeof updater === "function"
          ? (updater as (p: Record<string, GeneratingStage>) => Record<string, GeneratingStage>)
          : () => updater;
      const prev = pendingStagesRef.current;
      pendingStagesRef.current = prev ? (s) => updaterFn(prev(s)) : updaterFn;
      scheduleFlush();
    },
    [scheduleFlush],
  );

  const setGenerateProgress = useCallback<Dispatch<SetStateAction<{ done: number; total: number } | null>>>(
    (updater) => {
      if (typeof updater === "function") {
        const cur = pendingProgressRef.current.has
          ? pendingProgressRef.current.value
          : getLoading(projectId).generateProgress;
        pendingProgressRef.current = {
          value: (updater as (p: { done: number; total: number } | null) => { done: number; total: number } | null)(cur),
          has: true,
        };
      } else {
        pendingProgressRef.current = { value: updater, has: true };
      }
      scheduleFlush();
    },
    [projectId, scheduleFlush],
  );

  // Unmount / projectId 변경 시 pending rAF 가 다른 프로젝트로 누수되지
  // 않도록 즉시 flush 후 cancel. flushCoalesced 는 module store 에만 쓰므로
  // unmount 후 호출돼도 안전 (React state 가 아닌 module store).
  useEffect(() => {
    return () => {
      if (flushRafRef.current != null) {
        window.cancelAnimationFrame(flushRafRef.current);
        flushRafRef.current = null;
        flushCoalesced();
      }
    };
  }, [flushCoalesced]);
  const [showStyleTransferModal, setShowStyleTransferModal] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [infoVis, setInfoVis] = useState<ContiInfoVisibility>(() => loadContiInfoVis(projectId));
  const [showInfoMenu, setShowInfoMenu] = useState(false);
  const infoMenuRef = useRef<HTMLDivElement>(null);
  const [showGroups, setShowGroups] = useState<boolean>(() => loadContiShowGroups(projectId));
  const anyInfoVisible = Object.values(infoVis).some(Boolean);
  // Re-hydrate view prefs when switching projects.
  useEffect(() => {
    setInfoVis(loadContiInfoVis(projectId));
    setShowGroups(loadContiShowGroups(projectId));
  }, [projectId]);
  useEffect(() => {
    try {
      window.localStorage.setItem(contiInfoVisKey(projectId), JSON.stringify(infoVis));
    } catch {
      /* quota / private mode — non-fatal */
    }
  }, [projectId, infoVis]);
  useEffect(() => {
    try {
      window.localStorage.setItem(contiShowGroupsKey(projectId), showGroups ? "1" : "0");
    } catch {
      /* non-fatal */
    }
  }, [projectId, showGroups]);
  // Close the info dropdown on outside click.
  useEffect(() => {
    if (!showInfoMenu) return;
    const fn = (e: MouseEvent) => {
      if (infoMenuRef.current && !infoMenuRef.current.contains(e.target as Node)) setShowInfoMenu(false);
    };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [showInfoMenu]);
  const [showNewVersionModal, setShowNewVersionModal] = useState(false);
  const [renameVersion, setRenameVersion] = useState<SceneVersion | null>(null);
  const [dragActiveId, setDragActiveId] = useState<string | null>(null);
  const dragCloneRef = useRef<HTMLDivElement | null>(null);
  const [projectInfo, setProjectInfo] = useState<ProjectInfo>({
    title: "",
    client: null,
    active_version_id: null,
    conti_style_id: null,
  });
  const [studioScene, setStudioScene] = useState<Scene | null>(null);
  const [studioVersionId, setStudioVersionId] = useState<string | null>(null);
  const [studioInitialTab, setStudioInitialTab] = useState<
    "view" | "edit" | "sketches" | "history" | "compare" | undefined
  >(undefined);
  /** Compare 탭의 서브탭(versions/mood/library) 초기값 — 라이브러리 →
   *  프로젝트 복귀 흐름에서 마지막 머물렀던 서브탭으로 즉시 복원하기 위해
   *  사용. 한 번 ContiStudio 에 전달되고 나면 다음 studio open 에선
   *  undefined 로 돌아간다 (ContiStudio onClose 가 reset). */
  const [studioInitialCompareSubTab, setStudioInitialCompareSubTab] = useState<
    "versions" | "mood" | "library" | undefined
  >(undefined);
  const [compareSceneNumber, setCompareSceneNumber] = useState<number | null>(null);
  const [adjustingScene, setAdjustingScene] = useState<Scene | null>(null);
  const [relightingScene, setRelightingScene] = useState<Scene | null>(null);
  const [cameraVariationsScene, setCameraVariationsScene] = useState<Scene | null>(null);
  const [changeAngleScene, setChangeAngleScene] = useState<Scene | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("auto");
  const [cardSize, setCardSize] = useState<number>(videoFormat === "vertical" ? 240 : 300);
  // videoFormat 이 늦게 도착하거나 변경되면(세로↔가로 등) cardSize 가 처음 마운트
  // 시점의 값에 고정되어 그리드 minmax 와 카드 비율이 어긋나면서 jolt 처럼 보일
  // 수 있다. 사용자가 슬라이더로 직접 조정한 값(기본 240/300 외)이라면 그대로
  // 보존하고, 기본값 상태일 때만 새 videoFormat 의 기본값으로 동기화한다.
  useEffect(() => {
    setCardSize((prev) => {
      if (prev !== 240 && prev !== 300) return prev;
      return videoFormat === "vertical" ? 240 : 300;
    });
  }, [videoFormat]);
  const [showGenerateAllModal, setShowGenerateAllModal] = useState(false);
  const [tabMenuAnchor, setTabMenuAnchor] = useState<{ id: string; x: number; y: number } | null>(null);
  const [currentStyle, setCurrentStyle] = useState<StylePreset | null>(null);
  const [showStyleModal, setShowStyleModal] = useState(false);
  const [selectedSceneIds, setSelectedSceneIds] = useState<Set<string>>(new Set());
  const [deleteVersionTarget, setDeleteVersionTarget] = useState<{ id: string; name: string } | null>(null);

  /** ━━━ 라이브러리 → 프로젝트 복귀 시 ContiStudio 자동 복원 ━━━
   *
   *  ContiStudio.handleGoToLibrary 가 returnTo URL + sessionStorage 에 다음
   *  3 가지 복원 키를 실어 보낸다:
   *    - studioScene  (씬 id)
   *    - studioTab    ("compare" 고정)
   *    - compareSub   ("library" 고정)
   *
   *  사용자가 "프로젝트로 돌아가기" 를 누르면 ProjectPage 가 storyboard 탭으로
   *  마운트되고, ContiTab 가 isActive=true 로 진입한다. 이때 activeScenes 가
   *  hydrate 되면 해당 씬을 찾아 ContiStudio 를 비교 > 라이브러리 탭으로
   *  자동 오픈한다.
   *
   *  설계 포인트:
   *  · 첫 isActive=true 진입 시 *한 번* snapshot 을 잡고 sessionStorage 키를
   *    즉시 비운다 (ProjectPage 의 sourceTab 와 동일한 one-shot 정책 — 다음
   *    내비게이션에서 stale 복원이 일어나지 않도록).
   *  · snapshot 보관 후엔 activeScenes 가 늦게 들어오더라도 해당 씬이 등장하는
   *    순간 studio 가 열린다. ref 에 보관해 deps 폭주를 막는다.
   *  · 이미 studioScene 이 열려 있으면 *덮어쓰지 않음*.
   *  · 파싱은 URL(`?studioScene=...`) 우선, sessionStorage 폴백. HashRouter
   *    환경에서 query 가 유실되는 케이스 대비 — Brief 의 sourceTab 폴백과
   *    동일 패턴. */
  type RestoreSnapshot = {
    sceneId: string;
    studioTab: "view" | "edit" | "sketches" | "history" | "compare";
    compareSub: "versions" | "mood" | "library";
  };
  const restoreSnapshotRef = useRef<RestoreSnapshot | null>(null);
  const restoreInitedRef = useRef(false);

  useEffect(() => {
    if (!isActive) return;

    // 1) 첫 isActive=true 진입에서 한 번만 snapshot 을 잡고 sessionStorage 키
    //    를 즉시 제거. 복원 신호가 없으면 snapshotRef 는 null 로 남아 아래
    //    early-return.
    if (!restoreInitedRef.current) {
      restoreInitedRef.current = true;

      let sceneIdParam: string | null = null;
      let studioTabParam: string | null = null;
      let compareSubParam: string | null = null;
      try {
        const hash = typeof window !== "undefined" ? window.location.hash : "";
        const qIdx = hash.indexOf("?");
        if (qIdx >= 0) {
          const sp = new URLSearchParams(hash.slice(qIdx + 1));
          sceneIdParam = sp.get("studioScene");
          studioTabParam = sp.get("studioTab");
          compareSubParam = sp.get("compareSub");
        }
      } catch {
        /* 파싱 실패 — sessionStorage 폴백 */
      }
      try {
        if (!sceneIdParam) sceneIdParam = sessionStorage.getItem("preflow.return.studioSceneId");
        if (!studioTabParam) studioTabParam = sessionStorage.getItem("preflow.return.studioTab");
        if (!compareSubParam) compareSubParam = sessionStorage.getItem("preflow.return.compareSub");
        // one-shot: 다음 마운트 / 다른 프로젝트 진입에서 stale 복원이 발생
        // 하지 않도록 키를 즉시 비운다.
        sessionStorage.removeItem("preflow.return.studioSceneId");
        sessionStorage.removeItem("preflow.return.studioTab");
        sessionStorage.removeItem("preflow.return.compareSub");
      } catch {
        /* private mode — 무시 */
      }

      if (sceneIdParam) {
        const normalizedTab =
          studioTabParam === "view" ||
          studioTabParam === "edit" ||
          studioTabParam === "sketches" ||
          studioTabParam === "history" ||
          studioTabParam === "compare"
            ? studioTabParam
            : "compare";
        const normalizedSub =
          compareSubParam === "versions" || compareSubParam === "mood" || compareSubParam === "library"
            ? compareSubParam
            : "library";
        restoreSnapshotRef.current = {
          sceneId: sceneIdParam,
          studioTab: normalizedTab,
          compareSub: normalizedSub,
        };
      }
    }

    // 2) snapshot 이 있고 아직 studio 가 닫혀있다면, activeScenes 에 target 이
    //    등장한 순간 한 번만 오픈하고 snapshot 을 비운다.
    const snap = restoreSnapshotRef.current;
    if (!snap) return;
    if (studioScene) return; // 이미 열림 — 사용자 의도 보존
    if (activeScenes.length === 0) return;

    const targetScene = activeScenes.find((s) => s.id === snap.sceneId);
    if (!targetScene) return; // 다음 activeScenes 갱신까지 대기

    restoreSnapshotRef.current = null;
    setStudioScene(targetScene);
    setStudioVersionId(activeVersionIdRef.current);
    setStudioInitialTab(snap.studioTab);
    setStudioInitialCompareSubTab(snap.compareSub);
  }, [isActive, activeScenes, studioScene]);

  const toggleSceneSelect = (id: string, v: boolean) =>
    setSelectedSceneIds((s) => {
      const n = new Set(s);
      v ? n.add(id) : n.delete(id);
      return n;
    });

  const [cacheBusters, setCacheBustersState] = useState<Record<number, number>>(() => ({
    ...getCacheBusters(projectId),
  }));
  const bumpCache = (sceneNumber: number) => {
    const ts = Date.now();
    _cacheBustersByProject.set(projectId, { ...getCacheBusters(projectId), [sceneNumber]: ts });
    setCacheBustersState((prev) => ({ ...prev, [sceneNumber]: ts }));
  };

  const buildHistoryFromScenes = useCallback((scenes: Scene[]): Record<number, string[]> => {
    const h: Record<number, string[]> = {};
    for (const s of scenes) {
      if (s.conti_image_history && s.conti_image_history.length > 0) {
        h[s.scene_number] = s.conti_image_history;
      }
    }
    return h;
  }, []);

  const [imageHistory, setImageHistoryState] = useState<Record<number, string[]>>(() =>
    buildHistoryFromScenes(activeScenes),
  );
  const imageHistoryRef = useRef<Record<number, string[]>>(imageHistory);
  const replaceImageHistory = useCallback((next: Record<number, string[]>) => {
    imageHistoryRef.current = next;
    setImageHistoryState(next);
  }, []);
  const setImageHistory = useCallback((updater: (prev: Record<number, string[]>) => Record<number, string[]>) => {
    const next = updater(imageHistoryRef.current);
    imageHistoryRef.current = next;
    setImageHistoryState(next);
  }, []);
  const [historySheet, setHistorySheet] = useState<Scene | null>(null);

  // ⚠️ sceneId 로 식별한다. 이전에는 scene_number 로 식별했는데,
  // 스타일 변형 전체 루프 중간에 TR 삽입/삭제/재배열이 일어나면 scene_number 가 뒤섞여
  // 엉뚱한 scene 의 conti_image_history 에 push 되는 버그가 있었다.
  const pushHistory = (sceneId: string, oldUrl: string | null) => {
    if (!oldUrl) return;
    const latest = getSceneState(projectId)?.scenes ?? activeScenes;
    const scene = latest.find((s) => s.id === sceneId);
    if (!scene) return;
    const existing = Array.isArray(scene.conti_image_history) ? scene.conti_image_history : [];
    const next = [oldUrl, ...existing.filter((u) => u !== oldUrl)].slice(0, MAX_HISTORY);
    supabase.from("scenes").update({ conti_image_history: next }).eq("id", scene.id).then();
    // 모듈 store 를 동기로 먼저 갱신해 두어야, style-transfer 루프처럼
    // pushHistory 직후 await 전에 getSceneState() 를 읽는 코드가 최신 history 를 본다.
    const currentState = getSceneState(projectId);
    if (currentState) {
      const updatedScenes = currentState.scenes.map((s) =>
        s.id === scene.id ? { ...s, conti_image_history: next } : s,
      );
      saveSceneState(projectId, updatedScenes, currentState.activeVersionId ?? null);
    }
    setActiveScenes((prev) =>
      prev.map((s) => (s.id === scene.id ? { ...s, conti_image_history: next } : s)),
    );
    // UI 캐시는 '현재의' scene_number 로 동기화 (표시 전용).
    const nextMap = { ...imageHistoryRef.current, [scene.scene_number]: next };
    imageHistoryRef.current = nextMap;
    setImageHistoryState(nextMap);
  };

  const imageHistorySyncKey = activeScenes.map((s) => `${s.id}:${(s.conti_image_history ?? []).join("|")}`).join("||");

  useEffect(() => {
    replaceImageHistory(buildHistoryFromScenes(activeScenes));
  }, [imageHistorySyncKey, buildHistoryFromScenes, replaceImageHistory]);

  // setGeneratingSceneIds / setGeneratingAll 자체가 모듈 store를 갱신하므로 wrapper는 단순 alias.
  const updateGeneratingSceneIds = setGeneratingSceneIds;
  const updateGeneratingAll = setGeneratingAll;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const versionSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 10 } }));

  const handleVersionDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = versions.findIndex((v) => v.id === active.id);
      const newIndex = versions.findIndex((v) => v.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      const previous = versions;
      const reordered = arrayMove(versions, oldIndex, newIndex);
      _versionsByProject.set(projectId, reordered);
      setVersions(reordered);
      try {
        await Promise.all(
          reordered.map((v, i) =>
            supabase
              .from("scene_versions")
              .update({ display_order: i + 1 })
              .eq("id", v.id),
          ),
        );
      } catch (err: any) {
        _versionsByProject.set(projectId, previous);
        setVersions(previous);
        toast({ title: t("conti.toast.versionReorderFailed"), description: err.message, variant: "destructive" });
      }
    },
    [toast, versions],
  );

  const briefAnalysisRef = useRef<BriefAnalysis | null>(null);
  const moodImagesRef = useRef<Array<{ url: string; sceneRef: number | null }>>([]);
  const [moodImageUrls, setMoodImageUrls] = useState<string[]>([]);
  const [moodBookmarks, setMoodBookmarks] = useState<string[]>([]);

  const fetchCurrentScenes = useCallback(async () => {
    const { data } = await supabase
      .from("scenes")
      .select("*")
      .eq("project_id", projectId)
      .eq("source", "conti")
      .order("scene_number", { ascending: true });
    if (data) setCurrentScenes(data as Scene[]);
    return data as Scene[] | null;
  }, [projectId]);

  const fetchAssets = useCallback(async () => {
    const { data } = await supabase
      .from("assets")
      .select(
        // character_sheet_url + use_character_sheet flow through to
        // ContiStudio so inpaint can prefer the multi-angle sheet
        // over photo_url for tagged characters (and respect the user
        // toggle that suppresses sheet use without deleting the file).
        // The local-server adapter currently returns all columns
        // regardless, but listing them explicitly keeps intent
        // visible and will survive any future server-side column
        // whitelisting.
        "tag_name, photo_url, asset_type, ai_description, outfit_description, signature_items, space_description, character_sheet_url, character_board_url, character_ref_mode, use_character_sheet",
      )
      .eq("project_id", projectId);
    if (data) setAssets(data as Asset[]);
  }, [projectId]);

  // Live merge of new assets created elsewhere (e.g. AssetsTab "Save as
  // Background" on a framing variation). Without this, ContiTab's assets
  // state stays stale until the tab is unmounted/remounted, and any
  // `@<new-tag>` typed in a scene would be misresolved by resolveAsset's
  // prefix-fallback (or just rendered as plain text), then frozen into
  // tagged_assets[]. Listening for the same project's id keeps cross-
  // project events from leaking.
  useEffect(() => {
    const onAssetCreated = (e: Event) => {
      const ce = e as CustomEvent<Asset & { project_id?: string }>;
      const created = ce.detail;
      if (!created || !created.tag_name) return;
      if (created.project_id && created.project_id !== projectId) return;
      setAssets((prev) => {
        if (prev.some((a) => a.tag_name === created.tag_name)) return prev;
        return [...prev, created as Asset];
      });
    };
    // `preflow:asset-updated` fires when characterSheetStore finishes a
    // background sheet generation (or removal). We patch the matching
    // row in `assets` so ContiStudio's `assetRefUrls` picks up the
    // new `character_sheet_url` on the very next inpaint call without
    // a full refetch — same pattern AssetsTab uses.
    const onAssetUpdated = (e: Event) => {
      const ce = e as CustomEvent<Asset & { id?: string; project_id?: string }>;
      const updated = ce.detail;
      if (!updated || !updated.tag_name) return;
      if (updated.project_id && updated.project_id !== projectId) return;
      setAssets((prev) =>
        prev.map((a) => (a.tag_name === updated.tag_name ? { ...a, ...updated } : a)),
      );
    };
    window.addEventListener("preflow:asset-created", onAssetCreated as EventListener);
    window.addEventListener("preflow:asset-updated", onAssetUpdated as EventListener);
    return () => {
      window.removeEventListener("preflow:asset-created", onAssetCreated as EventListener);
      window.removeEventListener("preflow:asset-updated", onAssetUpdated as EventListener);
    };
  }, [projectId]);

  const getMoodReferenceUrl = useCallback((sceneNumber: number): string | undefined => {
    const linked = moodImagesRef.current.find((img) => img.sceneRef === sceneNumber);
    return linked?.url ?? undefined;
  }, []);

  useEffect(() => {
    const normalizeKey = (url: string | null | undefined) => normalizeStorageUrl(url) ?? url ?? "";
    const onMoodImagesDeleted = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string; urls?: string[] }>).detail;
      if (detail?.projectId !== projectId || !Array.isArray(detail.urls) || detail.urls.length === 0) return;
      const deleted = new Set(detail.urls.map(normalizeKey));
      moodImagesRef.current = moodImagesRef.current.filter((img) => !deleted.has(normalizeKey(img.url)));
      setMoodImageUrls((prev) => prev.filter((url) => !deleted.has(normalizeKey(url))));
      setMoodBookmarks((prev) => prev.filter((url) => !deleted.has(normalizeKey(url))));
    };
    window.addEventListener("preflow:mood-images-deleted", onMoodImagesDeleted);
    return () => window.removeEventListener("preflow:mood-images-deleted", onMoodImagesDeleted);
  }, [projectId]);

  // scene_versions.scenes 에 conti_image_history 가 누락된 legacy 데이터를 위해,
  // scenes 테이블에서 scene.id 기준으로 history 를 가져와 머지한다. renumber 에 영향을 받지 않는다.
  const hydrateSceneHistory = useCallback(
    async (scenes: Scene[]): Promise<Scene[]> => {
      if (!scenes.length) return scenes;
      const ids = scenes.map((s) => s.id).filter(Boolean);
      if (!ids.length) return scenes;
      const { data, error } = await supabase
        .from("scenes")
        .select("id, conti_image_history")
        .in("id", ids);
      if (error || !data) return scenes;
      const histById = new Map<string, string[]>();
      for (const row of data as { id: string; conti_image_history: string[] | null }[]) {
        histById.set(row.id, Array.isArray(row.conti_image_history) ? row.conti_image_history : []);
      }
      return scenes.map((s) => {
        const dbHist = histById.get(s.id) ?? [];
        const own = Array.isArray(s.conti_image_history) ? s.conti_image_history : [];
        // scene 객체에 history 가 이미 있다면 그것을 우선(최신 업데이트 반영).
        return { ...s, conti_image_history: own.length > 0 ? own : dbHist };
      });
    },
    [],
  );

  const loadVersions = useCallback(
    async (preserveActiveScenes = false, preferredVersionId?: string | null) => {
      const { data, error } = await supabase
        .from("scene_versions")
        .select("*")
        .eq("project_id", projectId)
        .order("display_order", { ascending: true });
      if (error) {
        console.warn("[ContiTab] loadVersions skipped after transient read error:", error.message);
        return;
      }
      const rawVers = (data ?? []) as SceneVersion[];
      // Self-heal legacy `sketches: "[]"` (string) snapshots — see
      // normalizeScenesSketches docs. We do this BEFORE setVersions so the
      // local state never sees the malformed shape, and we silently re-persist
      // any sanitised version's scenes JSON so the bad data doesn't reappear
      // on the next reload.
      const vers = rawVers.map((v) => {
        const arr = Array.isArray(v.scenes) ? (v.scenes as Scene[]) : [];
        const norm = normalizeScenesSketches(arr);
        if (norm.changed) {
          // Fire-and-forget — persistence failure must not block the tab from
          // rendering a sanitised view. Logged for visibility.
          void supabase
            .from("scene_versions")
            .update({ scenes: norm.scenes as any })
            .eq("id", v.id)
            .then((res: any) => {
              if (res?.error) {
                console.warn("[ContiTab] auto-heal sketches rewrite failed:", res.error);
              }
            });
        }
        return { ...v, scenes: norm.scenes as any };
      });
      versionsRef.current = vers;
      _versionsByProject.set(projectId, vers);
      setVersions(vers);
      if (vers.length > 0) {
        const active = vers.find((v) => v.id === preferredVersionId)
          ?? vers.find((v) => v.id === projectActiveVersionIdRef.current)
          ?? vers[0];
        projectActiveVersionIdRef.current = active.id;
        if (!preserveActiveScenes) {
          const hydrated = await hydrateSceneHistory(active.scenes as Scene[]);
          activeVersionIdRef.current = active.id;
          saveSceneState(projectId, hydrated, active.id);
          setActiveVersionIdState(active.id);
          setActiveScenesState(hydrated);
          restorePendingContiGenerateLoading(projectId, hydrated);
          restorePendingContiSingleLoading(projectId, hydrated);
        } else {
          activeVersionIdRef.current = active.id;
          setActiveVersionIdState(active.id);
        }
      } else {
        if (!preserveActiveScenes) {
          const scenes = await fetchCurrentScenes();
          const nextScenes = scenes ?? [];
          activeVersionIdRef.current = null;
          saveSceneState(projectId, nextScenes, null);
          setActiveVersionIdState(null);
          setActiveScenesState(nextScenes);
          restorePendingContiGenerateLoading(projectId, nextScenes);
          restorePendingContiSingleLoading(projectId, nextScenes);
        } else {
          activeVersionIdRef.current = null;
          setActiveVersionIdState(null);
        }
      }
    },
    [projectId, fetchCurrentScenes, hydrateSceneHistory],
  );

  useEffect(() => {
    const onContiVersionCreated = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string; versionId?: string }>).detail;
      if (!detail || detail.projectId !== projectId || !detail.versionId) return;
      projectActiveVersionIdRef.current = detail.versionId;
      void loadVersions(false, detail.versionId);
    };
    window.addEventListener("preflow:conti-version-created", onContiVersionCreated as EventListener);
    return () => {
      window.removeEventListener("preflow:conti-version-created", onContiVersionCreated as EventListener);
    };
  }, [projectId, loadVersions]);

  useEffect(() => {
    supabase.functions.invoke("openai-image", { body: { mode: "ping" } }).catch(() => {});
  }, []);

  useEffect(() => {
    // in-flight 스타일 변형/일괄 생성이 진행 중이면, DB 로부터 scene 을 다시 읽어
    // 모듈 store 를 덮어쓰지 않는다. 모듈 store 가 DB 보다 앞서있을 수 있기 때문.
    // (background loop 가 scene 마다 saveSceneState 후 async 로 DB 에 write — 이 사이
    //  구간에 리마운트가 일어나면 DB 는 한 번뒤쳐진 상태라 그걸 읽어 쓰면 진행분이 롤백된다.)
    const _l = getLoading(projectId);
    const hasOngoing =
      _l.generatingSceneIds.size > 0 ||
      _l.generatingAll ||
      _l.styleTransferringIds.size > 0 ||
      _l.styleTransferring;

    const briefsPromise = supabase
      .from("briefs")
      .select("analysis, mood_image_urls, mood_bookmarks")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const projectPromise = supabase
      .from("projects")
      .select("title, client, active_version_id, conti_style_id, status")
      .eq("id", projectId)
      .single();

    Promise.all([fetchCurrentScenes(), fetchAssets(), briefsPromise, projectPromise]).then(
      async ([_scenes, _assets, briefsRes, projectRes]) => {
        if (briefsRes.data?.analysis) briefAnalysisRef.current = briefsRes.data.analysis as unknown as BriefAnalysis;
        if (briefsRes.data?.mood_image_urls && Array.isArray(briefsRes.data.mood_image_urls)) {
          const rawMoods = briefsRes.data.mood_image_urls as any[];
          moodImagesRef.current = rawMoods.map((item: any) =>
            typeof item === "string"
              ? { url: item, sceneRef: null }
              : { url: item.url, sceneRef: item.sceneRef ?? null },
          );
          setMoodImageUrls(rawMoods.map((item: any) => (typeof item === "string" ? item : item.url)));
          const likedUrls = rawMoods
            .filter((item: any) => typeof item !== "string" && item.liked)
            .map((item: any) => item.url as string);
          if (likedUrls.length > 0) setMoodBookmarks(likedUrls);
        }
        if (briefsRes.data?.mood_bookmarks && Array.isArray(briefsRes.data.mood_bookmarks)) {
          setMoodBookmarks((prev) => {
            const existing = new Set(prev);
            const additional = (briefsRes.data!.mood_bookmarks as string[]).filter((u) => !existing.has(u));
            return additional.length > 0 ? [...prev, ...additional] : prev;
          });
        }
        if (projectRes.data) {
          const info = projectRes.data as ProjectInfo;
          projectActiveVersionIdRef.current = info.active_version_id;
          setProjectInfo(info);
          if (info.conti_style_id) {
            const { data: preset } = await supabase
              .from("style_presets")
              .select("id, name, description, thumbnail_url, style_prompt, is_default")
              .eq("id", info.conti_style_id)
              .single();
            if (preset) {
              setCurrentStyle(preset as StylePreset);
            } else {
              setCurrentStyle(null);
              setProjectInfo((prev) => ({ ...prev, conti_style_id: null }));
              await supabase.from("projects").update({ conti_style_id: null }).eq("id", projectId);
            }
          } else {
            setCurrentStyle(null);
          }
        }
        void loadVersions(hasOngoing).then(() => {
          const restoredScenes = getSceneState(projectId)?.scenes ?? [];
          restorePendingContiGenerateLoading(projectId, restoredScenes);
          restorePendingContiSingleLoading(projectId, restoredScenes);
        });
      },
    );
  }, [projectId]);

  const switchVersion = async (versionId: string) => {
    const requestId = ++switchVersionRequestRef.current;
    const { data } = await supabase.from("scene_versions").select("*").eq("id", versionId).single();
    if (requestId !== switchVersionRequestRef.current) return;
    if (!data) return;
    const version = data as SceneVersion;
    // Same self-heal as in loadVersions — covers the case where the user
    // navigates straight to a non-active version that loadVersions sanitised
    // in memory but the user lands on before the rewrite roundtrips.
    const arr = Array.isArray(version.scenes) ? (version.scenes as Scene[]) : [];
    const norm = normalizeScenesSketches(arr);
    if (norm.changed) {
      void supabase
        .from("scene_versions")
        .update({ scenes: norm.scenes as any })
        .eq("id", versionId)
        .then((res: any) => {
          if (res?.error) console.warn("[ContiTab] auto-heal sketches rewrite failed:", res.error);
        });
    }
    const cleanedScenes = norm.scenes;
    versionsRef.current = versionsRef.current.map((v) =>
      v.id === versionId ? { ...v, scenes: cleanedScenes as SceneVersion["scenes"] } : v,
    );
    _versionsByProject.set(projectId, versionsRef.current);
    setVersions(versionsRef.current);
    const hydrated = await hydrateSceneHistory(cleanedScenes);
    if (requestId !== switchVersionRequestRef.current) return;
    activeVersionIdRef.current = versionId;
    projectActiveVersionIdRef.current = versionId;
    saveSceneState(projectId, hydrated, versionId);
    setActiveVersionIdState(versionId);
    setActiveScenesState(hydrated);
    replaceImageHistory(buildHistoryFromScenes(hydrated));
    const moduleState = getGeneratingScenes(projectId);
    setGeneratingSceneIds(new Set(moduleState));
    await supabase.from("projects").update({ active_version_id: versionId }).eq("id", projectId);
  };

  const handleDeleteVersion = async (versionId: string) => {
    const version = versions.find((v) => v.id === versionId);
    if (!version) return;
    const vName = version.version_name || `v${version.version_number}`;
    setDeleteVersionTarget({ id: versionId, name: vName });
  };

  const executeDeleteVersion = async (versionId: string) => {
    const version = versions.find((v) => v.id === versionId);
    if (!version) return;
    const vName = version.version_name || `v${version.version_number}`;
    const isReferenced = activeVersionId === versionId || projectActiveVersionIdRef.current === versionId;
    if (isReferenced) {
      projectActiveVersionIdRef.current = null;
      await supabase.from("projects").update({ active_version_id: null }).eq("id", projectId);
      setProjectInfo((p) => ({ ...p, active_version_id: null }));
    }
    const { error } = await supabase.from("scene_versions").delete().eq("id", versionId);
    if (error) {
      toast({ title: t("conti.deleteFailed"), description: error.message, variant: "destructive" });
      return;
    }
    setVersions((prev) => {
      const next = prev.filter((v) => v.id !== versionId);
      _versionsByProject.set(projectId, next);
      return next;
    });
    toast({ title: t("conti.toast.versionDeleted", { name: vName }) });
    await loadVersions();
  };

  const handleSaveCurrentAsVersion = async () => {
    const scenes = currentScenes.length > 0 ? currentScenes : ((await fetchCurrentScenes()) ?? []);
    if (scenes.length === 0) {
      toast({ title: t("conti.noScenesToSave"), variant: "destructive" });
      return;
    }
    const num = versions.length + 1;
    await supabase.from("scene_versions").insert({
      project_id: projectId,
      version_number: num,
      version_name: `ver.${num}`,
      display_order: num,
      scenes: scenes as any,
      is_active: false,
    });
    toast({ title: t("conti.toast.versionSavedAs", { num }) });
    await loadVersions();
  };

  const activeVersionIdRef = useRef<string | null>(activeVersionId);
  const restoredPendingGenerateRef = useRef(false);
  const restoredPendingSingleRef = useRef(false);
  const updateVersionScenesQueueRef = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    activeVersionIdRef.current = activeVersionId;
  }, [activeVersionId]);

  const getScenesForVersion = useCallback(async (versionId: string): Promise<Scene[]> => {
    const cached = versionsRef.current.find((v) => v.id === versionId)?.scenes;
    if (Array.isArray(cached)) return normalizeScenesSketches(cached as Scene[]).scenes;

    const { data, error } = await supabase.from("scene_versions").select("scenes").eq("id", versionId).single();
    if (error) {
      console.warn("[ContiTab] Failed to read version scenes:", error);
      return [];
    }

    const rawScenes = Array.isArray((data as Pick<SceneVersion, "scenes"> | null)?.scenes)
      ? ((data as Pick<SceneVersion, "scenes">).scenes as Scene[])
      : [];
    return normalizeScenesSketches(rawScenes).scenes;
  }, []);

  const commitVersionScenesInMemory = useCallback((versionId: string, scenes: Scene[]) => {
    versionsRef.current = versionsRef.current.map((v) =>
      v.id === versionId ? { ...v, scenes: scenes as SceneVersion["scenes"] } : v,
    );
    setVersions(versionsRef.current);
  }, []);

  const updateVersionScenes = useCallback(
    async (
      updatedScenesOrUpdater: Scene[] | ((current: Scene[]) => Scene[]),
      options: { versionId?: string | null } = {},
    ) => {
      const targetVersionId = options.versionId ?? activeVersionIdRef.current;
      const run = async () => {
        const isTargetStillActive = !targetVersionId || targetVersionId === activeVersionIdRef.current;
        const storedState = getSceneState(projectId);
        const storedScenesMatchTarget =
          !targetVersionId || !storedState?.activeVersionId || storedState.activeVersionId === targetVersionId;
        const currentScenes =
          typeof updatedScenesOrUpdater === "function"
            ? isTargetStillActive && storedScenesMatchTarget
              ? storedState?.scenes ?? activeScenes
              : targetVersionId
                ? await getScenesForVersion(targetVersionId)
                : activeScenes
            : updatedScenesOrUpdater;
        const updatedScenes =
          typeof updatedScenesOrUpdater === "function"
            ? updatedScenesOrUpdater(currentScenes)
            : updatedScenesOrUpdater;
        // history 의 source of truth 는 scene 객체의 conti_image_history 필드.
        // imageHistoryRef 는 scene_number 키라 insert/delete/reorder 직후에는 꼬이기 때문에
        // 절대 fallback 으로 쓰면 안 된다 (예: TR 삽입 시 새 TR(#2) 이 구 #2 의 history 를 물려받는 버그).
        // scene 객체에 history 가 없으면 빈 배열로 취급한다 — legacy 데이터는 별도 hydrate 단계에서 채운다.
        const enriched = updatedScenes.map((s) => ({
          ...s,
          conti_image_history: Array.isArray(s.conti_image_history) ? s.conti_image_history : [],
        }));
        // ⚠️ 모듈 store 를 React state updater **바깥**에서 동기 갱신한다.
        // 컴포넌트 언마운트 후에도 in-flight 스타일 트랜스퍼/생성 루프가 다음 이터레이션에서
        // getSceneState() 로 최신 상태를 읽어 누적 업데이트 해야, 이전 이터레이션의 URL 이
        // 덮어쓰기로 롤백되는 사고(탭 이동 후 "생성이 안되" 버그)가 없어진다.
        if (!targetVersionId || targetVersionId === activeVersionIdRef.current) {
          saveSceneState(projectId, enriched, targetVersionId);
          setActiveScenesState(enriched);
        }
        if (targetVersionId) {
          await supabase
            .from("scene_versions")
            .update({ scenes: enriched as SceneVersion["scenes"] })
            .eq("id", targetVersionId);
          commitVersionScenesInMemory(targetVersionId, enriched);
        }
      };
      const queued = updateVersionScenesQueueRef.current.then(run, run);
      updateVersionScenesQueueRef.current = queued.catch(() => undefined);
      return queued;
    },
    [activeScenes, commitVersionScenesInMemory, getScenesForVersion, projectId],
  );

  const applyGeneratedSceneImage = useCallback(
    async (
      sceneId: string,
      newUrl: string,
      oldUrl: string | null,
      options: { resetCrop?: boolean; versionId?: string | null } = {},
    ) => {
      const targetVersionId = options.versionId ?? activeVersionIdRef.current;
      clearPendingContiSingleJobsForScene(projectId, sceneId);
      clearContiLoadingForScene(projectId, sceneId);
      const update: Record<string, unknown> = { conti_image_url: newUrl };
      if (options.resetCrop) update.conti_image_crop = null;
      let nextHistory: string[] | null = null;
      let updatedSceneNumber: number | null = null;
      await updateVersionScenes(
        (current) =>
          current.map((s) => {
            if (s.id !== sceneId) return s;
            updatedSceneNumber = s.scene_number;
            const existing = Array.isArray(s.conti_image_history) ? s.conti_image_history : [];
            const history = oldUrl ? [oldUrl, ...existing.filter((u) => u !== oldUrl)].slice(0, MAX_HISTORY) : existing;
            nextHistory = history;
            return {
              ...s,
              conti_image_url: newUrl,
              conti_image_history: history,
              ...(options.resetCrop ? { conti_image_crop: null } : {}),
            };
          }),
        { versionId: targetVersionId },
      );
      if (nextHistory) update.conti_image_history = nextHistory;
      await supabase.from("scenes").update(update).eq("id", sceneId);
      if (updatedSceneNumber !== null && (!targetVersionId || targetVersionId === activeVersionIdRef.current)) {
        bumpCache(updatedSceneNumber);
      }
    },
    [activeScenes, projectId, updateVersionScenes],
  );

  const registerInpaintJob = useCallback(
    (job: {
      sceneId: string;
      sceneNumber: number;
      originalUrl: string | null;
      body: Record<string, any>;
      resetCrop: boolean;
    }) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      upsertPendingContiSingleJob({
        id,
        projectId,
        versionId: activeVersionIdRef.current,
        sceneId: job.sceneId,
        sceneNumber: job.sceneNumber,
        kind: "inpaint",
        originalUrl: job.originalUrl,
        startedAt: Date.now(),
        body: { ...job.body, __resetCrop: job.resetCrop },
      });
      return id;
    },
    [projectId],
  );

  type ContiModel = "gpt" | "nano-banana-2";
  // 초기 모델 = Settings 의 컨티 기본값. 화면의 토글로 세션 내 변경(=override) 가능.
  const [contiModel, setContiModel] = useState<ContiModel>(
    () => getImageModelDefault("conti") as ContiModel,
  );

  const registerRegenerateJob = useCallback(
    (scene: Scene) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      upsertPendingContiSingleJob({
        id,
        projectId,
        versionId: activeVersionIdRef.current,
        sceneId: scene.id,
        sceneNumber: scene.scene_number,
        kind: "regenerate",
        model: contiModel,
        originalUrl: scene.conti_image_url ?? null,
        startedAt: Date.now(),
      });
      return id;
    },
    [contiModel, projectId],
  );

  const clearRegisteredSingleJob = useCallback((jobId: string) => {
    clearPendingContiSingleJob(projectId, jobId);
  }, [projectId]);

  const reconcilePendingContiOutputs = useCallback(async () => {
    const scenes = getSceneState(projectId)?.scenes ?? activeScenes;
    const singleJobs = readPendingContiSingleJobs(projectId);
    for (const job of singleJobs) {
      const jobScenes = job.versionId && job.versionId !== activeVersionIdRef.current
        ? await getScenesForVersion(job.versionId)
        : scenes;
      const scene = jobScenes.find((s) => s.id === job.sceneId);
      if (!scene || (scene.conti_image_url ?? null) !== job.originalUrl) {
        clearPendingContiSingleJob(projectId, job.id);
        if (scene) clearContiLoadingForScene(projectId, scene.id);
        continue;
      }
      const savedUrl = await findSavedContiUrl(projectId, job.sceneNumber, job.startedAt);
      if (!savedUrl) continue;
      await applyGeneratedSceneImage(job.sceneId, savedUrl, job.originalUrl, {
        resetCrop: job.kind === "inpaint" && Boolean(job.body?.__resetCrop),
        versionId: job.versionId,
      });
      clearPendingContiSingleJob(projectId, job.id);
    }

    const generateJob = readPendingContiGenerateJob(projectId);
    if (!generateJob) return;
    const generateScenes = generateJob.versionId && generateJob.versionId !== activeVersionIdRef.current
      ? await getScenesForVersion(generateJob.versionId)
      : scenes;
    for (const sceneId of generateJob.sceneIds) {
      const scene = generateScenes.find((s) => s.id === sceneId);
      if (!scene || (scene.conti_image_url ?? null) !== (generateJob.originalUrls[sceneId] ?? null)) continue;
      const savedUrl = await findSavedContiUrl(projectId, scene.scene_number, generateJob.startedAt);
      if (!savedUrl) continue;
      await applyGeneratedSceneImage(scene.id, savedUrl, generateJob.originalUrls[scene.id] ?? null, {
        versionId: generateJob.versionId,
      });
    }
    const latest =
      generateJob.versionId && generateJob.versionId !== activeVersionIdRef.current
        ? await getScenesForVersion(generateJob.versionId)
        : getSceneState(projectId)?.scenes ?? scenes;
    const stillPending = latest.some(
      (scene) =>
        generateJob.sceneIds.includes(scene.id) &&
        (scene.conti_image_url ?? null) === (generateJob.originalUrls[scene.id] ?? null),
    );
    if (!stillPending) {
      clearPendingContiGenerateJob(projectId, generateJob.id);
      patchLoading(projectId, {
        generatingAll: false,
        generateProgress: null,
        generatingVersionId: null,
        queuedSceneIds: new Set(),
      });
    }
  }, [activeScenes, applyGeneratedSceneImage, getScenesForVersion, projectId]);

  // Phase 1.5: 이전엔 useEffect 의존성에 `reconcilePendingContiOutputs` 가
  // 들어 있어 콜백 deps (activeScenes 등) 가 바뀔 때마다 effect 가 재실행되어
  // setInterval 을 clear / re-set 하는 폭주가 일어났다. 콜백 자체를 ref 로
  // 안정화하고, useEffect 의존성을 [projectId] 로만 좁힌다. 동작은 동일 —
  // pending 없는 tick 은 localStorage 두 번 읽고 즉시 빠지는 cheap path 라
  // hasPending 가드는 interval 내부로 이동했다.
  const reconcileRef = useRef(reconcilePendingContiOutputs);
  useEffect(() => {
    reconcileRef.current = reconcilePendingContiOutputs;
  });

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const hasPending =
        readPendingContiSingleJobs(projectId).length > 0 ||
        readPendingContiGenerateJob(projectId) !== null;
      if (!hasPending) return;
      void reconcileRef.current();
    };
    tick();
    const intervalId = window.setInterval(tick, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [projectId]);

  const handleSceneUpdate = async (sceneNumber: number, fields: Partial<Scene>) => {
    const current = getSceneState(projectId)?.scenes ?? activeScenes;
    const target = current.find((s) => s.scene_number === sceneNumber);
    if (!target) return;
    const dbFields = { ...fields } as Record<string, unknown>;
    // Highlight metadata is primarily version-level creative intent. Older
    // running local-server processes may not yet allow these new columns, so
    // keep the UI/version JSON update silent instead of surfacing adapter 500s.
    delete dbFields.is_highlight;
    delete dbFields.highlight_kind;
    delete dbFields.highlight_reason;
    if (Object.keys(dbFields).length > 0) {
      await supabase.from("scenes").update(dbFields).eq("id", target.id);
    }
    const latest = getSceneState(projectId)?.scenes ?? current;
    const merged = latest.map((s) => (s.scene_number === sceneNumber ? { ...s, ...fields } : s));
    await updateVersionScenes(merged);

    // is_final 토글 시 프로젝트 status 자동 동기화.
    //   - non-transition 씬을 기준으로 판단 (TR 카드는 작품 컷이 아님)
    //   - 모든 씬이 final 이면 'completed', 하나라도 해제되면 'active'
    //   - total === 0 (빈 프로젝트) 은 승격 대상 아님
    //   - 이미 desired 상태면 DB write 생략
    if ("is_final" in fields) {
      const real = merged.filter((s) => !s.is_transition);
      const allFinal = real.length > 0 && real.every((s) => s.is_final === true);
      const desired = allFinal ? "completed" : "active";
      if ((projectInfo.status ?? "active") !== desired) {
        const { error } = await supabase.from("projects").update({ status: desired }).eq("id", projectId);
        if (!error) {
          setProjectInfo((prev) => ({ ...prev, status: desired }));
          toast({ title: allFinal ? t("conti.toast.projectCompleted") : t("conti.toast.projectReactivated") });
        }
      }
    }
  };

  const handleSetThumbnail = async (imageUrl: string) => {
    try {
      const { error } = await supabase
        .from("projects")
        .update({ thumbnail_url: imageUrl } as any)
        .eq("id", projectId);
      if (error) throw error;
      toast({ title: t("conti.toast.thumbnailUpdated") });
    } catch (e: any) {
      toast({ variant: "destructive", title: t("conti.toast.thumbnailFailed"), description: e.message });
    }
  };

  /**
   * 씬카드 이미지를 프로젝트의 스타일 프리셋(style_presets)으로 등록 + 현재 프로젝트의 활성 스타일로 즉시 적용.
   * - 해당 씬의 conti_image_url을 다운로드 → style-presets 버킷에 재업로드 → style_presets 행 insert
   * - 등록 성공 시 projects.conti_style_id를 방금 만든 프리셋으로 업데이트 + currentStyle/projectInfo 클라이언트 상태 동기화
   * - 스키마/경로 규약은 StylePickerModal.handleUploadStyle 과 동일.
   */
  const handleRegisterSceneAsStyle = useCallback(
    async (scene: Scene) => {
      if (!scene.conti_image_url) {
        toast({ variant: "destructive", title: t("conti.noImageToRegister") });
        return;
      }
      try {
        const resp = await fetch(scene.conti_image_url);
        if (!resp.ok) throw new Error(`fetch failed (${resp.status})`);
        const blob = await resp.blob();
        const contentType = blob.type || "image/png";
        const ext = contentType.includes("png")
          ? "png"
          : contentType.includes("webp")
            ? "webp"
            : contentType.includes("jpeg") || contentType.includes("jpg")
              ? "jpg"
              : "png";
        const safeName = `scene-${scene.scene_number}-style-${Date.now()}.${ext}`.replace(/[^a-zA-Z0-9._-]/g, "_");
        const storagePath = `${projectId}/${safeName}`;
        const { error: upErr } = await supabase.storage
          .from("style-presets")
          .upload(storagePath, blob, { upsert: true, contentType });
        if (upErr) throw upErr;
        const { data: urlData } = supabase.storage.from("style-presets").getPublicUrl(storagePath);
        const publicUrl = urlData.publicUrl;
        const projectTitle = (projectInfo.title ?? "").trim() || "Untitled Project";
        const sceneLabel = `#${String(scene.scene_number).padStart(2, "0")}`;
        const presetName = `${projectTitle} - ${sceneLabel}`.slice(0, 60);
        const { data: inserted, error: insErr } = await supabase
          .from("style_presets")
          .insert({
            name: presetName,
            description: `From ${projectTitle} · shot #${String(scene.scene_number).padStart(2, "0")}`,
            thumbnail_url: publicUrl,
            style_prompt: "Match the visual style, color palette, and artistic treatment of the reference image.",
            is_default: false,
            user_id: (await supabase.auth.getUser()).data.user?.id ?? null,
          })
          .select()
          .single();
        if (insErr) throw insErr;
        const newPreset = inserted as StylePreset;
        // 프로젝트의 활성 스타일로 즉시 승격
        const { error: projErr } = await supabase
          .from("projects")
          .update({ conti_style_id: newPreset.id })
          .eq("id", projectId);
        if (projErr) throw projErr;
        setCurrentStyle(newPreset);
        setProjectInfo((prev) => ({ ...prev, conti_style_id: newPreset.id }));
        toast({ title: t("conti.toast.styleSetCurrent", { name: newPreset.name }) });
      } catch (e: any) {
        toast({
          variant: "destructive",
          title: t("conti.toast.registerStyleFailed"),
          description: e?.message ?? String(e),
        });
      }
    },
    [projectId, projectInfo.title, toast, t],
  );

  const handleDuplicateScene = async (scene: Scene) => {
    const tempNumber = 90000 + (Date.now() % 10000);
    // Recompute tagged_assets from the duplicated text instead of
    // blindly inheriting. Without this, character/item tags that were
    // carry-over on the source scene (i.e. not actually @-mentioned in
    // the text) silently follow the copy, and the next generation
    // renders ghosts of removed characters (e.g. a scene copied from
    // "@전사가 @바이킹을 조준" to a 1st-person POV rewrite that no
    // longer mentions @전사 still ships @전사's photo as a ref).
    // We trust the text: if a tag is actually mentioned in
    // description/location, it stays; otherwise it's dropped.
    const combinedText = `${scene.description ?? ""} ${scene.location ?? ""}`;
    const mentionedTags: string[] = [];
    const seen = new Set<string>();
    for (const m of combinedText.match(/@[\w가-힣-]+/g) ?? []) {
      const r = resolveAsset(m, assets);
      if (r && !seen.has(r.name)) {
        mentionedTags.push(r.name);
        seen.add(r.name);
      }
    }
    const { data, error } = await supabase
      .from("scenes")
      .insert({
        project_id: projectId,
        scene_number: tempNumber,
        // Duplicate stays in the SAME scene group as its source.
        sequence: scene.sequence ?? null,
        title: t("conti.toast.titleCopy", { title: scene.title ?? "" }),
        description: scene.description,
        camera_angle: scene.camera_angle,
        location: scene.location,
        mood: scene.mood,
        duration_sec: scene.duration_sec,
        tagged_assets: mentionedTags,
        is_highlight: scene.is_highlight ?? false,
        highlight_kind: scene.highlight_kind ?? null,
        highlight_reason: scene.highlight_reason ?? null,
        motion_in: scene.motion_in ?? null,
        motion_out: scene.motion_out ?? null,
        transition_to_next: scene.transition_to_next ?? null,
        conti_image_url: null,
        source: "conti",
      })
      .select()
      .single();
    if (error || !data) {
      toast({ title: t("conti.toast.duplicateFailed"), description: error?.message, variant: "destructive" });
      return;
    }
    // ⚠️ await 이후에는 반드시 모듈 store 로부터 최신 scene 배열을 다시 읽어야 한다.
    // 스타일 변형/전체 생성 루프가 진행 중이면, 위의 await 동안 다른 scene 들의
    // conti_image_url/conti_image_history 가 갱신되어 있다. activeScenes closure 는
    // stale 이라 그대로 쓰면 진행 중이던 변경사항(스타일 결과, 새 history 엔트리)을 롤백시킨다.
    const latest = getSceneState(projectId)?.scenes ?? activeScenes;
    const sourceIdxLatest = latest.findIndex((s) => s.id === scene.id);
    const insertIdx = sourceIdxLatest >= 0 ? sourceIdxLatest + 1 : latest.length;
    const newScenes = [...latest];
    newScenes.splice(insertIdx, 0, data as Scene);
    const renumbered = newScenes.map((s, i) => ({ ...s, scene_number: i + 1 }));
    const tempRenumbered = renumbered.map((s, i) => ({ ...s, scene_number: 80000 + i }));
    await Promise.all(
      tempRenumbered.map((s) => supabase.from("scenes").update({ scene_number: s.scene_number }).eq("id", s.id)),
    );
    await Promise.all(
      renumbered.map((s) => supabase.from("scenes").update({ scene_number: s.scene_number }).eq("id", s.id)),
    );
    await updateVersionScenes(renumbered);
    toast({ title: t("conti.toast.shotDuplicatedPosition", { n: insertIdx + 1 }) });
  };

  const handleDeleteScene = async (sceneId: string, sceneNumber: number) => {
    const snapshot = getSceneState(projectId)?.scenes ?? activeScenes;
    const deletedScene = snapshot.find((s) => s.id === sceneId);
    // 삭제는 하드 딜리트라 되돌리기를 위해 삭제 전 위치(index)와 전체 row 를 스냅샷.
    const deletedIndex = snapshot.findIndex((s) => s.id === sceneId);
    const isTransition = deletedScene?.is_transition;
    await supabase.from("scenes").delete().eq("id", sceneId);
    // await 이후 최신 snapshot 재조회 (스타일 변형 루프가 중간에 다른 scene 업데이트 가능).
    const latest = getSceneState(projectId)?.scenes ?? activeScenes;
    const updated = latest.filter((s) => s.id !== sceneId).map((s, i) => ({ ...s, scene_number: i + 1 }));
    const tempUpdated = updated.map((s, i) => ({ ...s, scene_number: 80000 + i }));
    await Promise.all(
      tempUpdated.map((s) => supabase.from("scenes").update({ scene_number: s.scene_number }).eq("id", s.id)),
    );
    await Promise.all(
      updated.map((s) => supabase.from("scenes").update({ scene_number: s.scene_number }).eq("id", s.id)),
    );
    await updateVersionScenes(updated);
    const transitionLabel = (() => {
      const key = normalizeTransitionKey(deletedScene?.transition_type ?? null);
      return key ? TRANSITION_MAP[key].label : t("conti.transitionDefault");
    })();
    toast({
      duration: 6000,
      title: isTransition
        ? t("conti.toast.transitionDeleted", { label: transitionLabel })
        : t("conti.toast.shotDeleted", { n: String(sceneNumber).padStart(2, "0") }),
      action: deletedScene ? (
        <ToastAction
          altText={t("conti.toast.undo")}
          onClick={(event) => {
            event.preventDefault();
            void restoreDeletedScenes([deletedScene], [deletedIndex]);
          }}
        >
          {t("conti.toast.undo")}
        </ToastAction>
      ) : undefined,
    });
  };

  /* 하드 딜리트한 컷을 되돌린다. 삭제 시점에 잡아둔 원본 row 와 위치(index) 로
     scenes 테이블에 다시 insert 한 뒤, 현재 배열의 해당 위치에 끼워넣고
     scene_number 를 재정렬한다. 여러 컷을 한 번에 복원할 수 있게 배열로 받음
     (bulk 삭제 되돌리기 공용). */
  const restoreDeletedScenes = async (deletedScenes: Scene[], indices: number[]) => {
    if (deletedScenes.length === 0) return;
    try {
      // 1) scenes 테이블에 원본 row 재삽입 (원래 id 유지). is_highlight 등
      //    구버전 로컬 서버에서 미지원일 수 있는 컬럼은 제외하고, 버전 JSON 으로만 복원.
      const insertRows = deletedScenes.map((s, i) => ({
        id: s.id,
        project_id: s.project_id,
        scene_number: 70000 + i,
        sequence: s.sequence ?? null,
        title: s.title,
        description: s.description,
        camera_angle: s.camera_angle,
        location: s.location,
        mood: s.mood,
        duration_sec: s.duration_sec,
        tagged_assets: s.tagged_assets ?? [],
        conti_image_url: s.conti_image_url ?? null,
        conti_image_history: Array.isArray(s.conti_image_history) ? s.conti_image_history : [],
        conti_image_crop: s.conti_image_crop ?? null,
        sketches: s.sketches ?? [],
        is_final: s.is_final ?? false,
        is_transition: s.is_transition ?? false,
        transition_type: s.transition_type ?? null,
        motion_in: s.motion_in ?? null,
        motion_out: s.motion_out ?? null,
        transition_to_next: s.transition_to_next ?? null,
        source: "conti",
      }));
      const { error } = await supabase.from("scenes").insert(insertRows);
      if (error) throw error;

      // 2) 현재 배열에 원래 위치로 끼워넣는다. 인덱스가 작은 것부터 넣어야
      //    뒤따르는 인덱스가 밀리지 않는다.
      const latest = getSceneState(projectId)?.scenes ?? activeScenes;
      const restored = [...latest];
      const ordered = deletedScenes
        .map((s, i) => ({ scene: s, index: indices[i] ?? restored.length }))
        .sort((a, b) => a.index - b.index);
      for (const { scene, index } of ordered) {
        const safeIdx = Math.min(Math.max(index, 0), restored.length);
        restored.splice(safeIdx, 0, { ...scene });
      }
      const renumbered = restored.map((s, i) => ({ ...s, scene_number: i + 1 }));
      const tempRenumbered = renumbered.map((s, i) => ({ ...s, scene_number: 80000 + i }));
      await Promise.all(
        tempRenumbered.map((s) => supabase.from("scenes").update({ scene_number: s.scene_number }).eq("id", s.id)),
      );
      await Promise.all(
        renumbered.map((s) => supabase.from("scenes").update({ scene_number: s.scene_number }).eq("id", s.id)),
      );
      await updateVersionScenes(renumbered);
      toast({ title: t("conti.toast.deleteUndone") });
    } catch (err) {
      toast({
        variant: "destructive",
        title: t("conti.toast.undoFailed"),
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const bulkDeleteScenes = async () => {
    const snapshot = getSceneState(projectId)?.scenes ?? activeScenes;
    const toDelete = snapshot.filter((s) => selectedSceneIds.has(s.id));
    if (toDelete.length === 0) return;
    // 되돌리기용: 삭제 전 원본 row 와 위치(index) 스냅샷.
    const deletedScenes = toDelete.map((s) => ({ ...s }));
    const deletedIndices = toDelete.map((s) => snapshot.findIndex((row) => row.id === s.id));
    await Promise.all(toDelete.map((s) => supabase.from("scenes").delete().eq("id", s.id)));
    const latest = getSceneState(projectId)?.scenes ?? activeScenes;
    const updated = latest
      .filter((s) => !selectedSceneIds.has(s.id))
      .map((s, i) => ({ ...s, scene_number: i + 1 }));
    await Promise.all(
      updated.map((s) => supabase.from("scenes").update({ scene_number: s.scene_number }).eq("id", s.id)),
    );
    await updateVersionScenes(updated);
    setSelectedSceneIds(new Set());
    toast({
      duration: 6000,
      title: t("conti.toast.shotsDeleted", { n: toDelete.length }),
      action: (
        <ToastAction
          altText={t("conti.toast.undo")}
          onClick={(event) => {
            event.preventDefault();
            void restoreDeletedScenes(deletedScenes, deletedIndices);
          }}
        >
          {t("conti.toast.undo")}
        </ToastAction>
      ),
    });
  };

  const handleAddScene = async () => {
    const snapshot = getSceneState(projectId)?.scenes ?? activeScenes;
    const tempNumber = 90000 + (Date.now() % 10000);
    const nextSceneTitleNumber = snapshot.filter((s) => !s.is_transition).length + 1;
    // Appended cut inherits the last non-transition cut's scene group AND
    // location so it reads as a continuation of the current scene (and shows
    // the location by default). The LLM shot plan can still re-group it later.
    const lastCut = [...snapshot].reverse().find((s) => !s.is_transition);
    const inheritedSequence = lastCut?.sequence ?? null;
    const inheritedLocation = lastCut?.location ?? null;
    const inheritedBgTags = inheritBackgroundTagsFrom(lastCut, assetMap);
    const { data, error } = await supabase
      .from("scenes")
      .insert({
        project_id: projectId,
        scene_number: tempNumber,
        sequence: inheritedSequence,
        title: formatDefaultShotTitle(nextSceneTitleNumber),
        description: null,
        camera_angle: null,
        location: inheritedLocation,
        mood: null,
        duration_sec: null,
        tagged_assets: inheritedBgTags,
        conti_image_url: null,
        source: "conti",
      })
      .select()
      .single();
    if (error || !data) {
      toast({ title: t("conti.toast.addShotFailed"), description: error?.message, variant: "destructive" });
      return;
    }
    // await 이후 모듈 store 재조회 — 진행 중인 스타일 변형/생성 결과를 덮어쓰지 않기 위해.
    const latest = getSceneState(projectId)?.scenes ?? activeScenes;
    const updated = [...latest, data as Scene];
    const renumbered = updated.map((s, i) => ({ ...s, scene_number: i + 1 }));
    await supabase.from("scenes").update({ scene_number: renumbered.length }).eq("id", data.id);
    // scene_versions 에 직접 쓰면 imageHistory 병합이 누락되어 히스토리가 유실된다.
    await updateVersionScenes(renumbered);
  };

  const handleInsertSceneAt = async (
    insertIdx: number,
    groupPref?: "before" | "after" | "new",
    opts?: { contiImageUrl?: string; cameraAngle?: string; suppressToast?: boolean },
  ): Promise<Scene | null> => {
    const snapshot = getSceneState(projectId)?.scenes ?? activeScenes;
    const nextSceneTitleNumber = snapshot.slice(0, insertIdx).filter((s) => !s.is_transition).length + 1;
    const tempNumber = 90000 + (Date.now() % 10000);
    // Inserted cut inherits a neighbouring cut's scene group. Default prefers
    // the cut *before* the insertion point (else the one after) so it stays in
    // the surrounding scene. When the insertion sits on a scene boundary the
    // user can explicitly pick the front/back scene via `groupPref`. With
    // `groupPref === "new"` the cut becomes its OWN scene (no group inherited);
    // `materializeSequences({ newSceneAt })` below makes it a distinct group
    // and renumbers the rest.
    const isNewScene = groupPref === "new";
    const before = snapshot.slice(0, insertIdx).reverse().find((s) => !s.is_transition);
    const after = snapshot.slice(insertIdx).find((s) => !s.is_transition);
    // Pick the scene to join (front by default, or the user's explicit choice),
    // and inherit BOTH its sequence and location so the new cut identifies with
    // that scene and shows its location by default.
    // When the user makes an explicit front/back choice, inherit strictly from
    // that scene so the cut lands in the chosen group. With no choice (default
    // = stay in the surrounding scene), fall back front-then-back.
    const beforeHasScene = !!before && (!!before.location || before.sequence != null);
    const joinPref = groupPref === "before" || groupPref === "after" ? groupPref : undefined;
    const source = isNewScene
      ? undefined
      : joinPref
        ? joinPref === "after"
          ? after
          : before
        : beforeHasScene
          ? before
          : after;
    const inheritedSequence = isNewScene
      ? null
      : (joinPref ? source?.sequence : (before?.sequence ?? after?.sequence)) ?? null;
    const inheritedLocation = isNewScene ? null : source?.location ?? null;
    const inheritedBgTags = isNewScene ? [] : inheritBackgroundTagsFrom(source, assetMap);
    const { data, error } = await supabase
      .from("scenes")
      .insert({
        project_id: projectId,
        scene_number: tempNumber,
        sequence: inheritedSequence,
        title: formatDefaultShotTitle(nextSceneTitleNumber),
        description: null,
        camera_angle: opts?.cameraAngle ?? null,
        location: inheritedLocation,
        mood: null,
        duration_sec: null,
        tagged_assets: inheritedBgTags,
        conti_image_url: opts?.contiImageUrl ?? null,
        source: "conti",
      })
      .select()
      .single();
    if (error || !data) {
      toast({ title: t("conti.toast.addShotFailed"), description: error?.message, variant: "destructive" });
      return null;
    }
    // await 이후 모듈 store 재조회.
    const latest = getSceneState(projectId)?.scenes ?? activeScenes;
    const safeInsertIdx = Math.min(insertIdx, latest.length);
    const updated = [...latest];
    updated.splice(safeInsertIdx, 0, data as Scene);
    let renumbered = updated.map((s, i) => ({ ...s, scene_number: i + 1 }));
    // "새 씬으로 추가": make the inserted cut a distinct scene group and freeze
    // every cut's sequence as an explicit ordinal (locks manual grouping).
    if (isNewScene) {
      renumbered = materializeSequences(renumbered, { newSceneAt: (data as Scene).id });
      saveGroupingLocked(activeVersionIdRef.current);
      // Surface the grouping so the user sees the new scene boundary land.
      setShowGroups(true);
    }
    const tempRenumbered = renumbered.map((s, i) => ({ ...s, scene_number: 80000 + i }));
    await Promise.all(
      tempRenumbered.map((s) => supabase.from("scenes").update({ scene_number: s.scene_number }).eq("id", s.id)),
    );
    await Promise.all(
      renumbered.map((s) => supabase.from("scenes").update({ scene_number: s.scene_number }).eq("id", s.id)),
    );
    await updateVersionScenes(renumbered);
    // Callers that drive their own progress/result UI (e.g. Angle Preset →
    // prev/next cut) pass suppressToast to avoid a duplicate position toast.
    if (!opts?.suppressToast) {
      toast({ title: t("conti.toast.shotInsertedPosition", { n: insertIdx + 1 }) });
    }
    return renumbered.find((s) => s.id === (data as Scene).id) ?? (data as Scene);
  };

  // ── Manual scene-boundary controls (card "씬" dropdown) ──
  // Both reuse `materializeSequences`: the boundary set derived from current
  // grouping is mutated by exactly one cut, then every grouped cut's sequence
  // is rewritten as an explicit ordinal. Persisting via updateVersionScenes is
  // enough (sequence lives in the version JSON) and we lock the version so the
  // storyboard-sheet self-heal won't clobber the user's choice.
  const handleStartNewScene = async (sceneId: string) => {
    const latest = getSceneState(projectId)?.scenes ?? activeScenes;
    const next = materializeSequences(latest, { startAt: sceneId });
    if (next === latest) return;
    saveGroupingLocked(activeVersionIdRef.current);
    await updateVersionScenes(next);
    toast({ title: t("conti.toast.sceneSplit") });
  };

  const handleMergeWithPrev = async (sceneId: string) => {
    const latest = getSceneState(projectId)?.scenes ?? activeScenes;
    const next = materializeSequences(latest, { mergeAt: sceneId });
    if (next === latest) return;
    saveGroupingLocked(activeVersionIdRef.current);
    await updateVersionScenes(next);
    toast({ title: t("conti.toast.sceneMerged") });
  };

  const handleInsertTransitionAt = async (idx: number, seedType?: string | null) => {
    const snapshot = getSceneState(projectId)?.scenes ?? activeScenes;
    const prevScene = snapshot[idx - 1];
    const nextScene = snapshot[idx];
    if (!prevScene?.conti_image_url || !nextScene?.conti_image_url) return;
    // 추천 트랜지션(컷의 transition_to_next)에서 호출된 경우 시드한다.
    //  · 정식 기법 키로 정규화되면 → 그 키로(아코디언 선택과 동일).
    //  · 자유 텍스트(모션 특화 한국어 등)면 → "설명 따름(NONE)" + 원문을 전환 의도
    //    (description)로 담아, 프리셋에 갇히지 않고 그 설명대로 생성되게 한다.
    //  · seed 없음(수동 "전환 추가")이면 → 기본 키.
    const seedRaw = seedType?.trim();
    const seededKey = normalizeTransitionKey(seedType);
    const seededType = seededKey ?? (seedRaw ? TRANSITION_NONE : DEFAULT_TRANSITION_KEY);
    const seededIntent = !seededKey && seedRaw ? seedRaw : "";
    const tempNumber = 80000 + (Date.now() % 10000);
    const { data: newScene, error } = await supabase
      .from("scenes")
      .insert({
        project_id: projectId,
        scene_number: tempNumber,
        title: "",
        // 자유 텍스트 추천이면 그 원문을 전환 의도로 시드(생성 시 최우선 지시로 사용).
        description: seededIntent,
        is_transition: true,
        // 정식 키면 그 키, 자유 텍스트면 NONE(설명 따름), seed 없으면 기본 키.
        // 사용자는 TR 카드 피커에서 언제든 변경 가능. 레거시 "TRANSITION" 값은
        // normalizeTransitionKey 로 투명하게 처리된다.
        transition_type: seededType,
        conti_image_url: null,
        source: "conti",
      })
      .select()
      .single();
    if (error || !newScene) {
      toast({ title: t("conti.toast.addTransitionFailed"), description: error?.message, variant: "destructive" });
      return;
    }
    // await 이후 반드시 모듈 store 로 최신 scene 배열을 재조회.
    // 스타일 변형/전체 생성이 진행 중이면 activeScenes closure 는 stale 이므로,
    // 그대로 TR 을 꽂으면 이미 완료된 scene 들의 새 conti_image_url / conti_image_history 가 덮어써진다.
    // prevScene.id 를 기준으로 최신 배열에서 삽입 위치를 다시 계산한다.
    const latest = getSceneState(projectId)?.scenes ?? activeScenes;
    const prevIdxInLatest = latest.findIndex((s) => s.id === prevScene.id);
    const insertIdx = prevIdxInLatest >= 0 ? prevIdxInLatest + 1 : Math.min(idx, latest.length);
    const inserted = [...latest.slice(0, insertIdx), newScene as Scene, ...latest.slice(insertIdx)].map((s, i) => ({
      ...s,
      scene_number: i + 1,
    }));
    await Promise.all(
      inserted.map((s, i) =>
        supabase
          .from("scenes")
          .update({ scene_number: 80000 + i + 1 })
          .eq("id", s.id),
      ),
    );
    await Promise.all(
      inserted.map((s) => supabase.from("scenes").update({ scene_number: s.scene_number }).eq("id", s.id)),
    );
    await updateVersionScenes(inserted);
    toast({ title: t("conti.toast.transitionAdded") });
  };

  const handleTransitionTypeChange = async (scene: Scene, newType: string) => {
    await supabase.from("scenes").update({ transition_type: newType, title: "" }).eq("id", scene.id);
    const latest = getSceneState(projectId)?.scenes ?? activeScenes;
    const updatedScenes = latest.map((s) =>
      s.id === scene.id ? { ...s, transition_type: newType, title: "" } : s,
    );
    await updateVersionScenes(updatedScenes);
    const newLabel = (() => {
      const key = normalizeTransitionKey(newType);
      return key ? TRANSITION_MAP[key].label : newType;
    })();
    toast({ title: t("conti.toast.transitionSet", { label: newLabel }) });
  };

  const handleImportSceneImage = async (sceneNumber: number, imageUrl: string) => {
    const current = getSceneState(projectId)?.scenes ?? activeScenes;
    const target = current.find((s) => s.scene_number === sceneNumber);
    if (!target) return;
    await applyGeneratedSceneImage(target.id, imageUrl, target.conti_image_url ?? null);
    toast({ title: t("conti.toast.shotContiReplaced", { n: String(target.scene_number).padStart(2, "0") }) });
  };

  const handleRollback = async (scene: Scene, url: string) => {
    const current = getSceneState(projectId)?.scenes ?? activeScenes;
    const liveScene = current.find((s) => s.id === scene.id);
    pushHistory(scene.id, liveScene?.conti_image_url ?? scene.conti_image_url);
    await supabase.from("scenes").update({ conti_image_url: url }).eq("id", scene.id);
    const latest = getSceneState(projectId)?.scenes ?? current;
    const updated = latest.map((s) => (s.id === scene.id ? { ...s, conti_image_url: url } : s));
    if (activeVersionId) await updateVersionScenes(updated);
    else {
      setActiveScenes(updated);
      await fetchCurrentScenes();
    }
    bumpCache(scene.scene_number);
    toast({ title: t("conti.toast.shotRestored", { n: String(scene.scene_number).padStart(2, "0") }) });
  };

  /**
   * Background runner for ChangeAngle.
   *
   * Lifecycle, mirrors the inpaint flow so the user gets the same UX:
   *   1) Modal hands off the request synchronously and closes itself.
   *   2) We mark the scene as edit-generating + set a stage so the
   *      SortableContiCard renders its standard `1/1 Generating…` overlay
   *      (see SortableContiCard `isEditGenerating` branch).
   *   3) Network call runs untethered to the modal lifecycle — closing or
   *      reopening the modal does NOT cancel anything.
   *   4) On success, we follow the same write-then-version-sync pattern
   *      used everywhere else (`pushHistory` → DB → updateVersionScenes
   *      → bumpCache) so cards refresh + history works for "Restore".
   *   5) Always clear the spinner state in `finally` so a failed call
   *      doesn't leave the card stuck in Generating.
   *
   * Concurrency guard:
   *   If the same scene already has an edit-generation in flight (could be
   *   inpaint OR a previous ChangeAngle that hasn't returned), we toast
   *   and return early instead of stacking duplicate calls. The card
   *   spinner can only represent one job at a time anyway.
   */
  const runChangeAngle = async (req: ChangeAngleSubmit) => {
    const inFlight = getLoading(projectId).editGeneratingIds;
    if (inFlight.has(req.sceneId)) {
      toast({
        title: t("conti.toast.shotStillGenerating", { n: String(req.sceneNumber).padStart(2, "0") }),
        description: t("conti.toast.waitForEdit"),
        variant: "destructive",
      });
      return;
    }
    const job: PendingContiSingleJob = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      projectId,
      versionId: activeVersionIdRef.current,
      sceneId: req.sceneId,
      sceneNumber: req.sceneNumber,
      kind: "change-angle",
      originalUrl: req.sourceImageUrl,
      startedAt: Date.now(),
      body: req.body,
    };
    upsertPendingContiSingleJob(job);
    setEditGeneratingIds((prev) => new Set(prev).add(req.sceneId));
    setSceneStages((prev) => ({ ...prev, [req.sceneId]: "generating" }));
    // Tag the loading channel with the version this job belongs to so the
    // SortableContiCard render filter can hide the spinner on cuts that
    // share this scene's id but live in a *different* version (sibling
    // copy-version). Without this the loading bleeds across versions —
    // see SortableContiCard `versionMatches` for the consumer side.
    setGeneratingSceneVersionMap((prev) => ({ ...prev, [req.sceneId]: job.versionId }));
    try {
      // Phase 2.0: __jobId carries the persisted job id into the main-process
      // dedup map so a renderer refresh that lands on the same job will
      // re-attach to the existing OpenAI promise instead of paying for a
      // duplicate call. job.id is already in localStorage from the
      // upsertPendingContiSingleJob() above, so a refreshing renderer can
      // discover it and pass the same string back here on resume.
      const { data, error: invokeErr } = await supabase.functions.invoke("openai-image", {
        body: { ...req.body, __jobId: job.id },
      });
      if (invokeErr) throw invokeErr;
      // Phase 1.8: 서버는 timeout/실패 시 throw 가 아닌 HTTP 200 + { error: "..." }
      // 으로 응답한다 (electron/api-handlers.ts ChangeAngle 경로 511-512). 이전 코드는
      // data.error 를 검사하지 않아 토스트가 항상 "no image URL" 로 떨어져 사용자에게
      // 진짜 사유 (timeout / API key 누락 등) 가 사라졌다. 먼저 string error 를 throw
      // 해서 catch 블록이 정확한 사유를 노출하도록 한다.
      const d = data as { publicUrl?: string; url?: string; error?: string; usedModel?: string } | null;
      if (d?.error) throw new Error(d.error);
      const newUrl = d?.publicUrl ?? d?.url ?? null;
      if (!newUrl) throw new Error("Change Angle returned no image URL");
      console.log("[ChangeAngle] success:", { usedModel: d?.usedModel });
      await applyGeneratedSceneImage(req.sceneId, newUrl, req.sourceImageUrl);
      clearPendingContiSingleJob(projectId, job.id);
      toast({
        title: t("conti.toast.changeAngleOk", { n: String(req.sceneNumber).padStart(2, "0") }),
        action: (
          <ToastAction altText={t("conti.toast.viewScene")} onClick={() => scrollToScene(req.sceneId, req.sceneNumber)}>
            {t("conti.toast.viewScene")}
          </ToastAction>
        ),
      });
    } catch (err: any) {
      // Phase 1.8: catch 에서도 pending job 을 비워야 한다. 누락 시 실패한 작업이
      // persisted store 에 남아 다음 마운트에서 resumeSingleJob 이 또 동일 호출을
      // 발사 → 사용자가 무한 12 분 로딩에 갇히는 버그가 발생.
      clearPendingContiSingleJob(projectId, job.id);
      console.error("[ChangeAngle] failed:", err);
      const fk = friendlyGenerationError(err);
      toast({
        title: t("conti.toast.changeAngleFailed", { n: String(req.sceneNumber).padStart(2, "0") }),
        description: fk ? t(fk) : (err?.message ?? String(err)),
        variant: "destructive",
      });
    } finally {
      setEditGeneratingIds((prev) => {
        const n = new Set(prev);
        n.delete(req.sceneId);
        return n;
      });
      setSceneStages((prev) => {
        const n = { ...prev };
        delete n[req.sceneId];
        return n;
      });
      setGeneratingSceneVersionMap((prev) => {
        if (!(req.sceneId in prev)) return prev;
        const n = { ...prev };
        delete n[req.sceneId];
        return n;
      });
    }
  };

  /**
   * Background runner for Relight. Mirror of `runChangeAngle` — same
   * `editGeneratingIds` + `sceneStages` channel so the scene card shows
   * the standard `1/1 Generating…` overlay while the modal stays closed.
   */
  const runRelight = async (req: RelightSubmit) => {
    const inFlight = getLoading(projectId).editGeneratingIds;
    if (inFlight.has(req.sceneId)) {
      toast({
        title: t("conti.toast.shotStillGenerating", { n: String(req.sceneNumber).padStart(2, "0") }),
        description: t("conti.toast.waitForRelight"),
        variant: "destructive",
      });
      return;
    }
    const job: PendingContiSingleJob = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      projectId,
      versionId: activeVersionIdRef.current,
      sceneId: req.sceneId,
      sceneNumber: req.sceneNumber,
      kind: "relight",
      originalUrl: req.sourceImageUrl,
      startedAt: Date.now(),
      body: req.body,
    };
    upsertPendingContiSingleJob(job);
    setEditGeneratingIds((prev) => new Set(prev).add(req.sceneId));
    setSceneStages((prev) => ({ ...prev, [req.sceneId]: "generating" }));
    // See runChangeAngle for the version-tag rationale.
    setGeneratingSceneVersionMap((prev) => ({ ...prev, [req.sceneId]: job.versionId }));
    try {
      // Phase 2.0: see runChangeAngle above for the __jobId rationale.
      const { data, error: invokeErr } = await supabase.functions.invoke("openai-image", {
        body: { ...req.body, __jobId: job.id },
      });
      if (invokeErr) throw invokeErr;
      // Phase 1.8: data.error string 을 먼저 검사 (runChangeAngle 와 동일 패턴).
      const d = data as { publicUrl?: string; url?: string; error?: string } | null;
      if (d?.error) throw new Error(d.error);
      const newUrl = d?.publicUrl ?? d?.url ?? null;
      if (!newUrl) throw new Error("Relight returned no image URL");
      await applyGeneratedSceneImage(req.sceneId, newUrl, req.sourceImageUrl);
      clearPendingContiSingleJob(projectId, job.id);
      toast({
        title: t("conti.toast.relit", { n: String(req.sceneNumber).padStart(2, "0") }),
        action: (
          <ToastAction altText={t("conti.toast.viewScene")} onClick={() => scrollToScene(req.sceneId, req.sceneNumber)}>
            {t("conti.toast.viewScene")}
          </ToastAction>
        ),
      });
    } catch (err: any) {
      // Phase 1.8: 실패 시에도 pending job 제거 — 무한 resume 방지.
      clearPendingContiSingleJob(projectId, job.id);
      console.error("[Relight] failed:", err);
      const fk = friendlyGenerationError(err);
      toast({
        title: t("conti.toast.relightFailed", { n: String(req.sceneNumber).padStart(2, "0") }),
        description: fk ? t(fk) : (err?.message ?? String(err)),
        variant: "destructive",
      });
    } finally {
      setEditGeneratingIds((prev) => {
        const n = new Set(prev);
        n.delete(req.sceneId);
        return n;
      });
      setSceneStages((prev) => {
        const n = { ...prev };
        delete n[req.sceneId];
        return n;
      });
      setGeneratingSceneVersionMap((prev) => {
        if (!(req.sceneId in prev)) return prev;
        const n = { ...prev };
        delete n[req.sceneId];
        return n;
      });
    }
  };

  /**
   * On-demand refine of an EXISTING cut: gpt-image-2 upscale (detail/resolution)
   * + reframe to the project aspect. Mirrors the inpaint/relight background UX
   * (editGeneratingIds + sceneStages spinner) but is non-persistent — not
   * resumed across reload, same as the camera-variation apply. The user's
   * manual thumbnail crop is preserved (no resetCrop); refine keeps framing.
   */
  const runRefineCut = async (scene: Scene) => {
    const src = scene.conti_image_url;
    if (!src) return;
    const inFlight = getLoading(projectId).editGeneratingIds;
    if (inFlight.has(scene.id)) {
      toast({
        title: t("conti.toast.shotStillGenerating", { n: String(scene.scene_number).padStart(2, "0") }),
        variant: "destructive",
      });
      return;
    }
    const versionId = activeVersionIdRef.current;
    setEditGeneratingIds((prev) => new Set(prev).add(scene.id));
    setSceneStages((prev) => ({ ...prev, [scene.id]: "generating" }));
    setGeneratingSceneVersionMap((prev) => ({ ...prev, [scene.id]: versionId }));
    try {
      const { refineExistingCut } = await import("@/lib/storyboardSheet");
      const refined = await refineExistingCut({
        srcUrl: src,
        projectId,
        sceneNumber: scene.scene_number,
        videoFormat,
      });
      await applyGeneratedSceneImage(scene.id, refined, src, { versionId });
      toast({
        title: t("conti.toast.refined", { n: String(scene.scene_number).padStart(2, "0") }),
        action: (
          <ToastAction altText={t("conti.toast.viewScene")} onClick={() => scrollToScene(scene.id, scene.scene_number)}>
            {t("conti.toast.viewScene")}
          </ToastAction>
        ),
      });
    } catch (err: any) {
      console.error("[refineCut] failed:", err);
      const fk = friendlyGenerationError(err);
      toast({
        title: t("conti.toast.refineFailed", { n: String(scene.scene_number).padStart(2, "0") }),
        description: fk ? t(fk) : (err?.message ?? String(err)),
        variant: "destructive",
      });
    } finally {
      setEditGeneratingIds((prev) => {
        const n = new Set(prev);
        n.delete(scene.id);
        return n;
      });
      setSceneStages((prev) => {
        const n = { ...prev };
        delete n[scene.id];
        return n;
      });
      setGeneratingSceneVersionMap((prev) => {
        if (!(scene.id in prev)) return prev;
        const n = { ...prev };
        delete n[scene.id];
        return n;
      });
    }
  };

  const handleUploadConti = async (scene: Scene, file: File) => {
    setUploadingSceneIds((prev) => new Set(prev).add(scene.id));
    // Tag uploads with the active version too, so a sibling copy-version
    // card sharing this scene's id doesn't show an "uploading" overlay.
    setGeneratingSceneVersionMap((prev) => ({ ...prev, [scene.id]: activeVersionIdRef.current }));
    try {
      const ext = file.name.split(".").pop() ?? "jpg";
      const path = `${projectId}/scene_${scene.scene_number}_upload_${Date.now()}.${ext}`;
      const { error: uploadError } = await supabase.storage.from("contis").upload(path, file, { upsert: true });
      if (uploadError) throw new Error(uploadError.message);
      const publicUrl = supabase.storage.from("contis").getPublicUrl(path).data.publicUrl;
      if (!publicUrl) throw new Error("URL generation failed");
      const current = getSceneState(projectId)?.scenes ?? activeScenes;
      const liveScene = current.find((s) => s.id === scene.id);
      await applyGeneratedSceneImage(scene.id, publicUrl, liveScene?.conti_image_url ?? scene.conti_image_url);
      toast({ title: t("conti.toast.imageUploaded", { n: String(scene.scene_number).padStart(2, "0") }) });
    } catch (err: any) {
      toast({ title: t("conti.uploadFailed"), description: err.message, variant: "destructive" });
    } finally {
      setUploadingSceneIds((prev) => {
        const n = new Set(prev);
        n.delete(scene.id);
        return n;
      });
      setGeneratingSceneVersionMap((prev) => {
        if (!(scene.id in prev)) return prev;
        const n = { ...prev };
        delete n[scene.id];
        return n;
      });
    }
  };

  const [showModelMenu, setShowModelMenu] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const MODEL_OPTIONS: { id: ContiModel; name: string; desc: string }[] = [
    { id: "gpt", name: "GPT Image 2", desc: t("conti.modelGptDesc") },
    { id: "nano-banana-2", name: "Nano Banana 2", desc: t("conti.modelNanoDesc") },
  ];
  const CONTI_DEFAULT_MODEL: ContiModel = "gpt";
  useEffect(() => {
    if (!showModelMenu) return;
    const handler = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) setShowModelMenu(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showModelMenu]);

  const handleGenerate = async (scene: Scene, resumeJob?: PendingContiSingleJob) => {
    if (!resumeJob && generatingSceneIds.has(scene.id)) return;
    const job =
      resumeJob ??
      ({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        projectId,
        versionId: activeVersionIdRef.current,
        sceneId: scene.id,
        sceneNumber: scene.scene_number,
        kind: scene.is_transition ? "transition" : scene.conti_image_url ? "regenerate" : "generate",
        model: contiModel,
        originalUrl: scene.conti_image_url ?? null,
        startedAt: Date.now(),
      } satisfies PendingContiSingleJob);

    if (scene.is_transition) {
      const idx = activeScenes.findIndex((s) => s.id === scene.id);
      const prevScene = activeScenes[idx - 1];
      const nextScene = activeScenes[idx + 1];
      if (!prevScene?.conti_image_url || !nextScene?.conti_image_url) {
        toast({ title: t("conti.toast.transitionNeedsAdjacentImages"), variant: "destructive" });
        return;
      }
      setSceneStages((prev) => ({ ...prev, [scene.id]: "translating" }));
      upsertPendingContiSingleJob(job);
      updateGeneratingSceneIds((prev) => new Set(prev).add(scene.id));
      setGeneratingSceneVersionMap((prev) => ({ ...prev, [scene.id]: job.versionId }));
      try {
        const newUrl = await generateTransitionFrame({
          projectId,
          videoFormat,
          briefAnalysis: briefAnalysisRef.current,
          model: job.model ?? contiModel,
          // Phase 2.0: in-flight dedup key (see ContiGenerateOptions.jobId).
          jobId: job.id,
          prev: {
            scene_number: prevScene.scene_number,
            title: prevScene.title,
            description: prevScene.description,
            camera_angle: prevScene.camera_angle,
            mood: prevScene.mood,
            location: prevScene.location,
            conti_image_url: prevScene.conti_image_url,
          },
          next: {
            scene_number: nextScene.scene_number,
            title: nextScene.title,
            description: nextScene.description,
            camera_angle: nextScene.camera_angle,
            mood: nextScene.mood,
            location: nextScene.location,
            conti_image_url: nextScene.conti_image_url,
          },
          tr: {
            scene_number: scene.scene_number,
            description: scene.description,
            transition_type: scene.transition_type,
          },
          // Pass the full board so the Claude pre-pass can build a ±2-scene
          // narrative window around the TR and gauge story position
          // (opening / mid-body / climax / resolution). Without this the
          // model only ever sees the two adjacent shots and can't calibrate
          // technique intensity to where we are in the story.
          allScenes: activeScenes.map((s) => ({
            scene_number: s.scene_number,
            title: s.title,
            description: s.description,
            is_transition: !!s.is_transition,
          })),
          onStageChange: (stage) => setSceneStages((prev) => ({ ...prev, [scene.id]: stage })),
        });
        if (newUrl) {
          await applyGeneratedSceneImage(scene.id, newUrl, scene.conti_image_url, { versionId: job.versionId });
          clearPendingContiSingleJob(projectId, job.id);
        }
      } catch (err: any) {
        toast({ title: t("conti.toast.transitionImageFailed"), description: err.message, variant: "destructive" });
      } finally {
        updateGeneratingSceneIds((prev) => {
          const n = new Set(prev);
          n.delete(scene.id);
          return n;
        });
        setGeneratingSceneVersionMap((prev) => {
          const n = { ...prev };
          delete n[scene.id];
          return n;
        });
        setSceneStages((prev) => {
          const next = { ...prev };
          delete next[scene.id];
          return next;
        });
      }
      return;
    }

    setSceneStages((prev) => ({ ...prev, [scene.id]: "translating" }));
    upsertPendingContiSingleJob(job);
    updateGeneratingSceneIds((prev) => new Set(prev).add(scene.id));
    setGeneratingSceneVersionMap((prev) => ({ ...prev, [scene.id]: job.versionId }));
    try {
      // Generate / Regenerate intentionally does NOT forward currentStyle.
      // Stuffing styleAnchor + styleImageUrl into the same prompt as scene
      // text + mood ref + every tagged asset only diluted the model's
      // attention and produced washed-out style adherence anyway. Style is
      // applied exclusively via the dedicated Style Transfer flow now,
      // which gives the model a focused 2-image (source + style) prompt
      // and reliably picks up the look. The currentStyle chip stays in
      // the toolbar so the Transfer button still works.
      const newUrl = await generateConti({
        scene,
        allScenes: activeScenes,
        projectId,
        videoFormat,
        briefAnalysis: briefAnalysisRef.current,
        model: job.model ?? contiModel,
        onStageChange: (stage) => setSceneStages((prev) => ({ ...prev, [scene.id]: stage })),
        // Phase 2.0: in-flight dedup — see resumeSingleJob/runChangeAngle.
        jobId: job.id,
      });
      await applyGeneratedSceneImage(scene.id, newUrl, scene.conti_image_url, { versionId: job.versionId });
      clearPendingContiSingleJob(projectId, job.id);
    } catch (err: any) {
      toast({
        title: t("conti.toast.shotGenerationFailed", { n: String(scene.scene_number).padStart(2, "0") }),
        description: err.message,
        variant: "destructive",
      });
    } finally {
      updateGeneratingSceneIds((prev) => {
        const n = new Set(prev);
        n.delete(scene.id);
        return n;
      });
      setGeneratingSceneVersionMap((prev) => {
        const n = { ...prev };
        delete n[scene.id];
        return n;
      });
      setSceneStages((prev) => {
        const next = { ...prev };
        delete next[scene.id];
        return next;
      });
    }
  };

  const resumeSingleJob = async (job: PendingContiSingleJob) => {
    const scene = (getSceneState(projectId)?.scenes ?? activeScenes).find((s) => s.id === job.sceneId);
    if (!scene) {
      clearPendingContiSingleJob(projectId, job.id);
      return;
    }
    if ((scene.conti_image_url ?? null) !== job.originalUrl) {
      clearPendingContiSingleJob(projectId, job.id);
      return;
    }
    const savedUrl = await findSavedContiUrl(projectId, job.sceneNumber, job.startedAt);
    if (savedUrl) {
      await applyGeneratedSceneImage(job.sceneId, savedUrl, job.originalUrl, {
        resetCrop: job.kind === "inpaint" && Boolean(job.body?.__resetCrop),
        versionId: job.versionId,
      });
      clearPendingContiSingleJob(projectId, job.id);
      return;
    }
    if (job.kind === "generate" || job.kind === "regenerate" || job.kind === "transition") {
      await handleGenerate(scene, job);
      return;
    }
    if (!job.body) {
      clearPendingContiSingleJob(projectId, job.id);
      return;
    }
    setEditGeneratingIds((prev) => new Set(prev).add(job.sceneId));
    setSceneStages((prev) => ({ ...prev, [job.sceneId]: "generating" }));
    // Tag the loading channel with this job's version so a copy-version
    // sibling card sharing the same scene id doesn't also light up. See
    // SortableContiCard `versionMatches` for the consumer.
    setGeneratingSceneVersionMap((prev) => ({ ...prev, [job.sceneId]: job.versionId ?? null }));
    try {
      const body = { ...job.body };
      const resetCrop = Boolean(body.__resetCrop);
      delete body.__resetCrop;
      // Phase 2.0: re-attach to the in-flight call (if any) by passing the
      // same job.id. If main-process still has the original promise alive
      // (because it never died across the refresh), we get its eventual
      // result for free instead of firing a duplicate. If main is cold
      // (full app restart), this is a fresh call — same as before.
      body.__jobId = job.id;
      const { data, error } = await supabase.functions.invoke("openai-image", { body });
      if (error) throw new Error(error.message);
      // Phase 1.8: 서버는 error 를 string 으로 반환 (HTTP 200 + { error: "..." }).
      // 이전 코드는 (data.error).message 를 읽어 항상 undefined → "Image generation
      // failed" 로 폴백되어 사용자가 실제 사유를 못 봤다. string/object 양쪽 호환.
      const errVal = (data as any)?.error;
      if (errVal) {
        throw new Error(typeof errVal === "string" ? errVal : (errVal?.message ?? "Image generation failed"));
      }
      const newUrl = (data as { publicUrl?: string; url?: string } | null)?.publicUrl ?? (data as any)?.url ?? null;
      if (!newUrl) throw new Error("Image generation returned no URL");
      await applyGeneratedSceneImage(job.sceneId, newUrl, job.originalUrl, { resetCrop, versionId: job.versionId });
      clearPendingContiSingleJob(projectId, job.id);
    } catch (err) {
      // Phase 1.8: resume 실패 시에도 pending job 제거 — 매 마운트마다 또 12 분
      // 로딩이 발사되는 무한 루프 차단. 이전엔 console.warn 만 찍고 넘어가서
      // 사용자가 ContiTab 열 때마다 dead job 이 다시 시도됐다.
      clearPendingContiSingleJob(projectId, job.id);
      console.warn(`[ContiTab] pending ${job.kind} resume failed:`, err);
    } finally {
      setEditGeneratingIds((prev) => {
        const n = new Set(prev);
        n.delete(job.sceneId);
        return n;
      });
      setSceneStages((prev) => {
        const n = { ...prev };
        delete n[job.sceneId];
        return n;
      });
      setGeneratingSceneVersionMap((prev) => {
        if (!(job.sceneId in prev)) return prev;
        const n = { ...prev };
        delete n[job.sceneId];
        return n;
      });
    }
  };

  const runGenerateAll = async (
    mode: "all" | "missing",
    resumeJob?: PendingContiGenerateJob,
  ) => {
    updateGeneratingAll(true);
    const runVersionId = resumeJob?.versionId ?? activeVersionIdRef.current;
    const runModel = resumeJob?.model ?? contiModel;
    setGeneratingVersionId(runVersionId);
    const sourceScenes = runVersionId ? await getScenesForVersion(runVersionId) : getSceneState(projectId)?.scenes ?? activeScenes;
    const basePending =
      resumeJob
        ? sourceScenes.filter((s) => {
            if (!resumeJob.sceneIds.includes(s.id)) return false;
            if (!s.description?.trim() || s.is_transition) return false;
            return (s.conti_image_url ?? null) === (resumeJob.originalUrls[s.id] ?? null);
          })
        : mode === "all"
          ? sourceScenes.filter((s) => s.description?.trim() && !s.is_transition)
          : sourceScenes.filter((s) => !s.conti_image_url && s.description?.trim() && !s.is_transition);
    const pending = basePending;
    const job =
      resumeJob ??
      ({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        projectId,
        versionId: runVersionId,
        mode,
        model: runModel,
        sceneIds: pending.map((s) => s.id),
        originalUrls: Object.fromEntries(pending.map((s) => [s.id, s.conti_image_url ?? null])),
        startedAt: Date.now(),
      } satisfies PendingContiGenerateJob);
    if (pending.length > 0) writePendingContiGenerateJob(job);
    setQueuedSceneIds(new Set(pending.map((s) => s.id)));
    setSceneStages((prev) => {
      const next = { ...prev };
      pending.forEach((s) => {
        next[s.id] = "queued";
      });
      return next;
    });
    setGenerateProgress({ done: 0, total: pending.length });
    // Generate-All matches the single-scene Generate path: no style
    // forwarding. Style is applied only via the explicit Style Transfer
    // flow (Select scenes → Transfer button). See handleGenerate above.

    // 사이클 단위 assets 캐시 (Phase 1.2). 병렬 씬 × 2 SELECT
    // (=fetchTaggedAssets + project tag scan) 의 중복 round-trip 을 1 회로
    // 단축한다. 캐시 빌드가 실패해도 fallback (씬별 캐시 없이 호출 →
    // 기존 경로) 으로 동작이 보존된다.
    let projectAssetsCache: ProjectAssetsCache | undefined;
    try {
      projectAssetsCache = await buildProjectAssetsCache(projectId);
    } catch (cacheErr) {
      console.warn("[runGenerateAll] buildProjectAssetsCache failed, falling back to per-scene fetches:", cacheErr);
      projectAssetsCache = undefined;
    }

    let doneCount = 0;
    // Phase 1.3: per-scene 실패를 누적해 finally 에서 사용자에게 가시화한다.
    // 기존엔 console.error 만 찍고 success toast 만 발행 ⇒ 사용자가 "방금 잔
    // 오류 있었나?" 체감의 직접 발원지였다. runStyleTransferAll 의 패턴을
    // 그대로 차용 (0/all/partial 3-way 토스트). 성공 경로는 !stillPending
    // 가드 유지 — 동작 변화 없음.
    const failedScenes: { sceneNumber: number; reason: string }[] = [];
    try {
      const processScene = async (scene: Scene) => {
        setQueuedSceneIds((prev) => {
          const next = new Set(prev);
          next.delete(scene.id);
          return next;
        });
        updateGeneratingSceneIds((prev) => new Set(prev).add(scene.id));
        setGeneratingSceneVersionMap((prev) => ({ ...prev, [scene.id]: runVersionId }));

        try {
          const savedUrl = resumeJob ? await findSavedContiUrl(projectId, scene.scene_number, job.startedAt) : null;
          if (savedUrl) {
            await applyGeneratedSceneImage(scene.id, savedUrl, job.originalUrls[scene.id] ?? scene.conti_image_url ?? null, {
              versionId: runVersionId,
            });
            return;
          }
          const newUrl = await generateConti({
            scene,
            allScenes: getSceneState(projectId)?.scenes ?? activeScenes,
            projectId,
            videoFormat,
            briefAnalysis: briefAnalysisRef.current,
            model: runModel,
            onStageChange: (stage) =>
              setSceneStages((prev) => (prev[scene.id] === stage ? prev : { ...prev, [scene.id]: stage })),
            projectAssetsCache,
            // Phase 2.0: per-scene dedup key inside the bulk job. If the
            // renderer reloads mid-batch, the in-flight call for each
            // already-running scene re-attaches via this key on resume,
            // and only scenes that were still queued (or that finished
            // before we could read storage) cost a fresh call. See the
            // ContiGenerateOptions.jobId doc for the persisted-id contract.
            jobId: `${job.id}:${scene.id}`,
          });
          await applyGeneratedSceneImage(scene.id, newUrl, scene.conti_image_url, { versionId: runVersionId });
        } catch (err: any) {
          const reason = err?.message ?? String(err);
          console.error(`Scene ${scene.scene_number} generation failed:`, reason);
          failedScenes.push({ sceneNumber: scene.scene_number, reason });
        } finally {
          updateGeneratingSceneIds((prev) => {
            const n = new Set(prev);
            n.delete(scene.id);
            return n;
          });
          setGeneratingSceneVersionMap((prev) => {
            const n = { ...prev };
            delete n[scene.id];
            return n;
          });
          doneCount++;
          setGenerateProgress({ done: doneCount, total: pending.length });
          setSceneStages((prev) => {
            const next = { ...prev };
            delete next[scene.id];
            return next;
          });
        }
      };

      // 동시 실행 상한(GENERATE_CONCURRENCY)을 둔 워커 풀로 돌린다. 슬롯이 비는 즉시
      // 다음 씬을 끌어와 항상 최대 N 개만 in-flight 로 유지한다 (batch 가 아니라 sliding
      // window). 대기 중인 씬은 processScene 진입 전까지 "대기중(queued)" 으로 남고, 풀이
      // 자기 차례에 끌어오면 그 안에서 큐에서 빠지며 spinner 로 전환된다. 이로써 응답들이
      // 동시에 몰려 메인스레드를 포화시켜 탭/워크스페이스 이동이 막히던 문제를 방지한다.
      await runPool(pending, GENERATE_CONCURRENCY, (scene) => processScene(scene));
    } finally {
      await reconcilePendingContiOutputs();
      const latestScenes = runVersionId ? await getScenesForVersion(runVersionId) : getSceneState(projectId)?.scenes ?? activeScenes;
      const stillPending = latestScenes.some(
        (scene) =>
          job.sceneIds.includes(scene.id) &&
          (scene.conti_image_url ?? null) === (job.originalUrls[scene.id] ?? null),
      );
      if (!stillPending) clearPendingContiGenerateJob(projectId, job.id);
      updateGeneratingAll(false);
      setGenerateProgress(null);
      setQueuedSceneIds(new Set());
      setGeneratingVersionId(null);
      // Toast strategy (mirrors runStyleTransferAll):
      //   · 0 failed && !stillPending → 기존 success 토스트
      //   · 0 failed && stillPending  → 토스트 없음 (resume 모드에서 워커가
      //                                  완료 못한 케이스 — 현 동작 보존)
      //   · all failed   → destructive (첫 실패 사유 노출)
      //   · partial      → destructive (count + 첫 실패 사유)
      if (failedScenes.length === 0) {
        if (!stillPending) toast({ title: t("conti.allContiGenerated") });
      } else if (pending.length > 0 && failedScenes.length === pending.length) {
        toast({
          variant: "destructive",
          title: t("conti.generateFailed"),
          description: failedScenes[0].reason,
        });
      } else {
        toast({
          variant: "destructive",
          title: t("conti.generatePartialFailed", { failed: failedScenes.length, total: pending.length }),
          description: t("conti.sceneFailureReason", {
            scene: failedScenes[0].sceneNumber,
            reason: failedScenes[0].reason,
          }),
        });
      }
    }
  };

  useEffect(() => {
    if (restoredPendingGenerateRef.current) return;
    if (activeScenes.length === 0) return;
    const job = readPendingContiGenerateJob(projectId);
    if (!job) {
      restoredPendingGenerateRef.current = true;
      return;
    }
    if (job.versionId && activeVersionId && job.versionId !== activeVersionId) return;
    restoredPendingGenerateRef.current = true;
    void runGenerateAll(job.mode, job);
  }, [activeScenes, activeVersionId, projectId]);

  useEffect(() => {
    if (restoredPendingSingleRef.current) return;
    if (activeScenes.length === 0) return;
    const jobs = restorePendingContiSingleLoading(projectId, activeScenes);
    if (jobs.length === 0) {
      restoredPendingSingleRef.current = true;
      return;
    }
    if (jobs.some((job) => job.versionId && activeVersionId && job.versionId !== activeVersionId)) return;
    restoredPendingSingleRef.current = true;
    jobs.forEach((job) => {
      void resumeSingleJob(job);
    });
  }, [activeScenes, activeVersionId, projectId]);

  const runStyleTransferAll = async (mode: "all" | "selected" = "all") => {
    const runVersionId = activeVersionIdRef.current;
    const targetScenes =
      mode === "selected"
        ? activeScenes.filter((s) => s.conti_image_url && selectedSceneIds.has(s.id))
        : activeScenes.filter((s) => s.conti_image_url);
    if (!currentStyle || targetScenes.length === 0) return;

    setStyleTransferring(true);
    setStyleTransferProgress({ done: 0, total: targetScenes.length });
    // 시작 스태거 대기 중인 scene 은 "대기 중" 으로 표시. 각 scene 이 자기 차례(시작
    // 지연 경과)에 도달하면 큐에서 빠지고 spinner 로 전환된다.
    setQueuedSceneIds(new Set(targetScenes.map((s) => s.id)));

    // ⚠️ NB2 호출은 batch 내에서 병렬로 돌리되,
    // pushHistory / updateVersionScenes (모듈 store / DB 읽고-합치고-쓰기) 는 race condition 을 피하려
    // 단일 체인으로 직렬화한다. (두 scene 이 동시에 getSceneState().scenes 를 읽고 write-back 하면
    // last-writer 가 먼저 쓴 쪽의 conti_image_url 을 덮어쓰는 사고 발생.)
    let postProcessChain: Promise<void> = Promise.resolve();
    const enqueuePostProcess = (task: () => Promise<void>): Promise<void> => {
      postProcessChain = postProcessChain.then(task, task); // 이전 task 실패해도 다음 task 는 진행
      return postProcessChain;
    };
    let doneCount = 0;
    // Track per-scene failures so the outer toast can tell the user
    // *something actually went wrong* instead of always claiming success.
    // Pre-fix this was the source of the "GPT image 2 로 스타일 변형이
    // 안된다" perception: every scene threw, ContiTab silently swallowed
    // the throw into console, and the finally block toasted "Style
    // transfer complete!" — leaving the user staring at unchanged images.
    const failedScenes: { sceneNumber: number; reason: string }[] = [];
    try {
      // 동시 실행 상한(GENERATE_CONCURRENCY)을 둔 워커 풀로 돌린다. 슬롯이 비는 즉시
      // 다음 scene 을 끌어와 항상 최대 N 개만 in-flight 로 유지 (batch 아님, sliding window).
      // 대기 중인 scene 은 풀이 자기 차례에 끌어올 때까지 "대기중(queued)" 으로 남고, 그
      // 시점에 큐에서 빠지며 spinner 채널 / 버전 태깅으로 전환된다. 이로써 응답들이 동시에
      // 몰려 메인스레드를 포화시켜 탭/워크스페이스 이동이 막히던 문제를 방지한다.
      await runPool(targetScenes, GENERATE_CONCURRENCY, async (scene) => {
          // 버전 태깅은 sibling copy-version 이 같은 scene id 로 spinner 를 띄우지
          // 않도록 하기 위함. SortableContiCard `versionMatches` 참고.
          setQueuedSceneIds((prev) => {
            const n = new Set(prev);
            n.delete(scene.id);
            return n;
          });
          setStyleTransferringIds((prev) => {
            const n = new Set(prev);
            n.add(scene.id);
            return n;
          });
          setGeneratingSceneVersionMap((prev) => ({ ...prev, [scene.id]: runVersionId ?? null }));
          try {
            setSceneStages((prev) => ({ ...prev, [scene.id]: "generating" }));
            const oldUrl = scene.conti_image_url;
            console.log("[StyleTransfer/ContiTab] ▶ start scene", scene.scene_number, {
              id: scene.id,
              oldUrl,
              hasCurrentStyle: !!currentStyle,
              styleThumbUrl: currentStyle?.thumbnail_url ?? null,
              is_transition: !!scene.is_transition,
            });
            const newUrl = await styleTransfer({
              scene,
              projectId,
              videoFormat,
              styleImageUrl: currentStyle?.thumbnail_url ?? null,
              // 스타일 적용은 컨티 토글과 분리 — 자체 Settings 기본값(모델/품질)을 따른다.
              model: getImageModelDefault("style") as "gpt" | "nano-banana-2",
              quality: getGptQualityDefault("style"),
              onStageChange: (stage) => setSceneStages((prev) => ({ ...prev, [scene.id]: stage })),
            });
            console.log("[StyleTransfer/ContiTab] ✓ got newUrl for scene", scene.scene_number, newUrl);
            // post-processing 을 체인에 enqueue — 완료될 때까지 await 해서 진행률/로딩 UI 가 정확히 맞도록.
            await enqueuePostProcess(async () => {
              // styleTransfer() 가 scenes 테이블의 conti_image_crop 도 null 로 비웠다.
              // (새 이미지의 자연 비율 = FORMAT_RATIO[videoFormat] = 프리뷰 컨테이너 비율
              //  → 별도 크롭 불필요. 옛 crop 의 좌표는 옛 이미지 콘텐츠 기준이라 새 이미지엔 안 맞음.)
              // 버전 JSON 도 동일하게 비워서 일관성 유지.
              let nextHistory: string[] | null = null;
              await updateVersionScenes(
                (current) =>
                  current.map((s) => {
                    if (s.id !== scene.id) return s;
                    const existing = Array.isArray(s.conti_image_history) ? s.conti_image_history : [];
                    const history = oldUrl
                      ? [oldUrl, ...existing.filter((u) => u !== oldUrl)].slice(0, MAX_HISTORY)
                      : existing;
                    nextHistory = history;
                    return { ...s, conti_image_url: newUrl, conti_image_crop: null, conti_image_history: history };
                  }),
                { versionId: runVersionId },
              );
              if (nextHistory) {
                await supabase.from("scenes").update({ conti_image_history: nextHistory }).eq("id", scene.id);
              }
              if (!runVersionId || runVersionId === activeVersionIdRef.current) bumpCache(scene.scene_number);
              doneCount += 1;
              setStyleTransferProgress({ done: doneCount, total: targetScenes.length });
              console.log("[StyleTransfer/ContiTab] ✓ done scene", scene.scene_number);
            });
          } catch (err: any) {
            const reason = err?.message ?? String(err);
            console.error(
              `[StyleTransfer/ContiTab] ✗ Scene ${scene.scene_number} FAILED:`,
              reason,
              err?.stack ?? err,
            );
            failedScenes.push({ sceneNumber: scene.scene_number, reason });
          } finally {
            setStyleTransferringIds((prev) => {
              const n = new Set(prev);
              n.delete(scene.id);
              return n;
            });
            setSceneStages((prev) => {
              const n = { ...prev };
              delete n[scene.id];
              return n;
            });
            setGeneratingSceneVersionMap((prev) => {
              if (!(scene.id in prev)) return prev;
              const n = { ...prev };
              delete n[scene.id];
              return n;
            });
          }
      });
      // 마지막 post-process 까지 다 끝난 뒤 종료 (exception-proof).
      await postProcessChain.catch(() => {});
    } finally {
      setStyleTransferring(false);
      setStyleTransferProgress(null);
      setQueuedSceneIds(new Set());
      if (mode === "selected") setSelectedSceneIds(new Set());
      // Toast strategy:
      //   · 0 failed → success
      //   · all failed → loud destructive toast carrying the first error
      //                  detail (e.g. the OpenAI message from gpt-image-2)
      //   · partial → warning toast with counts + first failure reason
      // The first-failure reason is included so the user can act on
      // "OPENAI_API_KEY not set" / "invalid size" / etc. without having
      // to dig through devtools.
      if (failedScenes.length === 0) {
        toast({ title: t("conti.styleTransferComplete") });
      } else if (failedScenes.length === targetScenes.length) {
        toast({
          variant: "destructive",
          title: t("conti.styleTransferFailed"),
          description: failedScenes[0].reason,
        });
      } else {
        toast({
          variant: "destructive",
          title: t("conti.styleTransferPartialFailed", { failed: failedScenes.length, total: targetScenes.length }),
          description: t("conti.sceneFailureReason", {
            scene: failedScenes[0].sceneNumber,
            reason: failedScenes[0].reason,
          }),
        });
      }
    }
  };

  // Phase 1 test: generate ONE multi-panel storyboard sheet from the first
  // cuts via GPT Image 2 and show the raw result (no slicing/assignment yet).
  const loadStoryboardSheets = useCallback(async () => {
    const { data } = await supabase
      .from("storyboard_sheets")
      .select()
      .eq("project_id", projectId)
      .order("created_at", { ascending: false });
    setStoryboardSheets((data as StoryboardSheetRow[]) ?? []);
  }, [projectId]);

  const runStoryboardSheetTest = async () => {
    if (storyboardTesting) return;
    setStoryboardTesting(true);
    try {
      // Generate only the selected cuts when there is a selection; otherwise
      // fall back to the front of the storyboard (format grid count).
      const selected =
        selectedSceneIds.size > 0
          ? activeScenes
              .filter((s) => selectedSceneIds.has(s.id))
              .sort((a, b) => a.scene_number - b.scene_number)
          : activeScenes;

      // Version-scoped production spec (set/palette/cast/cinematography). When the
      // active version predates the spec feature it is null and the sheet builder
      // falls back to the deterministic shotPlan.globalSpec synthesis.
      const activeVersionSpec =
        versionsRef.current.find((v) => v.id === activeVersionIdRef.current)?.production_spec ?? null;

      const { generateStoryboardSheet } = await import("@/lib/storyboardSheet");
      const res = await generateStoryboardSheet({
        scenes: selected as unknown as import("@/lib/storyboardSheet").StoryboardSheetScene[],
        assets: assets as unknown as import("@/lib/storyboardSheet").StoryboardSheetAsset[],
        projectId,
        videoFormat,
        styleAnchor: currentStyle?.style_prompt ?? null,
        briefAnalysis: briefAnalysisRef.current,
        productionSpec: activeVersionSpec,
        quality: getGptQualityDefault("storyboardSheet"),
        onStage: (stage) => setStoryboardPlanning(stage === "planning"),
        // 사용자가 수동으로 묶었으면 시트 프롬프트의 씬 경계도 LLM 숏플랜이 아닌
        // 사용자 sequence(continuityRanges)를 쓰게 한다.
        respectManualGrouping: loadGroupingLocked(activeVersionIdRef.current),
      });
      console.info("[ContiTab] storyboard sheet url", res.url);

      // Persist the sheet so the gallery survives reloads + orphan sweep.
      const sheetId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const sheetRow: StoryboardSheetRow = {
        id: sheetId,
        project_id: projectId,
        url: res.url,
        size_used: res.sizeUsed,
        cut_count: res.cutCount,
        cols: res.cols,
        rows: res.rows,
        scene_ids: JSON.stringify(res.sceneIds),
        video_format: videoFormat,
        created_at: new Date().toISOString(),
      };
      // The local adapter returns { error } instead of throwing, so an unchecked
      // insert fails SILENTLY — the sheet then never lands in the gallery while
      // the auto-apply below still runs (confusing "applied but not saved"
      // state). Surface it so a DB/schema issue is visible instead of swallowed.
      const { error: sheetInsertErr } = await supabase.from("storyboard_sheets").insert(sheetRow);
      if (sheetInsertErr) {
        console.error("[sheet] gallery save failed:", sheetInsertErr.message);
        toast({
          variant: "destructive",
          title: t("conti.sheet.saveFailed"),
          description: sheetInsertErr.message,
        });
      }
      await loadStoryboardSheets();

      // Self-heal: write the shot plan's normalized scene grouping back to the
      // scenes' `sequence` hint so it converges over time (and the deterministic
      // fallback / next shot plan get a better seed). Best-effort — a failure
      // here must NOT block the auto-apply below.
      // Guard: if the user has manually grouped this version, NEVER let the LLM
      // shot plan overwrite their `sequence` — manual grouping is authoritative.
      if (
        !loadGroupingLocked(activeVersionIdRef.current) &&
        res.sequenceBySceneId &&
        Object.keys(res.sequenceBySceneId).length > 0
      ) {
        const seqMap = res.sequenceBySceneId;
        try {
          await updateVersionScenes((current) =>
            current.map((s) => (seqMap[s.id] != null ? { ...s, sequence: seqMap[s.id] } : s)),
          );
        } catch (seqErr) {
          console.warn("[sheet] sequence write-back skipped", seqErr);
        }
      }

      toast({
        title: t("conti.sheet.genDone"),
        description: `${res.cutCount} cuts · ${res.refCount} refs · ${res.sizeUsed}`,
      });

      // Auto-apply: slice → smart-trim → NB2 refine → write each cut.
      await applyStoryboardSheetToConti(sheetRow);
    } catch (e) {
      toast({
        variant: "destructive",
        title: t("conti.sheet.genFailed"),
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setStoryboardTesting(false);
      setStoryboardPlanning(false);
    }
  };

  const deleteStoryboardSheet = async (row: StoryboardSheetRow) => {
    try {
      await deleteStoredFile(row.url);
      await supabase.from("storyboard_sheets").delete().eq("id", row.id);
      setConfirmDeleteSheetId((id) => (id === row.id ? null : id));
      setAppliedSheetId((id) => (id === row.id ? null : id));
      await loadStoryboardSheets();
    } catch (e) {
      toast({ variant: "destructive", title: t("conti.sheet.deleteFailed"), description: e instanceof Error ? e.message : String(e) });
    }
  };

  // Slice a stored sheet into tiles, then per tile: smart-trim white gutters →
  // NB2 refine to the exact cut aspect (full-bleed, upscaled) → apply to
  // scene_ids[i]'s conti image. NB2 failure falls back to center-crop so a cut
  // is always produced. Tiles are processed in parallel with a launch stagger.
  const applyStoryboardSheetToConti = async (row: StoryboardSheetRow) => {
    if (storyboardApplyingId) return;
    // Format guard: the sheet's cells are composed for the format it was
    // generated under. Applying it after the project format changed makes the
    // NB2 refine reframe each (wrong-shaped) cell into the new aspect, which
    // crops content to the wrong region (unfixable via the card's crop reset
    // because the cut IMAGE itself is wrong). Block + prompt a regenerate.
    // Legacy rows (video_format null) fall through to best-effort apply.
    if (row.video_format && row.video_format !== videoFormat) {
      toast({
        variant: "destructive",
        title: t("conti.sheet.formatMismatch"),
        description: t("conti.sheet.formatMismatchDesc", { sheet: row.video_format, project: videoFormat }),
      });
      return;
    }
    setStoryboardApplyingId(row.id);
    // Refresh-safety: persist enough to redo this apply if a reload interrupts
    // it (the GPT sheet is already saved to the gallery; only the per-cut refine
    // would otherwise be lost). Cleared in finally.
    writePendingSheetApplyJob({ projectId, row, startedAt: Date.now() });
    // Per-cut loading: scene ids whose card should show the refine spinner until
    // the (final) image actually lands. Hoisted so the outer finally can clear
    // any leftovers defensively. Uses the same generatingSceneIds mechanism as
    // regenerate so the card overlay is identical and survives tab navigation.
    const refiningSceneIds: string[] = [];
    // Collect NB2 refine errors so a silent center-crop fallback (which quietly
    // collapses cut quality) surfaces its real cause to the user instead of
    // only logging to the console.
    const refineFailures: string[] = [];
    try {
      const { splitContactSheetDataUrl, trimWhiteBorderDataUrl, dataUrlToBase64 } = await import("@/lib/contactSheet");
      const { refineTileToFormat, centerCropToFormatDataUrl } = await import("@/lib/storyboardSheet");
      const cols = row.cols ?? 1;
      const rows = row.rows ?? 1;
      const sceneIds: string[] = JSON.parse(row.scene_ids || "[]");
      const tiles = await splitContactSheetDataUrl(row.url, { rows, cols });

      const pairs = sceneIds
        .map((id, i) => ({ scene: activeScenes.find((s) => s.id === id), tile: tiles[i] }))
        .filter((p): p is { scene: Scene; tile: string } => !!p.scene && !!p.tile);

      // Image-based style is applied per cut via the dedicated style_transfer
      // pass (source = refined cut, style = registered image). This keeps the
      // style picture's CONTENT out of the cut (unlike a generic image ref).
      const styleUrl = currentStyle?.thumbnail_url ?? null;

      setSheetRefineProgress({ done: 0, total: pairs.length });

      // Mark every target cut as loading UP FRONT so all cards show the spinner
      // the moment apply starts (the per-tile stagger only delays when each
      // refine begins — the cards shouldn't look idle while queued). Each id is
      // cleared in its own finally once the final image lands.
      const activeVer = activeVersionIdRef.current;
      for (const { scene } of pairs) refiningSceneIds.push(scene.id);
      updateGeneratingSceneIds((prev) => {
        const next = new Set(prev);
        for (const id of refiningSceneIds) next.add(id);
        return next;
      });
      setGeneratingSceneVersionMap((prev) => {
        const next = { ...prev };
        for (const id of refiningSceneIds) next[id] = activeVer;
        return next;
      });

      let applied = 0;
      const SHEET_REFINE_STAGGER_MS = 600;
      await Promise.all(
        pairs.map(async ({ scene, tile }, idx) => {
          if (idx > 0) await new Promise((r) => setTimeout(r, idx * SHEET_REFINE_STAGGER_MS));
          try {
            const trimmed = await trimWhiteBorderDataUrl(tile);
            // 1) Content refine: full-bleed, exact aspect, upscaled (no style).
            let url: string;
            try {
              url = await refineTileToFormat({
                tileDataUrl: trimmed,
                projectId,
                sceneNumber: scene.scene_number,
                videoFormat,
              });
            } catch (refineErr) {
              console.warn("[sheet] NB2 refine failed, falling back to center-crop:", refineErr);
              refineFailures.push(refineErr instanceof Error ? refineErr.message : String(refineErr));
              const cropped = await centerCropToFormatDataUrl(trimmed, videoFormat);
              const { data } = await supabase.functions.invoke("openai-image", {
                body: {
                  mode: "save_local",
                  imageBase64: dataUrlToBase64(cropped),
                  projectId,
                  sceneNumber: scene.scene_number,
                  suffix: "sheet-cut",
                  folder: "contis",
                },
              });
              const fb = (data as { publicUrl?: string } | null)?.publicUrl;
              if (!fb) throw refineErr;
              url = fb;
            }
            await applyGeneratedSceneImage(scene.id, url, scene.conti_image_url ?? null, { resetCrop: true });

            // 2) Style pass (only when a style is registered). Dedicated
            //    style_transfer separates content (source) from style (ref) so
            //    the registered look is applied without leaking its picture.
            if (styleUrl) {
              try {
                const styledUrl = await styleTransfer({
                  scene: { ...(scene as any), conti_image_url: url, conti_image_crop: null },
                  projectId,
                  styleImageUrl: styleUrl,
                  stylePrompt: currentStyle?.style_prompt ?? undefined,
                  videoFormat,
                });
                await applyGeneratedSceneImage(scene.id, styledUrl, url, { resetCrop: true });
              } catch (styleErr) {
                console.warn("[sheet] style transfer failed, keeping refined cut for scene", scene.scene_number, styleErr);
              }
            }
            applied++;
          } catch (e) {
            console.error("[sheet] apply tile failed for scene", scene.scene_number, e);
          } finally {
            // Clear this cut's spinner only now — after the content refine AND
            // the optional style pass have both swapped in their image — so the
            // card reveals the FINAL image once instead of flashing the
            // intermediate refined frame.
            updateGeneratingSceneIds((prev) => {
              const n = new Set(prev);
              n.delete(scene.id);
              return n;
            });
            setGeneratingSceneVersionMap((prev) => {
              const n = { ...prev };
              delete n[scene.id];
              return n;
            });
            setSheetRefineProgress((prev) => (prev ? { done: prev.done + 1, total: prev.total } : prev));
          }
        }),
      );
      if (applied > 0) setAppliedSheetId(row.id);
      toast({ title: t("conti.sheet.applyDone"), description: t("conti.sheet.applyDoneDesc", { n: applied }) });
      // Surface NB2 refine failures: when the refine throws we silently
      // center-crop (low-res, unrefined look). Show the real cause so the user
      // doesn't have to dig through dev-server logs to learn why quality dropped.
      if (refineFailures.length > 0) {
        console.error("[sheet] refine fell back to center-crop for", refineFailures.length, "cut(s). First error:", refineFailures[0]);
        toast({
          variant: "destructive",
          title: `리파인 실패 ${refineFailures.length}/${pairs.length} — center-crop 폴백(저화질)`,
          description: refineFailures[0],
        });
      }
    } catch (e) {
      toast({ variant: "destructive", title: t("conti.sheet.applyFailed"), description: e instanceof Error ? e.message : String(e) });
    } finally {
      // Defensive: clear any cut spinners that never reached their per-tile
      // finally (e.g. an error thrown before/around the refine loop). No-op when
      // the per-tile cleanup already removed them.
      if (refiningSceneIds.length > 0) {
        updateGeneratingSceneIds((prev) => {
          const n = new Set(prev);
          for (const id of refiningSceneIds) n.delete(id);
          return n;
        });
        setGeneratingSceneVersionMap((prev) => {
          const n = { ...prev };
          for (const id of refiningSceneIds) delete n[id];
          return n;
        });
      }
      setStoryboardApplyingId(null);
      setSheetRefineProgress(null);
      clearPendingSheetApplyJob(projectId, row.id);
    }
  };
  // Keep a ref so the resume effect can call the latest closure (which captures
  // the current activeScenes / currentStyle) without re-subscribing.
  const applyStoryboardSheetToContiRef = useRef(applyStoryboardSheetToConti);
  applyStoryboardSheetToContiRef.current = applyStoryboardSheetToConti;

  useEffect(() => {
    void loadStoryboardSheets();
  }, [loadStoryboardSheets]);

  // Refresh-safety resume: if a previous apply was interrupted (e.g. page
  // reload mid-refine), the sheet is already in the gallery but its cuts never
  // landed. Rather than auto-overwriting conti images on mount (a surprising
  // mutation), we PROMPT once — the user confirms via the toast action to redo
  // the apply. Guarded so it shows at most once per leftover job and never
  // while an apply is already in flight (the navigation case is handled by the
  // module store, which keeps the loading UI alive without re-running).
  const sheetResumeAttemptedRef = useRef(false);
  useEffect(() => {
    if (!isActive) return;
    if (sheetResumeAttemptedRef.current) return;
    if (activeScenes.length === 0) return; // need scenes to map sheet tiles
    const job = readPendingSheetApplyJob(projectId);
    if (!job) return;
    // Already applying (came back to a still-running apply via the module
    // store) → let it finish; don't prompt.
    if (getLoading(projectId).storyboardApplyingId) {
      sheetResumeAttemptedRef.current = true;
      return;
    }
    sheetResumeAttemptedRef.current = true;
    toast({
      title: t("conti.sheet.resumePrompt"),
      description: t("conti.sheet.resumePromptDesc"),
      action: (
        <ToastAction
          altText={t("conti.sheet.resumeAction")}
          onClick={() => {
            void applyStoryboardSheetToContiRef.current(job.row);
          }}
        >
          {t("conti.sheet.resumeAction")}
        </ToastAction>
      ),
    });
  }, [isActive, projectId, activeScenes.length, toast, t]);

  // Lightbox keyboard nav: ←/→ step through sheets, Esc closes. Only bound
  // while the lightbox is open so it never shadows the board's own arrow keys.
  useEffect(() => {
    if (lightboxIndex === null) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setLightboxIndex(null);
        return;
      }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      setStoryboardImgError(false);
      setLightboxIndex((idx) => {
        if (idx === null) return idx;
        const n = storyboardSheets.length;
        if (n === 0) return idx;
        return e.key === "ArrowLeft" ? (idx - 1 + n) % n : (idx + 1) % n;
      });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [lightboxIndex, storyboardSheets.length]);

  // Esc in the gallery returns to the conti board. Only bound when the
  // lightbox is closed so a single Esc doesn't collapse both layers at once
  // (lightbox owns Esc while it's open — see the effect above).
  useEffect(() => {
    if (!storyboardGalleryOpen || lightboxIndex !== null) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setStoryboardGalleryOpen(false);
        setConfirmDeleteSheetId(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [storyboardGalleryOpen, lightboxIndex]);

  const handleDragStart = (event: DragStartEvent) => {
    const id = event.active.id as string;
    setDragActiveId(id);
    const scene = activeScenes.find((s) => s.id === id);
    if (scene) {
      const el = document.getElementById(`conti-scene-${scene.scene_number}`);
      if (el) {
        const clone = el.cloneNode(true) as HTMLDivElement;
        clone.style.width = `${el.offsetWidth}px`;
        dragCloneRef.current = clone;
      }
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setDragActiveId(null);
    dragCloneRef.current = null;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    // 스타일 변형/생성이 진행 중이어도 드래그 이동이 안전하도록 최신 snapshot 사용.
    const snapshot = getSceneState(projectId)?.scenes ?? activeScenes;
    const oldIdx = snapshot.findIndex((s) => s.id === active.id);
    const newIdx = snapshot.findIndex((s) => s.id === over.id);
    if (oldIdx === -1 || newIdx === -1) return;
    const reordered = arrayMove(snapshot, oldIdx, newIdx).map((s, i) => ({ ...s, scene_number: i + 1 }));
    // Drag policy: when the user has manually grouped (locked), a dropped cut
    // JOINS the scene it lands in (attach to the previous neighbour's group)
    // so the result is consistent regardless of the cut's stale sequence.
    // Untouched projects keep the legacy derived behaviour (no implicit lock).
    let finalScenes = reordered;
    if (loadGroupingLocked(activeVersionIdRef.current)) {
      const moved = reordered.find((s) => s.id === active.id);
      if (moved && !moved.is_transition) {
        finalScenes = materializeSequences(reordered, { attachToPrev: active.id as string });
      }
    }
    // ⚠️ 순서 중요 — 이전엔 DB write 50~200ms 를 *먼저* await 한 뒤 state 갱신해서
    // drop 직후 source 카드가 OLD 위치에 한 두 프레임 visible 로 남는 flicker 발생.
    // updateVersionScenes 내부의 setActiveScenesState 가 동기 실행되므로
    // 이걸 *제일 먼저* 호출 → UI 즉시 새 순서로 reflow. scenes 테이블 row 별
    // scene_number 업데이트는 그 다음에 (실패해도 다음 reorder 가 덮어씀).
    await updateVersionScenes(finalScenes);
    await Promise.all(
      finalScenes.map((s) => supabase.from("scenes").update({ scene_number: s.scene_number }).eq("id", s.id)),
    );
  };

  function getExportCrop(
    stored: unknown,
    fmt: string,
  ): { x: number; y: number; scale: number; rotate?: number; ia?: number } | null {
    if (!stored || typeof stored !== "object") return null;
    const map = stored as Record<string, any>;
    if ("horizontal" in map || "vertical" in map || "square" in map) {
      const c = map[fmt];
      if (c && c._v === 2) return c;
      return null;
    }
    const s = stored as any;
    if (!s._v) return s;
    return null;
  }

  function computeExportImageLayout(imgAspect: number, containerAspect: number, scale: number, x: number, y: number) {
    let covWR: number, covHR: number;
    if (imgAspect >= containerAspect) {
      covHR = 1;
      covWR = imgAspect / containerAspect;
    } else {
      covWR = 1;
      covHR = containerAspect / imgAspect;
    }
    const s = scale + 0.2;
    const wPct = s * covWR * 100;
    const hPct = s * covHR * 100;
    return { wPct, hPct, leftPct: 50 - wPct / 2 + x, topPct: 50 - hPct / 2 + y };
  }

  function getExportSceneLabel(scene: Scene, scenes: Scene[]) {
    if (scene.is_transition) return "TR";
    let counter = 0;
    for (const s of scenes) {
      if (!s.is_transition) counter++;
      if (s.id === scene.id) break;
    }
    return `#${String(counter).padStart(2, "0")}`;
  }

  function getExportTransitionInfo(scene: Scene, scenes: Scene[]) {
    const idx = scenes.findIndex((s) => s.id === scene.id);
    const realLabelAt = (index: number) => {
      let counter = 0;
      for (let i = 0; i <= index; i++) {
        if (!scenes[i]?.is_transition) counter++;
      }
      return `#${String(counter).padStart(2, "0")}`;
    };
    let prevIdx = -1;
    for (let i = idx - 1; i >= 0; i--) {
      if (!scenes[i].is_transition) {
        prevIdx = i;
        break;
      }
    }
    const nextOffset = scenes.slice(idx + 1).findIndex((s) => !s.is_transition);
    const nextIdx = nextOffset >= 0 ? idx + 1 + nextOffset : -1;
    const key = normalizeTransitionKey(scene.transition_type ?? null);
    return {
      flow: prevIdx >= 0 && nextIdx >= 0 ? `${realLabelAt(prevIdx)} → ${realLabelAt(nextIdx)}` : "",
      type: key ? TRANSITION_MAP[key].label : "Transition",
    };
  }

  function appendExportImage(
    imgWrap: HTMLDivElement,
    scene: Scene,
    renderMode: "page" | "individual" = "page",
  ) {
    const exportCrop = getExportCrop(scene.conti_image_crop, videoFormat);
    const createBgEl = (cssText: string) => {
      const bgEl = document.createElement("div");
      bgEl.style.cssText = cssText;
      imgWrap.appendChild(bgEl);
    };

    if (exportCrop) {
      const containerAspect = videoFormat === "vertical" ? 9 / 16 : videoFormat === "square" ? 1 : 16 / 9;
      const ia = exportCrop.ia ?? containerAspect;
      const layout = computeExportImageLayout(
        ia,
        containerAspect,
        exportCrop.scale,
        exportCrop.x,
        exportCrop.y,
      );
      createBgEl(
        `position:absolute;width:${layout.wPct}%;height:${layout.hPct}%;left:${layout.leftPct}%;top:${layout.topPct}%;background-image:url("${scene.conti_image_url}");background-size:cover;background-position:center;background-repeat:no-repeat;background-color:#111;${exportCrop.rotate ? `transform:rotate(${exportCrop.rotate}deg);transform-origin:center center;` : ""}`,
      );
      return;
    }

    if (renderMode === "individual") {
      const imgEl = document.createElement("img");
      imgEl.crossOrigin = "anonymous";
      imgEl.src = scene.conti_image_url!;
      imgEl.style.cssText =
        "position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;object-position:center;display:block;";
      imgWrap.appendChild(imgEl);
      return;
    }

    createBgEl(
      `position:absolute;top:0;left:0;width:100%;height:100%;background-image:url("${scene.conti_image_url}");background-size:cover;background-position:center;background-repeat:no-repeat;background-color:#111;`,
    );
  }

  const exportToPDFWithVersions = async (
    selectedVersions: { label: string; scenes: Scene[] }[],
    includeInfoParam: boolean = true,
    cardsPerRow: number = 5,
  ) => {
    setIsExporting(true);
    try {
      const [{ default: html2canvas }, { default: jsPDF }] = await Promise.all([
        import("html2canvas"),
        import("jspdf"),
      ]);
      // 캡처 전에 Pretendard 로드를 보장 — 폴백 폰트(특히 macOS Apple SD Gothic
      // Neo)로 한글이 깨지는 회귀 방지.
      await ensureExportFontsReady();
      const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      const margin = 12;
      const cols = Math.min(6, Math.max(3, Math.round(cardsPerRow)));
      const aspectMap: Record<string, string> = { vertical: "9/16", horizontal: "16/9", square: "1/1" };
      const aspect = aspectMap[videoFormat] ?? "9/16";
      const renderW = 2400;
      const padX = 24;
      const gapPx = 8;
      const cardW = (renderW - padX * 2 - gapPx * (cols - 1)) / cols;
      let isFirstPage = true;
      const stripAt = (s: string) => s.replace(/@/g, "");
      const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const getSceneLabel = (scene: Scene, scenes: Scene[]) => {
        return getExportSceneLabel(scene, scenes);
      };
      const buildMetaRow = (label: string, value: string | null | undefined) => {
        const v = value || "—";
        // PNG export 와 동일 — 카드 폭 대비 9px 은 너무 작아 PDF/ZIP 에서 글자가
        // 파묻힘. 15px 로 상향.
        return `<div style="display:flex; gap:8px; align-items:baseline;"><span style="font-size:15px; font-weight:500; color:#666; width:72px; flex-shrink:0;">${label}</span><span style="font-size:15px; color:#aaa;">${escHtml(v)}</span></div>`;
      };

      for (const { label, scenes } of selectedVersions) {
        const rows: Scene[][] = [];
        for (let i = 0; i < scenes.length; i += cols) rows.push(scenes.slice(i, i + cols));
        const rowsPerPage = 2;
        for (let pageStart = 0; pageStart < rows.length; pageStart += rowsPerPage) {
          if (!isFirstPage) pdf.addPage();
          isFirstPage = false;
          const pageRows = rows.slice(pageStart, pageStart + rowsPerPage);
          const container = document.createElement("div");
          container.style.cssText = `position:fixed; left:-9999px; top:0; z-index:-1; width:${renderW}px; background:#141414; padding:${padX}px; font-family:${EXPORT_FONT_FAMILY}; display:flex; flex-direction:column; gap:10px;`;
          const header = document.createElement("div");
          header.style.cssText = "display:flex; align-items:baseline; gap:10px; margin-bottom:6px;";
          header.innerHTML = `<span style="font-size:22px; font-weight:600; color:#ffffff;">${escHtml(projectInfo.title || "Pre-Flow")}</span><span style="font-size:18px; font-weight:400; color:#f9423a;">${escHtml(label)}</span>`;
          container.appendChild(header);
          const pageCardRows: HTMLDivElement[] = [];
          for (const row of pageRows) {
            const cardsRow = document.createElement("div");
            cardsRow.style.cssText = `display:flex; gap:${gapPx}px; align-items:stretch;`;
            for (const scene of row) {
              const card = document.createElement("div");
              card.style.cssText = `width:${cardW}px; background:#1a1a1a; border:1px solid rgba(255,255,255,0.07); border-radius:0; overflow:hidden; display:flex; flex-direction:column; box-sizing:border-box;`;
              const imgWrap = document.createElement("div");
              imgWrap.style.cssText = `position:relative; width:100%; aspect-ratio:${aspect}; background:#2a2a2a; overflow:hidden; border-radius:0; flex-shrink:0;`;
              if (scene.conti_image_url) {
                appendExportImage(imgWrap, scene);
              } else if (scene.is_transition) {
                const flow = document.createElement("div");
                flow.style.cssText =
                  "position:absolute;top:0;left:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;box-sizing:border-box;";
                const prevIdx = scenes.indexOf(scene);
                let prevLabel = "",
                  nextLabel = "";
                for (let pi = prevIdx - 1; pi >= 0; pi--) {
                  if (!scenes[pi].is_transition) {
                    let dn = 0;
                    for (let j = 0; j <= pi; j++) {
                      if (!scenes[j].is_transition) dn++;
                    }
                    prevLabel = `#${String(dn).padStart(2, "0")}`;
                    break;
                  }
                }
                for (let ni = prevIdx + 1; ni < scenes.length; ni++) {
                  if (!scenes[ni].is_transition) {
                    let dn = 0;
                    for (let j = 0; j <= ni; j++) {
                      if (!scenes[j].is_transition) dn++;
                    }
                    nextLabel = `#${String(dn).padStart(2, "0")}`;
                    break;
                  }
                }
                const svgNs = "http://www.w3.org/2000/svg";
                const svg = document.createElementNS(svgNs, "svg");
                svg.setAttribute("viewBox", "0 0 300 40");
                svg.setAttribute("width", "80%");
                svg.setAttribute("height", "40");
                svg.style.display = "block";
                svg.innerHTML = `<text x="4" y="20" dominant-baseline="middle" fill="#9ca3af" font-size="10" font-family="sans-serif">${prevLabel}</text><line x1="30" y1="20" x2="108" y2="20" stroke="#4b5563" stroke-width="0.8"/><circle cx="111" cy="20" r="3" fill="#4b5563"/><text x="150" y="20" dominant-baseline="middle" text-anchor="middle" fill="#6b7280" font-size="11" font-family="sans-serif">Transition</text><circle cx="189" cy="20" r="3" fill="#4b5563"/><line x1="192" y1="20" x2="264" y2="20" stroke="#4b5563" stroke-width="0.8"/><polygon points="264,16 272,20 264,24" fill="#4b5563"/><text x="276" y="20" dominant-baseline="middle" fill="#9ca3af" font-size="10" font-family="sans-serif">${nextLabel}</text>`;
                flow.appendChild(svg);
                imgWrap.appendChild(flow);
              } else {
                const noImg = document.createElement("div");
                noImg.style.cssText =
                  "width:100%; height:100%; display:flex; align-items:center; justify-content:center; color:#555; font-size:11px;";
                noImg.textContent = "No Image";
                imgWrap.appendChild(noImg);
              }
              card.appendChild(imgWrap);
              const textArea = document.createElement("div");
              textArea.style.cssText =
                "padding:10px 14px 14px 14px; display:flex; flex-direction:column; gap:8px; flex:1;";
              const titleRow = document.createElement("div");
              titleRow.style.cssText = "display:flex; align-items:flex-start; gap:8px;";
              const sceneLabel = document.createElement("div");
              sceneLabel.style.cssText = `font-size:17px; font-weight:700; color:${scene.is_transition ? "#6b7280" : KR}; line-height:1.3; flex-shrink:0;`;
              sceneLabel.textContent = getSceneLabel(scene, scenes);
              titleRow.appendChild(sceneLabel);
              if (scene.is_transition) {
                const info = getExportTransitionInfo(scene, scenes);
                const title = document.createElement("div");
                title.style.cssText =
                  "font-size:17px; font-weight:600; color:#d1d5db; word-break:break-word; line-height:1.3; flex:1;";
                title.textContent = info.flow || info.type;
                titleRow.appendChild(title);
              }
              if (includeInfoParam && !scene.is_transition) {
                const title = document.createElement("div");
                title.style.cssText =
                  "font-size:17px; font-weight:600; color:#ffffff; word-break:break-word; line-height:1.3; flex:1;";
                title.textContent = stripAt(scene.title || `Shot ${scene.scene_number}`);
                titleRow.appendChild(title);
              }
              textArea.appendChild(titleRow);
              if (includeInfoParam) {
                const metaWrap = document.createElement("div");
                metaWrap.style.cssText = "display:flex; flex-direction:column; gap:3px;";
                metaWrap.innerHTML = scene.is_transition
                  ? [buildMetaRow("Type", getExportTransitionInfo(scene, scenes).type)].join("")
                  : [
                      buildMetaRow("Camera", scene.camera_angle ? stripAt(scene.camera_angle) : null),
                      buildMetaRow("Mood", scene.mood ? stripAt(scene.mood) : null),
                      buildMetaRow("Location", scene.location ? stripAt(scene.location) : null),
                      buildMetaRow("Duration", scene.duration_sec ? `${scene.duration_sec}s` : null),
                    ].join("");
                textArea.appendChild(metaWrap);
              }
              if (scene.description) {
                const desc = document.createElement("div");
                desc.style.cssText =
                  "font-size:14px; color:#999; line-height:1.5; margin-top:5px; white-space:pre-wrap; word-break:break-word;";
                desc.textContent = scene.is_transition ? `Beat: ${stripAt(scene.description)}` : stripAt(scene.description);
                textArea.appendChild(desc);
              }
              card.appendChild(textArea);
              cardsRow.appendChild(card);
            }
            container.appendChild(cardsRow);
            pageCardRows.push(cardsRow);
          }
          document.body.appendChild(container);
          const imageUrls = pageRows.flatMap((r) => r.map((s) => s.conti_image_url)).filter(Boolean) as string[];
          await Promise.all(
            imageUrls.map(
              (url) =>
                new Promise<void>((resolve) => {
                  const img = new Image();
                  img.crossOrigin = "anonymous";
                  img.onload = () => resolve();
                  img.onerror = () => resolve();
                  img.src = url;
                }),
            ),
          );
          const allCards = pageCardRows.flatMap((rowEl) =>
            Array.from(rowEl.querySelectorAll<HTMLElement>(":scope > div")),
          );
          let maxCardH = 0;
          allCards.forEach((cardEl) => {
            maxCardH = Math.max(maxCardH, cardEl.offsetHeight);
          });
          allCards.forEach((cardEl) => {
            cardEl.style.height = `${maxCardH}px`;
          });
          const canvas = await html2canvas(container, {
            useCORS: true,
            backgroundColor: "#141414",
            scale: 3,
            imageTimeout: 20000,
          });
          const imgData = canvas.toDataURL("image/png");
          const ratio = canvas.width / canvas.height;
          const contentW = pageW - margin * 2;
          let drawW = contentW;
          let drawH = drawW / ratio;
          if (drawH > pageH - margin * 2) {
            drawH = pageH - margin * 2;
            drawW = drawH * ratio;
          }
          pdf.setFillColor(20, 20, 20);
          pdf.rect(0, 0, pageW, pageH, "F");
          pdf.addImage(imgData, "PNG", (pageW - drawW) / 2, (pageH - drawH) / 2, drawW, drawH);
          document.body.removeChild(container);
        }
      }
      pdf.save(`${projectInfo.title || "pre-flow"}_conti.pdf`);
      toast({ title: t("conti.toast.pdfExported") });
    } catch (err: any) {
      toast({ title: t("conti.toast.pdfExportFailed"), description: err.message, variant: "destructive" });
    } finally {
      setIsExporting(false);
    }
  };

  const exportToPNGWithVersions = async (
    selectedVersions: { label: string; scenes: Scene[] }[],
    scale: number,
    mode: "page" | "individual",
    includeInfo: boolean,
    cardsPerRow: number = 5,
  ) => {
    setIsExporting(true);
    try {
      const html2canvas = (await import("html2canvas")).default;
      // 캡처 전에 Pretendard 로드를 보장 — 폴백 폰트로 한글이 깨지는 회귀 방지.
      await ensureExportFontsReady();
      const allFiles: { name: string; blob: Blob; folder?: string }[] = [];
      const aspectMap: Record<string, string> = { vertical: "9/16", horizontal: "16/9", square: "1/1" };
      const aspect = aspectMap[videoFormat] ?? "9/16";
      const stripAt = (s: string) => s.replace(/@/g, "");
      const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9가-힣_-]/g, "_").slice(0, 30);
      const getSceneLabel = (scene: Scene, scenes: Scene[]) => {
        return getExportSceneLabel(scene, scenes);
      };
      const buildMetaRow = (label: string, value: string | null | undefined, large = false) => {
        const v = value || "—";
        // Page 모드 기본 9px → 15px 로 상향. 카드 폭 464px 에 비해 기존 9px
        // 는 이미지 대비 ~1/90 크기라 PNG export 시 글자가 완전히 파묻힘.
        // large(individual) 모드는 12→15px 로 소폭 조정.
        const fs = large ? "15px" : "15px";
        const lw = large ? "72px" : "72px";
        return `<div style="display:flex; gap:8px; align-items:baseline;"><span style="font-size:${fs}; font-weight:500; color:#666; width:${lw}; flex-shrink:0;">${label}</span><span style="font-size:${fs}; color:#aaa;">${escHtml(v)}</span></div>`;
      };

      if (mode === "page") {
        const cols = Math.min(6, Math.max(3, Math.round(cardsPerRow)));
        const renderW = 2400;
        const padX = 24;
        const gapPx = 8;
        const cardW = (renderW - padX * 2 - gapPx * (cols - 1)) / cols;
        for (const { label, scenes } of selectedVersions) {
          const rows: Scene[][] = [];
          for (let i = 0; i < scenes.length; i += cols) rows.push(scenes.slice(i, i + cols));
          const rowsPerPage = 2;
          const folderName = selectedVersions.length > 1 ? label : undefined;
          for (let pageStart = 0; pageStart < rows.length; pageStart += rowsPerPage) {
            const pageRows = rows.slice(pageStart, pageStart + rowsPerPage);
            const container = document.createElement("div");
            container.style.cssText = `position:fixed; left:-9999px; top:0; z-index:-1; width:${renderW}px; background:#141414; padding:${padX}px; font-family:${EXPORT_FONT_FAMILY}; display:flex; flex-direction:column; gap:10px;`;
            const header = document.createElement("div");
            header.style.cssText = "display:flex; align-items:baseline; gap:10px; margin-bottom:6px;";
            header.innerHTML = `<span style="font-size:22px; font-weight:600; color:#ffffff;">${escHtml(projectInfo.title || "Pre-Flow")}</span><span style="font-size:18px; font-weight:400; color:#f9423a;">${escHtml(label)}</span>`;
            container.appendChild(header);
            const pageCardRows: HTMLDivElement[] = [];
            for (const row of pageRows) {
              const cardsRow = document.createElement("div");
              cardsRow.style.cssText = `display:flex; gap:${gapPx}px; align-items:stretch;`;
              for (const scene of row) {
                const card = document.createElement("div");
                card.style.cssText = `width:${cardW}px; background:#1a1a1a; border:1px solid rgba(255,255,255,0.07); border-radius:0; overflow:hidden; display:flex; flex-direction:column; box-sizing:border-box;`;
                const imgWrap = document.createElement("div");
                imgWrap.style.cssText = `position:relative; width:100%; aspect-ratio:${aspect}; background:#2a2a2a; overflow:hidden; flex-shrink:0;`;
                if (scene.conti_image_url) {
                  appendExportImage(imgWrap, scene);
                } else if (scene.is_transition) {
                  const flow = document.createElement("div");
                  flow.style.cssText =
                    "position:absolute;top:0;left:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;box-sizing:border-box;";
                  const prevIdx = scenes.indexOf(scene);
                  let prevLabel = "",
                    nextLabel = "";
                  for (let pi = prevIdx - 1; pi >= 0; pi--) {
                    if (!scenes[pi].is_transition) {
                      let dn = 0;
                      for (let j = 0; j <= pi; j++) {
                        if (!scenes[j].is_transition) dn++;
                      }
                      prevLabel = `#${String(dn).padStart(2, "0")}`;
                      break;
                    }
                  }
                  for (let ni = prevIdx + 1; ni < scenes.length; ni++) {
                    if (!scenes[ni].is_transition) {
                      let dn = 0;
                      for (let j = 0; j <= ni; j++) {
                        if (!scenes[j].is_transition) dn++;
                      }
                      nextLabel = `#${String(dn).padStart(2, "0")}`;
                      break;
                    }
                  }
                  const svgNs = "http://www.w3.org/2000/svg";
                  const svg = document.createElementNS(svgNs, "svg");
                  svg.setAttribute("viewBox", "0 0 300 40");
                  svg.setAttribute("width", "80%");
                  svg.setAttribute("height", "40");
                  svg.style.display = "block";
                  svg.innerHTML = `<text x="4" y="20" dominant-baseline="middle" fill="#9ca3af" font-size="10" font-family="sans-serif">${prevLabel}</text><line x1="30" y1="20" x2="108" y2="20" stroke="#4b5563" stroke-width="0.8"/><circle cx="111" cy="20" r="3" fill="#4b5563"/><text x="150" y="20" dominant-baseline="middle" text-anchor="middle" fill="#6b7280" font-size="11" font-family="sans-serif">Transition</text><circle cx="189" cy="20" r="3" fill="#4b5563"/><line x1="192" y1="20" x2="264" y2="20" stroke="#4b5563" stroke-width="0.8"/><polygon points="264,16 272,20 264,24" fill="#4b5563"/><text x="276" y="20" dominant-baseline="middle" fill="#9ca3af" font-size="10" font-family="sans-serif">${nextLabel}</text>`;
                  flow.appendChild(svg);
                  imgWrap.appendChild(flow);
                } else {
                  const noImg = document.createElement("div");
                  noImg.style.cssText =
                    "width:100%; height:100%; display:flex; align-items:center; justify-content:center; color:#555; font-size:11px;";
                  noImg.textContent = "No Image";
                  imgWrap.appendChild(noImg);
                }
                card.appendChild(imgWrap);
                // 카드 폭 ~464px 기준 타이포를 1.6~1.8 배 상향. 기존 11/9px
                // 은 이미지 대비 글자가 파묻혀 export 시 가독성이 매우 낮았음.
                const textArea = document.createElement("div");
                textArea.style.cssText =
                  "padding:10px 14px 14px 14px; display:flex; flex-direction:column; gap:8px; flex:1;";
                const titleRow = document.createElement("div");
                titleRow.style.cssText = "display:flex; align-items:flex-start; gap:8px;";
                const sceneLabel = document.createElement("div");
                sceneLabel.style.cssText = `font-size:17px; font-weight:700; color:${scene.is_transition ? "#6b7280" : KR}; line-height:1.3; flex-shrink:0;`;
                sceneLabel.textContent = getSceneLabel(scene, scenes);
                titleRow.appendChild(sceneLabel);
                if (scene.is_transition) {
                  const info = getExportTransitionInfo(scene, scenes);
                  const title = document.createElement("div");
                  title.style.cssText =
                    "font-size:17px; font-weight:600; color:#d1d5db; word-break:break-word; line-height:1.3; flex:1;";
                  title.textContent = info.flow || info.type;
                  titleRow.appendChild(title);
                }
                if (includeInfo && !scene.is_transition) {
                  const title = document.createElement("div");
                  title.style.cssText =
                    "font-size:17px; font-weight:600; color:#ffffff; word-break:break-word; line-height:1.3; flex:1;";
                  title.textContent = stripAt(scene.title || `Shot ${scene.scene_number}`);
                  titleRow.appendChild(title);
                }
                textArea.appendChild(titleRow);
                if (includeInfo) {
                  const metaWrap = document.createElement("div");
                  metaWrap.style.cssText = "display:flex; flex-direction:column; gap:3px;";
                  metaWrap.innerHTML = scene.is_transition
                    ? [buildMetaRow("Type", getExportTransitionInfo(scene, scenes).type)].join("")
                    : [
                        buildMetaRow("Camera", scene.camera_angle ? stripAt(scene.camera_angle) : null),
                        buildMetaRow("Mood", scene.mood ? stripAt(scene.mood) : null),
                        buildMetaRow("Location", scene.location ? stripAt(scene.location) : null),
                        buildMetaRow("Duration", scene.duration_sec ? `${scene.duration_sec}s` : null),
                      ].join("");
                  textArea.appendChild(metaWrap);
                }
                if (scene.description) {
                  const desc = document.createElement("div");
                  desc.style.cssText =
                    "font-size:14px; color:#999; line-height:1.5; margin-top:5px; white-space:pre-wrap; word-break:break-word;";
                  desc.textContent = scene.is_transition ? `Beat: ${stripAt(scene.description)}` : stripAt(scene.description);
                  textArea.appendChild(desc);
                }
                card.appendChild(textArea);
                cardsRow.appendChild(card);
              }
              container.appendChild(cardsRow);
              pageCardRows.push(cardsRow);
            }
            document.body.appendChild(container);
            const bgUrls = pageRows.flatMap((r) => r.map((s) => s.conti_image_url)).filter(Boolean) as string[];
            await Promise.all(
              bgUrls.map(
                (url) =>
                  new Promise<void>((resolve) => {
                    const img = new Image();
                    img.crossOrigin = "anonymous";
                    img.onload = () => resolve();
                    img.onerror = () => resolve();
                    img.src = url;
                  }),
              ),
            );
            const allCards = pageCardRows.flatMap((r) => Array.from(r.querySelectorAll<HTMLElement>(":scope > div")));
            let maxH = 0;
            allCards.forEach((c) => {
              maxH = Math.max(maxH, c.offsetHeight);
            });
            allCards.forEach((c) => {
              c.style.height = `${maxH}px`;
            });
            const canvas = await html2canvas(container, {
              useCORS: true,
              backgroundColor: "#141414",
              scale,
              imageTimeout: 20000,
            });
            const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
            const pageNum = Math.floor(pageStart / rowsPerPage) + 1;
            allFiles.push({ name: `page_${pageNum}.png`, blob, folder: folderName });
            document.body.removeChild(container);
          }
        }
      } else {
        for (const { label, scenes } of selectedVersions) {
          const folderName = selectedVersions.length > 1 ? label : undefined;
          for (const scene of scenes) {
            const container = document.createElement("div");
            container.style.cssText = `position:fixed; left:-9999px; top:0; z-index:-1; width:800px; background:#141414; font-family:${EXPORT_FONT_FAMILY}; display:flex; flex-direction:column;`;
            const imgWrap = document.createElement("div");
            imgWrap.style.cssText = `position:relative; width:100%; aspect-ratio:${aspect}; background:#2a2a2a; overflow:hidden;`;
            if (scene.conti_image_url) {
              appendExportImage(imgWrap, scene, "individual");
            } else if (scene.is_transition) {
              const flow = document.createElement("div");
              flow.style.cssText =
                "position:absolute;top:0;left:0;width:100%;height:100%;display:flex;align-items:center;padding:0 24px;box-sizing:border-box;";
              const prevIdx = scenes.indexOf(scene);
              let prevLabel = "",
                nextLabel = "";
              for (let pi = prevIdx - 1; pi >= 0; pi--) {
                if (!scenes[pi].is_transition) {
                  let dn = 0;
                  for (let j = 0; j <= pi; j++) {
                    if (!scenes[j].is_transition) dn++;
                  }
                  prevLabel = `#${String(dn).padStart(2, "0")}`;
                  break;
                }
              }
              for (let ni = prevIdx + 1; ni < scenes.length; ni++) {
                if (!scenes[ni].is_transition) {
                  let dn = 0;
                  for (let j = 0; j <= ni; j++) {
                    if (!scenes[j].is_transition) dn++;
                  }
                  nextLabel = `#${String(dn).padStart(2, "0")}`;
                  break;
                }
              }
              if (prevLabel) {
                const p = document.createElement("span");
                p.style.cssText =
                  "font-size:14px;font-family:monospace;font-weight:700;color:rgba(255,255,255,0.3);flex-shrink:0;line-height:1;";
                p.textContent = prevLabel;
                flow.appendChild(p);
              }
              const lL = document.createElement("div");
              lL.style.cssText = "flex:1;height:1px;background:rgba(255,255,255,0.15);";
              flow.appendChild(lL);
              const dL = document.createElement("div");
              dL.style.cssText =
                "width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,0.3);flex-shrink:0;";
              flow.appendChild(dL);
              const lM1 = document.createElement("div");
              lM1.style.cssText = "flex:1;height:1px;background:rgba(255,255,255,0.15);";
              flow.appendChild(lM1);
              const cl = document.createElement("span");
              cl.style.cssText =
                "font-size:14px;font-weight:600;color:rgba(255,255,255,0.45);letter-spacing:0.04em;flex-shrink:0;padding:0 10px;line-height:1;";
              cl.textContent = "Transition";
              flow.appendChild(cl);
              const lM2 = document.createElement("div");
              lM2.style.cssText = "flex:1;height:1px;background:rgba(255,255,255,0.15);";
              flow.appendChild(lM2);
              const dR = document.createElement("div");
              dR.style.cssText =
                "width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,0.3);flex-shrink:0;";
              flow.appendChild(dR);
              const lR = document.createElement("div");
              lR.style.cssText = "flex:1;height:1px;background:rgba(255,255,255,0.15);";
              flow.appendChild(lR);
              const ar = document.createElement("div");
              ar.style.cssText =
                "width:0;height:0;border-top:4px solid transparent;border-bottom:4px solid transparent;border-left:7px solid rgba(255,255,255,0.3);flex-shrink:0;";
              flow.appendChild(ar);
              if (nextLabel) {
                const n = document.createElement("span");
                n.style.cssText =
                  "font-size:14px;font-family:monospace;font-weight:700;color:rgba(255,255,255,0.3);flex-shrink:0;padding-left:3px;line-height:1;";
                n.textContent = nextLabel;
                flow.appendChild(n);
              }
              imgWrap.appendChild(flow);
            } else {
              const noImg = document.createElement("div");
              noImg.style.cssText =
                "width:100%; height:100%; display:flex; align-items:center; justify-content:center; color:#555; font-size:14px;";
              noImg.textContent = "No Image";
              imgWrap.appendChild(noImg);
            }
            container.appendChild(imgWrap);
            // Individual 모드 800px 컨테이너에 1000px+ 이미지 → 14px 텍스트는
            // 상대적으로 작아 보임. 20px 라인으로 통일해서 export 가독성 확보.
            const textArea = document.createElement("div");
            textArea.style.cssText =
              "padding:14px 18px 20px; display:flex; flex-direction:column; gap:8px; background:#1a1a1a;";
            const indTitleRow = document.createElement("div");
            indTitleRow.style.cssText = "display:flex; align-items:baseline; gap:10px;";
            const indSceneLabel = document.createElement("span");
            indSceneLabel.style.cssText = `font-size:20px; font-weight:700; color:${scene.is_transition ? "#6b7280" : KR}; line-height:1.3; flex-shrink:0;`;
            indSceneLabel.textContent = getSceneLabel(scene, scenes);
            indTitleRow.appendChild(indSceneLabel);
            if (scene.is_transition) {
              const info = getExportTransitionInfo(scene, scenes);
              const indTitleEl = document.createElement("span");
              indTitleEl.style.cssText =
                "font-size:20px; font-weight:600; color:#d1d5db; line-height:1.3; word-break:break-word;";
              indTitleEl.textContent = info.flow || info.type;
              indTitleRow.appendChild(indTitleEl);
            }
            if (includeInfo && !scene.is_transition) {
              const indTitleEl = document.createElement("span");
              indTitleEl.style.cssText =
                "font-size:20px; font-weight:600; color:#ffffff; line-height:1.3; word-break:break-word;";
              indTitleEl.textContent = stripAt(scene.title || `Shot ${scene.scene_number}`);
              indTitleRow.appendChild(indTitleEl);
            }
            textArea.appendChild(indTitleRow);
            if (includeInfo && !scene.is_transition) {
              const indMetaWrap = document.createElement("div");
              indMetaWrap.style.cssText = "display:flex; flex-direction:column; gap:4px;";
              indMetaWrap.innerHTML = [
                buildMetaRow("Camera", scene.camera_angle ? stripAt(scene.camera_angle) : null, true),
                buildMetaRow("Mood", scene.mood ? stripAt(scene.mood) : null, true),
                buildMetaRow("Location", scene.location ? stripAt(scene.location) : null, true),
                buildMetaRow("Duration", scene.duration_sec ? `${scene.duration_sec}s` : null, true),
              ].join("");
              textArea.appendChild(indMetaWrap);
            }
            if (includeInfo && scene.is_transition) {
              const indMetaWrap = document.createElement("div");
              indMetaWrap.style.cssText = "display:flex; flex-direction:column; gap:4px;";
              indMetaWrap.innerHTML = [buildMetaRow("Type", getExportTransitionInfo(scene, scenes).type, true)].join("");
              textArea.appendChild(indMetaWrap);
            }
            if (scene.description) {
              const indDesc = document.createElement("div");
              indDesc.style.cssText =
                "font-size:16px; color:#999; line-height:1.55; white-space:pre-wrap; word-break:break-word;";
              indDesc.textContent = scene.is_transition ? `Beat: ${stripAt(scene.description)}` : stripAt(scene.description);
              textArea.appendChild(indDesc);
            }
            container.appendChild(textArea);
            document.body.appendChild(container);
            if (scene.conti_image_url) {
              await new Promise<void>((resolve) => {
                const img = new Image();
                img.crossOrigin = "anonymous";
                img.onload = () => resolve();
                img.onerror = () => resolve();
                img.src = scene.conti_image_url!;
              });
            }
            const canvas = await html2canvas(container, {
              useCORS: true,
              backgroundColor: "#141414",
              scale,
              imageTimeout: 20000,
            });
            const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
            const fileName = `${getSceneLabel(scene, scenes)}_${sanitize(scene.title || "untitled")}.png`;
            allFiles.push({ name: fileName, blob, folder: folderName });
            document.body.removeChild(container);
          }
        }
      }

      if (allFiles.length === 1) {
        const f = allFiles[0];
        const url = URL.createObjectURL(f.blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = f.name;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        const JSZip = (await import("jszip")).default;
        const zip = new JSZip();
        for (const f of allFiles) {
          if (f.folder) zip.folder(f.folder)!.file(f.name, f.blob);
          else zip.file(f.name, f.blob);
        }
        const zipBlob = await zip.generateAsync({ type: "blob" });
        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${projectInfo.title || "pre-flow"}_conti${mode === "individual" ? "_shots" : ""}.zip`;
        a.click();
        URL.revokeObjectURL(url);
      }
      toast({ title: t("conti.toast.pngExported") });
    } catch (err: any) {
      toast({ title: t("conti.toast.pngExportFailed"), description: err.message, variant: "destructive" });
    } finally {
      setIsExporting(false);
    }
  };

  // assets 배열의 정체성이 바뀔 때만 재계산. 이전에는 매 렌더마다 새 객체를
  // 만들어 SortableContiCard 의 memo() shallow compare 가 매번 깨졌다.
  const assetMap = useMemo<Record<string, Asset>>(() => {
    const m: Record<string, Asset> = {};
    for (const a of assets) m[a.tag_name.replace(/^@/, "")] = a;
    return m;
  }, [assets]);

  // ── 카드 핸들러 안정화 (Phase 1.1) ───────────────────────────────────
  // ContiTab 은 Generate All / Style Transfer 진행 중 setSceneStages /
  // setGenerateProgress 가 사이클당 수십~백 회 발사돼 같은 빈도로 재렌더된다.
  // 이전에는 SortableContiCard 로 넘기는 onClickImage / onGenerate / ...
  // 인라인 클로저들이 매 렌더마다 새 함수 ID 로 만들어져 memo() 가 항상 깨졌다.
  //
  // 해결책:
  //   1) 모든 핸들러 구현·setter 를 렌더마다 latestCardDepsRef 로 동기화.
  //   2) 최신 Scene 은 scenesByIdRef 로 lookup → 클로저가 오래된 scene 을
  //      잡아 두지 않는다 (이전 인라인 클로저보다 오히려 안전).
  //   3) scene.id 별 핸들러 번들을 cardHandlersCacheRef 에 영구 캐시 →
  //      식별자만 latest ref 를 들여다보므로 정체성이 영원히 같다.
  //   4) hasImage 게이팅이 필요한 prop (onSetThumbnail 등) 은 호출 측에서
  //      `scene.conti_image_url ? handlers.onX : undefined` 로 분기해
  //      기존 UI gating 동작과 외부 동작이 동일하게 유지된다.
  type CardCallbackBundle = {
    onClickImage: () => void;
    onGenerate: () => void;
    onInpaint: () => void;
    onCompare: () => void;
    onUpload: (file: File) => void;
    onHistory: () => void;
    onDelete: () => void;
    onDuplicate: () => void;
    onSelect: (v: boolean) => void;
    onSetThumbnail: () => void;
    onAdjustImage: () => void;
    onUseAsStyle: () => void;
    onRelight: () => void;
    onCameraVariations: () => void;
    onChangeAngle: () => void;
    onRefineCut: () => void;
    onSketches: () => void;
    onStartNewScene: () => void;
    onMergeWithPrev: () => void;
  };

  const latestCardDepsRef = useRef({
    setStudioInitialTab,
    setStudioVersionId,
    setStudioScene,
    setAdjustingScene,
    setRelightingScene,
    setCameraVariationsScene,
    setChangeAngleScene,
    activeVersionIdRef,
    handleGenerate,
    handleUploadConti,
    handleSceneUpdate,
    handleDeleteScene,
    handleDuplicateScene,
    handleSetThumbnail,
    handleRegisterSceneAsStyle,
    handleTransitionTypeChange,
    toggleSceneSelect,
    runRefineCut,
    handleStartNewScene,
    handleMergeWithPrev,
  });
  // 렌더마다 최신 참조로 갱신. 단순 대입이라 사이드이펙트 없음.
  latestCardDepsRef.current = {
    setStudioInitialTab,
    setStudioVersionId,
    setStudioScene,
    setAdjustingScene,
    setRelightingScene,
    setCameraVariationsScene,
    setChangeAngleScene,
    activeVersionIdRef,
    handleGenerate,
    handleUploadConti,
    handleSceneUpdate,
    handleDeleteScene,
    handleDuplicateScene,
    handleSetThumbnail,
    handleRegisterSceneAsStyle,
    handleTransitionTypeChange,
    toggleSceneSelect,
    runRefineCut,
    handleStartNewScene,
    handleMergeWithPrev,
  };

  const scenesByIdRef = useRef<Map<string, Scene>>(new Map());
  scenesByIdRef.current = useMemo(() => {
    const m = new Map<string, Scene>();
    for (const s of activeScenes) m.set(s.id, s);
    return m;
  }, [activeScenes]);

  const cardHandlersCacheRef = useRef<Map<string, CardCallbackBundle>>(new Map());
  const getCardHandlers = (sceneId: string): CardCallbackBundle => {
    const cached = cardHandlersCacheRef.current.get(sceneId);
    if (cached) return cached;
    const getScene = () => scenesByIdRef.current.get(sceneId);
    const bundle: CardCallbackBundle = {
      onClickImage: () => {
        const s = getScene();
        if (!s) return;
        const r = latestCardDepsRef.current;
        // 콘티 이미지가 없는 씬은 Compare 탭으로 열어서 mood 이미지를
        // 즉시 확인하고 "Use as Conti" 로 활용할 수 있도록 한다.
        r.setStudioInitialTab(s.conti_image_url ? undefined : "compare");
        r.setStudioVersionId(r.activeVersionIdRef.current);
        r.setStudioScene(s);
      },
      onGenerate: () => {
        const s = getScene();
        if (s) void latestCardDepsRef.current.handleGenerate(s);
      },
      onInpaint: () => {
        const s = getScene();
        if (!s) return;
        const r = latestCardDepsRef.current;
        r.setStudioInitialTab("edit");
        r.setStudioVersionId(r.activeVersionIdRef.current);
        r.setStudioScene(s);
      },
      onCompare: () => {
        const s = getScene();
        if (!s) return;
        const r = latestCardDepsRef.current;
        r.setStudioInitialTab("compare");
        r.setStudioVersionId(r.activeVersionIdRef.current);
        r.setStudioScene(s);
      },
      onUpload: (file) => {
        const s = getScene();
        if (s) void latestCardDepsRef.current.handleUploadConti(s, file);
      },
      onHistory: () => {
        const s = getScene();
        if (!s) return;
        const r = latestCardDepsRef.current;
        r.setStudioInitialTab("history");
        r.setStudioVersionId(r.activeVersionIdRef.current);
        r.setStudioScene(s);
      },
      onDelete: () => {
        const s = getScene();
        if (s) void latestCardDepsRef.current.handleDeleteScene(s.id, s.scene_number);
      },
      onDuplicate: () => {
        const s = getScene();
        if (s) void latestCardDepsRef.current.handleDuplicateScene(s);
      },
      onSelect: (v) => latestCardDepsRef.current.toggleSceneSelect(sceneId, v),
      onSetThumbnail: () => {
        const s = getScene();
        if (s?.conti_image_url) void latestCardDepsRef.current.handleSetThumbnail(s.conti_image_url);
      },
      onAdjustImage: () => {
        const s = getScene();
        if (s) latestCardDepsRef.current.setAdjustingScene(s);
      },
      onUseAsStyle: () => {
        const s = getScene();
        if (s) void latestCardDepsRef.current.handleRegisterSceneAsStyle(s);
      },
      onRelight: () => {
        const s = getScene();
        if (s) latestCardDepsRef.current.setRelightingScene(s);
      },
      onCameraVariations: () => {
        const s = getScene();
        if (s) latestCardDepsRef.current.setCameraVariationsScene(s);
      },
      onChangeAngle: () => {
        const s = getScene();
        if (s) latestCardDepsRef.current.setChangeAngleScene(s);
      },
      onRefineCut: () => {
        const s = getScene();
        if (s) void latestCardDepsRef.current.runRefineCut(s);
      },
      onSketches: () => {
        const s = getScene();
        if (!s) return;
        const r = latestCardDepsRef.current;
        r.setStudioInitialTab("sketches");
        r.setStudioVersionId(r.activeVersionIdRef.current);
        r.setStudioScene(s);
      },
      onStartNewScene: () => {
        void latestCardDepsRef.current.handleStartNewScene(sceneId);
      },
      onMergeWithPrev: () => {
        void latestCardDepsRef.current.handleMergeWithPrev(sceneId);
      },
    };
    cardHandlersCacheRef.current.set(sceneId, bundle);
    return bundle;
  };

  // 삭제된 씬 핸들러 번들은 다음 effect 사이클에서 GC. 캐시가 무한 성장하지
  // 않도록 하되, 동일 사이클 안에서는 정체성을 유지한다.
  useEffect(() => {
    const cache = cardHandlersCacheRef.current;
    const liveIds = new Set(activeScenes.map((s) => s.id));
    for (const id of cache.keys()) {
      if (!liveIds.has(id)) cache.delete(id);
    }
  }, [activeScenes]);

  // 씬-비특정 공유 핸들러 (매개변수로 식별자를 받으므로 per-scene 클로저 불필요).
  const stableHandleSceneUpdate = useCallback(
    (sceneNumber: number, fields: Partial<Scene>) =>
      latestCardDepsRef.current.handleSceneUpdate(sceneNumber, fields),
    [],
  );
  const stableHandleTransitionTypeChange = useCallback(
    (sceneArg: Scene, newType: string) =>
      latestCardDepsRef.current.handleTransitionTypeChange(sceneArg, newType),
    [],
  );

  const realSceneCount = activeScenes.filter((s) => !s.is_transition).length;
  // single = 가로형(landscape) 행 뷰: 전폭 1열로 카드가 이미지(좌) + 정보(우)
  // 를 좌우로 펼침. auto = 적응형 와이드 그리드(세로 카드).
  const gridClass = viewMode === "single" ? "grid-cols-1" : "";
  const gridStyle: React.CSSProperties =
    viewMode === "auto" ? { gridTemplateColumns: `repeat(auto-fill, minmax(${cardSize}px, 1fr))` } : {};

  // ── Scene-group (sequence) mapping for visualization ──
  // Walk the active scenes (skipping transitions) and assign a 1-based group
  // index per scene id. Grouping key = `sequence` when present, else a
  // location-run (consecutive same non-empty location).
  //
  // Crucial robustness rule: a *blank* cut (no sequence AND no location — e.g.
  // a freshly inserted/generated cut) does NOT break the running group. It
  // continues the previous cut's group so that:
  //   · inserting a blank cut inside a scene keeps the following cut in that
  //     same scene (no "pushed to next scene" jump), and
  //   · deleting such a blank cut can't suddenly merge two neighbours.
  // Only leading blanks (before any group has started) stay ungrouped.
  const sceneGroupMap = useMemo(() => computeSceneGroups(activeScenes), [activeScenes]);

  const noDescriptionCount = activeScenes.filter((s) => !s.is_transition && !s.description?.trim()).length;
  const scenesWithImages = activeScenes.filter((s) => !s.is_transition && s.conti_image_url).length;
  // Transfer 대상 = runStyleTransferAll('all') 의 타깃과 동일해야 버튼에 찍히는
  // 숫자와 실제 처리 건수가 일치한다. 실제 타깃은 TR 카드도 포함하므로
  // 여기서도 is_transition 필터를 뗀다. 서브바의 "Img N/M" 카운터는 여전히
  // "씬 중 이미지 보유 수" 라는 별개 semantic 이라 scenesWithImages 그대로 쓴다.
  const transferableSceneCount = activeScenes.filter((s) => s.conti_image_url).length;
  const dragActiveScene = dragActiveId ? activeScenes.find((s) => s.id === dragActiveId) : null;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── 버전 탭 바 ── */}
      {versions.length > 0 && (
        <DndContext sensors={versionSensors} collisionDetection={closestCenter} onDragEnd={handleVersionDragEnd}>
          <div
            className="flex items-center gap-0.5 px-3 pt-2 pb-0 overflow-x-auto shrink-0"
            style={{ background: "#0d0d0d", borderBottom: "1px solid rgba(255,255,255,0.06)" }}
          >
            <SortableContext items={versions.map((v) => v.id)} strategy={horizontalListSortingStrategy}>
              {versions.map((v, idx) => {
                const isActive = v.id === activeVersionId;
                return (
                  <SortableVersionTab key={v.id} id={v.id}>
                    {(dragListeners, dragAttributes) => (
                      <div className="relative shrink-0 group/vtab">
                        <button
                          onClick={() => switchVersion(v.id)}
                          className="flex items-center gap-1.5 px-3 py-2 text-caption font-mono font-medium transition-colors cursor-pointer active:cursor-grabbing"
                          {...dragListeners}
                          {...dragAttributes}
                          style={{
                            borderBottom: isActive ? `2px solid ${KR}` : "2px solid transparent",
                            color: isActive ? "#f0f0f0" : "rgba(255,255,255,0.3)",
                            background: "transparent",
                            borderRadius: 0,
                          }}
                        >
                          <span
                            className="font-mono text-micro font-bold px-1.5 py-0.5 text-white shrink-0"
                            style={{
                              background: isActive ? KR : "rgba(255,255,255,0.15)",
                              borderRadius: 0,
                              fontFamily: VERSION_TAB_FONT_FAMILY,
                            }}
                          >
                            {t("conti.versionShort", { num: idx + 1 })}
                          </span>
                          <span className="tracking-wide" style={{ fontFamily: VERSION_TAB_FONT_FAMILY }}>
                            {v.version_name || `v${v.version_number}`}
                          </span>
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            const rect = e.currentTarget.getBoundingClientRect();
                            setTabMenuAnchor((prev) =>
                              prev?.id === v.id ? null : { id: v.id, x: rect.left, y: rect.bottom + 4 },
                            );
                          }}
                          className="absolute top-1 right-[-5px] w-4 h-4 flex items-center justify-center opacity-0 group-hover/vtab:opacity-100 hover:!opacity-100 transition-all"
                          style={{ border: "none", cursor: "pointer", borderRadius: 2 }}
                        >
                          <svg width={10} height={10} viewBox="0 0 24 24" fill="rgba(255,255,255,0.4)" stroke="none">
                            <circle cx="12" cy="5" r="2" />
                            <circle cx="12" cy="12" r="2" />
                            <circle cx="12" cy="19" r="2" />
                          </svg>
                        </button>
                      </div>
                    )}
                  </SortableVersionTab>
                );
              })}
            </SortableContext>
            <button
              onClick={() => setShowNewVersionModal(true)}
              className="flex items-center gap-1 px-2 py-1.5 text-2xs font-mono tracking-wide hover:text-foreground transition-colors shrink-0"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "rgba(255,255,255,0.25)",
                fontFamily: VERSION_TAB_FONT_FAMILY,
              }}
            >
              <Plus className="w-2.5 h-2.5" />
              {t("conti.new")}
            </button>
            <div className="flex-1" />
          </div>
        </DndContext>
      )}

      {/* 탭 컨텍스트 메뉴 */}
      {tabMenuAnchor &&
        (() => {
          const menuId = tabMenuAnchor.id;
          return (
            <div
              style={{
                position: "fixed",
                top: tabMenuAnchor.y,
                left: tabMenuAnchor.x,
                zIndex: 300,
                background: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: 0,
                minWidth: 140,
                overflow: "hidden",
                boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
              }}
              onMouseLeave={() => setTabMenuAnchor(null)}
            >
              {[
                {
                  label: t("common.rename"),
                  fn: () => {
                    const v = versions.find((x) => x.id === menuId);
                    if (v) {
                      setRenameVersion(v);
                      setTabMenuAnchor(null);
                    }
                  },
                },
                {
                  label: t("common.delete"),
                  fn: () => {
                    setTabMenuAnchor(null);
                    handleDeleteVersion(menuId);
                  },
                  danger: true,
                },
              ].map((item, i) => (
                <button
                  key={i}
                  onClick={item.fn}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    padding: "9px 14px",
                    fontSize: 12,
                    cursor: "pointer",
                    border: "none",
                    textAlign: "left",
                    fontFamily: "inherit",
                    background: "transparent",
                    color: (item as any).danger ? "hsl(var(--destructive))" : "hsl(var(--foreground))",
                  }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "hsl(var(--muted))")}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
                >
                  {item.label}
                </button>
              ))}
            </div>
          );
        })()}

      {/* ── 서브 바 ── */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 shrink-0"
        style={{ background: "#0d0d0d", borderBottom: "1px solid rgba(255,255,255,0.06)" }}
      >
        <span className="text-2xs font-mono tracking-wide" style={{ color: "rgba(255,255,255,0.35)" }}>
          {t("conti.sceneCountShort", { count: realSceneCount })} ·{" "}
          {t("conti.imageCountShort", {
            done: scenesWithImages,
            total: realSceneCount,
          })}
        </span>
        {noDescriptionCount > 0 && !generatingAll && (
          <span className="text-2xs font-mono" style={{ color: "#d97706" }}>
            ⚠ {t("conti.noDescriptionShort", { count: noDescriptionCount })}
          </span>
        )}
        {generateProgress && (
          <span className="text-2xs font-mono font-bold" style={{ color: KR }}>
            {t("conti.generateProgressShort", { done: generateProgress.done, total: generateProgress.total })}
          </span>
        )}
        {styleTransferProgress && (
          <span className="text-2xs font-mono font-bold" style={{ color: KR }}>
            {t("conti.styleProgressShort", { done: styleTransferProgress.done, total: styleTransferProgress.total })}
          </span>
        )}
        <div className="flex-1" />

        <div className="flex items-center gap-1">
          {/* 뷰 토글 — single(가로형 행 뷰) / auto(그리드 뷰) 둘만 노출.
              아이콘: single = LayoutList(전폭 행 = 이미지 좌 + 정보 우), auto =
              LayoutGrid(4-square, "그리드 뷰" 시각 정체성). */}
          {(["single", "auto"] as ViewMode[]).map((m) => {
            const icons = {
              single: <LayoutList className="w-3 h-3" />,
              auto: <LayoutGrid className="w-3 h-3" />,
            };
            const labels: Record<ViewMode, string> = {
              single: t("conti.viewLandscape"),
              auto: t("conti.viewGrid"),
            };
            return (
              <button
                key={m}
                onClick={() => setViewMode(m)}
                title={labels[m]}
                aria-label={labels[m]}
                className="w-6 h-6 flex items-center justify-center transition-colors"
                style={{
                  background: viewMode === m ? KR_BG : "none",
                  color: viewMode === m ? KR : "rgba(255,255,255,0.3)",
                  border: viewMode === m ? `1px solid ${KR_BORDER2}` : "none",
                  cursor: "pointer",
                  borderRadius: 0,
                }}
              >
                {icons[m]}
              </button>
            );
          })}
          {viewMode === "auto" && (
            // 슬라이더 너비 w-16 → w-40 로 확장. 짧을 땐 한 step(20px)이 한
            // 픽셀 단위로 잡혀 미세 조정이 어려웠음. Library 사이즈 슬라이더와
            // 비슷한 폭(w-40) 으로 잡아 드래그 해상도 확보.
            <div className="flex items-center gap-1.5 ml-1">
              <Minus
                className="w-3 h-3 text-muted-foreground cursor-pointer"
                onClick={() => setCardSize((s) => Math.max(180, s - 20))}
              />
              <input
                type="range"
                min={180}
                max={500}
                step={20}
                value={cardSize}
                onChange={(e) => setCardSize(Number(e.target.value))}
                className="w-40 accent-primary"
              />
              <Plus
                className="w-3 h-3 text-muted-foreground cursor-pointer"
                onClick={() => setCardSize((s) => Math.min(500, s + 20))}
              />
            </div>
          )}

          {/* ── Info field dropdown (next to the size slider) ── */}
          <div className="relative ml-1" ref={infoMenuRef}>
            <button
              onClick={() => setShowInfoMenu((p) => !p)}
              className="flex items-center gap-1.5 px-3 h-8 text-caption font-medium tracking-wide transition-colors"
              style={{
                background: anyInfoVisible ? "rgba(255,255,255,0.09)" : "rgba(255,255,255,0.04)",
                color: anyInfoVisible ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.6)",
                border: showInfoMenu ? `1px solid ${KR}` : "1px solid rgba(255,255,255,0.10)",
                cursor: "pointer",
                borderRadius: 0,
              }}
            >
              {anyInfoVisible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
              {t("conti.info")}
              <ChevronDown
                className="w-3 h-3 opacity-60"
                style={{ transform: showInfoMenu ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}
              />
            </button>
            {showInfoMenu && (
              <div
                className="absolute top-full right-0 mt-1 z-50 border border-border bg-card shadow-lg"
                style={{ borderRadius: 0, minWidth: 200 }}
              >
                <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border">
                  <button
                    onClick={() =>
                      setInfoVis({ title: true, camera: true, mood: true, location: true, duration: true, description: true, motion: true })
                    }
                    className="flex-1 px-2 py-1 text-2xs font-medium transition-colors hover:bg-primary/[0.08]"
                    style={{ border: "1px solid rgba(255,255,255,0.10)", color: "rgba(255,255,255,0.75)", cursor: "pointer", borderRadius: 0 }}
                  >
                    {t("conti.infoAllOn")}
                  </button>
                  <button
                    onClick={() =>
                      setInfoVis({ title: false, camera: false, mood: false, location: false, duration: false, description: false, motion: false })
                    }
                    className="flex-1 px-2 py-1 text-2xs font-medium transition-colors hover:bg-primary/[0.08]"
                    style={{ border: "1px solid rgba(255,255,255,0.10)", color: "rgba(255,255,255,0.75)", cursor: "pointer", borderRadius: 0 }}
                  >
                    {t("conti.infoAllOff")}
                  </button>
                </div>
                {CONTI_INFO_FIELD_ORDER.map((key) => {
                  const on = infoVis[key];
                  return (
                    <button
                      key={key}
                      onClick={() => setInfoVis((p) => ({ ...p, [key]: !p[key] }))}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left text-caption transition-colors hover:bg-primary/[0.06]"
                      style={{ background: "transparent", color: on ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.45)", cursor: "pointer", border: "none", borderRadius: 0 }}
                    >
                      <span
                        className="flex items-center justify-center shrink-0"
                        style={{
                          width: 14,
                          height: 14,
                          border: on ? `1px solid ${KR}` : "1px solid rgba(255,255,255,0.25)",
                          background: on ? KR : "transparent",
                          borderRadius: 0,
                        }}
                      >
                        {on && <Check className="w-2.5 h-2.5 text-white" strokeWidth={3} />}
                      </span>
                      {t(`conti.infoField.${key}`)}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* ── Scene-group (sequence) visualization toggle ── */}
          <button
            onClick={() => setShowGroups((p) => !p)}
            title={t("conti.groupsToggleTip")}
            className="flex items-center gap-1.5 px-3 h-8 text-caption font-medium tracking-wide transition-colors ml-1"
            style={{
              background: showGroups ? KR_BG : "rgba(255,255,255,0.04)",
              color: showGroups ? "#fff" : "rgba(255,255,255,0.6)",
              border: showGroups ? `1px solid ${KR_BORDER2}` : "1px solid rgba(255,255,255,0.10)",
              cursor: "pointer",
              borderRadius: 0,
            }}
            aria-pressed={showGroups}
          >
            <Layers className="w-3.5 h-3.5" />
            {t("conti.groups")}
          </button>
        </div>

        {/* ── Model picker (always visible) ──────────────────────────── */}
        <div className="relative" ref={modelMenuRef} style={{ display: sheetMode ? "none" : undefined }}>
          <button
            onClick={() => setShowModelMenu((p) => !p)}
            className="flex items-center gap-1.5 px-3 h-8 text-caption font-medium tracking-wide transition-colors"
            style={{
              background: "rgba(255,255,255,0.04)",
              color: "rgba(255,255,255,0.6)",
              border: showModelMenu ? `1px solid ${KR}` : "1px solid rgba(255,255,255,0.10)",
              cursor: "pointer",
              borderRadius: 0,
            }}
          >
            <Cpu className="w-3.5 h-3.5" />
            {MODEL_OPTIONS.find((m) => m.id === contiModel)?.name ?? "Dev"}
          </button>
          {showModelMenu && (
            <div
              className="absolute top-full left-0 mt-1 z-50 border border-border bg-card shadow-lg"
              style={{ borderRadius: 0, minWidth: 340 }}
            >
              {MODEL_OPTIONS.map((opt) => {
                const isSelected = contiModel === opt.id;
                return (
                  <button
                    key={opt.id}
                    onClick={() => {
                      setContiModel(opt.id);
                      setShowModelMenu(false);
                    }}
                    className="w-full flex items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-primary/[0.06]"
                    style={{
                      background: isSelected ? KR_BG : "transparent",
                      borderRadius: 0,
                      cursor: "pointer",
                      border: "none",
                    }}
                  >
                    <div className="flex-1">
                      <div
                        className="text-caption font-bold flex items-center gap-1.5"
                        style={{ color: isSelected ? KR : "rgba(255,255,255,0.7)" }}
                      >
                        {opt.name}
                        {opt.id === CONTI_DEFAULT_MODEL && (
                          <span
                            className="text-nano tracking-wider px-1 py-0.5 border"
                            style={{ color: "rgba(255,255,255,0.4)", borderColor: "rgba(255,255,255,0.18)" }}
                          >
                            {t("studio.default")}
                          </span>
                        )}
                      </div>
                      <div className="text-micro whitespace-nowrap" style={{ color: "rgba(255,255,255,0.35)" }}>
                        {opt.desc}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div
          className="flex items-stretch h-8"
          style={{
            background: currentStyle ? KR_BG : "rgba(255,255,255,0.04)",
            border: currentStyle ? `1px solid ${KR_BORDER2}` : "1px solid rgba(255,255,255,0.08)",
            borderRadius: 0,
          }}
        >
          <button
            onClick={() => setShowStyleModal(true)}
            title={currentStyle ? currentStyle.name : undefined}
            className="flex items-center gap-1.5 px-3 text-caption font-medium tracking-wide transition-colors"
            style={{
              background: "transparent",
              color: currentStyle ? KR : "rgba(255,255,255,0.35)",
              border: "none",
              cursor: "pointer",
              borderRadius: 0,
            }}
          >
            {currentStyle?.thumbnail_url ? (
              <span
                className="h-5 w-5 shrink-0 overflow-hidden border border-white/10 bg-black/40"
                style={{ borderRadius: 0 }}
              >
                <img
                  src={currentStyle.thumbnail_url}
                  alt=""
                  className="h-full w-full object-cover"
                  loading="lazy"
                  decoding="async"
                />
              </span>
            ) : (
              <PhotoStar className="w-3.5 h-3.5" />
            )}
            {/* 스타일 적용 시엔 이름을 빼고 썸네일만 — 칩을 심플하게. 미적용 시에만 라벨 노출. */}
            {!currentStyle && t("projectModal.style")}
          </button>
          {currentStyle && (
            <button
              onClick={async (e) => {
                e.stopPropagation();
                // 옵티미스틱: 클라이언트 state 먼저 비움 → 즉시 칩 사라짐.
                setCurrentStyle(null);
                setProjectInfo((prev) => ({ ...prev, conti_style_id: null }));
                // DB 도 같이 비워야 탭 이동 후 재로드 시 다시 적용되지 않는다.
                // (StylePickerModal 의 handleApply(NONE) 와 동일한 영속화)
                try {
                  const { error } = await supabase
                    .from("projects")
                    .update({ conti_style_id: null })
                    .eq("id", projectId);
                  if (error) throw error;
                  toast({ title: t("conti.styleRemoved") });
                } catch (err: any) {
                  toast({ title: t("conti.styleChangeFailed"), description: err.message, variant: "destructive" });
                }
              }}
              title={t("conti.clearStyle")}
              className="flex items-center justify-center px-1.5 transition-colors"
              style={{
                background: "transparent",
                color: KR,
                border: "none",
                borderLeft: `1px solid ${KR_BORDER2}`,
                cursor: "pointer",
                borderRadius: 0,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(249,66,58,0.18)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <X className="w-3 h-3" />
            </button>
          )}
          {currentStyle && transferableSceneCount > 0 && !sheetMode && (
            <button
              onClick={() => setShowStyleTransferModal(true)}
              disabled={styleTransferring || generatingAll}
              className="flex items-center gap-1.5 px-3 text-caption font-medium tracking-wide transition-opacity disabled:opacity-40"
              style={{
                background: "rgba(249,66,58,0.14)",
                color: KR,
                border: "none",
                borderLeft: `1px solid ${KR_BORDER2}`,
                cursor: "pointer",
                borderRadius: 0,
              }}
            >
              {styleTransferring ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <ArrowRightLeft className="w-3.5 h-3.5" />
              )}
              {t("conti.transfer")}
              {/* 스타일 적용에 쓰이는 실제 모델 배지 — 콘티 모델 토글(GPT)과 혼동 방지.
                  생성 호출부와 동일하게 style 설정값을 읽어 표기/실제를 일치시킨다. */}
              <span
                className="text-nano tracking-wide px-1 py-0.5 border"
                style={{ color: "rgba(255,255,255,0.55)", borderColor: "rgba(255,255,255,0.18)" }}
              >
                {IMAGE_GEN_MODEL_LABELS[getImageModelDefault("style")] ?? getImageModelDefault("style")}
              </span>
            </button>
          )}
        </div>

        {/* ── Sheet: one red-outlined group that expands FROM the toggle
               "head". Click the head again to collapse (animated). ── */}
        <div
          className="flex items-stretch h-8 shrink-0"
          style={{
            background: sheetMode ? KR_BG : "rgba(249,66,58,0.06)",
            border: `1px solid ${sheetMode ? "rgba(249,66,58,0.55)" : "rgba(249,66,58,0.30)"}`,
            borderRadius: 0,
          }}
        >
          {/* head toggle (expand / collapse) */}
          <button
            onClick={() => setSheetMode((v) => !v)}
            aria-pressed={sheetMode}
            aria-expanded={sheetMode}
            title={t("conti.sheet.modelFixedHint")}
            className="flex items-center gap-1.5 px-3 text-caption font-medium tracking-wide transition-colors"
            style={{
              background: sheetMode ? KR_BG : "transparent",
              color: KR,
              border: "none",
              cursor: "pointer",
            }}
          >
            {!sheetMode && (storyboardTesting || storyboardApplyingId) ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <LayoutGrid className="w-3.5 h-3.5" />
            )}
            {t("conti.sheet.enter")}
            {!sheetMode && storyboardSheets.length > 0 ? ` (${storyboardSheets.length})` : ""}
            <ChevronRight
              className="w-3 h-3 opacity-60"
              style={{ transform: sheetMode ? "rotate(180deg)" : "none" }}
            />
          </button>

          {sheetMode && (
            <>
              {/* target info (muted, non-clickable) */}
              <span
                className="flex items-center px-3 text-2xs tracking-wide whitespace-nowrap"
                style={{ color: "rgba(255,255,255,0.5)", borderLeft: "1px solid rgba(249,66,58,0.25)" }}
              >
                {selectedSceneIds.size > 0
                  ? t("conti.sheet.targetSelected", { n: selectedSceneIds.size })
                  : t("conti.sheet.targetAll")}
              </span>

              {/* gallery (neutral) */}
              <button
                onClick={() => setStoryboardGalleryOpen(true)}
                className="flex items-center gap-1.5 px-3 text-caption font-medium tracking-wide whitespace-nowrap transition-colors"
                style={{ background: "transparent", color: "rgba(255,255,255,0.6)", border: "none", borderLeft: "1px solid rgba(249,66,58,0.25)", cursor: "pointer" }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.06)")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
              >
                <Images className="w-3.5 h-3.5" />
                {t("conti.sheet.gallery")} ({storyboardSheets.length})
              </button>

              {/* primary action (only red-filled element) */}
              <button
                onClick={runStoryboardSheetTest}
                disabled={storyboardTesting || !!storyboardApplyingId || activeScenes.length === 0}
                className="flex items-center gap-1.5 px-3 text-caption font-semibold tracking-wide text-white whitespace-nowrap transition-opacity disabled:opacity-40"
                style={{ background: KR, border: "none", borderLeft: "1px solid rgba(249,66,58,0.25)", cursor: "pointer" }}
              >
                {storyboardTesting || storyboardApplyingId ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5" />
                )}
                {sheetRefineProgress
                  ? t("conti.sheet.refining", { done: sheetRefineProgress.done, total: sheetRefineProgress.total })
                  : storyboardPlanning
                    ? t("conti.sheet.planning")
                    : storyboardTesting || storyboardApplyingId
                      ? t("conti.sheet.generating")
                      : t("conti.sheet.generate")}
              </button>
            </>
          )}
        </div>

        {!sheetMode && (
          <button
            onClick={() => setShowGenerateAllModal(true)}
            disabled={generatingAll || activeScenes.length === 0}
            className="flex items-center gap-1.5 px-3 h-8 text-caption font-medium tracking-wide text-white transition-opacity disabled:opacity-40"
            style={{ background: KR, border: "none", cursor: "pointer", borderRadius: 0 }}
          >
            {generatingAll ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {t("conti.generateAll")}
          </button>
        )}

        <button
          onClick={() => setShowExportModal(true)}
          disabled={isExporting || activeScenes.length === 0}
          className="flex items-center gap-1.5 px-3 h-8 text-caption font-medium tracking-wide transition-colors disabled:opacity-40"
          style={{
            background: "rgba(255,255,255,0.04)",
            color: "rgba(255,255,255,0.6)",
            border: "1px solid rgba(255,255,255,0.10)",
            cursor: "pointer",
            borderRadius: 0,
          }}
        >
          {isExporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
          {t("conti.export")}
        </button>

        {versions.length === 0 && activeScenes.length > 0 && (
          <button
            onClick={() => setShowNewVersionModal(true)}
            className="flex items-center gap-1.5 px-3 h-8 text-caption font-medium tracking-wide transition-colors"
            style={{
              background: "rgba(255,255,255,0.04)",
              color: "rgba(255,255,255,0.6)",
              border: "1px solid rgba(255,255,255,0.10)",
              cursor: "pointer",
              borderRadius: 0,
            }}
          >
            <Plus className="w-3.5 h-3.5" />
            {t("conti.new")}
          </button>
        )}
      </div>

      {selectedSceneIds.size > 0 && (
        <div
          className="flex items-center gap-2 px-3 py-1.5 shrink-0"
          style={{
            background: KR_BG,
            borderBottom: `0.5px solid ${KR_BORDER2}`,
          }}
        >
          <Check className="w-3.5 h-3.5" style={{ color: KR }} />
          <span className="text-meta font-medium tracking-wide" style={{ color: KR }}>
            {t("conti.selected", { count: selectedSceneIds.size })}
          </span>
          <button
            onClick={() => setSelectedSceneIds(new Set())}
            className="h-7 px-2.5 text-caption font-medium transition-colors"
            style={{
              background: "transparent",
              color: "hsl(var(--muted-foreground))",
              border: "0.5px solid hsl(var(--border))",
              cursor: "pointer",
              borderRadius: 0,
            }}
          >
            {t("conti.clearSelection")}
          </button>
          <div className="flex-1" />
          <button
            onClick={bulkDeleteScenes}
            className="h-7 px-3 inline-flex items-center gap-1.5 text-caption font-medium transition-colors"
            style={{
              background: "rgba(220,38,38,0.08)",
              color: "#dc2626",
              border: "0.5px solid rgba(220,38,38,0.45)",
              cursor: "pointer",
              borderRadius: 0,
            }}
          >
            <Trash2 className="w-3.5 h-3.5" />
            {t("common.delete")} ({selectedSceneIds.size})
          </button>
        </div>
      )}

      {versions.length === 0 && activeScenes.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <button
            onClick={() => setShowNewVersionModal(true)}
            className="flex flex-col items-center gap-3 px-12 py-10 transition-colors"
            style={{
              background: "rgba(255,255,255,0.03)",
              border: "1px dashed rgba(255,255,255,0.12)",
              borderRadius: 0,
              cursor: "pointer",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = KR;
              e.currentTarget.style.background = "rgba(249,66,58,0.04)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.12)";
              e.currentTarget.style.background = "rgba(255,255,255,0.03)";
            }}
          >
            <Plus className="w-8 h-8" style={{ color: "rgba(255,255,255,0.3)" }} />
            <span className="text-body font-medium" style={{ color: "rgba(255,255,255,0.4)" }}>
              {t("conti.newVersion")}
            </span>
            <span className="text-caption" style={{ color: "rgba(255,255,255,0.2)" }}>
              {t("conti.emptyHint")}
            </span>
          </button>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-3">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={activeScenes.map((s) => s.id)} strategy={rectSortingStrategy}>
              <div className={`grid ${gridClass} gap-3 items-stretch`} style={gridStyle}>
                {(() => {
                  let sceneCounter = 0;
                  return activeScenes.map((scene, idx) => {
                    if (!scene.is_transition) sceneCounter++;
                    const displayNum = scene.is_transition ? undefined : sceneCounter;
                    const cardHandlers = getCardHandlers(scene.id);
                    const hasImg = !!scene.conti_image_url;
                    // ── Version-aware loading filter ──
                    // Multiple versions of the same conti can share scene
                    // ids (the "Copy current scenes" path duplicates the
                    // scenes JSON without re-issuing ids). Loading state
                    // sets like editGeneratingIds / sceneStages /
                    // uploadingSceneIds / styleTransferringIds are keyed
                    // by scene.id, so without filtering, a job kicked off
                    // on version A makes the spinner light up on every
                    // sibling version's same-id card too — including ones
                    // the user already copied off and is no longer touching.
                    //
                    // The fix: every code path that adds to those sets now
                    // also writes the source-of-loading version into
                    // generatingSceneVersionMap (see runChangeAngle /
                    // runRelight / runStyleTransferAll / handleUploadConti
                    // / onEditGeneratingChange / inpaint onStageChange).
                    // Here we collapse that into a single boolean per
                    // scene and gate every loading lookup with it.
                    //
                    // sceneVer === undefined → no job ever populated the
                    //   map for this scene, fall through (legacy /
                    //   edge-case safe default = show spinner). The set
                    //   .has() check still applies, so we don't false-
                    //   positive on idle scenes.
                    const sceneVer = generatingSceneVersionMap[scene.id];
                    const versionMatches = sceneVer === undefined ? true : sceneVer === activeVersionId;
                    const group = sceneGroupMap.get(scene.id);
                    // Group of the cuts straddling this insertion point — used by
                    // InsertSceneButton to offer "front scene / back scene" when
                    // the insertion sits on a scene boundary.
                    const beforeGroup = (() => {
                      for (let i = idx - 1; i >= 0; i--) {
                        if (activeScenes[i]?.is_transition) continue;
                        return sceneGroupMap.get(activeScenes[i].id)?.index;
                      }
                      return undefined;
                    })();
                    const afterGroup = (() => {
                      for (let i = idx; i < activeScenes.length; i++) {
                        if (activeScenes[i]?.is_transition) continue;
                        return sceneGroupMap.get(activeScenes[i].id)?.index;
                      }
                      return undefined;
                    })();
                    const isGroupBoundary =
                      showGroups && beforeGroup != null && afterGroup != null && beforeGroup !== afterGroup;
                    return (
                      <div key={scene.id} style={{ position: "relative" }}>
                        <InsertSceneButton
                          onAddScene={(pref) => handleInsertSceneAt(idx, pref)}
                          onAddTransition={() => handleInsertTransitionAt(idx)}
                          canTransition={
                            idx > 0 && !!activeScenes[idx - 1]?.conti_image_url && !!activeScenes[idx]?.conti_image_url
                          }
                          groupChoice={
                            isGroupBoundary
                              ? { beforeLabel: `S${beforeGroup}`, afterLabel: `S${afterGroup}` }
                              : undefined
                          }
                        />
                        <SortableContiCard
                          scene={scene}
                          isGenerating={
                            (generatingSceneIds.has(scene.id) &&
                              (generatingVersionId
                                ? generatingVersionId === activeVersionId
                                : versionMatches)) ||
                            (editGeneratingIds.has(scene.id) && versionMatches)
                          }
                          isGeneratingAll={
                            generatingAll && (!generatingVersionId || generatingVersionId === activeVersionId)
                          }
                          isUploading={uploadingSceneIds.has(scene.id) && versionMatches}
                          isStyleTransferring={styleTransferringIds.has(scene.id) && versionMatches}
                          isStyleTransferFlow={styleTransferring}
                          isQueued={
                            queuedSceneIds.has(scene.id) &&
                            (!generatingVersionId || generatingVersionId === activeVersionId)
                          }
                          aspectClass={ASPECT_CLASS[videoFormat]}
                          assetMap={assetMap}
                          assets={assets}
                          cacheBuster={cacheBusters[scene.scene_number] ?? 0}
                          historyCount={(imageHistory[scene.scene_number] ?? []).length}
                          selected={selectedSceneIds.has(scene.id)}
                          hasMultipleVersions={versions.length > 1}
                          onClickImage={cardHandlers.onClickImage}
                          onGenerate={cardHandlers.onGenerate}
                          onInpaint={cardHandlers.onInpaint}
                          onCompare={cardHandlers.onCompare}
                          onUpload={cardHandlers.onUpload}
                          onHistory={cardHandlers.onHistory}
                          onSceneUpdate={stableHandleSceneUpdate}
                          onDelete={cardHandlers.onDelete}
                          onDuplicate={cardHandlers.onDuplicate}
                          onSelect={cardHandlers.onSelect}
                          onSetThumbnail={hasImg ? cardHandlers.onSetThumbnail : undefined}
                          onAdjustImage={hasImg ? cardHandlers.onAdjustImage : undefined}
                          onUseAsStyle={hasImg ? cardHandlers.onUseAsStyle : undefined}
                          onRelight={hasImg ? cardHandlers.onRelight : undefined}
                          onCameraVariations={hasImg ? cardHandlers.onCameraVariations : undefined}
                          onChangeAngle={hasImg ? cardHandlers.onChangeAngle : undefined}
                          onRefineCut={hasImg ? cardHandlers.onRefineCut : undefined}
                          onSketches={cardHandlers.onSketches}
                          displayNumber={displayNum}
                          onTransitionTypeChange={stableHandleTransitionTypeChange}
                          onInsertRecommendedTransition={
                            // 이 컷(idx)→다음 컷(idx+1) 사이에 추천 트랜지션으로 TR 카드 삽입.
                            // 양쪽 컷에 이미지가 있고, 둘 다 트랜지션 카드가 아닐 때만 활성화.
                            !scene.is_transition &&
                            scene.transition_to_next?.trim() &&
                            !!scene.conti_image_url &&
                            !!activeScenes[idx + 1]?.conti_image_url &&
                            !activeScenes[idx + 1]?.is_transition
                              ? () => handleInsertTransitionAt(idx + 1, scene.transition_to_next)
                              : undefined
                          }
                          info={infoVis}
                          layout={viewMode === "single" ? "row" : "card"}
                          showGroup={showGroups && !!group}
                          groupColor={group ? sceneGroupColor(group.index) : undefined}
                          groupLabel={group ? `S${group.index}` : undefined}
                          groupIndex={group?.index}
                          isGroupStart={group?.isStart}
                          onStartNewScene={cardHandlers.onStartNewScene}
                          onMergeWithPrev={cardHandlers.onMergeWithPrev}
                          generatingStage={versionMatches ? sceneStages[scene.id] : undefined}
                          // ── inpaint 단계 표시용: editGeneratingIds에 있으면 스피너를 "1/1"로 표시
                          // (versionMatches 로 sibling copy-version 의 동일 id 카드에는 안 뜨도록 차단)
                          isEditGenerating={editGeneratingIds.has(scene.id) && versionMatches}
                          allScenes={activeScenes}
                          videoFormat={videoFormat}
                        />
                      </div>
                    );
                  });
                })()}
                <AddSceneCard onClick={handleAddScene} />
              </div>
            </SortableContext>
            {/* dropAnimation={null} — 기본 drop 애니메이션이 clone 을 *원래 자리로*
                되돌리며 250ms 트랜지션을 걸어서, 그 사이 state 업데이트로 카드들이
                새 위치로 이동하면 두 모션이 겹쳐 "덜컥" 느낌이 났음. clone 을 즉시
                해제하고 sortable 의 transition (각 카드의 자연스러운 슬라이드) 만
                남겨두는 게 가장 부드러움. */}
            <DragOverlay dropAnimation={null}>
              {dragActiveId && dragCloneRef.current && (
                <div
                  className="shadow-2xl pointer-events-none"
                  style={{
                    opacity: 0.92,
                    border: `1.5px solid ${KR}`,
                    borderRadius: 0,
                    overflow: "hidden",
                    boxSizing: "border-box",
                  }}
                  ref={(node) => {
                    if (node && dragCloneRef.current && !node.hasChildNodes()) {
                      dragCloneRef.current.style.border = "none";
                      dragCloneRef.current.style.width = "100%";
                      node.appendChild(dragCloneRef.current);
                    }
                  }}
                />
              )}
            </DragOverlay>
          </DndContext>
        </div>
      )}

      {/* ── 모달들 ── */}
      {adjustingScene && (
        <SceneImageCropModal
          scene={adjustingScene}
          onClose={() => setAdjustingScene(null)}
          onSaved={(sceneId, crop) => {
            updateVersionScenes(activeScenes.map((s) => (s.id === sceneId ? { ...s, conti_image_crop: crop } : s)));
            setAdjustingScene(null);
          }}
        />
      )}

      {relightingScene && (
        <RelightModal
          scene={relightingScene}
          projectId={projectId}
          videoFormat={videoFormat}
          onClose={() => setRelightingScene(null)}
          onSubmit={(req) => {
            // Modal already calls onClose; do NOT await here. The runner
            // drives the same `editGeneratingIds` + `sceneStages` channel
            // that inpaint / ChangeAngle use, so the user sees
            // `1/1 Generating…` on the card and can keep working.
            void runRelight(req);
          }}
        />
      )}

      {cameraVariationsScene && (
        <CameraVariationsModal
          // Pass the LIVE scene (looked up from activeScenes) so the gallery
          // reflects grids appended by background generations in real time, not
          // the stale snapshot captured when the modal opened.
          scene={
            activeScenes.find((s) => s.id === cameraVariationsScene.id) ?? cameraVariationsScene
          }
          videoFormat={videoFormat}
          onClose={() => setCameraVariationsScene(null)}
          onGenerateGrid={(prompt) => {
            // BACKGROUND grid generation: kicks off the model call and returns
            // immediately. Tracked in camVarGridState so it survives the modal
            // (or whole Conti tab) closing — the scene card shows a spinner on
            // its Camera Variations icon, and the finished grid is APPENDED to
            // the scene's grid history (gallery) so "generate again" never
            // discards earlier grids.
            //
            // Pipeline is FIXED to match the storyboard sheet: GPT Image 2
            // composes the 9-panel grid (only its quality is configurable in
            // Settings), and the chosen tile is later refined by Nano Banana 2.
            const target = cameraVariationsScene;
            const src = target?.conti_image_url;
            if (!target || !src) return;
            const sid = target.id;
            setCamVarGen(projectId, sid, { startedAt: Date.now() });
            void (async () => {
              try {
                const quality = getGptQualityDefault("cameraVariation");
                const { data, error } = await supabase.functions.invoke("openai-image", {
                  body: {
                    mode: "inpaint",
                    preferredAngleModel: "gpt-image-2",
                    quality,
                    sourceImageUrl: src,
                    referenceImageUrls: [],
                    prompt,
                    projectId,
                    sceneNumber: target.scene_number,
                    imageSize: IMAGE_SIZE_MAP[videoFormat],
                  },
                });
                if (error) throw error;
                const d = data as { publicUrl?: string; url?: string; error?: string } | null;
                if (d?.error) throw new Error(d.error);
                const rawUrl = d?.publicUrl ?? d?.url ?? null;
                if (!rawUrl) throw new Error("Angle grid generation returned no image URL");
                // Append to the persisted grid history (active version snapshot —
                // the source of truth for displayed scenes — + scenes-table mirror).
                const entry = {
                  id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  rawUrl,
                  generatedAt: Date.now(),
                };
                const live = (getSceneState(projectId)?.scenes ?? activeScenes).find((s) => s.id === sid);
                const nextGrids = [...normalizeGridHistory(live?.camera_variation_grid), entry];
                await updateVersionScenes((current) =>
                  current.map((s) => (s.id === sid ? { ...s, camera_variation_grid: nextGrids } : s)),
                );
                void supabase.from("scenes").update({ camera_variation_grid: nextGrids }).eq("id", sid);
              } catch (err: any) {
                console.error("[cameraVar] grid generation failed:", err);
                toast({
                  title: t("cameraVar.generateFailed"),
                  description: err?.message ?? String(err),
                  variant: "destructive",
                });
              } finally {
                setCamVarGen(projectId, sid, null);
              }
            })();
          }}
          onDeleteGrid={(gridId) => {
            // Remove one grid from the scene's history.
            if (!cameraVariationsScene) return;
            const sid = cameraVariationsScene.id;
            const live = (getSceneState(projectId)?.scenes ?? activeScenes).find((s) => s.id === sid);
            const nextGrids = normalizeGridHistory(live?.camera_variation_grid).filter((g) => g.id !== gridId);
            void updateVersionScenes((current) =>
              current.map((s) => (s.id === sid ? { ...s, camera_variation_grid: nextGrids } : s)),
            );
            void supabase.from("scenes").update({ camera_variation_grid: nextGrids }).eq("id", sid);
          }}
          onApplyTile={(tileDataUrl) => {
            // Apply = close the popup and paste the chosen tile INSTANTLY (no
            // model call). The heavy gpt-image-2 refine was split out into the
            // card's on-demand "Refine" action, so applying a cut is now near-
            // immediate. The card still shows the standard generation overlay
            // briefly (editGeneratingIds), which is harmless when it resolves
            // fast. Detail/resolution upscaling is opt-in via Refine afterwards.
            const target = cameraVariationsScene;
            if (!target) return;
            void (async () => {
              setEditGeneratingIds((prev) => new Set(prev).add(target.id));
              setSceneStages((prev) => ({ ...prev, [target.id]: "generating" }));
              setGeneratingSceneVersionMap((prev) => ({ ...prev, [target.id]: activeVersionIdRef.current }));
              try {
                const { centerCropToFormatDataUrl, HEADROOM_VERTICAL_ANCHOR } =
                  await import("@/lib/storyboardSheet");
                const { trimWhiteBorderDataUrl, dataUrlToBase64 } = await import("@/lib/contactSheet");
                // 1) trimWhiteBorderDataUrl: 시트 거터의 큰 흰 여백을 적응적으로 제거.
                // 2) centerCropToFormatDataUrl(anchor=HEADROOM, overscan=1.02):
                //    표시 비율로 상단 바이어스 크롭(인물 머리 보존) + 1% 오버스캔으로
                //    트림이 놓친 얇은 잔여 흰 라인까지 굽는 단계에서 제거.
                // 저해상(타일 ~512px폭) 트레이드오프는 카드 "리파인"으로 보완.
                const trimmed = await trimWhiteBorderDataUrl(tileDataUrl);
                const cropped = await centerCropToFormatDataUrl(
                  trimmed,
                  videoFormat,
                  HEADROOM_VERTICAL_ANCHOR,
                  1.02,
                );
                const { data } = await supabase.functions.invoke("openai-image", {
                  body: {
                    mode: "save_local",
                    imageBase64: dataUrlToBase64(cropped),
                    projectId,
                    sceneNumber: target.scene_number,
                    suffix: "camvar-cut",
                    folder: "contis",
                  },
                });
                const refined = (data as { publicUrl?: string } | null)?.publicUrl;
                if (!refined) throw new Error("apply save returned no image URL");
                await applyGeneratedSceneImage(target.id, refined, target.conti_image_url ?? null);
                toast({
                  title: t("conti.toast.cameraAngleUpdated", { n: String(target.scene_number).padStart(2, "0") }),
                  action: (
                    <ToastAction altText={t("conti.toast.viewScene")} onClick={() => scrollToScene(target.id, target.scene_number)}>
                      {t("conti.toast.viewScene")}
                    </ToastAction>
                  ),
                });
              } catch (err: any) {
                console.error("[cameraVar] apply failed:", err);
                toast({
                  title: t("conti.toast.shotGenerationFailed", { n: String(target.scene_number).padStart(2, "0") }),
                  description: err?.message ?? String(err),
                  variant: "destructive",
                });
              } finally {
                setEditGeneratingIds((prev) => {
                  const n = new Set(prev);
                  n.delete(target.id);
                  return n;
                });
                setSceneStages((prev) => {
                  const n = { ...prev };
                  delete n[target.id];
                  return n;
                });
                setGeneratingSceneVersionMap((prev) => {
                  if (!(target.id in prev)) return prev;
                  const n = { ...prev };
                  delete n[target.id];
                  return n;
                });
              }
            })();
          }}
          onSaveTileAsNeighbor={(tileDataUrl, position, cameraAngle) => {
            // Save the chosen tile as a NEW neighbouring cut (prev/next) instead
            // of replacing the current one. To give immediate feedback (the modal
            // closes right away), we INSERT the new cut FIRST — empty, adjacent to
            // the source, inheriting its scene group + location and the selected
            // angle label — show the standard generating overlay on it, then fill
            // the image in the background (same fast trim+crop path as Apply, no
            // model refine). This mirrors how every other generation surfaces.
            const target = cameraVariationsScene;
            if (!target) return;
            void (async () => {
              const scenes = getSceneState(projectId)?.scenes ?? activeScenes;
              const srcIdx = scenes.findIndex((s) => s.id === target.id);
              if (srcIdx < 0) return;
              // before → insert at the source's slot and join the cut AFTER it
              //          (= the source). after → insert right after and join the
              //          cut BEFORE it (= the source). Either way the new cut
              //          lands in the source's scene group + location.
              const insertIdx = position === "before" ? srcIdx : srcIdx + 1;
              const groupPref: "before" | "after" = position === "before" ? "after" : "before";
              const inserted = await handleInsertSceneAt(insertIdx, groupPref, {
                cameraAngle,
                suppressToast: true,
              });
              if (!inserted) {
                toast({ title: t("conti.toast.addShotFailed"), variant: "destructive" });
                return;
              }
              const newId = inserted.id;
              setEditGeneratingIds((prev) => new Set(prev).add(newId));
              setSceneStages((prev) => ({ ...prev, [newId]: "generating" }));
              setGeneratingSceneVersionMap((prev) => ({ ...prev, [newId]: activeVersionIdRef.current }));
              try {
                const { centerCropToFormatDataUrl, HEADROOM_VERTICAL_ANCHOR } =
                  await import("@/lib/storyboardSheet");
                const { trimWhiteBorderDataUrl, dataUrlToBase64 } = await import("@/lib/contactSheet");
                const trimmed = await trimWhiteBorderDataUrl(tileDataUrl);
                const cropped = await centerCropToFormatDataUrl(
                  trimmed,
                  videoFormat,
                  HEADROOM_VERTICAL_ANCHOR,
                  1.02,
                );
                const { data } = await supabase.functions.invoke("openai-image", {
                  body: {
                    mode: "save_local",
                    imageBase64: dataUrlToBase64(cropped),
                    projectId,
                    sceneNumber: inserted.scene_number,
                    suffix: "camvar-neighbor",
                    folder: "contis",
                  },
                });
                const savedUrl = (data as { publicUrl?: string } | null)?.publicUrl;
                if (!savedUrl) throw new Error("neighbor save returned no image URL");
                await applyGeneratedSceneImage(newId, savedUrl, null);
                toast({
                  title: t(
                    position === "before" ? "conti.toast.prevCutCreated" : "conti.toast.nextCutCreated",
                  ),
                  action: (
                    <ToastAction
                      altText={t("conti.toast.viewScene")}
                      onClick={() => scrollToScene(newId, inserted.scene_number)}
                    >
                      {t("conti.toast.viewScene")}
                    </ToastAction>
                  ),
                });
              } catch (err: any) {
                console.error("[cameraVar] save as neighbor failed:", err);
                toast({
                  title: t("conti.toast.addShotFailed"),
                  description: err?.message ?? String(err),
                  variant: "destructive",
                });
              } finally {
                setEditGeneratingIds((prev) => {
                  const n = new Set(prev);
                  n.delete(newId);
                  return n;
                });
                setSceneStages((prev) => {
                  const n = { ...prev };
                  delete n[newId];
                  return n;
                });
                setGeneratingSceneVersionMap((prev) => {
                  if (!(newId in prev)) return prev;
                  const n = { ...prev };
                  delete n[newId];
                  return n;
                });
              }
            })();
          }}
        />
      )}

      {changeAngleScene && (
        <ChangeAngleModal
          scene={changeAngleScene}
          assets={assets}
          projectId={projectId}
          videoFormat={videoFormat}
          onClose={() => setChangeAngleScene(null)}
          onSubmit={(req) => {
            // Modal already calls onClose; do NOT await here. The runner
            // drives the same `editGeneratingIds` + `sceneStages` channel
            // that inpaint uses, so the user sees `1/1 Generating…` on
            // the card and can keep working in the meantime.
            void runChangeAngle(req);
          }}
        />
      )}

      {studioScene && (
        <Suspense fallback={null}>
        <ContiStudio
          scene={studioScene}
          allScenes={activeScenes}
          assets={assets as any}
          versions={versions}
          activeVersionId={activeVersionId}
          videoFormat={videoFormat}
          imageHistory={imageHistory}
          briefAnalysis={briefAnalysisRef.current}
          styleAnchor={currentStyle?.style_prompt ?? undefined}
          styleImageUrl={currentStyle?.thumbnail_url ?? undefined}
          moodReferenceUrl={getMoodReferenceUrl(studioScene.scene_number)}
          moodImages={moodImageUrls}
          moodBookmarks={moodBookmarks}
          initialTab={studioInitialTab}
          initialCompareSubTab={studioInitialCompareSubTab}
          onClose={() => {
            setStudioScene(null);
            setStudioVersionId(null);
            setStudioInitialTab(undefined);
            setStudioInitialCompareSubTab(undefined);
          }}
          onSaveInpaint={async (url, targetScene = studioScene) => {
            if (!targetScene) return;
            const targetVersionId = studioVersionId ?? activeVersionIdRef.current;
            const current = getSceneState(projectId)?.scenes ?? activeScenes;
            const liveScene = current.find((s) => s.id === targetScene.id);
            clearPendingContiSingleJobsForScene(projectId, targetScene.id);
            clearContiLoadingForScene(projectId, targetScene.id);
            const oldUrl = liveScene?.conti_image_url ?? targetScene.conti_image_url;
            // ContiStudio 의 handleInpaint 가 이미 scenes 테이블에
            // conti_image_url + conti_image_crop:null 을 기록했으므로 여기서는
            // 로컬 state (active version scenes) 만 동기화하면 된다.
            // conti_image_crop 을 null 로 같이 비워야 프리뷰가 옛 좌표계로
            // 잘못 렌더되지 않는다 (style transfer 와 동일한 패턴).
            let nextHistory: string[] | null = null;
            await updateVersionScenes(
              (latest) => latest.map((s) => {
                if (s.id !== targetScene.id) return s;
                const existing = Array.isArray(s.conti_image_history) ? s.conti_image_history : [];
                const versionOldUrl = s.conti_image_url ?? oldUrl;
                const history = versionOldUrl
                  ? [versionOldUrl, ...existing.filter((u) => u !== versionOldUrl)].slice(0, MAX_HISTORY)
                  : existing;
                nextHistory = history;
                return { ...s, conti_image_url: url, conti_image_crop: null, conti_image_history: history };
              }),
              { versionId: targetVersionId },
            );
            if (nextHistory) {
              await supabase.from("scenes").update({ conti_image_history: nextHistory }).eq("id", targetScene.id);
            }
            if (!targetVersionId || targetVersionId === activeVersionIdRef.current) bumpCache(targetScene.scene_number);
          }}
          onRollback={(url, targetScene = studioScene) => targetScene && handleRollback(targetScene as Scene, url)}
          onDeleteHistory={async (url, targetScene = studioScene) => {
            if (!targetScene) return;
            const sceneNumber = targetScene.scene_number;
            let updatedHist: string[] = [];
            await updateVersionScenes(
              (latest) =>
                latest.map((s) => {
                  if (s.id !== targetScene.id) return s;
                  updatedHist = (Array.isArray(s.conti_image_history) ? s.conti_image_history : []).filter((u) => u !== url);
                  return { ...s, conti_image_history: updatedHist };
                }),
              { versionId: studioVersionId },
            );
            if (!studioVersionId || studioVersionId === activeVersionIdRef.current) {
              setImageHistory((prev) => ({ ...prev, [sceneNumber]: updatedHist }));
            }
            await supabase.from("scenes").update({ conti_image_history: updatedHist }).eq("id", targetScene.id);
          }}
          onEditGeneratingChange={(sceneId, generating) => {
            setEditGeneratingIds((prev) => {
              const next = new Set(prev);
              if (generating) next.add(sceneId);
              else next.delete(sceneId);
              return next;
            });
            // Mirror the loading state into the version map so the card
            // render filter can hide the spinner on a copy-version sibling
            // sharing this scene's id. studioVersionId is the version the
            // Studio was opened against, captured at open-time.
            setGeneratingSceneVersionMap((prev) => {
              if (generating) {
                return { ...prev, [sceneId]: studioVersionId ?? activeVersionIdRef.current };
              }
              if (!(sceneId in prev)) return prev;
              const next = { ...prev };
              delete next[sceneId];
              return next;
            });
          }}
          // StudioSketchesTab calls this with a functional updater (not
          // a final array) so that two sibling-model batches finishing
          // in the same tick can each merge their delta against the
          // freshest version-JSON snapshot, instead of both computing
          // `merged` against the same stale React state and clobbering
          // each other (NB visible / GPT missing symptom).
          //
          // We mirror the result into `activeScenes` + the active
          // version's scenes JSON so (a) SortableContiCard's sketch-
          // count badge updates live and (b) reopening Studio doesn't
          // hand back a stale `scene.sketches` prop that would clobber
          // the freshly-saved list.
          onSketchesUpdated={(sceneId, updater) => {
            void updateVersionScenes(
              (current) => current.map((s) =>
                s.id === sceneId
                  ? { ...s, sketches: updater(Array.isArray(s.sketches) ? s.sketches : []) }
                  : s,
              ),
              { versionId: studioVersionId },
            );
          }}
          // ── inpaint stage를 카드 스피너에 전달 ──
          onStageChange={(sceneId, stage) => {
            setSceneStages((prev) => {
              if (stage === null) {
                const next = { ...prev };
                delete next[sceneId];
                return next;
              }
              return { ...prev, [sceneId]: stage };
            });
            // Same version-tag rationale as onEditGeneratingChange — keeps
            // the inpaint stage text from leaking onto a copy-version
            // sibling card that shares this scene's id.
            setGeneratingSceneVersionMap((prev) => {
              if (stage === null) {
                if (!(sceneId in prev)) return prev;
                const next = { ...prev };
                delete next[sceneId];
                return next;
              }
              return { ...prev, [sceneId]: studioVersionId ?? activeVersionIdRef.current };
            });
          }}
          onRegisterInpaintJob={registerInpaintJob}
          onRegisterRegenerateJob={registerRegenerateJob}
          onClearPendingJob={clearRegisteredSingleJob}
          isRegenerating={generatingSceneIds.has(studioScene.id)}
        />
        </Suspense>
      )}

      {compareSceneNumber !== null && (
        <VersionCompareModal
          sceneNumber={compareSceneNumber}
          versions={versions}
          activeVersionId={activeVersionId}
          videoFormat={videoFormat}
          onClose={() => setCompareSceneNumber(null)}
          onImport={handleImportSceneImage}
        />
      )}
      {historySheet && (
        <HistorySheet
          sceneNumber={historySheet.scene_number}
          sceneTitle={historySheet.title}
          history={imageHistory[historySheet.scene_number] ?? []}
          aspectClass={ASPECT_CLASS[videoFormat]}
          onClose={() => setHistorySheet(null)}
          onRollback={(url) => handleRollback(historySheet, url)}
          onDelete={async (url) => {
            const sn = historySheet.scene_number;
            setImageHistory((prev) => {
              const updated = (prev[sn] ?? []).filter((u) => u !== url);
              return { ...prev, [sn]: updated };
            });
            const scene = (getSceneState(projectId)?.scenes ?? activeScenes).find((s) => s.scene_number === sn);
            if (scene) {
              const updatedHist = (imageHistory[sn] ?? []).filter((u) => u !== url);
              // DB 업데이트를 await 한 뒤에 reference-check 를 돌려야
              // 방금 뺀 자신이 false-positive 로 잡혀 파일이 orphan 으로
              // 남는 걸 피할 수 있다.
              await supabase
                .from("scenes")
                .update({ conti_image_history: updatedHist })
                .eq("id", scene.id);
            }
            // 프로젝트 내 모든 위치(다른 씬의 history, sketches, scene_versions
            // snapshot, Mood Ideation 배열) 를 훑어 아직 참조중이면 스킵.
            // 단일 active version 기준의 `conti_image_url` 만 확인하던 기존
            // 체크가 멀티버전/스케치/무드 경로와 겹치는 URL 을 오삭제해
            // HistorySheet 엑박을 만들던 회귀를 차단한다.
            void deleteStoredFileIfUnreferenced(projectId, url);
          }}
        />
      )}
      {showNewVersionModal && (
        <NewVersionModal
          versions={versions}
          activeScenes={activeScenes}
          projectId={projectId}
          onClose={() => setShowNewVersionModal(false)}
          onCreated={async (newId) => {
            await loadVersions();
            if (newId) switchVersion(newId);
          }}
        />
      )}
      {showExportModal && (
        <ExportModal
          versions={versions}
          currentScenes={activeScenes}
          activeVersionId={activeVersionId}
          showInfo={anyInfoVisible}
          videoFormat={videoFormat}
          projectTitle={projectInfo.title || ""}
          onClose={() => setShowExportModal(false)}
          onExportPdf={exportToPDFWithVersions}
          onExportPng={exportToPNGWithVersions}
        />
      )}
      {showGenerateAllModal && (
        <GenerateAllModal
          totalCount={activeScenes.filter((s) => s.description?.trim() && !s.is_transition).length}
          missingCount={
            activeScenes.filter((s) => !s.conti_image_url && s.description?.trim() && !s.is_transition).length
          }
          onClose={() => setShowGenerateAllModal(false)}
          onConfirm={runGenerateAll}
        />
      )}
      {showStyleTransferModal && currentStyle && (
        <StyleTransferConfirmModal
          styleName={currentStyle.name}
          styleThumb={currentStyle.thumbnail_url}
          sceneCount={transferableSceneCount}
          selectedCount={activeScenes.filter((s) => s.conti_image_url && selectedSceneIds.has(s.id)).length}
          onClose={() => setShowStyleTransferModal(false)}
          onConfirm={runStyleTransferAll}
        />
      )}
      {lightboxIndex !== null && storyboardSheets[lightboxIndex] && (() => {
        // Lightbox is index-driven so ←/→ (keyboard or the on-screen arrows)
        // can flip through the gallery without re-opening. Plain fixed overlay
        // (not a Radix Dialog) so a focus-trap quirk can't auto-close it.
        const row = storyboardSheets[lightboxIndex];
        const total = storyboardSheets.length;
        const step = (dir: -1 | 1) => {
          setStoryboardImgError(false);
          setLightboxIndex((idx) => (idx === null ? idx : (idx + dir + total) % total));
        };
        return (
          <div
            className="fixed inset-x-0 bottom-0 top-[81px] z-[200] flex flex-col"
            style={{ background: "hsl(var(--background) / 0.92)", backdropFilter: "blur(2px)" }}
            onClick={() => setLightboxIndex(null)}
          >
            <div
              className="flex items-center justify-between px-4 py-2.5 shrink-0 border-b"
              style={{ background: "hsl(var(--popover))", borderColor: "hsl(var(--border))" }}
            >
              <span className="flex items-center gap-2 text-body font-semibold" style={{ color: "hsl(var(--foreground))" }}>
                {t("conti.sheet.sheetTitle")}
                {total > 1 && (
                  <span className="text-caption font-normal" style={{ color: "hsl(var(--muted-foreground))" }}>
                    {lightboxIndex + 1} / {total}
                  </span>
                )}
              </span>
              <div className="flex items-center gap-3">
                <a
                  href={row.url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-meta underline"
                  style={{ color: "hsl(var(--muted-foreground))" }}
                >
                  {t("conti.sheet.openFull")}
                </a>
                <button
                  onClick={() => setLightboxIndex(null)}
                  className="flex items-center justify-center w-7 h-7 hover:bg-muted"
                  style={{ color: "hsl(var(--muted-foreground))" }}
                  title={t("common.close")}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div
              className="flex-1 overflow-auto flex items-center justify-center p-4 relative"
              onClick={(e) => e.stopPropagation()}
            >
              {total > 1 && (
                <button
                  onClick={() => step(-1)}
                  className="absolute left-3 top-1/2 -translate-y-1/2 flex items-center justify-center w-10 h-10 z-10"
                  style={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
                  title={t("conti.sheet.prev")}
                  aria-label={t("conti.sheet.prev")}
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
              )}
              {storyboardImgError ? (
                <div className="flex flex-col items-center gap-2 p-6 text-center">
                  <p className="text-meta text-destructive">{t("conti.sheet.loadError")}</p>
                  <p className="text-caption break-all max-w-[80vw]" style={{ color: "hsl(var(--muted-foreground))" }}>{row.url}</p>
                </div>
              ) : (
                <img
                  key={row.url}
                  src={row.url}
                  alt="storyboard sheet"
                  className="max-w-full max-h-full object-contain"
                  onError={() => setStoryboardImgError(true)}
                />
              )}
              {total > 1 && (
                <button
                  onClick={() => step(1)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center justify-center w-10 h-10 z-10"
                  style={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
                  title={t("conti.sheet.next")}
                  aria-label={t("conti.sheet.next")}
                >
                  <ChevronRight className="w-5 h-5" />
                </button>
              )}
            </div>
          </div>
        );
      })()}
      {storyboardGalleryOpen && (
        <div
          className="fixed inset-x-0 bottom-0 top-[81px] z-[190] flex flex-col"
          style={{ background: "hsl(var(--background) / 0.92)", backdropFilter: "blur(2px)" }}
          onClick={() => setStoryboardGalleryOpen(false)}
        >
          <div
            className="flex items-center justify-between px-4 py-2.5 shrink-0 border-b"
            style={{ background: "hsl(var(--popover))", borderColor: "hsl(var(--border))" }}
          >
            <span className="flex items-center gap-2 text-body font-semibold" style={{ color: "hsl(var(--foreground))" }}>
              <Images className="w-4 h-4" style={{ color: KR }} />
              {t("conti.sheet.viewerTitle")}
              <span className="text-caption font-normal" style={{ color: "hsl(var(--muted-foreground))" }}>
                {storyboardSheets.length}
              </span>
            </span>
            <button
              onClick={() => setStoryboardGalleryOpen(false)}
              className="flex items-center justify-center w-7 h-7 hover:bg-muted"
              style={{ color: "hsl(var(--muted-foreground))" }}
              title={t("common.close")}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div
            className="flex-1 overflow-auto p-5"
            onClick={(e) => { e.stopPropagation(); setConfirmDeleteSheetId(null); }}
          >
            {storyboardSheets.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 text-center mt-24">
                <ImageIcon className="w-7 h-7" style={{ color: "hsl(var(--muted-foreground))", opacity: 0.6 }} />
                <div className="text-body font-semibold" style={{ color: "hsl(var(--foreground))" }}>
                  {t("conti.sheet.emptyTitle")}
                </div>
                <p className="text-caption leading-relaxed max-w-[280px]" style={{ color: "hsl(var(--muted-foreground))" }}>
                  {t("conti.sheet.empty")}
                </p>
              </div>
            ) : (
              <div className="grid gap-4 max-w-[1100px] mx-auto" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
                {storyboardSheets.map((row, idx) => {
                  const isApplied = appliedSheetId === row.id;
                  const isApplying = storyboardApplyingId === row.id;
                  const rel = computeRelativeTime(row.created_at);
                  const relKey =
                    rel?.key === "justNow" ? "dashboard.justNow"
                      : rel?.key === "minutesAgo" ? "dashboard.minutesAgo"
                        : rel?.key === "hoursAgo" ? "dashboard.hoursAgo"
                          : "dashboard.daysAgo";
                  const confirming = confirmDeleteSheetId === row.id;
                  return (
                    <div
                      key={row.id}
                      className="flex flex-col overflow-hidden"
                      style={{
                        background: "hsl(var(--card))",
                        border: `1px solid ${isApplied ? KR : "hsl(var(--border))"}`,
                        boxShadow: isApplied ? `0 0 0 1px ${KR} inset` : undefined,
                      }}
                    >
                      <button
                        onClick={() => { setStoryboardImgError(false); setLightboxIndex(idx); }}
                        className="relative block w-full overflow-hidden group"
                        style={{ aspectRatio: "4 / 3", background: "hsl(var(--muted))" }}
                        title={t("conti.sheet.zoom")}
                      >
                        <img
                          src={row.url}
                          alt="sheet"
                          className="w-full h-full object-contain"
                          loading="lazy"
                        />
                        {isApplied && (
                          <span
                            className="absolute top-2 left-2 flex items-center gap-1 px-1.5 py-0.5 text-2xs font-semibold text-white"
                            style={{ background: KR }}
                          >
                            <Check className="w-3 h-3" />
                            {t("conti.sheet.applied")}
                          </span>
                        )}
                        {isApplying && sheetRefineProgress && (
                          <span
                            className="absolute inset-0 flex items-center justify-center gap-1.5 text-caption font-medium text-white"
                            style={{ background: "hsl(var(--background) / 0.6)" }}
                          >
                            <Loader2 className="w-4 h-4 animate-spin" />
                            {t("conti.sheet.refining", { done: sheetRefineProgress.done, total: sheetRefineProgress.total })}
                          </span>
                        )}
                      </button>
                      <div className="flex items-center justify-between gap-2 px-2.5 py-2">
                        <div className="min-w-0 flex flex-col" title={row.size_used ?? ""}>
                          <span className="text-caption font-medium truncate" style={{ color: "hsl(var(--foreground))" }}>
                            {t("conti.sheet.cuts", { n: row.cut_count ?? "?" })}
                            <span style={{ color: "hsl(var(--muted-foreground))" }}> · {row.cols}×{row.rows}</span>
                          </span>
                          {rel && (
                            <span className="text-2xs" style={{ color: "hsl(var(--muted-foreground))" }}>
                              {t(relKey, { n: rel.value })}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => applyStoryboardSheetToConti(row)}
                            disabled={!!storyboardApplyingId}
                            className="flex items-center gap-1 px-2.5 h-7 text-caption font-semibold text-white disabled:opacity-50 transition-opacity"
                            style={{ background: KR }}
                            title={t("conti.sheet.reapply")}
                          >
                            {isApplying ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <RefreshCw className="w-3 h-3" />
                            )}
                            {t("conti.sheet.reapply")}
                          </button>
                          {confirming ? (
                            <button
                              onClick={(e) => { e.stopPropagation(); deleteStoryboardSheet(row); }}
                              disabled={isApplying}
                              className="flex items-center px-2 h-7 text-caption font-semibold text-white disabled:opacity-40"
                              style={{ background: "hsl(var(--destructive))" }}
                              title={t("common.delete")}
                            >
                              {t("conti.sheet.confirmDelete")}
                            </button>
                          ) : (
                            <button
                              onClick={(e) => { e.stopPropagation(); setConfirmDeleteSheetId(row.id); }}
                              disabled={isApplying}
                              className="flex items-center justify-center w-7 h-7 hover:bg-muted hover:text-destructive disabled:opacity-40"
                              style={{ color: "hsl(var(--muted-foreground))" }}
                              title={t("common.delete")}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
      {showStyleModal && (
        <StylePickerModal
          currentStyleId={currentStyle?.id ?? null}
          projectId={projectId}
          onClose={() => setShowStyleModal(false)}
          onChanged={(preset) => {
            setCurrentStyle(preset);
            setProjectInfo((prev) => ({ ...prev, conti_style_id: preset?.id ?? null }));
          }}
        />
      )}
      {renameVersion && (
        <RenameVersionModal
          version={renameVersion}
          onClose={() => setRenameVersion(null)}
          onRenamed={() => loadVersions(true)}
        />
      )}
      {deleteVersionTarget && (
        <Dialog open onOpenChange={(o) => !o && setDeleteVersionTarget(null)}>
          <DialogContent size="sm">
            <DialogHeader>
              <DialogTitle>{t("conti.deleteVersion")}</DialogTitle>
            </DialogHeader>
            <p className="text-body text-muted-foreground">
              {t("conti.deleteVersionDesc", { name: deleteVersionTarget.name })}
            </p>
            <DialogFooter className="gap-2">
              <Button variant="ghost" className="text-body h-9" onClick={() => setDeleteVersionTarget(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                className="text-white text-body h-9"
                style={{ background: "#dc2626" }}
                onClick={() => {
                  executeDeleteVersion(deleteVersionTarget.id);
                  setDeleteVersionTarget(null);
                }}
              >
                {t("common.delete")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
};
