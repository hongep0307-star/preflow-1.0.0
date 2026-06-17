import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { supabase } from "@/lib/supabase";
import { callLLM } from "@/lib/llm";
import { getModel } from "@/lib/modelPreference";
import { subscribeModel } from "@/lib/modelPreference";
import { getModelMeta } from "@/lib/modelCatalog";
import { ensureSettingsLoaded, getSettingsCached } from "@/lib/settingsCache";
import { briefAnalysisRegistry } from "@/lib/briefAnalysisRegistry";
import {
  addImageAttachment,
  addPdfAttachment,
  addVideoAttachment,
  addYoutubeAttachment,
  deleteBriefAttachment,
  loadBriefAttachments,
  updateBriefAttachment,
} from "@/lib/briefAttachments";
import { pruneBriefMatchImages } from "@/lib/briefMatchStore";
import ModelPicker from "@/components/common/ModelPicker";
import { LibraryImportDialog } from "@/components/library/LibraryImportDialog";
import {
  type RefItem,
  type RefImageItem,
  type RefYoutubeItem,
  type RefVideoItem,
  type RefAnnotation,
  type SerializableRefItem,
  toSerializableRefItems,
  fromSerializableRefItems,
  recomputeIgnoredByModel,
  summarize as summarizeRefs,
  summarizeLabel as summarizeRefsLabel,
  makeRefId,
  toDataUrl as refToDataUrl,
  hasAnnotation,
  parseTimeRange,
  formatAnnotationLines,
} from "@/lib/refItems";
import { ingestYoutube, isYoutubeUrl, YOUTUBE_URL_REGEX } from "@/lib/youtube";
import { extractFirstFrame, sampleFrames, validateVideoFile } from "@/lib/videoFrames";
import { unlinkReferenceFromProject, urlToVisionBase64 } from "@/lib/referenceLibrary";
import type {
  ContentType,
  ProductInfo,
  HeroVisual,
  HookStrategy,
  KeyVisualCriteria,
  Pacing,
  Constraints,
  AudienceInsight,
  ABCDCompliance,
  NarrativeAnalysis,
} from "@/components/agent/agentTypes";
import { scoreABCD, gradeABCD } from "@/lib/abcdScorer";
import { KNOWLEDGE_BRIEF_ANALYSIS } from "@/lib/directorKnowledgeBase";
import {
  activateWorkspace,
  ensureWorkspacesLoaded,
  getCachedActiveId,
  getCachedLastActiveByKind,
  getCachedWorkspaces,
} from "@/lib/workspaceClient";
import { useToast } from "@/hooks/use-toast";
import { toast as sonnerToast } from "sonner";
import {
  BarChart3,
  CheckCircle,
  Copy,
  ImagePlus,
  Library,
  X,
  Plus,
  FileText,
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  LayoutList,
  GalleryHorizontalEnd,
  ChevronLeft,
  GripVertical,
  Package,
  MessageSquare,
  Target,
  Camera,
  Lightbulb,
  Scissors,
  Link as LinkIcon,
  Film,
  Youtube as YoutubeIcon,
  Loader2,
  Image as ImageIcon,
  EyeOff,
  Pencil,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import { KR } from "@/lib/brand";
import { SidebarResizeHandle } from "@/components/SidebarResizeHandle";
import {
  BRIEF_PANEL_WIDTH_CHANGED_EVENT,
  DEFAULT_BRIEF_PANEL_WIDTH,
  clampBriefPanelWidth,
  readBriefPanelWidth,
  saveBriefPanelWidth,
} from "@/lib/briefPreferences";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { useIsMobile } from "@/hooks/use-mobile";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useT, useUiLanguage } from "@/lib/uiLanguage";
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  rectSortingStrategy,
  useSortable,
  arrayMove,
  type AnimateLayoutChanges,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

/* ━━━━━ localStorage 키 ━━━━━ */
const LS_KEY = (pid: string) => `ff_brief_draft_${pid}`;

/* ━━━━━ localStorage 직렬화용 이미지 타입 (File 제외) ━━━━━ */
interface SerializableImage {
  base64: string;
  mediaType: string;
  /** brief_attachments 행 ID — 영구 저장본 연결. 옛 draft 에는 비어 있고,
   *  업로드 직후 부여된다. */
  attachmentId?: string;
  /** DB 백업 이미지의 storage URL. attachmentId 가 있으면 base64 를 LS 에
   *  중복 저장하지 않고 이 URL 로 프리뷰를 복원한다(quota 절약). */
  previewUrl?: string;
}

interface PersistedDraft {
  briefText: string;
  ideaNote: string;
  briefImages: SerializableImage[];
  /** v2 통합 모델 — image/youtube/video 모두 담음 */
  refItems: SerializableRefItem[];
  /** v1 호환 — 옛날 데이터에서만 존재, 로드 후 refItems 로 자동 마이그레이션 */
  refImages?: SerializableImage[];
  pdfState: "idle" | "extracting" | "ready" | "error";
  pdfExtractedText: string;
  pdfFileName: string;
  pdfFileSize: number;
  pdfPageInfo: { pages: number; chars: number } | null;
  /** PDF 본체의 brief_attachments 행 ID — 새로 업로드된 PDF 만 채워진다. */
  pdfAttachmentId?: string;
}

const getDefaultPersisted = (): PersistedDraft => ({
  briefText: "",
  ideaNote: "",
  briefImages: [],
  refItems: [],
  pdfState: "idle",
  pdfExtractedText: "",
  pdfFileName: "",
  pdfFileSize: 0,
  pdfPageInfo: null,
});

/**
 * v1 → v2 자동 마이그레이션: 옛 `refImages` 만 있는 드래프트를
 * 새 `refItems` 로 변환. 한 번 로드하면 다음 save 부터 v2 형식으로 저장됨.
 */
const migrateLegacyRefImages = (draft: PersistedDraft): PersistedDraft => {
  if (draft.refItems && draft.refItems.length > 0) return draft;
  if (!draft.refImages || draft.refImages.length === 0) return draft;
  const migrated: SerializableRefItem[] = draft.refImages.map((img) => ({
    kind: "image",
    id: makeRefId("image"),
    addedAt: new Date().toISOString(),
    base64: img.base64,
    mediaType: img.mediaType,
  }));
  return { ...draft, refItems: migrated, refImages: [] };
};

const loadFromLS = (pid: string): PersistedDraft => {
  try {
    const raw = localStorage.getItem(LS_KEY(pid));
    if (!raw) return getDefaultPersisted();
    const merged = { ...getDefaultPersisted(), ...JSON.parse(raw) } as PersistedDraft;
    return migrateLegacyRefImages(merged);
  } catch {
    return getDefaultPersisted();
  }
};

/**
 * Draft 저장 실패 (localStorage quota / 비활성화) 시 호출자가 식별 가능하도록 던지는 전용 에러.
 *
 * 옛 구현은 quota 초과 시 `briefImages` 와 `refItems` 를 **조용히 비워서** 저장했다.
 * 사용자가 모르는 사이 브리프 이미지/레퍼런스가 통째로 사라지는 가장 큰 데이터 손실
 * 경로였다. 이 클래스는 그 silent drop 을 명시적 throw 로 바꿔, 각 setter 가
 *   1) in-memory state 를 직전 값으로 롤백
 *   2) 사용자에게 토스트로 안내
 * 하도록 만든다. localStorage 에는 이전 성공 저장본이 그대로 남아 있어 새로고침
 * 후에도 데이터 손실 없음.
 */
export class BriefDraftQuotaError extends Error {
  constructor(message = "Brief draft quota exceeded") {
    super(message);
    this.name = "BriefDraftQuotaError";
  }
}

const isQuotaError = (e: unknown): boolean => {
  if (e instanceof BriefDraftQuotaError) return true;
  if (typeof DOMException !== "undefined" && e instanceof DOMException) {
    // Firefox / Safari / Chrome 모두 동일하게 QuotaExceededError name 을 사용.
    // 일부 구버전 Safari 는 name === "QUOTA_EXCEEDED_ERR" 또는 code === 22.
    if (e.name === "QuotaExceededError" || e.name === "QUOTA_EXCEEDED_ERR" || e.code === 22) {
      return true;
    }
  }
  return false;
};

/** 직렬화된 draft(JSON 문자열)에서 DB 백업(attachmentId 보유) 항목의 base64 를
 *  소급 제거해 슬림화한다. base64 는 brief_attachments(DB)에 영구 저장돼 있어
 *  localStorage 사본은 중복 — 제거해도 데이터 손실이 없고, 마운트 recovery 가
 *  file_url 로 프리뷰를 되살린다. 반환: 변경 여부. */
const slimPersistedDraftJson = (raw: string): { json: string; changed: boolean } => {
  let draft: PersistedDraft;
  try {
    draft = JSON.parse(raw) as PersistedDraft;
  } catch {
    return { json: raw, changed: false };
  }
  let changed = false;
  const slimImg = (img: SerializableImage): SerializableImage => {
    if (img.attachmentId && img.base64) {
      changed = true;
      return { ...img, base64: "" };
    }
    return img;
  };
  if (Array.isArray(draft.briefImages)) {
    draft.briefImages = draft.briefImages.map(slimImg);
  }
  if (Array.isArray(draft.refItems)) {
    draft.refItems = draft.refItems.map((it) => {
      if (!it.attachmentId) return it;
      if (it.kind === "image" && it.base64) {
        changed = true;
        return { ...it, base64: "" };
      }
      if (it.kind === "video" && it.posterBase64) {
        changed = true;
        return { ...it, posterBase64: "" };
      }
      return it;
    });
  }
  return changed ? { json: JSON.stringify(draft), changed: true } : { json: raw, changed: false };
};

/** quota 회복 / 능동 회수 — 데이터 손실 없이 회수 가능한 공간만 비운다.
 *  1) 모든 ff_brief_draft_* 에서 DB 백업 항목의 중복 base64 소급 제거(슬림화).
 *  2) 브리프 매치 폴더 보관 이미지 비우기(aggressive 면 전부, 아니면 최근 2개 유지).
 *  반환: 무언가 회수했으면 true.
 *
 *  NOTE: ff_brief_autoanalyze_* 플래그는 절대 건드리지 않는다 — 한 글자라 공간
 *  절약 효과가 없고, "스마트 브리프 매치 → 프로젝트 내보내기" 직후 BriefTab 이
 *  이 플래그를 읽어 자동 분석을 1회 실행하는데, 능동 회수가 먼저 지워 버리면
 *  자동 분석이 실행되지 않는다(회귀 방지). */
const evictStaleBriefStorage = (aggressive = false): boolean => {
  let freed = false;
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }
    for (const k of keys) {
      if (k.startsWith("ff_brief_draft_")) {
        const raw = localStorage.getItem(k);
        if (!raw) continue;
        const { json, changed } = slimPersistedDraftJson(raw);
        if (changed) {
          try {
            localStorage.setItem(k, json);
            freed = true;
          } catch {
            /* 다른 키 정리로 공간이 생기면 다음 패스에서 재시도 */
          }
        }
      }
    }
  } catch {
    /* ignore */
  }
  try {
    if (pruneBriefMatchImages(aggressive ? 0 : 2) > 0) freed = true;
  } catch {
    /* ignore */
  }
  return freed;
};

/* 앱 세션당 1회만 능동 회수 실행하도록 가드(중복 패스 방지). */
let _briefStorageReclaimed = false;

const saveToLS = (pid: string, draft: PersistedDraft): void => {
  try {
    localStorage.setItem(LS_KEY(pid), JSON.stringify(draft));
  } catch (e) {
    if (isQuotaError(e)) {
      // 1차 quota — DB 백업 항목의 중복 base64 소급 제거 + 소비된 플래그 정리
      // 후 재시도. 데이터 손실 없이 회복된다.
      if (evictStaleBriefStorage(false)) {
        try {
          localStorage.setItem(LS_KEY(pid), JSON.stringify(draft));
          return;
        } catch (e2) {
          if (!isQuotaError(e2)) throw e2;
        }
      }
      // 2차 quota — 더 공격적으로 브리프 매치 보관 이미지를 전부 비우고 재시도.
      if (evictStaleBriefStorage(true)) {
        try {
          localStorage.setItem(LS_KEY(pid), JSON.stringify(draft));
          return;
        } catch (e3) {
          if (!isQuotaError(e3)) throw e3;
        }
      }
      // 옛 구현은 여기서 briefImages/refItems 를 비워 재시도했다 — 데이터 손실의
      // 핵심 경로. 이제는 throw 하여 setter 가 in-memory 도 롤백하고 사용자에게
      // 알리도록 한다. 직전 성공 저장본이 LS 에 그대로 남아 새로고침 시에도 안전.
      throw new BriefDraftQuotaError();
    }
    throw e;
  }
};

/* ━━━━━ 모듈 레벨 Map — 탭 전환 시 성능용 캐시 ━━━━━ */
interface DraftState {
  briefText: string;
  ideaNote: string;
  briefImages: ImageItem[];
  refItems: RefItem[];
  pdfState: "idle" | "extracting" | "ready" | "error";
  pdfExtractedText: string;
  pdfFileName: string;
  pdfFileSize: number;
  pdfPageInfo: { pages: number; chars: number } | null;
  /** PDF 본체의 brief_attachments 행 ID. */
  pdfAttachmentId?: string;
}
const _draftByProject = new Map<string, DraftState>();

const getDefaultDraft = (): DraftState => ({
  briefText: "",
  ideaNote: "",
  briefImages: [],
  refItems: [],
  pdfState: "idle",
  pdfExtractedText: "",
  pdfFileName: "",
  pdfFileSize: 0,
  pdfPageInfo: null,
});

/* ━━━━━ 모듈-레벨 cross-tab append API ━━━━━
 * Library 에서 우클릭 → "Brief 에 추가" 가 BriefTab 미마운트 상태에서도
 * 안전하게 draft 에 RefItem 을 박을 수 있도록. _draftByProject 를 직접
 * mutate + localStorage 영구화 + 이벤트 디스패치 → 마운트된 BriefTab 이
 * 들으면 state 재로드.
 *
 * 호출자 (attachLibraryItemToProject 사용처) 는 이미 base64 변환을 끝낸
 * RefItem (referenceToRefItem 결과) 을 넘겨야 한다. orchestrator/도우미 가
 * BriefTab 의 내부 변환 로직을 알 필요 없도록 직렬화 형태로 받는다. */
export const BRIEF_DRAFT_CHANGED_EVENT = "brief-draft-changed";

export interface BriefDraftChangedDetail {
  projectId: string;
}

/** appendLibraryRefItemToProject 의 반환 형태.
 *  - "added": 새로 추가됨.
 *  - "duplicate": 같은 id 가 이미 brief draft 에 있어 skip.
 *  - "no-project": projectId 가 비어 있어 no-op.
 *  caller (LibraryPage) 가 토스트 분기에 사용. */
export type AppendLibraryRefResult = "added" | "duplicate" | "no-project";

/** 한 자료를 Brief 의 refItems 리스트에 append. id 가 같으면 dedupe.
 *  localStorage 영구 저장까지 동기적으로 완료된 후 이벤트 발화. 마운트된
 *  BriefTab 이 이벤트를 듣고 setRefItems 로 visual 갱신.
 *
 *  반환값으로 결과 분기를 caller 에 노출 — 이전엔 silent dedupe 였는데, 사용자
 *  입장에선 "내가 이미 넣은 자료" 와 "처음 넣은 자료" 가 피드백 없이 같아져
 *  혼란이 컸다. caller 가 결과를 받아 토스트로 안내한다.
 *
 *  ⚠️ 이 함수는 reference.tags 나 다른 reference 필드를 *건드리지 않는다*.
 *  brief draft (project-scoped localStorage) 만 변경. */
export function appendLibraryRefItemToProject(projectId: string, refItem: RefItem): AppendLibraryRefResult {
  if (!projectId) return "no-project";
  const cur = _draftByProject.get(projectId);
  // 마운트 안 된 상태 = cur 가 없을 수 있음. localStorage 에서 한 번 로드.
  let base: DraftState;
  if (cur) {
    base = cur;
  } else {
    const persisted = loadFromLS(projectId);
    base = {
      briefText: persisted.briefText,
      ideaNote: persisted.ideaNote,
      briefImages: fromSerializable(persisted.briefImages),
      refItems: fromSerializableRefItems(persisted.refItems),
      pdfState: persisted.pdfState,
      pdfExtractedText: persisted.pdfExtractedText,
      pdfFileName: persisted.pdfFileName,
      pdfFileSize: persisted.pdfFileSize,
      pdfPageInfo: persisted.pdfPageInfo,
      pdfAttachmentId: persisted.pdfAttachmentId,
    };
  }
  // dedupe — 같은 id (library_<refId>) 가 이미 있으면 caller 에게 알린다.
  if (base.refItems.some((r) => r.id === refItem.id)) return "duplicate";
  const next: DraftState = { ...base, refItems: [...base.refItems, refItem] };
  _draftByProject.set(projectId, next);
  // localStorage 영구화
  const persisted: PersistedDraft = {
    briefText: next.briefText,
    ideaNote: next.ideaNote,
    briefImages: toSerializable(next.briefImages),
    refItems: toSerializableRefItems(next.refItems),
    pdfState: next.pdfState,
    pdfExtractedText: next.pdfExtractedText,
    pdfFileName: next.pdfFileName,
    pdfFileSize: next.pdfFileSize,
    pdfPageInfo: next.pdfPageInfo,
    pdfAttachmentId: next.pdfAttachmentId,
  };
  try {
    saveToLS(projectId, persisted);
  } catch (err) {
    // Quota 초과 — in-memory 캐시도 직전 상태로 롤백해 일관성 유지.
    // 호출자(LibraryPage `sendItemsToBrief` / `performAttachToProject`) 는 이미
    // try/catch 로 감싸고 있어 사용자에게 토스트로 안내된다.
    _draftByProject.set(projectId, base);
    throw err;
  }
  // 마운트된 BriefTab 에게 즉시 재로드 신호
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<BriefDraftChangedDetail>(BRIEF_DRAFT_CHANGED_EVENT, {
        detail: { projectId },
      }),
    );
  }
  return "added";
}

/** 브리프 본문(텍스트/아이디어 메모/캡쳐 이미지)을 프로젝트 draft 에 시드한다.
 *  "스마트 브리프 매치 → 프로젝트 내보내기" 가 BriefTab 마운트 전에 호출 →
 *  마운트 시 초기 state 로 하이드레이션되어 즉시 표시 + 자동 분석 입력이 된다.
 *  appendLibraryRefItemToProject 와 동일하게 _draftByProject + localStorage 갱신.
 *  이미지는 attachmentId 없이 넣어 BriefTab 의 마이그레이션이 DB 로 영구화한다. */
export function seedBriefContentToProjectDraft(
  projectId: string,
  content: { briefText?: string; ideaNote?: string; images?: { base64: string; mediaType: string }[] },
): void {
  if (!projectId) return;
  const cur = _draftByProject.get(projectId);
  let base: DraftState;
  if (cur) {
    base = cur;
  } else {
    const persisted = loadFromLS(projectId);
    base = {
      briefText: persisted.briefText,
      ideaNote: persisted.ideaNote,
      briefImages: fromSerializable(persisted.briefImages),
      refItems: fromSerializableRefItems(persisted.refItems),
      pdfState: persisted.pdfState,
      pdfExtractedText: persisted.pdfExtractedText,
      pdfFileName: persisted.pdfFileName,
      pdfFileSize: persisted.pdfFileSize,
      pdfPageInfo: persisted.pdfPageInfo,
      pdfAttachmentId: persisted.pdfAttachmentId,
    };
  }
  const newImages: ImageItem[] = (content.images ?? []).map((img) => ({
    base64: img.base64,
    mediaType: img.mediaType,
    preview: toDataUrl(img.base64, img.mediaType),
  }));
  const next: DraftState = {
    ...base,
    briefText: content.briefText?.trim() ? content.briefText.trim() : base.briefText,
    ideaNote: content.ideaNote?.trim() ? content.ideaNote.trim() : base.ideaNote,
    briefImages: [...base.briefImages, ...newImages],
  };
  _draftByProject.set(projectId, next);
  const persisted: PersistedDraft = {
    briefText: next.briefText,
    ideaNote: next.ideaNote,
    briefImages: toSerializable(next.briefImages),
    refItems: toSerializableRefItems(next.refItems),
    pdfState: next.pdfState,
    pdfExtractedText: next.pdfExtractedText,
    pdfFileName: next.pdfFileName,
    pdfFileSize: next.pdfFileSize,
    pdfPageInfo: next.pdfPageInfo,
    pdfAttachmentId: next.pdfAttachmentId,
  };
  try {
    saveToLS(projectId, persisted);
  } catch {
    // Quota — in-memory(_draftByProject)에는 남아 이번 세션 표시/분석은 가능.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<BriefDraftChangedDetail>(BRIEF_DRAFT_CHANGED_EVENT, { detail: { projectId } }),
    );
  }
}

/* ━━━━━ 이미지 타입 (런타임용) ━━━━━ */
interface ImageItem {
  file?: File;
  base64: string;
  mediaType: string;
  preview: string;
  /** brief_attachments 행 ID — 영구 저장본 연결. */
  attachmentId?: string;
}

/* ━━━━━ base64 → data URL 프리뷰 ━━━━━ */
const toDataUrl = (base64: string, mediaType: string) => `data:${mediaType};base64,${base64}`;

/* storage URL(http/https) 인지 — data: URL 과 구분해 슬림 직렬화 여부 판단. */
const isHttpUrl = (url: string | undefined): url is string => !!url && /^https?:\/\//i.test(url);

/* ━━━━━ localStorage → ImageItem 변환 ━━━━━ */
const fromSerializable = (imgs: SerializableImage[]): ImageItem[] =>
  imgs.map((img) => ({
    base64: img.base64,
    mediaType: img.mediaType,
    // 슬림 항목(base64 빔)은 previewUrl(storage URL)로 프리뷰 복원.
    preview: img.previewUrl || (img.base64 ? toDataUrl(img.base64, img.mediaType) : ""),
    attachmentId: img.attachmentId,
  }));

/* ━━━━━ ImageItem → SerializableImage 변환 ━━━━━
 *  DB 백업 항목(attachmentId + storage URL preview)은 base64 를 비워 quota 누적
 *  을 막고 previewUrl 로 복원한다. http preview 가 아직 없으면 base64 유지. */
const toSerializable = (imgs: ImageItem[]): SerializableImage[] =>
  imgs.map(({ base64, mediaType, attachmentId, preview }) => {
    const slim = !!attachmentId && isHttpUrl(preview);
    return {
      base64: slim ? "" : base64,
      mediaType,
      attachmentId,
      previewUrl: slim ? preview : undefined,
    };
  });

/* ━━━━━ Types ━━━━━ */
interface VisualDirectionStructured {
  camera: string;
  lighting: string;
  color_grade: string;
  editing: string;
}
interface SceneFlowBeat {
  label: string;
  duration: string;
  description: string;
}

interface SceneFlowStructured {
  structure: string;
  total_scenes: string;
  total_sequences?: string;
  total_shots?: string;
  hook: { duration: string; description: string };
  /**
   * BODY 단계는 영상 길이에 따라 N개의 beat 로 세분화한다.
   * `pacing.sequence_count.recommended` 가 결정하는 시퀀스 수에서 HOOK/CTA 를
   * 제외한 갯수만큼 들어간다. 짧은 영상(6-15s) 은 1개, 30s 는 보통 2-3개,
   * 60s 는 5-6개까지. 각 beat 은 광고 내러티브의 한 단락(예: 문제 제기,
   * 솔루션 등장, 기능 데모, 신뢰 빌드)을 의미.
   *
   * 구버전 분석 결과(legacy `body: {duration, description}`) 는 마이그레이션
   * 헬퍼 `migrateBodyToBeats` 가 1-beat 배열로 변환해 호환을 유지한다.
   */
  body_beats?: SceneFlowBeat[];
  /** @deprecated 구버전 호환 — 새 분석은 body_beats 를 채운다. */
  body?: { duration: string; description: string };
  cta: { duration: string; description: string };
}

/**
 * 구버전 SceneFlowStructured 데이터를 새 body_beats 스키마로 정규화.
 * `body_beats` 가 이미 있으면 그대로, 없고 `body` 만 있으면 단일 beat 로 감싼다.
 * 둘 다 없는 극단 케이스(누락된 분석 결과) 는 빈 배열로 폴백한다.
 */
const getBodyBeats = (flow: SceneFlowStructured): SceneFlowBeat[] => {
  if (Array.isArray(flow.body_beats) && flow.body_beats.length > 0) {
    return flow.body_beats.map((b) => ({
      label: b.label || "Body",
      duration: b.duration || "",
      description: b.description || "",
    }));
  }
  if (flow.body && (flow.body.duration || flow.body.description)) {
    return [{ label: "Body", duration: flow.body.duration ?? "", description: flow.body.description ?? "" }];
  }
  return [];
};

/**
 * Body 비트 그리드의 컬럼 수를 row 가 균형 잡히도록 계산.
 *
 * `auto-fit + minmax` 만 쓰면 컨테이너 폭에 따라 마지막 행에 1 카드만 남는
 * (예: 8개 → 7+1) 어색한 분배가 생긴다. 이 함수는 cols 후보 중에서:
 * - 마지막 행이 가장 꽉 차고 (waste 가 최소)
 * - 그 조건에서는 cols 가 가장 큰 (= 카드가 너무 넓어지지 않는) 것
 * 을 선택한다.
 *
 * 예) n=8, max=5  → 4 (4+4)
 *     n=7, max=5  → 4 (4+3)
 *     n=6, max=5  → 3 (3+3)
 *     n=5, max=5  → 5 (단일 행)
 *     n=11, max=5 → 4 (4+4+3)
 */
const getBalancedCols = (n: number, maxCols: number): number => {
  if (n <= 0) return 1;
  if (n <= maxCols) return n;
  let bestC = maxCols;
  let bestWaste = Infinity;
  for (let c = 2; c <= maxCols; c++) {
    const lastRow = ((n - 1) % c) + 1;
    const waste = c - lastRow;
    if (waste < bestWaste || (waste === bestWaste && c > bestC)) {
      bestC = c;
      bestWaste = waste;
    }
  }
  return bestC;
};

/* ━━━━━ Duration helpers (timeline weighting & auto-recompute) ━━━━━
 *
 * 씬 흐름의 각 segment(HOOK/Body beats/CTA) 의 `duration` 필드는
 * "0-8s", "13-19s", "13-19초", "8s" 같은 자유 문자열이라 시각적으로 비례 표시
 * 하거나 reorder 후 자동 재계산하려면 일관된 파서가 필요하다.
 *
 * `weight = end - start` 를 timeline flex 가중치 / Gantt 바 segment 폭으로 사용.
 * Reorder/Delete/Add 시점에는 `recomputeBeatDurations` 가 모든 body beat 의
 * 시간 범위를 sequential 하게 다시 깐다 (HOOK/CTA 의 시간은 보존).
 */
type DurationUnit = "s" | "초";
type ParsedDuration = { start: number; end: number; weight: number; unit: DurationUnit };

const parseDurationRange = (s: string | undefined | null): ParsedDuration => {
  if (!s) return { start: 0, end: 0, weight: 0, unit: "s" };
  const unit: DurationUnit = /초/.test(s) ? "초" : "s";
  const cleaned = s.replace(/[s초\s]/g, "");
  const m = cleaned.match(/^(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?$/);
  if (!m) return { start: 0, end: 0, weight: 0, unit };
  const start = parseFloat(m[1]);
  const end = m[2] !== undefined ? parseFloat(m[2]) : start;
  return { start, end, weight: Math.max(0, end - start), unit };
};

const formatDurationRange = (start: number, end: number, unit: DurationUnit = "s"): string => {
  const fmt = (n: number) => (Number.isInteger(n) ? String(Math.round(n)) : n.toFixed(1));
  return `${fmt(start)}-${fmt(end)}${unit}`;
};

/**
 * 사용자 입력 (예: "5", "5s", "5초", "5 초") 에서 길이(초) 추출.
 * 음수/0/파싱 불가는 null 반환.
 */
const parseLengthInput = (input: string): number | null => {
  if (!input) return null;
  const cleaned = input.replace(/[s초\s]/gi, "");
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
};

/**
 * 각 세그먼트의 길이만 보면서 0 부터 순차적으로 시간 range 를 재구축.
 *
 * 사용자가 어느 한 카드의 duration 을 편집해도 다른 카드의 "길이" 는
 * 그대로 유지되고 (storage 기준 range 만 시퀀스에 맞게 재계산), 그 결과
 * 총 듀레이션은 자동 증감한다. Reorder/Delete/Add 에도 같은 로직 적용.
 *
 * 인자 `overrides` 로 특정 세그먼트의 길이를 강제 지정 가능.
 *
 * 결과로 `{ hook, beats, cta }` 모두 새 range 문자열을 돌려주며 호출 측은
 * 필요한 경로만 골라 onUpdate 한다 (보통 셋 다 갱신).
 */
const rebuildSequentialRanges = (
  flow: SceneFlowStructured,
  beats: SceneFlowBeat[],
  overrides?: { hookLen?: number; beatLengths?: number[]; ctaLen?: number },
): { hook: string; beats: SceneFlowBeat[]; cta: string; total: number; unit: DurationUnit } => {
  const hookParsed = parseDurationRange(flow.hook?.duration);
  const ctaParsed = parseDurationRange(flow.cta?.duration);
  const unit: DurationUnit =
    hookParsed.unit === "초" || ctaParsed.unit === "초" ? "초" : "s";

  const FALLBACK = 5;
  const safeLen = (n: number) => (n > 0 ? n : FALLBACK);

  const hookLen = safeLen(overrides?.hookLen ?? hookParsed.weight);
  const ctaLen = safeLen(overrides?.ctaLen ?? ctaParsed.weight);
  const beatLengths =
    overrides?.beatLengths ??
    beats.map((b) => parseDurationRange(b.duration).weight);
  const safeBeatLengths = beatLengths.map(safeLen);

  let cursor = 0;
  const hook = formatDurationRange(cursor, cursor + hookLen, unit);
  cursor += hookLen;

  const newBeats = beats.map((b, i) => {
    const start = cursor;
    const end = cursor + safeBeatLengths[i];
    cursor = end;
    return { ...b, duration: formatDurationRange(start, end, unit) };
  });

  const cta = formatDurationRange(cursor, cursor + ctaLen, unit);
  const total = cursor + ctaLen;

  return { hook, beats: newBeats, cta, total, unit };
};
interface UspItem {
  keyword: string;
  comparison: string;
}
export interface DeepAnalysis {
  goal: {
    summary: string;
    items: string[];
    kpi_hint: string;
    core_message?: string;
    success_criteria?: string;
    desired_action?: string;
  };
  target: { summary: string; primary: string[]; insight: string; media_behavior: string };
  usp: { summary: string; items: string[] | UspItem[]; competitive_edge: string; message_hierarchy: string };
  tone_manner: {
    summary: string;
    keywords: string[];
    visual_direction: string | VisualDirectionStructured;
    reference_mood: string;
    do_not: string;
  };
  production_notes: {
    format_recommendation: string;
    shooting_style: string;
    scene_count_hint: string | SceneFlowStructured;
    budget_efficiency: string;
  };
  idea_note?: string;
  image_analysis?: string;
  creative_gap?: { synergy: string[]; gap: string[]; recommendation: string };

  // ── reference video insights (GPT-5.x only) ──
  reference_video_insights?: Array<{
    source: "youtube" | "upload";
    title?: string;
    hook_pattern?: string;
    pacing_per_scene?: Array<{ t: string; beat: string }>;
    visual_motifs?: string[];
    audio_cues?: string[];
    transferable_techniques?: string[];
    do_not_copy?: string[];
  }>;

  // ── v2 fields (all optional; populated when classifier runs) ──
  content_type?: ContentType;
  classification_confidence?: number;
  classification_reasoning?: string;
  secondary_type?: ContentType;

  product_info?: ProductInfo;
  hero_visual?: HeroVisual;
  key_visual_criteria?: KeyVisualCriteria;
  hook_strategy?: HookStrategy;
  pacing?: Pacing;
  constraints?: Constraints;
  audience_insight?: AudienceInsight;
  abcd_compliance?: ABCDCompliance;
  narrative?: NarrativeAnalysis;
}
interface LegacyAnalysis {
  goal: string[];
  target: string[];
  usp: string[];
  tone_manner: string[];
}
type Analysis = DeepAnalysis | LegacyAnalysis;
function isDeepAnalysis(a: Analysis): a is DeepAnalysis {
  return a.goal && typeof a.goal === "object" && !Array.isArray(a.goal);
}
interface Brief {
  id: string;
  raw_text: string | null;
  analysis: Analysis | null;
  created_at: string;
  source_type: string | null;
  image_urls: string[] | null;
}
interface Props {
  projectId: string;
  onSwitchToAgent: (lang: "ko" | "en") => void;
  onSwitchToAssets?: () => void;
}

/* ━━━━━ Helpers ━━━━━ */
const fileToBase64 = (file: File): Promise<string> =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res((r.result as string).split(",")[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });

/** base64 문자열 → Blob. brief_attachments 마이그레이션이 LS-only 항목을 디스크로
 *  옮길 때 사용. atob 가 raw binary string 을 만들면 8-bit 단위로 잘라 Uint8Array
 *  를 채워 Blob 으로 감싼다. mediaType 은 그대로 type 으로 전달. */
function base64ToBlob(base64: string, mediaType: string): Blob {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mediaType || "application/octet-stream" });
}

