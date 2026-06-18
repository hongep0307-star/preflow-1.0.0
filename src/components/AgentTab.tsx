import React, { useEffect, useState, useRef, useCallback, useMemo } from "react";
import type { VideoFormat } from "@/lib/conti";
import { supabase } from "@/lib/supabase";
import { deleteStoredFileIfUnreferenced, normalizeStorageUrl } from "@/lib/storageUtils";
import { callLLMStream } from "@/lib/llm";
import { getModel } from "@/lib/modelPreference";
import { getModelMeta } from "@/lib/modelCatalog";
import { getSettingsCached, ensureSettingsLoaded } from "@/lib/settingsCache";
import { pruneHistoryForBudget } from "@/lib/historyBudget";
import {
  loadPendingSpecFromLS,
  savePendingSpecToLS,
  type ProductionSpec,
} from "@/lib/productionSpec";
import { useToast } from "@/hooks/use-toast";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  Plus,
  Clapperboard,
  Send,
  Lightbulb,
  X,
  Check,
  ImagePlus,
  RotateCcw,
  Image,
  ImageOff,
  Layers,
  PanelLeftClose,
  PanelLeftOpen,
  Columns2,
  MessageSquare,
  SlidersHorizontal,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";

import {
  KR,
  KR_BG,
  KR_BORDER2,
  type Asset,
  type Scene,
  type Analysis,
  type ChatLog,
  type ChatImage,
  type MoodImage,
  type ParsedScene,
  type FocalPoint,
  type RightPanel,
  formatTime,
  fileToBase64,
  toVisionSafeChatImage,
  readAgentChatImages,
  clearAgentChatImages,
  AGENT_CHAT_ATTACH_CHANGED_EVENT,
  CHAT_IMAGE_MAX,
  toMoodImages,
  extractScenesFromText,
  extractSpecFromText,
  resolveAsset,
  _pendingScenesByProject,
  loadPendingFromLS,
  savePendingToLS,
  getMoodGenBatches,
  collectAllInFlightSkeletonIds,
  lookupArrivedUrlForSkeleton,
  subscribeMoodGen,
  getChatGen,
  setChatGen,
  patchChatGen,
  subscribeChatGen,
  parseMessageSegments,
  remapMessageForHistory,
  ACFG,
  ASSET_ICON,
  type DirectionMode,
} from "./agent/agentTypes";
import { MoodIdeationPanel } from "./agent/MoodIdeationPanel";
import AgentAbcdPanel from "./agent/AgentAbcdPanel";
import {
  SortableSceneCard,
  EditablePendingSceneCard,
  AgentInlineField,
} from "./agent/AgentSceneCards";
import { ConfirmScenesModal, SendToContiModal, LoadVersionModal } from "./agent/AgentModals";
import {
  buildAssetUsageReminder,
  buildSystemPrompt,
  buildBriefContextString,
  buildContinuityFixPrompt,
  buildDirectionReminder,
  isBriefAnalysisMsg,
} from "./agent/prompts";
import { MessageContent } from "./agent/MessageContent";
import { AgentChatInput } from "./agent/AgentChatInput";
import { EmptyState } from "@/components/ui/empty-state";
import { LibraryImportDialog } from "@/components/library/LibraryImportDialog";
import { useT } from "@/lib/uiLanguage";
import { briefAnalysisRegistry } from "@/lib/briefAnalysisRegistry";

// ══════════════════════════════════════════════════════════
//   MAIN — AgentTab
// ══════════════════════════════════════════════════════════

interface Props {
  projectId: string;
  videoFormat?: VideoFormat;
  lang?: "ko" | "en";
  onSwitchToContiTab?: () => void;
  /** 이 탭이 현재 활성화(보이는) 상태인지. 백그라운드 prefetch 로 미리 마운트된
   *  뒤 브리프 분석이 끝나는 케이스에서, 활성화 시점에 브리프를 재조회하기 위함. */
  isActive?: boolean;
}

/** 연출 모드 짧은 라벨(아코디언 헤더/버튼 공용). */
const directionModeLabel = (mode: DirectionMode, lang: "ko" | "en"): string =>
  lang === "en"
    ? mode === "narrative"
      ? "Narrative"
      : mode === "motion"
        ? "Motion"
        : "Balanced"
    : mode === "narrative"
      ? "서사"
      : mode === "motion"
        ? "모션"
        : "균형";

/** 방향 카드 클릭 시 채팅으로 보낼 확정 문구(이 메시지가 LLM 을 Phase 1 로 넘긴다). */
const directionConfirmMsg = (mode: DirectionMode, lang: "ko" | "en"): string => {
  if (lang === "en") {
    const l = mode === "narrative" ? "narrative-driven" : mode === "motion" ? "motion-driven" : "balanced";
    return `Let's go ${l}. Now propose the synopsis directions (storylines).`;
  }
  const l = mode === "narrative" ? "서사 중심" : mode === "motion" ? "모션 연출 중심" : "균형";
  return `${l}으로 진행할게요. 이제 시놉시스(storylines)를 제안해줘.`;
};

const DRAFT_REPLACE_INTENT_RE =
  /(삭제|제거|빼|빼고|줄여|축소|정리|재구성|다시\s*구성|다시\s*짜|교체|새로\s*짜|최종안|최종\s*컷|remove|delete|drop|omit|reduce|shorten|rework|replace|final\s+cut|final\s+shot)/i;

const shouldReplaceDraftsFromExtraction = ({
  userText,
  assistantText,
  previous,
  extracted,
}: {
  userText: string;
  assistantText: string;
  previous: ParsedScene[];
  extracted: ParsedScene[];
}) => {
  if (previous.length === 0 || extracted.length === 0) return false;
  if (extracted.length >= previous.length && extracted.length > 1) return true;
  const hasReplaceIntent = DRAFT_REPLACE_INTENT_RE.test(`${userText}\n${assistantText}`);
  return hasReplaceIntent && extracted.length > 1;
};

const mergeOrReplaceDrafts = (previous: ParsedScene[], extracted: ParsedScene[], forceReplace = false) => {
  if (previous.length === 0 || forceReplace) return extracted;
  const updated = [...previous];
  for (const ext of extracted) {
    const idx = updated.findIndex((p) => p.scene_number === ext.scene_number);
    if (idx >= 0) updated[idx] = ext;
    else updated.push(ext);
  }
  if (extracted.length >= previous.length && extracted.length > 1) return extracted;
  return updated.sort((a, b) => a.scene_number - b.scene_number);
};

const MOOD_PENDING_KEY_PREFIX = "preflow_mood_pending:";

type StoredPendingMoodBatch = {
  batchId?: string;
  count?: number;
  skeletonIds?: string[];
  startedAt?: number;
};

const readStoredPendingMoodBatches = (projectId: string): StoredPendingMoodBatch[] => {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(`${MOOD_PENDING_KEY_PREFIX}${projectId}`);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((batch) => typeof batch?.startedAt === "number" && Date.now() - batch.startedAt < 60 * 60 * 1000);
  } catch {
    return [];
  }
};

const hasStoredPendingMoodBatches = (projectId: string) => readStoredPendingMoodBatches(projectId).length > 0;

const storedPendingMoodSkeletons = (projectId: string): MoodImage[] =>
  readStoredPendingMoodBatches(projectId).flatMap((batch) =>
    (batch.skeletonIds ?? []).map((id) => ({
      id,
      url: lookupArrivedUrlForSkeleton(projectId, id),
      liked: false,
      sceneRef: null,
      comment: "",
      createdAt: new Date(batch.startedAt ?? Date.now()).toISOString(),
    })),
  );

/** 컷 카드 목록에서 같은 sequence(=씬) 묶음 앞에 표시하는 씬 구분 헤더. */
const SceneGroupHeader = ({ label }: { label: string }) => (
  <div className="flex items-center gap-2 pt-2 pb-0.5 select-none">
    <span
      className="text-2xs font-bold uppercase"
      style={{ color: KR, letterSpacing: "0.08em" }}
    >
      {label}
    </span>
    <div className="flex-1 h-px" style={{ background: `${KR}33` }} />
  </div>
);

/**
 * 턴별 GPT-5.x reasoning 강도 분류. 컷 기획/재구성처럼 사고가 필요한 무거운
 * 턴은 "medium", 인사·방향 확정·단순 질의응답 등 가벼운 턴은 "low" 로 잡아
 * 추론 시간을 줄인다. (휴리스틱이라 필요 시 키워드 보강 가능.)
 */
const classifyAgentTurn = (text: string): "low" | "medium" => {
  const t = text ?? "";
  // 스토리라인 선택 신호 (handleSend 의 looksLikeStorylinePick 패턴과 동일 계열)
  const picksStoryline =
    /\b[A-Z]안\b[\s\S]*(선택|진행|결정|가자|갈게|갈래)/.test(t) ||
    /\b(pick|go\s+with|choose|proceed)\b/i.test(t);
  // 컷/스토리보드 생성·재구성·정리 의도
  const cutWork =
    /(컷|씬|스토리보드|보드|구성|재구성|정리|추가|수정|쪼개|나눠|만들)/.test(t) ||
    /\b(scene|shot|storyboard|cut|restructure|rebuild|outline)\b/i.test(t);
  return picksStoryline || cutWork ? "medium" : "low";
};

/**
 * 스트리밍 미리보기용 — 완료/미완료 코드펜스(```scene 등)를 제거해 임시 버블에
 * 평문만 보여준다. 반쪽 JSON 펜스가 카드로 깨져 보이는 것을 막는다.
 */
