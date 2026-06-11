import React, { useEffect, useState, useRef, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import {
  generateMoodImages,
  type MoodImageModel,
} from "@/lib/moodIdeation";
import { getImageModelDefault, getGptQualityDefault } from "@/lib/imageGenPreference";
import { normalizeStorageUrl } from "@/lib/storageUtils";
import { supabase } from "@/lib/supabase";
import { Trash2, Loader2, X, Check, Send, Sparkles, ChevronLeft, ChevronRight, Image as ImageIcon, Heart, Cpu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useT } from "@/lib/uiLanguage";
import {
  KR,
  KR_BG,
  KR_BORDER,
  KR_BORDER2,
  FORMAT_DEFAULT_COLS,
  getMoodGenBatches,
  isAnyMoodGenInFlight,
  addMoodGenBatch,
  patchMoodGenBatch,
  removeMoodGenBatch,
  subscribeMoodGen,
  toMoodImages,
  genMoodId,
  type Asset,
  type Scene,
  type Analysis,
  type MoodImage,
  type MoodGenState,
} from "./agentTypes";

type MoodModelOption = "gpt-image-1.5-ref" | "gpt-image-1.5-text" | "gpt-image-2" | "nano-banana-2";
const MOOD_MODEL_OPTION_DEFAULT: MoodModelOption = "gpt-image-1.5-ref";
const MOOD_PENDING_KEY_PREFIX = "preflow_mood_pending:";

type PendingMoodBatch = {
  batchId: string;
  projectId: string;
  count: number;
  skeletonIds: string[];
  startedAt: number;
  opts: {
    briefAnalysis: Analysis | null;
    scenes: Array<Pick<Scene, "scene_number" | "title" | "description" | "camera_angle" | "location" | "mood" | "tagged_assets">>;
    assets: Array<Pick<Asset, "tag_name" | "photo_url" | "ai_description" | "asset_type" | "role_description" | "outfit_description" | "space_description">>;
    videoFormat: string;
    targetSceneNumber: number | null;
    model: MoodImageModel;
    forceAssetRefs: boolean;
  };
};

const pendingMoodKey = (projectId: string) => `${MOOD_PENDING_KEY_PREFIX}${projectId}`;

function readPendingMoodBatches(projectId: string): PendingMoodBatch[] {
  try {
    const raw = window.localStorage.getItem(pendingMoodKey(projectId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writePendingMoodBatches(projectId: string, batches: PendingMoodBatch[]) {
  try {
    if (batches.length === 0) window.localStorage.removeItem(pendingMoodKey(projectId));
    else window.localStorage.setItem(pendingMoodKey(projectId), JSON.stringify(batches));
  } catch {}
}

function upsertPendingMoodBatch(batch: PendingMoodBatch) {
  const batches = readPendingMoodBatches(batch.projectId).filter((b) => b.batchId !== batch.batchId);
  writePendingMoodBatches(batch.projectId, [...batches, batch]);
}

function removePendingMoodBatch(projectId: string, batchId: string) {
  writePendingMoodBatches(projectId, readPendingMoodBatches(projectId).filter((b) => b.batchId !== batchId));
}

function moodTimestampFromName(name: string): number {
  const match = name.match(/-(\d{10,})\.[a-z0-9]+$/i);
  return match ? Number(match[1]) : 0;
}

async function listGeneratedMoodUrls(projectId: string, startedAt: number): Promise<string[]> {
  const { data } = await supabase.storage.from("mood").list(projectId, { limit: 1000 });
  const files = Array.isArray(data) ? data : [];
  return files
    .map((file: { name?: string }) => file.name)
    .filter((name): name is string => !!name && moodTimestampFromName(name) >= startedAt - 5000)
    .sort((a, b) => moodTimestampFromName(a) - moodTimestampFromName(b))
    .map((name) => supabase.storage.from("mood").getPublicUrl(`${projectId}/${name}`).data.publicUrl);
}

/* ━━━━━ Mood generation result persistence ━━━━━
 * AgentTab(부모) 이 언마운트된 상태에서 generation 이 끝날 수 있으므로
 * React state 를 거치지 않고 DB 에 직접 저장하는 경로가 필요하다.
 * 모듈 store 의 arrivedUrls + skeletonIds 를 기준으로
 * 현재 DB 의 mood_image_urls 와 머지해 persist 한다.
 */
async function persistMoodGenResultToDB(projectId: string, gen: MoodGenState | undefined | null) {
  if (!gen || gen.skeletonIds.length === 0) return;
  try {
    const { data: brief } = await supabase
      .from("briefs")
      .select("id,mood_image_urls")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    if (!brief) return;
    const skelIdSet = new Set(gen.skeletonIds);
    const dbImages = toMoodImages(((brief as any).mood_image_urls as (string | MoodImage)[]) ?? []);
    const dbWithoutSkel = dbImages.filter((img) => !skelIdSet.has(img.id));
    const arrivedImages: MoodImage[] = gen.skeletonIds
      .map((id, i) => ({
        id,
        url: gen.arrivedUrls[i] ?? null,
        liked: false,
        sceneRef: null,
        comment: "",
        createdAt: new Date().toISOString(),
      }))
      .filter((img) => img.url !== null) as MoodImage[];
    const merged = [...arrivedImages, ...dbWithoutSkel];
    await supabase
      .from("briefs")
      .update({ mood_image_urls: merged } as any)
      .eq("id", (brief as any).id);
  } catch (e) {
    console.error("[MoodGen] persistMoodGenResultToDB failed:", e);
  }
}

/* ━━━━━ MoodCard ━━━━━ */
const MoodCard = ({
  img,
  selected,
  hasSelection,
  skelIdx,
  totalSkel,
  videoFormat,
  onToggleSelect,
  onToggleLike,
  onDelete,
  onSendToChat,
  onLightbox,
  onAttach,
  onBroken,
}: {
  img: MoodImage;
  selected: boolean;
  hasSelection: boolean;
  skelIdx?: number;
  totalSkel?: number;
  videoFormat?: string;
  onToggleSelect: () => void;
  onToggleLike: () => void;
  onDelete: () => void;
  onSendToChat: () => void;
  onLightbox: () => void;
  onAttach: (e: React.MouseEvent) => void;
  /** Fired when the <img> fails to load (404/network). The parent uses this
   *  to self-heal legacy rows that pointed at disk files that never existed
   *  (e.g. the old GPT suffix embedded `:` in filenames, which Windows NTFS
   *  refused to write, so the URL went to DB but no file was ever saved). */
  onBroken?: () => void;
}) => {
  const t = useT();
  const [hovered, setHovered] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const showOverlay = hovered || selected;
  const imageUrl = img.url ? normalizeStorageUrl(img.url) ?? img.url : null;

  useEffect(() => {
    setImageLoaded(false);
  }, [img.url]);

  useEffect(() => {
    if (!imageUrl || imageLoaded) return;
    let parsed: URL;
    try {
      parsed = new URL(imageUrl, window.location.href);
    } catch {
      return;
    }
    const isLocalStorageImage =
      parsed.protocol === "local-file:" ||
      ((parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") &&
        parsed.pathname.startsWith("/storage/file/"));
    if (!isLocalStorageImage) return;

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 5000);
    fetch(imageUrl, { method: "GET", cache: "no-store", signal: controller.signal })
      .then((res) => {
        if (!res.ok) onBroken?.();
      })
      .catch(() => {
        // Network aborts can happen during dev-server restarts; keep the card
        // unless the local server explicitly says the file is gone.
      })
      .finally(() => window.clearTimeout(timeoutId));
    return () => {
      controller.abort();
      window.clearTimeout(timeoutId);
    };
  }, [imageLoaded, imageUrl, onBroken]);

  // ── url === null : 스켈레톤을 MoodCard 안에서 직접 렌더링
  // 이렇게 하면 key={img.id}인 같은 컴포넌트가 유지되면서
  // props(url)만 null→string으로 바뀌므로 React가 DOM을 교체하지 않음
  if (img.url === null) {
    const aspect = videoFormat === "horizontal" ? "16/9" : videoFormat === "square" ? "1/1" : "9/16";
    return (
      <div
        style={{
          aspectRatio: aspect,
          background: "hsl(var(--muted))",
          position: "relative",
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "linear-gradient(90deg, transparent 0%, hsl(var(--primary) / 0.06) 50%, transparent 100%)",
            animation: `shimmerSweep 2s ease-in-out ${(skelIdx ?? 0) * 0.15}s infinite`,
          }}
        />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, zIndex: 1 }}>
          <Loader2
            className="animate-spin"
            style={{ width: 14, height: 14, color: "hsl(var(--muted-foreground))", opacity: 0.6 }}
          />
          {totalSkel !== undefined && skelIdx !== undefined && (
            <span style={{ fontSize: 9, fontWeight: 500, color: "hsl(var(--muted-foreground))", opacity: 0.5 }}>
              {skelIdx + 1}/{totalSkel}
            </span>
          )}
        </div>
      </div>
    );
  }

  // ── url 있음 : 실제 이미지 + 오버레이
  // wrapper에 aspectRatio를 걸어서 이미지 로드 전에도 높이 유지
  // img를 position: absolute로 배치해서 레이아웃이 절대 무너지지 않음
  const imgAspect = videoFormat === "horizontal" ? "16/9" : videoFormat === "square" ? "1/1" : "9/16";
  return (
    <div
      draggable={!!imageUrl}
      onDragStart={(e) => {
        if (!imageUrl) return;
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData(
          "application/x-mood-image",
          JSON.stringify({ moodImageId: img.id, url: imageUrl }),
        );
        e.dataTransfer.setData("text/plain", imageUrl);
      }}
      style={{
        position: "relative",
        overflow: "hidden",
        cursor: "pointer",
        aspectRatio: imgAspect,
        background: "hsl(var(--muted))",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(e) => {
        e.stopPropagation();
        if (hasSelection) {
          onToggleSelect();
          return;
        }
        onLightbox();
      }}
    >
      <img
        src={imageUrl ?? undefined}
        alt="mood"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          display: "block",
          opacity: imageLoaded ? 1 : 0,
          transition: "opacity 0.45s ease",
        }}
        loading="lazy"
        onLoad={(e) => {
          setImageLoaded(true);
        }}
        onError={() => onBroken?.()}
        decoding="async" />
      {!imageLoaded && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 4,
            background: "hsl(var(--muted))",
            pointerEvents: "none",
          }}
        >
          <Loader2
            className="animate-spin"
            style={{ width: 14, height: 14, color: "hsl(var(--muted-foreground))", opacity: 0.6 }}
          />
          <span style={{ fontSize: 9, fontWeight: 500, color: "hsl(var(--muted-foreground))", opacity: 0.5 }}>
            loading
          </span>
        </div>
      )}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: showOverlay ? "rgba(0,0,0,0.35)" : "rgba(0,0,0,0)",
          transition: "background 0.12s",
          pointerEvents: "none",
        }}
      />
      {showOverlay && (
        <div
          style={{ position: "absolute", top: 7, left: 7 }}
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect();
          }}
        >
          <div
            style={{
              width: 24,
              height: 24,
              cursor: "pointer",
              border: selected ? "none" : "1.5px solid hsl(var(--foreground) / 0.75)",
              background: selected ? KR : "rgba(0,0,0,0.3)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "all 0.1s",
            }}
          >
            {selected && (
              <svg
                width={12}
                height={12}
                viewBox="0 0 24 24"
                fill="none"
                stroke="#fff"
                strokeWidth={3}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </div>
        </div>
      )}
      {(showOverlay || img.liked) && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleLike();
          }}
          style={{
            position: "absolute",
            top: 7,
            right: 7,
            width: 31,
            height: 31,
            background: img.liked ? KR : "rgba(0,0,0,0.45)",
            border: "none",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "all 0.1s",
          }}
        >
          <svg
            width={13}
            height={13}
            viewBox="0 0 24 24"
            fill={img.liked ? "#fff" : "none"}
            stroke={img.liked ? "#fff" : "hsl(var(--foreground) / 0.85)"}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" />
          </svg>
        </button>
      )}
      {showOverlay && (
        <>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAttach(e);
            }}
            title={
              img.sceneRef != null
                ? t("mood.linkedToScene", { scene: String(img.sceneRef).padStart(2, "0") })
                : t("mood.attachToScene")
            }
            style={{
              position: "absolute",
              bottom: 7,
              left: 7,
              width: 29,
              height: 29,
              background: img.sceneRef != null ? KR : "rgba(0,0,0,0.5)",
              border: "none",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg
              width={12}
              height={12}
              viewBox="0 0 24 24"
              fill="none"
              stroke="hsl(var(--foreground) / 0.9)"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
            </svg>
            {img.sceneRef != null && (
              <span
                style={{
                  position: "absolute",
                  top: -4,
                  right: -4,
                  fontSize: 8,
                  fontWeight: 700,
                  padding: "1px 3px",
                  background: "#fff",
                  color: KR,
                  lineHeight: 1,
                }}
              >
                #{String(img.sceneRef).padStart(2, "0")}
              </span>
            )}
          </button>
          <div style={{ position: "absolute", bottom: 7, right: 7, display: "flex", gap: 4 }}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onSendToChat();
              }}
              style={{
                width: 29,
                height: 29,
                background: "rgba(0,0,0,0.45)",
                border: "none",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              title={t("mood.sendToChat")}
            >
              <Send style={{ width: 12, height: 12, color: "hsl(var(--foreground) / .85)" }} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              style={{
                width: 29,
                height: 29,
                background: "rgba(180,0,0,0.55)",
                border: "none",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              title={t("mood.deleteImage")}
            >
              <Trash2 style={{ width: 12, height: 12, color: "hsl(var(--foreground) / .9)" }} />
            </button>
          </div>
        </>
      )}
      {!showOverlay && img.sceneRef !== null && (
        <div style={{ position: "absolute", bottom: 6, left: 6 }}>
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              padding: "2px 6px",
              background: KR,
              color: "#fff",
            }}
          >
                #{String(img.sceneRef).padStart(2, "0")}
          </span>
        </div>
      )}
    </div>
  );
};