const DEEP_ANALYSIS_SYSTEM_PROMPT = `당신은 게임/프로모션 영상 제작을 돕는 시니어 CD 이자 Performance Creative 전문가입니다.
1인 프로듀서가 이 분석만으로 씬을 바로 짤 수 있도록, 마케팅 수사보다 "무엇을/언제/어떻게 노출할지"에 집중하세요.
기반 프레임워크: Meta Creative Best Practices · Google ABCD · Mobile UA Patterns.

${KNOWLEDGE_BRIEF_ANALYSIS}

═══ STAGE 1 — CONTENT TYPE CLASSIFICATION ═══
먼저 브리프를 읽고 5개 타입 중 하나로 분류하세요:

1. product_launch — 특정 인게임 상품/스킨/무기/번들/패스 출시·판매
2. event — 기간 한정 이벤트·시즌·토너먼트·콜라보·보상
3. update — 패치/신규 맵/밸런스/기능 업데이트 안내
4. community — 크리에이터·UGC·스트리머·플레이어 토너먼트 중심
5. brand_film — 세계관/철학/감성 서사 중심, 직접 판매 CTA 없음

분류 기준:
- 브리프에 "출시/런칭/구매/스킨/한정/번들" → product_launch
- "이벤트/시즌/한정 기간/보상/콜라보" → event
- "업데이트/패치/신규 맵/밸런스" → update
- "크리에이터/UGC/스트리머/토너먼트" → community
- "브랜드 필름/세계관/철학/감동/스토리" 명시 + 길이 45초 이상 → brand_film

content_type 결정 후, classification_confidence (0.0–1.0), classification_reasoning (1문장) 을 함께 기록하세요.
confidence < 0.6 이면 secondary_type 도 추가 제시.

═══ STAGE 2 — TEMPLATE SELECTION ═══
- content_type ∈ { product_launch, event, update, community } → Performance Creative 템플릿 (기본)
- content_type === "brand_film" → Narrative Creative 추가 블록(narrative) 포함

═══ OUTPUT JSON SCHEMA (반드시 이 형식만) ═══

공통 + Performance 필드 (항상 포함):
{
  "content_type": "product_launch | event | update | community | brand_film",
  "classification_confidence": 0.85,
  "classification_reasoning": "브리프에 'WSUS 411 한정 스킨' 3회 언급, 판매 목적 명확",
  "secondary_type": "event",

  "goal": { "summary": "…", "items": ["…","…","…"], "kpi_hint": "…", "core_message": "15단어 이내 태그라인", "success_criteria": "수치 2-3개", "desired_action": "단계1 → 단계2 → 단계3" },
  "target": { "summary": "…", "primary": ["…","…","…"], "insight": "페인포인트", "media_behavior": "미디어 행동" },
  "audience_insight": { "pain_point": "이전 WSUS 시리즈를 놓친 경험", "motivation": "한정 희소성 + FOMO" },
  "usp": { "summary": "…", "items": [{"keyword":"2-4단어","comparison":"…"}], "competitive_edge": "…", "message_hierarchy": "1순위 → 2순위 → 3순위" },
  "tone_manner": { "summary": "…", "keywords": ["…","…","…","…"], "visual_direction": {"camera":"…","lighting":"…","color_grade":"…","editing":"…"}, "reference_mood": "…", "do_not": "…" },
  "production_notes": { "format_recommendation": "…", "shooting_style": "…", "scene_count_hint": {"structure":"HOOK → … → CTA","total_scenes":"3-4개 씬 / 6-10개 컷","total_sequences":"3-4개 씬/시퀀스","total_shots":"6-10개 컷","hook":{"duration":"…","description":"…"},"body_beats":[{"label":"Setup","duration":"3-8s","description":"…"},{"label":"Build","duration":"8-20s","description":"…"}],"cta":{"duration":"…","description":"…"}}, "budget_efficiency": "…" },

  "product_info": {
    "what": "구체적 상품/이벤트명 (예: WSUS 411 한정 스킨)",
    "key_benefit": "핵심 혜택 1문장 (예: 출시 기념 30% 할인)",
    "urgency": {"type":"time_limited|quantity_limited|exclusive|none","description":"3월 31일까지 등"},
    "cta_destination": "인게임 상점 > 스킨 탭 같은 구체 경로",
    "cta_action": "지금 구매하기 같은 동사형 구체 문구"
  },

  "hero_visual": {
    "must_show": ["반드시 노출할 시각 요소 3개"],
    "first_frame": "첫 프레임에 등장할 시각 요소의 구체 묘사",
    "brand_reveal_timing": "0-3s | 3-5s",
    "product_reveal_timing": "0-3s | 3-5s | 5-10s",
    "logo_placement": "first_frame | last_frame | persistent_corner"
  },

  "key_visual_criteria": {
    "definition": "이 프로젝트에서 키비주얼/하이라이트 컷이 의미하는 바 1문장",
    "selection_rules": ["하이라이트 후보를 고르는 기준 3개 — hook/hero/product/emotion/cta 중 근거 명시"],
    "visual_priorities": ["대표 이미지가 가져야 할 시각 우선순위 3-5개 — 피사체 위계, 실루엣, 깊이, 컬러 포인트 등"],
    "avoid_patterns": ["반복되면 품질이 떨어지는 구도/표현 2-4개"],
    "evidence": ["브리프/레퍼런스/ABCD 기준 중 이 정의의 근거 2-4개"]
  },

  "hook_strategy": {
    "primary": "gameplay_first | fail_solve | power_fantasy | unboxing_reveal | before_after | mystery_tease | testimonial | pattern_interrupt",
    "alternatives": ["대안 Hook 타입 2개"],
    "first_3s_description": "첫 3초에 실제로 일어날 일 구체 묘사 (무엇이 보이고, 어떤 소리/동작)",
    "pattern_interrupt": true
  },

  "pacing": {
    "format": "9:16 | 16:9 | 1:1 | 4:5",
    "duration": "6s | 15s | 30s | 45s | 60s",
    "sequence_count": {"min":3,"max":4,"recommended":3},
    "shot_count": {"min":6,"max":10,"recommended":8},
    "scene_count": {"min":6,"max":10,"recommended":8},
    "edit_rhythm": "fast | medium | slow",
    "silent_viewable": true,
    "captions_required": true
  },

  "constraints": {
    "brand_guidelines": ["로고/컬러/폰트 규칙"],
    "avoid": ["피해야 할 표현·이미지 — 네거티브 프롬프트로 직결됨"],
    "platform_policies": ["YouTube/Meta/TikTok 플랫폼별 주의사항"]
  }
}

brand_film 인 경우에만 추가:
"narrative": {
  "controlling_idea": "마지막 씬이 전달할 단 하나의 감정",
  "story_structure": "hero_journey | before_after | vignette | demonstration",
  "protagonist": {"identity":"…","desire":"…","transformation":"…"},
  "emotional_beats": [{"timestamp":"0-5s","emotion":"호기심","intensity":5}]
}

아이디어 메모가 함께 제공된 경우 위 JSON에 추가:
"idea_note": "원본 메모",
"creative_gap": { "synergy": ["시너지 2~3개"], "gap": ["간극 (없으면 빈 배열)"], "recommendation": "CD 한마디 제언" }

═══ CRITICAL QUALITY RULES ═══

[hook_strategy.primary 선택 기준]
- unboxing_reveal: 스킨/아이템 판매(product_launch) 기본값
- power_fantasy: RPG·배틀 product_launch / event 에 강함
- before_after: update 필수 선택 (구버전 → 신버전 비교)
- mystery_tease: 티저성 event 에 최적
- testimonial: community / 이벤트 보상 체감 필요 시
- gameplay_first: 판단 어려울 때의 안전한 기본값
- fail_solve: 퍼즐/캐주얼 전용
- pattern_interrupt: 바이럴 지향·플랫폼 알고리즘 노출 극대화

[hero_visual.first_frame 규칙]
- 첫 프레임 자체가 움직임 또는 궁금증 유발을 포함해야 한다 (정적 로고컷 금지)
- product_launch / event 는 product_reveal_timing = "0-3s" 가 기본값
- brand_film 은 product_reveal_timing = "5-10s" 도 허용

[key_visual_criteria 규칙]
- Highlight 체크박스가 후속 씬/이미지 생성에서 참고할 기준이다. 반드시 브리프와 레퍼런스 근거를 evidence 에 적는다.
- selection_rules 는 "왜 이 컷이 대표 이미지 후보인지"를 판단할 수 있어야 한다. 단순히 "멋있게" 금지.
- visual_priorities 는 카메라 고정값이 아니라 피사체 위계, 실루엣, 전경/중경/후경 깊이, 조명 분리, 브랜드/제품 가독성처럼 다양한 구도에 적용 가능한 기준으로 작성한다.
- avoid_patterns 는 과도한 중앙 클로즈업, generic stock hero pose, 로고 단독 첫 프레임, 모든 컷 동일 구도 등 반복 패턴 방지 기준을 포함한다.
- ABCD 기준과 연결: Attract=첫눈에 이해, Brand=제품/브랜드 명확성, Connect=감정/타겟 공감, Direct=CTA로 이어지는 명확성.

[레퍼런스 분석 규칙]
- 이미지/영상 레퍼런스는 "분위기"로만 요약하지 말고 hook 방식, 구도 원리, 조명/색, 편집 리듬, 전환 방식, 따라 하면 안 되는 요소로 분해한다.
- 사용자가 Time range / Focus points 를 달았으면 해당 구간의 timing, staging, subject hierarchy 를 최우선 근거로 삼는다.
- reference_video_insights.transferable_techniques 에는 후속 Storyboard/Conti가 바로 쓸 수 있는 연출 패턴만 적는다.

[constraints.avoid 규칙]
- 반드시 네거티브 프롬프트 형태 (예: "logo-only first frame", "flat product shot without motion", "generic stock footage cliché")
- 최소 2개 이상 제공

[pacing.sequence_count / pacing.shot_count 자동 결정]
- sequence_count 는 큰 이야기 단락 수다. 예: Hook / 상품 발견 / 기능 비교 / CTA.
- shot_count 는 후속 Agent/Conti 카드가 될 실제 Shot/컷 수다. 한 컷은 한 이미지 생성 단위다.
- scene_count 는 기존 저장 데이터 호환용 legacy 필드이며, 새 분석에서는 shot_count 와 같은 값을 넣는다.
- 6s → sequence_count 1~2 (recommended 1), shot_count 2~4 (recommended 3)
- 15s → sequence_count 3~4 (recommended 3), shot_count 6~10 (recommended 8)
- 30s → sequence_count 5~7 (recommended 6), shot_count 10~16 (recommended 12)
- 45s → sequence_count 7~10 (recommended 8), shot_count 14~22 (recommended 18)
- 60s → sequence_count 8~12 (recommended 10), shot_count 18~30 (recommended 24)
- product_launch / event / update 처럼 정보량이 많거나 HUD·제품 디테일·CTA가 필요한 경우 shot_count는 권장 범위의 상단을 선택한다.
- 단, sequence_count를 늘리는 것과 shot_count를 늘리는 것을 혼동하지 말 것. 15초 3~4씬은 가능하지만, 이를 3~4컷으로 줄이면 안 된다.

[scene_count_hint.body_beats 작성 규칙 (필수)]
- 30초 이상 영상에서 BODY 가 너무 많은 정보를 담아 통째로 묘사되면 후속 Agent/Conti 가 어디부터 손대야 할지 모른다. 그래서 BODY 를 sequence 단위로 쪼갠다.
- body_beats 길이 = pacing.sequence_count.recommended − 2 (HOOK 과 CTA 를 뺀 나머지가 body 시퀀스). 단 최소 1개는 보장한다.
  · 6s   (sequence 1~2): body_beats 1개  · 1초 미만이면 0개도 허용되나 비워두지 말고 1개로 둔다
  · 15s  (sequence 3):   body_beats 1개
  · 30s  (sequence 6):   body_beats 4개
  · 45s  (sequence 8):   body_beats 6개
  · 60s  (sequence 10):  body_beats 8개
- 각 beat 는 { label, duration, description } 3개 필드를 모두 채운다.
  · label: 4-10자 한글 또는 짧은 영문 (예: "문제 제기", "솔루션 등장", "기능 데모", "신뢰 빌드", "Setup", "Build", "Climax", "Pre-CTA"). 광고 내러티브의 한 단락을 가리키는 단어.
  · duration: HOOK 끝 ~ CTA 시작 사이를 균등 분할 또는 내용 비중에 맞춰 지정. 예: "3-8s", "8-20s".
  · description: 그 시퀀스에서 실제 무엇이 화면에 일어나는지 1-2문장. "EV3, EV4, PV5 를 각기 다른 역할로 짧게 분리 노출" 같은 구체 묘사.
- structure 필드는 새 형식에 맞춰 "HOOK → Setup → Build → Climax → CTA" 처럼 실제 beat label 들을 포함하도록 작성한다 ("HOOK → BODY → CTA" 같은 정적 문자열 금지).
- legacy 호환: 구버전 시스템과 데이터 간섭을 막기 위해 body 단일 필드는 출력하지 말고 항상 body_beats 배열로 작성한다.

[pacing.silent_viewable]
- 모바일·SNS (9:16, 1:1) 는 기본 true, captions_required = true
- YouTube 가로 (16:9) 는 false 허용

[product_info 규칙]
- what: 상품명은 브리프에서 그대로 추출 (추측 금지)
- cta_action: "지금 구매", "지금 다운로드", "참여하기" 같은 **동사 시작의 3-6자 짧은 문구**
- urgency.type === "none" 은 brand_film 외 허용 X

[visual_direction 4개 서브필드 의무]
- camera, lighting, color_grade, editing 각각 1-2 문장의 실무 지시어
- 추상적 "cinematic" 금지 → 실제 기법 (예: "handheld shaky cam at 120fps", "rim light from 45° back-left")

[reference_mood 작성 규칙]
- 장르 나열 금지. 시각/청각 디테일 2-3문장 센서리 묘사
- BAD: "다큐멘터리 현장감"
- GOOD: "라이브 스트림 채팅이 겹친 화면, 현장 사이렌+바람 소리 그대로의 무편집 오디오, 타임스탬프 오버레이"

[production_notes.format_recommendation 작성 규칙]
- 서술형 문장 금지. 실무자가 한눈에 스캔 가능한 짧은 라인 3-6개를 \n 줄바꿈으로 구분한다.
- 각 라인 = "- 라벨: 값 / 값 / 값" 패턴. 라벨은 2-6자, 값은 기술 사양(해상도/비율/길이/코덱/프레임률 등) 위주로 슬래시·플러스로 묶는다.
- 라벨 후보: 마스터, 송출, 세로 리프레임, 썸네일, 비율, 코덱, 프레임률, 자막, 안전 영역 등. 프로젝트에 안 맞는 라벨은 생략.
- BAD: "마스터는 60초 이내 16:9 1920x1080으로 제작하고, 오프라인 송출용 3840x2160과 세로형 1080x1920 리프레임을 동시에 고려합니다. 썸네일은 16:9 및 9:16 각각 PNG로, 차량·PUBGM·KIA 콜라보 맥락이 한눈에 들어오게 제작합니다."
- GOOD (KO):
  - 마스터: 60s / 16:9 / 1920x1080
  - 송출: 3840x2160 + 세로 1080x1920
  - 썸네일: 16:9 + 9:16 PNG
  - 자막: 무음 시청 대응 필수
- GOOD (EN):
  - Master: 60s / 16:9 / 1920x1080
  - Delivery: 3840x2160 + vertical 1080x1920
  - Thumb: 16:9 + 9:16 PNG
  - Captions: silent-view ready
- 실제 출력은 위 GOOD 처럼 string 안에 \n 으로 라인 구분된 단일 문자열로 작성.

[goal.core_message]
- 관객에게 던지는 15단어 이내 태그라인 (목표 설명 아님)

[goal.success_criteria]
- 수치 포함 2-3개 (예: "완주율 60% 이상, CTR 15% 이상")

[goal.desired_action]
- → 화살표로 연결한 2-3단계 퍼널

[usp.items]
- 각 item: { keyword: 2-4단어, comparison: "기존/경쟁 콘텐츠는 ~인데 이건 ~라서 다르다" 구체 비교 1문장 }
- 모호한 단어(현장감/사실성) 단독 금지

반드시 위 JSON 형식만 응답. JSON 외 텍스트 절대 포함 금지.`;

const LANG_DIRECTIVE_KO = `CRITICAL LANGUAGE RULE: ALL output fields must be written in Korean (한국어). This includes visual_direction (camera, lighting, color_grade, editing), reference_mood, scene_count_hint descriptions, usp comparisons, and every other text field. Do NOT mix English into Korean analysis. Only use English for proper nouns, technical terms (e.g. POV, HUD, CCTV), or universally understood abbreviations.\n\n`;
const LANG_DIRECTIVE_EN = `CRITICAL LANGUAGE RULE: ALL output fields must be written in English. Do NOT use Korean in any field.\n\n`;

/**
 * GPT-5.x 전용 추가 directive — JSON 강제 모드 (Chat Completions response_format=json_object)
 * 와 함께 쓰이지만, 모델이 가끔 빈 객체를 뱉을 위험을 줄이기 위해 시스템 프롬프트에서도
 * "stick to the schema, no extra keys" 를 명시한다.
 */
const GPT_DEEP_ANALYSIS_SUFFIX = `

[OUTPUT DISCIPLINE — GPT-5.x ONLY]
- Plan internally step by step, then output only valid JSON matching the schema above.
- No markdown fences. No commentary. No leading/trailing prose.
- Do NOT invent extra top-level keys. Optional keys may be omitted; required keys must be present.
- If reference video metadata or transcript is provided in the user message, you MUST also output a top-level "reference_video_insights" array with one object per reference, each shaped:
  { "source": "youtube"|"upload", "title": "...", "hook_pattern": "...",
    "pacing_per_scene": [{ "t": "0-3s", "beat": "..." }],
    "visual_motifs": ["..."], "audio_cues": ["..."],
    "transferable_techniques": ["..."], "do_not_copy": ["..."] }
- If no reference video is provided, omit the "reference_video_insights" key entirely.
`;

/**
 * 분석 결과 파서.
 *  - Claude 는 JSON 을 ```json``` 펜스로 감싸서 보낼 때가 있어 strip 처리.
 *  - GPT-5.x 는 response_format=json_object 가 보장되어 있어 그대로 parse.
 *  - 두 케이스 모두 안전하게 한 번에 처리.
 */
const parseDeepAnalysisJson = (text: string): DeepAnalysis => {
  const cleaned = text.replace(/```json\n?|\n?```/g, "").trim();
  return JSON.parse(cleaned);
};

const countRangeForDuration = (
  duration?: string,
): { sequence_count: { min: number; max: number; recommended: number }; shot_count: { min: number; max: number; recommended: number } } => {
  const d = duration ?? "";
  if (/6/.test(d)) return { sequence_count: { min: 1, max: 2, recommended: 1 }, shot_count: { min: 2, max: 4, recommended: 3 } };
  if (/30/.test(d)) return { sequence_count: { min: 5, max: 7, recommended: 6 }, shot_count: { min: 10, max: 16, recommended: 12 } };
  if (/45/.test(d)) return { sequence_count: { min: 7, max: 10, recommended: 8 }, shot_count: { min: 14, max: 22, recommended: 18 } };
  if (/60/.test(d)) return { sequence_count: { min: 8, max: 12, recommended: 10 }, shot_count: { min: 18, max: 30, recommended: 24 } };
  return { sequence_count: { min: 3, max: 4, recommended: 3 }, shot_count: { min: 6, max: 10, recommended: 8 } };
};

const ensureBriefQualityFields = (analysis: DeepAnalysis): DeepAnalysis => {
  const pacing = analysis.pacing
    ? (() => {
        const counts = countRangeForDuration(analysis.pacing.duration);
        const shot_count = analysis.pacing.shot_count ?? counts.shot_count;
        const sequence_count = analysis.pacing.sequence_count ?? counts.sequence_count;
        return {
          ...analysis.pacing,
          sequence_count,
          shot_count,
          scene_count: analysis.pacing.scene_count ?? shot_count,
        };
      })()
    : undefined;

  const abcd_compliance =
    analysis.abcd_compliance ??
    scoreABCD({
      hook_strategy: analysis.hook_strategy,
      hero_visual: analysis.hero_visual,
      product_info: analysis.product_info,
      pacing,
      constraints: analysis.constraints,
      audience_insight: analysis.audience_insight,
      visual_direction:
        typeof analysis.tone_manner?.visual_direction === "object"
          ? analysis.tone_manner.visual_direction
          : undefined,
      reference_mood: analysis.tone_manner?.reference_mood,
    }) ??
    undefined;

  const key_visual_criteria =
    analysis.key_visual_criteria ??
    (analysis.hero_visual
      ? {
          definition: `이 프로젝트의 대표 컷은 ${analysis.hero_visual.first_frame}의 시각 의도를 가장 명확히 보여주는 장면입니다.`,
          selection_rules: [
            "첫 3초 훅 또는 감정/제품 피크와 직접 연결되는 컷",
            "hero_visual.must_show 요소가 한눈에 읽히는 컷",
            "ABCD 기준에서 Attract와 Brand를 동시에 보강하는 컷",
          ],
          visual_priorities: [
            "명확한 피사체 위계",
            "실루엣 또는 조명 분리",
            "브랜드/제품/캐릭터 가독성",
            "전경/중경/후경 깊이감",
          ],
          avoid_patterns: [
            "로고만 보이는 정적 첫 프레임",
            "모든 컷이 같은 중앙 클로즈업으로 반복되는 구성",
            "제품/캐릭터가 배경에 묻혀 보이지 않는 구성",
          ],
          evidence: [
            "hero_visual.first_frame",
            "hero_visual.must_show",
            "Google ABCD: Attract/Brand",
          ],
        }
      : undefined);

  return {
    ...analysis,
    ...(pacing ? { pacing } : {}),
    ...(abcd_compliance ? { abcd_compliance } : {}),
    ...(key_visual_criteria ? { key_visual_criteria } : {}),
  };
};

const analyzeBriefText = async (briefText: string, lang: Lang = "ko", modelId?: string): Promise<DeepAnalysis> => {
  const langDirective = lang === "en" ? LANG_DIRECTIVE_EN : LANG_DIRECTIVE_KO;
  const resolvedModel = modelId ?? getModel("brief");
  const meta = getModelMeta(resolvedModel, getSettingsCached());
  const isOpenAI = meta?.provider === "openai";
  const system = langDirective + DEEP_ANALYSIS_SYSTEM_PROMPT + (isOpenAI ? GPT_DEEP_ANALYSIS_SUFFIX : "");
  const result = await callLLM({
    model: resolvedModel,
    system,
    max_tokens: meta?.maxOutputTokens ?? 4500,
    response_format: isOpenAI ? "json_object" : undefined,
    messages: [{ role: "user", content: `다음 브리프를 분석해주세요:\n\n${briefText}` }],
  });
  return ensureBriefQualityFields(parseDeepAnalysisJson(result.text));
};

type BriefAnalysisImage = { base64: string; mediaType: string; label?: string };

/** 슬림 항목(base64 가 비고 preview 가 storage URL)을 분석 직전에만 base64 로
 *  지연 fetch 한다. localStorage 슬림화(quota 절약)와 분석 입력 구성을 양립시키는
 *  핵심 — 평소엔 URL 만 들고 있다가 분석 때 1회 vision-downscale fetch. */
async function resolveAnalysisBase64(item: {
  base64: string;
  mediaType: string;
  preview?: string;
}): Promise<{ base64: string; mediaType: string }> {
  if (item.base64) return { base64: item.base64, mediaType: item.mediaType };
  if (isHttpUrl(item.preview)) {
    try {
      const r = await urlToVisionBase64(item.preview);
      return { base64: r.base64, mediaType: r.mediaType };
    } catch (e) {
      console.warn("[BriefTab] lazy base64 fetch failed:", (e as Error).message);
    }
  }
  return { base64: item.base64, mediaType: item.mediaType };
}

const analyzeBriefWithImages = async (
  images: BriefAnalysisImage[],
  additionalText: string,
  lang: Lang = "ko",
  modelId?: string,
): Promise<DeepAnalysis> => {
  const langDirective = lang === "en" ? LANG_DIRECTIVE_EN : LANG_DIRECTIVE_KO;
  const resolvedModel = modelId ?? getModel("brief");
  const meta = getModelMeta(resolvedModel, getSettingsCached());
  const isOpenAI = meta?.provider === "openai";
  const system =
    langDirective +
    DEEP_ANALYSIS_SYSTEM_PROMPT +
    "\n\n이미지 안의 모든 시각적 정보를 빠짐없이 읽고 분석하세요." +
    (isOpenAI ? GPT_DEEP_ANALYSIS_SUFFIX : "");
  const content: Array<{ type: "text"; text: string } | { type: "image"; mediaType: string; dataBase64: string }> = [];
  images.forEach((img, i) => {
    content.push({ type: "image", mediaType: img.mediaType, dataBase64: img.base64 });
    if (images.length > 1) {
      content.push({ type: "text", text: img.label ?? `위 이미지는 브리프 이미지 ${i + 1}입니다.` });
    }
  });
  content.push({
    type: "text",
    text: `첨부 이미지와 레퍼런스를 함께 읽고 광고 브리프를 분석하세요.${additionalText ? `\n\n추가 설명: ${additionalText}` : ""}`,
  });
  const result = await callLLM({
    model: resolvedModel,
    system,
    max_tokens: meta?.maxOutputTokens ?? 4500,
    response_format: isOpenAI ? "json_object" : undefined,
    messages: [{ role: "user", content }],
  });
  return ensureBriefQualityFields(parseDeepAnalysisJson(result.text));
};

export interface RunBriefDeepAnalysisInput {
  briefText?: string;
  ideaNote?: string;
  /** 사용자가 첨부한 브리프 본문 이미지(캡쳐/스크린샷). 레퍼런스와 달리 "브리프
   *  원본" 으로 취급해 분석 우선순위가 높다. */
  briefImages?: { base64: string; mediaType: string }[];
  /** 브리프 PDF 추출 텍스트(있으면 분석 본문에 합류). */
  pdfText?: string;
  /** 분석 입력으로 쓸 레퍼런스(이미지/영상/유튜브). link 는 호출부에서 썸네일
   *  이미지 RefItem 으로 변환해 넘긴다. */
  refItems: RefItem[];
  lang?: Lang;
  modelId?: string;
}

/**
 * 컴포넌트 밖(예: 라이브러리 "스마트 브리프 매치" 사전 분석 시드)에서 호출 가능한
 * 브리프 심층 분석. `handleAnalyze` 의 "텍스트 + 레퍼런스(이미지/영상/유튜브)" 경로를
 * 그대로 재사용하되, PDF / 사용자 첨부 브리프 이미지는 다루지 않는다(폴더 내보내기
 * 범위 = 텍스트 + 레퍼런스). 결과 `DeepAnalysis` 는 호출부가 `briefs.analysis` 로
 * 시드하면 프로젝트 BriefTab 진입 시 로딩 없이 즉시 표시된다.
 */
export async function runBriefDeepAnalysis(input: RunBriefDeepAnalysisInput): Promise<DeepAnalysis> {
  const lang: Lang = input.lang ?? "ko";
  await ensureSettingsLoaded();
  const modelId = input.modelId ?? getModel("brief");
  const meta = getModelMeta(modelId, getSettingsCached());
  const modelSupportsVideo = !!meta?.supportsVideoFrames;
  const supportsVision = !!meta?.supportsVision;
  const briefText = (input.briefText ?? "").trim();
  const ideaNote = (input.ideaNote ?? "").trim();
  const pdfText = (input.pdfText ?? "").trim();
  const briefImages = input.briefImages ?? [];
  const refItems = input.refItems;

  const refImagesUsable = refItems.filter(
    (it): it is RefImageItem => it.kind === "image" && !it.ignoredByModel,
  );
  const youtubesUsable = refItems.filter(
    (it): it is RefYoutubeItem => it.kind === "youtube" && !it.ignoredByModel && it.status === "ready",
  );
  const videosUsable = refItems.filter(
    (it): it is RefVideoItem => it.kind === "video" && !it.ignoredByModel && it.status === "ready",
  );

  // 영상 프레임 샘플링 — 라이브러리 영상은 File 핸들이 없고 remoteUrl(storage URL)
  // 로 샘플링한다. 둘 다 없으면 poster 한 장으로 폴백.
  const sampledVideos: Array<{ item: RefVideoItem; frames: { base64: string; mediaType: string; t: number }[] }> = [];
  if (modelSupportsVideo) {
    for (const v of videosUsable) {
      const source = v.file ?? v.remoteUrl;
      if (!source) {
        sampledVideos.push({
          item: v,
          frames: v.posterBase64 ? [{ base64: v.posterBase64, mediaType: "image/png", t: 0 }] : [],
        });
        continue;
      }
      try {
        const targetCount = v.durationSec > 60 ? 12 : 8;
        const ann = v.annotation;
        const range =
          ann && typeof ann.startSec === "number" && typeof ann.endSec === "number"
            ? { startSec: ann.startSec, endSec: ann.endSec }
            : undefined;
        const { frames } = await sampleFrames(source, targetCount, range);
        sampledVideos.push({ item: v, frames: frames.map((f) => ({ base64: f.base64, mediaType: f.mediaType, t: f.t })) });
      } catch {
        sampledVideos.push({
          item: v,
          frames: v.posterBase64 ? [{ base64: v.posterBase64, mediaType: "image/png", t: 0 }] : [],
        });
      }
    }
  }

  // 텍스트 인서트: youtube 메타/자막 + video 메타 + 이미지 부연설명
  const ytLines: string[] = [];
  for (const yt of youtubesUsable) {
    const head = `- [YouTube] ${yt.title || yt.url} ${yt.channel ? `· ${yt.channel}` : ""} (${yt.videoId})`;
    const annLines = formatAnnotationLines(yt.annotation, { includeRange: true });
    const transcript = yt.transcript
      ? `\n  Transcript (excerpt): ${yt.transcript.slice(0, 1500)}${yt.transcript.length > 1500 ? "…" : ""}`
      : "";
    ytLines.push([head, ...annLines].join("\n") + transcript);
  }
  const vidLines: string[] = sampledVideos.map(({ item, frames }) => {
    const ann = item.annotation;
    const rangeApplied = ann && typeof ann.startSec === "number" && typeof ann.endSec === "number";
    const head = `- [Video] ${item.fileName} · ${Math.round(item.durationSec)}s · ${frames.length} frames sampled${rangeApplied ? ` (dense-sampled within ${ann!.rangeText})` : ""}`;
    const annLines = formatAnnotationLines(ann, { includeRange: !rangeApplied });
    return [head, ...annLines].join("\n");
  });
  const imgNoteLines: string[] = [];
  {
    let idx = 1;
    const imageIdxMap = new Map<string, number>();
    for (const it of refItems) {
      if (it.kind === "image") {
        imageIdxMap.set(it.id, idx);
        idx++;
      }
    }
    for (const [id, n] of imageIdxMap) {
      const img = refItems.find((it) => it.id === id) as RefImageItem | undefined;
      if (!img || !hasAnnotation(img.annotation)) continue;
      const annLines = formatAnnotationLines(img.annotation, { includeRange: false });
      if (annLines.length === 0) continue;
      imgNoteLines.push([`- Image ${n}`, ...annLines].join("\n"));
    }
  }
  let videoInsightsBlock = "";
  if (ytLines.length || vidLines.length || imgNoteLines.length) {
    const hasAnyUserNotes = refItems.some((it) => hasAnnotation(it.annotation));
    const directive = hasAnyUserNotes
      ? "Each reference below may carry a 'Time range' and 'Focus points' — these are explicit, user-highlighted learning points. Prioritize extracting the technique, timing and staging from those sections over other elements.\n\n"
      : "";
    videoInsightsBlock = directive + [
      ytLines.length ? `### YouTube References\n${ytLines.join("\n")}` : "",
      vidLines.length ? `### Video References\n${vidLines.join("\n")}` : "",
      imgNoteLines.length ? `### Image Reference Notes\n${imgNoteLines.join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const extraFrameImages: BriefAnalysisImage[] = modelSupportsVideo
    ? sampledVideos
        .flatMap(({ item, frames }) =>
          frames.map((frame) => ({
            base64: frame.base64,
            mediaType: frame.mediaType,
            label: `위 이미지는 영상 레퍼런스 "${item.fileName}"의 ${frame.t.toFixed(1)}초 프레임입니다.`,
          })),
        )
        .slice(0, 16)
    : [];
  const refImageInputs: BriefAnalysisImage[] = supportsVision
    ? (
        await Promise.all(
          refImagesUsable.map(async (img, index) => {
            const { base64, mediaType } = await resolveAnalysisBase64(img);
            return {
              base64,
              mediaType,
              label: `위 이미지는 레퍼런스 이미지 ${index + 1}입니다. 브리프 원본이 아니라 시각 스타일, 분위기, 구성, 연출 힌트로만 참고하세요.`,
            };
          }),
        )
      ).filter((i) => !!i.base64)
    : [];

  // 사용자 브리프 본문 이미지 — vision 지원 시 "브리프 원본" 으로 최우선 첨부.
  const briefImageInputs: BriefAnalysisImage[] = supportsVision
    ? briefImages.map((img, index) => ({
        base64: img.base64,
        mediaType: img.mediaType,
        label: `위 이미지는 사용자가 첨부한 브리프 이미지 ${index + 1}입니다.`,
      }))
    : [];

  let result: DeepAnalysis;
  if (briefImageInputs.length > 0 || refImageInputs.length > 0 || extraFrameImages.length > 0) {
    const allImages: BriefAnalysisImage[] = [...briefImageInputs, ...refImageInputs, ...extraFrameImages];
    result = await analyzeBriefWithImages(
      allImages,
      [
        briefText,
        pdfText ? `PDF 브리프 본문:\n${pdfText}` : "",
        videoInsightsBlock ? `영상 레퍼런스 인사이트:\n${videoInsightsBlock}` : "",
        ideaNote ? `크리에이터 아이디어 메모: ${ideaNote}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      lang,
      modelId,
    );
  } else {
    let txt = briefText;
    if (pdfText) txt += `\n\n## PDF 브리프 본문\n${pdfText}`;
    if (videoInsightsBlock) txt += `\n\n## 영상 레퍼런스 인사이트\n${videoInsightsBlock}`;
    if (ideaNote) txt += `\n\n## 크리에이터 아이디어 메모\n${ideaNote}`;
    result = await analyzeBriefText(txt, lang, modelId);
  }

  if (ideaNote) result.idea_note = ideaNote;
  return result;
}

/* ━━━━━ i18n 라벨 맵 ━━━━━ */
export type Lang = "ko" | "en";
const L: Record<string, Record<Lang, string>> = {
  core_strategy: { ko: "핵심 전략", en: "Core Strategy" },
  production_guide: { ko: "제작 가이드", en: "Production Guide" },
  campaign_goal: { ko: "캠페인 목표", en: "Campaign Goal" },
  target: { ko: "타겟", en: "Target" },
  target_audience: { ko: "타겟 오디언스", en: "Target Audience" },
  usp: { ko: "USP · 핵심 차별점", en: "USP · Key Differentiator" },
  tone_manner: { ko: "톤앤매너", en: "Tone & Manner" },
  prod_notes: { ko: "제작 노트", en: "Prod Notes" },
  brief_idea_analysis: { ko: "브리프 × 아이디어 메모 분석", en: "Brief × Idea Memo Analysis" },
  kpi_hint: { ko: "KPI 힌트", en: "KPI Hint" },
  core_message: { ko: "핵심 메시지", en: "Core Message" },
  success_criteria: { ko: "성공 기준", en: "Success Criteria" },
  desired_action: { ko: "핵심 액션", en: "Desired Action" },
  psychological_insight: { ko: "심리적 인사이트", en: "Psychological Insight" },
  media_behavior: { ko: "미디어 행동", en: "Media Behavior" },
  competitive_edge: { ko: "경쟁 우위", en: "Competitive Edge" },
  visual_direction: { ko: "비주얼 방향", en: "Visual Direction" },
  reference_mood: { ko: "레퍼런스 무드", en: "Reference Mood" },
  do_not: { ko: "금지 사항", en: "Do Not" },
  format: { ko: "포맷", en: "Format" },
  shooting_style: { ko: "촬영 스타일", en: "Shooting Style" },
  scene_flow: { ko: "씬 흐름", en: "Scene Flow" },
  budget_efficiency: { ko: "예산 효율", en: "Budget Efficiency" },
  abcd_effectiveness: { ko: "ABCD 효과성 스코어", en: "ABCD Effectiveness Score" },
  abcd_design_checklist: { ko: "ABCD 설계 체크리스트", en: "ABCD Design Checklist" },
  abcd_measured_effectiveness: { ko: "ABCD 효과성 점검", en: "ABCD Effectiveness Check" },
  abcd_source_plan: { ko: "예측 · 브리프 설계 기반", en: "Predicted · plan-based" },
  abcd_source_scenes: { ko: "실측 · 씬 {n}개 반영", en: "Measured · {n} scenes applied" },
  abcd_preview_plan: {
    ko: "브리프 설계값을 기준으로 ABCD 4축이 얼마나 탄탄히 준비됐는지 예측합니다.",
    en: "Predicts ABCD 4-axis readiness from the current brief plan values.",
  },
  abcd_preview_scenes: {
    ko: "Agent 씬을 반영한 ABCD 4축 실측 점검 — 씬이 갱신되면 D축이 재계산됩니다.",
    en: "ABCD 4-axis check measured against Agent scenes — D-axis re-scores as scenes evolve.",
  },
  abcd_attract: { ko: "Attract · 첫 3초 몰입도", en: "Attract · First 3s Hook" },
  abcd_brand: { ko: "Brand · 브랜드·제품 노출", en: "Brand · Brand/Product Exposure" },
  abcd_connect: { ko: "Connect · 감정 연결", en: "Connect · Emotional Link" },
  abcd_direct: { ko: "Direct · CTA 명확성", en: "Direct · CTA Clarity" },
  abcd_total: { ko: "종합", en: "Total" },
  narrative_structure: { ko: "서사 구조 (브랜드 필름)", en: "Narrative Structure (Brand Film)" },
  controlling_idea: { ko: "Controlling Idea", en: "Controlling Idea" },
  protagonist: { ko: "주인공 · 욕망 · 변화", en: "Protagonist · Desire · Transformation" },
  emotional_beats: { ko: "감정 비트", en: "Emotional Beats" },
  content_type_label: { ko: "콘텐츠 유형", en: "Content Type" },
};

