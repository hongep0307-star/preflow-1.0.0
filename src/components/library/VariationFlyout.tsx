/**
 * VariationFlyout — Reference Library AI 베리에이션 패널.
 *
 * 기존 모달(VariationDialog)을 BriefMatchFlyout 패턴의 `position: fixed` 패널로
 * 전환한 것. 모달이 아니므로 뒤 그리드/캔버스가 살아 있어 카드를 그대로 잡을 수
 * 있고, 참조 주입을 (1) 로컬 파일 선택 (2) OS 파일 드래그&드랍 (3) 라이브러리
 * 카드 드래그(글로벌 트래커 → data-drop-variation-inject) 세 경로로 받는다.
 *
 * 앵커링: 원본 카드(data-drop-card-id / data-canvas-item-id)의 화면 rect 를 rAF
 * 루프로 재측정해 카드 오른쪽(공간 없으면 왼쪽)에 붙여 따라다닌다. 카드가 화면
 * 밖으로 나가면 뷰포트 가장자리로 clamp. (그리드 스크롤 + 캔버스 팬/줌 모두 대응)
 */
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from "react";
import { X, ImagePlus } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  GPT_QUALITIES,
  IMAGE_GEN_MODEL_LABELS,
  getFeatureSpec,
  getGptQualityDefault,
  getImageModelDefault,
  modelIsGpt,
  setGptQualityDefault,
  setImageModelDefault,
  type GptQuality,
} from "@/lib/imageGenPreference";
import type { ReferenceItem } from "@/lib/referenceLibrary";
import { withReferenceVersion } from "@/lib/referenceLibrary";
import { getActiveLibraryDrag, subscribeDragHover } from "@/lib/libraryDragChannel";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/uiLanguage";

/** Step 1(빠른 변형) — 추가 리소스 없이 원본만으로 "구도 베리에이션" 을 뽑는
 *  내장 프롬프트. 정체성/의상/무드만 유지하고 구도(앵글·샷 사이즈·배치)는 크게
 *  바꾸도록 강하게 지시한다 — edits/NB2 가 입력을 그대로 재현하는 보수 성향을
 *  상쇄하기 위함. */
const COMPOSITION_TEMPLATE =
  "Reframe this subject into a DISTINCTLY different cinematic shot — it should look like " +
  "another frame from the same photoshoot, not a copy of the input. " +
  "Preserve ONLY the subject's identity, wardrobe, and overall color and lighting mood. " +
  "Substantially change the composition: camera angle, shot size, the subject's position " +
  "within the frame, lens and depth of field. Avoid replicating the original pose and framing. " +
  "High-quality, photographic, cinematic.";

export interface VariationSubmit {
  prompt: string;
  model: string;
  quality: GptQuality;
  referenceImageUrls: string[];
  count: number;
  /** 출력 해상도/비율 — "1024x1536"(세로) | "1536x1024"(가로) | "1024x1024"(정사각). */
  imageSize: string;
  /** 사용자가 프롬프트를 비워 자동 구도 템플릿을 쓰는 경우 true. 이때 다중 생성
   *  시 부모가 장별로 서로 다른 앵글 지시를 덧붙여 출력 다양성을 높인다. */
  autoComposition: boolean;
}

/** 라이브러리에서 주입한 참조(부모가 id → 항목 해석해 내려줌). */
export interface VariationInjectedRef {
  id: string;
  url: string;
  preview: string;
  name: string;
}

interface VariationFlyoutProps {
  source: ReferenceItem | null;
  /** 앵커할 카드 id — data-drop-card-id(그리드) / data-canvas-item-id(캔버스). */
  anchorId: string | null;
  /** 현재 백그라운드에서 진행 중인 생성 수(병렬). 0 보다 크면 버튼에 표시하되
   *  버튼을 막지 않는다 — 생성 중에도 추가 생성을 시작할 수 있다. */
  inFlight?: number;
  /** 라이브러리 카드 드래그로 주입된 참조(부모 소유). */
  libraryInjected: VariationInjectedRef[];
  onRemoveLibraryInjected: (id: string) => void;
  onClose: () => void;
  onSubmit: (params: VariationSubmit) => void;
}

const COUNT_OPTIONS = [1, 2, 3, 4];
const PANEL_WIDTH = 320;
const GAP = 8;

const ASPECT_OPTIONS: { id: string; labelKey: string }[] = [
  { id: "1024x1536", labelKey: "library.variation.ratioPortrait" },
  { id: "1536x1024", labelKey: "library.variation.ratioLandscape" },
  { id: "1024x1024", labelKey: "library.variation.ratioSquare" },
];