const stripFencesForPreview = (s: string): string =>
  (s ?? "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/```[\s\S]*$/, "")
    .trim();

/**
 * 값이 바뀌어도 최소 `ms` 간격으로만 갱신하는 throttle 훅. 스트리밍 중
 * 토큰마다 무거운 파싱·리렌더가 도는 걸 막기 위해 streamingText 를 throttle 한 뒤
 * 완성된 펜스를 추출한다(평문 프리뷰는 기존대로 매 토큰 갱신).
 */
function useThrottledValue<T>(value: T, ms: number): T {
  const [throttled, setThrottled] = useState(value);
  const lastRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const commit = () => {
      lastRef.current = Date.now();
      setThrottled(value);
    };
    const elapsed = Date.now() - lastRef.current;
    if (elapsed >= ms) {
      commit();
    } else {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(commit, ms - elapsed);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [value, ms]);
  return throttled;
}

/**
 * 스트리밍 중 점진 렌더 패널 — 닫힌 ```scene 펜스를 컷 카드로 하나씩 보여주고,
 * 전략/스펙 블록이 닫히면 칩으로 표시한다. 맨 아래엔 "쓰는 중" 스켈레톤 한 장을
 * 둬서 다음 블록이 작성 중임을 알린다. 완료되면 isLoading 이 풀려 정식 카드로 교체된다.
 */
const StreamingScenesPreview = React.memo(function StreamingScenesPreview({
  scenes,
  hasSpec,
  hasStrategy,
}: {
  scenes: ParsedScene[];
  hasSpec: boolean;
  hasStrategy: boolean;
}) {
  const clamp2: React.CSSProperties = {
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  };
  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-meta text-muted-foreground">
        {hasStrategy && <span className="px-1.5 py-0.5 border border-border">전략</span>}
        {hasSpec && <span className="px-1.5 py-0.5 border border-border">스펙</span>}
        {scenes.length > 0 && (
          <span className="font-semibold" style={{ color: KR }}>
            컷 {scenes.length}개 생성됨
          </span>
        )}
      </div>
      {scenes.map((s) => (
        <div key={s.scene_number} className="bg-card border border-border px-3 py-2" style={{ borderRadius: 0 }}>
          <div className="flex items-center gap-1.5 mb-1">
            <span
              className="font-mono text-meta font-bold px-1.5 py-0.5 text-white shrink-0"
              style={{ background: KR }}
            >
              #{String(s.scene_number).padStart(2, "0")}
            </span>
            {s.title && <span className="text-body font-semibold text-foreground truncate">{s.title}</span>}
          </div>
          {s.description && (
            <p className="text-body text-foreground/75 leading-snug" style={clamp2}>
              {s.description}
            </p>
          )}
          {(s.camera_angle || s.mood) && (
            <p className="text-meta text-muted-foreground mt-1 truncate">
              {[s.camera_angle, s.mood].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
      ))}
      <div className="bg-card border border-border px-3 py-2 animate-pulse" style={{ borderRadius: 0 }}>
        <div className="flex items-center gap-1.5 mb-1.5">
          <span className="h-4 w-7 shrink-0" style={{ background: "rgba(249,66,58,0.5)" }} />
          <span className="h-3 w-24 bg-muted-foreground/30" />
        </div>
        <div className="h-3 w-full bg-muted-foreground/20 mb-1" />
        <div className="h-3 w-3/5 bg-muted-foreground/20" />
      </div>
    </div>
  );
});

export const AgentTab = ({ projectId, videoFormat = "vertical", lang = "en", onSwitchToContiTab, isActive = true }: Props) => {
  const { toast } = useToast();
  const t = useT();
  const isMobile = useIsMobile();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [chatHistory, setChatHistory] = useState<ChatLog[]>([]);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [chatImages, setChatImages] = useState<ChatImage[]>([]);
  const [libraryImportOpen, setLibraryImportOpen] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  // createdAt → 전송 직후(업로드 완료 전) 메시지 버블에 띄울 미리보기 + 미디어 종류.
  const [sessionImageMap] = useState(() => new Map<string, Array<{ src: string; kind?: "gif" | "video" }>>());

  // 라이브러리 'Agent에 추가' 핸드오프: LS 큐에 쌓인 첨부를 작성칸으로 끌어온다.
  // mount 시 + 큐 변경 이벤트(이미 마운트된 채로 라이브러리에서 추가된 경우) 모두 drain.
  useEffect(() => {
    const drain = () => {
      const pending = readAgentChatImages(projectId);
      if (!pending.length) return;
      clearAgentChatImages(projectId);
      setChatImages((prev) => [...prev, ...pending].slice(0, CHAT_IMAGE_MAX));
    };
    drain();
    const onChanged = (e: Event) => {
      if ((e as CustomEvent).detail?.projectId === projectId) drain();
    };
    window.addEventListener(AGENT_CHAT_ATTACH_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(AGENT_CHAT_ATTACH_CHANGED_EVENT, onChanged);
  }, [projectId]);
  const [moodLightboxUrl, setMoodLightboxUrl] = useState<string | null>(null);
  const [moodImages, setMoodImages] = useState<MoodImage[]>([]);

  const [cardHeights, setCardHeights] = useState<Record<string, number>>({});
  const [showImages, setShowImages] = useState(true);
  const handlePendingUpdate = useCallback((updated: ParsedScene) => {
    setPendingScenes((prev) => prev.map((p) => (p.scene_number === updated.scene_number ? updated : p)));
    // setPendingScenes 는 아래쪽에서 useCallback 으로 정의되므로 deps 에 넣으면
    // TDZ. closure 캡처는 정상 동작이라 deps 비워두는 것이 올바름. PR-3 에서
    // setPendingScenes 정의를 위로 끌어올리면서 정식 dep 으로 바꿀 예정.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleContentHeight = useCallback((id: string, h: number) => {
    setCardHeights((prev) => {
      if (prev[id] === h) return prev;
      return { ...prev, [id]: h };
    });
  }, []);
  // 삭제된 scene 의 cardHeights 엔트리가 남아 sharedHeight 를 상향 고정하는 것을 방지.
  useEffect(() => {
    setCardHeights((prev) => {
      const sceneIds = new Set(scenes.map((s) => s.id));
      let changed = false;
      const next: Record<string, number> = {};
      for (const k of Object.keys(prev)) {
        if (sceneIds.has(k)) next[k] = prev[k];
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [scenes]);

  // ─── Scene 패널 폭 관측 + 이미지 컬럼 상한 계산 ───
  // Split 뷰에서 Mood 패널을 넓혀 Scene 패널이 좁아지면, Scene 카드의
  // imgWidth(= sharedHeight × wr/hr) 가 컨테이너를 잠식하면서 회색 placeholder 만
  // 남는 피드백 루프가 발생한다. 패널 폭을 기준으로 imgWidth / sharedHeight 양쪽에
  // 상한을 걸어 피드백 루프 자체를 차단한다.
  const [scenesPanelEl, setScenesPanelEl] = useState<HTMLDivElement | null>(null);
  const [scenesPanelWidth, setScenesPanelWidth] = useState(0);
  const scenesPanelRef = useCallback((el: HTMLDivElement | null) => {
    setScenesPanelEl(el);
  }, []);
  useEffect(() => {
    if (!scenesPanelEl) return;
    setScenesPanelWidth(scenesPanelEl.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setScenesPanelWidth(e.contentRect.width);
    });
    ro.observe(scenesPanelEl);
    return () => ro.disconnect();
  }, [scenesPanelEl]);

  // 이미지 컬럼이 패널 폭에서 차지할 수 있는 최대 비율.
  // 피드백 루프를 확실히 끊으려면 0.5 미만이어야 한다.
  const IMAGE_COL_MAX_RATIO = 0.35;
  const [imgWR, imgHR] =
    videoFormat === "horizontal" ? [16, 9] : videoFormat === "square" ? [1, 1] : [9, 16];
  const maxImgWidth =
    scenesPanelWidth > 0 ? Math.max(60, Math.floor(scenesPanelWidth * IMAGE_COL_MAX_RATIO)) : 9999;
  // sharedHeight 는 naturalHeight 를 따르되, maxImgWidth 에서 역산한 상한을 넘지 않게 캡.
  const maxSharedHeightFromPanel =
    scenesPanelWidth > 0 ? Math.floor((maxImgWidth * imgHR) / imgWR) : 9999;
  const naturalSharedHeight = Math.max(160, ...Object.values(cardHeights));
  const sharedHeight = Math.max(160, Math.min(naturalSharedHeight, maxSharedHeightFromPanel));

  const minPanelWidthForImage =
    videoFormat === "horizontal" ? 520 : videoFormat === "square" ? 400 : 330;
  const panelTooNarrowForImage =
    scenesPanelWidth > 0 && scenesPanelWidth < minPanelWidthForImage;
  const effectiveShowImages = showImages && !panelTooNarrowForImage;

  const moodImagesRef = useRef<MoodImage[]>([]);
  useEffect(() => {
    moodImagesRef.current = moodImages;
  }, [moodImages]);

  // ─── In-flight mood generation 동기화 (다중 배치 대응) ───
  // 탭 이동으로 AgentTab 이 unmount → remount 된 동안 진행되던 모든 배치의
  // 스켈레톤 + 도착 URL 을 모듈 store 에서 읽어와 moodImages 에 반영한다.
  //
  // 한 프로젝트에 여러 배치가 동시에 떠 있을 수 있으므로:
  //   1) 모든 배치의 skeleton ID 합집합을 구해 placeholder 가 누락된 게 있으면 앞에 끼워넣고,
  //   2) 각 skeleton ID 의 url 을 해당 배치의 arrivedUrls 에서 룩업해 in-place 갱신한다.
  // 위치(앞쪽) 는 이미 handleGenerate 의 prepend 로 결정되므로 여기서는 재정렬하지 않는다.
  useEffect(() => {
    const sync = () => {
      const allSkelIds = collectAllInFlightSkeletonIds(projectId);
      if (allSkelIds.size === 0) return;
      setMoodImages((prev) => {
        const presentIds = new Set(prev.map((img) => img.id));
        // 1) 누락된 skeleton placeholder 를 앞에 보충 (배치 시작 직후 remount 된 경우 대비).
        const missingSkeletons: MoodImage[] = [];
        for (const id of allSkelIds) {
          if (presentIds.has(id)) continue;
          missingSkeletons.push({
            id,
            url: lookupArrivedUrlForSkeleton(projectId, id),
            liked: false,
            sceneRef: null,
            comment: "",
            createdAt: new Date().toISOString(),
          });
        }
        // 2) 기존 항목 중 skeleton 인 것은 arrivedUrl 로 in-place 갱신.
        const updated = prev.map((img) => {
          if (!allSkelIds.has(img.id)) return img;
          const arrived = lookupArrivedUrlForSkeleton(projectId, img.id);
          if (img.url === arrived) return img;
          return { ...img, url: arrived };
        });
        return missingSkeletons.length > 0 ? [...missingSkeletons, ...updated] : updated;
      });
    };
    sync();
    return subscribeMoodGen(projectId, sync);
  }, [projectId]);

  const [pendingScenes, setPendingSceneState] = useState<ParsedScene[]>(
    () => _pendingScenesByProject.get(projectId) ?? loadPendingFromLS(projectId),
  );
  const setPendingScenes = useCallback(
    (val: ParsedScene[] | ((prev: ParsedScene[]) => ParsedScene[])) => {
      setPendingSceneState((prev) => {
        const next = typeof val === "function" ? val(prev) : val;
        _pendingScenesByProject.set(projectId, next);
        savePendingToLS(projectId, next);
        return next;
      });
    },
    [projectId],
  );

  // Agent-authored production spec (set/palette/cast/cinematography) for this
  // project's draft. Persisted to localStorage alongside pendingScenes so it
  // survives tab switches, then handed to Send-to-Conti to store on the version.
  const [pendingSpec, setPendingSpecState] = useState<ProductionSpec | null>(
    () => loadPendingSpecFromLS(projectId),
  );
  const setPendingSpec = useCallback(
    (val: ProductionSpec | null) => {
      setPendingSpecState(val);
      savePendingSpecToLS(projectId, val);
    },
    [projectId],
  );
  const abcdScenes = useMemo<Scene[]>(
    () => [
      ...scenes,
      ...pendingScenes.map((s) => ({
        id: `draft-${s.scene_number}`,
        project_id: projectId,
        scene_number: s.scene_number,
        sequence: typeof s.sequence === "number" ? s.sequence : null,
        title: s.title ?? null,
        description: s.description ?? null,
        camera_angle: s.camera_angle ?? null,
        location: s.location ?? null,
        mood: s.mood ?? null,
        duration_sec: typeof s.duration_sec === "number" ? s.duration_sec : null,
        tagged_assets: s.tagged_assets ?? [],
        conti_image_url: null,
        is_highlight: s.is_highlight,
        highlight_kind: s.highlight_kind,
        highlight_reason: s.highlight_reason,
      })),
    ],
    [scenes, pendingScenes, projectId],
  );

  const [briefAnalysis, setBriefAnalysis] = useState<Analysis | null>(null);
  const [briefLang, setBriefLang] = useState<"ko" | "en">(lang);
  // 연출 방향 모드(서사/모션/하이브리드). null = 미확정 → 진입 시 선제안 게이팅.
  // ref 는 handleSend/auto-init 같은 async 클로저에서 최신값을 동기 참조하기 위함.
  const [directionMode, setDirectionModeState] = useState<DirectionMode | null>(null);
  // 연출 방향 아코디언 열림 상태(채팅 입력창 위 항상 노출되는 모드 선택기).
  const [directionOpen, setDirectionOpen] = useState(false);
  const directionModeRef = useRef<DirectionMode | null>(null);
  useEffect(() => {
    directionModeRef.current = directionMode;
  }, [directionMode]);
  const persistDirectionMode = useCallback(
    async (mode: DirectionMode) => {
      if (directionModeRef.current === mode) return;
      setDirectionModeState(mode);
      directionModeRef.current = mode;
      try {
        await supabase.from("projects").update({ direction_mode: mode }).eq("id", projectId);
      } catch (e) {
        console.warn("[AgentTab] persist direction_mode failed", e);
      }
    },
    [projectId],
  );
  /** 어시스턴트 응답 텍스트에 direction.confirmed 펜스가 있으면 모드를 확정 반영. */
  const applyConfirmedDirection = useCallback(
    (text: string) => {
      try {
        for (const seg of parseMessageSegments(text)) {
          if (seg.type === "direction" && seg.data?.confirmed) {
            void persistDirectionMode(seg.data.confirmed);
            break;
          }
        }
      } catch {
        /* ignore parse issues */
      }
    },
    [persistDirectionMode],
  );
  const [isLoading, setIsLoading] = useState(false);
  // 스트리밍 중 누적되는 어시스턴트 텍스트(임시 버블). 완료 시 chatHistory 로
  // 커밋하고 초기화한다. 빈 문자열이면 기존 점멸 인디케이터를 보여준다.
  const [streamingText, setStreamingText] = useState("");
  // 점진 렌더용: streamingText 를 throttle 해서 완성된 펜스만 파싱한다. 평문
  // 프리뷰(stripFencesForPreview)는 기존대로 매 토큰 갱신하고, 무거운 추출만
  // 120ms 간격으로 돌려 컷 카드를 하나씩 차오르게 한다.
  const throttledStreamingText = useThrottledValue(streamingText, 120);
  const liveStreamScenes = useMemo(
    () => (isLoading ? extractScenesFromText(throttledStreamingText) : []),
    [isLoading, throttledStreamingText],
  );
  const liveStreamHasSpec = useMemo(
    () => (isLoading ? !!extractSpecFromText(throttledStreamingText) : false),
    [isLoading, throttledStreamingText],
  );
  const liveStreamHasStrategy = useMemo(
    () => (isLoading ? /```strategy(?![a-z_])[\s\S]*?```/.test(throttledStreamingText) : false),
    [isLoading, throttledStreamingText],
  );
  const [initialLoaded, setInitialLoaded] = useState(false);
  // 브리프 재조회 트리거. (1) 분석 완료 알림 (2) 탭 활성화 시점에 증가시켜
  // 아래 auto-init load() 이펙트를 다시 돌린다. 백그라운드 prefetch 로 분석 전에
  // 미리 마운트된 AgentTab 이 "브리프 없음" 상태로 고착되는 문제를 해결한다.
  const [briefFetchNonce, setBriefFetchNonce] = useState(0);
  const [projectAssets, setProjectAssets] = useState<Asset[]>([]);
  const [showSendModal, setShowSendModal] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [replaceConfirmBuffer, setReplaceConfirmBuffer] = useState<ParsedScene[] | null>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  // 탭 이동 후 복귀 시 마지막 우측 패널 상태(scenes / mood / split) 가 유지되도록 프로젝트별 localStorage 에 기록.
  const rightPanelKey = `ff_agent_right_panel_${projectId}`;
  const splitViewKey = `ff_agent_split_view_${projectId}`;
  const [rightPanel, setRightPanelState] = useState<RightPanel>(() => {
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem(rightPanelKey) : null;
      if (raw === "scenes" || raw === "mood") return raw;
    } catch {}
    return "scenes";
  });
  const setRightPanel = useCallback(
    (val: RightPanel | ((prev: RightPanel) => RightPanel)) => {
      setRightPanelState((prev) => {
        const next = typeof val === "function" ? (val as (p: RightPanel) => RightPanel)(prev) : val;
        try {
          window.localStorage.setItem(rightPanelKey, next);
        } catch {}
        return next;
      });
    },
    [rightPanelKey],
  );
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [splitView, setSplitViewState] = useState<boolean>(() => {
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem(splitViewKey) : null;
      if (raw === "1") return true;
      if (raw === "0") return false;
    } catch {}
    return false;
  });
  const setSplitView = useCallback(
    (val: boolean | ((prev: boolean) => boolean)) => {
      setSplitViewState((prev) => {
        const next = typeof val === "function" ? (val as (p: boolean) => boolean)(prev) : val;
        try {
          window.localStorage.setItem(splitViewKey, next ? "1" : "0");
        } catch {}
        return next;
      });
    },
    [splitViewKey],
  );
  const prevScenesLenRef = useRef<number | null>(null);
  const pendingOrderNotice = useRef<string | null>(null);
  // 탭 이동 시 AgentTab 이 언마운트 되므로, 진행 중인 LLM 호출이 언마운트 이후에
  // 로컬 state 를 건드리지 않도록 mountedRef 로 가드.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const [versions, setVersions] = useState<
    { id: string; version_name: string | null; version_number: number; scenes: any[] }[]
  >([]);
  const [showLoadModal, setShowLoadModal] = useState(false);

  const saveMoodImagesToDB = useCallback(
    async (images: MoodImage[]) => {
      const { data: brief } = await supabase
        .from("briefs")
        .select("id")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      if (brief)
        await supabase
          .from("briefs")
          .update({ mood_image_urls: images } as any)
          .eq("id", brief.id);
    },
    [projectId],
  );

  useEffect(() => {
    if (getMoodGenBatches(projectId).some((batch) => batch.promise !== null)) return;
    if (hasStoredPendingMoodBatches(projectId)) return;
    if (!moodImages.some((img) => img.url === null)) return;
    const healedImages = moodImages.filter((img) => img.url !== null);
    setMoodImages(healedImages);
    void saveMoodImagesToDB(healedImages);
  }, [moodImages, projectId, saveMoodImagesToDB]);

  const fetchAssets = useCallback(async () => {
    const { data, error } = await supabase
      .from("assets")
      .select("tag_name,photo_url,ai_description,asset_type,role_description,outfit_description,space_description")
      .eq("project_id", projectId);
    if (error) {
      console.warn("[AgentTab] fetchAssets skipped after transient read error:", error.message);
      return null;
    }
    if (data) setProjectAssets(data as Asset[]);
    return data as Asset[] | null;
  }, [projectId]);

  // Mirror ContiTab: live-merge assets created in another tab so the
  // mention resolver in scene fields/chat input doesn't operate on a
  // stale list (which would silently corrupt tagged_assets[]).
  useEffect(() => {
    const onAssetCreated = (e: Event) => {
      const ce = e as CustomEvent<Asset & { project_id?: string }>;
      const created = ce.detail;
      if (!created || !created.tag_name) return;
      if (created.project_id && created.project_id !== projectId) return;
      setProjectAssets((prev) => {
        if (prev.some((a) => a.tag_name === created.tag_name)) return prev;
        return [...prev, created as Asset];
      });
    };
    window.addEventListener("preflow:asset-created", onAssetCreated as EventListener);
    return () =>
      window.removeEventListener("preflow:asset-created", onAssetCreated as EventListener);
  }, [projectId]);

  const fetchScenes = useCallback(async () => {
    const { data, error } = await supabase
      .from("scenes")
      .select("*")
      .eq("project_id", projectId)
      .eq("source", "agent")
      .order("scene_number", { ascending: true });
    if (error) {
      console.warn("[AgentTab] fetchScenes skipped after transient read error:", error.message);
      return;
    }
    if (data) setScenes(data as Scene[]);
  }, [projectId]);

  const fetchBrief = useCallback(async () => {
    const { data, error } = await supabase
      .from("briefs")
      .select("analysis,mood_image_urls,lang")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    if (error) {
      console.warn("[AgentTab] fetchBrief skipped after transient read error:", error.message);
      return null;
    }
    if (data?.analysis) setBriefAnalysis(data.analysis as unknown as Analysis);
    if ((data as any)?.lang) setBriefLang((data as any).lang as "ko" | "en");
    if ((data as any)?.mood_image_urls) {
      const dbImages = toMoodImages((data as any).mood_image_urls as (string | MoodImage)[]).map((img) =>
        img.url ? { ...img, url: normalizeStorageUrl(img.url) ?? img.url } : img,
      );
      // In-flight generation 의 skeleton placeholder 가 있으면 모두 앞에 보존 (다중 배치 대응).
      // 각 배치의 skeleton 순서를 유지하되, 배치 자체는 시작 순서대로(오래된 → 최신) 나열한다.
      // handleGenerate 가 새 배치를 prepend 하므로 시각적으로는 최신 배치가 위쪽이지만,
      // remount 시 한 번에 재구성할 때는 시작 순서를 그대로 따라도 사용자 경험상 큰 차이가 없다.
      const batches = getMoodGenBatches(projectId).filter((b) => b.promise !== null);
      const storedSkeletons = storedPendingMoodSkeletons(projectId);
      if (batches.length > 0 || storedSkeletons.length > 0) {
        const allSkelIdSet = new Set<string>();
        const skeletons: MoodImage[] = [];
        for (const b of batches) {
          for (let i = 0; i < b.skeletonIds.length; i++) {
            const id = b.skeletonIds[i];
            allSkelIdSet.add(id);
            skeletons.push({
              id,
              url: b.arrivedUrls[i] ?? null,
              liked: false,
              sceneRef: null,
              comment: "",
              createdAt: new Date().toISOString(),
            });
          }
        }
        for (const skel of storedSkeletons) {
          if (allSkelIdSet.has(skel.id)) continue;
          allSkelIdSet.add(skel.id);
          skeletons.push(skel);
        }
        const dbWithoutSkel = dbImages.filter((img) => !allSkelIdSet.has(img.id));
        setMoodImages([...skeletons, ...dbWithoutSkel]);
      } else {
        const healedImages = dbImages.filter((img) => img.url !== null);
        setMoodImages(healedImages);
        if (healedImages.length !== dbImages.length) {
          void saveMoodImagesToDB(healedImages);
        }
      }
    }
    return data?.analysis ? (data.analysis as unknown as Analysis) : null;
  }, [projectId, saveMoodImagesToDB]);

  const handleSceneUpdate = useCallback(async (id: string, fields: Partial<Scene>) => {
    await supabase.from("scenes").update(fields).eq("id", id);
    setScenes((prev) => prev.map((s) => (s.id === id ? { ...s, ...fields } : s)));
  }, []);

  const handleAttachMoodToScene = useCallback(
    async (imageUrl: string, sceneId: string, moodImageId: string, sceneNumber: number) => {
      await supabase.from("scenes").update({ conti_image_url: imageUrl }).eq("id", sceneId);
      setScenes((prev) => prev.map((s) => (s.id === sceneId ? { ...s, conti_image_url: imageUrl } : s)));
      setMoodImages((prev) => {
        const next = prev.map((img) => (img.id === moodImageId ? { ...img, sceneRef: sceneNumber } : img));
        saveMoodImagesToDB(next);
        return next;
      });
    },
    [saveMoodImagesToDB],
  );

  const handleSceneDrop = useCallback(
    async (
      sceneId: string,
      sceneNumber: number,
      payload: { moodImageId: string; url: string },
    ) => {
      if (!payload?.url) return;
      await handleAttachMoodToScene(payload.url, sceneId, payload.moodImageId, sceneNumber);
      toast({ title: t("mood.attachedToast", { scene: sceneNumber }) });
    },
    [handleAttachMoodToScene, toast, t],
  );

  const handleClearSceneImage = useCallback(
    async (scene: Scene) => {
      const prevUrl = scene.conti_image_url;
      await supabase.from("scenes").update({ conti_image_url: null }).eq("id", scene.id);
      setScenes((prev) => prev.map((s) => (s.id === scene.id ? { ...s, conti_image_url: null } : s)));
      setMoodImages((prev) => {
        const next = prev.map((img) =>
          img.url === prevUrl && img.sceneRef === scene.scene_number ? { ...img, sceneRef: null } : img,
        );
        saveMoodImagesToDB(next);
        return next;
      });
    },
    [saveMoodImagesToDB],
  );

  const handleDetachFromScene = useCallback(
    async (moodImageId: string, sceneNumber: number) => {
      const scene = scenes.find((s) => s.scene_number === sceneNumber);
      const img = moodImages.find((i) => i.id === moodImageId);
      if (scene && img && scene.conti_image_url === img.url) {
        await supabase.from("scenes").update({ conti_image_url: null }).eq("id", scene.id);
        setScenes((prev) => prev.map((s) => (s.id === scene.id ? { ...s, conti_image_url: null } : s)));
      }
      setMoodImages((prev) => {
        const next = prev.map((i) => (i.id === moodImageId ? { ...i, sceneRef: null } : i));
        saveMoodImagesToDB(next);
        return next;
      });
    },
    [scenes, moodImages, saveMoodImagesToDB],
  );

  const handleDeleteMoodImages = useCallback(
    async (ids: string[]) => {
      const idsSet = new Set(ids);
      const connectedSceneIds: string[] = [];
      // 삭제 대상의 파일 URL 후보 — 실제 디스크 삭제는 뒤에서 프로젝트
      // 전반(`scene.conti_image_url`, `conti_image_history`, `sketches`,
      // `scene_versions.scenes` 스냅샷 등) 을 훑는 중앙 가드로 한번 더 검사한다.
      // 기존 코드는 "현재 live `conti_image_url` 과 매치되면 씬 쪽이 처리"
      // 로만 가정했는데, Mood → 씬으로 올린 이미지를 씬에서 Regenerate 하면
      // 그 URL 은 live 에서 빠지고 `conti_image_history` 로 이동한다. 그
      // 상태에서 Mood 쪽 삭제를 하면 history 에 남은 URL 의 파일이 지워져
      // HistorySheet 엑박이 되는 회귀를 유발했다 → 중앙 가드로 차단.
      const candidateUrls: string[] = [];
      for (const id of ids) {
        const img = moodImages.find((i) => i.id === id);
        if (!img) continue;
        if (img.sceneRef !== null && img.sceneRef !== undefined) {
          const scene = scenes.find((s) => s.scene_number === img.sceneRef && s.conti_image_url === img.url);
          if (scene) connectedSceneIds.push(scene.id);
        }
        if (img.url) candidateUrls.push(img.url);
      }
      if (connectedSceneIds.length > 0) {
        await Promise.all(
          connectedSceneIds.map((sceneId) =>
            supabase.from("scenes").update({ conti_image_url: null }).eq("id", sceneId),
          ),
        );
        setScenes((prev) => prev.map((s) => (connectedSceneIds.includes(s.id) ? { ...s, conti_image_url: null } : s)));
      }
      const nextMood = moodImages.filter((i) => !idsSet.has(i.id));
      setMoodImages(nextMood);
      // DB (briefs.mood_image_urls) 업데이트를 먼저 await 한 뒤 참조 검사를
      // 돌려야 "방금 뺀 자기 자신" 이 false-positive 로 잡혀 파일이
      // orphan 으로 남는 걸 피할 수 있다.
      await saveMoodImagesToDB(nextMood);
      window.dispatchEvent(
        new CustomEvent("preflow:mood-images-deleted", {
          detail: {
            projectId,
            urls: candidateUrls.flatMap((url) => {
              const normalized = normalizeStorageUrl(url) ?? url;
              return normalized === url ? [url] : [url, normalized];
            }),
          },
        }),
      );
      await Promise.all(
        candidateUrls.map((u) => deleteStoredFileIfUnreferenced(projectId, u)),
      );
    },
    [moodImages, scenes, saveMoodImagesToDB, projectId],
  );

  const clearScenesAfterSend = useCallback(async () => {
    await supabase.from("scenes").delete().eq("project_id", projectId).eq("source", "agent");
    setScenes([]);
    setPendingScenes([]);
    setPendingSpec(null);
    const unlinkedMood = moodImagesRef.current.map((img) =>
      img.sceneRef === null ? img : { ...img, sceneRef: null },
    );
    setMoodImages(unlinkedMood);
    await saveMoodImagesToDB(unlinkedMood);
  }, [projectId, saveMoodImagesToDB, setPendingScenes]);

  const fetchVersions = useCallback(async () => {
    const { data, error } = await supabase
      .from("scene_versions")
      .select("id,version_name,version_number,scenes")
      .eq("project_id", projectId)
      .order("display_order", { ascending: true });
    if (error) {
      console.warn("[AgentTab] fetchVersions skipped after transient read error:", error.message);
      return versions;
    }
    setVersions((data ?? []) as any[]);
    return (data ?? []) as any[];
  }, [projectId, versions]);

  const handleLoadVersion = useCallback(
    async (versionScenes: any[]) => {
      // Only wipe agent-sourced scenes. Conti-sourced rows (the ones shown in
      // the Conti tab) must survive because the user is re-populating the
      // Ideation tab with a snapshot, not replacing the whole project.
      // Without the `source=agent` filter, loading a version here used to
      // delete every scene the Conti tab was actively editing.
      await supabase.from("scenes").delete().eq("project_id", projectId).eq("source", "agent");
      const storyScenes = versionScenes.filter((s: any) => s.is_transition !== true && !s.transition_type);
      const toInsert = storyScenes.map((s: any, i: number) => ({
        project_id: projectId,
        scene_number: i + 1,
        sequence: typeof s.sequence === "number" ? s.sequence : null,
        title: s.title ?? `Shot ${i + 1}`,
        description: s.description ?? "",
        camera_angle: s.camera_angle ?? "",
        location: s.location ?? "",
        mood: s.mood ?? "",
        duration_sec: s.duration_sec ?? null,
        tagged_assets: s.tagged_assets ?? [],
        is_highlight: s.is_highlight ?? false,
        highlight_kind: s.highlight_kind ?? null,
        highlight_reason: s.highlight_reason ?? null,
        conti_image_url: null,
        source: "agent",
      }));
      const { data } = await supabase.from("scenes").insert(toInsert).select();
      if (data) setScenes(data as Scene[]);
      setPendingScenes([]);
      toast({ title: t("agent.versionLoaded") });
    },
    [projectId, setPendingScenes, t, toast],
  );

  const saveScenesToDB = useCallback(
    async (parsed: ParsedScene[], mode: "replace" | "append") => {
      const newScenes = parsed
        .filter((s) => s.scene_number && typeof s.scene_number === "number")
        .map((s) => {
          const jsonTags = (Array.isArray(s.tagged_assets) ? s.tagged_assets : []).map((t: string) =>
            t.startsWith("@") ? t : `@${t}`,
          );
          const extractNormalized = (text: string) =>
            (text.match(/@([\w가-힣-]+)/g) ?? [])
              .map((m) => {
                const r = resolveAsset(m, projectAssets);
                return r ? `@${r.name}` : null;
              })
              .filter((n): n is string => n !== null);
          const allRaw = [
            ...new Set([
              ...jsonTags,
              ...extractNormalized(s.description ?? ""),
              ...extractNormalized(s.location ?? ""),
            ]),
          ];
          const registeredTags =
            projectAssets.length > 0
              ? allRaw.filter((tag) => {
                  const raw = tag.startsWith("@") ? tag.slice(1) : tag;
                  return projectAssets.some((a) => {
                    const an = a.tag_name.startsWith("@") ? a.tag_name.slice(1) : a.tag_name;
                    return an === raw;
                  });
                })
              : allRaw;
          return {
            project_id: projectId,
            scene_number: s.scene_number,
            sequence: typeof s.sequence === "number" ? s.sequence : null,
        title: s.title ?? `Shot ${s.scene_number}`,
            description: s.description ?? "",
            camera_angle: s.camera_angle ?? "",
            location: s.location ?? "",
            mood: s.mood ?? "",
            emotional_beat: s.emotional_beat ?? null,
            duration_sec: typeof s.duration_sec === "number" ? s.duration_sec : null,
            tagged_assets: registeredTags,
            is_highlight: s.is_highlight ?? false,
            highlight_kind: s.highlight_kind ?? null,
            highlight_reason: s.highlight_reason ?? null,
            motion_in: s.motion_in ?? null,
            motion_out: s.motion_out ?? null,
            transition_to_next: s.transition_to_next ?? null,
          };
        });
      if (!newScenes.length) return;
      if (mode === "replace") {
        await supabase.from("scenes").delete().eq("project_id", projectId).eq("source", "agent");
        const { error } = await supabase.from("scenes").insert(newScenes.map((s) => ({ ...s, source: "agent" })));
        if (error) {
          toast({ title: t("agent.failedSaveScenes"), description: error.message, variant: "destructive" });
          return;
        }
      } else {
        const { data: existing } = await supabase
          .from("scenes")
          .select("scene_number")
          .eq("project_id", projectId)
          .order("scene_number", { ascending: false })
          .limit(1);
        const offset = existing?.[0]?.scene_number ?? 0;
        const { error } = await supabase
          .from("scenes")
          .insert(newScenes.map((s, i) => ({ ...s, scene_number: offset + i + 1, source: "agent" })));
        if (error) {
          toast({ title: t("agent.failedSaveScenes"), description: error.message, variant: "destructive" });
          return;
        }
      }
      await fetchScenes();
    },
    [projectId, fetchScenes, projectAssets, t, toast],
  );

  const handleConfirmScenes = useCallback(
    async (mode: "replace" | "append") => {
      if (!pendingScenes.length) return;
      await saveScenesToDB(pendingScenes, mode);
      setPendingScenes([]);
      toast({ title: t("agent.scenesConfirmed", { count: pendingScenes.length }) });
    },
    [pendingScenes, saveScenesToDB, t, toast, setPendingScenes],
  );

  const handleClickConfirm = useCallback(() => {
    if (scenes.length > 0) setShowConfirmModal(true);
    else handleConfirmScenes("replace");
  }, [scenes.length, handleConfirmScenes]);

  const handleReplaceConfirm = useCallback(async () => {
    if (!replaceConfirmBuffer) return;
    await supabase.from("scenes").delete().eq("project_id", projectId);
    setScenes([]);
    setPendingScenes(replaceConfirmBuffer);
    setReplaceConfirmBuffer(null);
  }, [replaceConfirmBuffer, projectId, setPendingScenes]);

  useEffect(() => {
    const load = async () => {
      const [chatRes] = await Promise.all([
        supabase.from("chat_logs").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
        fetchScenes(),
      ]);
      const [analysis, assets] = await Promise.all([fetchBrief(), fetchAssets()]);
      if (chatRes.error) {
        console.warn("[AgentTab] chat load skipped after transient read error:", chatRes.error.message);
        return;
      }
      if (chatRes.data?.length) {
        setChatHistory(chatRes.data as ChatLog[]);
        setInitialLoaded(true);
        return;
      }
      setInitialLoaded(true);
      if (analysis) {
        // 이미 다른 마운트에서 auto-init 이 돌고 있다면 중복 호출 방지
        if (getChatGen(projectId)?.inFlight) return;
        setIsLoading(true);
        setChatGen(projectId, { inFlight: true, startedAt: Date.now() });
        try {
          const { data: briefRow } = await supabase
            .from("briefs")
            .select("lang")
            .eq("project_id", projectId)
            .order("created_at", { ascending: false })
            .limit(1)
            .single();
          const initLang = ((briefRow as any)?.lang ?? "ko") as "ko" | "en";
          // 진입 시 확정된 연출 방향 로드. 미확정(NULL)이면 첫 응답에서 방향
          // 선제안(게이팅), 이미 확정돼 있으면 곧바로 시놉시스를 요청한다.
          let initMode: DirectionMode | null = null;
          try {
            const { data: projRow } = await supabase
              .from("projects")
              .select("direction_mode")
              .eq("id", projectId)
              .single();
            const dm = (projRow as { direction_mode?: string } | null)?.direction_mode;
            if (dm === "narrative" || dm === "motion" || dm === "hybrid") initMode = dm;
          } catch {
            /* projects 미지원 구버전 — 게이팅 기본값(null) 유지 */
          }
          if (initMode && directionModeRef.current !== initMode) {
            setDirectionModeState(initMode);
            directionModeRef.current = initMode;
          }
          const briefCtx = buildBriefContextString(analysis, initLang);
          const prefix = initLang === "en" ? "[Brief Analysis]" : "[브리프 분석 결과]";
          const tail = !initMode
            ? initLang === "en"
              ? "\n\nBefore proposing synopses, recommend a direction first: output ONLY one ```direction fence (narrative / motion / hybrid + a recommended one + a one-line reason each). Do NOT write storylines or scenes yet."
              : "\n\n시놉시스를 짜기 전에 먼저 연출 방향을 추천해줘: ```direction 펜스 1개만 출력해(서사/모션/균형 3안 + 추천 1개 + 각 1줄 근거). 아직 storylines나 씬은 짜지 마."
            : initLang === "en"
              ? "\n\nBased on this brief, propose 2–3 synopsis directions in a storylines block. Do not write scenes yet."
              : "\n\n이 브리프를 바탕으로 방향성이 다른 시놉시스 2~3안을 storylines 블록으로 제안해주세요. 아직 씬은 짜지 마세요.";
          const autoPrompt = `${prefix}\n${briefCtx}${tail}`;
          await supabase.from("chat_logs").insert({ project_id: projectId, role: "user", content: autoPrompt });
          await ensureSettingsLoaded();
          const agentModelId = getModel("agent");
          const agentMeta = getModelMeta(agentModelId, getSettingsCached());
          if (mountedRef.current) setStreamingText("");
          const llmResult = await callLLMStream(
            {
              model: agentModelId,
              // OpenAI 1M ctx 모델 등 메타가 있으면 카탈로그 기준 max_tokens 사용,
              // 없으면 callLLMStream 이 카탈로그 디폴트로 폴백.
              max_tokens: agentMeta?.maxOutputTokens ?? 4096,
              system: buildSystemPrompt(videoFormat, assets ?? undefined, analysis, initLang, agentMeta?.provider, initMode),
              messages: [{ role: "user", content: autoPrompt }],
              // 진입 첫 응답: 방향 선제안(미확정)은 가볍게, 시놉시스 제안은 보통.
              reasoningEffort: initMode ? "medium" : "low",
            },
            {
              onDelta: (full) => {
                if (mountedRef.current) setStreamingText(full);
              },
            },
          );
          const msg = llmResult.text;
          await supabase.from("chat_logs").insert({ project_id: projectId, role: "assistant", content: msg });
          applyConfirmedDirection(msg);
          const extractedSpec = extractSpecFromText(msg);
          if (extractedSpec) setPendingSpec(extractedSpec);
          const extracted = extractScenesFromText(msg);
          if (extracted.length > 0) {
            if (mountedRef.current) {
              setPendingScenes(extracted);
            } else {
              patchChatGen(projectId, {
                pendingExtractedScenes: extracted,
                pendingExtractedNeedsReplaceConfirm: false,
              });
            }
          }
          if (mountedRef.current) {
            setChatHistory([
              { project_id: projectId, role: "user", content: autoPrompt, created_at: new Date().toISOString() },
              { project_id: projectId, role: "assistant", content: msg, created_at: new Date().toISOString() },
            ]);
          }
        } catch (err) {
          console.error("Auto-init error:", err);
        } finally {
          if (mountedRef.current) {
            setIsLoading(false);
            setStreamingText("");
          }
          const cur = getChatGen(projectId);
          if (cur?.pendingExtractedScenes && cur.pendingExtractedScenes.length) {
            patchChatGen(projectId, { inFlight: false });
          } else {
            setChatGen(projectId, null);
          }
        }
      }
    };
    load();
    // setPendingScenes / videoFormat 도 본문에서 쓰지만 *의도적으로* deps 에서
    // 제외한다 — 이 effect 는 "프로젝트 진입 시 1회 auto-init" 용이고, 사용자가
    // 도중에 videoFormat 을 바꿨다고 chat 을 다시 자동 초기화 / 시스템 프롬프트
    // 재삽입 하면 진행 중 대화를 덮어쓰는 회귀가 난다. setPendingScenes 는 아래
    // 쪽에서 useCallback 으로 정의돼 deps 에 넣으면 TDZ. 둘 다 PR-3 에서 정식
    // 처리 예정.
    // briefFetchNonce 가 바뀌면 (분석 완료 알림 / 탭 활성화) 브리프를 재조회하고
    // 필요 시 auto-init 을 다시 시도한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, fetchScenes, fetchBrief, fetchAssets, briefFetchNonce]);

  // ── Fix 1: 브리프 분석 완료 알림 구독 ──────────────────────────────
  // 백그라운드 prefetch 로 분석 전에 미리 마운트된 경우, 분석이 끝나는 순간
  // nonce 를 올려 위 load() 가 재실행되며 브리프를 재조회 + auto-init 한다.
  // (BriefTab 의 briefFetchNonce 패턴과 동일한 메커니즘.)
  useEffect(() => {
    let prevAnalyzing = briefAnalysisRegistry.isAnalyzing(projectId);
    return briefAnalysisRegistry.subscribe(projectId, ({ analyzing }) => {
      if (prevAnalyzing && !analyzing) {
        setBriefFetchNonce((n) => n + 1);
      }
      prevAnalyzing = analyzing;
    });
  }, [projectId]);

  // ── Fix 2: 탭 활성화 시 브리프 재조회 ──────────────────────────────
  // 다른 진입 순서(예: 분석을 마친 뒤 Ideation 으로 전환)에서도, 활성화 시점에
  // 아직 브리프가 비어 있으면 한 번 더 재조회를 트리거한다. 이미 브리프가 있거나
  // 로딩 중이면 아무 것도 하지 않는다.
  const prevActiveRef = useRef(isActive);
  useEffect(() => {
    const became = isActive && !prevActiveRef.current;
    prevActiveRef.current = isActive;
    // 빈 상태(웰컴 노출)일 때만 재조회 — 브리프 없이 채팅 중인 프로젝트에서
    // 탭 전환마다 chat_logs 를 재fetch 하는 낭비/스크롤 점프를 피한다.
    if (became && !briefAnalysis && !isLoading && !chatHistory.length) {
      setBriefFetchNonce((n) => n + 1);
    }
  }, [isActive, briefAnalysis, isLoading, chatHistory.length]);

  // ✅ 탭 이동 후 복귀 시, 모듈 스토어에 남아있는 in-flight LLM 호출 상태를 복원한다.
  //    - inFlight 중이면 로딩 인디케이터를 켜두고,
  //    - 완료(스토어가 비워짐)되면 chat_logs 를 재조회해 어시스턴트 응답을 반영,
  //    - 완료 시점에 보관된 pendingExtractedScenes 가 있으면 소비.
  useEffect(() => {
    const hydrateFromStore = () => {
      const state = getChatGen(projectId);
      if (!state) return;
      if (state.inFlight) {
        setIsLoading(true);
      }
      if (state.pendingExtractedScenes && state.pendingExtractedScenes.length > 0) {
        const extracted = state.pendingExtractedScenes;
        const needsReplace = !!state.pendingExtractedNeedsReplaceConfirm;
        const replaceDrafts = !!state.pendingExtractedReplaceDrafts;
        if (needsReplace) {
          setReplaceConfirmBuffer(extracted);
        } else {
          setPendingScenes((prev) => mergeOrReplaceDrafts(prev, extracted, replaceDrafts));
        }
        // 소비 후 정리
        if (state.inFlight) {
          patchChatGen(projectId, {
            pendingExtractedScenes: undefined,
            pendingExtractedNeedsReplaceConfirm: undefined,
            pendingExtractedReplaceDrafts: undefined,
          });
        } else {
          setChatGen(projectId, null);
        }
      }
    };

    hydrateFromStore();

    const unsub = subscribeChatGen(projectId, () => {
      const state = getChatGen(projectId);
      if (!state) {
        // 완전히 비워짐 → 완료. 로딩 해제 + chat_logs 재조회.
        if (mountedRef.current) {
          setIsLoading(false);
          supabase
            .from("chat_logs")
            .select("*")
            .eq("project_id", projectId)
            .order("created_at", { ascending: true })
            .then(({ data }) => {
              if (data && mountedRef.current) setChatHistory(data as ChatLog[]);
            });
        }
        return;
      }
      if (state.inFlight && mountedRef.current) {
        setIsLoading(true);
      }
      if (!state.inFlight && state.pendingExtractedScenes && state.pendingExtractedScenes.length > 0) {
        // 완료됐지만 extracted scenes 가 아직 소비되지 않은 상태 → 소비.
        hydrateFromStore();
      }
    });

    return unsub;
  }, [projectId, setPendingScenes]);

  // 채팅 패널은 collapse/재오픈 시 통째로 언마운트→remount 되어 스크롤 컨테이너가
  // 새 DOM 노드로 교체된다. useRef + useEffect([]) 로는 새 노드에 리스너가 다시
  // 안 붙고 scrollTop=0(맨 위) 으로 리셋되는 문제가 있어, callback ref 로 마운트
  // 시점마다 (1) 스크롤 리스너 재부착 (2) 마지막 메시지로 즉시 점프 를 처리한다.
  const scrollCleanupRef = useRef<(() => void) | null>(null);
  const setChatContainer = useCallback((node: HTMLDivElement | null) => {
    if (scrollCleanupRef.current) {
      scrollCleanupRef.current();
      scrollCleanupRef.current = null;
    }
    chatContainerRef.current = node;
    if (!node) return;
    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = node;
      setUserScrolledUp(scrollTop + clientHeight < scrollHeight - 100);
    };
    node.addEventListener("scroll", onScroll);
    scrollCleanupRef.current = () => node.removeEventListener("scroll", onScroll);
    // 마운트 직후 바닥으로 즉시 점프 (재오픈 시 scrollTop=0 리셋 보정).
    requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
    });
  }, []);

  useEffect(() => {
    if (!userScrolledUp && (isLoading || chatHistory.length > 0))
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory, isLoading, userScrolledUp]);

  // 탭 복귀(display:none → block) 는 컨테이너가 unmount 되지 않아 callback ref 가
  // 안 불린다. 이 경로의 scrollTop 리셋은 별도 effect 로 보정한다. chatCollapsed
  // 가 풀려 재오픈되는 경우는 callback ref 가 처리하므로 여기선 닫힘 상태를 스킵.
  useEffect(() => {
    if (!isActive || chatCollapsed) return;
    const id = requestAnimationFrame(() => {
      const c = chatContainerRef.current;
      if (c) c.scrollTop = c.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [isActive, chatCollapsed]);

  useEffect(() => {
    if (prevScenesLenRef.current === null) {
      prevScenesLenRef.current = scenes.length;
      return;
    }
    if (
      prevScenesLenRef.current === 0 &&
      scenes.length > 0 &&
      !chatCollapsed &&
      !isMobile
    ) {
      setChatCollapsed(true);
    }
    prevScenesLenRef.current = scenes.length;
  }, [scenes.length, chatCollapsed, isMobile]);

  const addImages = useCallback(
    async (files: FileList | File[]) => {
      const arr = Array.from(files)
        .filter((f) => f.type.startsWith("image/"))
        .slice(0, 4 - chatImages.length);
      if (!arr.length) return;
      const converted = await Promise.all(arr.map(fileToBase64));
      setChatImages((prev) => [...prev, ...converted].slice(0, 4));
    },
    [chatImages.length],
  );

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };
  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragOver(false);
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files?.length) addImages(e.dataTransfer.files);
  };

  // ✅ [FIX] handleSend — 매 전송마다 briefAnalysis DB re-fetch
  const handleSend = async (directText?: string) => {
    const rawText = directText ?? "";
    const orderNotice = pendingOrderNotice.current;
    pendingOrderNotice.current = null;
    const text = orderNotice ? `${orderNotice}\n\n${rawText}`.trim() : rawText.trim();
    if (!text || isLoading) return;
    // 모듈 스토어 레벨에서도 중복 전송 가드 (탭 복귀 직후 in-flight 중인 경우)
    if (getChatGen(projectId)?.inFlight) return;
    setIsLoading(true);
    setChatGen(projectId, { inFlight: true, startedAt: Date.now() });
    const createdAt = new Date().toISOString();
    const currentImages = [...chatImages];
    // NOTE: chat UI / chat_logs DB 에는 사용자가 타이핑한 원본 `text` 그대로 저장.
    //       LLM payload 에만 에셋 활용 체크리스트를 prepend 해서 순응도를 강제한다.
    //       (latestAssets 는 아래 try 블록 안에서 fetch 후 실제 주입됨 → 여기서는 플레이스홀더)
    setChatHistory((prev) => [...prev, { project_id: projectId, role: "user", content: text, created_at: createdAt }]);
    if (currentImages.length > 0)
      sessionImageMap.set(
        createdAt,
        currentImages.map((i) => ({ src: i.preview, kind: i.mediaKind })),
      );
    setChatImages([]);
    try {
      // ✅ assets와 briefAnalysis 동시 re-fetch
      const [latestAssets, latestAnalysis] = await Promise.all([fetchAssets(), fetchBrief()]);
      // 첨부를 비전 API 호환 MIME(jpeg/png/gif/webp)으로 정규화. AVIF/octet-stream
      // 등은 그대로 보내면 "Invalid MIME type" 으로 전송이 실패하므로 webp 로 재인코딩.
      const safeImages = await Promise.all(currentImages.map(toVisionSafeChatImage));
      // 첨부 이미지를 'chat' 버킷에 업로드해 영속 URL 확보 → chat_logs.images 에 저장.
      // 업로드 실패한 것은 제외하고 진행(텍스트 메시지는 항상 저장).
      let imageUrls: string[] = [];
      if (safeImages.length > 0) {
        const uploaded = await Promise.all(
          safeImages.map(async (img) => {
            try {
              const { data } = await supabase.functions.invoke("openai-image", {
                body: {
                  mode: "save_local",
                  imageBase64: img.base64,
                  projectId,
                  sceneNumber: -1,
                  // 미디어 종류를 파일명 suffix 에 인코딩 → 새로고침 후에도 URL 만
                  // 으로 메시지 버블에 GIF/VIDEO 뱃지를 복원(DB 스키마 변경 없이).
                  suffix: img.mediaKind ? `chat-${img.mediaKind}` : "chat",
                  folder: "chat",
                },
              });
              return (data?.publicUrl as string) ?? null;
            } catch {
              return null;
            }
          }),
        );
        imageUrls = uploaded.filter((u): u is string => !!u);
        // 영속 URL 을 현재 메시지에도 반영(새로고침 전에도 일관) + 세션맵 갱신.
        if (imageUrls.length > 0) {
          setChatHistory((prev) =>
            prev.map((m) => (m.created_at === createdAt ? { ...m, images: imageUrls } : m)),
          );
        }
      }
      await supabase
        .from("chat_logs")
        .insert({ project_id: projectId, role: "user", content: text, images: imageUrls });

      // LLM payload 용 텍스트: 등록 에셋이 있으면 체크리스트를 사용자 메시지 앞에 prepend.
      // chat UI / DB 에는 영향 없고 이번 API 호출에만 사용됨.
      const assetReminder = buildAssetUsageReminder(latestAssets ?? [], briefLang);
      // 라이브러리에서 첨부한 자료의 AI 분석 요약(caption) 동봉 — 특히 영상/GIF 는
      // 정지 프레임만으론 전달 못 하는 모션/샷 맥락을 채운다. 첨부당 1개(첫 프레임에
      // 실려 옴)만 모아 중복 제거 후 prepend(LLM 전용, 화면/DB 미저장).
      const refCaptions = Array.from(
        new Set(safeImages.map((i) => i.caption).filter((c): c is string => !!c && c.trim().length > 0)),
      );
      const refContext = refCaptions.length
        ? `${briefLang === "en" ? "[Attached reference analysis]" : "[첨부 레퍼런스 분석]"}\n${refCaptions.join("\n\n")}`
        : "";
      // 확정된 연출 모드 리마인더(순응도 강화, LLM 전용).
      const directionReminder = buildDirectionReminder(directionModeRef.current, briefLang);
      const prefixBlocks = [directionReminder, assetReminder, refContext].filter(Boolean).join("\n\n");
      const textForLLM = prefixBlocks ? `${prefixBlocks}\n${briefLang === "en" ? "[User request]" : "[사용자 요청]"}\n${text}` : text;
      // ⚠️ callLLM 디스패처(llm.ts)의 정규형 LLMImagePart 는
      //    { type:"image", mediaType, dataBase64 } 이다. (Anthropic 의
      //    { source:{ media_type, data } } 가 아님!) 이전엔 source 형태로 넘겨
      //    mediaType/dataBase64 가 undefined 가 돼 "data:undefined;base64,undefined"
      //    가 전송되며 "Invalid MIME type" 으로 실패했다.
      // 각 첨부는 보이는 썸네일 1장 + (영상/GIF) 화면엔 안 보이는 extraFrames 로
      //    확장해 LLM 에 함께 보낸다(모션을 시각적으로도 인지).
      const llmImageParts = safeImages.flatMap((img) => [
        { type: "image" as const, mediaType: img.mediaType, dataBase64: img.base64 },
        ...(img.extraFrames ?? []).map((f) => ({
          type: "image" as const,
          mediaType: f.mediaType,
          dataBase64: f.base64,
        })),
      ]);
      const userApiContent: any =
        llmImageParts.length > 0
          ? [...llmImageParts, { type: "text" as const, text: textForLLM }]
          : textForLLM;

      // ✅ Mirror the cumulative storyline-ID remap that the UI applies, so the LLM
      //    sees the same A/B/C → D/E/F numbering the user is looking at.
      const cumulativeIds = new Set<string>();
      const history = chatHistory.map((c) => {
        if (c.role === "assistant") {
          return { role: c.role, content: remapMessageForHistory(c.content, cumulativeIds) };
        }
        return { role: c.role, content: c.content };
      });
      if (!history.length && (latestAnalysis ?? briefAnalysis)) {
        const seedPrefix = briefLang === "en" ? "[Brief Analysis]" : "[브리프 분석 결과]";
        history.push({
          role: "user" as const,
          content: `${seedPrefix}\n${buildBriefContextString(latestAnalysis ?? briefAnalysis!, briefLang)}`,
        });
      }
      history.push({ role: "user" as const, content: userApiContent });
      await ensureSettingsLoaded();
      const agentModelId = getModel("agent");
      const agentMeta = getModelMeta(agentModelId, getSettingsCached());
      const systemPrompt = buildSystemPrompt(
        videoFormat,
        latestAssets ?? undefined,
        latestAnalysis ?? briefAnalysis,
        briefLang,
        agentMeta?.provider,
        directionModeRef.current,
      );
      // ★ 모델 컨텍스트 윈도우에 맞춰 히스토리 소프트 트림.
      //   Claude Sonnet 4=200k, GPT-5.4=400k, GPT-5.5=1M. 작은 모델일수록
      //   오래된 메시지가 먼저 잘려 나가고, 큰 모델은 사실상 트림 없이 통과.
      const prunedHistory = pruneHistoryForBudget(history, {
        contextWindowTokens: agentMeta?.contextWindow ?? 200_000,
        reserveOutputTokens: agentMeta?.maxOutputTokens ?? 4096,
        systemPromptChars: systemPrompt.length,
      });
      if (mountedRef.current) setStreamingText("");
      const llmResult = await callLLMStream(
        {
          model: agentModelId,
          max_tokens: agentMeta?.maxOutputTokens ?? 4096,
          system: systemPrompt,
          messages: prunedHistory,
          // 가벼운 턴은 추론을 줄여 빠르게, 컷 기획/재구성 턴만 medium.
          reasoningEffort: classifyAgentTurn(text),
        },
        {
          onDelta: (full) => {
            if (mountedRef.current) setStreamingText(full);
          },
        },
      );
      const assistantContent = llmResult.text;
      await supabase.from("chat_logs").insert({ project_id: projectId, role: "assistant", content: assistantContent });
      // 자유 채팅으로 방향을 정한 경우 direction.confirmed 펜스를 읽어 모드 확정.
      applyConfirmedDirection(assistantContent);
      if (mountedRef.current) {
        setChatHistory((prev) => [
          ...prev,
          { project_id: projectId, role: "assistant", content: assistantContent, created_at: new Date().toISOString() },
        ]);
      }
      const extractedSpec = extractSpecFromText(assistantContent);
      if (extractedSpec) setPendingSpec(extractedSpec);
      const extracted = extractScenesFromText(assistantContent);
      // Storyline-selection 응답에서 씬이 하나도 추출되지 않으면 Phase 2 전환 실패일 가능성이 높다.
      // 실제 어시스턴트가 어떤 포맷으로 응답했는지 디버깅할 수 있도록 로그를 남긴다.
      const looksLikeStorylinePick =
        /\b[A-Z]안\b[\s\S]*(선택|진행|결정|가자|갈게|갈래)/.test(text) ||
        /\b(pick|go\s+with|choose|proceed)\b/i.test(text);
      if (looksLikeStorylinePick && extracted.length === 0) {
        console.warn(
          "[AgentTab] 스토리라인 선택 후 ```scene``` 블록이 감지되지 않았습니다. 어시스턴트 응답:",
          assistantContent,
        );
      }
      if (extracted.length > 0) {
        const needsReplaceConfirm = scenes.length > 0;
        const replaceDrafts = shouldReplaceDraftsFromExtraction({
          userText: text,
          assistantText: assistantContent,
          previous: pendingScenes,
          extracted,
        });
        if (mountedRef.current) {
          if (needsReplaceConfirm) {
            setReplaceConfirmBuffer(extracted);
          } else {
            setPendingScenes((prev) => mergeOrReplaceDrafts(prev, extracted, replaceDrafts));
          }
        } else {
          // 언마운트 상태라면 모듈 스토어에 보관, 리마운트 시 반영
          patchChatGen(projectId, {
            pendingExtractedScenes: extracted,
            pendingExtractedNeedsReplaceConfirm: needsReplaceConfirm,
            pendingExtractedReplaceDrafts: replaceDrafts,
          });
        }
      }
    } catch (err: any) {
      if (mountedRef.current) {
        toast({ title: t("agent.failedSendMessage"), description: err.message, variant: "destructive" });
      }
    } finally {
      if (mountedRef.current) {
        setIsLoading(false);
        setStreamingText("");
      }
      // in-flight 플래그 해제 — 단, pendingExtractedScenes 가 남아있으면 리마운트가 소비할 때까지 유지
      const cur = getChatGen(projectId);
      if (cur?.pendingExtractedScenes && cur.pendingExtractedScenes.length) {
        patchChatGen(projectId, { inFlight: false });
      } else {
        setChatGen(projectId, null);
      }
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const reordered = arrayMove(
      scenes,
      scenes.findIndex((s) => s.id === active.id),
      scenes.findIndex((s) => s.id === over.id),
    ).map((s, i) => ({ ...s, scene_number: i + 1 }));
    setScenes(reordered);
    await Promise.all(
      reordered.map((s) => supabase.from("scenes").update({ scene_number: s.scene_number }).eq("id", s.id)),
    );
    pendingOrderNotice.current = `[Shot order changed]\n${reordered.map((s) => `#${String(s.scene_number).padStart(2, "0")} ${s.title || `Shot ${s.scene_number}`}`).join("\n")}\n\nPlease check whether the story flow still feels natural.`;
    toast({ title: t("agent.sceneOrderUpdated") });
  };

  const handleDeleteScene = async (id: string) => {
    const deletedScene = scenes.find((s) => s.id === id);
    await supabase.from("scenes").delete().eq("id", id);
    if (deletedScene) {
      setMoodImages((prev) => {
        const next = prev.map((img) => (img.sceneRef === deletedScene.scene_number ? { ...img, sceneRef: null } : img));
        if (next.some((img, i) => img !== prev[i])) saveMoodImagesToDB(next);
        return next;
      });
    }
    await fetchScenes();
  };
  const [newSceneId, setNewSceneId] = useState<string | null>(null);

  const handleAddScene = async () => {
    const tempNumber = 90000 + (Date.now() % 10000);
    const nextNum = scenes.reduce((max, scene) => Math.max(max, scene.scene_number), 0) + 1;
    const { data, error } = await supabase
      .from("scenes")
      .insert({
        project_id: projectId,
        scene_number: tempNumber,
        title: `Shot ${nextNum}`,
        description: null,
        camera_angle: null,
        location: null,
        mood: null,
        duration_sec: null,
        tagged_assets: [],
        conti_image_url: null,
        source: "agent",
      })
      .select()
      .single();
    if (error || !data) {
      toast({ title: t("agent.failedAddScene"), description: error?.message, variant: "destructive" });
      return;
    }
    const updated = [...scenes, data as Scene];
    const renumbered = updated.map((scene, index) => ({ ...scene, scene_number: index + 1 }));
    setNewSceneId(data.id);
    setScenes(renumbered);
    setTimeout(() => setNewSceneId(null), 400);
    const tempRenumbered = renumbered.map((scene, index) => ({ ...scene, scene_number: 80000 + index }));
    await Promise.all(
      tempRenumbered.map((scene) =>
        supabase.from("scenes").update({ scene_number: scene.scene_number }).eq("id", scene.id),
      ),
    );
    await Promise.all(
      renumbered.map((scene) =>
        supabase.from("scenes").update({ scene_number: scene.scene_number }).eq("id", scene.id),
      ),
    );
  };

  const handleInsertSceneAt = async (insertIdx: number) => {
    const tempNumber = 90000 + (Date.now() % 10000);
    const { data, error } = await supabase
      .from("scenes")
      .insert({
        project_id: projectId,
        scene_number: tempNumber,
        title: `Shot ${insertIdx + 1}`,
        description: null,
        camera_angle: null,
        location: null,
        mood: null,
        duration_sec: null,
        tagged_assets: [],
        conti_image_url: null,
        source: "agent",
      })
      .select()
      .single();
    if (error || !data) {
      toast({ title: t("agent.failedInsertScene"), description: error?.message, variant: "destructive" });
      return;
    }
    const updated = [...scenes];
    updated.splice(insertIdx, 0, data as Scene);
    const renumbered = updated.map((scene, index) => ({ ...scene, scene_number: index + 1 }));
    setNewSceneId(data.id);
    setScenes(renumbered);
    setTimeout(() => setNewSceneId(null), 400);
    const tempRenumbered = renumbered.map((scene, index) => ({ ...scene, scene_number: 80000 + index }));
    await Promise.all(
      tempRenumbered.map((scene) =>
        supabase.from("scenes").update({ scene_number: scene.scene_number }).eq("id", scene.id),
      ),
    );
    await Promise.all(
      renumbered.map((scene) =>
        supabase.from("scenes").update({ scene_number: scene.scene_number }).eq("id", scene.id),
      ),
    );
  };

  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const displayMessages: ChatLog[] =
    initialLoaded && !chatHistory.length && !isLoading
      ? [{ project_id: projectId, role: "assistant", content: t("agent.welcomeNoBrief"), created_at: new Date().toISOString() }]
      : chatHistory.map((m) =>
          m.role === "user" && isBriefAnalysisMsg(m.content) ? { ...m, role: "assistant" as const } : m,
        );

  const CdAvatar = ({ size = "w-8 h-8", iconSize = 18 }: { size?: string; iconSize?: number }) => (
    <div
      className={`${size} flex items-center justify-center text-white font-bold shrink-0`}
      style={{ background: KR, borderRadius: 0 }}
    >
      <svg
        width={iconSize}
        height={iconSize}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    </div>
  );

  const handleMoodToChat = useCallback((url: string) => {
    fetch(url)
      .then((r) => r.blob())
      .then((b) => fileToBase64(new File([b], "mood.jpg", { type: "image/jpeg" })))
      .then((img) => setChatImages((prev) => [...prev, img].slice(0, 4)));
    setRightPanel("scenes");
  }, [setRightPanel]);

  const chatPanel = (
    <div
      className="flex flex-col h-full relative"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{ background: "#000" }}
    >
      {isDragOver && (
        <div
          className="absolute inset-0 z-50 flex flex-col items-center justify-center rounded-none pointer-events-none"
          style={{ background: KR_BG, border: `2px dashed ${KR}` }}
        >
          <ImagePlus className="w-10 h-10 mb-2" style={{ color: KR }} />
          <span className="text-label font-semibold" style={{ color: KR }}>
            {t("agent.dropImagesHere")}
          </span>
        </div>
      )}
      {/* 채팅 상단: 우측 패널 탭 바와 높이 맞춤
          우측 탭 바 = outer padding(10 + 10) + tablist(padding 3×2 + border 1×2 + 탭버튼 32) = 60 */}
      <div
        className="flex items-center justify-between gap-3 shrink-0"
        style={{
          padding: "10px 14px",
          height: 60,
          borderBottom: "1px solid hsl(var(--border))",
        }}
      >
        <div className="flex items-center justify-center min-w-0 flex-1">
          <span
            className="inline-flex items-center gap-2 truncate"
            style={{ fontSize: 14, fontWeight: 700, letterSpacing: "0.02em", color: "rgba(255,255,255,0.85)" }}
          >
            <MessageSquare style={{ width: 15, height: 15, color: KR, flexShrink: 0 }} />
            {t("agent.storyboardGuide")}
          </span>
        </div>
        {!isMobile && (
          <button
            onClick={() => setChatCollapsed(true)}
            title={t("agent.collapseChat")}
            style={{
              width: 24,
              height: 24,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              background: "transparent",
              border: "1px solid hsl(var(--border))",
              color: "rgba(255,255,255,0.55)",
              cursor: "pointer",
              transition: "all 0.15s",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.color = "#fff";
              (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.06)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.55)";
              (e.currentTarget as HTMLElement).style.background = "transparent";
            }}
          >
            <PanelLeftClose style={{ width: 13, height: 13 }} />
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4" ref={setChatContainer}>
        {(() => {
          const cumulativeIds = new Set<string>();
          return displayMessages.map((msg, i) => {
            const parsedSegments = msg.role === "assistant" && !isBriefAnalysisMsg(msg.content)
              ? parseMessageSegments(msg.content, cumulativeIds)
              : undefined;

            if (parsedSegments) {
              for (const seg of parsedSegments) {
                if (seg.type === "storylines" && Array.isArray(seg.options)) {
                  seg.options.forEach((o: any) => cumulativeIds.add(String(o.id).toUpperCase()));
                }
              }
            }

            return (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                {msg.role === "assistant" && <CdAvatar size="w-6 h-6" iconSize={14} />}
                {msg.role === "assistant" && <div className="mr-2" />}
                <div className="max-w-[85%]">
                  {(() => {
                    // 영속된 images(DB, 새로고침 후) 우선, 없으면 세션맵(전송 직후 미리보기).
                    // 각 항목을 { src, kind } 로 정규화 — URL 은 파일명 suffix 에서
                    // kind 를 복원, 세션맵은 이미 kind 를 들고 있다.
                    const entries: Array<{ src: string; kind?: "gif" | "video" }> =
                      msg.role !== "user"
                        ? []
                        : msg.images && msg.images.length
                          ? msg.images.map((url) => ({
                              src: url,
                              kind: (/-chat-(gif|video)-/.exec(url)?.[1] as "gif" | "video" | undefined) ?? undefined,
                            }))
                          : msg.created_at
                            ? sessionImageMap.get(msg.created_at) ?? []
                            : [];
                    return entries.length ? (
                      <div className="flex flex-wrap gap-1.5 mb-1.5 justify-end">
                        {entries.map((e, j) => (
                          <div key={j} className="relative shrink-0">
                            <img src={e.src} className="h-16 w-16 object-cover rounded-none border border-border" loading="lazy" decoding="async" />
                            {e.kind && (
                              <span
                                className="absolute top-0 left-0 text-white font-semibold uppercase leading-none"
                                style={{ fontSize: 8, background: KR, letterSpacing: "0.04em", padding: "2px 3px" }}
                              >
                                {e.kind}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : null;
                  })()}
                  <div
                    className={`px-3.5 py-2.5 text-label leading-relaxed ${msg.role === "user" ? "text-foreground" : "bg-card text-foreground border border-border"}`}
                    style={
                      msg.role === "user"
                        ? { background: "rgba(249,66,58,0.06)", border: "1px solid rgba(249,66,58,0.15)", borderRadius: 0 }
                        : { borderRadius: 0 }
                    }
                  >
                    <MessageContent
                      content={msg.content}
                      assets={projectAssets}
                      onSend={handleSend}
                      segments={parsedSegments}
                      activeDirectionMode={directionMode}
                      onPickDirection={(m) => {
                        void persistDirectionMode(m);
                        void handleSend(directionConfirmMsg(m, briefLang));
                      }}
                    />
                  </div>
                  <div className={`text-caption text-muted-foreground mt-1 ${msg.role === "user" ? "text-right" : ""}`}>
                    {formatTime(msg.created_at)}
                  </div>
                </div>
              </div>
            );
          });
        })()}
        {isLoading && (() => {
          const streamPreview = stripFencesForPreview(streamingText);
          // 펜스가 하나라도 닫혔으면(전략/스펙/컷) 점진 렌더 패널을 보여준다.
          const hasLive =
            liveStreamScenes.length > 0 || liveStreamHasSpec || liveStreamHasStrategy;
          return (
            <div className="flex justify-start">
              <CdAvatar size="w-6 h-6" iconSize={14} />
              <div className="ml-2 max-w-[85%]">
                {streamPreview ? (
                  // 스트리밍 중 평문 미리보기(펜스 제거). 완료 시 chatHistory 로 커밋되며
                  // scene/spec 카드가 정상 파싱·렌더된다.
                  <div
                    className="px-3.5 py-2.5 text-label leading-relaxed bg-card text-foreground border border-border whitespace-pre-wrap"
                    style={{ borderRadius: 0 }}
                  >
                    {streamPreview}
                    <span className="inline-block w-1.5 h-3.5 ml-0.5 align-text-bottom animate-pulse" style={{ background: KR }} />
                  </div>
                ) : hasLive ? null : (
                  <div className="bg-secondary rounded-none border border-border px-4 py-3 flex items-center gap-1">
                    {[0, 1, 2].map((j) => (
                      <span
                        key={j}
                        className="w-1.5 h-1.5 rounded-none animate-bounce"
                        style={{ background: KR, animationDelay: `${j * 150}ms` }}
                      />
                    ))}
                  </div>
                )}
                {hasLive && (
                  <StreamingScenesPreview
                    scenes={liveStreamScenes}
                    hasSpec={liveStreamHasSpec}
                    hasStrategy={liveStreamHasStrategy}
                  />
                )}
                <div className="text-meta text-muted-foreground mt-1">{t("agent.craftingScenario")}</div>
              </div>
            </div>
          );
        })()}
        <div ref={messagesEndRef} />
      </div>
      {chatImages.length > 0 && (
        <div className="px-4 pt-3 pb-1 flex items-center gap-2 shrink-0">
          {chatImages.map((img, i) => (
            <div key={i} className="relative group shrink-0">
              <img
                src={img.preview}
                className="rounded-none object-cover border border-border"
                style={{ width: 52, height: 52 }} loading="lazy" decoding="async" />
              {img.mediaKind && (
                <span
                  className="absolute top-0 left-0 px-1 text-white font-semibold uppercase leading-none"
                  style={{ fontSize: 8, background: KR, letterSpacing: "0.04em", padding: "2px 3px" }}
                >
                  {img.mediaKind}
                </span>
              )}
              <div className="absolute inset-0 rounded-none bg-black/0 group-hover:bg-black/30 transition-colors" />
              <button
                onClick={() => setChatImages((prev) => prev.filter((_, j) => j !== i))}
                className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                style={{ background: "none", border: "none", cursor: "pointer" }}
              >
                <div className="w-5 h-5 rounded-none bg-black/60 flex items-center justify-center">
                  <X className="w-3 h-3 text-white" />
                </div>
              </button>
            </div>
          ))}
          {chatImages.length < 4 && (
            <button
              onClick={() => fileInputRef.current?.click()}
              className="shrink-0 flex flex-col items-center justify-center rounded-none border border-dashed border-border text-muted-foreground/50 hover:border-primary hover:text-primary transition-colors"
              style={{ width: 52, height: 52, background: "transparent" }}
            >
              <Plus className="w-4 h-4" />
              <span style={{ fontSize: 9, marginTop: 2 }}>{chatImages.length}/4</span>
            </button>
          )}
        </div>
      )}
      <div className="shrink-0 border-t border-border px-3 py-2.5">
        <div className="flex items-end gap-2">
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => setDirectionOpen((o) => !o)}
              aria-expanded={directionOpen}
              className="flex items-center gap-2 px-3 transition-colors hover:bg-white/[0.05]"
              style={{
                height: 36,
                borderRadius: 0,
                border: `1.5px solid ${directionMode ? KR : "rgba(249,66,58,0.45)"}`,
                background: directionMode ? "rgba(249,66,58,0.08)" : "rgba(249,66,58,0.04)",
                boxSizing: "border-box",
              }}
            >
              <Clapperboard className="w-4 h-4 shrink-0" style={{ color: KR }} />
              <span className="hidden lg:inline text-muted-foreground" style={{ fontSize: 13 }}>
                {t("agent.directionMode")}
              </span>
              <span
                className="font-semibold whitespace-nowrap"
                style={{ fontSize: 13, color: directionMode ? KR : "rgba(255,255,255,0.85)" }}
              >
                {directionMode ? directionModeLabel(directionMode, briefLang) : t("agent.directionNotSet")}
              </span>
              <ChevronDown
                className="w-4 h-4 ml-0.5 shrink-0 text-muted-foreground transition-transform"
                style={{ transform: directionOpen ? "rotate(180deg)" : "none" }}
              />
            </button>
            {directionOpen && (
              <div
                className="absolute left-0 bottom-full mb-1.5 z-50 flex items-center gap-1.5 p-1.5 border bg-popover"
                style={{ borderRadius: 0, borderColor: "rgba(255,255,255,0.14)" }}
              >
                {(["narrative", "motion", "hybrid"] as DirectionMode[]).map((m) => {
                  const label = directionModeLabel(m, briefLang);
                  const active = directionMode === m;
                  return (
                    <button
                      key={m}
                      onClick={() => {
                        setDirectionOpen(false);
                        if (active) return;
                        void persistDirectionMode(m);
                        toast({
                          title:
                            briefLang === "en"
                              ? `Direction set to ${label}. It applies from your next message.`
                              : `연출 방향을 '${label}'으로 변경했어요. 다음 메시지부터 반영됩니다.`,
                        });
                      }}
                      className="font-medium px-3 h-7 inline-flex items-center transition-opacity hover:opacity-80 whitespace-nowrap"
                      style={{
                        fontSize: 13,
                        borderRadius: 0,
                        border: `1px solid ${active ? KR : "rgba(255,255,255,0.18)"}`,
                        background: active ? "rgba(249,66,58,0.16)" : "transparent",
                        color: active ? KR : "rgba(255,255,255,0.85)",
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <AgentChatInput
              assets={projectAssets}
              projectId={projectId}
              disabled={isLoading}
              hasImages={chatImages.length > 0}
              onSend={handleSend}
              onAttach={() => fileInputRef.current?.click()}
              onAttachLibrary={() => setLibraryImportOpen(true)}
            />
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addImages(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      <LibraryImportDialog
        open={libraryImportOpen}
        onOpenChange={setLibraryImportOpen}
        target="agent"
        projectId={projectId}
      />
    </div>
  );

  const rightPanelContent = (
    <div className="flex flex-col h-full">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "10px 14px",
          borderBottom: "1px solid hsl(var(--border))",
          flexShrink: 0,
          overflowX: "auto",
        }}
      >
        <div
          role="tablist"
          aria-label={t("agent.rightPanel")}
          style={{
            display: splitView ? "none" : "inline-flex",
            gap: 4,
            padding: 3,
            background: "rgba(255,255,255,0.04)",
            border: "1px solid hsl(var(--border))",
            flexShrink: 0,
            transition: "opacity 0.15s",
          }}
        >
          {(["scenes", "mood"] as RightPanel[]).map((p) => {
            const active = !splitView && rightPanel === p;
            const Icon = p === "scenes" ? Layers : SlidersHorizontal;
            const label = p === "scenes" ? t("agent.sceneComposition") : t("agent.moodIdeation");
            const count = p === "scenes" ? scenes.length : moodImages.length;
            return (
              <button
                key={p}
                role="tab"
                aria-selected={active}
                onClick={() => {
                  if (splitView) setSplitView(false);
                  setRightPanel(p);
                }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  height: 32,
                  padding: "0 12px",
                  fontSize: 12.5,
                  fontWeight: 700,
                  letterSpacing: "0.02em",
                  color: active ? "#fff" : "rgba(255,255,255,0.55)",
                  background: active ? "rgba(249,66,58,0.16)" : "transparent",
                  border: active
                    ? "1px solid rgba(249,66,58,0.45)"
                    : "1px solid transparent",
                  cursor: "pointer",
                  transition: "all 0.15s",
                }}
                onMouseEnter={(e) => {
                  if (!active) (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.85)";
                }}
                onMouseLeave={(e) => {
                  if (!active) (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.55)";
                }}
              >
                <Icon
                  style={{
                    width: 13,
                    height: 13,
                    color: active ? KR : "currentColor",
                  }}
                />
                <span>{label}</span>
                <span
                  className="font-mono"
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    padding: "1px 5px",
                    background: active ? "rgba(249,66,58,0.22)" : "rgba(255,255,255,0.08)",
                    color: active ? KR : "rgba(255,255,255,0.5)",
                  }}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {!isMobile && (
          <button
            onClick={() => setSplitView((v) => !v)}
            title={splitView ? t("agent.singleViewTitle") : t("agent.splitViewTitle")}
            aria-pressed={splitView}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              height: 32,
              padding: "0 12px",
              fontSize: 11.5,
              fontWeight: 700,
              letterSpacing: "0.04em",
              color: splitView ? KR : "rgba(255,255,255,0.55)",
              background: splitView ? "rgba(249,66,58,0.10)" : "transparent",
              border: splitView
                ? "1px solid rgba(249,66,58,0.45)"
                : "1px solid hsl(var(--border))",
              cursor: "pointer",
              transition: "all 0.15s",
              flexShrink: 0,
            }}
            onMouseEnter={(e) => {
              if (!splitView) {
                (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.85)";
                (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.04)";
              }
            }}
            onMouseLeave={(e) => {
              if (!splitView) {
                (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.55)";
                (e.currentTarget as HTMLElement).style.background = "transparent";
              }
            }}
          >
            <Columns2 style={{ width: 13, height: 13 }} />
            <span>{splitView ? t("agent.splitOn") : t("agent.split")}</span>
          </button>
        )}
      </div>

      {(() => {
      const scenesBody = (
        <div ref={scenesPanelRef} className="flex flex-col flex-1 min-h-0">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "8px 12px",
              borderBottom: "0.5px solid hsl(var(--border))",
              flexShrink: 0,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {scenes.some((s) => s.duration_sec) && (
                <span
                  className="font-mono"
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: "0.04em",
                    color: "hsl(var(--muted-foreground))",
                  }}
                >
                  {t("agent.totalSeconds", { seconds: scenes.reduce((a, s) => a + (s.duration_sec ?? 0), 0) })}
                </span>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <button
                onClick={() => setShowImages((v) => !v)}
                title={
                  panelTooNarrowForImage
                    ? t("agent.imageColumnCollapsed")
                    : showImages
                      ? t("agent.hideImages")
                      : t("agent.showImages")
                }
                disabled={panelTooNarrowForImage}
                className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {effectiveShowImages ? (
                  <Image style={{ width: 14, height: 14 }} />
                ) : (
                  <ImageOff style={{ width: 14, height: 14 }} />
                )}
              </button>
              <div style={{ width: 1, height: 16, background: "hsl(var(--border))" }} />
              <button
                onClick={async () => {
                  await fetchVersions();
                  setShowLoadModal(true);
                }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  height: 28,
                  padding: "0 10px",
                  borderRadius: 0,
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: "0.04em",
                  border: "0.5px solid hsl(var(--border))",
                  background: "transparent",
                  color: "hsl(var(--muted-foreground))",
                  cursor: "pointer",
                  transition: "background 0.15s",
                }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "hsl(var(--muted))")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
              >
                <RotateCcw style={{ width: 12, height: 12 }} />
                {t("agent.loadVersion")}
              </button>
              <div style={{ width: 1, height: 16, background: "hsl(var(--border))" }} />
              <button
                onClick={handleAddScene}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  height: 28,
                  padding: "0 10px",
                  borderRadius: 0,
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: "0.04em",
                  border: "0.5px solid hsl(var(--border))",
                  background: "transparent",
                  color: "hsl(var(--muted-foreground))",
                  cursor: "pointer",
                  transition: "background 0.15s",
                }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "hsl(var(--muted))")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
              >
                <Plus style={{ width: 12, height: 12 }} />
                {t("agent.addScene")}
              </button>
              <button
                onClick={() => setShowSendModal(true)}
                disabled={!scenes.length}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  height: 28,
                  padding: "0 12px",
                  borderRadius: 0,
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: "0.04em",
                  background: scenes.length ? KR : "hsl(var(--muted))",
                  color: scenes.length ? "#fff" : "hsl(var(--muted-foreground))",
                  border: "none",
                  cursor: scenes.length ? "pointer" : "not-allowed",
                }}
              >
                <Send style={{ width: 12, height: 12 }} />
                {t("agent.sendToConti")}
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3 relative">
            {briefAnalysis && (
              <AgentAbcdPanel
                projectId={projectId}
                scenes={abcdScenes}
                briefAnalysis={briefAnalysis}
                lang={briefLang}
                busy={isLoading}
                onFixContinuity={(c) => handleSend(buildContinuityFixPrompt(c.notes, briefLang))}
              />
            )}
            {pendingScenes.length > 0 && (
              <div className="rounded-none border-2 overflow-visible" style={{ borderColor: KR, background: KR_BG }}>
                <div
                  className="flex items-center justify-between px-4 py-2.5"
                  style={{ borderBottom: `1px solid ${KR_BORDER2}` }}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-meta font-bold" style={{ color: KR }}>
                      {t("agent.draftScenes", { count: pendingScenes.length })}
                    </span>
                    <span className="text-caption text-muted-foreground">{t("agent.clickToEdit")}</span>
                  </div>
                  <button
                    onClick={() => setPendingScenes([])}
                    style={{ background: "none", border: "none", cursor: "pointer" }}
                  >
                    <X className="w-3.5 h-3.5 text-muted-foreground" />
                  </button>
                </div>
                <div className="p-3 space-y-2">
                  {pendingScenes.map((s, i) => {
                    const prevSeq = i > 0 ? pendingScenes[i - 1].sequence : undefined;
                    const showHeader = typeof s.sequence === "number" && s.sequence !== prevSeq;
                    return (
                      <React.Fragment key={s.scene_number}>
                        {showHeader && <SceneGroupHeader label={t("agent.sceneGroup", { n: s.sequence })} />}
                        <EditablePendingSceneCard
                          scene={s}
                          assets={projectAssets}
                          projectId={projectId}
                          onUpdate={handlePendingUpdate}
                        />
                      </React.Fragment>
                    );
                  })}
                </div>
                <div className="px-3 pb-3">
                  <button
                    onClick={handleClickConfirm}
                    className="w-full flex items-center justify-center gap-2 py-2 rounded-none text-body font-semibold text-white transition-opacity hover:opacity-90"
                    style={{ background: KR, border: "none", cursor: "pointer" }}
                  >
                    <Check className="w-4 h-4" />{t("agent.createSceneCardsFromDraft")}
                  </button>
                </div>
              </div>
            )}
            {!scenes.length && !pendingScenes.length ? (
              <EmptyState
                icon={<Clapperboard className="w-10 h-10" />}
                title={t("agent.noScenesYet")}
                description={t("agent.noScenesDesc")}
                action={
                  versions.length > 0 ? (
                    <button
                      onClick={async () => {
                        await fetchVersions();
                        setShowLoadModal(true);
                      }}
                      className="inline-flex items-center gap-1.5 h-8 px-3 rounded-none text-caption font-semibold transition-colors"
                      style={{
                        border: `0.5px solid ${KR}`,
                        background: "transparent",
                        color: KR,
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLElement).style.background = "rgba(249,66,58,0.08)";
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLElement).style.background = "transparent";
                      }}
                    >
                      <RotateCcw style={{ width: 12, height: 12 }} />
                      {t("agent.loadVersion")}
                    </button>
                  ) : undefined
                }
                className="absolute inset-0"
              />
            ) : scenes.length > 0 ? (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={scenes.map((s) => s.id)} strategy={verticalListSortingStrategy}>
                  {pendingScenes.length > 0 && (
                    <div className="flex items-center gap-2 py-1">
                      <div className="flex-1 h-px bg-border/50" />
                      <span className="text-2xs text-muted-foreground/50">{t("agent.confirmedScenes")}</span>
                      <div className="flex-1 h-px bg-border/50" />
                    </div>
                  )}
                  {scenes.map((scene, idx) => (
                    <React.Fragment key={scene.id}>
                      {typeof scene.sequence === "number" && scene.sequence !== scenes[idx - 1]?.sequence && (
                        <SceneGroupHeader label={t("agent.sceneGroup", { n: scene.sequence })} />
                      )}
                      {idx > 0 && (
                        <div
                          style={{
                            position: "relative",
                            height: 8,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                          className="group/insert"
                        >
                          <div
                            className="opacity-0 group-hover/insert:opacity-100 transition-opacity"
                            style={{
                              position: "absolute",
                              left: 0,
                              right: 0,
                              top: "50%",
                              height: 1,
                              background: `linear-gradient(to right, transparent, ${KR} 15%, ${KR} 85%, transparent)`,
                              transform: "translateY(-50%)",
                              pointerEvents: "none",
                            }}
                          />
                          <button
                            onClick={() => handleInsertSceneAt(idx)}
                            className="opacity-0 group-hover/insert:opacity-100 transition-opacity"
                            style={{
                              position: "absolute",
                              top: "50%",
                              left: "50%",
                              transform: "translate(-50%, -50%)",
                              zIndex: 10,
                              width: 24,
                              height: 24,
                              minWidth: 24,
                              minHeight: 24,
                              borderRadius: "9999px",
                              aspectRatio: "1 / 1",
                              background: KR,
                              color: "#fff",
                              border: "none",
                              cursor: "pointer",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              padding: 0,
                              boxSizing: "border-box",
                            }}
                          >
                            <Plus style={{ width: 12, height: 12 }} />
                          </button>
                        </div>
                      )}
                      <div
                        style={{
                          transition: "transform 0.3s ease, opacity 0.3s ease",
                          ...(scene.id === newSceneId ? { animation: "fadeIn 0.35s ease forwards" } : {}),
                        }}
                      >
                        <SortableSceneCard
                          scene={scene}
                          onDelete={setDeleteConfirmId}
                          onUpdate={handleSceneUpdate}
                          onClearImage={handleClearSceneImage}
                          assets={projectAssets}
                          onLightboxMood={setMoodLightboxUrl}
                          videoFormat={videoFormat}
                          sharedHeight={sharedHeight}
                          onContentHeight={handleContentHeight}
                          showImages={effectiveShowImages}
                          onDropMoodImage={handleSceneDrop}
                          maxImgWidth={maxImgWidth}
                        />
                      </div>
                    </React.Fragment>
                  ))}
                </SortableContext>
              </DndContext>
            ) : null}
            <AlertDialog open={!!deleteConfirmId} onOpenChange={(open) => !open && setDeleteConfirmId(null)}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("agent.deleteScene")}</AlertDialogTitle>
                  <AlertDialogDescription>
                    Are you sure you want to delete this scene? This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => {
                      if (deleteConfirmId) {
                        handleDeleteScene(deleteConfirmId);
                        setDeleteConfirmId(null);
                      }
                    }}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      );
      const moodBody = (
        <MoodIdeationPanel
          projectId={projectId}
          briefAnalysis={briefAnalysis}
          scenes={scenes}
          assets={projectAssets}
          videoFormat={videoFormat}
          moodImages={moodImages}
          setMoodImages={setMoodImages}
          saveMoodImagesToDB={saveMoodImagesToDB}
          onSendToChat={handleMoodToChat}
          onAttachToScene={handleAttachMoodToScene}
          onDetachFromScene={handleDetachFromScene}
          onDeleteMoodImages={handleDeleteMoodImages}
        />
      );
      if (splitView && !isMobile) {
        const renderSplitHeader = (kind: RightPanel) => {
          const Icon = kind === "scenes" ? Layers : SlidersHorizontal;
          const label = kind === "scenes" ? t("agent.sceneComposition") : t("agent.moodIdeation");
          const count = kind === "scenes" ? scenes.length : moodImages.length;
          return (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                height: 40,
                padding: "0 14px",
                borderBottom: "0.5px solid hsl(var(--border))",
                background: "rgba(255,255,255,0.02)",
                flexShrink: 0,
              }}
            >
              <Icon style={{ width: 13, height: 13, color: KR }} />
              <span
                style={{
                  fontSize: 12.5,
                  fontWeight: 700,
                  letterSpacing: "0.02em",
                  color: "#fff",
                }}
              >
                {label}
              </span>
              <span
                className="font-mono"
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: "1px 5px",
                  background: "rgba(249,66,58,0.22)",
                  color: KR,
                }}
              >
                {count}
              </span>
            </div>
          );
        };
        return (
          <ResizablePanelGroup direction="horizontal" className="flex-1" style={{ background: "hsl(var(--border)/0.5)" }}>
            <ResizablePanel defaultSize={48} minSize={25}>
              <div
                className="h-full flex flex-col overflow-hidden"
                style={{ background: "hsl(var(--muted)/0.15)" }}
              >
                {renderSplitHeader("scenes")}
                {scenesBody}
              </div>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={52} minSize={25}>
              <div
                className="h-full flex flex-col overflow-hidden"
                style={{ background: "hsl(var(--muted)/0.15)" }}
              >
                {renderSplitHeader("mood")}
                {moodBody}
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        );
      }
      return rightPanel === "scenes" ? scenesBody : moodBody;
      })()}
    </div>
  );

  const modals = (
    <>
      {showSendModal && (
        <SendToContiModal
          scenes={scenes}
          productionSpec={pendingSpec}
          projectId={projectId}
          onClose={() => setShowSendModal(false)}
          onSent={async (_, name) => {
            toast({ title: t("agent.sentToContiSuccess", { name }) });
            await clearScenesAfterSend();
            window.dispatchEvent(
              new CustomEvent("preflow:conti-version-created", {
                detail: { projectId, versionId: _, versionName: name },
              }),
            );
            onSwitchToContiTab?.();
          }}
        />
      )}
      {showConfirmModal && (
        <ConfirmScenesModal
          pendingCount={pendingScenes.length}
          existingCount={scenes.length}
          onClose={() => setShowConfirmModal(false)}
          onConfirm={handleConfirmScenes}
        />
      )}
      {showLoadModal && (
        <LoadVersionModal versions={versions} onClose={() => setShowLoadModal(false)} onLoad={handleLoadVersion} />
      )}
      {replaceConfirmBuffer && (
        <Dialog open onOpenChange={(o) => !o && setReplaceConfirmBuffer(null)}>
          <DialogContent size="sm">
            <DialogHeader>
              <DialogTitle>{t("agent.replaceDraftTitle")}</DialogTitle>
            </DialogHeader>
            <p
              className="text-body text-muted-foreground leading-relaxed"
              dangerouslySetInnerHTML={{
                __html: t("agent.replaceDraftBody", {
                  pending: `<strong class="text-foreground">${replaceConfirmBuffer.length}</strong>`,
                  pendingS: replaceConfirmBuffer.length > 1 ? "s" : "",
                  existing: `<strong class="text-foreground">${scenes.length}</strong>`,
                  existingS: scenes.length > 1 ? "s" : "",
                }),
              }}
            />
            <div className="flex items-start gap-2 text-caption text-muted-foreground/60 bg-muted rounded-none px-3 py-2 mt-1">
              <Lightbulb className="w-3.5 h-3.5 shrink-0 mt-px" strokeWidth={1.75} />
              <span>{t("agent.finalCommitHint")}</span>
            </div>
            <DialogFooter className="gap-2 mt-1">
              <Button variant="ghost" onClick={() => setReplaceConfirmBuffer(null)}>
                {t("common.cancel")}
              </Button>
              <Button onClick={handleReplaceConfirm} className="gap-1.5 text-white" style={{ background: KR }}>
                <Check className="w-3.5 h-3.5" />
                {t("agent.replace")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {moodLightboxUrl && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80"
          onClick={() => setMoodLightboxUrl(null)}
        >
          <button
            onClick={() => setMoodLightboxUrl(null)}
            className="absolute top-4 right-4"
            style={{
              width: 36,
              height: 36,
              borderRadius: "50%",
              background: "rgba(255,255,255,0.15)",
              border: "none",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <X className="w-5 h-5 text-white" />
          </button>
          <img
            src={moodLightboxUrl}
            alt="mood"
            style={{ maxWidth: "90vw", maxHeight: "90vh", objectFit: "contain", borderRadius: 0 }}
            onClick={(e) => e.stopPropagation()} loading="lazy" decoding="async" />
        </div>
      )}
    </>
  );

  const chatRail = (
    <div
      style={{
        width: 44,
        flexShrink: 0,
        // 확장 상태의 채팅 패널(#000)과 동일 톤 — "chat = 검정" 일관성 유지
        background: "#000",
        borderRight: "1px solid hsl(var(--border))",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* 상단: 우측 패널 탭 바(60px) 와 높이 정렬 */}
      <button
        onClick={() => setChatCollapsed(false)}
        title={t("agent.expandChat")}
        style={{
          width: "100%",
          height: 60,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "transparent",
          border: "none",
          borderBottom: "1px solid hsl(var(--border))",
          color: "rgba(255,255,255,0.7)",
          cursor: "pointer",
          transition: "all 0.15s",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.color = KR;
          (e.currentTarget as HTMLElement).style.background = "rgba(249,66,58,0.08)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.7)";
          (e.currentTarget as HTMLElement).style.background = "transparent";
        }}
      >
        <PanelLeftOpen style={{ width: 16, height: 16 }} />
      </button>
      {/* 중단: 채팅 히스토리 인디케이터 — 클릭 시 채팅 펼치기 */}
      <button
        onClick={() => setChatCollapsed(false)}
        title={t("agent.expandChat")}
        style={{
          flex: 1,
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "flex-start",
          gap: 8,
          background: "transparent",
          border: "none",
          color: "rgba(255,255,255,0.45)",
          cursor: "pointer",
          padding: "18px 0",
          transition: "color 0.15s",
        }}
        onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.95)")}
        onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.45)")}
      >
        <MessageSquare style={{ width: 14, height: 14 }} />
        {chatHistory.length > 0 && (
          <span
            className="font-mono"
            style={{
              fontSize: 9,
              fontWeight: 700,
              padding: "2px 5px",
              background: "rgba(249,66,58,0.14)",
              color: KR,
              border: "1px solid rgba(249,66,58,0.3)",
              lineHeight: 1,
            }}
          >
            {chatHistory.length}
          </span>
        )}
      </button>
    </div>
  );

  if (isMobile) {
    return (
      <div className="flex flex-col h-full">
        <div style={{ height: "60vh" }}>{chatPanel}</div>
        <div className="border-t border-border" style={{ height: "40vh" }}>
          {rightPanelContent}
        </div>
        {modals}
      </div>
    );
  }

  return (
    <div className="h-full">
      {chatCollapsed ? (
        <div className="flex h-full">
          {chatRail}
          <div className="flex-1 min-w-0">{rightPanelContent}</div>
        </div>
      ) : (
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel defaultSize={50} minSize={28}>
            {chatPanel}
          </ResizablePanel>
          <ResizableHandle
            className="!bg-transparent w-1 transition-colors"
            style={{
              background:
                "linear-gradient(to bottom, transparent, hsl(var(--border)) 20%, hsl(var(--border)) 80%, transparent)",
            }}
          />
          <ResizablePanel defaultSize={50} minSize={35}>
            {rightPanelContent}
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
      {modals}
    </div>
  );
};