const CONTENT_TYPE_LABEL: Record<string, { ko: string; en: string; color: string }> = {
  product_launch: { ko: "상품 런칭", en: "Product Launch", color: "#f59e0b" },
  event: { ko: "이벤트", en: "Event", color: "#8b5cf6" },
  update: { ko: "업데이트", en: "Update", color: "#06b6d4" },
  community: { ko: "커뮤니티", en: "Community", color: "#10b981" },
  brand_film: { ko: "브랜드 필름", en: "Brand Film", color: KR },
};
const t = (key: string, lang: Lang) => L[key]?.[lang] ?? key;

/* ━━━━━ UI 서브 컴포넌트 (Dark Theme) ━━━━━ */
const SectionCard = ({
  children,
  className = "",
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) => (
  <div
    className={`bg-elevated border border-border overflow-hidden ${className}`}
    style={{ borderRadius: 0, ...style }}
  >
    {children}
  </div>
);

type DotVariant = "red" | "black" | "gray";

const SectionHeader = ({ dot, label }: { dot: DotVariant; label: string; tag?: string }) => (
  <div
    className="flex items-center gap-2 px-3 py-2.5 border-b border-border"
    style={{ background: dot === "red" ? "rgba(249,66,58,0.06)" : "rgba(255,255,255,0.02)" }}
  >
    <span
      className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot === "red" ? "bg-primary" : dot === "black" ? "bg-foreground" : "bg-muted-foreground"}`}
    />
    <span className="text-meta font-bold uppercase tracking-wider text-foreground">{label}</span>
  </div>
);

const BulletList = ({ items, dot = "red" }: { items: string[]; dot?: "red" | "black" }) => (
  <ul className="space-y-1.5">
    {items.map((item, i) => (
      <li key={i} className="flex items-start gap-2 text-body leading-relaxed text-muted-foreground">
        <span className={`w-1 h-1 rounded-full shrink-0 mt-[7px] ${dot === "red" ? "bg-primary" : "bg-foreground"}`} />
        {item}
      </li>
    ))}
  </ul>
);

const SubCard = ({ label, value }: { label: string; value: string }) => (
  <div className="bg-background/80 border border-border px-3 py-2.5" style={{ borderRadius: 0 }}>
    <p className="label-meta text-muted-foreground mb-1">{label}</p>
    <div className="text-body leading-relaxed text-foreground/80 space-y-1">
      {value
        .split(/(?<=[.。!?])\s+/)
        .filter((s) => s.trim())
        .map((sentence, i) => (
          <p key={i}>{sentence.trim()}</p>
        ))}
    </div>
  </div>
);

const CreativeGapSection = ({
  gap,
  lang = "ko",
  onUpdate,
}: {
  gap: DeepAnalysis["creative_gap"];
  lang?: Lang;
  onUpdate?: OnFieldUpdate;
}) => {
  if (!gap) return null;
  return (
    <SectionCard>
      <SectionHeader dot="gray" label={t("brief_idea_analysis", lang)} />
      <div className="px-3 py-2.5 space-y-2">
        {gap.synergy.map((s, i) => (
          <div key={i} className="flex items-start gap-2 text-body leading-relaxed text-emerald-400">
            <CheckCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            {onUpdate ? (
              <EditableText
                value={s}
                onSave={(v) => onUpdate(["creative_gap", "synergy", String(i)], v)}
                className="flex-1 text-body leading-relaxed text-emerald-400"
              />
            ) : (
              s
            )}
          </div>
        ))}
        {gap.gap.map((g, i) => (
          <div key={i} className="flex items-start gap-2 text-body leading-relaxed text-amber-400">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            {onUpdate ? (
              <EditableText
                value={g}
                onSave={(v) => onUpdate(["creative_gap", "gap", String(i)], v)}
                className="flex-1 text-body leading-relaxed text-amber-400"
              />
            ) : (
              g
            )}
          </div>
        ))}
        {gap.recommendation && (
          <div className="border-l-2 border-primary/40 pl-3 mt-2">
            {onUpdate ? (
              <EditableText
                value={gap.recommendation}
                onSave={(v) => onUpdate(["creative_gap", "recommendation"], v)}
                className="text-body text-muted-foreground leading-relaxed italic"
              />
            ) : (
              <p className="text-body text-muted-foreground leading-relaxed italic">"{gap.recommendation}"</p>
            )}
          </div>
        )}
      </div>
    </SectionCard>
  );
};

/* ━━━━━ Collapsible Section ━━━━━ */
const CollapsibleSection = ({
  title,
  preview,
  defaultOpen = false,
  children,
}: {
  title: string;
  preview?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 py-1.5 text-left group">
        <ChevronDown
          className={`w-3 h-3 text-muted-foreground/50 transition-transform duration-200 ${open ? "" : "-rotate-90"}`}
        />
        <span className="label-meta text-primary">{title}</span>
        {!open && preview && (
          <span className="text-2xs text-muted-foreground/40 truncate flex-1 ml-1">{preview}</span>
        )}
      </button>
      <div
        className={`overflow-hidden transition-all duration-200 ${open ? "max-h-[2000px] opacity-100 mt-1.5" : "max-h-0 opacity-0"}`}
      >
        {children}
      </div>
    </div>
  );
};

/* ━━━━━ Section heading helpers ━━━━━ */
const Heading1 = ({ children }: { children: React.ReactNode }) => (
  <div className="flex items-center gap-2.5 mt-8 first:mt-0 mb-4">
    <span className="w-[3px] self-stretch bg-primary" style={{ borderRadius: 0 }} />
    <span className="text-title font-bold text-primary tracking-wide">{children}</span>
  </div>
);

const Heading2 = ({ children, tag }: { children: React.ReactNode; tag?: string }) => (
  <div className="flex items-center gap-2 mb-2">
    <span className="text-label font-semibold text-foreground">{children}</span>
    {tag && (
      <span
        className="ml-auto font-mono text-2xs px-2 py-0.5 font-bold uppercase tracking-wider"
        style={{
          borderRadius: 0,
          background: "rgba(255,255,255,0.06)",
          color: "rgba(255,255,255,0.4)",
          border: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        {tag}
      </span>
    )}
  </div>
);

/**
 * 카테고리 sub-label.
 *
 * 본문(13px) 보다 시각적으로 약해 보이지 않도록 폰트 굵기·밝기·tracking 을
 * 전부 강화. 좌측 1.5px × 12px 레드 핑크 캡 액센트로 라벨 위치를 명확히
 * 앵커링한다 (KR 핑크 #f9423a). 색은 white 70% 로 낮은 투명도 본문과 톤
 * 차이를 둠.
 */
const Label3 = ({ children }: { children: React.ReactNode }) => (
  <div className="flex items-center gap-1.5 mb-2">
    <span className="block" style={{ width: 2, height: 11, background: KR }} />
    <span
      className="text-meta font-bold uppercase tracking-wider"
      style={{ color: "rgba(255,255,255,0.78)" }}
    >
      {children}
    </span>
  </div>
);

/* ━━━━━ EditableText — inline editing component ━━━━━ */
type OnFieldUpdate = (path: string[], newValue: any) => void;

const EditableText = ({
  value,
  onSave,
  multiline,
  placeholder,
  className: extraClass = "",
  style: extraStyle,
  syncing,
}: {
  value: string;
  onSave: (newValue: string) => void;
  multiline?: boolean;
  placeholder?: string;
  className?: string;
  style?: React.CSSProperties;
  syncing?: boolean;
}) => {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const clickOffsetRef = useRef<number | null>(null);

  /**
   * Display ↔ Edit 사이 시각 차이를 0 으로 만들기 위한 공통 박스 스타일.
   *
   * - padding 은 0. 이전엔 `4px 8px` 였지만 EditableText 가 bullet/번호/라벨
   *   같은 형제 요소와 같은 줄에 놓일 때 padding 만큼 텍스트가 안쪽으로 밀려
   *   "정렬이 흐트러진" 듯한 느낌을 줬다. 클릭 시 jolt 는 padding 으로
   *   제거하지 않고도 border-width 와 line-height 가 두 모드에서 동일하면
   *   충분히 막을 수 있다.
   * - Display 는 투명 1px 테두리, Edit 는 빨강 1px 테두리 (둘 다 1px) — 두께
   *   차이로 인한 0.5~1px shift 를 막는다.
   * - 멀티라인은 line-break 를 그대로 유지하기 위해 `whiteSpace: pre-wrap`.
   *
   * NOTE: font 속성(family/size/line-height) 은 여기 넣지 않는다. Display span
   * 은 className 의 Tailwind text-* 를 그대로 받아야 해서 inline style 로
   * fontSize: "inherit" 를 박으면 부모 폰트 크기로 강제 회귀해 타이틀과 본문
   * 폰트 차이가 사라진다. textarea/input 만 form-element 의 브라우저 기본
   * 폰트를 잠재우려고 별도로 inherit 를 명시한다.
   */
  const sharedBoxStyle: React.CSSProperties = {
    padding: 0,
    margin: 0,
    borderRadius: 0,
    borderWidth: 1,
    borderStyle: "solid",
    boxSizing: "border-box",
  };
  const formFontStyle: React.CSSProperties = {
    fontFamily: "inherit",
    fontSize: "inherit",
    lineHeight: "inherit",
  };

  // textarea 의 높이를 내용에 맞춰 자동으로 키워, "클릭하니 작은 박스로 바뀐다"
  // 는 jolt 를 없앤다. min-height 는 두지 않고 scrollHeight 를 그대로 쓴다.
  const autosize = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus();
      if (clickOffsetRef.current !== null) {
        const pos = Math.min(clickOffsetRef.current, ref.current.value.length);
        ref.current.setSelectionRange(pos, pos);
        clickOffsetRef.current = null;
      } else {
        const len = ref.current.value.length;
        ref.current.setSelectionRange(len, len);
      }
      if (multiline && ref.current instanceof HTMLTextAreaElement) {
        autosize(ref.current);
      }
    }
  }, [editing, multiline]);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  if (!editing) {
    const isEmpty = !value;
    const displayBody = isEmpty ? (
      <span style={{ color: "#555", fontStyle: "italic" }}>{placeholder || "—"}</span>
    ) : (
      value
    );
    return (
      <span
        onClick={() => {
          const sel = window.getSelection();
          clickOffsetRef.current = sel?.focusOffset ?? value.length;
          setDraft(value);
          setEditing(true);
        }}
        className={`cursor-text transition-colors duration-150 ${extraClass}`}
        style={{
          ...sharedBoxStyle,
          borderColor: "transparent",
          background: "transparent",
          // 멀티라인은 textarea 처럼 block 으로 폭 100%, 단일라인은 inline-block
          // 으로 자기 크기.
          display: multiline ? "block" : "inline-block",
          width: multiline ? "100%" : undefined,
          // 사용자 입력의 \n 을 그대로 보여주고, 가로 폭이 작으면 자연스럽게
          // word-wrap. textarea 와 동일한 wrap 거동.
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          ...extraStyle,
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.04)";
          (e.currentTarget as HTMLElement).style.borderColor = "rgba(255,255,255,0.08)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.background = "transparent";
          (e.currentTarget as HTMLElement).style.borderColor = "transparent";
        }}
        title={t("brief.clickToEdit")}
      >
        {displayBody}
        {syncing && (
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: KR,
              animation: "pulse 1s infinite",
              marginLeft: 4,
              display: "inline-block",
              verticalAlign: "middle",
            }}
          />
        )}
      </span>
    );
  }
  const handleCommit = () => {
    setEditing(false);
    if (draft.trim() !== value) {
      onSave(draft.trim());
      sonnerToast("Saved", { duration: 1000 });
    }
  };

  if (multiline) {
    return (
      <textarea
        ref={ref as React.RefObject<HTMLTextAreaElement>}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          autosize(e.currentTarget);
        }}
        onInput={(e) => autosize(e.currentTarget as HTMLTextAreaElement)}
        onBlur={handleCommit}
        onKeyDown={(e) => {
          /* Enter 단독 → commit & 종료 (single-line input 과 동일).
             줄바꿈은 Shift+Enter (또는 Cmd/Ctrl+Enter) 로 강제. */
          if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            handleCommit();
            return;
          }
          if (e.key === "Escape") {
            setDraft(value);
            setEditing(false);
          }
        }}
        className={extraClass}
        style={{
          ...sharedBoxStyle,
          ...formFontStyle,
          width: "100%",
          background: "rgba(255,255,255,0.06)",
          borderColor: "rgba(249,66,58,0.3)",
          color: "#fff",
          outline: "none",
          // resize 핸들 / min-height 제거: autosize 가 모든 케이스를 커버.
          // 폭은 부모를 따른다 (display 모드와 동일).
          resize: "none",
          overflow: "hidden",
          // textarea 기본 display 는 inline-block 으로 세로 정렬이 묘하게 어긋
          // 나는 경우가 있어 명시적으로 block 처리.
          display: "block",
          ...extraStyle,
        }}
      />
    );
  }

  return (
    <input
      ref={ref as React.RefObject<HTMLInputElement>}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={handleCommit}
      onKeyDown={(e) => {
        if (e.key === "Enter") handleCommit();
        if (e.key === "Escape") {
          setDraft(value);
          setEditing(false);
        }
      }}
      className={extraClass}
      style={{
        ...sharedBoxStyle,
        ...formFontStyle,
        width: "100%",
        background: "rgba(255,255,255,0.06)",
        borderColor: "rgba(249,66,58,0.3)",
        color: "#fff",
        outline: "none",
        ...extraStyle,
      }}
    />
  );
};

/* ━━━━━ Deep-set utility ━━━━━ */
function deepSet(obj: any, path: string[], value: any): any {
  const result = structuredClone(obj);
  let target = result;
  for (let i = 0; i < path.length - 1; i++) {
    target = target[path[i]];
  }
  target[path[path.length - 1]] = value;
  return result;
}

/* ━━━━━ Reorder array sync (no translation needed) ━━━━━ */
function reorderArraySync(targetLang: any, sourceLang: any, path: string[], newArray: any[]): any {
  const result = structuredClone(targetLang);
  let target = result;
  for (let i = 0; i < path.length - 1; i++) target = target[path[i]];

  const oldTargetArray = target[path[path.length - 1]] || [];

  let oldSource = sourceLang;
  for (const p of path) oldSource = oldSource?.[p];

  if (Array.isArray(newArray) && Array.isArray(oldTargetArray)) {
    const reordered = newArray.map((item, i) => {
      const origIdx = oldSource?.findIndex?.((old: any) => JSON.stringify(old) === JSON.stringify(item));
      return origIdx >= 0 && origIdx < oldTargetArray.length ? oldTargetArray[origIdx] : oldTargetArray[i] || item;
    });
    target[path[path.length - 1]] = reordered;
  }

  return result;
}

/* ━━━━━ SortableUspItem — draggable USP card ━━━━━ */
const SortableUspCard = ({
  item,
  index,
  onUpdate,
  basePath,
}: {
  item: UspItem;
  index: number;
  onUpdate?: OnFieldUpdate;
  basePath: string[];
}) => {
  const noLayoutAnimation: AnimateLayoutChanges = () => false;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `usp-${index}`,
    animateLayoutChanges: noLayoutAnimation,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? transition : undefined,
    opacity: isDragging ? 0.7 : 1,
    borderRadius: 0,
    ...(index === 0
      ? {
          background: "rgba(249,66,58,0.08)",
          border: isDragging ? "1px solid rgba(249,66,58,0.5)" : "1px solid rgba(249,66,58,0.2)",
        }
      : {
          background: "rgba(255,255,255,0.03)",
          border: isDragging ? "1px solid rgba(249,66,58,0.5)" : "1px solid rgba(255,255,255,0.06)",
        }),
  };

  return (
    <div ref={setNodeRef} style={style} className="px-3 py-3">
      <div className="flex items-start gap-2.5">
        <span
          {...attributes}
          {...listeners}
          className="w-5 h-5 flex items-center justify-center text-2xs font-bold shrink-0 mt-0.5 cursor-grab active:cursor-grabbing group relative"
          style={{
            borderRadius: 0,
            background: index === 0 ? KR : index === 1 ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.08)",
            color: index === 0 ? "#fff" : "rgba(255,255,255,0.5)",
          }}
        >
          {index + 1}
          <GripVertical
            className="w-3 h-3 absolute opacity-0 group-hover:opacity-60 transition-opacity"
            style={{ color: "currentColor" }}
          />
        </span>
        <div className="flex-1 min-w-0 flex flex-col gap-1.5">
          {onUpdate ? (
            <>
              <EditableText
                value={item.keyword}
                onSave={(v) => onUpdate([...basePath, String(index), "keyword"], v)}
                className="text-body leading-snug font-semibold"
                style={{ color: index === 0 ? "#f0f0f0" : "rgba(255,255,255,0.6)" }}
              />
              {item.comparison && (
                <EditableText
                  value={item.comparison}
                  onSave={(v) => onUpdate([...basePath, String(index), "comparison"], v)}
                  multiline
                  className="text-meta leading-[1.6]"
                  style={{ color: "#999", paddingLeft: 0 }}
                />
              )}
            </>
          ) : (
            <>
              <span
                className="text-body leading-snug font-semibold"
                style={{ color: index === 0 ? "#f0f0f0" : "rgba(255,255,255,0.6)" }}
              >
                {item.keyword}
              </span>
              {item.comparison && (
                <p className="text-meta leading-[1.6]" style={{ color: "#999" }}>
                  {item.comparison}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

const AccordionCard = ({
  index,
  title,
  preview,
  isOpen,
  onToggle,
  children,
}: {
  index: number;
  title: string;
  preview: string;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) => (
  <div
    className="transition-all duration-200"
    style={{
      background: isOpen ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.02)",
      border: `1px solid ${isOpen ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.06)"}`,
      borderRadius: 0,
      marginBottom: 8,
    }}
  >
    <div
      onClick={onToggle}
      className="flex items-center justify-between cursor-pointer select-none"
      style={{ padding: "14px 14px 6px" }}
    >
      <div className="flex items-center gap-2.5">
        <span
          className="w-[22px] h-[22px] flex items-center justify-center text-caption font-bold text-white shrink-0"
          style={{ borderRadius: "50%", background: KR }}
        >
          {index}
        </span>
        <span className="text-subhead font-bold text-foreground">{title}</span>
      </div>
      <ChevronDown
        className="w-3.5 h-3.5 transition-transform duration-200"
        style={{ color: "#666", transform: isOpen ? "rotate(0deg)" : "rotate(-90deg)" }}
      />
    </div>
    <div
      className="text-xs text-muted-foreground my-0 mx-0 py-[20px] px-[45px] pt-0"
      style={{ paddingBottom: isOpen ? "14px" : "10px", lineHeight: 1.4 }}
    >
      {preview}
    </div>
    <div
      className="transition-all duration-300"
      style={{
        overflow: "hidden",
        maxHeight: isOpen ? 2000 : 0,
        opacity: isOpen ? 1 : 0,
        transition: "max-height 300ms ease-in-out, opacity 200ms ease-in-out",
      }}
    >
      <div
        style={{
          padding: "14px 14px 14px",
          borderTop: "1px solid rgba(255,255,255,0.05)",
          marginTop: 2,
        }}
      >
        {children}
      </div>
    </div>
  </div>
);

/* ━━━━━ SceneFlowSection — proportional timeline + always-on detail cards ━━━━━
 *
 * 설계 정책 (사용자 피드백 반영):
 * - 점선 타임라인은 균등이 아닌 각 세그먼트의 duration weight 비례로 분배.
 *   짧은 비트는 좁게, 긴 비트는 넓게 배치되어 실제 시간 분포를 한눈에 파악.
 * - 별도의 Gantt 바는 제거 (정보 중복).
 * - 상세 토글 제거 → HOOK/BODY/CTA 카드는 항상 펼쳐진 상태. 그 대신 타임라인과
 *   분리되도록 위쪽에 가는 divider + 약간의 vertical padding.
 * - 카드 듀레이션 표기는 range ("13-19s") 가 아닌 "길이만" ("6s"). 한 카드를
 *   편집해도 다른 카드 길이는 그대로 유지되고, 총 듀레이션만 자동 증감.
 *   storage 는 호환성 위해 여전히 range 로 저장 — 편집 시 `rebuildSequentialRanges`
 *   가 0 부터 순차적으로 다시 깐다.
 */
type SceneFlowVariant = "main" | "slide";

const SCENE_HINT_PATH = ["production_notes", "scene_count_hint"];
const BEATS_PATH = ["production_notes", "scene_count_hint", "body_beats"];

const lengthLabel = (durationStr: string | undefined): string => {
  const p = parseDurationRange(durationStr);
  if (!p.weight) return "";
  const fmt = Number.isInteger(p.weight) ? String(p.weight) : p.weight.toFixed(1);
  return `${fmt}${p.unit}`;
};

/**
 * 드래그/삭제 가능한 Body beat 카드.
 * 핸들/삭제 버튼은 동일한 라벨 행에 배치하며, 드래그 listener 는 핸들 span
 * 에만 붙어서 라벨/설명 클릭 편집과 충돌하지 않는다.
 */
const SortableBeatCard = ({
  id,
  beat,
  index,
  variant,
  onUpdate,
  onDelete,
  onLengthChange,
}: {
  id: string;
  beat: SceneFlowBeat;
  index: number;
  variant: SceneFlowVariant;
  onUpdate?: OnFieldUpdate;
  onDelete?: () => void;
  onLengthChange?: (newLen: number) => void;
}) => {
  const t = useT();
  const isSlide = variant === "slide";
  const cardPadding = isSlide ? "px-4 py-4" : "px-3 py-3";
  const labelTextSize = isSlide ? "text-body" : "text-meta";
  const durationTextSize = isSlide ? "text-meta" : "text-caption";
  const descriptionTextSize = isSlide ? "text-body leading-[1.6]" : "text-body leading-[1.5]";

  const noLayoutAnimation: AnimateLayoutChanges = () => false;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    animateLayoutChanges: noLayoutAnimation,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? transition : undefined,
    opacity: isDragging ? 0.6 : 1,
    borderRadius: 0,
    background: isDragging ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.04)",
    border: isDragging ? "1px solid rgba(249,66,58,0.4)" : "1px solid transparent",
  };

  const lengthStr = lengthLabel(beat.duration);

  return (
    <div ref={setNodeRef} style={style} className={`${cardPadding} relative group`}>
      <div className={`flex items-center gap-1.5 ${isSlide ? "mb-2" : "mb-1.5"}`}>
        {onUpdate && (
          <span
            {...attributes}
            {...listeners}
            className="cursor-grab active:cursor-grabbing opacity-30 group-hover:opacity-70 hover:!opacity-100 transition-opacity shrink-0"
          >
            <GripVertical className="w-3 h-3" style={{ color: "rgba(255,255,255,0.6)" }} />
          </span>
        )}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {onUpdate ? (
            <EditableText
              value={beat.label}
              onSave={(v) => onUpdate([...BEATS_PATH, String(index), "label"], v)}
              className={`font-mono ${labelTextSize} font-semibold uppercase truncate`}
              style={{ color: "rgba(255,255,255,0.7)" }}
            />
          ) : (
            <span
              className={`font-mono ${labelTextSize} font-semibold uppercase truncate`}
              style={{ color: "rgba(255,255,255,0.7)" }}
              title={beat.label}
            >
              {beat.label}
            </span>
          )}
          {/* 길이만 표시. 사용자 편집은 별도 onLengthChange 로 위임 — 다른
              카드의 시간을 건드리지 않고 총 듀레이션만 늘어난다. */}
          {onUpdate && onLengthChange ? (
            <EditableText
              value={lengthStr}
              onSave={(v) => {
                const n = parseLengthInput(v);
                if (n !== null) onLengthChange(n);
              }}
              className={durationTextSize}
              style={{ color: "#666" }}
            />
          ) : (
            <span className={durationTextSize} style={{ color: "#666" }}>{lengthStr}</span>
          )}
        </div>
        {onUpdate && onDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="opacity-0 group-hover:opacity-50 hover:!opacity-100 transition-opacity shrink-0"
            title={t("common.delete")}
          >
            <X className="w-3 h-3" style={{ color: "rgba(255,255,255,0.7)" }} />
          </button>
        )}
      </div>
      {onUpdate ? (
        <EditableText
          value={beat.description}
          onSave={(v) => onUpdate([...BEATS_PATH, String(index), "description"], v)}
          multiline
          className={descriptionTextSize}
          style={{ color: "#aaa" }}
        />
      ) : (
        <p className={descriptionTextSize} style={{ color: "#aaa", whiteSpace: "pre-wrap" }}>{beat.description}</p>
      )}
    </div>
  );
};