/** 원본 카드 비율로부터 기본 출력 비율을 추론(수동 오버라이드의 시작값). */
function defaultAspectFor(source: ReferenceItem | null): string {
  const w = source?.width ?? 0;
  const h = source?.height ?? 0;
  if (w > 0 && h > 0) {
    if (w > h * 1.1) return "1536x1024";
    if (h > w * 1.1) return "1024x1536";
    return "1024x1024";
  }
  return "1024x1536";
}

interface LocalRef {
  url: string;
  name: string;
}

export function VariationFlyout({
  source,
  anchorId,
  inFlight = 0,
  libraryInjected,
  onRemoveLibraryInjected,
  onClose,
  onSubmit,
}: VariationFlyoutProps) {
  const t = useT();
  const spec = getFeatureSpec("variation");
  const open = source !== null;

  const [prompt, setPrompt] = useState("");
  const [localInjected, setLocalInjected] = useState<LocalRef[]>([]);
  const [count, setCount] = useState(1);
  const [aspect, setAspect] = useState<string>(() => defaultAspectFor(source));
  const [model, setModel] = useState(spec.defaultModel);
  const [quality, setQuality] = useState<GptQuality>(spec.defaultQuality);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [injectHover, setInjectHover] = useState(false);
  const [fileOver, setFileOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // 열거나 원본이 바뀔 때 입력 초기화, 모델/품질은 Settings 디폴트, 비율은
  // 원본 카드 비율을 기본값으로(수동 오버라이드 가능).
  useEffect(() => {
    if (!open) return;
    setPrompt("");
    setLocalInjected([]);
    setCount(1);
    setModel(getImageModelDefault("variation"));
    setQuality(getGptQualityDefault("variation"));
    setAspect(defaultAspectFor(source));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source?.id]);

  // 카드 rect 를 rAF 루프로 추적해 패널 위치를 따라다니게 한다(그리드 스크롤 +
  // 캔버스 팬/줌 모두 native scroll 이벤트가 없을 수 있어 폴링이 가장 견고).
  useLayoutEffect(() => {
    if (!open || !anchorId) return;
    let raf = 0;
    let last: { left: number; top: number } | null = null;
    const measure = () => {
      const el = document.querySelector<HTMLElement>(
        `[data-drop-card-id="${CSS.escape(anchorId)}"], [data-canvas-item-id="${CSS.escape(anchorId)}"]`,
      );
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const panelH = panelRef.current?.offsetHeight ?? 360;
      let left: number;
      let top: number;
      if (el) {
        const r = el.getBoundingClientRect();
        // 오른쪽 우선, 공간 없으면 왼쪽.
        left = r.right + GAP;
        if (left + PANEL_WIDTH > vw - GAP) left = r.left - PANEL_WIDTH - GAP;
        top = r.top;
      } else {
        // 카드를 못 찾으면 화면 우상단 가장자리에 둔다.
        left = vw - PANEL_WIDTH - GAP;
        top = 72;
      }
      left = Math.max(GAP, Math.min(left, vw - PANEL_WIDTH - GAP));
      top = Math.max(GAP, Math.min(top, vh - panelH - GAP));
      const next = { left: Math.round(left), top: Math.round(top) };
      if (!last || last.left !== next.left || last.top !== next.top) {
        last = next;
        setPos(next);
      }
      raf = requestAnimationFrame(measure);
    };
    raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [open, anchorId]);

  // 라이브러리 카드를 주입 드롭존 위로 드래그할 때(내부 드래그) 강조.
  useEffect(() => {
    if (!open) return;
    const unsub = subscribeDragHover((target) => {
      setInjectHover(target?.kind === "variationInject");
    });
    return () => {
      unsub();
      setInjectHover(false);
    };
  }, [open]);

  const qualityApplies = modelIsGpt("variation", model);

  const handleModelChange = (value: string) => {
    setModel(value);
    setImageModelDefault("variation", value);
  };

  const handleQualityChange = (value: string) => {
    const q = value as GptQuality;
    setQuality(q);
    setGptQualityDefault("variation", q);
  };

  const handlePickFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const reads = await Promise.all(
      Array.from(files)
        .filter((f) => f.type.startsWith("image/"))
        .map(
          (f) =>
            new Promise<LocalRef>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve({ url: String(reader.result), name: f.name });
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(f);
            }),
        ),
    );
    setLocalInjected((cur) => [...cur, ...reads]);
  };

  const removeLocal = (idx: number) => {
    setLocalInjected((cur) => cur.filter((_, i) => i !== idx));
  };

  // 주입 드롭존 — 라이브러리 카드는 글로벌 트래커가, OS 파일은 native drop 이.
  const onInjectDrop = (e: DragEvent) => {
    e.preventDefault();
    setFileOver(false);
    if (getActiveLibraryDrag()) return; // 라이브러리 카드는 트래커가 처리
    if (e.dataTransfer.files?.length) void handlePickFiles(e.dataTransfer.files);
  };

  const onInjectDragOver = (e: DragEvent) => {
    if (getActiveLibraryDrag()) return; // 내부 드래그는 트래커가 처리
    e.preventDefault();
    setFileOver(true);
  };

  const submit = () => {
    const custom = prompt.trim();
    const finalPrompt = custom ? custom : COMPOSITION_TEMPLATE;
    const referenceImageUrls = [
      ...libraryInjected.map((i) => i.url),
      ...localInjected.map((i) => i.url),
    ];
    onSubmit({
      prompt: finalPrompt,
      model,
      quality,
      referenceImageUrls,
      count,
      imageSize: aspect,
      autoComposition: !custom,
    });
    // 생성 시작 후 패널은 닫는다 — 생성은 백그라운드로 계속되고, 진행 상태는
    // 원본 카드의 로딩 오버레이로 표시된다.
    onClose();
  };

  if (!open) return null;

  const previewUrl = source ? withReferenceVersion(source.thumbnail_url ?? source.file_url, source) : "";
  const totalInjected = libraryInjected.length + localInjected.length;
  const dropActive = injectHover || fileOver;

  return (
    <div
      ref={panelRef}
      className="fixed z-50 flex w-[320px] flex-col overflow-hidden border border-primary/30 bg-popover ring-1 ring-black/40"
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        maxHeight: "calc(100vh - 16px)",
        borderRadius: 0,
        visibility: pos ? "visible" : "hidden",
        // 그리드 위에 확실히 떠 보이도록 강한 그림자 + 좌측 accent.
        boxShadow: "0 16px 48px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4)",
      }}
    >
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
        <span className="flex-1 truncate text-meta font-semibold">{t("library.variation.title")}</span>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-6 w-6 items-center justify-center text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          style={{ borderRadius: 0 }}
          aria-label={t("common.close")}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5 space-y-3">
        {/* 원본 프리뷰 */}
        {previewUrl ? (
          <div className="flex items-center gap-2.5">
            <img
              src={previewUrl}
              alt={source?.title ?? ""}
              className="h-12 w-12 shrink-0 object-cover border border-border"
              style={{ borderRadius: 0 }}
            />
            <div className="min-w-0">
              <p className="truncate text-meta text-foreground/80">{source?.title}</p>
              <p className="text-caption text-muted-foreground">{t("library.variation.sourceHint")}</p>
            </div>
          </div>
        ) : null}

        {/* 모델 / 품질 / 장수 */}
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <p className="label-meta text-muted-foreground mb-1">{t("library.variation.model")}</p>
            <Select value={model} onValueChange={handleModelChange}>
              <SelectTrigger className="h-8 rounded-none text-meta">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-popover border-border-subtle text-foreground/80 rounded-none">
                {spec.models.map((m) => (
                  <SelectItem key={m.id} value={m.id} className="text-meta">
                    {IMAGE_GEN_MODEL_LABELS[m.id] ?? m.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-[72px]">
            <p className="label-meta text-muted-foreground mb-1">{t("library.variation.count")}</p>
            <Select value={String(count)} onValueChange={(v) => setCount(Number(v))}>
              <SelectTrigger className="h-8 rounded-none text-meta">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-popover border-border-subtle text-foreground/80 rounded-none">
                {COUNT_OPTIONS.map((n) => (
                  <SelectItem key={n} value={String(n)} className="text-meta">
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {/* 비율 + 품질 — 비율은 원본 기준 기본값에서 수동 변경 가능. */}
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <p className="label-meta text-muted-foreground mb-1">{t("library.variation.ratio")}</p>
            <Select value={aspect} onValueChange={setAspect}>
              <SelectTrigger className="h-8 rounded-none text-meta">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-popover border-border-subtle text-foreground/80 rounded-none">
                {ASPECT_OPTIONS.map((a) => (
                  <SelectItem key={a.id} value={a.id} className="text-meta">
                    {t(a.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className={cn("flex-1", qualityApplies ? undefined : "opacity-40")}>
            <p className="label-meta text-muted-foreground mb-1">{t("library.variation.quality")}</p>
            <Select value={quality} onValueChange={handleQualityChange} disabled={!qualityApplies}>
              <SelectTrigger className="h-8 rounded-none text-meta">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-popover border-border-subtle text-foreground/80 rounded-none">
                {GPT_QUALITIES.map((q) => (
                  <SelectItem key={q} value={q} className="text-meta">
                    {t(`settings.gptQuality.${q}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* 참조 주입 — 항상 노출. 클릭(로컬 선택) + 드래그&드랍 + 라이브러리 카드 드롭. */}
        <div>
          <p className="label-meta text-foreground mb-1">{t("library.variation.addReference")}</p>
          <div
            data-drop-variation-inject=""
            role="button"
            tabIndex={0}
            onClick={(e) => {
              // 썸네일(삭제 X 포함)을 클릭한 경우엔 파일 선택을 열지 않는다.
              if ((e.target as HTMLElement).closest("[data-inject-thumb]")) return;
              fileInputRef.current?.click();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            onDrop={onInjectDrop}
            onDragOver={onInjectDragOver}
            onDragLeave={() => setFileOver(false)}
            className={cn(
              "min-h-[56px] cursor-pointer border bg-input p-2 transition-colors hover:border-primary/40",
              dropActive ? "border-primary/60" : "border-input",
            )}
            style={{
              borderRadius: 0,
              ...(dropActive ? { background: "rgba(249,66,58,0.06)" } : {}),
            }}
          >
            {totalInjected === 0 ? (
              <div className="flex h-10 items-center justify-center gap-1.5 px-2 text-center text-2xs text-muted-foreground/60">
                <ImagePlus className="h-3.5 w-3.5" />
                {t("library.variation.dropHint")}
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {libraryInjected.map((img) => (
                  <div key={img.id} data-inject-thumb className="group relative h-[52px] w-[52px] border border-border" style={{ borderRadius: 0 }}>
                    <img src={img.preview || img.url} alt={img.name} className="h-full w-full object-cover" />
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onRemoveLibraryInjected(img.id); }}
                      className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center bg-primary text-white opacity-0 transition-opacity group-hover:opacity-100"
                      style={{ borderRadius: 0 }}
                      aria-label={t("common.delete")}
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </div>
                ))}
                {localInjected.map((img, idx) => (
                  <div key={`${img.name}-${idx}`} data-inject-thumb className="group relative h-[52px] w-[52px] border border-border" style={{ borderRadius: 0 }}>
                    <img src={img.url} alt={img.name} className="h-full w-full object-cover" />
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); removeLocal(idx); }}
                      className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center bg-primary text-white opacity-0 transition-opacity group-hover:opacity-100"
                      style={{ borderRadius: 0 }}
                      aria-label={t("common.delete")}
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </div>
                ))}
                {/* 더 추가 타일 — 썸네일이 있을 때도 추가 선택이 가능 */}
                <div
                  className="flex h-[52px] w-[52px] items-center justify-center border border-dashed border-border text-muted-foreground/60 hover:border-primary/50 hover:text-foreground"
                  style={{ borderRadius: 0 }}
                  aria-hidden
                >
                  <ImagePlus className="h-4 w-4" />
                </div>
              </div>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              void handlePickFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>

        {/* 프롬프트 — 항상 노출. 비워두면 구도 베리에이션(placeholder 로 안내). */}
        <div className="border-t border-border pt-2.5">
          <p className="label-meta text-foreground mb-1">{t("library.variation.promptLabel")}</p>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t("library.variation.promptEmptyHint")}
            className="w-full min-h-[72px] resize-none border bg-input px-2.5 py-2 text-meta leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-primary/50"
            style={{ borderRadius: 0 }}
          />
        </div>
      </div>

      {/* Footer — 생성 중에도 막지 않음(병렬). 진행 수만 표시. */}
      <div className="shrink-0 border-t border-border px-3 py-2.5">
        <button
          type="button"
          onClick={submit}
          disabled={!source}
          className="flex h-9 w-full items-center justify-center gap-1.5 bg-primary text-meta font-semibold text-primary-foreground disabled:opacity-50"
          style={{ borderRadius: 0 }}
        >
          {t("library.variation.generate")}
          {inFlight > 0 ? (
            <span className="inline-flex h-4 min-w-4 items-center justify-center bg-black/25 px-1 text-2xs tabular-nums">
              {inFlight}
            </span>
          ) : null}
        </button>
        {inFlight > 0 ? (
          <p className="mt-1.5 text-center text-2xs text-muted-foreground/70">
            {t("library.variation.inFlightHint", { n: inFlight })}
          </p>
        ) : null}
      </div>
    </div>
  );
}