/* ━━━━━ MoodIdeationPanel ━━━━━ */
export const MoodIdeationPanel = ({
  projectId,
  briefAnalysis,
  scenes,
  assets,
  videoFormat,
  moodImages,
  setMoodImages,
  saveMoodImagesToDB,
  onSendToChat,
  onAttachToScene,
  onDetachFromScene,
  onDeleteMoodImages,
}: {
  projectId: string;
  briefAnalysis: Analysis | null;
  scenes: Scene[];
  assets: Asset[];
  videoFormat: string;
  moodImages: MoodImage[];
  setMoodImages: React.Dispatch<React.SetStateAction<MoodImage[]>>;
  saveMoodImagesToDB: (images: MoodImage[]) => Promise<void>;
  onSendToChat: (url: string) => void;
  onAttachToScene: (imageUrl: string, sceneId: string, moodImageId: string, sceneNumber: number) => Promise<void>;
  onDetachFromScene: (moodImageId: string, sceneNumber: number) => Promise<void>;
  onDeleteMoodImages: (ids: string[]) => Promise<void>;
}) => {
  const t = useT();
  useEffect(() => {
    const id = "mood-shimmer-style";
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = `@keyframes shimmerSweep {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(200%); }
    }
    @keyframes moodFadeIn {
      0% { opacity: 0; transform: scale(0.9); }
      100% { opacity: 1; transform: scale(1); }
    }`;
    document.head.appendChild(style);
    return () => {
      document.getElementById(id)?.remove();
    };
  }, []);
  const { toast } = useToast();
  // 진행중 배치 카운트. 1개 이상이면 스피너/카운터 표시, 그러나 generate 버튼 자체는
  // 배치 동시 진행을 허용하므로 disable 시키지 않는다 (이전 동작과 다름).
  const [inFlightCount, setInFlightCount] = useState<number>(
    () => getMoodGenBatches(projectId).filter((b) => b.promise !== null).length,
  );
  const isGenerating = inFlightCount > 0;
  const [showLikedOnly, setShowLikedOnly] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [targetSceneNum, setTargetSceneNum] = useState<number | null>(null);
  const [ctxOpen, setCtxOpen] = useState(false);
  const ctxRef = useRef<HTMLDivElement>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [attachMenu, setAttachMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ ids: string[]; connectedScenes: number[] } | null>(null);
  const [generateCount, setGenerateCount] = useState(3);
  const defaultCols = FORMAT_DEFAULT_COLS[videoFormat] ?? 3;
  // 탭 이동/언마운트 후 복귀 시에도 마지막 설정값이 유지되도록 프로젝트별 localStorage 에 저장.
  const thumbColsKey = `ff_mood_thumb_cols_${projectId}`;
  const [thumbCols, setThumbColsState] = useState<number>(() => {
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem(thumbColsKey) : null;
      const parsed = raw ? parseInt(raw, 10) : NaN;
      if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 12) return parsed;
    } catch {}
    return defaultCols;
  });
  const setThumbCols = useCallback(
    (val: number) => {
      setThumbColsState(val);
      try {
        window.localStorage.setItem(thumbColsKey, String(val));
      } catch {}
    },
    [thumbColsKey],
  );
  // Mood 이미지 생성 모델. GPT Image 1.5 + 이미지 참조가 기본값.
  // 사용자의 마지막 선택은 프로젝트 단위로 localStorage 에 저장되어
  // 탭 이동/재진입/새로고침 후에도 유지된다.
  const moodModelKey = `ff_mood_model_${projectId}`;
  const [moodModel, setMoodModelState] = useState<MoodModelOption>(() => {
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem(moodModelKey) : null;
      if (raw === "gpt-image-1.5-ref" || raw === "gpt-image-1.5-text") {
        return raw;
      }
      if (raw === "gpt-image-1.5") return "gpt-image-1.5-ref";
      if (raw === "gpt-image-2" || raw === "nano-banana-2") return "gpt-image-1.5-ref";
      // 과거 "creative" / "asset" 문자열을 신규 모델명으로 마이그레이트.
      if (raw === "asset") return "gpt-image-1.5-ref";
      if (raw === "creative") return "gpt-image-1.5-text";
    } catch {}
    // 프로젝트 저장값이 없으면 Settings 의 mood 기본 모델에서 출발.
    return getImageModelDefault("mood") as MoodModelOption;
  });
  const setMoodModel = useCallback(
    (val: MoodModelOption) => {
      setMoodModelState(val);
      try {
        window.localStorage.setItem(moodModelKey, val);
      } catch {}
    },
    [moodModelKey],
  );
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);

  const MOOD_MODEL_LABELS: Record<MoodModelOption, string> = {
    "gpt-image-1.5-ref": t("mood.gpt15WithRefs"),
    "gpt-image-1.5-text": t("mood.gpt15TextOnly"),
    "gpt-image-2": "GPT Image 2",
    "nano-banana-2": "Nano Banana 2",
  };
  const MOOD_MODEL_DESCRIPTIONS: Record<MoodModelOption, string> = {
    "gpt-image-1.5-ref": t("mood.gpt15WithRefsDesc"),
    "gpt-image-1.5-text": t("mood.gpt15TextOnlyDesc"),
    "gpt-image-2": t("mood.disabledModelDesc"),
    "nano-banana-2": t("mood.disabledModelDesc"),
  };
  const genMoodId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  useEffect(() => {
    if (!ctxOpen) return;
    const fn = (e: MouseEvent) => {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) setCtxOpen(false);
    };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [ctxOpen]);
  useEffect(() => {
    if (!modelMenuOpen) return;
    const fn = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) setModelMenuOpen(false);
    };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [modelMenuOpen]);
  useEffect(() => {
    if (!attachMenu) return;
    const fn = (e: MouseEvent) => {
      if (attachMenuRef.current && !attachMenuRef.current.contains(e.target as Node)) setAttachMenu(null);
    };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [attachMenu]);

  // 진행중 배치 수를 모듈 store 변화에 맞춰 항상 동기화.
  // 컴포넌트 마운트 시점에도 (탭 이동 후 복귀) 정확한 카운터로 시작하도록
  // subscribe 콜백을 즉시 한 번 호출한다.
  useEffect(() => {
    const sync = () =>
      setInFlightCount(getMoodGenBatches(projectId).filter((b) => b.promise !== null).length);
    sync();
    return subscribeMoodGen(projectId, sync);
  }, [projectId]);

  const contextLabel = (() => {
    if (targetSceneNum !== null) {
      const s = scenes.find((sc) => sc.scene_number === targetSceneNum);
      return `#${String(targetSceneNum).padStart(2, "0")}${s?.title ? ` · ${s.title}` : ""}`;
    }
    return scenes.length > 0 ? t("mood.contextAllScenes", { count: scenes.length }) : t("mood.contextBriefBased");
  })();

  const mergeRecoveredBatch = useCallback(
    async (pending: PendingMoodBatch): Promise<number> => {
      const recoveredUrls = (await listGeneratedMoodUrls(projectId, pending.startedAt)).slice(0, pending.count);
      const skeletonSet = new Set(pending.skeletonIds);
      const recoveredImages: MoodImage[] = recoveredUrls.map((url, index) => ({
        id: pending.skeletonIds[index] ?? genMoodId(),
        url: normalizeStorageUrl(url) ?? url,
        liked: false,
        sceneRef: null,
        comment: "",
        createdAt: new Date(pending.startedAt).toISOString(),
      }));

      setMoodImages((prev) => {
        const seenUrls = new Set(recoveredImages.map((img) => img.url).filter(Boolean));
        const rest = prev.filter((img) => !skeletonSet.has(img.id) && (!img.url || !seenUrls.has(img.url)));
        const next = [...recoveredImages, ...rest];
        void saveMoodImagesToDB(next);
        return next;
      });
      return recoveredImages.length;
    },
    [projectId, saveMoodImagesToDB, setMoodImages],
  );

  useEffect(() => {
    const pendingBatches = readPendingMoodBatches(projectId).filter((batch) => Date.now() - batch.startedAt < 60 * 60 * 1000);
    if (pendingBatches.length === 0) {
      writePendingMoodBatches(projectId, []);
      return;
    }

    let cancelled = false;
    writePendingMoodBatches(projectId, pendingBatches);

    for (const pending of pendingBatches) {
      if (getMoodGenBatches(projectId).some((batch) => batch.batchId === pending.batchId)) continue;
      addMoodGenBatch(projectId, {
        batchId: pending.batchId,
        count: pending.count,
        skeletonIds: pending.skeletonIds,
        arrivedUrls: [],
        promise: null,
      });

      const restorePromise = (async () => {
        try {
          let recoveredCount = await mergeRecoveredBatch(pending);
          if (cancelled || recoveredCount >= pending.count) return;

          await new Promise((resolve) => window.setTimeout(resolve, 12000));
          if (cancelled) return;
          recoveredCount = await mergeRecoveredBatch(pending);
          if (cancelled || recoveredCount >= pending.count) return;

          const missingCount = pending.count - recoveredCount;
          const resumedUrls = await generateMoodImages(
            {
              projectId,
              briefAnalysis: pending.opts.briefAnalysis,
              scenes: pending.opts.scenes,
              assets: pending.opts.assets,
              videoFormat: pending.opts.videoFormat,
              count: missingCount,
              targetSceneNumber: pending.opts.targetSceneNumber,
              model: pending.opts.model,
              forceAssetRefs: pending.opts.forceAssetRefs,
              quality: getGptQualityDefault("mood"),
            },
            (batchUrls) => {
              const batches = getMoodGenBatches(projectId);
              const cur = batches.find((batch) => batch.batchId === pending.batchId);
              if (cur) {
                patchMoodGenBatch(projectId, pending.batchId, {
                  arrivedUrls: [...cur.arrivedUrls, ...batchUrls],
                });
              }
            },
          );
          if (cancelled) return;
          const resumedImages: MoodImage[] = resumedUrls.map((url, index) => ({
            id: pending.skeletonIds[recoveredCount + index] ?? genMoodId(),
            url: normalizeStorageUrl(url) ?? url,
            liked: false,
            sceneRef: null,
            comment: "",
            createdAt: new Date().toISOString(),
          }));
          setMoodImages((prev) => {
            const skeletonSet = new Set(pending.skeletonIds);
            const existingUrls = new Set(prev.map((img) => img.url).filter(Boolean));
            const uniqueResumed = resumedImages.filter((img) => img.url && !existingUrls.has(img.url));
            const rest = prev.filter((img) => !skeletonSet.has(img.id));
            const next = [...uniqueResumed, ...rest];
            void saveMoodImagesToDB(next);
            return next;
          });
        } finally {
          removePendingMoodBatch(projectId, pending.batchId);
          removeMoodGenBatch(projectId, pending.batchId);
        }
      })();

      patchMoodGenBatch(projectId, pending.batchId, { promise: restorePromise });
    }

    return () => {
      cancelled = true;
    };
  }, [mergeRecoveredBatch, projectId, saveMoodImagesToDB, setMoodImages]);

  const handleGenerate = async () => {
    // ─── 다중 배치 동시 진행 ───
    // 이전에는 _moodGeneratingByProject 가 프로젝트당 단일 슬롯이라 두 번째 generate 호출이
    // 첫 배치의 skeletonIds/arrivedUrls 를 덮어쓰는 한계가 있었음.
    // 이제 batchId 로 식별되는 배치 단위로 보관하므로, 사용자가 첫 배치 진행 중에 추가
    // generate 를 눌러도 두 배치가 독립적으로 살아남는다.
    const batchId = genMoodId();
    const batchCount = generateCount;
    const batchModel = moodModel;
    const batchApiModel: MoodImageModel = batchModel === "gpt-image-1.5-ref" || batchModel === "gpt-image-1.5-text"
      ? "gpt-image-1.5"
      : batchModel;
    const batchForceAssetRefs = batchModel === "gpt-image-1.5-ref";
    const batchTargetSceneNum = targetSceneNum;

    // skeleton placeholder (url: null) 삽입.
    // skeletonIds 는 모듈 store 에도 보관해서 탭 이동 → 재마운트 시에도 살아있게 한다.
    const skeletonIds = Array.from({ length: batchCount }, () => genMoodId());
    const skeletons: MoodImage[] = skeletonIds.map((id) => ({
      id,
      url: null,
      liked: false,
      sceneRef: null,
      comment: "",
      createdAt: new Date().toISOString(),
    }));
    setMoodImages((prev) => [...skeletons, ...prev]);

    // 배치를 모듈 store 에 등록 (promise 는 아래에서 채움)
    addMoodGenBatch(projectId, {
      batchId,
      count: batchCount,
      skeletonIds,
      arrivedUrls: [],
      promise: null,
    });

    const targetScenes =
      batchTargetSceneNum !== null ? scenes.filter((s) => s.scene_number === batchTargetSceneNum) : scenes;
    upsertPendingMoodBatch({
      batchId,
      projectId,
      count: batchCount,
      skeletonIds,
      startedAt: Date.now(),
      opts: {
        briefAnalysis,
        scenes: targetScenes.map((s) => ({
          scene_number: s.scene_number,
          title: s.title,
          description: s.description,
          camera_angle: s.camera_angle,
          location: s.location,
          mood: s.mood,
          tagged_assets: s.tagged_assets,
        })),
        assets: assets.map((a) => ({
          tag_name: a.tag_name,
          photo_url: a.photo_url,
          ai_description: a.ai_description,
          asset_type: a.asset_type,
          role_description: a.role_description,
          outfit_description: a.outfit_description,
          space_description: a.space_description,
        })),
        videoFormat,
        targetSceneNumber: batchTargetSceneNum,
        model: batchApiModel,
        forceAssetRefs: batchForceAssetRefs,
      },
    });

    const genPromise = (async () => {
      try {
        const generatedUrls = await generateMoodImages(
          {
            projectId,
            briefAnalysis,
            scenes: targetScenes.map((s) => ({
              scene_number: s.scene_number,
              title: s.title,
              description: s.description,
              camera_angle: s.camera_angle,
              location: s.location,
              mood: s.mood,
              tagged_assets: s.tagged_assets,
            })),
            assets: assets.map((a) => ({
              tag_name: a.tag_name,
              photo_url: a.photo_url,
              ai_description: a.ai_description,
              asset_type: a.asset_type,
              role_description: a.role_description,
              outfit_description: a.outfit_description,
              space_description: a.space_description,
            })),
            videoFormat,
            count: batchCount,
            targetSceneNumber: batchTargetSceneNum,
            model: batchApiModel,
            forceAssetRefs: batchForceAssetRefs,
            quality: getGptQualityDefault("mood"),
          },
          (batchUrls) => {
            // 이 배치의 arrivedUrls 만 갱신 — 다른 in-flight 배치에 영향 없음.
            // AgentTab 의 mood gen 구독 effect 가 이 patch 를 받아 모든 배치의
            // skeletonIds + arrivedUrls 를 합쳐 moodImages 를 일관되게 재구성한다.
            //
            // NOTE: 로컬 setMoodImages 로 null 을 url 로 바꾸는 추가 작업은 하지 않는다.
            //       구독자(AgentTab.sync) 가 단일 진실 공급원으로 동작해야
            //       동시 배치에서 "첫 번째 null 슬롯" 을 잘못 해석해 URL 중복 기록되는 일이 없다.
            const batches = getMoodGenBatches(projectId);
            const cur = batches.find((b) => b.batchId === batchId);
            if (cur) {
              patchMoodGenBatch(projectId, batchId, {
                arrivedUrls: [...cur.arrivedUrls, ...batchUrls],
              });
            }
          },
        );
        if (generatedUrls.length < batchCount) {
          toast({
            title: t("mood.generatedPartialToast", { done: generatedUrls.length, total: batchCount }),
            description: t("mood.generatedPartialDesc"),
            variant: "destructive",
          });
        } else {
          toast({ title: t("mood.generatedToast", { count: batchCount }) });
        }
      } catch (err: any) {
        const message = String(err?.message ?? "");
        const isSafetyRejected = message === "SAFETY_FILTER_REJECTED" || /safety system|safety filter/i.test(message);
        toast({
          title: isSafetyRejected ? t("mood.safetyRejectedTitle") : t("mood.generationFailed"),
          description: isSafetyRejected ? t("mood.safetyRejectedDesc") : t("mood.allGenerationFailedDesc"),
          variant: "destructive",
        });
      } finally {
        // ─── 언마운트-세이프 완료 처리 ───
        // 탭 전환으로 AgentTab 이 unmount 된 상태에서도 DB 에 반드시 저장되어야 하므로,
        // setMoodImages (React state) 가 아닌 모듈 store + supabase 를 직접 사용한다.
        // 1) 이 배치의 arrivedUrls 기준으로 DB persist (다른 배치 영향 X — 자기 skeletonIds 만 머지)
        const finalBatch = getMoodGenBatches(projectId).find((b) => b.batchId === batchId);
        await persistMoodGenResultToDB(projectId, finalBatch);
        // 2) mount 된 경우에만 로컬 state 정리 — 이 배치의 skeleton 중 url 이 null 로 남은 것만 제거.
        //    다른 in-flight 배치의 null skeleton 은 보존해야 하므로 "이 배치 소속 + null" 만 필터아웃.
        const skelSet = new Set(skeletonIds);
        setMoodImages((prev) => prev.filter((img) => !(skelSet.has(img.id) && img.url === null)));
        // 3) 모듈 store 에서 이 배치 제거 — subscribeMoodGen listener 트리거.
        removePendingMoodBatch(projectId, batchId);
        removeMoodGenBatch(projectId, batchId);
      }
    })();
    // promise 핸들을 이 배치에 기록
    patchMoodGenBatch(projectId, batchId, { promise: genPromise });
  };

  const handleToggleLike = (id: string) =>
    setMoodImages((prev) => {
      const next = prev.map((img) => (img.id === id ? { ...img, liked: !img.liked } : img));
      saveMoodImagesToDB(next);
      return next;
    });
  const requestDelete = (ids: string[]) => {
    const connectedScenes = ids
      .map((id) => moodImages.find((i) => i.id === id))
      .filter((img): img is MoodImage => !!img && img.sceneRef !== null)
      .map((img) => img.sceneRef as number);
    if (connectedScenes.length > 0) setDeleteConfirm({ ids, connectedScenes: [...new Set(connectedScenes)] });
    else onDeleteMoodImages(ids);
  };
  const toggleSelect = (id: string) =>
    setSelectedIds((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const clearSelection = () => setSelectedIds(new Set());
  const openAttachMenu = (e: React.MouseEvent, imgId: string) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setAttachMenu({ id: imgId, x: rect.left, y: rect.top });
  };
  const doAttach = async (imgId: string, scene: Scene) => {
    const img = moodImages.find((i) => i.id === imgId);
    if (!img || !img.url) return;
    await onAttachToScene(normalizeStorageUrl(img.url) ?? img.url, scene.id, imgId, scene.scene_number);
    setAttachMenu(null);
    toast({ title: t("mood.attachedToast", { scene: scene.scene_number }) });
  };
  const doDetach = async (imgId: string) => {
    const img = moodImages.find((i) => i.id === imgId);
    if (!img || img.sceneRef === null) return;
    await onDetachFromScene(imgId, img.sceneRef);
    setAttachMenu(null);
    toast({ title: t("mood.detachedToast", { scene: img.sceneRef }) });
  };

  const displayImages = showLikedOnly ? moodImages.filter((img) => img.url === null || img.liked) : moodImages;
  const likedCount = moodImages.filter((img) => img.liked).length;
  const attachImg = attachMenu ? moodImages.find((i) => i.id === attachMenu.id) : null;

  const MOOD_MODEL_OPTIONS: MoodModelOption[] = ["gpt-image-1.5-ref", "gpt-image-1.5-text", "gpt-image-2", "nano-banana-2"];

  const modelSelector = (
    <div ref={modelMenuRef} style={{ position: "relative" }}>
      <button
        onClick={() => setModelMenuOpen((p) => !p)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "0 10px",
          height: 28,
          fontSize: 11,
          cursor: "pointer",
          border: `0.5px solid ${modelMenuOpen ? KR : "hsl(var(--border))"}`,
          background: modelMenuOpen ? KR_BG : "hsl(var(--muted))",
          color: modelMenuOpen ? KR : "hsl(var(--muted-foreground))",
          transition: "all 0.15s",
          fontWeight: 500,
        }}
      >
        <Cpu className="w-3 h-3" />
        {MOOD_MODEL_LABELS[moodModel]}
        <span style={{ fontSize: 9, opacity: 0.6 }}>{modelMenuOpen ? "▴" : "▾"}</span>
      </button>
      {modelMenuOpen && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            background: "hsl(var(--card))",
            border: "0.5px solid hsl(var(--border))",
            overflow: "hidden",
            boxShadow: "0 4px 16px rgba(0,0,0,0.1)",
            zIndex: 100,
            minWidth: 260,
          }}
        >
          {MOOD_MODEL_OPTIONS.map((m) => {
            const disabled = m === "gpt-image-2" || m === "nano-banana-2";
            const active = moodModel === m;
            return (
              <button
                key={m}
                onClick={() => {
                  if (disabled) {
                    toast({
                      title: t("mood.disabledModelTitle"),
                      description: t("mood.disabledModelDesc"),
                      variant: "destructive",
                    });
                    return;
                  }
                  setMoodModel(m);
                  setModelMenuOpen(false);
                }}
                style={{
                  width: "100%",
                  display: "flex",
                  flexDirection: "column",
                  padding: "8px 12px",
                  background: "none",
                  border: "none",
                  cursor: disabled ? "not-allowed" : "pointer",
                  textAlign: "left",
                  fontFamily: "inherit",
                  opacity: disabled ? 0.4 : 1,
                }}
                onMouseEnter={(e) => {
                  if (!disabled) (e.currentTarget as HTMLElement).style.background = "hsl(var(--muted))";
                }}
                onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "none")}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: active ? 600 : 400,
                      color: active ? KR : "hsl(var(--foreground))",
                    }}
                  >
                    {MOOD_MODEL_LABELS[m]}
                  </span>
                  {m === MOOD_MODEL_OPTION_DEFAULT && (
                    <span
                      style={{
                        fontSize: 9,
                        padding: "1px 5px",
                        border: "0.5px solid hsl(var(--border))",
                        color: "hsl(var(--muted-foreground))",
                        letterSpacing: 0.3,
                      }}
                    >
                      {t("mood.default")}
                    </span>
                  )}
                  {active && (
                    <Check className="w-3 h-3 ml-auto" style={{ color: "hsl(var(--muted-foreground))" }} />
                  )}
                </div>
                <span style={{ fontSize: 10, color: "hsl(var(--muted-foreground))", marginTop: 2 }}>
                  {MOOD_MODEL_DESCRIPTIONS[m]}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  const renderMasonryGrid = (images: MoodImage[]) => {
    // 스켈레톤 관련 계산은 여기서 미리
    const skelImages = images.filter((i) => i.url === null);
    const totalSkel = skelImages.length;

    return (
      <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
        {Array.from({ length: thumbCols }, (_, colIdx) => (
          <div key={colIdx} style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
            {images
              .filter((_, idx) => idx % thumbCols === colIdx)
              .map((img) => {
                // 스켈레톤 순번 계산 (url === null인 것들 중 몇 번째인지)
                const skelIdx = img.url === null ? skelImages.indexOf(img) : undefined;

                // ── 핵심 변경 ──
                // url === null이든 아니든 항상 MoodCard 하나만 반환
                // React가 key={img.id}인 같은 컴포넌트를 유지하므로
                // url이 null→string으로 바뀌어도 DOM 교체 없이 props만 업데이트됨
                return (
                  <MoodCard
                    key={img.id}
                    img={img}
                    selected={selectedIds.has(img.id)}
                    hasSelection={selectedIds.size > 0}
                    skelIdx={skelIdx}
                    totalSkel={totalSkel}
                    videoFormat={videoFormat}
                    onToggleSelect={() => toggleSelect(img.id)}
                    onToggleLike={() => handleToggleLike(img.id)}
                    onDelete={() => requestDelete([img.id])}
                    onSendToChat={() => onSendToChat(normalizeStorageUrl(img.url) ?? img.url!)}
                    onLightbox={() => setLightboxUrl(normalizeStorageUrl(img.url) ?? img.url!)}
                    onAttach={(e) => openAttachMenu(e, img.id)}
                    onBroken={() => {
                      // Self-heal: the img 404'd. Most likely this is a
                      // legacy row written before the filename-sanitize fix
                      // (colons in GPT-path suffixes never actually wrote
                      // to disk on Windows). Drop it from state + DB so
                      // the empty card disappears and Lightbox doesn't
                      // resurrect it. Skeletons have url === null and
                      // don't render the <img> we bound this to, so this
                      // only fires for real broken URLs.
                      setMoodImages((prev) => {
                        const next = prev.filter((m) => m.id !== img.id);
                        void saveMoodImagesToDB(next);
                        return next;
                      });
                      setSelectedIds((prev) => {
                        if (!prev.has(img.id)) return prev;
                        const copy = new Set(prev);
                        copy.delete(img.id);
                        return copy;
                      });
                    }}
                  />
                );
              })}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full" onClick={() => setAttachMenu(null)}>
      <div style={{ padding: "8px 12px", borderBottom: "0.5px solid hsl(var(--border))", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "nowrap" }}>
          {/* Context selector */}
          <div ref={ctxRef} style={{ position: "relative" }}>
            <button
              onClick={() => setCtxOpen((p) => !p)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "0 10px",
                height: 28,
                fontSize: 11,
                cursor: "pointer",
                border: `0.5px solid ${ctxOpen ? KR : "hsl(var(--border))"}`,
                background: ctxOpen ? KR_BG : "hsl(var(--muted))",
                color: ctxOpen ? KR : "hsl(var(--muted-foreground))",
                transition: "all 0.15s",
                fontWeight: 500,
              }}
            >
              <svg
                width={10}
                height={10}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
              {contextLabel}
              <span style={{ fontSize: 9, opacity: 0.6 }}>{ctxOpen ? "▴" : "▾"}</span>
            </button>
            {ctxOpen && (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  left: 0,
                  background: "hsl(var(--card))",
                  border: "0.5px solid hsl(var(--border))",
                  overflow: "hidden",
                  boxShadow: "0 4px 16px rgba(0,0,0,0.1)",
                  zIndex: 100,
                  minWidth: 180,
                  whiteSpace: "nowrap" as const,
                }}
              >
                {[
                  { label: scenes.length > 0 ? t("mood.allScenes") : t("mood.briefBased"), num: null },
                  ...scenes.map((s) => ({
                    label: `#${String(s.scene_number).padStart(2, "0")}${s.title ? ` · ${s.title}` : ""}`,
                    num: s.scene_number,
                  })),
                ].map((opt) => (
                  <button
                    key={opt.num ?? "all"}
                    onClick={() => {
                      setTargetSceneNum(opt.num);
                      setCtxOpen(false);
                    }}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      padding: "7px 12px",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      textAlign: "left",
                      fontFamily: "inherit",
                      fontSize: 12,
                      color: targetSceneNum === opt.num ? KR : "hsl(var(--foreground))",
                      fontWeight: targetSceneNum === opt.num ? 600 : 400,
                    }}
                    onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "hsl(var(--muted))")}
                    onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "none")}
                  >
                    <span
                      style={{
                        width: 5,
                        height: 5,
                        borderRadius: "50%",
                        background: KR,
                        flexShrink: 0,
                        opacity: targetSceneNum === opt.num ? 1 : 0,
                      }}
                    />
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* Count selector */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              background: "hsl(var(--muted))",
              padding: "2px 6px",
            }}
          >
            <button
              onClick={() => setGenerateCount((p) => Math.max(1, p - 1))}
              style={{
                width: 20,
                height: 24,
                fontSize: 13,
                fontWeight: 600,
                background: "transparent",
                color: "hsl(var(--muted-foreground))",
                border: "none",
                cursor: "pointer",
                lineHeight: 1,
              }}
            >
              −
            </button>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={generateCount}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v >= 1 && v <= 20) setGenerateCount(v);
              }}
              style={{
                width: 28,
                height: 22,
                fontSize: 11,
                fontWeight: 700,
                background: KR,
                color: "#fff",
                border: "none",
                textAlign: "center",
                fontFamily: "var(--font-mono, monospace)",
              }}
            />
            <button
              onClick={() => setGenerateCount((p) => Math.min(20, p + 1))}
              style={{
                width: 20,
                height: 24,
                fontSize: 13,
                fontWeight: 600,
                background: "transparent",
                color: "hsl(var(--muted-foreground))",
                border: "none",
                cursor: "pointer",
                lineHeight: 1,
              }}
            >
              +
            </button>
          </div>
          {/* Model selector */}
          {modelSelector}
          <div style={{ width: 1, height: 14, background: "hsl(var(--border))" }} />
          {/* Saved filter */}
          <button
            onClick={() => setShowLikedOnly((p) => !p)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "0 10px",
              height: 28,
              fontSize: 11,
              fontWeight: 500,
              background: showLikedOnly ? KR_BG : "transparent",
              color: showLikedOnly ? KR : "hsl(var(--muted-foreground))",
              border: `0.5px solid ${showLikedOnly ? KR_BORDER : "transparent"}`,
              cursor: "pointer",
              transition: "all 0.15s",
            }}
          >
            <svg
              width={11}
              height={11}
              viewBox="0 0 24 24"
              fill={showLikedOnly ? "currentColor" : "none"}
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" />
            </svg>
            {likedCount > 0 ? t("mood.savedCount", { count: likedCount }) : t("mood.saved")}
          </button>
          {/* Column slider + count */}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 11, color: "hsl(var(--muted-foreground))" }}>{displayImages.length} imgs</span>
            <div style={{ width: 1, height: 14, background: "hsl(var(--border))" }} />
            <svg
              width={11}
              height={11}
              viewBox="0 0 24 24"
              fill="none"
              stroke="hsl(var(--muted-foreground))"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
            </svg>
            <input
              type="range"
              min={1}
              max={7}
              step={1}
              value={thumbCols}
              onChange={(e) => setThumbCols(Number(e.target.value))}
              style={{ width: 64, accentColor: KR, cursor: "pointer" }}
              title={`${thumbCols} col`}
            />
            <span style={{ fontSize: 10, color: "hsl(var(--muted-foreground))", minWidth: 28, textAlign: "center" }}>
              {thumbCols} cols
            </span>
          </div>
          {/* Generate button — 진행중 배치가 있어도 계속 클릭 가능 (다중 배치 동시 진행 허용).
              진행중일 때는 in-flight 카운터를 우측에 작은 배지로 노출. */}
          <button
            onClick={handleGenerate}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "0 13px",
              height: 28,
              fontSize: 11,
              fontWeight: 600,
              background: KR,
              color: "#fff",
              border: "none",
              cursor: "pointer",
              flexShrink: 0,
            }}
            title={isGenerating ? t("mood.generateInProgressTitle", { count: inFlightCount }) : undefined}
          >
            {isGenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}{" "}
            {t("mood.generate")}
            {inFlightCount > 0 && (
              <span
                style={{
                  marginLeft: 4,
                  padding: "0 5px",
                  height: 16,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 8,
                  background: "hsl(var(--foreground) / 0.22)",
                  fontSize: 10,
                  fontWeight: 700,
                  lineHeight: 1,
                }}
              >
                {inFlightCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {selectedIds.size > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 12px",
            background: KR_BG,
            borderBottom: `0.5px solid ${KR_BORDER2}`,
            flexShrink: 0,
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
          >
            <polyline points="9 11 12 14 22 4" />
            <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
          </svg>
          <span style={{ fontSize: 12, fontWeight: 500, color: KR }}>
            {t("mood.selected", { count: selectedIds.size })}
          </span>
          <button
            onClick={clearSelection}
            style={{
              padding: "4px 10px",
              fontSize: 11,
              border: "0.5px solid hsl(var(--border))",
              background: "transparent",
              color: "hsl(var(--muted-foreground))",
              cursor: "pointer",
            }}
          >
            {t("mood.deselect")}
          </button>
          <div style={{ flex: 1 }} />
          <button
            onClick={() => requestDelete(Array.from(selectedIds))}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "4px 10px",
              fontSize: 11,
              fontWeight: 500,
              background: "#dc2626",
              color: "#fff",
              border: "none",
              cursor: "pointer",
            }}
          >
          {t("mood.delete")}
          </button>
          {moodImages.length > 0 && (
            <button
              onClick={() => requestDelete(moodImages.map((i) => i.id))}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "4px 10px",
                fontSize: 11,
                fontWeight: 500,
                background: "transparent",
                color: "#fff",
                border: "0.5px solid #dc2626",
                cursor: "pointer",
              }}
            >
              {t("mood.deleteAll")}
            </button>
          )}
        </div>
      )}

      {/* 빈 상태에서는 하단 패딩(pb-24) 을 빼서 컷 구성 패널과 중앙 정렬 높이를 맞춘다.
          그리드일 때만 pb-24 — 마지막 행 카드의 호버 오버레이가 뷰포트 하단에 가려지지 않도록. */}
      <div className="flex-1 min-h-0 overflow-y-auto" onClick={() => setAttachMenu(null)}>
        {displayImages.length === 0 && !isGenerating ? (
          <EmptyState
            icon={showLikedOnly ? <Heart className="w-10 h-10" /> : <ImageIcon className="w-10 h-10" />}
            title={showLikedOnly ? t("mood.noSavedImages") : t("mood.noMoodImages")}
            description={showLikedOnly ? t("mood.saveImagesHint") : t("mood.generateHint")}
            className="h-full"
          />
        ) : (
          <div className="p-3 pb-24">{renderMasonryGrid(displayImages)}</div>
        )}
      </div>

      {attachMenu && attachImg && (
        <div
          ref={attachMenuRef}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "fixed",
            left: attachMenu.x,
            top: attachMenu.y - 4,
            transform: "translateY(-100%)",
            background: "#141414",
            border: "0.5px solid hsl(var(--border))",
            overflow: "hidden",
            boxShadow: "0 4px 24px rgba(0,0,0,0.5)",
            zIndex: 9999,
            minWidth: 150,
          }}
        >
          <div
            style={{
              padding: "5px 10px 4px",
              fontSize: 10,
              color: "hsl(var(--muted-foreground))",
              borderBottom: "0.5px solid hsl(var(--border))",
            }}
          >
            {t("mood.attachToScene")}
          </div>
          {attachImg.sceneRef !== null && (
            <>
              <button
                onClick={() => doDetach(attachMenu.id)}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 10px",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  textAlign: "left",
                  fontFamily: "inherit",
                  fontSize: 11,
                  color: "#dc2626",
                }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "rgba(220,38,38,0.12)")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "none")}
              >
                <X style={{ width: 11, height: 11 }} />
                {t("mood.detachScene", { scene: String(attachImg.sceneRef).padStart(2, "0") })}
              </button>
              <div style={{ height: 1, background: "hsl(var(--border))", margin: "2px 0" }} />
            </>
          )}
          {scenes.map((s) => {
            const attachUrl = normalizeStorageUrl(attachImg.url) ?? attachImg.url;
            const sceneUrl = normalizeStorageUrl(s.conti_image_url) ?? s.conti_image_url;
            const alreadyTaken = !!sceneUrl && sceneUrl !== attachUrl;
            const isCurrentlyAttached = attachImg.sceneRef === s.scene_number;
            return (
              <button
                key={s.id}
                disabled={alreadyTaken}
                onClick={() => !alreadyTaken && doAttach(attachMenu.id, s)}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 10px",
                  background: "none",
                  border: "none",
                  cursor: alreadyTaken ? "not-allowed" : "pointer",
                  textAlign: "left",
                  fontFamily: "inherit",
                  fontSize: 11,
                  color: isCurrentlyAttached ? KR : "hsl(var(--foreground))",
                  opacity: alreadyTaken ? 0.4 : 1,
                }}
                onMouseEnter={(e) => {
                  if (!alreadyTaken) (e.currentTarget as HTMLElement).style.background = "hsl(var(--muted))";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.background = "none";
                }}
              >
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    padding: "1px 5px",
                    background: KR,
                    color: "#fff",
                  }}
                >
                  #{String(s.scene_number).padStart(2, "0")}
                </span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {s.title || `Shot ${s.scene_number}`}
                </span>
                {alreadyTaken && <span style={{ fontSize: 9, color: "hsl(var(--muted-foreground))" }}>{t("mood.linked")}</span>}
                {isCurrentlyAttached && !alreadyTaken && (
                  <svg
                    width={10}
                    height={10}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke={KR}
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}

      {deleteConfirm && (
        <Dialog open onOpenChange={() => setDeleteConfirm(null)}>
          <DialogContent size="sm">
            <DialogHeader>
              <DialogTitle>{t("mood.deleteImagesTitle")}</DialogTitle>
            </DialogHeader>
            <p className="text-body text-muted-foreground leading-relaxed">
              {t("mood.deleteImagesDesc", {
                count: deleteConfirm.connectedScenes.length,
                scenes: deleteConfirm.connectedScenes.map((n) => `#${String(n).padStart(2, "0")}`).join(", "),
              })}
            </p>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setDeleteConfirm(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                onClick={async () => {
                  await onDeleteMoodImages(deleteConfirm.ids);
                  setSelectedIds(new Set());
                  setDeleteConfirm(null);
                }}
                className="gap-1.5"
                style={{ background: "#dc2626", color: "#fff" }}
              >
                {t("common.delete")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {lightboxUrl &&
        (() => {
          const currentIdx = displayImages.findIndex((img) => (normalizeStorageUrl(img.url) ?? img.url) === lightboxUrl);
          const hasPrev = currentIdx > 0;
          const hasNext = currentIdx < displayImages.length - 1;
          const goPrev = () => {
            if (hasPrev) setLightboxUrl(normalizeStorageUrl(displayImages[currentIdx - 1].url) ?? displayImages[currentIdx - 1].url);
          };
          const goNext = () => {
            if (hasNext) setLightboxUrl(normalizeStorageUrl(displayImages[currentIdx + 1].url) ?? displayImages[currentIdx + 1].url);
          };
          return (
            <div
              className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80"
              onClick={() => setLightboxUrl(null)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setLightboxUrl(null);
                if (e.key === "ArrowLeft") goPrev();
                if (e.key === "ArrowRight") goNext();
              }}
              tabIndex={0}
              ref={(el) => el?.focus()}
            >
              <button
                onClick={() => setLightboxUrl(null)}
                className="absolute top-4 right-4"
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: "50%",
                  background: "hsl(var(--foreground) / 0.15)",
                  border: "none",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <X className="w-5 h-5 text-white" />
              </button>
              {hasPrev && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    goPrev();
                  }}
                  className="absolute left-4 top-1/2 -translate-y-1/2"
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: "50%",
                    background: "hsl(var(--foreground) / 0.1)",
                    border: "none",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <ChevronLeft className="w-5 h-5 text-white" />
                </button>
              )}
              {hasNext && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    goNext();
                  }}
                  className="absolute right-4 top-1/2 -translate-y-1/2"
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: "50%",
                    background: "hsl(var(--foreground) / 0.1)",
                    border: "none",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <ChevronRight className="w-5 h-5 text-white" />
                </button>
              )}
              <img
                src={lightboxUrl}
                alt="mood lightbox"
                style={{ maxWidth: "85vw", maxHeight: "90vh", objectFit: "contain" }}
                onClick={(e) => e.stopPropagation()} loading="lazy" decoding="async" />
              {currentIdx >= 0 && (
                <span
                  className="absolute bottom-4 left-1/2 -translate-x-1/2"
                  style={{ fontSize: 11, color: "hsl(var(--foreground) / 0.5)", fontWeight: 500 }}
                >
                  {currentIdx + 1} / {displayImages.length}
                </span>
              )}
            </div>
          );
        })()}
    </div>
  );
};