const SceneFlowSection = ({
  flow,
  lang,
  onUpdate,
  variant,
}: {
  flow: SceneFlowStructured;
  lang: Lang;
  onUpdate?: OnFieldUpdate;
  variant: SceneFlowVariant;
}) => {
  const beats = getBodyBeats(flow);
  /* ── 씬 수 (실시간) ──
   * HOOK + body_beats + CTA = 지금 화면에 보이는 segment 의 갯수.
   * 사용자가 비트를 추가/삭제하면 즉시 반응한다. LLM 이 적어둔
   * `total_sequences` 정적 문자열은 반영하지 않고 무조건 직접 계산. */
  const liveSceneCount = beats.length + 2;
  const sceneLabel = lang === "ko" ? `${liveSceneCount}개 씬` : `${liveSceneCount} scenes`;

  /* ── 권장 컷 수 (다음 단계 ContiTab/AgentTab 용 hint) ──
   * scene_count_hint.total_shots 는 LLM 이 영상 포맷(=duration) 기반으로 한 번
   * 적어두는 *권장값* 이며, 이 화면에서 편집하는 body_beats 와는 다른 단위다.
   * (sequence vs shot 분리 — directorKnowledgeBase.ts 의 페이싱 표 참고)
   * 사용자가 "지금의 카운트" 로 오해하지 않도록 "권장 " 을 prefix 로 붙여 명시.
   * legacy 분석 결과(`total_scenes` 가 "X개 씬 / Y개 컷" 같은 단일 문자열) 호환을
   * 위해, total_shots 가 비어있으면 total_scenes 에서 컷 부분만 추출한다. */
  const shotsHint =
    flow.total_shots ||
    ((flow.total_scenes || "").match(/\d+(?:[-~]\d+)?\s*(?:개\s*컷|shots?)/i)?.[0] ?? "");
  const shotsLabel = shotsHint
    ? lang === "ko"
      ? `권장 ${shotsHint}`
      : `Recommended ${shotsHint}`
    : "";

  const isSlide = variant === "slide";
  const maxCols = isSlide ? 5 : 4;
  const minmaxPx = isSlide ? 240 : 220;
  const cardPadding = isSlide ? "px-4 py-4" : "px-3 py-3";
  const cardGap = isSlide ? "gap-3" : "gap-2";
  const labelTextSize = isSlide ? "text-body" : "text-meta";
  const durationTextSize = isSlide ? "text-meta" : "text-caption";
  const descriptionTextSize = isSlide ? "text-body leading-[1.6]" : "text-body leading-[1.5]";
  const containerSpacing = isSlide ? "space-y-3" : "space-y-2";

  const beatCols = getBalancedCols(Math.max(1, beats.length), maxCols);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  /* ── 가중치 계산 (proportional timeline 용) ──
   * weight 0 인 segment 는 평균값으로 보정해서 한 칸 정도 자리를 잡도록 한다.
   */
  const hookWeightRaw = parseDurationRange(flow.hook?.duration).weight;
  const ctaWeightRaw = parseDurationRange(flow.cta?.duration).weight;
  const beatWeightsRaw = beats.map((b) => parseDurationRange(b.duration).weight);
  const allRaw = [hookWeightRaw, ...beatWeightsRaw, ctaWeightRaw];
  const nonZero = allRaw.filter((w) => w > 0);
  const fallback = nonZero.length ? nonZero.reduce((a, b) => a + b, 0) / nonZero.length : 1;
  const safe = (w: number) => (w > 0 ? w : fallback);
  const segmentWeights: { id: string; label: string; weight: number; isAccent: boolean }[] = [
    { id: "hook", label: "Hook", weight: safe(hookWeightRaw), isAccent: true },
    ...beats.map((b, i) => ({
      id: `beat-${i}`,
      label: b.label || (lang === "ko" ? `구간 ${i + 1}` : `Step ${i + 1}`),
      weight: safe(beatWeightsRaw[i]),
      isAccent: false,
    })),
    { id: "cta", label: "CTA", weight: safe(ctaWeightRaw), isAccent: true },
  ];

  /* ── 총 듀레이션 (자동 업데이트) ──
   * Raw weight 의 합. duration 미입력 segment 가 있으면 그만큼 빠진 수치만
   * 표시 (절대 fabricate 하지 않음). 모두 0 이면 라벨 자체를 숨김. */
  const totalSec =
    hookWeightRaw +
    beatWeightsRaw.reduce((a, b) => a + b, 0) +
    ctaWeightRaw;
  const unit: DurationUnit =
    parseDurationRange(flow.hook?.duration).unit === "초" ||
    parseDurationRange(flow.cta?.duration).unit === "초"
      ? "초"
      : "s";
  const totalLabel =
    Number.isInteger(totalSec) ? `${Math.round(totalSec)}${unit}` : `${totalSec.toFixed(1)}${unit}`;

  /* ── 변경 핸들러 ──
   * 모든 변경은 `rebuildSequentialRanges` 로 0 부터 순차적으로 range 를 재구축.
   * Storage 의 일관성 보장 + React state 의 stale-closure 문제(같은 이벤트
   * 핸들러 내에서 onUpdate 를 여러 번 호출하면 마지막 호출만 살아남음) 회피를
   * 위해 scene_count_hint 객체 자체를 단일 onUpdate 로 갱신한다.
   */
  const writeAll = (next: ReturnType<typeof rebuildSequentialRanges>) => {
    if (!onUpdate) return;
    const nextFlow: SceneFlowStructured = {
      ...flow,
      hook: { ...(flow.hook ?? { duration: "", description: "" }), duration: next.hook },
      cta: { ...(flow.cta ?? { duration: "", description: "" }), duration: next.cta },
      body_beats: next.beats,
      // body 는 deprecated 이지만 만약 들어있다면 유지 (legacy 분석 결과 호환)
    };
    onUpdate(SCENE_HINT_PATH, nextFlow as any);
  };

  const handleBeatLengthChange = (idx: number, newLen: number) => {
    const beatLengths = beats.map((b) => parseDurationRange(b.duration).weight);
    beatLengths[idx] = newLen;
    writeAll(rebuildSequentialRanges(flow, beats, { beatLengths }));
  };

  const handleHookLengthChange = (newLen: number) => {
    writeAll(rebuildSequentialRanges(flow, beats, { hookLen: newLen }));
  };

  const handleCtaLengthChange = (newLen: number) => {
    writeAll(rebuildSequentialRanges(flow, beats, { ctaLen: newLen }));
  };

  const handleDragEnd = (event: any) => {
    const { active, over } = event;
    if (!active || !over || active.id === over.id) return;
    const oldIndex = parseInt(String(active.id).replace("beat-", ""));
    const newIndex = parseInt(String(over.id).replace("beat-", ""));
    if (Number.isNaN(oldIndex) || Number.isNaN(newIndex)) return;
    const reordered = arrayMove(beats, oldIndex, newIndex);
    writeAll(rebuildSequentialRanges(flow, reordered));
  };

  const handleDelete = (idx: number) => {
    const next = beats.filter((_, i) => i !== idx);
    writeAll(rebuildSequentialRanges(flow, next));
  };

  const handleAdd = () => {
    const labelDefault = lang === "ko" ? "새 구간" : "New step";
    const descDefault = lang === "ko" ? "구간 설명을 입력하세요." : "Describe this step.";
    const next = [...beats, { label: labelDefault, duration: "", description: descDefault }];
    writeAll(rebuildSequentialRanges(flow, next));
  };

  return (
    <div className="space-y-3">
      {/* ── 1. 비례 점선 타임라인 ──
        flex weight = 각 세그먼트의 duration. 짧은 비트는 좁게, 긴 비트는 넓게.
        - dot 은 각 segment 의 시작점(=좌측 가장자리)에 위치 → 타임라인의
          "이 시점부터 이 구간이 시작" 이라는 의미가 직관적으로 전달.
        - 라벨은 dot 아래 좌측 정렬, `whiteSpace: nowrap` + truncate 제거 →
          segment 가 좁아도 잘리지 않고 옆 segment 영역까지 자연스럽게 흘러간다
          (라벨은 짧은 한국어 키워드라 충돌 가능성 낮음).
        - 가로 라인은 컨테이너 전체에 깔고 dot 의 background-colored border 로
          끊긴 것처럼 보이게 처리.
      */}
      <div className="relative" style={{ paddingTop: 2 }}>
        <div className="absolute top-[8px] left-0 right-0 h-px" style={{ background: "rgba(255,255,255,0.12)" }} />
        <div className="flex">
          {segmentWeights.map((seg) => (
            <div
              key={seg.id}
              className="relative"
              style={{ flex: `${seg.weight} 1 0%`, minWidth: 44 }}
            >
              <div className="flex flex-col items-start gap-1.5 relative z-10">
                <div
                  className="w-3 h-3 border-2 border-background"
                  style={{ borderRadius: 0, background: seg.isAccent ? KR : "rgba(255,255,255,0.25)" }}
                />
                <span
                  className={`font-mono ${isSlide ? "text-caption" : "text-2xs"} font-bold uppercase`}
                  style={{
                    color: seg.isAccent ? KR : "rgba(255,255,255,0.5)",
                    whiteSpace: "nowrap",
                  }}
                  title={seg.label}
                >
                  {seg.label}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── 2. 요약 + 총 듀레이션 라인 ── 둘 다 좌측 정렬, " · " 구분자로 묶음. */}
      <div className={`flex items-center gap-2 pt-1 font-mono ${isSlide ? "text-caption" : "text-2xs"}`}>
        {totalSec > 0 && (
          <span style={{ color: "rgba(255,255,255,0.55)" }}>
            {lang === "ko" ? "총 " : "Total "}
            <span style={{ color: KR, fontWeight: 600 }}>{totalLabel}</span>
          </span>
        )}
        {totalSec > 0 && <span style={{ color: "rgba(255,255,255,0.25)" }}>·</span>}
        <span style={{ color: "rgba(255,255,255,0.42)" }}>{sceneLabel}</span>
        {shotsLabel && <span style={{ color: "rgba(255,255,255,0.25)" }}>·</span>}
        {shotsLabel && (
          <span style={{ color: "rgba(255,255,255,0.42)" }}>{shotsLabel}</span>
        )}
      </div>

      {/* ── 3. 디테일 카드 영역 ── 항상 펼침. 위쪽 divider + 충분한 vertical
          padding 으로 타임라인 영역과 명확히 분리. mt/pt 모두 넉넉히 줘서
          "여기서 다른 영역이 시작" 임이 한눈에 들어오게 한다. */}
      <div
        className={`${containerSpacing} pt-5 mt-5`}
        style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}
      >
        {/* HOOK */}
        <div
          className={cardPadding}
          style={{ borderRadius: 0, background: "rgba(249,66,58,0.06)", borderLeft: "2px solid #f9423a" }}
        >
          <div className={`flex items-center gap-2 ${isSlide ? "mb-2" : "mb-1.5"}`}>
            <span className={`font-mono ${labelTextSize} font-semibold`} style={{ color: KR }}>HOOK</span>
            {onUpdate ? (
              <EditableText
                value={lengthLabel(flow.hook?.duration)}
                onSave={(v) => {
                  const n = parseLengthInput(v);
                  if (n !== null) handleHookLengthChange(n);
                }}
                className={durationTextSize}
                style={{ color: "#666" }}
              />
            ) : (
              <span className={durationTextSize} style={{ color: "#666" }}>{lengthLabel(flow.hook?.duration)}</span>
            )}
          </div>
          {onUpdate ? (
            <EditableText
              value={flow.hook?.description ?? ""}
              onSave={(v) => onUpdate(["production_notes", "scene_count_hint", "hook", "description"], v)}
              multiline
              className={descriptionTextSize}
              style={{ color: "#aaa" }}
            />
          ) : (
            <p className={descriptionTextSize} style={{ color: "#aaa", whiteSpace: "pre-wrap" }}>{flow.hook?.description ?? ""}</p>
          )}
        </div>

        {/* BODY */}
        {(beats.length > 0 || onUpdate) && (
          <div
            className={cardPadding}
            style={{ borderRadius: 0, background: "rgba(255,255,255,0.02)", borderLeft: "2px solid rgba(255,255,255,0.2)" }}
          >
            <div className={`flex items-center gap-2 ${isSlide ? "mb-3" : "mb-2"}`}>
              <span className={`font-mono ${labelTextSize} font-semibold`} style={{ color: "rgba(255,255,255,0.55)" }}>BODY</span>
              <span className={durationTextSize} style={{ color: "#666" }}>
                {lang === "ko" ? `${beats.length}개 구간` : `${beats.length} steps`}
              </span>
            </div>

            {onUpdate ? (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext
                  items={beats.map((_, i) => `beat-${i}`)}
                  strategy={rectSortingStrategy}
                >
                  <div
                    className={`grid ${cardGap}`}
                    style={{ gridTemplateColumns: `repeat(${beatCols}, minmax(${minmaxPx}px, 1fr))` }}
                  >
                    {beats.map((beat, idx) => (
                      <SortableBeatCard
                        key={`beat-${idx}`}
                        id={`beat-${idx}`}
                        beat={beat}
                        index={idx}
                        variant={variant}
                        onUpdate={onUpdate}
                        onDelete={() => handleDelete(idx)}
                        onLengthChange={(n) => handleBeatLengthChange(idx, n)}
                      />
                    ))}
                    <button
                      type="button"
                      onClick={handleAdd}
                      className={`${cardPadding} flex flex-col items-center justify-center gap-1.5 transition-colors hover:bg-white/5 group`}
                      style={{
                        borderRadius: 0,
                        background: "transparent",
                        border: "1px dashed rgba(255,255,255,0.18)",
                        minHeight: isSlide ? 100 : 80,
                      }}
                      title={lang === "ko" ? "추가" : "Add"}
                    >
                      <Plus className="w-4 h-4 opacity-50 group-hover:opacity-90 transition-opacity" style={{ color: "rgba(255,255,255,0.7)" }} />
                      <span className={`font-mono ${durationTextSize} uppercase tracking-wider opacity-50 group-hover:opacity-90 transition-opacity`} style={{ color: "rgba(255,255,255,0.7)" }}>
                        {lang === "ko" ? "추가" : "Add"}
                      </span>
                    </button>
                  </div>
                </SortableContext>
              </DndContext>
            ) : (
              <div
                className={`grid ${cardGap}`}
                style={{ gridTemplateColumns: `repeat(${beatCols}, minmax(${minmaxPx}px, 1fr))` }}
              >
                {beats.map((beat, idx) => (
                  <div
                    key={`beat-ro-${idx}`}
                    className={cardPadding}
                    style={{ borderRadius: 0, background: "rgba(255,255,255,0.04)" }}
                  >
                    <div className={`flex items-center gap-2 ${isSlide ? "mb-2" : "mb-1.5"}`}>
                      <span
                        className={`font-mono ${labelTextSize} font-semibold uppercase truncate`}
                        style={{ color: "rgba(255,255,255,0.7)" }}
                        title={beat.label}
                      >
                        {beat.label}
                      </span>
                      <span className={durationTextSize} style={{ color: "#666" }}>{lengthLabel(beat.duration)}</span>
                    </div>
                    <p className={descriptionTextSize} style={{ color: "#aaa", whiteSpace: "pre-wrap" }}>{beat.description}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* CTA */}
        <div
          className={cardPadding}
          style={{ borderRadius: 0, background: "rgba(249,66,58,0.06)", borderLeft: "2px solid #f9423a" }}
        >
          <div className={`flex items-center gap-2 ${isSlide ? "mb-2" : "mb-1.5"}`}>
            <span className={`font-mono ${labelTextSize} font-semibold`} style={{ color: KR }}>CTA</span>
            {onUpdate ? (
              <EditableText
                value={lengthLabel(flow.cta?.duration)}
                onSave={(v) => {
                  const n = parseLengthInput(v);
                  if (n !== null) handleCtaLengthChange(n);
                }}
                className={durationTextSize}
                style={{ color: "#666" }}
              />
            ) : (
              <span className={durationTextSize} style={{ color: "#666" }}>{lengthLabel(flow.cta?.duration)}</span>
            )}
          </div>
          {onUpdate ? (
            <EditableText
              value={flow.cta?.description ?? ""}
              onSave={(v) => onUpdate(["production_notes", "scene_count_hint", "cta", "description"], v)}
              multiline
              className={descriptionTextSize}
              style={{ color: "#aaa" }}
            />
          ) : (
            <p className={descriptionTextSize} style={{ color: "#aaa", whiteSpace: "pre-wrap" }}>{flow.cta?.description ?? ""}</p>
          )}
        </div>
      </div>
    </div>
  );
};

/* ━━━━━ CoreStrategyUI — center column ━━━━━ */
const CoreStrategyUI = ({
  analysis,
  lang = "ko",
  onUpdate,
}: {
  analysis: DeepAnalysis;
  lang?: Lang;
  onUpdate?: OnFieldUpdate;
}) => {
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());
  const toggleSection = (key: string) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const isStrategyOpen = openSections.has("strategy");
  const isDirectionOpen = openSections.has("direction");
  const isAbcdOpen = openSections.has("abcd");

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleUspDragEnd = (event: any) => {
    const { active, over } = event;
    if (!active || !over || active.id === over.id || !onUpdate) return;
    const items = analysis.usp.items;
    if (!items.length || typeof items[0] !== "object") return;
    const oldIndex = parseInt((active.id as string).replace("usp-", ""));
    const newIndex = parseInt((over.id as string).replace("usp-", ""));
    const reordered = arrayMove(items as UspItem[], oldIndex, newIndex);
    onUpdate(["usp", "items"], reordered as any);
  };

  const directionPreview =
    lang === "ko" ? "비주얼 방향 · 레퍼런스 무드 · 씬 흐름" : "Visual Direction · Reference Mood · Scene Flow";

  const strategyPreview =
    lang === "ko" ? "캠페인 목표 · 타겟 · USP · 메모 분석" : "Campaign Goal · Target · USP · Memo Analysis";

  const abcdPreview = t("abcd_preview_plan", lang);
  const abcdTitle = t("abcd_design_checklist", lang);

  const E = (
    path: string[],
    value: string,
    opts?: { multiline?: boolean; className?: string; style?: React.CSSProperties },
  ) => {
    if (!onUpdate) {
      return (
        <span className={opts?.className} style={opts?.style}>
          {value}
        </span>
      );
    }
    return (
      <EditableText
        value={value}
        onSave={(v) => onUpdate(path, v)}
        multiline={opts?.multiline}
        className={opts?.className || ""}
        style={opts?.style}
      />
    );
  };

  const EditableBulletList = ({
    items,
    basePath,
    dot = "red",
  }: {
    items: string[];
    basePath: string[];
    dot?: "red" | "black";
  }) => (
    <ul className="space-y-1.5">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-2 text-body leading-relaxed text-muted-foreground">
          <span
            className={`w-1 h-1 rounded-full shrink-0 mt-[7px] ${dot === "red" ? "bg-primary" : "bg-foreground"}`}
          />
          {onUpdate ? (
            <EditableText
              value={item}
              onSave={(v) => onUpdate([...basePath, String(i)], v)}
              className="flex-1 text-body leading-relaxed text-muted-foreground"
            />
          ) : (
            item
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <div>
      <div className="px-1 mb-6">
        {analysis.content_type && CONTENT_TYPE_LABEL[analysis.content_type] && (
          <div className="mb-2">
            <span
              className="inline-block text-2xs font-bold uppercase tracking-wider px-2 py-0.5"
              title={analysis.classification_reasoning ?? ""}
              style={{
                borderRadius: 0,
                background: `${CONTENT_TYPE_LABEL[analysis.content_type].color}15`,
                color: CONTENT_TYPE_LABEL[analysis.content_type].color,
                border: `1px solid ${CONTENT_TYPE_LABEL[analysis.content_type].color}40`,
              }}
            >
              {CONTENT_TYPE_LABEL[analysis.content_type][lang]}
              {typeof analysis.classification_confidence === "number" &&
                ` · ${Math.round(analysis.classification_confidence * 100)}%`}
            </span>
          </div>
        )}
        {E(["goal", "summary"], analysis.goal.summary, {
          className: "text-hero font-bold text-foreground leading-tight tracking-tight",
        })}
        <div className="mt-2">
          {E(["usp", "summary"], analysis.usp.summary, {
            className: "text-body text-muted-foreground leading-relaxed",
          })}
        </div>
      </div>

      <AccordionCard
        index={1}
        title={t("core_strategy", lang)}
        preview={strategyPreview}
        isOpen={isStrategyOpen}
        onToggle={() => toggleSection("strategy")}
      >
        <div className="grid gap-4 items-stretch" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <SectionCard className="w-full flex flex-col">
            <SectionHeader dot="red" label={t("campaign_goal", lang)} tag="GOAL" />
            <div className="px-3 py-3 flex-1 space-y-2.5">
              <EditableBulletList items={analysis.goal.items} basePath={["goal", "items"]} dot="red" />
              {analysis.goal.core_message && (
                <div
                  className="rounded-none px-3 py-2.5"
                  style={{ background: "rgba(249,66,58,0.06)", border: "1px solid rgba(249,66,58,0.15)" }}
                >
                  <span className="text-caption font-medium inline-flex items-center gap-1.5" style={{ color: "#888" }}>
                    <MessageSquare className="w-3 h-3" /> {t("core_message", lang)}
                  </span>
                  <div className="mt-1">
                    {E(["goal", "core_message"], analysis.goal.core_message, {
                      className: "text-body text-foreground/90 font-medium leading-relaxed",
                    })}
                  </div>
                </div>
              )}
              {analysis.goal.success_criteria && (
                <div
                  className="rounded-none px-3 py-2.5"
                  style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
                >
                  <span className="text-caption font-medium inline-flex items-center gap-1.5" style={{ color: "#888" }}>
                    <Target className="w-3 h-3" /> {t("success_criteria", lang)}
                  </span>
                  <div className="mt-1">
                    {E(["goal", "success_criteria"], analysis.goal.success_criteria, {
                      multiline: true,
                      className: "text-body text-foreground/80 leading-relaxed",
                    })}
                  </div>
                </div>
              )}
              {analysis.goal.desired_action && (
                <div
                  className="rounded-none px-3 py-2.5"
                  style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
                >
                  <span className="text-caption font-medium" style={{ color: "#888" }}>
                    ▶ {t("desired_action", lang)}
                  </span>
                  <div className="mt-1">
                    {E(["goal", "desired_action"], analysis.goal.desired_action, {
                      className: "text-body text-foreground/80 leading-relaxed",
                    })}
                  </div>
                </div>
              )}
            </div>
          </SectionCard>

          <SectionCard className="w-full flex flex-col">
            <SectionHeader dot="black" label={t("target", lang)} tag="TARGET" />
            <div className="px-3 py-3 space-y-2 flex-1">
              {E(["target", "summary"], analysis.target.summary, {
                className: "text-body font-medium text-muted-foreground",
              })}
              <EditableBulletList items={analysis.target.primary} basePath={["target", "primary"]} dot="black" />
              <div className="bg-background/80 border border-border px-3 py-2.5" style={{ borderRadius: 0 }}>
                <Label3>{t("psychological_insight", lang)}</Label3>
                {E(["target", "insight"], analysis.target.insight, {
                  multiline: true,
                  className: "text-body leading-relaxed text-foreground/80",
                })}
              </div>
              <div className="bg-background/80 border border-border px-3 py-2.5" style={{ borderRadius: 0 }}>
                <Label3>{t("media_behavior", lang)}</Label3>
                {E(["target", "media_behavior"], analysis.target.media_behavior, {
                  multiline: true,
                  className: "text-body leading-relaxed text-foreground/80",
                })}
              </div>
            </div>
          </SectionCard>
        </div>

        <div className="border-t mt-5 pt-4" style={{ borderColor: "rgba(255,255,255,0.04)" }}>
          <SectionCard className="w-full">
            <SectionHeader dot="red" label={t("usp", lang)} tag="USP" />
            <div className="px-3 py-3 space-y-1.5" style={{ gap: 6 }}>
              {(() => {
                const items = analysis.usp.items;
                const isStructured = items.length > 0 && typeof items[0] === "object";
                if (isStructured && onUpdate) {
                  return (
                    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleUspDragEnd}>
                      <SortableContext
                        items={(items as UspItem[]).map((_, i) => `usp-${i}`)}
                        strategy={verticalListSortingStrategy}
                      >
                        <div className="flex flex-col" style={{ gap: 6 }}>
                          {(items as UspItem[]).map((item, i) => (
                            <SortableUspCard
                              key={`usp-${i}`}
                              item={item}
                              index={i}
                              onUpdate={onUpdate}
                              basePath={["usp", "items"]}
                            />
                          ))}
                        </div>
                      </SortableContext>
                    </DndContext>
                  );
                }
                if (isStructured) {
                  return (
                    <div className="flex flex-col" style={{ gap: 6 }}>
                      {(items as UspItem[]).map((item, i) => (
                        <div
                          key={i}
                          className="px-3 py-2"
                          style={{
                            borderRadius: 0,
                            ...(i === 0
                              ? { background: "rgba(249,66,58,0.08)", border: "1px solid rgba(249,66,58,0.2)" }
                              : { background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }),
                          }}
                        >
                          <div className="flex items-start gap-2.5">
                            <span
                              className="w-5 h-5 flex items-center justify-center text-2xs font-bold shrink-0 mt-px"
                              style={{
                                borderRadius: 0,
                                background:
                                  i === 0 ? KR : i === 1 ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.08)",
                                color: i === 0 ? "#fff" : "rgba(255,255,255,0.5)",
                              }}
                            >
                              {i + 1}
                            </span>
                            <div className="flex-1 min-w-0">
                              <span
                                className="text-body leading-relaxed font-semibold"
                                style={{ color: i === 0 ? "#f0f0f0" : "rgba(255,255,255,0.6)" }}
                              >
                                {item.keyword}
                              </span>
                              {item.comparison && (
                                <p className="text-body leading-[1.5] mt-1" style={{ color: "#888" }}>
                                  {item.comparison}
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                }
                return <BulletList items={items as string[]} dot="red" />;
              })()}
              {analysis.usp.competitive_edge && (
                <div className="pt-1">
                  <div className="bg-background/80 border border-border px-3 py-2.5" style={{ borderRadius: 0 }}>
                    <Label3>{t("competitive_edge", lang)}</Label3>
                    {E(["usp", "competitive_edge"], analysis.usp.competitive_edge, {
                      className: "text-body leading-relaxed text-foreground/80",
                    })}
                  </div>
                </div>
              )}
            </div>
          </SectionCard>
        </div>

        {analysis.creative_gap && (
          <div className="border-t mt-5 pt-4" style={{ borderColor: "rgba(255,255,255,0.04)" }}>
            <CreativeGapSection gap={analysis.creative_gap} lang={lang} onUpdate={onUpdate} />
          </div>
        )}
      </AccordionCard>

      <AccordionCard
        index={2}
        title={lang === "ko" ? "연출 가이드" : "Direction Guide"}
        preview={directionPreview}
        isOpen={isDirectionOpen}
        onToggle={() => toggleSection("direction")}
      >
        {/*
          ── 연출 가이드 시각 정리 ──
          하위 4 섹션 (Visual / Mood / KeyVis / Flow) 사이 구분이 약해 정보가
          한덩어리로 보이던 문제를 해결. 첫 섹션 외에는 위쪽에 divider 와
          큰 vertical gap (mt-14 pt-10 ≈ 96px) 을 두어 "여긴 새 섹션" 이라는
          신호를 한 눈에 알아볼 수 있게 함. divider 색상도 0.06 → 0.1 로
          살짝 올려 가독성 보강.
        */}
        <section>
          <Heading2>{t("visual_direction", lang)}</Heading2>
          {typeof analysis.tone_manner.visual_direction === "string" ? (
            <SubCard label={t("visual_direction", lang)} value={analysis.tone_manner.visual_direction} />
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {(
                [
                  { Icon: Camera, label: lang === "ko" ? "카메라" : "Camera", key: "camera" as const },
                  { Icon: Lightbulb, label: lang === "ko" ? "조명" : "Lighting", key: "lighting" as const },
                  { Icon: SlidersHorizontal, label: lang === "ko" ? "색감" : "Color", key: "color_grade" as const },
                  { Icon: Scissors, label: lang === "ko" ? "편집" : "Editing", key: "editing" as const },
                ] as const
              ).map(({ Icon, label: cellLabel, key }) => (
                <div key={key} className="px-3 py-3" style={{ borderRadius: 0, background: "rgba(255,255,255,0.03)" }}>
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <Icon className="w-3 h-3 text-foreground/60" />
                    <span className="text-2xs font-bold uppercase tracking-wider text-foreground/60">{cellLabel}</span>
                  </div>
                  {E(
                    ["tone_manner", "visual_direction", key],
                    (analysis.tone_manner.visual_direction as VisualDirectionStructured)[key],
                    {
                      multiline: true,
                      className: "text-body text-foreground/70 leading-relaxed",
                    },
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {analysis.tone_manner.reference_mood && (
          <section className="mt-14 pt-10 border-t" style={{ borderColor: "rgba(255,255,255,0.1)" }}>
            <Heading2>{t("reference_mood", lang)}</Heading2>
            <div
              className="px-3 py-2.5"
              style={{
                borderRadius: 0,
                background: "rgba(255,255,255,0.02)",
                borderLeft: "2px solid rgba(255,255,255,0.18)",
              }}
            >
              {E(["tone_manner", "reference_mood"], analysis.tone_manner.reference_mood, {
                multiline: true,
                className: "text-body leading-relaxed text-foreground/80",
              })}
            </div>
          </section>
        )}

        {analysis.key_visual_criteria && (
          <section className="mt-14 pt-10 border-t" style={{ borderColor: "rgba(255,255,255,0.1)" }}>
            <Heading2>{lang === "ko" ? "키비주얼 기준" : "Key Visual Criteria"}</Heading2>
            <div className="space-y-3">
              <div
                className="px-3 py-2.5"
                style={{ borderRadius: 0, background: "rgba(249,66,58,0.06)", border: "1px solid rgba(249,66,58,0.16)" }}
              >
                <Label3>{lang === "ko" ? "정의" : "Definition"}</Label3>
                {E(["key_visual_criteria", "definition"], analysis.key_visual_criteria.definition, {
                  multiline: true,
                  className: "text-body leading-relaxed text-foreground/85",
                })}
              </div>
              <div className="grid grid-cols-2 gap-3">
                {[
                  {
                    label: lang === "ko" ? "선정 기준" : "Selection Rules",
                    values: analysis.key_visual_criteria.selection_rules ?? [],
                    path: ["key_visual_criteria", "selection_rules"],
                  },
                  {
                    label: lang === "ko" ? "시각 우선순위" : "Visual Priorities",
                    values: analysis.key_visual_criteria.visual_priorities ?? [],
                    path: ["key_visual_criteria", "visual_priorities"],
                  },
                  {
                    label: lang === "ko" ? "피해야 할 패턴" : "Avoid Patterns",
                    values: analysis.key_visual_criteria.avoid_patterns ?? [],
                    path: ["key_visual_criteria", "avoid_patterns"],
                  },
                  {
                    label: lang === "ko" ? "근거" : "Evidence",
                    values: analysis.key_visual_criteria.evidence ?? [],
                    path: ["key_visual_criteria", "evidence"],
                  },
                ].map((section) => (
                  <div key={section.label} className="px-3 py-2.5" style={{ borderRadius: 0, background: "rgba(255,255,255,0.03)" }}>
                    <Label3>{section.label}</Label3>
                    <EditableBulletList items={section.values} basePath={section.path} dot="red" />
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        <section className="mt-14 pt-10 border-t" style={{ borderColor: "rgba(255,255,255,0.1)" }}>
          <Heading2>{t("scene_flow", lang)}</Heading2>
          <div className="bg-background/80 border border-border px-3 py-3" style={{ borderRadius: 0 }}>
          {typeof analysis.production_notes.scene_count_hint === "string" ? (
            <>
              <div className="flex items-start mb-3">
                {(["Hook", "Body", "CTA"] as const).map((step, i) => (
                  <div key={step} className="flex-1 relative">
                    {i < 2 && <div className="absolute top-[6px] left-1/2 w-full h-px bg-border" />}
                    <div className="flex flex-col items-center gap-1.5 relative z-10">
                      <div
                        className="w-3 h-3 border-2 border-background"
                        style={{ borderRadius: 0, background: i === 1 ? "rgba(255,255,255,0.2)" : KR }}
                      />
                      <span
                        className="font-mono text-2xs font-bold uppercase"
                        style={{ color: i === 1 ? "rgba(255,255,255,0.3)" : KR }}
                      >
                        {step}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-body text-muted-foreground leading-relaxed">
                {analysis.production_notes.scene_count_hint}
              </p>
            </>
          ) : (
            <SceneFlowSection
              flow={analysis.production_notes.scene_count_hint as SceneFlowStructured}
              lang={lang}
              onUpdate={onUpdate}
              variant="main"
            />
          )}
          </div>
        </section>
      </AccordionCard>

      <AccordionCard
        index={3}
        title={abcdTitle}
        preview={abcdPreview}
        isOpen={isAbcdOpen}
        onToggle={() => toggleSection("abcd")}
      >
        <AbcdSlideContent analysis={analysis} lang={lang} />
      </AccordionCard>
    </div>
  );
};

/* ━━━━━ SlideUspContent — USP with DnD for slide view ━━━━━ */
const SlideUspContent = ({
  analysis,
  lang,
  onUpdate,
}: {
  analysis: DeepAnalysis;
  lang: Lang;
  onUpdate?: OnFieldUpdate;
}) => {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const items = analysis.usp.items;
  const isStructured = items.length > 0 && typeof items[0] === "object";

  const handleDragEnd = (event: any) => {
    const { active, over } = event;
    if (!active || !over || active.id === over.id || !onUpdate) return;
    if (!isStructured) return;
    const oldIndex = parseInt((active.id as string).replace("usp-", ""));
    const newIndex = parseInt((over.id as string).replace("usp-", ""));
    const reordered = arrayMove(items as UspItem[], oldIndex, newIndex);
    onUpdate(["usp", "items"], reordered as any);
  };

  return (
    <div className="space-y-4">
      {isStructured && onUpdate ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext
            items={(items as UspItem[]).map((_, i) => `usp-${i}`)}
            strategy={verticalListSortingStrategy}
          >
            <div className="flex flex-col" style={{ gap: 6 }}>
              {(items as UspItem[]).map((item, i) => (
                <SortableUspCard
                  key={`usp-${i}`}
                  item={item}
                  index={i}
                  onUpdate={onUpdate}
                  basePath={["usp", "items"]}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      ) : isStructured ? (
        <div className="flex flex-col gap-3">
          {(items as UspItem[]).map((item, i) => (
            <div
              key={i}
              className="px-4 py-3"
              style={{
                borderRadius: 0,
                ...(i === 0
                  ? { background: "rgba(249,66,58,0.08)", border: "1px solid rgba(249,66,58,0.2)" }
                  : { background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }),
              }}
            >
              <div className="flex items-start gap-3">
                <span
                  className="w-6 h-6 flex items-center justify-center text-caption font-bold shrink-0"
                  style={{
                    borderRadius: 0,
                    background: i === 0 ? KR : "rgba(255,255,255,0.12)",
                    color: i === 0 ? "#fff" : "rgba(255,255,255,0.5)",
                  }}
                >
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                  <span className="text-body leading-snug font-semibold">{item.keyword}</span>
                  {item.comparison && (
                    <p className="text-meta leading-[1.6]" style={{ color: "#999" }}>
                      {item.comparison}
                    </p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <BulletList items={items as string[]} dot="red" />
      )}
      {analysis.usp.competitive_edge &&
        (onUpdate ? (
          <div className="bg-background/80 border border-border px-3 py-2.5" style={{ borderRadius: 0 }}>
            <Label3>{t("competitive_edge", lang)}</Label3>
            <EditableText
              value={analysis.usp.competitive_edge}
              onSave={(v) => onUpdate(["usp", "competitive_edge"], v)}
              className="text-body leading-relaxed text-foreground/80"
            />
          </div>
        ) : (
          <SubCard label={t("competitive_edge", lang)} value={analysis.usp.competitive_edge} />
        ))}
    </div>
  );
};

/* ━━━━━ SlideViewUI — 7-slide carousel for analysis ━━━━━ */
type SlideGroup = "core" | "direction" | "abcd";

interface SlideDefinition {
  title: string;
  badge: string;
  group: SlideGroup;
  render: (analysis: DeepAnalysis, lang: Lang, onUpdate?: OnFieldUpdate) => React.ReactNode;
  /** optional predicate — if present and returns false, slide is filtered out */
  show?: (analysis: DeepAnalysis) => boolean;
}

const SLIDE_GROUP_LABEL: Record<SlideGroup, { ko: string; en: string; color: string; bg: string }> = {
  core: { ko: "핵심 전략", en: "Core Strategy", color: KR, bg: "rgba(249,66,58,0.08)" },
  direction: { ko: "연출 가이드", en: "Direction Guide", color: "#888", bg: "rgba(255,255,255,0.04)" },
  abcd: { ko: "효과성 검증", en: "Effectiveness Check", color: "#10b981", bg: "rgba(16,185,129,0.10)" },
};

const SLIDE_DEFS: ((lang: Lang) => SlideDefinition)[] = [
  (lang) => ({
    title: t("campaign_goal", lang),
    badge: "GOAL",
    group: "core",
    render: (a, l, onU) => (
      <div className="space-y-4">
        <ul className="space-y-1.5">
          {a.goal.items.map((item, i) => (
            <li key={i} className="flex items-start gap-2 text-body leading-relaxed text-muted-foreground">
              <span className="w-1 h-1 rounded-full shrink-0 mt-[7px] bg-primary" />
              {onU ? (
                <EditableText
                  value={item}
                  onSave={(v) => onU(["goal", "items", String(i)], v)}
                  className="flex-1 text-body leading-relaxed text-muted-foreground"
                />
              ) : (
                item
              )}
            </li>
          ))}
        </ul>
        {a.goal.core_message && (
          <div
            className="rounded-none px-3 py-1.5"
            style={{ background: "rgba(249,66,58,0.06)", border: "1px solid rgba(249,66,58,0.15)" }}
          >
            <span className="text-caption font-medium inline-flex items-center gap-1.5" style={{ color: "#888" }}>
              <MessageSquare className="w-3 h-3" /> {t("core_message", l)}
            </span>
            <div className="mt-1">
              {onU ? (
                <EditableText
                  value={a.goal.core_message}
                  onSave={(v) => onU(["goal", "core_message"], v)}
                  className="text-body text-foreground/90 font-medium leading-relaxed"
                />
              ) : (
                <p className="text-body text-foreground/90 font-medium leading-relaxed">"{a.goal.core_message}"</p>
              )}
            </div>
          </div>
        )}
        {a.goal.success_criteria && (
          <div
            className="rounded-none px-3 py-1.5"
            style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
          >
            <span className="text-caption font-medium inline-flex items-center gap-1.5" style={{ color: "#888" }}>
              <Target className="w-3 h-3" /> {t("success_criteria", l)}
            </span>
            <div className="mt-1">
              {onU ? (
                <EditableText
                  value={a.goal.success_criteria}
                  onSave={(v) => onU(["goal", "success_criteria"], v)}
                  multiline
                  className="text-body text-foreground/80 leading-relaxed"
                />
              ) : (
                <div className="space-y-1">
                  {a.goal.success_criteria.split(/[,،、]\s*/).map((c: string, i: number) => (
                    <p key={i} className="text-body text-foreground/80 leading-relaxed">
                      {c.trim()}
                    </p>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        {a.goal.desired_action && (
          <div
            className="rounded-none px-3 py-1.5"
            style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
          >
            <span className="text-caption font-medium" style={{ color: "#888" }}>
              ▶ {t("desired_action", l)}
            </span>
            <div className="mt-1">
              {onU ? (
                <EditableText
                  value={a.goal.desired_action}
                  onSave={(v) => onU(["goal", "desired_action"], v)}
                  className="text-body text-foreground/80 leading-relaxed"
                />
              ) : (
                <p className="text-body text-foreground/80 leading-relaxed">{a.goal.desired_action}</p>
              )}
            </div>
          </div>
        )}
      </div>
    ),
  }),
  (lang) => ({
    title: t("target", lang),
    badge: "TARGET",
    group: "core",
    render: (a, l, onU) => (
      <div className="space-y-4">
        {onU ? (
          <EditableText
            value={a.target.summary}
            onSave={(v) => onU(["target", "summary"], v)}
            className="text-body text-muted-foreground leading-relaxed"
          />
        ) : (
          <p className="text-body text-muted-foreground leading-relaxed">{a.target.summary}</p>
        )}
        <ul className="space-y-1.5">
          {a.target.primary.map((item, i) => (
            <li key={i} className="flex items-start gap-2 text-body leading-relaxed text-muted-foreground">
              <span className="w-1 h-1 rounded-full shrink-0 mt-[7px] bg-foreground" />
              {onU ? (
                <EditableText
                  value={item}
                  onSave={(v) => onU(["target", "primary", String(i)], v)}
                  className="flex-1 text-body leading-relaxed text-muted-foreground"
                />
              ) : (
                item
              )}
            </li>
          ))}
        </ul>
        {onU ? (
          <>
            <div className="bg-background/80 border border-border px-3 py-2.5" style={{ borderRadius: 0 }}>
              <Label3>{t("psychological_insight", l)}</Label3>
              <EditableText
                value={a.target.insight}
                onSave={(v) => onU(["target", "insight"], v)}
                multiline
                className="text-body leading-relaxed text-foreground/80"
              />
            </div>
            <div className="bg-background/80 border border-border px-3 py-2.5" style={{ borderRadius: 0 }}>
              <Label3>{t("media_behavior", l)}</Label3>
              <EditableText
                value={a.target.media_behavior}
                onSave={(v) => onU(["target", "media_behavior"], v)}
                multiline
                className="text-body leading-relaxed text-foreground/80"
              />
            </div>
          </>
        ) : (
          <>
            <SubCard label={t("psychological_insight", l)} value={a.target.insight} />
            <SubCard label={t("media_behavior", l)} value={a.target.media_behavior} />
          </>
        )}
      </div>
    ),
  }),
  (lang) => ({
    title: t("usp", lang),
    badge: "USP",
    group: "core",
    render: (a, _l, onU) => <SlideUspContent analysis={a} lang={lang} onUpdate={onU} />,
  }),
  (lang) => ({
    title: t("brief_idea_analysis", lang),
    badge: "MEMO",
    group: "core",
    // 아이디어 메모가 없으면(creative_gap 미생성) 슬라이드 자체를 노출하지 않는다.
    show: (a) => !!a.creative_gap,
    render: (a, _l, onU) =>
      a.creative_gap ? (
        <div className="space-y-3">
          {a.creative_gap.synergy.map((s, i) => (
            <div key={i} className="flex items-start gap-2.5 text-body leading-relaxed text-emerald-400">
              <CheckCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              {onU ? (
                <EditableText
                  value={s}
                  onSave={(v) => onU(["creative_gap", "synergy", String(i)], v)}
                  className="flex-1 text-body leading-relaxed text-emerald-400"
                />
              ) : (
                s
              )}
            </div>
          ))}
          {a.creative_gap.gap.map((g, i) => (
            <div key={i} className="flex items-start gap-2.5 text-body leading-relaxed text-amber-400">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              {onU ? (
                <EditableText
                  value={g}
                  onSave={(v) => onU(["creative_gap", "gap", String(i)], v)}
                  className="flex-1 text-body leading-relaxed text-amber-400"
                />
              ) : (
                g
              )}
            </div>
          ))}
          {a.creative_gap.recommendation && (
            <div className="border-l-2 border-primary/40 pl-4 mt-3">
              {onU ? (
                <EditableText
                  value={a.creative_gap.recommendation}
                  onSave={(v) => onU(["creative_gap", "recommendation"], v)}
                  className="text-label text-muted-foreground leading-relaxed italic"
                />
              ) : (
                <p className="text-label text-muted-foreground leading-relaxed italic">
                  "{a.creative_gap.recommendation}"
                </p>
              )}
            </div>
          )}
        </div>
      ) : (
        <p className="text-body text-muted-foreground/50">
          {lang === "ko" ? "아이디어 메모가 없습니다" : "No idea memo provided"}
        </p>
      ),
  }),
  (lang) => ({
    title: t("visual_direction", lang),
    badge: "VISUAL",
    group: "direction",
    render: (a, l, onU) =>
      typeof a.tone_manner.visual_direction === "string" ? (
        onU ? (
          <EditableText
            value={a.tone_manner.visual_direction}
            onSave={(v) => onU(["tone_manner", "visual_direction"], v)}
            multiline
            className="text-label text-foreground/80 leading-relaxed"
          />
        ) : (
          <p className="text-label text-foreground/80 leading-relaxed">{a.tone_manner.visual_direction}</p>
        )
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {(
            [
              { Icon: Camera, label: l === "ko" ? "카메라" : "Camera", key: "camera" as const },
              { Icon: Lightbulb, label: l === "ko" ? "조명" : "Lighting", key: "lighting" as const },
              { Icon: SlidersHorizontal, label: l === "ko" ? "색감" : "Color", key: "color_grade" as const },
              { Icon: Scissors, label: l === "ko" ? "편집" : "Editing", key: "editing" as const },
            ] as const
          ).map(({ Icon, label: cellLabel, key }) => (
            <div key={key} className="px-4 py-4" style={{ borderRadius: 0, background: "rgba(255,255,255,0.03)" }}>
              <div className="flex items-center gap-2 mb-2">
                <Icon className="w-3.5 h-3.5 text-foreground/60" />
                <span className="text-caption font-bold uppercase tracking-wider text-foreground/60">{cellLabel}</span>
              </div>
              {onU ? (
                <EditableText
                  value={(a.tone_manner.visual_direction as VisualDirectionStructured)[key]}
                  onSave={(v) => onU(["tone_manner", "visual_direction", key], v)}
                  multiline
                  className="text-body text-foreground/70 leading-relaxed"
                />
              ) : (
                <p className="text-body text-foreground/70 leading-relaxed">
                  {(a.tone_manner.visual_direction as VisualDirectionStructured)[key]}
                </p>
              )}
            </div>
          ))}
        </div>
      ),
  }),
  (lang) => ({
    title: t("reference_mood", lang),
    badge: "MOOD",
    group: "direction",
    render: (a, _l, onU) =>
      onU ? (
        <EditableText
          value={a.tone_manner.reference_mood || ""}
          onSave={(v) => onU(["tone_manner", "reference_mood"], v)}
          multiline
          className="text-label leading-relaxed text-foreground/80"
        />
      ) : (
        <ul className="space-y-2.5">
          {(a.tone_manner.reference_mood || "")
            .split(/(?<=[.。!?])\s+|(?<=\n)/)
            .filter((s: string) => s.trim())
            .map((sentence: string, i: number) => (
              <li key={i} className="flex items-start gap-2.5 text-label leading-relaxed text-foreground/80">
                <span className="shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full bg-foreground/30" />
                {sentence.trim()}
              </li>
            ))}
        </ul>
      ),
  }),
  (lang) => ({
    title: t("scene_flow", lang),
    badge: "FLOW",
    group: "direction",
    render: (a, l, onU) => {
      // legacy 문자열 케이스 — 기존 정적 3-노드 표시 유지.
      if (typeof a.production_notes.scene_count_hint === "string") {
        return (
          <div className="space-y-4">
            <div className="flex items-start">
              {(["Hook", "Body", "CTA"] as const).map((step, i) => (
                <div key={step} className="flex-1 relative">
                  {i < 2 && <div className="absolute top-[6px] left-1/2 w-full h-px bg-border" />}
                  <div className="flex flex-col items-center gap-1.5 relative z-10">
                    <div
                      className="w-3 h-3 border-2 border-background"
                      style={{ borderRadius: 0, background: i === 1 ? "rgba(255,255,255,0.2)" : KR }}
                    />
                    <span
                      className="font-mono text-2xs font-bold uppercase"
                      style={{ color: i === 1 ? "rgba(255,255,255,0.3)" : KR }}
                    >
                      {step}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-body text-muted-foreground leading-relaxed">{a.production_notes.scene_count_hint}</p>
          </div>
        );
      }

      return (
        <SceneFlowSection
          flow={a.production_notes.scene_count_hint as SceneFlowStructured}
          lang={l}
          onUpdate={onU}
          variant="slide"
        />
      );
    },
  }),
  (lang) => ({
    title: lang === "ko" ? "키비주얼 기준" : "Key Visual Criteria",
    badge: "KEYVIS",
    group: "direction",
    show: (a) => !!a.key_visual_criteria,
    render: (a, l, onU) => {
      const k = a.key_visual_criteria!;
      return (
        <div className="space-y-4">
          <div className="px-4 py-3" style={{ borderRadius: 0, background: "rgba(249,66,58,0.06)", border: "1px solid rgba(249,66,58,0.16)" }}>
            <Label3>{l === "ko" ? "정의" : "Definition"}</Label3>
            {onU ? (
              <EditableText
                value={k.definition}
                onSave={(v) => onU(["key_visual_criteria", "definition"], v)}
                multiline
                className="text-label text-foreground/85 leading-relaxed"
              />
            ) : (
              <p className="text-label text-foreground/85 leading-relaxed">{k.definition}</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: l === "ko" ? "선정 기준" : "Selection Rules", values: k.selection_rules ?? [] },
              { label: l === "ko" ? "시각 우선순위" : "Visual Priorities", values: k.visual_priorities ?? [] },
              { label: l === "ko" ? "피해야 할 패턴" : "Avoid Patterns", values: k.avoid_patterns ?? [] },
              { label: l === "ko" ? "근거" : "Evidence", values: k.evidence ?? [] },
            ].map((section) => (
              <div key={section.label} className="px-4 py-3" style={{ borderRadius: 0, background: "rgba(255,255,255,0.03)" }}>
                <Label3>{section.label}</Label3>
                <ul className="space-y-1.5">
                  {section.values.map((item, i) => (
                    <li key={i} className="flex items-start gap-2 text-meta leading-relaxed text-muted-foreground">
                      <span className="w-1 h-1 shrink-0 mt-[7px] bg-primary" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      );
    },
  }),
  (lang) => ({
    title: t("narrative_structure", lang),
    badge: "NARRATIVE",
    group: "direction",
    show: (a) => a.content_type === "brand_film" && !!a.narrative,
    render: (a, l) => <NarrativeSlideContent analysis={a} lang={l} />,
  }),
  (lang) => ({
    title: t("abcd_design_checklist", lang),
    badge: "ABCD",
    group: "abcd",
    render: (a, l) => <AbcdSlideContent analysis={a} lang={l} />,
  }),
];

/* ━━━━━ Narrative (brand_film) Slide ━━━━━ */
const NarrativeSlideContent = ({ analysis, lang }: { analysis: DeepAnalysis; lang: Lang }) => {
  const n = analysis.narrative;
  if (!n) return null;
  return (
    <div className="space-y-4">
      <div className="px-4 py-3" style={{ borderRadius: 0, background: "rgba(249,66,58,0.06)", border: "1px solid rgba(249,66,58,0.15)" }}>
        <Label3>{t("controlling_idea", lang)}</Label3>
        <p className="text-label text-foreground/90 leading-relaxed italic">"{n.controlling_idea}"</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="px-3 py-2.5" style={{ borderRadius: 0, background: "rgba(255,255,255,0.03)" }}>
          <Label3>Story Structure</Label3>
          <p className="text-body text-foreground/80 font-mono">{n.story_structure}</p>
        </div>
        <div className="px-3 py-2.5" style={{ borderRadius: 0, background: "rgba(255,255,255,0.03)" }}>
          <Label3>{t("protagonist", lang)}</Label3>
          <p className="text-meta text-foreground/80 leading-relaxed">
            <span className="text-foreground/60">{lang === "ko" ? "정체성" : "Identity"}:</span> {n.protagonist?.identity}
            <br />
            <span className="text-foreground/60">{lang === "ko" ? "욕망" : "Desire"}:</span> {n.protagonist?.desire}
            <br />
            <span className="text-foreground/60">{lang === "ko" ? "변화" : "Transformation"}:</span> {n.protagonist?.transformation}
          </p>
        </div>
      </div>

      {Array.isArray(n.emotional_beats) && n.emotional_beats.length > 0 && (
        <div className="px-3 py-2.5" style={{ borderRadius: 0, background: "rgba(255,255,255,0.03)" }}>
          <Label3>{t("emotional_beats", lang)}</Label3>
          <div className="space-y-1.5 mt-1">
            {n.emotional_beats.map((b, i) => (
              <div key={i} className="flex items-center gap-3 text-meta">
                <span className="font-mono text-foreground/50 w-16 shrink-0">{b.timestamp}</span>
                <span className="text-foreground/85 flex-1">{b.emotion}</span>
                <div className="flex gap-0.5 items-end h-4 w-16">
                  {Array.from({ length: 10 }).map((_, idx) => (
                    <div
                      key={idx}
                      className="flex-1 rounded-none"
                      style={{
                        background: idx < b.intensity ? KR : "rgba(255,255,255,0.08)",
                        height: `${30 + idx * 7}%`,
                      }}
                    />
                  ))}
                </div>
                <span className="font-mono text-caption text-foreground/50 w-6 text-right">{b.intensity}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const containsKorean = (value: string): boolean => /[ㄱ-ㅎㅏ-ㅣ가-힣]/u.test(value);

const localizeAbcdNote = (note: string, lang: Lang): string => {
  if (lang !== "en" || !containsKorean(note)) return note;

  const replacements: Array<[RegExp, string]> = [
    [/첫 프레임 시각 정의됨/g, "First-frame visual defined"],
    [/hero_visual\.first_frame 미정의 — 첫 프레임 시각을 구체화할 것/g, "hero_visual.first_frame is missing - define the first-frame visual"],
    [/hero_visual\.first_frame 미정의/g, "hero_visual.first_frame is missing"],
    [/pattern_interrupt 활성/g, "Pattern interrupt enabled"],
    [/pattern_interrupt 신호 확인됨/g, "Pattern interrupt signal found"],
    [/스크롤 멈춤\(pattern_interrupt\) 장치 없음/g, "No scroll-stopping pattern interrupt"],
    [/첫 3초 내 브랜드·제품 노출 설계됨/g, "Brand/product exposure planned within the first 3s"],
    [/첫 3초 내 제품\/브랜드 노출이 설계되지 않음/g, "Brand/product exposure is not planned within the first 3s"],
    [/훅 첫 3초 묘사가 비었거나 너무 짧음/g, "First 3s hook description is missing or too short"],
    [/첫 씬 description 이 비었거나 너무 짧음 — 훅 샷 구체화 필요/g, "First scene description is missing or too short - specify the hook shot"],
    [/첫 씬 description 구체적/g, "First scene description is specific"],
    [/첫 씬 camera_angle 미지정/g, "First scene camera_angle is missing"],
    [/첫 씬 duration 이 너무 짧음 — 훅 인지 불가/g, "First scene duration is too short for the hook to register"],
    [/첫 씬 duration 훅 구간에 적합/g, "First scene duration fits the hook window"],
    [/첫 씬 duration 미지정/g, "First scene duration is missing"],
    [/첫 제품\/브랜드 노출이 ([\d.]+)s — 3초 초과/g, "First product/brand exposure is at $1s - over 3s"],
    [/첫 ([\d.]+)s 내 브랜드·제품 노출/g, "Brand/product exposure within the first $1s"],
    [/씬에 제품\/브랜드 키워드 노출 없음/g, "No product/brand keyword exposure in scenes"],
    [/어떤 씬에도 제품\/브랜드 키워드가 없음/g, "No product/brand keyword appears in any scene"],
    [/브랜드·제품 노출이 ([\d.]+)s — 3초 초과/g, "Brand/product exposure is at $1s - over 3s"],
    [/3초 이내 \(([\d.]+)s\) 브랜드 노출/g, "Brand exposure within 3s ($1s)"],
    [/브랜드 노출이 5초 초과 — Hook 구간 내 진입 필요/g, "Brand exposure is after 5s - move it into the hook window"],
    [/브랜드 노출 타이밍이 5초 이내에 설계되지 않음/g, "Brand exposure is not planned within 5s"],
    [/5초 이내 브랜드 노출 \(설계\)/g, "Brand exposure within 5s (planned)"],
    [/브랜드·제품이 1개 씬에만 등장 — 분산 노출 부족/g, "Brand/product appears in only one scene - distributed exposure is weak"],
    [/브랜드·제품 분산 노출 없음/g, "No distributed brand/product exposure"],
    [/(\d+)개 씬에 걸쳐 브랜드·제품 반복 노출/g, "Repeated brand/product exposure across $1 scenes"],
    [/브랜드·제품 총 노출 ([\d.]+)s \/ ([\d.]+)s \((\d+)%\) — 20% 미만/g, "Total brand/product exposure is $1s / $2s ($3%) - below 20%"],
    [/총 러닝타임 산출 불가/g, "Total runtime cannot be calculated"],
    [/브랜드 노출 비중 (\d+)%/g, "Brand exposure share $1%"],
    [/product_info\.what 누락 — 판매·홍보 대상 불명확/g, "product_info.what is missing - the promoted object is unclear"],
    [/product_info\.what 누락/g, "product_info.what is missing"],
    [/logo_placement 미정의/g, "logo_placement is missing"],
    [/hero_visual\.must_show 자산 2개 미만/g, "Fewer than 2 hero_visual.must_show assets"],
    [/audience_insight\.pain_point 미정의 — 타겟 페인 포인트 구체화 필요/g, "audience_insight.pain_point is missing - specify the target pain point"],
    [/audience_insight\.pain_point 미정의/g, "audience_insight.pain_point is missing"],
    [/훅이 감정 비트를 강조하는 유형이 아님/g, "Hook type does not emphasize an emotional beat"],
    [/감정 연결형 훅 유형/g, "Emotion-driven hook type"],
    [/감정 연결형 훅 선택됨/g, "Emotion-driven hook selected"],
    [/감정 톤을 구체화할 lighting·reference_mood 서술 부족/g, "lighting/reference_mood lacks enough emotional detail"],
    [/visual_direction\.lighting 이 감정 톤을 구체화하지 못함/g, "visual_direction.lighting does not specify the emotional tone"],
    [/reference_mood 가 센서리 디테일로 묘사되지 않음/g, "reference_mood lacks sensory detail"],
    [/필드 씬 (\d+)개 — 스토리 비트 구성 불가 \(3\+ 권장\)/g, "$1 filled scene(s) - not enough for story beats (3+ recommended)"],
    [/필드 씬 (\d+)개 — 감정 빌드업 공간 부족/g, "$1 filled scene(s) - not enough room for emotional buildup"],
    [/(\d+)개 씬으로 내러티브 구성 가능/g, "$1 scenes can support narrative structure"],
    [/CTA 이전 빌드업 씬이 없음 — 감정 곡선 부재/g, "No buildup scene before CTA - emotional arc is missing"],
    [/CTA 이전 빌드업 씬 존재/g, "Buildup scene exists before CTA"],
    [/cta_action 이 동사형 10자 이내가 아님/g, "cta_action is not a short verb phrase"],
    [/cta_action 이 동사형 3-6자 짧은 문구가 아님/g, "cta_action is not a short verb phrase"],
    [/cta_action 구체적 동사형/g, "cta_action is a concrete verb phrase"],
    [/cta_destination \(구체적 경로\) 누락/g, "cta_destination is missing"],
    [/cta_destination 누락/g, "cta_destination is missing"],
    [/urgency 'none' — 긴박감 장치 없음/g, "urgency is 'none' - no urgency device"],
    [/urgency 'none'/g, "urgency is 'none'"],
    [/긴박감\(urgency\) 설계됨/g, "Urgency is planned"],
    [/긴박감 설계됨/g, "Urgency is planned"],
    [/마지막 30% 구간 씬에 CTA 키워드 없음/g, "No CTA keyword in the final 30% of scenes"],
    [/CTA 노출 ([\d.]+)s — 2초 미만, 인지 어려움/g, "CTA exposure is $1s - under 2s, hard to register"],
    [/CTA 노출 없음/g, "No CTA exposure"],
    [/CTA 마지막 구간 ([\d.]+)s 노출/g, "CTA exposure in final section: $1s"],
    [/권장 씬 수 3 미만 — 마지막 CTA 구간 확보 어려움/g, "Recommended shot count is below 3 - hard to secure a final CTA section"],
    [/권장 컷 수 3 미만 — 마지막 CTA 구간 확보 어려움/g, "Recommended shot count is below 3 - hard to secure a final CTA section"],
    [/검색어:/g, "keywords:"],
    [/초반 스크롤 이탈 위험 \(1-5s 권장\)/g, "early scroll-off risk (1-5s recommended)"],
    [/첫 씬 duration ([\d.]+)s/g, "First scene duration $1s"],
  ];

  return replacements.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), note);
};

const localizeAbcdGrade = (grade: string, lang: Lang): string => {
  if (lang !== "en") return grade;
  return ({ 탁월: "Excellent", 양호: "Good", 보통: "Fair", 취약: "Weak" } as Record<string, string>)[grade] ?? grade;
};

/* ━━━━━ ABCD Effectiveness Slide ━━━━━ */
const AbcdSlideContent = ({ analysis, lang }: { analysis: DeepAnalysis; lang: Lang }) => {
  // 브리프 설계값만으로 채점하는 "설계 체크리스트". 저장된 값이 있으면 사용.
  // 브리프 설계값만으로 채점 → scoreABCD 는 scenes 미전달 시 항상 non-null 반환
  const computed = analysis.abcd_compliance ?? scoreABCD({
    hook_strategy: analysis.hook_strategy,
    hero_visual: analysis.hero_visual,
    product_info: analysis.product_info,
    pacing: analysis.pacing,
    constraints: analysis.constraints,
    audience_insight: analysis.audience_insight,
    visual_direction:
      typeof analysis.tone_manner?.visual_direction === "object"
        ? analysis.tone_manner.visual_direction
        : undefined,
    reference_mood: analysis.tone_manner?.reference_mood,
  }) ?? {
    attract: { score: 0, notes: "" },
    brand: { score: 0, notes: "" },
    connect: { score: 0, notes: "" },
    direct: { score: 0, notes: "" },
    total: 0,
  };
  const total = computed.total ?? (computed.attract.score + computed.brand.score + computed.connect.score + computed.direct.score);
  const gradeInfo = gradeABCD(total);
  const colorMap: Record<typeof gradeInfo.color, string> = {
    red: "#ef4444",
    amber: "#f59e0b",
    lime: "#a3e635",
    green: "#10b981",
  };
  const rows: Array<{ key: "attract" | "brand" | "connect" | "direct"; letter: string; label: string }> = [
    { key: "attract", letter: "A", label: t("abcd_attract", lang) },
    { key: "brand", letter: "B", label: t("abcd_brand", lang) },
    { key: "connect", letter: "C", label: t("abcd_connect", lang) },
    { key: "direct", letter: "D", label: t("abcd_direct", lang) },
  ];
  return (
    <div className="space-y-4">
      {rows.map(({ key, letter, label }) => {
        const row = computed[key];
        const pct = Math.round((row.score / 10) * 100);
        return (
          <div key={key} className="space-y-1.5">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-body font-bold" style={{ color: KR }}>{letter}</span>
              <span className="text-meta uppercase tracking-wider text-foreground/70 font-semibold">{label}</span>
              <span className="ml-auto font-mono text-body text-foreground/80">{row.score}/10</span>
            </div>
            <div className="h-2 w-full rounded-none bg-foreground/10 overflow-hidden">
              <div
                className="h-full transition-all"
                style={{
                  width: `${pct}%`,
                  background:
                    row.score >= 7 ? "#10b981" : row.score >= 5 ? "#a3e635" : row.score >= 3 ? "#f59e0b" : "#ef4444",
                }}
              />
            </div>
            {row.notes && (
              <p className="text-caption leading-relaxed text-muted-foreground/80 pl-4 font-light">{localizeAbcdNote(row.notes, lang)}</p>
            )}
          </div>
        );
      })}
      <div
        className="mt-4 px-4 py-3 flex items-center justify-between"
        style={{ borderRadius: 0, background: "rgba(255,255,255,0.03)", border: `1px solid ${colorMap[gradeInfo.color]}40` }}
      >
        <div className="flex items-baseline gap-2">
          <span className="text-caption font-bold uppercase tracking-wider text-muted-foreground">{t("abcd_total", lang)}</span>
          <span className="font-mono text-subhead font-bold" style={{ color: colorMap[gradeInfo.color] }}>
            {(total / 4).toFixed(1)}/10
          </span>
        </div>
        <span
          className="text-meta font-bold uppercase tracking-wider"
          style={{ color: colorMap[gradeInfo.color] }}
        >
          {localizeAbcdGrade(gradeInfo.grade, lang)}
        </span>
      </div>
    </div>
  );
};

const SlideViewUI = ({
  analysis,
  lang = "ko",
  onUpdate,
}: {
  analysis: DeepAnalysis;
  lang?: Lang;
  onUpdate?: OnFieldUpdate;
}) => {
  const [slideIndex, setSlideIndex] = useState(0);
  // show predicate 가 있는 슬라이드는 현재 analysis 에 맞지 않으면 숨긴다
  const slides = SLIDE_DEFS.map((fn) => fn(lang)).filter((s) => !s.show || s.show(analysis));
  const total = slides.length;
  const current = slides[Math.min(slideIndex, total - 1)];

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowLeft") setSlideIndex((i) => Math.max(0, i - 1));
      if (e.key === "ArrowRight") setSlideIndex((i) => Math.min(total - 1, i + 1));
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [total]);

  return (
    <div className="flex flex-col h-full">
      <div className="px-1 mb-4">
        {analysis.content_type && CONTENT_TYPE_LABEL[analysis.content_type] && (
          <div className="mb-2">
            <span
              className="inline-block text-2xs font-bold uppercase tracking-wider px-2 py-0.5"
              title={analysis.classification_reasoning ?? ""}
              style={{
                borderRadius: 0,
                background: `${CONTENT_TYPE_LABEL[analysis.content_type].color}15`,
                color: CONTENT_TYPE_LABEL[analysis.content_type].color,
                border: `1px solid ${CONTENT_TYPE_LABEL[analysis.content_type].color}40`,
              }}
            >
              {CONTENT_TYPE_LABEL[analysis.content_type][lang]}
              {typeof analysis.classification_confidence === "number" &&
                ` · ${Math.round(analysis.classification_confidence * 100)}%`}
            </span>
          </div>
        )}
        {onUpdate ? (
          <EditableText
            value={analysis.goal.summary}
            onSave={(v) => onUpdate(["goal", "summary"], v)}
            className="text-hero font-bold text-foreground leading-tight tracking-tight"
          />
        ) : (
          <p className="text-hero font-bold text-foreground leading-tight tracking-tight">{analysis.goal.summary}</p>
        )}
        <div className="mt-2">
          {onUpdate ? (
            <EditableText
              value={analysis.usp.summary}
              onSave={(v) => onUpdate(["usp", "summary"], v)}
              className="text-body text-muted-foreground leading-relaxed"
            />
          ) : (
            <p className="text-body text-muted-foreground leading-relaxed">{analysis.usp.summary}</p>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        <div
          className="flex-1 overflow-y-auto"
          style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 0 }}
        >
          <div className="flex items-center gap-3 px-5 py-3 border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
            <span className="font-mono text-caption font-bold" style={{ color: "#666" }}>
              {slideIndex + 1}/{total}
            </span>
            <span
              className="text-2xs font-bold uppercase tracking-wider px-2 py-0.5"
              style={{
                borderRadius: 0,
                background: SLIDE_GROUP_LABEL[current.group].bg,
                color: SLIDE_GROUP_LABEL[current.group].color,
              }}
            >
              {SLIDE_GROUP_LABEL[current.group][lang]}
            </span>
            <span className="text-title font-bold text-foreground">{current.title}</span>
          </div>
          <div key={slideIndex} className="px-5 py-5 animate-fade-in">
            {current.render(analysis, lang, onUpdate)}
          </div>
        </div>

        <div className="flex flex-col items-center gap-2 pt-4 pb-1">
          <div className="flex items-center gap-4">
            <button
              onClick={() => setSlideIndex((i) => Math.max(0, i - 1))}
              disabled={slideIndex === 0}
              className="w-8 h-8 flex items-center justify-center transition-colors"
              style={{
                borderRadius: "50%",
                background: slideIndex === 0 ? "transparent" : "rgba(255,255,255,0.06)",
                color: slideIndex === 0 ? "#333" : "#999",
                border: "none",
                cursor: slideIndex === 0 ? "default" : "pointer",
              }}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div className="flex items-center gap-1.5">
              {slides.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setSlideIndex(i)}
                  style={{
                    width: i === slideIndex ? 20 : 6,
                    height: 6,
                    borderRadius: 0,
                    background: i === slideIndex ? KR : "rgba(255,255,255,0.15)",
                    border: "none",
                    cursor: "pointer",
                    transition: "width 200ms, background 200ms",
                  }}
                />
              ))}
            </div>
            <button
              onClick={() => setSlideIndex((i) => Math.min(total - 1, i + 1))}
              disabled={slideIndex === total - 1}
              className="w-8 h-8 flex items-center justify-center transition-colors"
              style={{
                borderRadius: "50%",
                background: slideIndex === total - 1 ? "transparent" : "rgba(255,255,255,0.06)",
                color: slideIndex === total - 1 ? "#333" : "#999",
                border: "none",
                cursor: slideIndex === total - 1 ? "default" : "pointer",
              }}
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          <span className="text-caption text-muted-foreground/50">
            {slideIndex + 1} / {total} · {current.title}
          </span>
        </div>
      </div>
    </div>
  );
};

/* ━━━━━ ProductionGuideUI — right column ━━━━━ */
const ProductionGuideUI = ({
  analysis,
  lang = "ko",
  onUpdate,
}: {
  analysis: DeepAnalysis;
  lang?: Lang;
  onUpdate?: OnFieldUpdate;
}) => {
  const [addingTag, setAddingTag] = useState(false);
  const [newTag, setNewTag] = useState("");

  const addToneTag = (tag: string) => {
    if (!tag.trim() || !onUpdate) return;
    const updated = [...(analysis.tone_manner.keywords || []), tag.trim()];
    onUpdate(["tone_manner", "keywords"], updated as any);
    setAddingTag(false);
    setNewTag("");
  };

  const removeToneTag = (index: number) => {
    if (!onUpdate) return;
    const updated = analysis.tone_manner.keywords.filter((_, i) => i !== index);
    onUpdate(["tone_manner", "keywords"], updated as any);
  };

  const E = (
    path: string[],
    value: string,
    opts?: { multiline?: boolean; className?: string; style?: React.CSSProperties },
  ) => {
    if (!onUpdate) {
      return (
        <span className={opts?.className} style={opts?.style}>
          {value}
        </span>
      );
    }
    return (
      <EditableText
        value={value}
        onSave={(v) => onUpdate(path, v)}
        multiline={opts?.multiline}
        className={opts?.className || ""}
        style={opts?.style}
      />
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="w-[3px] h-3 bg-foreground/30" style={{ borderRadius: 0 }} />
        <span className="label-meta text-muted-foreground">{t("production_guide", lang)}</span>
      </div>

      <SectionCard>
        <SectionHeader dot="gray" label={t("tone_manner", lang)} />
        <div className="px-3 py-3 space-y-2.5">
          <div className="flex flex-wrap gap-1.5">
            {analysis.tone_manner.keywords.map((kw, i) => (
              <span
                key={i}
                className="font-mono text-2xs px-2 py-1 font-bold uppercase tracking-wider relative group"
                style={{
                  borderRadius: 0,
                  ...(i % 2 === 0
                    ? { background: "rgba(249,66,58,0.12)", color: KR, border: "1px solid rgba(249,66,58,0.2)" }
                    : {
                        background: "rgba(255,255,255,0.06)",
                        color: "rgba(255,255,255,0.5)",
                        border: "1px solid rgba(255,255,255,0.08)",
                      }),
                }}
              >
                {kw}
                {onUpdate && (
                  <button
                    onClick={() => removeToneTag(i)}
                    className="absolute top-0 right-0 w-3.5 h-3.5 bg-primary text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    style={{ borderRadius: "50%", fontSize: 8, lineHeight: 1 }}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
            {onUpdate && !addingTag && (
              <button
                onClick={() => setAddingTag(true)}
                className="font-mono text-2xs px-2 py-1 font-bold uppercase tracking-wider transition-colors"
                style={{
                  borderRadius: 0,
                  background: "rgba(255,255,255,0.06)",
                  color: "#666",
                  border: "1px solid rgba(255,255,255,0.08)",
                }}
              >
                +
              </button>
            )}
            {addingTag && (
              <input
                autoFocus
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                onBlur={() => {
                  if (newTag.trim()) addToneTag(newTag);
                  else {
                    setAddingTag(false);
                    setNewTag("");
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newTag.trim()) addToneTag(newTag);
                  if (e.key === "Escape") {
                    setAddingTag(false);
                    setNewTag("");
                  }
                }}
                className="font-mono text-2xs px-2 py-1 font-bold uppercase tracking-wider"
                style={{
                  width: 80,
                  borderRadius: 0,
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(249,66,58,0.3)",
                  color: "#fff",
                  outline: "none",
                }}
              />
            )}
          </div>
          <div
            className="flex items-start gap-2.5 px-3 py-2.5"
            style={{ borderRadius: 0, background: "rgba(249,66,58,0.08)", border: "1px solid rgba(249,66,58,0.25)" }}
          >
            <div
              className="w-5 h-5 flex items-center justify-center shrink-0 mt-px"
              style={{ borderRadius: 0, background: KR }}
            >
              <span className="text-white text-caption font-bold leading-none">!</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="label-meta text-primary mb-1">{t("do_not", lang).toUpperCase()}</p>
              {E(["tone_manner", "do_not"], analysis.tone_manner.do_not, {
                multiline: true,
                className: "text-body text-primary/80 leading-relaxed",
              })}
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard>
        <div
          className="flex items-center gap-2 px-3 py-2.5 border-b border-border"
          style={{ background: "rgba(249,66,58,0.1)" }}
        >
          <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-primary" />
          <span className="text-caption font-bold uppercase tracking-wider text-primary">
            {t("prod_notes", lang).toUpperCase()}
          </span>
        </div>
        <div className="px-3 py-3 space-y-2">
          <div className="bg-background/80 border border-border px-3 py-2.5" style={{ borderRadius: 0 }}>
            <p className="label-meta text-muted-foreground mb-1">{t("format", lang)}</p>
            {E(["production_notes", "format_recommendation"], analysis.production_notes.format_recommendation, {
              multiline: true,
              className: "text-body leading-relaxed text-foreground/80",
            })}
          </div>
          <div className="bg-background/80 border border-border px-3 py-2.5" style={{ borderRadius: 0 }}>
            <p className="label-meta text-muted-foreground mb-1">{t("shooting_style", lang)}</p>
            {E(["production_notes", "shooting_style"], analysis.production_notes.shooting_style, {
              multiline: true,
              className: "text-body leading-relaxed text-foreground/80",
            })}
          </div>
          <div className="bg-background/80 border border-border px-3 py-2.5" style={{ borderRadius: 0 }}>
            <p className="label-meta text-muted-foreground mb-1">{t("budget_efficiency", lang)}</p>
            {E(["production_notes", "budget_efficiency"], analysis.production_notes.budget_efficiency, {
              multiline: true,
              className: "text-body leading-relaxed text-foreground/80",
            })}
          </div>
        </div>
      </SectionCard>
    </div>
  );
};

/* ━━━━━ DeepResultUI (legacy wrapper) ━━━━━ */
const DeepResultUI = ({
  analysis,
  lang = "ko",
  onUpdate,
}: {
  analysis: DeepAnalysis;
  lang?: Lang;
  onUpdate?: OnFieldUpdate;
}) => (
  <div className="space-y-5">
    <CoreStrategyUI analysis={analysis} lang={lang} onUpdate={onUpdate} />
    <ProductionGuideUI analysis={analysis} lang={lang} onUpdate={onUpdate} />
  </div>
);

const LegacyResultUI = ({ analysis, lang = "ko" }: { analysis: LegacyAnalysis; lang?: Lang }) => {
  const cards: { dot: DotVariant; label: string; tag: string; key: keyof LegacyAnalysis }[] = [
    { dot: "red", label: t("campaign_goal", lang), tag: "GOAL", key: "goal" },
    { dot: "black", label: t("target_audience", lang), tag: "TARGET", key: "target" },
    { dot: "red", label: t("usp", lang), tag: "USP", key: "usp" },
    { dot: "gray", label: t("tone_manner", lang), tag: "TONE", key: "tone_manner" },
  ];
  return (
    <div className="space-y-2">
      {cards.map((c) => (
        <SectionCard key={c.key}>
          <SectionHeader dot={c.dot} label={c.label} tag={c.tag} />
          <div className="px-3 py-2.5">
            <BulletList items={analysis[c.key] as string[]} dot={c.dot === "black" ? "black" : "red"} />
          </div>
        </SectionCard>
      ))}
    </div>
  );
};

/* ━━━━━ NextStepOption ━━━━━ */
const NextStepOption = ({
  Icon,
  title,
  desc,
  onClick,
}: {
  Icon: LucideIcon;
  title: string;
  desc: string;
  onClick: () => void;
}) => {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="w-full flex items-start gap-3 p-3 border text-left transition-all duration-150"
      style={{
        borderRadius: 0,
        borderColor: hovered ? "rgba(249,66,58,0.4)" : "rgba(255,255,255,0.07)",
        background: hovered ? "rgba(249,66,58,0.06)" : "transparent",
        transform: hovered ? "translateY(-1px)" : "translateY(0)",
        boxShadow: hovered ? "0 4px 12px rgba(249,66,58,0.12)" : "none",
      }}
    >
      <Icon
        className="w-4 h-4 shrink-0 mt-0.5"
        style={{ color: hovered ? KR : "rgba(255,255,255,0.5)" }}
        strokeWidth={1.75}
      />
      <div>
        <div className="text-meta font-semibold text-foreground">{title}</div>
        <div className="text-caption text-muted-foreground mt-0.5">{desc}</div>
      </div>
    </button>
  );
};

const NextStepModal = ({
  onClose,
  onGoAssets,
  onGoAgent,
}: {
  onClose: () => void;
  onGoAssets: () => void;
  onGoAgent: () => void;
  analysisLang?: "ko" | "en";
}) => {
  const t = useT();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t("brief.nextStepTitle")}</DialogTitle>
        </DialogHeader>
        <p className="text-meta text-muted-foreground leading-relaxed">
          {t("brief.nextStepDesc")}
        </p>
        <div className="space-y-2 mt-1">
          {[
            {
              Icon: Package,
              title: t("brief.nextStepAssetsTitle"),
              desc: t("brief.nextStepAssetsDesc"),
              onClick: () => {
                onClose();
                onGoAssets();
              },
            },
            {
              Icon: MessageSquare,
              title: t("brief.nextStepIdeationTitle"),
              desc: t("brief.nextStepIdeationDesc"),
              onClick: () => {
                onClose();
                onGoAgent();
              },
            },
          ].map((opt) => (
            <NextStepOption key={opt.title} {...opt} />
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" className="text-body h-9" onClick={onClose}>
            {t("common.cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/* ━━━━━ LangToggle — shared toggle UI ━━━━━ */
const LangToggle = ({
  lang,
  onChange,
  loading = false,
}: {
  lang: Lang;
  onChange: (l: Lang) => void;
  loading?: boolean;
}) => (
  <button
    onClick={() => onChange(lang === "ko" ? "en" : "ko")}
    disabled={loading}
    className="flex items-center h-6 border border-border overflow-hidden"
    style={{ borderRadius: 0 }}
  >
    {(["ko", "en"] as const).map((l) => (
      <span
        key={l}
        className="px-2 h-full flex items-center text-2xs font-bold tracking-wider transition-colors"
        style={{
          background: lang === l ? KR : "transparent",
          color: lang === l ? "#fff" : "rgba(255,255,255,0.35)",
        }}
      >
        {l === "en" && loading ? (
          <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
        ) : (
          l.toUpperCase()
        )}
      </span>
    ))}
  </button>
);

/* ━━━━━ Main Component ━━━━━ */
export const BriefTab = ({ projectId, onSwitchToAgent, onSwitchToAssets }: Props) => {
  const { toast } = useToast();
  const t = useT();
  const { language: uiLanguage } = useUiLanguage();
  const isMobile = useIsMobile();

  // 크리에이티브 입력 패널 폭 — 드래그 리사이즈 가능. localStorage 영구화 +
  // 같은/다른 윈도우 동기화(CustomEvent + storage). 분석 후에도 접지 않고
  // 이 폭을 그대로 유지한다.
  const [briefPanelWidth, setBriefPanelWidth] = useState<number>(() => readBriefPanelWidth());
  useEffect(() => {
    const syncFromEvent = (e: Event) => {
      const detail = (e as CustomEvent<number>).detail;
      if (typeof detail === "number") setBriefPanelWidth(clampBriefPanelWidth(detail));
    };
    const syncFromStorage = (e: StorageEvent) => {
      if (e.key === "preflow.brief.panelWidth") setBriefPanelWidth(readBriefPanelWidth());
    };
    window.addEventListener(BRIEF_PANEL_WIDTH_CHANGED_EVENT, syncFromEvent);
    window.addEventListener("storage", syncFromStorage);
    return () => {
      window.removeEventListener(BRIEF_PANEL_WIDTH_CHANGED_EVENT, syncFromEvent);
      window.removeEventListener("storage", syncFromStorage);
    };
  }, []);

  const getInitialDraft = useCallback((): DraftState => {
    const memCached = _draftByProject.get(projectId);
    if (memCached) return memCached;

    const persisted = loadFromLS(projectId);
    const draft: DraftState = {
      briefText: persisted.briefText,
      ideaNote: persisted.ideaNote,
      pdfState: persisted.pdfState,
      pdfExtractedText: persisted.pdfExtractedText,
      pdfFileName: persisted.pdfFileName,
      pdfFileSize: persisted.pdfFileSize,
      pdfPageInfo: persisted.pdfPageInfo,
      pdfAttachmentId: persisted.pdfAttachmentId,
      briefImages: fromSerializable(persisted.briefImages),
      refItems: fromSerializableRefItems(persisted.refItems),
    };
    _draftByProject.set(projectId, draft);
    return draft;
  }, [projectId]);

  const initialDraft = getInitialDraft();

  const [briefText, setBriefTextState] = useState(initialDraft.briefText);
  const [ideaNote, setIdeaNoteState] = useState(initialDraft.ideaNote);
  const [briefImages, setBriefImagesState] = useState<ImageItem[]>(initialDraft.briefImages);
  const [refItems, setRefItemsState] = useState<RefItem[]>(initialDraft.refItems);
  const [libraryImportOpen, setLibraryImportOpen] = useState(false);

  // Library 컨텍스트 메뉴에서 이 프로젝트로 "Brief 에 추가" 가 발화되면
  // 모듈-레벨 appendLibraryRefItemToProject 가 _draftByProject 를 직접 갱신하고
  // CustomEvent 로 신호. 마운트된 BriefTab 은 그 시점에 refItems state 만
  // 빠르게 sync (다른 필드는 동일하므로 굳이 재로드 안 함).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<BriefDraftChangedDetail>).detail;
      if (!detail || detail.projectId !== projectId) return;
      const fresh = _draftByProject.get(projectId);
      if (fresh) setRefItemsState(fresh.refItems);
    };
    window.addEventListener(BRIEF_DRAFT_CHANGED_EVENT, handler);
    return () => window.removeEventListener(BRIEF_DRAFT_CHANGED_EVENT, handler);
  }, [projectId]);

  const [pdfState, setPdfStateRaw] = useState<"idle" | "extracting" | "ready" | "error">(initialDraft.pdfState);
  const [pdfExtractedText, setPdfExtractedTextState] = useState(initialDraft.pdfExtractedText);
  const [pdfFileName, setPdfFileNameState] = useState(initialDraft.pdfFileName);
  const [pdfFileSize, setPdfFileSizeState] = useState(initialDraft.pdfFileSize);
  const [pdfPageInfo, setPdfPageInfoState] = useState(initialDraft.pdfPageInfo);
  // PDF 본체 storage 영속화 ID — handlePDFUpload 가 채우고 resetPdf 가 청소.
  // localStorage 의 pdfAttachmentId 와 동기화돼, 새 이미지/탭 전환 후에도 동일
  // 첨부 인스턴스를 가리킨다.
  const [pdfAttachmentId, setPdfAttachmentIdState] = useState<string | undefined>(
    initialDraft.pdfAttachmentId,
  );

  /**
   * Draft 패치를 in-memory 캐시 + localStorage 양쪽에 영구화.
   *
   * Quota 초과로 LS 저장이 실패하면:
   *   1) _draftByProject 도 직전 상태로 롤백해 cross-tab append 와의 정합성을 유지
   *   2) BriefDraftQuotaError 를 그대로 throw — 호출자가 React state 도 롤백하고
   *      사용자에게 토스트로 안내
   */
  const saveDraft = useCallback(
    (patch: Partial<DraftState>): void => {
      const cur = _draftByProject.get(projectId) ?? getDefaultDraft();
      const next = { ...cur, ...patch };
      _draftByProject.set(projectId, next);

      const persisted: PersistedDraft = {
        briefText: next.briefText,
        ideaNote: next.ideaNote,
        briefImages: toSerializable(next.briefImages),
        refItems: toSerializableRefItems(next.refItems),
        pdfState: next.pdfState,
        pdfExtractedText: next.pdfExtractedText,
        pdfFileName: next.pdfFileName,
        pdfFileSize: next.pdfFileSize,
        pdfPageInfo: next.pdfPageInfo,
        pdfAttachmentId: next.pdfAttachmentId,
      };
      try {
        saveToLS(projectId, persisted);
      } catch (err) {
        _draftByProject.set(projectId, cur);
        throw err;
      }
    },
    [projectId],
  );

  /**
   * Setter 들이 saveDraft 의 quota 에러를 잡아 1) React state 를 직전 값으로
   * 롤백하고 2) 사용자에게 토스트를 띄우는 공통 헬퍼. 어떤 필드가 너무 커서
   * 거절됐는지는 사용자가 무엇을 추가하다 토스트를 봤는지로 식별 가능하므로
   * 별도 필드명은 메시지에 노출하지 않는다.
   *
   * Quota 가 아닌 다른 예외는 그대로 다시 throw — 호출 스택의 상위 try/catch
   * 가 처리하거나 React error boundary 가 잡도록 한다.
   */
  const handleDraftQuotaError = useCallback(
    (err: unknown): boolean => {
      if (!isQuotaError(err)) return false;
      toast({
        variant: "destructive",
        title: t("brief.toast.draftFull"),
        description: t("brief.toast.draftFullDesc"),
      });
      return true;
    },
    [toast, t],
  );

  const setBriefText = (v: string) => {
    setBriefTextState((prev) => {
      try {
        saveDraft({ briefText: v });
        return v;
      } catch (err) {
        if (handleDraftQuotaError(err)) return prev;
        throw err;
      }
    });
  };
  const setIdeaNote = (v: string) => {
    setIdeaNoteState((prev) => {
      try {
        saveDraft({ ideaNote: v });
        return v;
      } catch (err) {
        if (handleDraftQuotaError(err)) return prev;
        throw err;
      }
    });
  };

  const setBriefImages = (fn: ImageItem[] | ((p: ImageItem[]) => ImageItem[])) => {
    setBriefImagesState((prev) => {
      const next = typeof fn === "function" ? fn(prev) : fn;
      try {
        saveDraft({ briefImages: next });
        return next;
      } catch (err) {
        if (handleDraftQuotaError(err)) return prev;
        throw err;
      }
    });
  };
  const setRefItems = (fn: RefItem[] | ((p: RefItem[]) => RefItem[])) => {
    setRefItemsState((prev) => {
      const next = typeof fn === "function" ? fn(prev) : fn;
      try {
        saveDraft({ refItems: next });
        return next;
      } catch (err) {
        if (handleDraftQuotaError(err)) return prev;
        throw err;
      }
    });
  };
  const setPdfState = (v: "idle" | "extracting" | "ready" | "error") => {
    setPdfStateRaw((prev) => {
      try {
        saveDraft({ pdfState: v });
        return v;
      } catch (err) {
        if (handleDraftQuotaError(err)) return prev;
        throw err;
      }
    });
  };
  const setPdfExtractedText = (v: string) => {
    setPdfExtractedTextState((prev) => {
      try {
        saveDraft({ pdfExtractedText: v });
        return v;
      } catch (err) {
        if (handleDraftQuotaError(err)) return prev;
        throw err;
      }
    });
  };
  const setPdfFileName = (v: string) => {
    setPdfFileNameState((prev) => {
      try {
        saveDraft({ pdfFileName: v });
        return v;
      } catch (err) {
        if (handleDraftQuotaError(err)) return prev;
        throw err;
      }
    });
  };
  const setPdfFileSize = (v: number) => {
    setPdfFileSizeState((prev) => {
      try {
        saveDraft({ pdfFileSize: v });
        return v;
      } catch (err) {
        if (handleDraftQuotaError(err)) return prev;
        throw err;
      }
    });
  };
  const setPdfPageInfo = (v: { pages: number; chars: number } | null) => {
    setPdfPageInfoState((prev) => {
      try {
        saveDraft({ pdfPageInfo: v });
        return v;
      } catch (err) {
        if (handleDraftQuotaError(err)) return prev;
        throw err;
      }
    });
  };
  const setPdfAttachmentId = (v: string | undefined) => {
    setPdfAttachmentIdState((prev) => {
      try {
        saveDraft({ pdfAttachmentId: v });
        return v;
      } catch (err) {
        if (handleDraftQuotaError(err)) return prev;
        throw err;
      }
    });
  };

  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  // analyzing 은 모듈 레벨 briefAnalysisRegistry 에서 hydrate 한다 — BriefTab 이
  // 다른 라우트로 다녀와 언마운트→재마운트 되는 동안에도 진행 상태가 유지되어야
  // 사용자가 돌아왔을 때 로딩 UI 가 끊기지 않는다.
  const [analyzing, setAnalyzing] = useState<boolean>(() =>
    briefAnalysisRegistry.isAnalyzing(projectId),
  );
  const [analyzingStartedAt, setAnalyzingStartedAt] = useState<number | null>(() =>
    briefAnalysisRegistry.startedAt(projectId),
  );
  // analyzing 이 false 로 내려간 직후 300ms 동안 로더를 유지해 100% 스냅 연출.
  // AnalysisLoader 가 onHidden 콜백으로 해제.
  const [loaderLingering, setLoaderLingering] = useState(false);
  // 분석 종료 알림(레지스트리 구독)으로 fetchBrief 를 강제 재실행하기 위한 nonce.
  // 분석을 시작한 BriefTab 인스턴스가 이미 언마운트된 케이스(다른 라우트 갔다가
  // 분석 끝난 뒤 돌아옴)에도, 새로 마운트된 인스턴스가 DB 의 결과를 즉시 반영.
  const [briefFetchNonce, setBriefFetchNonce] = useState(0);
  const [existingBrief, setExistingBrief] = useState<Brief | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [analyzedAt, setAnalyzedAt] = useState<string | null>(null);
  const [sourceType, setSourceType] = useState<"text" | "image" | "pdf">("text");
  const [composerDragOver, setComposerDragOver] = useState(false);
  const [refDragOver, setRefDragOver] = useState(false);
  const [refUrlInput, setRefUrlInput] = useState("");
  const [showNextStepModal, setShowNextStepModal] = useState(false);
  const [viewMode, setViewMode] = useState<"list" | "slide">("list");

  /* ━━━━━ KO/EN — analysis lang + bidirectional sync ━━━━━ */
  const [analysisLang, setAnalysisLang] = useState<Lang>(() => uiLanguage);
  const [analysisEn, setAnalysisEn] = useState<Analysis | null>(null);
  const [translating, setTranslating] = useState(false);
  const [fieldSyncing, setFieldSyncing] = useState<string | null>(null);
  const analysisLangTouchedRef = useRef(false);
  const previousProjectIdRef = useRef(projectId);

  useEffect(() => {
    if (previousProjectIdRef.current === projectId) return;
    previousProjectIdRef.current = projectId;
    analysisLangTouchedRef.current = false;
    setAnalysisLang(uiLanguage);
  }, [projectId, uiLanguage]);

  useEffect(() => {
    if (!analysis && !existingBrief && !analysisLangTouchedRef.current) {
      setAnalysisLang(uiLanguage);
    }
  }, [uiLanguage, analysis, existingBrief]);

  /* ━━━━━ Analyzing 상태를 모듈 레벨 레지스트리와 동기화 ━━━━━
   *
   * BriefTab 이 마운트될 때 진행 중인 분석이 있으면 즉시 로딩 UI 를 보여주고,
   * 진행 중에 다른 라우트로 다녀온 뒤 돌아왔을 때도 끊김 없이 이어준다. 분석이
   * 끝났다는 알림을 받으면 (a) 100% 스냅 연출용 lingering 을 켜고 (b) DB
   * 재조회로 분석 결과를 화면에 반영한다 — 분석을 시작한 인스턴스가 이미
   * 언마운트되어 setAnalysis 가 no-op 인 케이스를 커버한다. */
  useEffect(() => {
    const initialAnalyzing = briefAnalysisRegistry.isAnalyzing(projectId);
    setAnalyzing(initialAnalyzing);
    setAnalyzingStartedAt(briefAnalysisRegistry.startedAt(projectId));
    let prevAnalyzing = initialAnalyzing;
    return briefAnalysisRegistry.subscribe(projectId, ({ analyzing: nextAnalyzing, startedAt }) => {
      if (prevAnalyzing && !nextAnalyzing) {
        setLoaderLingering(true);
        setBriefFetchNonce((n) => n + 1);
      }
      prevAnalyzing = nextAnalyzing;
      setAnalyzing(nextAnalyzing);
      setAnalyzingStartedAt(startedAt);
    });
  }, [projectId]);

  /* Analysis result lang toggle — lazy translate on first EN click */
  const handleLangToggle = useCallback(
    async (next: Lang) => {
      if (next === "ko") {
        setAnalysisLang("ko");
        return;
      }
      if (!analysis) return;
      if (analysisEn) {
        setAnalysisLang("en");
        return;
      }
      // First-time full translation
      setTranslating(true);
      try {
        const { data, error } = await supabase.functions.invoke("translate-analysis", {
          body: { mode: "full", analysis, direction: "ko_to_en" },
        });
        if (error) throw error;
        if (data?.translated) {
          setAnalysisEn(data.translated);
          setAnalysisLang("en");
          if (existingBrief) {
            await supabase
              .from("briefs")
              .update({ analysis_en: data.translated } as any)
              .eq("id", existingBrief.id);
          }
        }
      } catch {
        toast({
          variant: "destructive",
          title: t("brief.toast.translationFailed"),
          description: t("brief.toast.translationFailedDesc"),
        });
      } finally {
        setTranslating(false);
      }
    },
    [analysis, analysisEn, toast, existingBrief, t],
  );

  /* ━━━━━ Bidirectional field sync ━━━━━ */
  const updateAnalysisField = useCallback(
    async (path: string[], newValue: any) => {
      if (!analysis || !isDeepAnalysis(analysis)) return;

      const editedLang = analysisLang;
      const pathKey = path.join(".");

      if (editedLang === "ko") {
        const updated = deepSet(analysis, path, newValue);
        setAnalysis(updated);
        if (existingBrief) {
          await supabase.from("briefs").update({ analysis: updated }).eq("id", existingBrief.id);
        }
      } else {
        if (!analysisEn) return;
        const updated = deepSet(analysisEn, path, newValue);
        setAnalysisEn(updated);
        if (existingBrief) {
          await supabase
            .from("briefs")
            .update({ analysis_en: updated } as any)
            .eq("id", existingBrief.id);
        }
      }

      if (editedLang === "ko" && !analysisEn) return;
      if (editedLang === "en" && !analysis) return;

      if (Array.isArray(newValue)) {
        if (editedLang === "ko" && analysisEn) {
          const enUpdated = reorderArraySync(analysisEn, analysis, path, newValue);
          setAnalysisEn(enUpdated);
          if (existingBrief) {
            await supabase
              .from("briefs")
              .update({ analysis_en: enUpdated } as any)
              .eq("id", existingBrief.id);
          }
        } else if (editedLang === "en" && analysis) {
          const koUpdated = reorderArraySync(analysis, analysisEn!, path, newValue);
          setAnalysis(koUpdated);
          if (existingBrief) {
            await supabase.from("briefs").update({ analysis: koUpdated }).eq("id", existingBrief.id);
          }
        }
        return;
      }

      /* Object 업데이트 — duration 같이 언어 무관 필드 다수를 한번에 갱신할 때
         (예: SceneFlowSection 의 reorder/delete/add) 사용. 다른 언어 사이드에는
         같은 객체를 그대로 deepSet 한다. 객체 내부에 언어별 텍스트 (description
         등) 가 있을 수 있지만 writeAll 트리거에선 description 을 건드리지
         않으므로 안전. 만약 description 도 객체 안에서 함께 변하면 별도 string
         path 로 갱신해야 한다. */
      if (
        newValue !== null &&
        typeof newValue === "object" &&
        !Array.isArray(newValue)
      ) {
        if (editedLang === "ko" && analysisEn) {
          const enUpdated = deepSet(analysisEn, path, newValue);
          setAnalysisEn(enUpdated);
          if (existingBrief) {
            await supabase
              .from("briefs")
              .update({ analysis_en: enUpdated } as any)
              .eq("id", existingBrief.id);
          }
        } else if (editedLang === "en" && analysis) {
          const koUpdated = deepSet(analysis, path, newValue);
          setAnalysis(koUpdated);
          if (existingBrief) {
            await supabase.from("briefs").update({ analysis: koUpdated }).eq("id", existingBrief.id);
          }
        }
        return;
      }

      if (typeof newValue === "string" && newValue.trim()) {
        setFieldSyncing(pathKey);
        try {
          const { data } = await supabase.functions.invoke("translate-analysis", {
            body: {
              mode: "field",
              fieldValue: newValue,
              fieldPath: pathKey,
              direction: editedLang === "ko" ? "ko_to_en" : "en_to_ko",
            },
          });

          if (data?.translated) {
            if (editedLang === "ko" && analysisEn) {
              const enUpdated = deepSet(structuredClone(analysisEn), path, data.translated);
              setAnalysisEn(enUpdated);
              if (existingBrief) {
                await supabase
                  .from("briefs")
                  .update({ analysis_en: enUpdated } as any)
                  .eq("id", existingBrief.id);
              }
            } else if (editedLang === "en" && analysis) {
              const koUpdated = deepSet(structuredClone(analysis), path, data.translated);
              setAnalysis(koUpdated);
              if (existingBrief) {
                await supabase.from("briefs").update({ analysis: koUpdated }).eq("id", existingBrief.id);
              }
            }
          }
        } catch (err) {
          console.error("Field sync failed:", err);
        } finally {
          setFieldSyncing(null);
        }
      }
    },
    [analysis, analysisEn, analysisLang, existingBrief],
  );

  /* ━━━━━ First-time editing hint ━━━━━ */
  const [showEditHint, setShowEditHint] = useState(false);
  useEffect(() => {
    if (!analysis || !isDeepAnalysis(analysis)) return;
    const key = `ff_edit_hint_${projectId}`;
    if (!localStorage.getItem(key)) {
      setShowEditHint(true);
      localStorage.setItem(key, "1");
      const timer = setTimeout(() => setShowEditHint(false), 3000);
      const handleClick = () => {
        setShowEditHint(false);
        clearTimeout(timer);
      };
      window.addEventListener("click", handleClick, { once: true });
      return () => {
        clearTimeout(timer);
        window.removeEventListener("click", handleClick);
      };
    }
  }, [analysis, projectId]);

  const refFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const fetchBrief = async () => {
      const { data } = await supabase
        .from("briefs")
        .select("*")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (!data) return;
      setExistingBrief(data as unknown as Brief);

      if (data.analysis) {
        const rawAnalysis = data.analysis as unknown as Analysis;
        const a = isDeepAnalysis(rawAnalysis) ? ensureBriefQualityFields(rawAnalysis) : rawAnalysis;
        setAnalysis(a);
        setAnalyzedAt(data.created_at);
        setSourceType(((data as any).source_type as "text" | "image" | "pdf") || "text");

        if (isDeepAnalysis(a) && JSON.stringify(a) !== JSON.stringify(data.analysis)) {
          await supabase.from("briefs").update({ analysis: a }).eq("id", data.id);
        }

        // ★ Load lang from DB
        if ((data as any).lang) {
          setAnalysisLang((data as any).lang as Lang);
        }

        if ((data as any).analysis_en) {
          const rawAnalysisEn = (data as any).analysis_en as unknown as Analysis;
          setAnalysisEn(isDeepAnalysis(rawAnalysisEn) ? ensureBriefQualityFields(rawAnalysisEn) : rawAnalysisEn);
        }

        const currentDraft = loadFromLS(projectId);
        if (!currentDraft.ideaNote && isDeepAnalysis(a) && a.idea_note) {
          setIdeaNote(a.idea_note);
        }
      }

      const currentDraft = loadFromLS(projectId);
      if (!currentDraft.briefText && data.raw_text) {
        setBriefText(data.raw_text);
      }
    };
    fetchBrief();
    // briefFetchNonce 가 바뀌면 (분석 종료 알림) DB 의 최신 결과를 다시 로드.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, briefFetchNonce]);

  /* ━━━━━ brief_attachments 동기화 — DB ↔ in-memory ━━━━━
   *
   * 두 가지 일을 한다 (마운트당 1회):
   *   (A) Recovery: DB 에 행이 있는데 in-memory (LS 로부터 hydrate 된 state) 에
   *       없는 첨부물을 in-memory 로 복구. 옛날 LS quota 초과로 silent drop
   *       됐던 항목이나, 다른 디바이스에서 import 된 프로젝트의 첨부물이
   *       이 경로로 살아 돌아온다.
   *   (B) Migration: in-memory 항목 중 `attachmentId` 가 비어 있는 것
   *       (= LS-only 옛 draft) 을 DB 로 업로드해 attachmentId 를 채운다. 이후
   *       export/디바이스 이전/quota 시나리오 모두에서 안전해진다.
   *
   * 둘 다 실패해도 사용자 흐름은 막지 않는다 (warn 로그만).
   *
   * NOTE: dual-write 가 표준 경로가 된 이후에 도입된 마이그레이션이라 일회성
   * 이지만, in-flight 분석/편집 중일 때 race condition 을 피하려고 unmount
   * 가드와 projectId 가드로 보호한다.
   */
  /* 능동 회수 — 마운트 시 1회, quota 가 터지기 전에 모든 draft 의 DB 중복
     base64 를 소급 제거한다. "브리프 임시 저장소가 가득" 토스트가 반복되던
     근본 원인(과거 마이그레이션이 attachmentId 만 채우고 base64 를 LS 에
     남겨 둔 이중 저장)을 회복한다. 데이터 손실 없음(base64 는 DB 사본). */
  useEffect(() => {
    if (_briefStorageReclaimed) return;
    _briefStorageReclaimed = true;
    try {
      evictStaleBriefStorage(false);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!projectId) return;
      // 사전 가드 — workspace 가 다른 DB 로 전환된 직후 in-flight 으로 남은
      // 마이그레이션이 엉뚱한 DB 로 INSERT 를 날려 FK constraint 가 터지는
      // race 를 차단. 현재 active DB 에 이 project 가 존재할 때만 진행.
      try {
        const { data: probe } = await supabase
          .from("projects")
          .select("id")
          .eq("id", projectId)
          .maybeSingle();
        if (cancelled || !probe) return;
      } catch {
        return;
      }
      let dbRows: Awaited<ReturnType<typeof loadBriefAttachments>>;
      try {
        dbRows = await loadBriefAttachments(projectId);
      } catch (err) {
        console.warn("[BriefTab] loadBriefAttachments failed:", err);
        return;
      }
      if (cancelled) return;

      const dbById = new Map(dbRows.map((r) => [r.id, r]));

      /* (A) Recovery — DB 에만 있는 row 를 in-memory 로 추가 ----------- */
      // briefImages: role='brief' && kind='image' && file_url
      const knownBriefAttIds = new Set(
        (_draftByProject.get(projectId)?.briefImages ?? [])
          .map((it) => it.attachmentId)
          .filter((x): x is string => !!x),
      );
      const recoveredBriefImages: ImageItem[] = [];
      for (const row of dbRows) {
        if (row.role !== "brief") continue;
        if (row.kind !== "image" || !row.file_url) continue;
        if (knownBriefAttIds.has(row.id)) continue;
        recoveredBriefImages.push({
          base64: "",
          mediaType: row.mime_type ?? "image/png",
          preview: row.file_url,
          attachmentId: row.id,
        });
      }
      // 기존 항목 중 슬림(attachmentId 보유, http 프리뷰 없음)인 것은 DB file_url
      // 로 프리뷰를 되살린다(소급 슬림화로 base64 가 비워진 항목 복원).
      const needsBriefPatch = (_draftByProject.get(projectId)?.briefImages ?? []).some(
        (it) => it.attachmentId && !isHttpUrl(it.preview) && dbById.get(it.attachmentId)?.file_url,
      );
      if (recoveredBriefImages.length > 0 || needsBriefPatch) {
        setBriefImages((prev) => {
          const patched = prev.map((it) => {
            if (it.attachmentId && !isHttpUrl(it.preview)) {
              const url = dbById.get(it.attachmentId)?.file_url;
              if (url) return { ...it, preview: url, base64: "" };
            }
            return it;
          });
          return recoveredBriefImages.length > 0 ? [...patched, ...recoveredBriefImages] : patched;
        });
      }

      // refItems: role='reference' && kind in {image,video,youtube}
      const knownRefAttIds = new Set(
        (_draftByProject.get(projectId)?.refItems ?? [])
          .map((it) => it.attachmentId)
          .filter((x): x is string => !!x),
      );
      const recoveredRefs: RefItem[] = [];
      for (const row of dbRows) {
        if (row.role !== "reference") continue;
        if (knownRefAttIds.has(row.id)) continue;
        if (row.kind === "image" && row.file_url) {
          recoveredRefs.push({
            kind: "image",
            id: makeRefId("image"),
            addedAt: row.created_at,
            base64: "",
            mediaType: row.mime_type ?? "image/png",
            preview: row.file_url,
            attachmentId: row.id,
            annotation: row.annotation ?? undefined,
            ignoredByModel: false,
          });
        } else if (row.kind === "video" && (row.file_url || row.external_url)) {
          recoveredRefs.push({
            kind: "video",
            id: makeRefId("video"),
            addedAt: row.created_at,
            fileName: row.filename ?? "video",
            fileSize: row.size_bytes ?? 0,
            durationSec: row.duration_sec ?? 0,
            posterBase64: "",
            // poster_url(storage URL)로 썸네일을 표시한다 — base64 없이도 보임.
            posterUrl: row.poster_url ?? undefined,
            remoteUrl: row.external_url ?? row.file_url ?? undefined,
            status: "ready",
            attachmentId: row.id,
            annotation: row.annotation ?? undefined,
            ignoredByModel: !supportsVideoFrames,
          });
        } else if (row.kind === "youtube" && row.external_url) {
          const m = row.external_url.match(YOUTUBE_URL_REGEX);
          recoveredRefs.push({
            kind: "youtube",
            id: makeRefId("youtube"),
            addedAt: row.created_at,
            url: row.external_url,
            videoId: m?.[1] ?? "",
            title: row.filename ?? undefined,
            thumbnailUrl: row.poster_url ?? undefined,
            transcript: row.extracted_text ?? undefined,
            durationSec: row.duration_sec ?? undefined,
            status: "ready",
            attachmentId: row.id,
            annotation: row.annotation ?? undefined,
            ignoredByModel: !supportsVideoFrames,
          });
        }
      }
      // 기존 image refItem 중 슬림(attachmentId 보유, http 프리뷰 없음)인 것은
      // DB file_url 로 프리뷰 복원(소급 슬림화 호환).
      const needsRefPatch = (_draftByProject.get(projectId)?.refItems ?? []).some(
        (it) =>
          it.kind === "image" &&
          it.attachmentId &&
          !isHttpUrl(it.preview) &&
          dbById.get(it.attachmentId)?.file_url,
      );
      if (recoveredRefs.length > 0 || needsRefPatch) {
        setRefItems((prev) => {
          const patched = prev.map((it) => {
            if (it.kind === "image" && it.attachmentId && !isHttpUrl(it.preview)) {
              const url = dbById.get(it.attachmentId)?.file_url;
              if (url) return { ...it, preview: url, base64: "" } as typeof it;
            }
            return it;
          });
          return recoveredRefs.length > 0 ? [...patched, ...recoveredRefs] : patched;
        });
      }

      // PDF 복구 — pdfState 가 idle 이고 DB 에 PDF row 가 있으면 표시.
      const memDraft = _draftByProject.get(projectId);
      if (!memDraft?.pdfAttachmentId) {
        const pdfRow = dbRows.find(
          (r) => r.role === "brief" && r.kind === "pdf" && !!r.extracted_text,
        );
        if (pdfRow) {
          setPdfFileName(pdfRow.filename ?? "document.pdf");
          setPdfFileSize(pdfRow.size_bytes ?? 0);
          setPdfExtractedText(pdfRow.extracted_text ?? "");
          setPdfPageInfo({
            pages: pdfRow.page_count ?? 0,
            chars: (pdfRow.extracted_text ?? "").length,
          });
          setPdfState("ready");
          setPdfAttachmentId(pdfRow.id);
        }
      }

      /* (B) Migration — in-memory 항목 중 attachmentId 없는 것 업로드 -- */
      const draft = _draftByProject.get(projectId);
      if (!draft) return;

      // briefImages: base64 → Blob → addImageAttachment
      const migrateBriefImages = async () => {
        const updated: { index: number; attachmentId: string; fileUrl: string | null }[] = [];
        for (let i = 0; i < draft.briefImages.length; i++) {
          const img = draft.briefImages[i];
          if (img.attachmentId || dbById.has(img.attachmentId ?? "")) continue;
          if (!img.base64) continue; // 이미 storage URL preview 인 케이스
          try {
            const blob = base64ToBlob(img.base64, img.mediaType);
            const row = await addImageAttachment(projectId, blob, {
              role: "brief",
              filename: img.file?.name,
            });
            updated.push({ index: i, attachmentId: row.id, fileUrl: row.file_url });
          } catch (err) {
            console.warn("[BriefTab] migrate briefImage failed:", err);
          }
        }
        if (cancelled || updated.length === 0) return;
        // 업로드 성공분은 base64 를 비우고 preview 를 storage URL 로 교체 →
        // 다음 saveDraft 가 슬림 형식으로 저장되어 localStorage quota 누적 차단.
        setBriefImages((prev) =>
          prev.map((it, j) => {
            const u = updated.find((x) => x.index === j);
            if (!u) return it;
            return u.fileUrl
              ? { ...it, attachmentId: u.attachmentId, base64: "", preview: u.fileUrl }
              : { ...it, attachmentId: u.attachmentId };
          }),
        );
      };

      // refItems: kind 별로 분기
      const migrateRefItems = async () => {
        const updated: { id: string; attachmentId: string; fileUrl?: string | null }[] = [];
        for (const it of draft.refItems) {
          if (it.attachmentId) continue;
          try {
            if (it.kind === "image") {
              if (!it.base64) continue;
              const blob = base64ToBlob(it.base64, it.mediaType);
              const row = await addImageAttachment(projectId, blob, {
                role: "reference",
                filename: it.file?.name,
              });
              updated.push({ id: it.id, attachmentId: row.id, fileUrl: row.file_url });
            } else if (it.kind === "youtube") {
              const row = await addYoutubeAttachment(projectId, {
                role: "reference",
                url: it.url,
                videoId: it.videoId,
                title: it.title,
                channel: it.channel,
                thumbnailUrl: it.thumbnailUrl,
                transcript: it.transcript,
                durationSec: it.durationSec,
              });
              updated.push({ id: it.id, attachmentId: row.id });
            } else if (it.kind === "video") {
              if (!it.posterBase64) continue;
              // File 핸들이 사라진 케이스(새로고침 후) 가 보통이라 fileBlob 은
              // 가능하면 첨부, 없으면 poster + 메타만 남긴다.
              const posterBlob = base64ToBlob(it.posterBase64, "image/jpeg");
              const row = await addVideoAttachment(projectId, {
                role: "reference",
                filename: it.fileName,
                fileBlob: it.file,
                posterBlob,
                durationSec: it.durationSec,
                fileSize: it.fileSize,
                remoteUrl: it.remoteUrl,
              });
              updated.push({ id: it.id, attachmentId: row.id });
            }
          } catch (err) {
            console.warn("[BriefTab] migrate refItem failed:", err);
          }
        }
        if (cancelled || updated.length === 0) return;
        setRefItems((prev) =>
          prev.map((it) => {
            const u = updated.find((x) => x.id === it.id);
            if (!u) return it;
            // image 는 base64 를 비우고 preview 를 storage URL 로 교체 → 슬림 저장.
            if (it.kind === "image" && u.fileUrl) {
              return { ...it, attachmentId: u.attachmentId, base64: "", preview: u.fileUrl } as typeof it;
            }
            return { ...it, attachmentId: u.attachmentId } as typeof it;
          }),
        );
      };

      await Promise.allSettled([migrateBriefImages(), migrateRefItems()]);
    })();
    return () => {
      cancelled = true;
    };
    // 일회성 마운트당 동기화 — projectId 가 바뀌면 다시 실행.
    // 의도적으로 setter / supportsVideoFrames 등 비안정 deps 는 제외.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  /* ━━━━━ Reference 패널 — 모델 가용성 ━━━━━
   *  projectId 스코프를 명시해 프로젝트 override 가 있으면 그걸,
   *  없으면 global 디폴트를 따른다. (Settings 에서 디폴트를 바꿔도
   *  이 프로젝트에 override 가 있다면 유지.) */
  const [briefModelTick, setBriefModelTick] = useState(0);
  const briefModelMeta = useMemo(() => {
    const id = getModel("brief", projectId);
    return getModelMeta(id, getSettingsCached());
    // briefModelTick: picker 에서 변경이 발생하면 재계산.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, briefModelTick]);
  const supportsVideoFrames = !!briefModelMeta?.supportsVideoFrames;

  // 모델/설정이 바뀔 때마다 ignoredByModel 재계산
  useEffect(() => {
    setRefItems((prev) => recomputeIgnoredByModel(prev, supportsVideoFrames));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supportsVideoFrames]);

  // brief 모델 변경을 구독해서 리렌더 트리거 — 해당 projectId 스코프만.
  useEffect(() => {
    const unsub = subscribeModel("brief", () => setBriefModelTick((t) => t + 1), projectId);
    return unsub;
  }, [projectId]);

  const refCounts = useMemo(() => summarizeRefs(refItems), [refItems]);
  const REF_TOTAL_LIMIT = 8;

  const handleRefFileSelect = useCallback(
    async (files: FileList | null) => {
      if (!files) return;
      const slots = Math.max(0, REF_TOTAL_LIMIT - refItems.length);
      const arr = Array.from(files).slice(0, slots);
      for (const file of arr) {
        const isImage = ["image/jpeg", "image/png", "image/webp"].includes(file.type);
        const isVideo = ["video/mp4", "video/quicktime", "video/webm"].includes(file.type);

        if (isImage) {
          if (file.size > 10 * 1024 * 1024) {
            toast({ variant: "destructive", title: t("brief.toast.fileTooLarge"), description: t("brief.toast.maxImage10MB") });
            continue;
          }
          const base64 = await fileToBase64(file);
          // 영구 저장본 시도 — 실패해도 in-memory 항목은 추가됨.
          let attachmentId: string | undefined;
          try {
            const row = await addImageAttachment(projectId, file, {
              role: "reference",
              filename: file.name,
            });
            attachmentId = row.id;
          } catch (err) {
            console.warn("[BriefTab] addImageAttachment(ref) failed:", err);
          }
          const item: RefImageItem = {
            kind: "image",
            id: makeRefId("image"),
            addedAt: new Date().toISOString(),
            base64,
            mediaType: file.type,
            preview: toDataUrl(base64, file.type),
            file,
            ignoredByModel: false,
            attachmentId,
          };
          setRefItems((prev) => [...prev, item]);
          continue;
        }

        if (isVideo) {
          if (!supportsVideoFrames) {
            toast({
              variant: "destructive",
              title: t("brief.toast.videoNotSupported"),
              description: t("brief.toast.videoNotSupportedDesc"),
            });
            continue;
          }
          const v = validateVideoFile(file);
          if (!v.ok) {
            const reason = "reason" in v ? v.reason : "video rejected";
            toast({ variant: "destructive", title: t("brief.toast.videoRejected"), description: reason });
            continue;
          }
          const id = makeRefId("video");
          // Provisional entry — 메타/포스터 추출 중
          const provisional: RefVideoItem = {
            kind: "video",
            id,
            addedAt: new Date().toISOString(),
            fileName: file.name,
            fileSize: file.size,
            durationSec: 0,
            posterBase64: "",
            file,
            status: "sampling",
            ignoredByModel: !supportsVideoFrames,
          };
          setRefItems((prev) => [...prev, provisional]);
          try {
            const { meta, poster } = await extractFirstFrame(file);
            // 포스터 추출 직후 영구 저장 시도 — 실패해도 in-memory 는 유지.
            // 옛 구현은 File 핸들만 가지고 있어 새로고침 시 영상 자체가
            // 사라졌던 버그를 동시에 해소.
            let attachmentId: string | undefined;
            try {
              const posterBlob = await (async () => {
                const dataUrl = toDataUrl(poster.base64, poster.mediaType);
                const res = await fetch(dataUrl);
                return res.blob();
              })();
              const row = await addVideoAttachment(projectId, {
                role: "reference",
                filename: file.name,
                fileBlob: file,
                posterBlob,
                durationSec: meta.durationSec,
                fileSize: file.size,
              });
              attachmentId = row.id;
            } catch (uploadErr) {
              console.warn("[BriefTab] addVideoAttachment failed:", uploadErr);
            }
            setRefItems((prev) =>
              prev.map((it) =>
                it.id === id && it.kind === "video"
                  ? {
                      ...it,
                      durationSec: meta.durationSec,
                      posterBase64: poster.base64,
                      status: "ready" as const,
                      attachmentId,
                    }
                  : it,
              ),
            );
          } catch (err: any) {
            setRefItems((prev) =>
              prev.map((it) =>
                it.id === id && it.kind === "video"
                  ? { ...it, status: "error" as const, errorMsg: err?.message || "video probe failed" }
                  : it,
              ),
            );
          }
          continue;
        }

        toast({
          variant: "destructive",
          title: t("brief.toast.unsupportedFormat"),
          description: t("brief.toast.unsupportedFormatDescImg"),
        });
      }
    },
    // setRefItems / t 도 ESLint 가 요구하지만 setRefItems 는 useCallback 이 아닌
    // 평범한 함수라 deps 에 넣으면 매 렌더마다 새 ref → 이 useCallback 의 메모화
    // 자체가 무력화된다. PR-3 에서 setRefItems 를 useCallback 으로 승격시킨 뒤
    // dep 에 정식으로 넣을 예정.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refItems.length, supportsVideoFrames, toast, projectId],
  );

  const addYoutubeRef = useCallback(
    async (rawUrl: string) => {
      const url = rawUrl.trim();
      if (!url) return;
      if (!isYoutubeUrl(url)) {
        toast({ variant: "destructive", title: t("brief.toast.invalidUrl"), description: t("brief.toast.invalidUrlDesc") });
        return;
      }
      if (!supportsVideoFrames) {
        toast({
          variant: "destructive",
          title: t("brief.toast.youtubeNotSupported"),
          description: t("brief.toast.youtubeNotSupportedDesc"),
        });
        return;
      }
      if (refItems.length >= REF_TOTAL_LIMIT) {
        toast({ variant: "destructive", title: t("brief.toast.limitReached"), description: t("brief.toast.limitReachedDesc", { n: REF_TOTAL_LIMIT }) });
        return;
      }
      const m = url.match(YOUTUBE_URL_REGEX);
      const videoId = m?.[1] ?? "";
      const id = makeRefId("youtube");
      const provisional: RefYoutubeItem = {
        kind: "youtube",
        id,
        addedAt: new Date().toISOString(),
        url,
        videoId,
        status: "loading",
        ignoredByModel: !supportsVideoFrames,
      };
      setRefItems((prev) => [...prev, provisional]);
      try {
        const ingested = await ingestYoutube(url);
        // 영구 저장본 시도 — 실패해도 in-memory 항목은 유지.
        let attachmentId: string | undefined;
        try {
          const row = await addYoutubeAttachment(projectId, {
            role: "reference",
            url,
            videoId: ingested.videoId,
            title: ingested.title,
            channel: ingested.channel,
            thumbnailUrl: ingested.thumbnailUrl,
            transcript: ingested.transcript,
            durationSec: ingested.durationSec,
          });
          attachmentId = row.id;
        } catch (uploadErr) {
          console.warn("[BriefTab] addYoutubeAttachment failed:", uploadErr);
        }
        setRefItems((prev) =>
          prev.map((it) =>
            it.id === id && it.kind === "youtube"
              ? {
                  ...it,
                  videoId: ingested.videoId,
                  title: ingested.title,
                  channel: ingested.channel,
                  thumbnailUrl: ingested.thumbnailUrl,
                  transcript: ingested.transcript,
                  durationSec: ingested.durationSec,
                  status: "ready" as const,
                  attachmentId,
                }
              : it,
          ),
        );
      } catch (err: any) {
        setRefItems((prev) =>
          prev.map((it) =>
            it.id === id && it.kind === "youtube"
              ? { ...it, status: "error" as const, errorMsg: err?.message || "ingest failed" }
              : it,
          ),
        );
      }
    },
    // 위 addImageRef 와 동일 사유 — setRefItems 가 plain 함수라 deps 에 넣으면
    // 매 렌더마다 메모화 깨짐. PR-3 에서 정식 처리.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refItems.length, supportsVideoFrames, toast, projectId],
  );

  const removeRefItem = (id: string) =>
    setRefItems((prev) => {
      // 영구 저장본도 같이 삭제 — 실패해도 UI 는 막지 않고 orphan sweep 가 정리.
      const target = prev.find((it) => it.id === id);
      if (target?.attachmentId) {
        void deleteBriefAttachment(target.attachmentId).catch((err) =>
          console.warn("[BriefTab] deleteBriefAttachment failed:", err),
        );
      }
      // 라이브러리에서 가져온 자료(`library_<refId>`) 라면 project_reference_links
      // 도 같이 정리. 이렇게 안 하면 사용자가 Brief 에서 자료를 빼도 라이브러리
      // 인스펙터의 "이 자료 N개 프로젝트에서 사용 중" 카운트와 「최근 사용」
      // 사이드바가 영영 부풀어 있게 된다. 실패해도 UI 는 막지 않음 — link 행은
      // 추적용일 뿐 사용자 데이터(refItems / brief_attachments) 는 이미 정리됨.
      if (target && projectId && target.id.startsWith("library_")) {
        const refId = target.id.slice("library_".length);
        if (refId) {
          void unlinkReferenceFromProject({
            projectId,
            referenceId: refId,
            target: "brief",
          }).catch((err) =>
            console.warn("[BriefTab] unlinkReferenceFromProject failed:", err),
          );
        }
      }
      return prev.filter((it) => it.id !== id);
    });
  const setRefItemAnnotation = (id: string, annotation: RefAnnotation | undefined) =>
    setRefItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it;
        // hasAnnotation 기준으로 비어있으면 아얘 필드 제거해서 저장 용량/노이즈 최소화.
        const next = hasAnnotation(annotation) ? annotation : undefined;
        // DB 행에도 annotation 변경 반영 (영구 저장본이 있을 때만).
        if (it.attachmentId) {
          void updateBriefAttachment(it.attachmentId, {
            annotation: next
              ? {
                  rangeText: next.rangeText,
                  startSec: next.startSec,
                  endSec: next.endSec,
                  notes: next.notes,
                }
              : null,
          }).catch((err) => console.warn("[BriefTab] updateBriefAttachment failed:", err));
        }
        return { ...it, annotation: next } as typeof it;
      }),
    );
  const removeBriefImage = (i: number) =>
    setBriefImages((prev) => {
      const target = prev[i];
      if (target?.attachmentId) {
        void deleteBriefAttachment(target.attachmentId).catch((err) =>
          console.warn("[BriefTab] deleteBriefAttachment failed:", err),
        );
      }
      return prev.filter((_, j) => j !== i);
    });

  const extractTextFromPDF = async (file: File) => {
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      pages.push(`[${i}페이지]\n${(tc.items as any[]).map((it) => it.str).join(" ")}`);
    }
    const full = pages.join("\n\n");
    if (full.trim().length < 50) throw new Error("Not enough text extracted");
    return { text: full.length > 8000 ? full.slice(0, 8000) + "\n\n[truncated]" : full, pages: pdf.numPages };
  };

  const handlePDFUpload = useCallback(
    async (file: File) => {
      if (file.size > 20 * 1024 * 1024) {
        toast({ variant: "destructive", title: t("brief.toast.fileTooLarge"), description: t("brief.toast.maxPdf20MB") });
        return;
      }
      if (file.type !== "application/pdf") {
        toast({ variant: "destructive", title: t("brief.toast.unsupportedFormat"), description: t("brief.toast.unsupportedFormatDescPdf") });
        return;
      }
      setPdfFileName(file.name);
      setPdfFileSize(file.size);
      setPdfState("extracting");
      try {
        const { text, pages } = await extractTextFromPDF(file);
        setPdfExtractedText(text);
        setPdfPageInfo({ pages, chars: text.length });
        setPdfState("ready");
        // PDF 본체와 추출 텍스트를 영구 저장 — 실패해도 분석 흐름은 계속 진행.
        try {
          const row = await addPdfAttachment(projectId, file, {
            role: "brief",
            filename: file.name,
            extractedText: text,
            pageCount: pages,
          });
          setPdfAttachmentId(row.id);
        } catch (uploadErr) {
          console.warn("[BriefTab] addPdfAttachment failed:", uploadErr);
        }
      } catch {
        setPdfState("error");
      }
    },
    // setPdf* 다섯 개와 t 가 빠져 있다. setPdf* 는 plain 함수라 deps 에 넣으면
    // 매 렌더마다 새 ref → useCallback 메모화 무력화. PR-3 에서 setPdf* 를
    // useCallback 으로 승격시키며 함께 정식 처리.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toast, projectId],
  );

  const resetPdf = () => {
    if (pdfAttachmentId) {
      void deleteBriefAttachment(pdfAttachmentId).catch((err) =>
        console.warn("[BriefTab] deleteBriefAttachment(pdf) failed:", err),
      );
    }
    setPdfState("idle");
    setPdfExtractedText("");
    setPdfFileName("");
    setPdfFileSize(0);
    setPdfPageInfo(null);
    setPdfAttachmentId(undefined);
  };

  const handleComposerDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setComposerDragOver(false);
      const files = e.dataTransfer.files;
      if (!files?.length) return;
      const pdfs = Array.from(files).filter((f) => f.type === "application/pdf");
      const imgs = Array.from(files).filter((f) => ["image/jpeg", "image/png", "image/webp"].includes(f.type));
      if (pdfs[0]) handlePDFUpload(pdfs[0]);
      for (const file of imgs.slice(0, 3 - briefImages.length)) {
        if (file.size > 10 * 1024 * 1024) {
          toast({ variant: "destructive", title: t("brief.toast.fileTooLarge"), description: t("brief.toast.maxFile10MB") });
          continue;
        }
        const base64 = await fileToBase64(file);
        // brief_attachments 로 영구 저장 — 실패하면 LS-only 로 fallback (이전 동작).
        // 성공 시 attachmentId 가 부여돼 quota/디바이스 이전/export 에 안전.
        let attachmentId: string | undefined;
        try {
          const row = await addImageAttachment(projectId, file, {
            role: "brief",
            filename: file.name,
          });
          attachmentId = row.id;
        } catch (err) {
          console.warn("[BriefTab] addImageAttachment(composer) failed:", err);
        }
        setBriefImages((prev) => [
          ...prev,
          { file, base64, mediaType: file.type, preview: toDataUrl(base64, file.type), attachmentId },
        ]);
      }
    },
    // setBriefImages 와 t 도 ESLint 요구지만 setBriefImages 는 plain 함수.
    // PR-3 에서 useCallback 으로 승격시키며 함께 dep 에 정식 추가.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [briefImages.length, handlePDFUpload, toast, projectId],
  );

  const canAnalyze = briefText.trim().length > 0 || pdfState === "ready" || briefImages.length > 0;

  const handleAnalyze = async () => {
    if (!canAnalyze) return;
    // 동일 프로젝트에 진행 중인 분석이 있으면 중복 호출 방지 — 다른 라우트
    // 다녀온 사이 진행 중이던 분석이 살아 있을 수 있어 버튼 가드만으로는
    // 부족하므로 레지스트리로 한 번 더 체크.
    if (briefAnalysisRegistry.isAnalyzing(projectId)) return;
    briefAnalysisRegistry.begin(projectId);
    setAnalyzing(true);
    setAnalyzingStartedAt(briefAnalysisRegistry.startedAt(projectId));
    try {
      // settings 캐시를 미리 로드해서 ModelMeta 가용성/maxTokens 가 정확히 결정되도록
      await ensureSettingsLoaded();
      const briefModelId = getModel("brief", projectId);
      const briefMeta = getModelMeta(briefModelId, getSettingsCached());
      const modelSupportsVideo = !!briefMeta?.supportsVideoFrames;

      let result: DeepAnalysis;
      let currentSourceType: "text" | "pdf" | "image";
      const imageAnalysis = "";
      let videoInsightsBlock = "";

      // ── 1) 이미지 레퍼런스: 선택한 브리프 모델이 직접 함께 읽는다 ──
      const refImagesUsable = refItems.filter(
        (it): it is RefImageItem => it.kind === "image" && !it.ignoredByModel,
      );

      // ── 2) YouTube/Video 레퍼런스: GPT-5.x 일 때만 텍스트 + 프레임 첨부 ──
      const youtubesUsable = refItems.filter(
        (it): it is RefYoutubeItem => it.kind === "youtube" && !it.ignoredByModel && it.status === "ready",
      );
      const videosUsable = refItems.filter(
        (it): it is RefVideoItem => it.kind === "video" && !it.ignoredByModel && it.status === "ready",
      );
      // 비디오 프레임을 in-place 로 샘플링 (분석 직전에만)
      const sampledVideos: Array<{ item: RefVideoItem; frames: { base64: string; mediaType: string; t: number }[] }> = [];
      if (modelSupportsVideo) {
        for (const v of videosUsable) {
          if (!v.file) {
            // 파일 핸들이 사라진 경우 — poster 만이라도 사용
            sampledVideos.push({ item: v, frames: v.posterBase64 ? [{ base64: v.posterBase64, mediaType: "image/png", t: 0 }] : [] });
            continue;
          }
          try {
            const targetCount = v.durationSec > 60 ? 12 : 8;
            // 사용자가 관심 구간을 지정했다면 그 구간 안에서 dense 샘플링.
            // parseTimeRange 가 성공한 경우에만 startSec/endSec 가 채워져 있음.
            const ann = v.annotation;
            const range =
              ann && typeof ann.startSec === "number" && typeof ann.endSec === "number"
                ? { startSec: ann.startSec, endSec: ann.endSec }
                : undefined;
            const { frames } = await sampleFrames(v.file, targetCount, range);
            sampledVideos.push({ item: v, frames: frames.map((f) => ({ base64: f.base64, mediaType: f.mediaType, t: f.t })) });
          } catch {
            sampledVideos.push({ item: v, frames: v.posterBase64 ? [{ base64: v.posterBase64, mediaType: "image/png", t: 0 }] : [] });
          }
        }
      }

      // 텍스트 인서트: youtube 메타/자막 + video 메타 + 사용자 부연설명
      const ytLines: string[] = [];
      for (const yt of youtubesUsable) {
        const head = `- [YouTube] ${yt.title || yt.url} ${yt.channel ? `· ${yt.channel}` : ""} (${yt.videoId})`;
        const annLines = formatAnnotationLines(yt.annotation, { includeRange: true }); // YT 는 샘플링 없이 텍스트 힌트로만 반영
        const transcript = yt.transcript ? `\n  Transcript (excerpt): ${yt.transcript.slice(0, 1500)}${yt.transcript.length > 1500 ? "…" : ""}` : "";
        ytLines.push([head, ...annLines].join("\n") + transcript);
      }
      const vidLines: string[] = sampledVideos.map(({ item, frames }) => {
        const ann = item.annotation;
        const rangeApplied =
          ann && typeof ann.startSec === "number" && typeof ann.endSec === "number";
        const head = `- [Video] ${item.fileName} · ${Math.round(item.durationSec)}s · ${frames.length} frames sampled${rangeApplied ? ` (dense-sampled within ${ann!.rangeText})` : ""}`;
        // 구간은 head 에 이미 반영했으니 본문에는 포인트만.
        const annLines = formatAnnotationLines(ann, { includeRange: !rangeApplied });
        return [head, ...annLines].join("\n");
      });
      // 이미지 레퍼런스 부연설명 — 이미지 자체와 함께 메인 분석 모델에 전달한다.
      // 사용자가 적은 포인트는 텍스트 힌트로 합류시켜 가중치를 높인다.
      const imgNoteLines: string[] = [];
      const imageIdxMap = new Map<string, number>();
      {
        let idx = 1;
        for (const it of refItems) {
          if (it.kind === "image") {
            imageIdxMap.set(it.id, idx);
            idx++;
          }
        }
      }
      for (const [id, n] of imageIdxMap) {
        const img = refItems.find((it) => it.id === id) as RefImageItem | undefined;
        if (!img || !hasAnnotation(img.annotation)) continue;
        const annLines = formatAnnotationLines(img.annotation, { includeRange: false });
        if (annLines.length === 0) continue;
        imgNoteLines.push([`- Image ${n}`, ...annLines].join("\n"));
      }
      if (ytLines.length || vidLines.length || imgNoteLines.length) {
        // 사용자가 어느 레퍼런스 하나에라도 부연설명을 달았으면, 분석기가 이를
        // 강한 힌트로 반영하도록 상단에 지시문 한 줄을 붙인다. 부연설명이 전혀
        // 없는 일반 케이스에서는 지시문을 생략해 불필요한 톤 변경을 피함.
        const hasAnyUserNotes = refItems.some((it) => hasAnnotation(it.annotation));
        const directive = hasAnyUserNotes
          ? "Each reference below may carry a 'Time range' and 'Focus points' — these are explicit, user-highlighted learning points. Prioritize extracting the technique, timing and staging from those sections over other elements.\n\n"
          : "";
        videoInsightsBlock = directive + [
          ytLines.length ? `### YouTube References\n${ytLines.join("\n")}` : "",
          vidLines.length ? `### Video References\n${vidLines.join("\n")}` : "",
          imgNoteLines.length ? `### Image Reference Notes\n${imgNoteLines.join("\n")}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");
      }

      // 모델이 video 를 지원 안 하는데 사용자가 (모델 변경 전) 등록만 해둔 경우
      const ignoredVideoCount = refItems.filter((it) => it.ignoredByModel).length;
      if (ignoredVideoCount > 0) {
        toast({
          title: t("brief.toast.someSkipped"),
          description: t("brief.toast.someSkippedDesc", { n: ignoredVideoCount }),
        });
      }

      // ── 3) 모델 호출: 모든 시각 레퍼런스는 선택한 브리프 모델이 일관되게 분석 ──
      const extraFrameImages: BriefAnalysisImage[] = modelSupportsVideo
        ? sampledVideos.flatMap(({ item, frames }) =>
            frames.map((frame) => ({
              base64: frame.base64,
              mediaType: frame.mediaType,
              label: `위 이미지는 영상 레퍼런스 "${item.fileName}"의 ${frame.t.toFixed(1)}초 프레임입니다.`,
            })),
          ).slice(0, 16) // 안전 상한
        : [];
      const refImageInputs: BriefAnalysisImage[] = briefMeta?.supportsVision
        ? (
            await Promise.all(
              refImagesUsable.map(async (img, index) => {
                const { base64, mediaType } = await resolveAnalysisBase64(img);
                return {
                  base64,
                  mediaType,
                  label: `위 이미지는 레퍼런스 이미지 ${index + 1}입니다. 브리프 원본이 아니라 시각 스타일, 분위기, 구성, 연출 힌트로만 참고하세요.`,
                };
              }),
            )
          ).filter((i) => !!i.base64)
        : [];

      // 사용자 브리프 본문 이미지 — 슬림 항목은 storage URL 로 지연 fetch.
      const briefImageInputs: BriefAnalysisImage[] = (
        await Promise.all(
          briefImages.map(async (i, index) => {
            const { base64, mediaType } = await resolveAnalysisBase64(i);
            return {
              base64,
              mediaType,
              label: `위 이미지는 사용자가 첨부한 브리프 이미지 ${index + 1}입니다.`,
            };
          }),
        )
      ).filter((i) => !!i.base64);

      if (briefImageInputs.length > 0 || refImageInputs.length > 0 || extraFrameImages.length > 0) {
        const allImages: BriefAnalysisImage[] = [
          ...briefImageInputs,
          ...refImageInputs,
          ...extraFrameImages,
        ];
        result = await analyzeBriefWithImages(
          allImages,
          [
            briefText.trim(),
            imageAnalysis ? `스타일 레퍼런스 분석: ${imageAnalysis}` : "",
            videoInsightsBlock ? `영상 레퍼런스 인사이트:\n${videoInsightsBlock}` : "",
            ideaNote.trim() ? `크리에이터 아이디어 메모: ${ideaNote.trim()}` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
          analysisLang,
          briefModelId,
        );
        currentSourceType = "image";
      } else if (pdfState === "ready") {
        let txt = `[PDF 브리프: ${pdfFileName}]\n\n${pdfExtractedText}`;
        if (briefText.trim()) txt += `\n\n## 추가 텍스트\n${briefText.trim()}`;
        if (imageAnalysis) txt += `\n\n## 첨부 이미지 스타일 분석\n${imageAnalysis}`;
        if (videoInsightsBlock) txt += `\n\n## 영상 레퍼런스 인사이트\n${videoInsightsBlock}`;
        if (ideaNote.trim()) txt += `\n\n## 크리에이터 아이디어 메모\n${ideaNote.trim()}`;
        result = await analyzeBriefText(txt, analysisLang, briefModelId);
        currentSourceType = "pdf";
      } else {
        let txt = briefText.trim();
        if (imageAnalysis) txt += `\n\n## 첨부 이미지 스타일 분석\n${imageAnalysis}`;
        if (videoInsightsBlock) txt += `\n\n## 영상 레퍼런스 인사이트\n${videoInsightsBlock}`;
        if (ideaNote.trim()) txt += `\n\n## 크리에이터 아이디어 메모\n${ideaNote.trim()}`;
        result = await analyzeBriefText(txt, analysisLang, briefModelId);
        currentSourceType = "text";
      }

      if (ideaNote.trim()) result.idea_note = ideaNote.trim();
      if (imageAnalysis) result.image_analysis = imageAnalysis;

      setAnalysis(result);
      setAnalysisEn(null); // invalidate EN cache
      // ★ analysisLang은 유지 — 사용자가 선택한 언어 보존
      setSourceType(currentSourceType);
      setAnalyzedAt(new Date().toISOString());

      // image_urls 는 의도적으로 payload 에서 제외. 옛 구현은 매 재분석마다
      // `image_urls: null` 로 강제 초기화해 — 향후 brief_attachments 마이그레이션
      // 으로 들어올 storage URL 까지 같이 날려버리는 데이터 손실 경로가 됐다.
      // 재분석은 텍스트 분석 결과만 갱신하면 충분하며, 첨부 자료의 수명은
      // 사용자의 명시적 add/remove 액션이 단일 진실 소스다.
      //
      // analysis_en: null 은 그대로 둔다 — 영문 번역 캐시는 옛 분석본을 기준으로
      // 만들어졌으므로 새 분석이 들어오면 진짜로 stale. 다음 EN 토글 시 lazy
      // 재번역이 자동으로 일어난다.
      const payload: Record<string, unknown> = {
        raw_text: pdfState === "ready" ? pdfExtractedText : briefText.trim(),
        analysis: result,
        analysis_en: null,
        lang: analysisLang, // ★ DB에 lang 저장
        source_type: currentSourceType,
      };

      if (existingBrief) {
        await supabase.from("briefs").update(payload).eq("id", existingBrief.id);
      } else {
        const { data: nb } = await supabase
          .from("briefs")
          .insert({ project_id: projectId, ...payload })
          .select()
          .single();
        if (nb) setExistingBrief(nb as unknown as Brief);
      }
    } catch {
      toast({
        variant: "destructive",
        title: t("brief.toast.analysisError"),
        description: t("brief.toast.analysisErrorDesc"),
      });
    } finally {
      // loader 가 100% 스냅 연출 후 사라지도록 lingering 플래그 on —
      // AnalysisLoader onHidden 에서 off.
      // briefAnalysisRegistry.end 가 동기적으로 subscriber 를 호출해
      // setLoaderLingering(true) + setAnalyzing(false) 를 트리거한다.
      // 명시적 set 호출은 분석을 시작한 BriefTab 인스턴스가 이미 언마운트된
      // 케이스에서도 레지스트리 알림이 새 마운트에 도달하므로 안전망 역할.
      briefAnalysisRegistry.end(projectId);
      setLoaderLingering(true);
      setAnalyzing(false);
    }
  };

  /* 자동 분석 트리거 — "스마트 브리프 매치 → 프로젝트 내보내기" 가 남긴 플래그가
     있으면, 콘텐츠(브리프 텍스트/이미지/레퍼런스)가 하이드레이션된 직후 분석을
     1회 자동 실행한다. 다이얼로그에서 블로킹 대기하는 대신 여기 로딩바로 진행되어
     체감 지연이 줄고, 사용자는 재분석을 선택적으로 다시 할 수 있다. */
  const autoAnalyzeConsumedRef = useRef(false);
  useEffect(() => {
    if (autoAnalyzeConsumedRef.current) return;
    const key = `ff_brief_autoanalyze_${projectId}`;
    let flag: string | null = null;
    try {
      flag = localStorage.getItem(key);
    } catch {
      return;
    }
    if (!flag) return;
    const consume = () => {
      autoAnalyzeConsumedRef.current = true;
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    };
    // 이미 분석 결과가 있거나 진행 중이면 플래그만 소비.
    if (analysis || briefAnalysisRegistry.isAnalyzing(projectId)) {
      consume();
      return;
    }
    // 콘텐츠가 아직 하이드레이션되지 않았으면(canAnalyze=false) 다음 렌더까지 대기.
    if (!canAnalyze) return;
    consume();
    void handleAnalyze();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, canAnalyze, analysis]);

  const copyAll = () => {
    if (!analysis) return;
    let text: string;
    if (isDeepAnalysis(analysis)) {
      const a = analysis;
      text = [
        `캠페인 목표: ${a.goal.summary}\n${a.goal.items.map((g) => `• ${g}`).join("\n")}`,
        `타겟: ${a.target.summary}\n${a.target.primary.map((t) => `• ${t}`).join("\n")}`,
        `USP: ${a.usp.summary}\n${a.usp.items.map((u) => `• ${u}`).join("\n")}`,
        `톤앤매너: ${a.tone_manner.summary}\n키워드: ${a.tone_manner.keywords.join(", ")}`,
        `제작 노트\n포맷: ${a.production_notes.format_recommendation}`,
      ].join("\n\n");
    } else {
      const l = analysis as LegacyAnalysis;
      text = [
        `목표:\n${l.goal.map((g) => `• ${g}`).join("\n")}`,
        `타겟:\n${l.target.map((t) => `• ${t}`).join("\n")}`,
        `USP:\n${l.usp.map((u) => `• ${u}`).join("\n")}`,
        `톤앤매너:\n${l.tone_manner.map((t) => `• ${t}`).join("\n")}`,
      ].join("\n\n");
    }
    navigator.clipboard.writeText(text);
    toast({ title: t("brief.toast.copied"), description: t("brief.toast.copiedDesc") });
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  const hasAnalysis = !!analysis && !analyzing;
  // 분석 후에도 크리에이티브 입력 패널을 접지 않는다(사용자 요청). 폭은
  // briefPanelWidth(드래그 리사이즈) 로 사용자가 직접 조절한다. 과거에는
  // hasAnalysis 시 좁은 collapsible 모드로 전환됐다.
  const isCollapsedMode = false;

  const briefTextPreview = briefText.trim()
    ? briefText.trim().slice(0, 60) + (briefText.trim().length > 60 ? "…" : "")
    : "Empty";
  const moodboardPreview = refItems.length > 0 ? summarizeRefsLabel(refCounts) || `${refItems.length} item${refItems.length > 1 ? "s" : ""}` : "Empty";
  const ideaNotePreview = ideaNote.trim()
    ? ideaNote.trim().slice(0, 60) + (ideaNote.trim().length > 60 ? "…" : "")
    : "Empty";

  const renderBriefTextContent = () => (
    <>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setComposerDragOver(true);
        }}
        onDragLeave={() => setComposerDragOver(false)}
        onDrop={handleComposerDrop}
        className={`overflow-hidden border bg-input transition-colors ${composerDragOver ? "border-primary/50" : "border-input focus-within:border-primary/50"}`}
        style={{
          borderRadius: 0,
          ...(composerDragOver ? { background: "rgba(249,66,58,0.04)" } : {}),
        }}
      >
        <textarea
          value={briefText}
          onChange={(e) => setBriefText(e.target.value.slice(0, 5000))}
          placeholder={t("brief.briefPlaceholder")}
          className={`w-full border-none outline-none resize-none text-meta font-[inherit] text-foreground bg-transparent px-3 pt-3 pb-2 leading-relaxed placeholder:text-muted-foreground/40 ${isCollapsedMode ? "h-[100px]" : "h-[140px]"}`}
        />
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-t border-border bg-input">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="1.5">
            <path d="M3 10l3-3 3 3M9 7l3-3 3 3" />
            <path d="M1 13h14" />
          </svg>
          <span className="font-mono text-2xs text-muted-foreground/40">{t("brief.attachHint")}</span>
          <span className="ml-auto font-mono text-2xs text-muted-foreground/30">{briefText.length} / 5000</span>
        </div>
      </div>

      {briefImages.length > 0 && (
        <div className="border border-border p-2" style={{ borderRadius: 0 }}>
          <p className="label-meta text-muted-foreground mb-1.5">{t("brief.briefImages")}</p>
          <div className="flex gap-2 flex-wrap">
            {briefImages.map((img, i) => (
              <div key={i} className="relative group">
                <img
                  src={img.preview}
                  alt=""
                  onClick={() => setLightboxSrc(img.preview)}
                  className="h-[56px] w-[56px] object-cover border border-border cursor-zoom-in"
                  style={{ borderRadius: 0 }} loading="lazy" decoding="async" />
                <button
                  onClick={() => removeBriefImage(i)}
                  className="absolute top-0 right-0 w-4 h-4 bg-primary text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{ borderRadius: 0 }}
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </div>
            ))}
            {briefImages.length < 3 && (
              <div
                className="h-[56px] w-[56px] border border-dashed border-border flex flex-col items-center justify-center gap-0.5"
                style={{ borderRadius: 0 }}
              >
                <span className="font-mono text-micro text-muted-foreground/30">{t("brief.drop")}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {pdfState === "extracting" && (
        <div className="flex items-center gap-2 px-3 py-2.5 bg-input border border-border" style={{ borderRadius: 0 }}>
          <FileText className="w-4 h-4 text-primary shrink-0" />
          <span className="font-mono text-caption text-muted-foreground flex-1 truncate">{pdfFileName}</span>
          <div className="w-20 h-1 bg-border overflow-hidden" style={{ borderRadius: 0 }}>
            <div className="h-full bg-primary animate-pulse" style={{ width: "70%", borderRadius: 0 }} />
          </div>
        </div>
      )}
      {pdfState === "ready" && (
        <div className="flex items-center gap-2 px-3 py-2.5 bg-input border border-border" style={{ borderRadius: 0 }}>
          <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-meta text-foreground truncate font-medium">{pdfFileName}</p>
            {pdfPageInfo && (
              <p className="font-mono text-2xs text-muted-foreground">
                {pdfPageInfo.pages}P · {pdfPageInfo.chars.toLocaleString()} CHARS
              </p>
            )}
          </div>
          <button onClick={resetPdf} className="text-muted-foreground hover:text-foreground transition-colors shrink-0">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {pdfState === "error" && (
        <div
          className="flex items-center gap-2 px-3 py-2.5 border"
          style={{ borderRadius: 0, background: "rgba(249,66,58,0.06)", borderColor: "rgba(249,66,58,0.2)" }}
        >
          <AlertCircle className="w-4 h-4 text-primary shrink-0" />
          <p className="font-mono text-2xs text-primary flex-1">{t("brief.pdfExtractFailed")}</p>
          <button onClick={resetPdf} className="text-caption text-primary underline shrink-0">
            {t("common.close")}
          </button>
        </div>
      )}
    </>
  );

  /** 라이브러리 워크스페이스로 전환 + returnTo=현재 프로젝트.
   *
   *  선택 우선순위:
   *  1) `lastActive[library]` 슬롯에 기록된 ID (사용자가 한 번이라도 활성화 한
   *     적이 있는 라이브러리).
   *  2) 슬롯이 비어있으면 등록된 워크스페이스 중 kind="library" 인 것.
   *     - 1개: 그것을 자동 활성화.
   *     - 2개 이상: 일단 첫 번째 활성화 + 안내 토스트 (정확한 선택은 라이브러리
   *       내부의 WorkspaceSwitcher 에서).
   *     - 0개: 토스트로 "라이브러리 워크스페이스를 먼저 만드세요" 안내. */
  const handleGoToLibrary = useCallback(async () => {
    // returnTo 에 `tab` (어느 탭에서 진입했는지) 과 `ws` (현재 프로젝트의
    // 워크스페이스 id) 를 query 로 포함. 칩 클릭 시 이 정보로 워크스페이스
    // 전환 + 같은 탭으로 복귀. 추후 Asset/Conti 탭에서 같은 helper 가 생기면
    // sourceTab 만 바꿔 호출.
    const sourceTab = "brief";
    const activeWsId = getCachedActiveId();
    const wsQuery = activeWsId ? `&ws=${encodeURIComponent(activeWsId)}` : "";
    const returnTo = `/project/${projectId}?tab=${sourceTab}${wsQuery}`;
    const target = `/library?returnTo=${encodeURIComponent(returnTo)}`;

    // sessionStorage 백업 — activateWorkspace 가 hard navigation (location.href)
    // 을 수행하면서 search query 가 유실되는 케이스가 있다 (HashRouter + Electron
    // 환경). WorkspaceSwitcher 와 동일한 RETURN_TO_KEY 로 저장해 두면 LibraryPage
    // 의 getReturnTo() fallback 이 returnProjectId 를 복원하므로, 우클릭→Brief 시
    // 즉시 attach (picker 안 뜸).
    //
    // sourceTab 도 별도 키로 백업: 복귀 시 URL 의 `?tab=brief` 가 HashRouter
    // 파싱 단계에서 유실되어도 ProjectPage 가 sessionStorage fallback 으로
    // initialTab 을 복원할 수 있게 한다.
    try {
      sessionStorage.setItem("preflow.library.returnTo", returnTo);
      sessionStorage.setItem("preflow.return.sourceTab", sourceTab);
    } catch {
      /* private mode 등 — 실패해도 흐름 자체는 진행 */
    }

    // 캐시가 비어있을 가능성 (앱 부팅 직후) — 최초 1회 fetch 보장.
    await ensureWorkspacesLoaded();

    let lib = getCachedLastActiveByKind("library");
    if (!lib) {
      const libs = getCachedWorkspaces().filter((w) => w.kind === "library");
      if (libs.length === 0) {
        toast({
          variant: "destructive",
          title: t("brief.toast.libraryWorkspaceMissing"),
          description: t("brief.toast.libraryWorkspaceMissingDesc"),
        });
        return;
      }
      if (libs.length > 1) {
        toast({
          title: t("brief.toast.multipleLibraries"),
          description: t("brief.toast.multipleLibrariesDesc"),
        });
      }
      lib = libs[0];
    }

    try {
      await activateWorkspace(lib.id, false, target);
      // 성공 시 activateWorkspace 가 location.href 로 이동시킴.
    } catch (err) {
      console.error("[brief] go to library failed:", err);
      toast({
        variant: "destructive",
        title: t("brief.toast.openLibraryFailed"),
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }, [projectId, toast, t]);

  const renderMoodboardContent = () => {
    const acceptAttr = supportsVideoFrames
      ? "image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm"
      : "image/jpeg,image/png,image/webp";
    const dropHintLabel = supportsVideoFrames
      ? t("brief.refDropVideo")
      : t("brief.refDropImageOnly");
    const slotsLeft = REF_TOTAL_LIMIT - refItems.length;

    const renderTile = (item: RefItem) => {
      const ignored = !!item.ignoredByModel;
      const tileBaseStyle: React.CSSProperties = {
        borderRadius: 0,
        opacity: ignored ? 0.4 : 1,
        filter: ignored ? "grayscale(100%)" : undefined,
      };
      const annotated = hasAnnotation(item.annotation);
      const includeRange = item.kind !== "image";
      // 라이브러리에서 가져온 자료인지 판정 — `library_<refId>` prefix 가 단일
      // 출처 신호. 출처 배지(우상단 인사이드, X 버튼 outside corner 와 겹치지
      // 않게 배치) + 클릭으로 라이브러리 역방향 점프.
      const libraryRefId = item.id.startsWith("library_") ? item.id.slice("library_".length) : null;
      const openInLibrary = libraryRefId
        ? () => {
            const activeWsId = getCachedActiveId();
            const wsQuery = activeWsId ? `&ws=${encodeURIComponent(activeWsId)}` : "";
            const returnTo = `/project/${projectId}?tab=brief${wsQuery}`;
            const target = `/library?returnTo=${encodeURIComponent(returnTo)}&focus=${encodeURIComponent(libraryRefId)}`;
            try {
              sessionStorage.setItem("preflow.library.returnTo", returnTo);
              sessionStorage.setItem("preflow.return.sourceTab", "brief");
            } catch {
              /* private mode 등 — 폴백 흐름 유지 */
            }
            void (async () => {
              // workspace 가 같으면 직접 navigate, 다르면 handleGoToLibrary 와
              // 동일하게 library workspace 로 전환. 단순화를 위해 활성
              // workspace 가 *현재* 인 경우만 빠른 직행 — 라이브러리 출처는
              // 다른 workspace 일 가능성이 더 높지만, 두 케이스 모두 같은 URL
              // 로 도달하면 LibraryPage 의 focus 파라미터가 동작한다.
              await ensureWorkspacesLoaded();
              const lib = getCachedLastActiveByKind("library");
              if (lib && lib.id !== activeWsId) {
                await activateWorkspace(lib.id, false, target);
                return;
              }
              // 같은 workspace 면 그냥 SPA navigate.
              window.location.hash = target;
            })();
          }
        : null;
      // 공통 오버레이: 주석 인디케이터(좌하단 점) + 연필 아이콘(우하단 hover)
      //               + 라이브러리 배지(좌상단, 클릭으로 라이브러리 역방향 점프).
      // 라이브러리 배지가 좌상단을 차지하면 YT/VID 배지는 그 옆(14px shift)
      // 으로 밀려 나란히 배치됨 — 좌상단을 "출처/종류 정보 영역" 으로 통일.
      // 모든 in-tile 배지는 h-3.5(14px) 로 높이 통일해 시각적 줄맞춤 유지.
      const overlayControls = (
        <>
          {annotated && !ignored && (
            <span
              className="pointer-events-none absolute bottom-0.5 left-0.5 w-1.5 h-1.5 bg-primary"
              style={{ borderRadius: "9999px" }}
              aria-hidden
            />
          )}
          {libraryRefId && openInLibrary && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                openInLibrary();
              }}
              className="absolute top-0 left-0 h-3.5 w-3.5 bg-black/70 hover:bg-black/90 text-white flex items-center justify-center transition-colors opacity-90 group-hover:opacity-100"
              style={{ borderRadius: 0 }}
              title={`${t("brief.refFromLibraryTitle")} — ${t("brief.refOpenInLibrary")}`}
              aria-label={t("brief.refOpenInLibrary")}
            >
              <Library className="w-2.5 h-2.5" />
            </button>
          )}
          <RefNoteEditor
            item={item}
            includeRange={includeRange}
            onSave={(ann) => setRefItemAnnotation(item.id, ann)}
            disabled={ignored}
          />
        </>
      );
      // YT/VID 배지의 좌측 오프셋 — 라이브러리 배지(14px) 가 좌상단을 점유
      // 했을 때만 그 옆으로 밀어준다. 변수로 빼서 youtube/video 두 케이스에
      // 동일하게 사용.
      const kindBadgeLeftOffset = libraryRefId ? "left-3.5" : "left-0";
      // YT/VID 배지 공통 className — 14px 높이로 통일 (기존 py-[1px] 은 ~10px
      // 였음). text-nano + flex items-center 로 수직 가운데 정렬.
      const kindBadgeBaseClass = `absolute top-0 ${kindBadgeLeftOffset} h-3.5 px-1 flex items-center font-mono text-nano text-white`;
      if (item.kind === "image") {
        return (
          <div key={item.id} className="relative group">
            <img
              src={item.preview}
              alt=""
              onClick={() => !ignored && setLightboxSrc(item.preview)}
              className="h-[54px] w-[54px] object-cover border border-border cursor-zoom-in"
              style={tileBaseStyle}
              loading="lazy"
              decoding="async"
            />
            {ignored && (
              <span className="absolute bottom-0 left-0 right-0 text-center font-mono text-nano text-white bg-black/60">
                {t("brief.ignored")}
              </span>
            )}
            {overlayControls}
            <button
              onClick={() => removeRefItem(item.id)}
              className="absolute top-0 right-0 w-4 h-4 bg-primary text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              style={{ borderRadius: 0 }}
            >
              <X className="w-2.5 h-2.5" />
            </button>
          </div>
        );
      }
      if (item.kind === "youtube") {
        const thumb = item.thumbnailUrl;
        return (
          <div key={item.id} className="relative group">
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="block h-[54px] w-[54px] border border-border bg-black flex items-center justify-center"
              style={tileBaseStyle}
              title={item.title || item.url}
            >
              {thumb ? (
                // eslint-disable-next-line jsx-a11y/alt-text
                <img src={thumb} className="h-full w-full object-cover" loading="lazy" decoding="async" />
              ) : item.status === "loading" ? (
                <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
              ) : item.status === "error" ? (
                <AlertCircle className="w-4 h-4 text-primary" />
              ) : (
                <YoutubeIcon className="w-4 h-4 text-muted-foreground" />
              )}
              <span className={`${kindBadgeBaseClass} bg-red-600/90`}>YT</span>
              {ignored && (
                <span className="absolute bottom-0 left-0 right-0 text-center font-mono text-nano text-white bg-black/60">
                  {t("brief.ignored")}
                </span>
              )}
            </a>
            {overlayControls}
            <button
              onClick={() => removeRefItem(item.id)}
              className="absolute top-0 right-0 w-4 h-4 bg-primary text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              style={{ borderRadius: 0 }}
            >
              <X className="w-2.5 h-2.5" />
            </button>
          </div>
        );
      }
      // video — base64 우선, 없으면 storage URL(poster_url)로 썸네일 표시.
      const posterSrc = item.posterBase64
        ? refToDataUrl(item.posterBase64, "image/png")
        : item.posterUrl || null;
      return (
        <div key={item.id} className="relative group">
          <div
            className="h-[54px] w-[54px] border border-border bg-black overflow-hidden flex items-center justify-center"
            style={tileBaseStyle}
            title={`${item.fileName} · ${Math.round(item.durationSec)}s`}
          >
            {posterSrc ? (
              // eslint-disable-next-line jsx-a11y/alt-text
              <img src={posterSrc} className="h-full w-full object-cover" loading="lazy" decoding="async" />
            ) : item.status === "sampling" ? (
              <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
            ) : item.status === "error" ? (
              <AlertCircle className="w-4 h-4 text-primary" />
            ) : (
              <Film className="w-4 h-4 text-muted-foreground" />
            )}
            <span className={`${kindBadgeBaseClass} bg-neutral-700/90`}>VID</span>
            {ignored && (
              <span className="absolute bottom-0 left-0 right-0 text-center font-mono text-nano text-white bg-black/60">
                {t("brief.ignored")}
              </span>
            )}
          </div>
          {overlayControls}
          <button
            onClick={() => removeRefItem(item.id)}
            className="absolute top-0 right-0 w-4 h-4 bg-primary text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ borderRadius: 0 }}
          >
            <X className="w-2.5 h-2.5" />
          </button>
        </div>
      );
    };

    return (
      <>
        <input
          ref={refFileInputRef}
          type="file"
          accept={acceptAttr}
          multiple
          className="hidden"
          onChange={(e) => {
            handleRefFileSelect(e.target.files);
            e.target.value = "";
          }}
        />

        {/* ── 라이브러리 진입 — Workspace 스위치 + returnTo=현재 프로젝트.
             브리프 측 *부착 흐름* 의 단방향 친화도를 키운다 (라이브러리 가서
             자료 우클릭하면 returnProjectId 가 이 프로젝트로 잡혀 즉시 attach). */}
        <button
          onClick={() => setLibraryImportOpen(true)}
          className="w-full flex items-center justify-center gap-2 mb-2 px-3 py-1.5 border border-border-subtle text-meta font-medium text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors"
          style={{ borderRadius: 0 }}
        >
          <Library className="w-3.5 h-3.5" />
          {t("brief.openLibrary")}
        </button>
        <LibraryImportDialog
          open={libraryImportOpen}
          onOpenChange={setLibraryImportOpen}
          target="brief"
          projectId={projectId}
          onOpenFullLibrary={handleGoToLibrary}
        />

        {/* ── URL 인풋 (모델이 video frames 지원할 때만) ── */}
        {supportsVideoFrames ? (
          <div
            className="flex items-center gap-1.5 px-2 py-1 mb-2 border bg-input"
            style={{ borderRadius: 0, borderColor: "rgba(255,255,255,0.07)" }}
          >
            <LinkIcon className="w-3 h-3 text-muted-foreground/40 shrink-0" />
            <input
              type="url"
              value={refUrlInput}
              onChange={(e) => setRefUrlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (refUrlInput.trim()) {
                    addYoutubeRef(refUrlInput);
                    setRefUrlInput("");
                  }
                }
              }}
              placeholder={t("brief.youtubePlaceholder")}
              className="flex-1 min-w-0 bg-transparent border-none outline-none text-meta font-[inherit] text-foreground placeholder:text-muted-foreground/40"
            />
            {refUrlInput.trim() && (
              <button
                onClick={() => {
                  if (refUrlInput.trim()) {
                    addYoutubeRef(refUrlInput);
                    setRefUrlInput("");
                  }
                }}
                className="font-mono text-2xs text-muted-foreground hover:text-foreground"
              >
                {t("brief.add")}
              </button>
            )}
          </div>
        ) : (
          <div
            className="flex items-center gap-1.5 px-2 py-1 mb-2 border border-dashed overflow-hidden"
            style={{ borderRadius: 0, borderColor: "rgba(255,255,255,0.07)" }}
            title={t("brief.imageOnlyModeTitle")}
          >
            <EyeOff className="w-3 h-3 text-muted-foreground/30 shrink-0" />
            {/* 컨테이너가 좁으면 2줄로 깨지던 문구. whitespace-nowrap + truncate
             *  로 항상 한 줄에 유지하고, 폭이 부족하면 말줄임표로 축약.
             *  원문 title 로 전체 문구는 hover 툴팁에서 읽을 수 있음. */}
            <span className="font-mono text-2xs text-muted-foreground/40 whitespace-nowrap truncate min-w-0">
              {t("brief.imageOnlyMode")}
            </span>
          </div>
        )}

        {/* ── 드롭존 / 타일 ── */}
        {refItems.length === 0 ? (
          <div
            onClick={() => refFileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setRefDragOver(true);
            }}
            onDragLeave={() => setRefDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setRefDragOver(false);
              handleRefFileSelect(e.dataTransfer.files);
            }}
            className="h-[60px] border border-dashed flex items-center justify-center gap-2 px-3 cursor-pointer transition-colors"
            style={{
              borderRadius: 0,
              borderColor: refDragOver ? "rgba(249,66,58,0.5)" : "rgba(255,255,255,0.1)",
              background: refDragOver ? "rgba(249,66,58,0.04)" : "transparent",
            }}
          >
            <ImagePlus className="w-4 h-4 text-muted-foreground/30 shrink-0" />
            <p className="font-mono text-2xs text-muted-foreground/40 text-center leading-tight min-w-0 break-keep">{dropHintLabel}</p>
          </div>
        ) : (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setRefDragOver(true);
            }}
            onDragLeave={() => setRefDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setRefDragOver(false);
              handleRefFileSelect(e.dataTransfer.files);
            }}
            className="border p-2 transition-colors"
            style={{
              borderRadius: 0,
              borderColor: refDragOver ? "rgba(249,66,58,0.5)" : "rgba(255,255,255,0.07)",
              background: refDragOver ? "rgba(249,66,58,0.04)" : "transparent",
            }}
          >
            <div className="flex gap-2 flex-wrap">
              {refItems.map(renderTile)}
              {slotsLeft > 0 && (
                <button
                  onClick={() => refFileInputRef.current?.click()}
                  className="h-[54px] w-[54px] border border-dashed border-border hover:border-primary/40 flex flex-col items-center justify-center gap-0.5 transition-colors"
                  style={{ borderRadius: 0 }}
                  title={t("brief.addMoreReferences")}
                >
                  <Plus className="w-3.5 h-3.5 text-muted-foreground/30" />
                </button>
              )}
            </div>
            {refCounts.ignored > 0 && (
              <p className="font-mono text-micro text-muted-foreground/50 mt-1.5">
                {t("brief.ignoredByModel", { count: refCounts.ignored })}
              </p>
            )}
          </div>
        )}
      </>
    );
  };

  const renderIdeaNoteContent = () => (
    <div
      className="overflow-hidden border border-input bg-input transition-colors focus-within:border-primary/50"
      style={{ borderRadius: 0 }}
    >
      <textarea
        value={ideaNote}
        onChange={(e) => setIdeaNote(e.target.value.slice(0, 2000))}
        placeholder={t("brief.ideaPlaceholder")}
        className="w-full h-[60px] border-none outline-none resize-none text-meta font-[inherit] text-foreground bg-transparent px-3 py-2 leading-relaxed placeholder:text-muted-foreground/40"
      />
    </div>
  );

  /* ━━━━━ RENDER ━━━━━ */
  return (
    <div className="flex gap-3 h-full">
      {/* ── LEFT: Input Panel ── */}
      <div
        className={`shrink-0 ${isMobile ? "w-full" : ""}`}
        style={
          isMobile
            ? {}
            : {
                // 드래그 리사이즈로 사용자가 정한 폭(접힘 없음). 기본값은 기존
                // 300 보다 넓혀 긴 설명/모델 라벨이 처음부터 잘 보이게 한다.
                width: briefPanelWidth,
              }
        }
      >
        <div className="bg-card/80 border border-border flex flex-col h-full" style={{ borderRadius: 0 }}>
          {/* ★ Header — Creative Input + Model picker + KO/EN toggle
           *  컨테이너 너비가 좁아지면 ModelPicker 의 모델 라벨은 truncate
           *  되도록 `min-w-0 flex-1` 로 공간을 양보하고, LangToggle 은 항상
           *  `shrink-0` 으로 온전히 보이게 고정. `Creative Input` 타이틀 역시
           *  min-w-0 + truncate 로 필요하면 줄여서 토글 잘림을 방지. */}
          <div className="px-4 pt-4 pb-3 border-b border-border flex items-center gap-2">
            <h2 className="text-body font-bold tracking-wider text-foreground min-w-0 truncate">
              {t("brief.creativeInput")}
            </h2>
            <div className="flex items-center gap-2 min-w-0 flex-1 justify-end">
              <div className="min-w-0 flex-shrink">
                <ModelPicker stage="brief" projectId={projectId} variant="compact" className="max-w-full" />
              </div>
              <div className="shrink-0">
                <LangToggle
                  lang={analysisLang}
                  onChange={(l) => {
                    analysisLangTouchedRef.current = true;
                    if (hasAnalysis) handleLangToggle(l);
                    else setAnalysisLang(l);
                  }}
                  loading={translating}
                />
              </div>
            </div>
          </div>

          <div className="flex flex-col flex-1 px-5 pt-3 pb-4 gap-4 overflow-y-auto">
            {isCollapsedMode ? (
              <>
                <CollapsibleSection title={t("brief.briefText")} preview={briefTextPreview}>
                  {renderBriefTextContent()}
                </CollapsibleSection>
                <CollapsibleSection title={t("brief.reference")} preview={moodboardPreview}>
                  {renderMoodboardContent()}
                </CollapsibleSection>
                <CollapsibleSection title={t("brief.ideaNote")} preview={ideaNotePreview}>
                  {renderIdeaNoteContent()}
                </CollapsibleSection>
                <button
                  onClick={handleAnalyze}
                  disabled={!canAnalyze || analyzing}
                  className="w-full h-[36px] text-caption font-semibold tracking-wider text-muted-foreground border border-border transition-colors flex items-center justify-center gap-2 mt-auto hover:text-foreground hover:border-foreground/20 disabled:opacity-30 disabled:cursor-not-allowed"
                  style={{ borderRadius: 0 }}
                >
                  <RefreshCw className="w-3 h-3" />
                  {t("brief.reAnalyze")}
                </button>
              </>
            ) : (
              <>
                <div>
                  <p className="label-meta text-primary mb-1">{t("brief.briefText")}</p>
                  {renderBriefTextContent()}
                </div>
                <div>
                  <p className="label-meta text-primary mb-1">{t("brief.reference")}</p>
                  {renderMoodboardContent()}
                </div>
                <div>
                  <p className="label-meta text-primary mb-1">
                    {t("brief.ideaNote")} <span className="font-normal opacity-50">({t("brief.optional")})</span>
                  </p>
                  {renderIdeaNoteContent()}
                </div>
                <button
                  onClick={handleAnalyze}
                  disabled={!canAnalyze || analyzing}
                  className="w-full h-[40px] text-meta font-semibold tracking-wider text-white transition-colors flex items-center justify-center gap-2 mt-auto disabled:opacity-30 disabled:cursor-not-allowed"
                  style={{
                    borderRadius: 0,
                    background: analyzing ? "rgba(249,66,58,0.4)" : KR,
                  }}
                  onMouseEnter={(e) => {
                    if (!analyzing && canAnalyze) (e.currentTarget as HTMLElement).style.background = "#e03530";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.background = analyzing ? "rgba(249,66,58,0.4)" : KR;
                  }}
                >
                  {analyzing ? t("brief.analyzing") : `✦ ${t("brief.executeAnalysis")}`}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── 리사이즈 핸들 ── 데스크톱에서 크리에이티브 입력 패널 폭을 드래그로
          조절. 더블클릭하면 기본 폭으로 복원. mouseup 시점에만 영구화. */}
      {!isMobile && (
        <SidebarResizeHandle
          width={briefPanelWidth}
          onWidthChange={setBriefPanelWidth}
          defaultWidth={DEFAULT_BRIEF_PANEL_WIDTH}
          clamp={clampBriefPanelWidth}
          onCommit={saveBriefPanelWidth}
        />
      )}

      {/* ── CENTER: Strategy Manifesto ── */}
      {(hasAnalysis || analyzing || loaderLingering) && (
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="border border-border overflow-hidden flex flex-col h-full" style={{ borderRadius: 0 }}>
            <div
              className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0"
              style={{ background: "rgba(249,66,58,0.06)" }}
            >
              <h2 className="text-body font-bold tracking-wider text-foreground">{t("brief.strategyManifesto")}</h2>
              {showEditHint && (
                <span
                  className="text-2xs px-2 py-0.5 rounded-none animate-fade-in"
                  style={{
                    background: "rgba(249,66,58,0.12)",
                    color: KR,
                    border: "1px solid rgba(249,66,58,0.2)",
                  }}
                >
                  텍스트를 클릭하여 편집할 수 있습니다
                </span>
              )}
              {hasAnalysis && (
                <>
                  <div
                    className="ml-auto flex items-center gap-1"
                    style={{ background: "rgba(255,255,255,0.04)", borderRadius: 0, padding: 2 }}
                  >
                    <button
                      onClick={() => setViewMode("list")}
                      className="flex items-center justify-center transition-colors"
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 0,
                        background: viewMode === "list" ? "rgba(249,66,58,0.14)" : "transparent",
                        color: viewMode === "list" ? KR : "#666",
                      }}
                    >
                      <LayoutList className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setViewMode("slide")}
                      className="flex items-center justify-center transition-colors"
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 0,
                        background: viewMode === "slide" ? "rgba(249,66,58,0.14)" : "transparent",
                        color: viewMode === "slide" ? KR : "#666",
                      }}
                    >
                      <GalleryHorizontalEnd className="w-3.5 h-3.5" />
                    </button>
                  </div>

                   {/* ★ Result area lang toggle — removed, now in Creative Input header */}
                </>
              )}
            </div>

            <div className="flex-1 overflow-y-auto bg-background/60 p-4">
              {analyzing || loaderLingering ? (
                <AnalysisLoader
                  active={analyzing}
                  mode={pdfState === "ready" ? "pdf" : "default"}
                  variant="full"
                  onHidden={() => setLoaderLingering(false)}
                  startedAt={analyzingStartedAt}
                />
              ) : analysis ? (
                (() => {
                  const displayAnalysis = analysisLang === "en" && analysisEn ? analysisEn : analysis;
                  if (isDeepAnalysis(displayAnalysis)) {
                    return viewMode === "slide" ? (
                      <SlideViewUI analysis={displayAnalysis} lang={analysisLang} onUpdate={updateAnalysisField} />
                    ) : (
                      <CoreStrategyUI analysis={displayAnalysis} lang={analysisLang} onUpdate={updateAnalysisField} />
                    );
                  }
                  return <LegacyResultUI analysis={displayAnalysis as LegacyAnalysis} lang={analysisLang} />;
                })()
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* ── Empty state ── */}
      {!hasAnalysis && !analyzing && (
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="border border-border overflow-hidden flex flex-col h-full" style={{ borderRadius: 0 }}>
            <div
              className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0"
              style={{ background: "rgba(249,66,58,0.06)" }}
            >
              <h2 className="text-body font-bold tracking-wider text-foreground">{t("brief.strategyManifesto")}</h2>
            </div>
            <div className="flex-1 overflow-y-auto bg-background/60 p-4">
              <div className="flex flex-col items-center justify-center h-full min-h-[360px]">
                <BarChart3 className="w-8 h-8 text-muted-foreground/20 mb-3" />
                <p className="text-body font-bold tracking-wider text-muted-foreground/40">{t("brief.noAnalysisYet")}</p>
                <p className="font-mono text-2xs text-muted-foreground/25 mt-1">{t("brief.inputBriefExecute")}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── RIGHT: Production Guide + Actions ── */}
      {!isMobile && hasAnalysis && (
        <div className="shrink-0" style={{ width: 380, minWidth: 340 }}>
          <div className="border border-border flex flex-col h-full overflow-hidden" style={{ borderRadius: 0 }}>
            <div
              className="px-4 pt-4 pb-3 shrink-0"
              style={{
                position: "sticky",
                top: 0,
                zIndex: 10,
                background: "hsl(var(--background))",
                boxShadow: "0 1px 0 rgba(255,255,255,0.06)",
              }}
            >
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />
                  <span className="text-caption font-medium text-emerald-400">{t("brief.analysisComplete")}</span>
                  {analyzedAt && (
                    <span className="font-mono text-2xs text-muted-foreground/50 ml-auto">
                      {formatDate(analyzedAt)}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => setShowNextStepModal(true)}
                  className="w-full h-[44px] text-meta font-semibold tracking-wider text-white transition-colors flex items-center justify-center gap-2"
                  style={{ borderRadius: 0, background: KR }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.background = "#e03530";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.background = KR;
                  }}
                >
                  {t("brief.executeStrategy")} →
                </button>
                <div className="flex items-center gap-3">
                  <button
                    onClick={copyAll}
                    className="flex items-center gap-1.5 text-caption text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Copy className="w-3 h-3" />
                    {t("brief.copy")}
                  </button>
                  <button
                    onClick={handleAnalyze}
                    disabled={!canAnalyze || analyzing}
                    className="flex items-center gap-1.5 text-caption text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30"
                  >
                    <RefreshCw className="w-3 h-3" />
                    {t("brief.reAnalyze")}
                  </button>
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-4">
              {analysis &&
                isDeepAnalysis(analysis) &&
                (() => {
                  const displayAnalysis = analysisLang === "en" && analysisEn ? analysisEn : analysis;
                  return isDeepAnalysis(displayAnalysis) ? (
                    <ProductionGuideUI analysis={displayAnalysis} lang={analysisLang} onUpdate={updateAnalysisField} />
                  ) : null;
                })()}
            </div>
          </div>
        </div>
      )}

      {/* ── RIGHT: Action Panel (no analysis) ── */}
      {!isMobile && !hasAnalysis && (
        <div className="w-[200px] shrink-0">
          <div className="bg-card/80 border border-border flex flex-col h-full" style={{ borderRadius: 0 }}>
            <div className="px-4 pt-4 pb-3 border-b border-border">
              <h2 className="text-body font-bold tracking-wider text-foreground">{t("brief.nextStep")}</h2>
            </div>
            <div className="flex flex-col flex-1 px-3 pt-4 pb-4 gap-4">
              {analyzing ? (
                <div className="flex flex-col items-center justify-center flex-1 gap-2 text-center">
                  <span className="font-mono text-2xs text-muted-foreground/30 uppercase leading-relaxed">
                    {t("brief.analyzing")}
                  </span>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center flex-1 gap-2 text-center">
                  <span className="font-mono text-2xs text-muted-foreground/30 uppercase leading-relaxed">
                    {t("brief.runAnalysisFirst")}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showNextStepModal && (
        <NextStepModal
          onClose={() => setShowNextStepModal(false)}
          onGoAssets={() => onSwitchToAssets?.()}
          onGoAgent={() => onSwitchToAgent(analysisLang)}
          analysisLang={analysisLang}
        />
      )}

      {lightboxSrc && (
        <div
          onClick={() => setLightboxSrc(null)}
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 cursor-zoom-out"
        >
          <button
            onClick={() => setLightboxSrc(null)}
            className="absolute top-4 right-4 w-8 h-8 bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
            style={{ borderRadius: 0 }}
          >
            <X className="w-4 h-4 text-white" />
          </button>
          <img
            src={lightboxSrc}
            alt="Original image"
            onClick={(e) => e.stopPropagation()}
            className="max-w-[90vw] max-h-[90vh] object-contain shadow-2xl cursor-default"
            style={{ borderRadius: 0 }} loading="lazy" decoding="async" />
        </div>
      )}
    </div>
  );
};

/* ━━━━━ Reference 부연설명 에디터 ━━━━━
 *
 * 각 RefItem 타일 우하단에 연필 아이콘을 띄우고, 클릭 시 Popover 로
 * 관심 구간 + 보고 싶은 포인트를 편집한다. 이미지 타일에서는 구간 입력 숨김.
 * `onSave` 는 빈 값으로 호출되면 상위에서 annotation 필드 자체를 제거. */
interface RefNoteEditorProps {
  item: RefItem;
  includeRange: boolean;
  disabled?: boolean;
  onSave: (next: RefAnnotation | undefined) => void;
}
const RefNoteEditor = ({ item, includeRange, disabled, onSave }: RefNoteEditorProps) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [rangeText, setRangeText] = useState(item.annotation?.rangeText ?? "");
  const [notes, setNotes] = useState(item.annotation?.notes ?? "");
  const [rangeError, setRangeError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setRangeText(item.annotation?.rangeText ?? "");
      setNotes(item.annotation?.notes ?? "");
      setRangeError(null);
    }
  }, [open, item.annotation?.rangeText, item.annotation?.notes]);

  const handleSave = () => {
    const trimmedRange = rangeText.trim();
    const trimmedNotes = notes.trim();
    let startSec: number | undefined;
    let endSec: number | undefined;
    if (includeRange && trimmedRange) {
      const parsed = parseTimeRange(trimmedRange);
      if (parsed) {
        startSec = parsed.startSec;
        endSec = parsed.endSec;
      } else if (!rangeError) {
        setRangeError(t("brief.referenceRangeError"));
        return;
      }
    }
    const next: RefAnnotation = {
      rangeText: trimmedRange && includeRange ? trimmedRange : undefined,
      startSec,
      endSec,
      notes: trimmedNotes || undefined,
    };
    onSave(next);
    setOpen(false);
  };

  const handleClear = () => {
    setRangeText("");
    setNotes("");
    onSave(undefined);
    setOpen(false);
  };

  if (disabled) return null;

  const hasExisting = hasAnnotation(item.annotation);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          aria-label={hasExisting ? t("brief.referenceNoteEdit") : t("brief.referenceNoteAdd")}
          className={
            "absolute bottom-0 right-0 w-4 h-4 bg-foreground text-background flex items-center justify-center " +
            (hasExisting ? "opacity-100" : "opacity-0 group-hover:opacity-100") +
            " transition-opacity"
          }
          style={{ borderRadius: 0 }}
        >
          <Pencil className="w-2.5 h-2.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-80 p-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col gap-3">
          <div className="text-caption font-medium tracking-wide text-primary">
            {t("brief.referenceNote")}
          </div>
          {includeRange && (
            <label className="flex flex-col gap-1">
              <span className="text-caption text-muted-foreground">{t("brief.referenceTimeRange")}</span>
              <input
                type="text"
                value={rangeText}
                onChange={(e) => {
                  setRangeText(e.target.value);
                  setRangeError(null);
                }}
                placeholder="00:12~00:15"
                className="h-8 px-2 text-meta border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                style={{ borderRadius: 0 }}
              />
              {rangeError && (
                <span className="text-2xs text-primary">{rangeError}</span>
              )}
            </label>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-caption text-muted-foreground">{t("brief.referenceFocusPoints")}</span>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t("brief.referenceNotePlaceholder")}
              className="min-h-[90px] text-meta"
            />
          </label>
          <div className="flex items-center justify-between gap-2 pt-1">
            <button
              type="button"
              onClick={handleClear}
              className="h-8 px-2 text-meta text-muted-foreground hover:text-foreground"
            >
              {t("brief.clear")}
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="h-8 px-3 text-meta border border-border hover:bg-secondary"
                style={{ borderRadius: 0 }}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={handleSave}
                className="h-8 px-3 text-meta bg-primary text-primary-foreground hover:bg-primary/85"
                style={{ borderRadius: 0 }}
              >
                {t("common.save")}
              </button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
};

/* ━━━━━ Execute Analysis 로딩 체감 개선 ━━━━━
 *
 * LLM 분석은 Promise 단일 resolve 라 중간 진행 이벤트가 없다. 실제 진행률을
 * 모르면서도 "멈춘 듯한" 인상을 줄이기 위해 두 축을 도입:
 *   A. asymptotic 진행률 바 (0 → 95% log 곡선) — 완료 시 100% 스냅 + 300ms fade
 *   B. 실제 파이프라인 단계를 반영한 5개 스테이지 메시지 로테이션
 * 둘 다 "거짓말" 아님 — 분석 시 실제로 저 단계들이 (순차적으로) 일어남. */
/* 진행 단계 문구는 i18n 키로 둔다 — 모듈 상수라 훅을 못 쓰므로 키만 보관하고
   렌더 시 AnalysisLoader 가 t() 로 변환(UI 언어를 따른다). */
const ANALYSIS_STAGE_KEYS = [
  "brief.analyzing.stage1",
  "brief.analyzing.stage2",
  "brief.analyzing.stage3",
  "brief.analyzing.stage4",
  "brief.analyzing.stage5",
] as const;

const FAKE_ANALYSIS_PROGRESS_TAU_SEC = 20;
const FAKE_ANALYSIS_STAGE_INTERVAL_MS = 3500;

function useFakeAnalysisProgress(active: boolean, startedAt?: number | null) {
  const computeFromStart = useCallback((started: number) => {
    const t = (Date.now() - started) / 1000;
    const eased = 1 - Math.exp(-t / FAKE_ANALYSIS_PROGRESS_TAU_SEC);
    return Math.min(95, eased * 100);
  }, []);
  const computeStageIdx = useCallback((started: number) => {
    const elapsedMs = Date.now() - started;
    return Math.min(
      Math.max(0, Math.floor(elapsedMs / FAKE_ANALYSIS_STAGE_INTERVAL_MS)),
      ANALYSIS_STAGE_KEYS.length - 1,
    );
  }, []);
  // startedAt 이 주어지면 그 시점부터 elapsed 를 계산해 진행률을 이어준다 —
  // BriefTab 이 분석 도중 다른 라우트를 다녀와 재마운트되어도 0% 로 리셋되지
  // 않고 실제 경과 시간을 반영. 미지정 시 마운트 시점을 시작으로 기존처럼.
  const initialStart = startedAt ?? Date.now();
  const [pct, setPct] = useState(() => (active ? computeFromStart(initialStart) : 0));
  const [stageIdx, setStageIdx] = useState(() =>
    active ? computeStageIdx(initialStart) : 0,
  );
  useEffect(() => {
    if (!active) {
      setPct(0);
      setStageIdx(0);
      return;
    }
    const started = startedAt ?? Date.now();
    setPct(computeFromStart(started));
    setStageIdx(computeStageIdx(started));
    // 1 - e^(-t/tau), tau=20s keeps the visual-only bar 2.5x slower before the 95% cap.
    // tick 120ms 면 바의 transition-[width] duration-500 과 어우러져 부드럽게 차오름.
    const tick = setInterval(() => {
      setPct(computeFromStart(started));
    }, 120);
    const rotate = setInterval(() => {
      setStageIdx(computeStageIdx(started));
    }, FAKE_ANALYSIS_STAGE_INTERVAL_MS);
    return () => {
      clearInterval(tick);
      clearInterval(rotate);
    };
  }, [active, startedAt, computeFromStart, computeStageIdx]);
  return { pct, stageKey: ANALYSIS_STAGE_KEYS[stageIdx] };
}

/* 메인 결과 영역용 풀 로더 (spinner + 타이틀 + 스테이지 + 바 + 퍼센트).
 * compact variant 는 좁은 Next Step 사이드바 카드 안에서 쓰이며 스피너 생략. */
interface AnalysisLoaderProps {
  active: boolean;
  mode?: "default" | "pdf";
  variant?: "full" | "compact";
  onHidden?: () => void;
  /** 분석 시작 시각 (epoch ms). 다른 라우트 다녀와 재마운트되어도 진행률이
   *  리셋되지 않도록 모듈 레지스트리의 startedAt 을 그대로 전달한다. */
  startedAt?: number | null;
}
const AnalysisLoader = ({ active, mode = "default", variant = "full", onHidden, startedAt }: AnalysisLoaderProps) => {
  const t = useT();
  const { pct, stageKey } = useFakeAnalysisProgress(active, startedAt);
  const stage = t(stageKey);
  const [displayPct, setDisplayPct] = useState(0);
  useEffect(() => {
    if (active) {
      setDisplayPct(pct);
      return;
    }
    // active=false 로 내려오는 순간: 100% 스냅 유지 후 300ms 뒤 onHidden.
    setDisplayPct(100);
    if (!onHidden) return;
    const timer = setTimeout(onHidden, 300);
    return () => clearTimeout(timer);
  }, [active, pct, onHidden]);

  if (variant === "compact") {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-2 text-center w-full">
        <span className="font-mono text-2xs text-muted-foreground/50 leading-relaxed">
          {stage}
        </span>
        <div
          className="w-full h-1 rounded-full overflow-hidden"
          style={{ background: "rgba(255,255,255,0.06)" }}
        >
          <div
            className="h-full bg-primary/60 rounded-full transition-[width] duration-500 ease-out"
            style={{ width: `${displayPct}%` }}
          />
        </div>
        <span className="font-mono text-micro text-muted-foreground/30">
          {Math.round(displayPct)}%
        </span>
      </div>
    );
  }

  const headline = mode === "pdf" ? t("brief.analyzing.headlinePdf") : t("brief.analyzing.headline");
  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[300px] gap-5">
      <div className="relative w-10 h-10">
        <span className="absolute inset-0 border-2 border-primary/20 rounded-full" />
        <span className="absolute inset-0 border-2 border-transparent border-t-primary rounded-full animate-spin" />
      </div>
      <div className="text-center space-y-1.5">
        <p className="text-body font-semibold text-foreground">{headline}</p>
        <p className="font-mono text-2xs text-muted-foreground/60 min-h-[14px] transition-opacity">
          {stage}
        </p>
      </div>
      <div className="w-48 h-1 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
        <div
          className="h-full bg-primary/70 rounded-full transition-[width] duration-500 ease-out"
          style={{ width: `${displayPct}%` }}
        />
      </div>
      <p className="font-mono text-2xs text-muted-foreground/30">
        {Math.round(displayPct)}%
      </p>
    </div>
  );
};
