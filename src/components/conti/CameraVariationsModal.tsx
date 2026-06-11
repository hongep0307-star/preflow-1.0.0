/**
 * CameraVariationsModal — generates camera-angle variations of a scene.
 *
 * Two modes, surfaced as tabs in the modal body:
 *
 *   ● Presets        — multi-select N cameras from a 22-preset library
 *                      (Distance / Angle / Creative), fire one NB2 call per
 *                      preset in parallel. Each call uses the scene's source
 *                      image as the reference and prompts NB2 to RE-PHOTOGRAPH
 *                      the same world from the new camera position, keeping
 *                      identity, costume, environment, lighting and style.
 *                      This is the workhorse path.
 *
 *   ● Contact Sheet  — single NB2 call that produces a 3x3 cinematographer's
 *                      contact sheet in a 1:1 / 2K output. The 9 panels are
 *                      split client-side (canvas), displayed as 9 clickable
 *                      thumbnails; picking one uploads just that tile back
 *                      to storage via the `save_local` mode. This gives us
 *                      nine camera explorations for the latency cost of one
 *                      API call, with strong intra-image consistency because
 *                      all panels exist in a single NB2 canvas.
 *
 * Shared across both tabs:
 *   - Subject descriptor (buildSubjectDescriptor) injected into prompts so
 *     NB2 has a written identity anchor to complement the visual reference.
 *   - Emotion/Intent chip row — biases framing and expression without
 *     overwriting identity (e.g. "tense", "intimate", "triumphant").
 *
 * Prompt construction lives in src/lib/cameraLibrary.ts so every flow in
 * the app (this modal, ChangeAngleModal's Advanced chain) speaks NB2 in
 * the same voice.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Images,
  Loader2,
  X,
  Check,
  RotateCcw,
  Trash2,
  ArrowLeft,
  Grid3x3,
  HelpCircle,
  Sparkles,
} from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import type { Scene, Asset } from "./contiTypes";
import { IMAGE_SIZE_MAP } from "@/lib/conti";
import {
  CAMERA_PRESETS,
  CAMERA_PRESETS_BY_CATEGORY,
  EMOTION_CHIPS,
  buildPresetPrompt,
  buildContactSheetPrompt,
  contactSheetPresets,
  getEmotion,
  type CameraPreset,
  type CameraCategory,
  type EmotionChip,
} from "@/lib/cameraLibrary";
import { buildSubjectDescriptor } from "@/lib/subjectDescriptor";
import { splitContactSheetDataUrl, dataUrlToBase64 } from "@/lib/contactSheet";
import { useT } from "@/lib/uiLanguage";

type VideoFormat = keyof typeof IMAGE_SIZE_MAP;

/* ━━━ Types ━━━ */
type SlotStatus = "queued" | "generating" | "success" | "error";

interface VariationSlot {
  presetId: string;
  status: SlotStatus;
  url: string | null;
  error: string | null;
  startedAt?: number;
  durationMs?: number;
}

/**
 * Single generation request from modal → ContiTab. ContiTab dispatches on
 * the discriminator:
 *   preserve      → openai-image:inpaint (NB2) with source + built prompt.
 *                   One request per preset in the Presets tab.
 *   contact_sheet → openai-image:inpaint (NB2) with 1:1 / 2K imageSize +
 *                   the contact-sheet prompt. Returns a single image URL
 *                   containing the 3x3 grid.
 *   save_local    → upload a pre-rendered base64 tile to storage. Used by
 *                   the Contact Sheet "Apply" flow after the client has
 *                   split a tile out of the sheet.
 */
export type CameraVariationRequest =
  | {
      mode: "preserve";
      presetId: string;
      presetLabel: string;
      prompt: string;
      sourceImageUrl: string;
    }
  | {
      mode: "contact_sheet";
      prompt: string;
      sourceImageUrl: string;
    }
  | {
      mode: "save_local";
      base64: string;
      suffix: string;
    };

/* ━━━ Module-level slot cache ━━━
 * Keyed by scene.id. Survives modal open/close cycles so users can iterate
 * across several Generate cycles without losing earlier results. */
const slotsCache = new Map<string, Record<string, VariationSlot>>();
const readSlots = (sceneId: string): Record<string, VariationSlot> =>
  slotsCache.get(sceneId) ?? {};
const writeSlots = (sceneId: string, next: Record<string, VariationSlot>) => {
  if (Object.keys(next).length === 0) slotsCache.delete(sceneId);
  else slotsCache.set(sceneId, next);
};

/* Contact-sheet session cache — one per scene.id. Stores the raw NB2 output
 * URL plus the split tile data-URLs. Also preserved across open/close so a
 * user who accidentally closes the modal doesn't lose an expensive render. */
interface ContactSheetSession {
  rawUrl: string;
  tiles: string[];
  generatedAt: number;
}
const sheetCache = new Map<string, ContactSheetSession>();

/* Concurrency per modal session. NB2 tolerates 5-wide burst comfortably. */
const CONCURRENCY = 5;

/* ━━━ Color Tokens ━━━ */
const ACCENT = "hsl(var(--primary))";
const ACCENT_SOFT_BG = "hsl(var(--primary) / 0.12)";
const ACCENT_SOFT_BORDER = "hsl(var(--primary) / 0.55)";

/* ━━━ Styles ━━━ */
const BACKDROP_STYLE: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 50,
  background: "hsl(0 0% 0% / 0.8)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
};

const PANEL_STYLE: React.CSSProperties = {
  background: "hsl(var(--card))",
  border: "1px solid hsl(var(--border-subtle))",
  boxShadow: "0 10px 15px -3px hsl(0 0% 0% / 0.5), 0 4px 6px -4px hsl(0 0% 0% / 0.4)",
  width: "min(1180px, 100%)",
  height: "min(92vh, 860px)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const HEADER_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "14px 20px",
  borderBottom: "1px solid hsl(var(--border-subtle))",
  userSelect: "none",
  flexShrink: 0,
};

const FOOTER_STYLE: React.CSSProperties = {
  padding: "12px 20px",
  borderTop: "1px solid hsl(var(--border-subtle))",
  display: "flex",
  alignItems: "center",
  gap: 10,
  justifyContent: "flex-end",
  flexShrink: 0,
  background: "hsl(var(--surface-nav))",
};

type Tab = "presets" | "contact_sheet";
type FilterCategory = "all" | CameraCategory;

/* ━━━ Main modal ━━━ */
export interface CameraVariationsModalProps {
  scene: Scene;
  /** Asset library — fed into the subject descriptor for richer NB2 prompts. */
  assets?: Asset[];
  videoFormat: VideoFormat;
  onClose: () => void;
  onApplied: (newUrl: string, previousUrl: string | null) => void | Promise<void>;
  /**
   * Single generation entry point. ContiTab dispatches on `req.mode` and
   * returns the final public URL of the resulting image (or, for
   * contact_sheet, the URL of the single grid image the client will
   * then split).
   */
  generate: (req: CameraVariationRequest) => Promise<string>;
  /** Optional initial tab. Lets other menu entries (Change Angle legacy, etc.)
   *  land the user directly on a specific tab. */
  initialTab?: Tab;
}

export function CameraVariationsModal({
  scene,
  assets = [],
  videoFormat: _videoFormat,
  onClose,
  onApplied,
  generate,
  initialTab = "presets",
}: CameraVariationsModalProps) {
  const t = useT();
  const sourceUrl = scene.conti_image_url;

  const [tab, setTab] = useState<Tab>(initialTab);
  const [emotionId, setEmotionId] = useState<string>("neutral");
  const emotion = useMemo<EmotionChip | null>(
    () => getEmotion(emotionId) ?? null,
    [emotionId],
  );

  // Written identity anchor for prompts — cheap to recompute, only depends
  // on scene + assets, so memoise by reference equality.
  const subject = useMemo(() => buildSubjectDescriptor(scene, assets), [scene, assets]);

  return (
    <div style={BACKDROP_STYLE} onClick={onClose}>
      <div style={PANEL_STYLE} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={HEADER_STYLE}>
          <Images className="w-4 h-4" style={{ color: "hsl(var(--foreground) / 0.78)" }} />
          <div
            style={{
              color: "hsl(var(--foreground) / 0.95)",
              fontSize: 14,
              fontWeight: 600,
              flex: 1,
              letterSpacing: 0.1,
            }}
          >
            {t("cameraVar.title")}
          </div>
          <button
            onClick={onClose}
            className="text-white/60 hover:text-white/90"
            style={{ background: "transparent", border: "none", cursor: "pointer", display: "flex" }}
            title={t("cameraVar.closeEsc")}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab bar */}
        <div
          style={{
            display: "flex",
            gap: 2,
            padding: "0 16px",
            background: "hsl(var(--background))",
            borderBottom: "1px solid hsl(var(--foreground) / 0.06)",
            flexShrink: 0,
          }}
        >
          <TabBtn
            active={tab === "presets"}
            onClick={() => setTab("presets")}
            icon={<Sparkles className="w-3.5 h-3.5" />}
            label={t("cameraVar.tabPresets")}
            blurb={t("cameraVar.tabPresetsBlurb")}
          />
          <TabBtn
            active={tab === "contact_sheet"}
            onClick={() => setTab("contact_sheet")}
            icon={<Grid3x3 className="w-3.5 h-3.5" />}
            label={t("cameraVar.tabContactSheet")}
            blurb={t("cameraVar.tabContactSheetBlurb")}
          />
        </div>

        {/* Emotion chip row — shared across tabs.
            NB2 reacts well to a single adjective-pack appended to the prompt
            ("tense", "intimate", etc.), biasing framing and expression without
            overwriting identity. We surface it once at the top so changing
            tabs doesn't lose the selection. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 20px",
            borderBottom: "1px solid hsl(var(--foreground) / 0.05)",
            flexShrink: 0,
            background: "hsl(var(--background))",
          }}
        >
          <div
            style={{
              color: "hsl(var(--foreground) / 0.55)",
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: 0.6,
              textTransform: "uppercase",
              marginRight: 4,
              whiteSpace: "nowrap",
            }}
          >
            {t("cameraVar.mood")}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {EMOTION_CHIPS.map((e) => (
              <EmotionChipBtn
                key={e.id}
                chip={e}
                active={emotionId === e.id}
                onClick={() => setEmotionId(e.id)}
              />
            ))}
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, minHeight: 0, display: "flex", overflow: "hidden" }}>
          {!sourceUrl ? (
            <div
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "hsl(var(--foreground) / 0.6)",
                fontSize: 13,
                padding: 24,
                textAlign: "center",
              }}
            >
              {t("cameraVar.noSourceShot")}
            </div>
          ) : tab === "presets" ? (
            <PresetsTab
              scene={scene}
              subject={subject}
              emotion={emotion}
              sourceUrl={sourceUrl}
              generate={generate}
              onApplied={onApplied}
              onClose={onClose}
            />
          ) : (
            <ContactSheetTab
              scene={scene}
              subject={subject}
              emotion={emotion}
              sourceUrl={sourceUrl}
              generate={generate}
              onApplied={onApplied}
              onClose={onClose}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * PRESETS TAB
 * Multi-select N presets → fire N parallel NB2 calls → show results in
 * a grid. Results are persisted per scene.id in slotsCache.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
interface TabPaneProps {
  scene: Scene;
  subject: string;
  emotion: EmotionChip | null;
  sourceUrl: string;
  generate: (req: CameraVariationRequest) => Promise<string>;
  onApplied: (newUrl: string, previousUrl: string | null) => void | Promise<void>;
  onClose: () => void;
}

function PresetsTab({
  scene,
  subject,
  emotion,
  sourceUrl,
  generate,
  onApplied,
  onClose,
}: TabPaneProps) {
  const t = useT();
  // Default selection = every "recommended" preset so first-time users get
  // a well-rounded batch without having to tick boxes.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(CAMERA_PRESETS.filter((p) => p.recommended).map((p) => p.id)),
  );
  const [filter, setFilter] = useState<FilterCategory>("all");
  const [notes, setNotes] = useState("");
  const [slots, setSlots] = useState<Record<string, VariationSlot>>(() => readSlots(scene.id));
  const [phase, setPhase] = useState<"setup" | "results">(() =>
    Object.keys(readSlots(scene.id)).length > 0 ? "results" : "setup",
  );
  const [applyingFromUrl, setApplyingFromUrl] = useState<string | null>(null);

  useEffect(() => {
    writeSlots(scene.id, slots);
  }, [scene.id, slots]);

  const activeCountRef = useRef(0);
  const pendingQueueRef = useRef<string[]>([]);
  const cancelledRef = useRef(false);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !applyingFromUrl) onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [applyingFromUrl, onClose]);

  useEffect(
    () => () => {
      cancelledRef.current = true;
    },
    [],
  );

  const filteredPresets = useMemo(
    () => (filter === "all" ? CAMERA_PRESETS : CAMERA_PRESETS_BY_CATEGORY[filter]),
    [filter],
  );

  const togglePreset = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const selectAll = () => setSelected(new Set(CAMERA_PRESETS.map((p) => p.id)));
  const selectNone = () => setSelected(new Set());
  const selectRecommended = () =>
    setSelected(new Set(CAMERA_PRESETS.filter((p) => p.recommended).map((p) => p.id)));

  const runVariation = async (presetId: string) => {
    const preset = CAMERA_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;

    const startedAt = Date.now();
    setSlots((prev) => ({
      ...prev,
      [presetId]: {
        ...(prev[presetId] ?? { presetId, url: null, error: null }),
        status: "generating",
        startedAt,
        durationMs: undefined,
      },
    }));

    try {
      const prompt = buildPresetPrompt({
        preset,
        subject,
        emotion,
        extraNotes: notes,
      });
      const url = await generate({
        mode: "preserve",
        presetId: preset.id,
        presetLabel: preset.label,
        prompt,
        sourceImageUrl: sourceUrl,
      });
      if (cancelledRef.current) return;
      const durationMs = Date.now() - startedAt;
      setSlots((prev) => ({
        ...prev,
        [presetId]: { presetId, status: "success", url, error: null, startedAt, durationMs },
      }));
    } catch (e) {
      if (cancelledRef.current) return;
      const message = e instanceof Error ? e.message : String(e);
      const durationMs = Date.now() - startedAt;
      setSlots((prev) => ({
        ...prev,
        [presetId]: { presetId, status: "error", url: null, error: message, startedAt, durationMs },
      }));
    }
  };

  const drainQueue = () => {
    while (activeCountRef.current < CONCURRENCY && pendingQueueRef.current.length > 0) {
      const next = pendingQueueRef.current.shift()!;
      activeCountRef.current++;
      void runVariation(next).finally(() => {
        activeCountRef.current--;
        drainQueue();
      });
    }
  };

  const toGenerateIds = useMemo(() => {
    return CAMERA_PRESETS.filter((p) => selected.has(p.id))
      .filter((p) => {
        const slot = slots[p.id];
        if (!slot) return true;
        if (slot.status === "error") return true;
        return false;
      })
      .map((p) => p.id);
  }, [selected, slots]);

  const handleGenerate = () => {
    if (toGenerateIds.length === 0) return;

    setSlots((prev) => {
      const next = { ...prev };
      for (const id of toGenerateIds) {
        next[id] = { presetId: id, status: "queued", url: null, error: null };
      }
      return next;
    });

    cancelledRef.current = false;
    pendingQueueRef.current.push(...toGenerateIds);
    setPhase("results");
    drainQueue();
  };

  const handleReroll = (presetId: string) => {
    setSlots((prev) => ({
      ...prev,
      [presetId]: { presetId, status: "queued", url: null, error: null },
    }));
    pendingQueueRef.current.push(presetId);
    drainQueue();
  };

  const handleDiscard = (presetId: string) => {
    setSlots((prev) => {
      const next = { ...prev };
      delete next[presetId];
      return next;
    });
  };

  const handleApplyResult = async (url: string) => {
    if (applyingFromUrl) return;
    setApplyingFromUrl(url);
    try {
      await onApplied(url, sourceUrl);
      onClose();
    } catch (e) {
      console.error("[CameraVariations] apply failed:", e);
      setApplyingFromUrl(null);
    }
  };

  const hasAnySlots = Object.keys(slots).length > 0;

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "grid",
        gridTemplateColumns: "minmax(260px, 320px) 1fr",
        overflow: "hidden",
      }}
    >
      <SourcePreview scene={scene} sourceUrl={sourceUrl} subject={subject} />
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        {phase === "setup" ? (
          <PresetsSetup
            filteredPresets={filteredPresets}
            filter={filter}
            setFilter={setFilter}
            selected={selected}
            togglePreset={togglePreset}
            selectAll={selectAll}
            selectNone={selectNone}
            selectRecommended={selectRecommended}
            slots={slots}
            notes={notes}
            setNotes={setNotes}
          />
        ) : (
          <ResultsPanel
            slots={slots}
            applyingFromUrl={applyingFromUrl}
            onApplyResult={handleApplyResult}
            onReroll={handleReroll}
            onDiscard={handleDiscard}
          />
        )}
        <div style={FOOTER_STYLE}>
          {phase === "results" ? (
            <button
              onClick={() => setPhase("setup")}
              disabled={!!applyingFromUrl}
              style={backBtnStyle(!!applyingFromUrl)}
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              {t("cameraVar.backToPresets")}
            </button>
          ) : (
            hasAnySlots && (
              <button onClick={() => setPhase("results")} style={backBtnStyle(false)}>
                {t("cameraVar.viewResults", { n: Object.keys(slots).length })}
              </button>
            )
          )}
          <div style={{ color: "hsl(var(--foreground) / 0.45)", fontSize: 11 }}>
            {phase === "setup"
              ? summarizeSetup(selected, slots, toGenerateIds.length, t)
              : summarizeSlots(slots, t)}
          </div>
          {phase === "setup" && (
            <button
              onClick={handleGenerate}
              disabled={toGenerateIds.length === 0}
              title={
                toGenerateIds.length === 0
                  ? selected.size === 0
                    ? t("cameraVar.pickAtLeastOnePreset")
                    : t("cameraVar.allHaveResults")
                  : undefined
              }
              style={{
                background: toGenerateIds.length === 0 ? "rgba(220, 38, 38, 0.25)" : ACCENT,
                color: toGenerateIds.length === 0 ? "hsl(var(--foreground) / 0.45)" : "hsl(var(--primary-foreground))",
                border: "none",
                padding: "8px 14px",
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: 0.2,
                cursor: toGenerateIds.length === 0 ? "not-allowed" : "pointer",
              }}
            >
              {toGenerateIds.length > 0 ? t("cameraVar.generateN", { n: toGenerateIds.length }) : t("cameraVar.generate")}
            </button>
          )}
          {phase === "results" && (
            <button
              onClick={onClose}
              disabled={!!applyingFromUrl}
              style={{
                background: "transparent",
                border: "1px solid hsl(var(--foreground) / 0.18)",
                color: "hsl(var(--foreground) / 0.85)",
                padding: "8px 14px",
                fontSize: 12,
                fontWeight: 600,
                cursor: applyingFromUrl ? "not-allowed" : "pointer",
              }}
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function PresetsSetup({
  filteredPresets,
  filter,
  setFilter,
  selected,
  togglePreset,
  selectAll,
  selectNone,
  selectRecommended,
  slots,
  notes,
  setNotes,
}: {
  filteredPresets: CameraPreset[];
  filter: FilterCategory;
  setFilter: (f: FilterCategory) => void;
  selected: Set<string>;
  togglePreset: (id: string) => void;
  selectAll: () => void;
  selectNone: () => void;
  selectRecommended: () => void;
  slots: Record<string, VariationSlot>;
  notes: string;
  setNotes: (v: string) => void;
}) {
  const t = useT();
  const filters: { id: FilterCategory; label: string }[] = [
    { id: "all", label: t("cameraVar.filterAll") },
    { id: "distance", label: t("cameraVar.filterDistance") },
    { id: "angle", label: t("cameraVar.filterAngle") },
    { id: "creative", label: t("cameraVar.filterCreative") },
  ];

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflow: "auto",
        padding: "14px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      {/* Filter + quick-select row */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div style={sectionLabelStyle}>{t("cameraVar.cameraPresets")}</div>
        <div style={{ display: "flex", gap: 3 }}>
          {filters.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              style={{
                padding: "3px 10px",
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: 0.3,
                background: filter === f.id ? ACCENT_SOFT_BG : "transparent",
                border: `1px solid ${filter === f.id ? ACCENT_SOFT_BORDER : "hsl(var(--foreground) / 0.12)"}`,
                color: filter === f.id ? "hsl(var(--primary) / 0.9)" : "hsl(var(--foreground) / 0.7)",
                cursor: "pointer",
                textTransform: "uppercase",
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <QuickBtn onClick={selectRecommended} label={t("cameraVar.recommended")} />
        <QuickBtn onClick={selectAll} label={t("cameraVar.filterAll")} />
        <QuickBtn onClick={selectNone} label={t("cameraVar.none")} />
      </div>

      {/* Preset grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
          gap: 8,
        }}
      >
        {filteredPresets.map((p) => {
          const active = selected.has(p.id);
          const slot = slots[p.id];
          return (
            <button
              key={p.id}
              onClick={() => togglePreset(p.id)}
              style={{
                textAlign: "left",
                padding: "10px 12px",
                background: active ? ACCENT_SOFT_BG : "hsl(var(--foreground) / 0.03)",
                border: `1px solid ${active ? ACCENT_SOFT_BORDER : "hsl(var(--foreground) / 0.08)"}`,
                cursor: "pointer",
                display: "flex",
                flexDirection: "column",
                gap: 4,
                transition: "border-color 0.12s, background 0.12s",
                position: "relative",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 2,
                    border: `1px solid ${active ? ACCENT : "hsl(var(--foreground) / 0.3)"}`,
                    background: active ? ACCENT : "transparent",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  {active && <Check className="w-2.5 h-2.5" style={{ color: "hsl(var(--primary-foreground))" }} />}
                </span>
                <div style={{ color: "hsl(var(--foreground) / 0.95)", fontSize: 12, fontWeight: 600 }}>
                  {p.label}
                </div>
                {p.recommended && !slot && (
                  <span
                    style={{
                      fontSize: 9,
                      color: "hsl(var(--foreground) / 0.55)",
                      letterSpacing: 0.3,
                      marginLeft: "auto",
                      textTransform: "uppercase",
                    }}
                  >
                    {t("cameraVar.recommendedShort")}
                  </span>
                )}
                {slot && <PresetStatusBadge status={slot.status} />}
              </div>
              <div style={{ color: "hsl(var(--foreground) / 0.55)", fontSize: 10.5, lineHeight: 1.35 }}>
                {p.shortDesc}
              </div>
              <div
                style={{
                  marginTop: 2,
                  fontSize: 9,
                  color: "hsl(var(--foreground) / 0.35)",
                  letterSpacing: 0.5,
                  textTransform: "uppercase",
                }}
              >
                {p.category}
              </div>
            </button>
          );
        })}
      </div>

      {/* Cinematic notes */}
      <div>
        <div style={sectionLabelStyle}>
          {t("cameraVar.cinematicNotes")}
          <span
            style={{
              color: "hsl(var(--foreground) / 0.4)",
              fontWeight: 400,
              fontSize: 10.5,
              marginLeft: 6,
              textTransform: "none",
              letterSpacing: 0,
            }}
          >
            {t("cameraVar.cinematicNotesHintPresets")}
          </span>
        </div>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder={t("cameraVar.cinematicNotesPlaceholder")}
          style={{
            width: "100%",
            background: "hsl(var(--foreground) / 0.03)",
            border: "1px solid hsl(var(--foreground) / 0.1)",
            color: "hsl(var(--foreground) / 0.9)",
            padding: 10,
            fontSize: 12,
            fontFamily: "inherit",
            resize: "vertical",
            outline: "none",
          }}
        />
      </div>
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CONTACT SHEET TAB
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function ContactSheetTab({
  scene,
  subject,
  emotion,
  sourceUrl,
  generate,
  onApplied,
  onClose,
}: TabPaneProps) {
  const t = useT();
  const [session, setSession] = useState<ContactSheetSession | null>(
    () => sheetCache.get(scene.id) ?? null,
  );
  const [notes, setNotes] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [selectedTile, setSelectedTile] = useState<number | null>(null);
  const [applying, setApplying] = useState(false);

  // Persist session so accidental modal close doesn't throw away ~25s of work.
  useEffect(() => {
    if (session) sheetCache.set(scene.id, session);
  }, [scene.id, session]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !generating && !applying) onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [generating, applying, onClose]);

  const presetsForSheet = useMemo(() => contactSheetPresets(), []);

  const handleGenerate = async () => {
    if (generating) return;
    setError(null);
    setSelectedTile(null);
    setGenerating(true);
    setStartedAt(Date.now());
    try {
      const prompt = buildContactSheetPrompt({
        subject,
        presets: presetsForSheet,
        emotion,
        extraNotes: notes,
      });
      const rawUrl = await generate({
        mode: "contact_sheet",
        prompt,
        sourceImageUrl: sourceUrl,
      });
      const tiles = await splitContactSheetDataUrl(rawUrl);
      const nextSession: ContactSheetSession = {
        rawUrl,
        tiles,
        generatedAt: Date.now(),
      };
      setSession(nextSession);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setGenerating(false);
    }
  };

  const handleApplyTile = async () => {
    if (!session || selectedTile == null || applying) return;
    const tileDataUrl = session.tiles[selectedTile];
    const preset = presetsForSheet[selectedTile];
    if (!tileDataUrl || !preset) return;
    setApplying(true);
    try {
      const base64 = dataUrlToBase64(tileDataUrl);
      const publicUrl = await generate({
        mode: "save_local",
        base64,
        suffix: `sheet-${preset.id}`,
      });
      await onApplied(publicUrl, sourceUrl);
      onClose();
    } catch (e) {
      console.error("[ContactSheet] apply failed:", e);
      setError(e instanceof Error ? e.message : String(e));
      setApplying(false);
    }
  };

  const handleDiscard = () => {
    sheetCache.delete(scene.id);
    setSession(null);
    setSelectedTile(null);
    setError(null);
  };

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "grid",
        gridTemplateColumns: "minmax(260px, 320px) 1fr",
        overflow: "hidden",
      }}
    >
      <SourcePreview scene={scene} sourceUrl={sourceUrl} subject={subject} />
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            padding: "14px 20px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div>
            <div style={sectionLabelStyle}>{t("cameraVar.howThisWorks")}</div>
            <div
              style={{
                padding: "10px 12px",
                background: "hsl(var(--foreground) / 0.03)",
                border: "1px solid hsl(var(--foreground) / 0.06)",
                color: "hsl(var(--foreground) / 0.7)",
                fontSize: 11.5,
                lineHeight: 1.55,
              }}
            >
              {t("cameraVar.howThisWorksDesc")}
            </div>
          </div>

          {/* Panel-legend — tells users which preset is in which slot so they
              can aim the generate call if they want to bias a rerun via notes. */}
          <div>
            <div style={sectionLabelStyle}>{t("cameraVar.panelLayout")}</div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 4,
              }}
            >
              {presetsForSheet.map((p, i) => (
                <div
                  key={p.id}
                  style={{
                    padding: "6px 8px",
                    background: "hsl(var(--foreground) / 0.03)",
                    border: "1px solid hsl(var(--foreground) / 0.06)",
                    fontSize: 11,
                    color: "hsl(var(--foreground) / 0.82)",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <span
                    style={{
                      fontFamily: "'SF Mono', monospace",
                      color: "hsl(var(--foreground) / 0.4)",
                      fontSize: 10,
                    }}
                  >
                    {i + 1}
                  </span>
                  <span style={{ fontWeight: 600 }}>{p.label}</span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div style={sectionLabelStyle}>
              {t("cameraVar.cinematicNotes")}
              <span
                style={{
                  color: "hsl(var(--foreground) / 0.4)",
                  fontWeight: 400,
                  fontSize: 10.5,
                  marginLeft: 6,
                  textTransform: "none",
                  letterSpacing: 0,
                }}
              >
                {t("cameraVar.cinematicNotesHintSheet")}
              </span>
            </div>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder={t("cameraVar.cinematicNotesPlaceholderSheet")}
              disabled={generating}
              style={{
                width: "100%",
                background: "hsl(var(--foreground) / 0.03)",
                border: "1px solid hsl(var(--foreground) / 0.1)",
                color: "hsl(var(--foreground) / 0.9)",
                padding: 10,
                fontSize: 12,
                fontFamily: "inherit",
                resize: "vertical",
                outline: "none",
              }}
            />
          </div>

          {/* Result / in-flight surface */}
          {generating ? (
            <div
              style={{
                border: "1px solid hsl(var(--foreground) / 0.08)",
                background: "hsl(var(--foreground) / 0.02)",
                padding: 28,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 10,
                minHeight: 280,
              }}
            >
              <Loader2
                className="w-6 h-6"
                style={{ color: "hsl(var(--foreground) / 0.6)", animation: "spin 1s linear infinite" }}
              />
              <div style={{ color: "hsl(var(--foreground) / 0.75)", fontSize: 12 }}>
                {t("cameraVar.rendering")}
              </div>
              <div style={{ color: "hsl(var(--foreground) / 0.4)", fontSize: 10, letterSpacing: 0.4 }}>
                {startedAt ? t("cameraVar.sElapsed", { n: Math.round((Date.now() - startedAt) / 1000) }) : "…"} · {t("cameraVar.typically")}
              </div>
            </div>
          ) : error ? (
            <div className="rounded-none border border-destructive/60 bg-destructive/10 px-3 py-2.5 text-caption leading-relaxed text-destructive-foreground">
              {error}
            </div>
          ) : session ? (
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 8,
                }}
              >
                <div style={sectionLabelStyle}>{t("cameraVar.pickTile")}</div>
                <div style={{ flex: 1 }} />
                <button
                  onClick={handleDiscard}
                  disabled={applying}
                  style={{
                    padding: "3px 8px",
                    fontSize: 10.5,
                    background: "transparent",
                    border: "1px solid hsl(var(--foreground) / 0.12)",
                    color: "hsl(var(--foreground) / 0.7)",
                    cursor: applying ? "not-allowed" : "pointer",
                  }}
                  title={t("cameraVar.discardSheetTitle")}
                >
                  {t("cameraVar.discard")}
                </button>
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3, 1fr)",
                  gap: 6,
                }}
              >
                {session.tiles.map((tile, i) => {
                  const active = selectedTile === i;
                  const preset = presetsForSheet[i];
                  return (
                    <button
                      key={i}
                      onClick={() => setSelectedTile(i)}
                      disabled={applying}
                      style={{
                        position: "relative",
                        padding: 0,
                        background: "hsl(var(--background))",
                        border: `2px solid ${active ? ACCENT : "hsl(var(--foreground) / 0.08)"}`,
                        cursor: applying ? "not-allowed" : "pointer",
                        overflow: "hidden",
                        aspectRatio: "1 / 1",
                        transition: "border-color 120ms ease",
                      }}
                    >
                      <img
                        src={tile}
                        alt={preset?.label ?? t("cameraVar.panelN", { n: i + 1 })}
                        style={{
                          width: "100%",
                          height: "100%",
                          objectFit: "cover",
                          display: "block",
                          pointerEvents: "none",
                        }}
                      />
                      <div
                        style={{
                          position: "absolute",
                          top: 4,
                          left: 4,
                          fontSize: 9,
                          padding: "1px 5px",
                          background: active ? ACCENT : "rgba(0,0,0,0.6)",
                          color: "hsl(var(--primary-foreground))",
                          fontWeight: 700,
                          letterSpacing: 0.4,
                          textTransform: "uppercase",
                        }}
                      >
                        {i + 1} · {preset?.label}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div
              style={{
                border: "1px dashed hsl(var(--foreground) / 0.12)",
                padding: 28,
                textAlign: "center",
                color: "hsl(var(--foreground) / 0.55)",
                fontSize: 12,
                lineHeight: 1.55,
              }}
            >
              {t("cameraVar.pressGenerateHint")}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={FOOTER_STYLE}>
          {session && selectedTile != null && presetsForSheet[selectedTile] && (
            <div
              style={{
                fontSize: 11,
                color: "hsl(var(--foreground) / 0.6)",
                marginRight: "auto",
              }}
            >
              {t("cameraVar.selected")} <b style={{ color: "hsl(var(--primary) / 0.9)" }}>{presetsForSheet[selectedTile].label}</b>
            </div>
          )}
          <button
            onClick={handleGenerate}
            disabled={generating || applying}
            style={{
              background: generating ? "rgba(220,38,38,0.25)" : ACCENT,
              color: "hsl(var(--primary-foreground))",
              border: "none",
              padding: "8px 14px",
              fontSize: 12,
              fontWeight: 600,
              cursor: generating || applying ? "not-allowed" : "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            {generating && <Loader2 className="w-3 h-3 animate-spin" />}
            {session ? t("cameraVar.regenerateSheet") : t("cameraVar.generateSheet")}
          </button>
          {session && (
            <button
              onClick={handleApplyTile}
              disabled={selectedTile == null || applying || generating}
              style={{
                background:
                  selectedTile == null || applying || generating
                    ? "rgba(16,185,129,0.2)"
                    : "#10b981",
                color:
                  selectedTile == null || applying || generating
                    ? "hsl(var(--foreground) / 0.5)"
                    : "hsl(var(--primary-foreground))",
                border: "none",
                padding: "8px 14px",
                fontSize: 12,
                fontWeight: 600,
                cursor:
                  selectedTile == null || applying || generating ? "not-allowed" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
              title={
                selectedTile == null
                  ? t("cameraVar.clickTileFirst")
                  : t("cameraVar.replaceWithTile")
              }
            >
              {applying ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
              {t("cameraVar.applyTile")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Shared subpanels & atoms
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function SourcePreview({
  scene,
  sourceUrl,
  subject,
}: {
  scene: Scene;
  sourceUrl: string;
  subject: string;
}) {
  const t = useT();
  return (
    <div
      style={{
        borderRight: "1px solid hsl(var(--foreground) / 0.06)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        background: "hsl(var(--background))",
      }}
    >
      <div
        style={{
          padding: 14,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "hsl(var(--background))",
          borderBottom: "1px solid hsl(var(--foreground) / 0.06)",
        }}
      >
        <img
          src={sourceUrl}
          alt={t("cameraVar.shotAlt", { n: String(scene.scene_number).padStart(2, "0") })}
          style={{
            maxWidth: "100%",
            maxHeight: 220,
            objectFit: "contain",
            display: "block",
          }}
        />
      </div>
      <div
        style={{
          padding: "12px 14px",
          overflow: "auto",
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div>
          <div style={miniLabelStyle}>{t("cameraVar.shotDescription")}</div>
          <div style={{ color: "hsl(var(--foreground) / 0.82)", fontSize: 12, lineHeight: 1.5 }}>
            {scene.description || <span style={{ opacity: 0.5 }}>{t("cameraVar.noDescription")}</span>}
          </div>
        </div>
        {subject && (
          <div>
            <div style={miniLabelStyle}>{t("cameraVar.identityAnchor")}</div>
            <div style={{ color: "hsl(var(--foreground) / 0.72)", fontSize: 11, lineHeight: 1.5 }}>
              {subject}
            </div>
          </div>
        )}
        {(scene.location || scene.mood) && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "auto 1fr",
              columnGap: 8,
              rowGap: 4,
              fontSize: 11,
            }}
          >
            {scene.location && (
              <>
                <div style={{ color: "hsl(var(--foreground) / 0.45)" }}>{t("cameraVar.location")}</div>
                <div style={{ color: "hsl(var(--foreground) / 0.8)" }}>{scene.location}</div>
              </>
            )}
            {scene.mood && (
              <>
                <div style={{ color: "hsl(var(--foreground) / 0.45)" }}>{t("cameraVar.mood")}</div>
                <div style={{ color: "hsl(var(--foreground) / 0.8)" }}>{scene.mood}</div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PresetStatusBadge({ status }: { status: SlotStatus }) {
  const t = useT();
  const cfg = {
    queued: { label: t("cameraVar.queued"), color: "hsl(var(--foreground) / 0.55)", bg: "hsl(var(--foreground) / 0.08)" },
    generating: { label: "…", color: "hsl(var(--foreground) / 0.7)", bg: "hsl(var(--foreground) / 0.08)" },
    success: { label: t("cameraVar.generated"), color: "rgba(110, 231, 183, 0.95)", bg: "rgba(16, 185, 129, 0.15)" },
    error: { label: t("cameraVar.failed"), color: "rgba(252, 165, 165, 0.95)", bg: "rgba(239, 68, 68, 0.18)" },
  }[status];
  return (
    <span
      style={{
        fontSize: 9,
        color: cfg.color,
        background: cfg.bg,
        padding: "1px 6px",
        letterSpacing: 0.3,
        marginLeft: "auto",
        textTransform: "uppercase",
        fontWeight: 600,
      }}
    >
      {cfg.label}
    </span>
  );
}

function useElapsedTicker(active: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return tick;
}

const formatElapsed = (ms: number): string => {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${s.toString().padStart(2, "0")}s`;
};

/* ━━━ Results subpanel (Presets tab) ━━━ */
function ResultsPanel({
  slots,
  applyingFromUrl,
  onApplyResult,
  onReroll,
  onDiscard,
}: {
  slots: Record<string, VariationSlot>;
  applyingFromUrl: string | null;
  onApplyResult: (url: string) => void;
  onReroll: (presetId: string) => void;
  onDiscard: (presetId: string) => void;
}) {
  const t = useT();
  const ordered = CAMERA_PRESETS.filter((p) => slots[p.id]);
  const anyRunning = ordered.some(
    (p) => slots[p.id]?.status === "generating" || slots[p.id]?.status === "queued",
  );
  useElapsedTicker(anyRunning);

  if (ordered.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "hsl(var(--foreground) / 0.5)",
          fontSize: 12,
        }}
      >
        {t("cameraVar.allDiscarded")}
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflow: "auto",
        padding: 16,
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
        gap: 12,
        alignContent: "start",
      }}
    >
      {ordered.map((preset) => {
        const slot = slots[preset.id]!;
        return (
          <ResultCard
            key={preset.id}
            preset={preset}
            slot={slot}
            disabled={!!applyingFromUrl}
            applying={applyingFromUrl !== null && applyingFromUrl === slot.url}
            onApply={() => slot.url && onApplyResult(slot.url)}
            onReroll={() => onReroll(preset.id)}
            onDiscard={() => onDiscard(preset.id)}
          />
        );
      })}
    </div>
  );
}

function ResultCard({
  preset,
  slot,
  disabled,
  applying,
  onApply,
  onReroll,
  onDiscard,
}: {
  preset: CameraPreset;
  slot: VariationSlot;
  disabled: boolean;
  applying: boolean;
  onApply: () => void;
  onReroll: () => void;
  onDiscard: () => void;
}) {
  const t = useT();
  return (
    <div
      style={{
        background: "hsl(var(--foreground) / 0.03)",
        border: "1px solid hsl(var(--foreground) / 0.08)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <div
        style={{
          padding: "8px 10px",
          fontSize: 11,
          fontWeight: 600,
          color: "hsl(var(--foreground) / 0.9)",
          display: "flex",
          alignItems: "center",
          gap: 6,
          borderBottom: "1px solid hsl(var(--foreground) / 0.05)",
          minWidth: 0,
        }}
      >
        <span
          title={preset.label}
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {preset.label}
        </span>
        <span
          style={{
            flexShrink: 0,
            fontSize: 10,
            color: "hsl(var(--foreground) / 0.4)",
            whiteSpace: "nowrap",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {slot.status === "queued" && t("cameraVar.queued")}
          {slot.status === "generating" &&
            (slot.startedAt ? formatElapsed(Date.now() - slot.startedAt) : "…")}
          {slot.status === "success" && (slot.durationMs ? formatElapsed(slot.durationMs) : t("cameraVar.ready"))}
          {slot.status === "error" && t("cameraVar.failed")}
        </span>
      </div>
      <div
        style={{
          aspectRatio: "1 / 1",
          background: "hsl(var(--background))",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {slot.status === "success" && slot.url ? (
          <img
            src={slot.url}
            alt={preset.label}
            style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
          />
        ) : slot.status === "error" ? (
          <div
            style={{
              color: "rgba(255,120,120,0.9)",
              fontSize: 11,
              padding: 14,
              textAlign: "center",
              lineHeight: 1.4,
            }}
          >
            {slot.error ?? t("cameraVar.unknownError")}
          </div>
        ) : (
          <Loader2
            className="w-5 h-5"
            style={{
              color: "hsl(var(--foreground) / 0.5)",
              animation: "spin 1s linear infinite",
            }}
          />
        )}
      </div>
      <div
        style={{
          display: "flex",
          gap: 4,
          padding: 6,
          borderTop: "1px solid hsl(var(--foreground) / 0.05)",
        }}
      >
        <button
          onClick={onApply}
          disabled={disabled || slot.status !== "success"}
          style={{
            flex: 1,
            padding: "6px 8px",
            fontSize: 11,
            fontWeight: 600,
            background: slot.status === "success" && !disabled ? ACCENT : "rgba(220,38,38,0.2)",
            color: slot.status === "success" && !disabled ? "hsl(var(--primary-foreground))" : "hsl(var(--foreground) / 0.4)",
            border: "none",
            cursor: slot.status === "success" && !disabled ? "pointer" : "not-allowed",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 4,
          }}
          title={t("cameraVar.replaceWithVariation")}
        >
          {applying ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
          {t("cameraVar.apply")}
        </button>
        <IconBtn
          title={t("cameraVar.generateAgain")}
          onClick={onReroll}
          disabled={disabled || slot.status === "generating" || slot.status === "queued"}
        >
          <RotateCcw className="w-3 h-3" />
        </IconBtn>
        <IconBtn
          title={t("cameraVar.remove")}
          onClick={onDiscard}
          disabled={disabled || slot.status === "generating"}
        >
          <Trash2 className="w-3 h-3" />
        </IconBtn>
      </div>
    </div>
  );
}

/* ━━━ atoms ━━━ */
function TabBtn({
  active,
  onClick,
  icon,
  label,
  blurb,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  blurb: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "10px 16px",
        background: active ? "hsl(var(--card))" : "transparent",
        border: "none",
        borderBottom: `2px solid ${active ? ACCENT : "transparent"}`,
        color: active ? "hsl(var(--foreground) / 0.95)" : "hsl(var(--foreground) / 0.6)",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontFamily: "inherit",
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: 0.2,
        marginBottom: -1,
      }}
    >
      <span style={{ display: "flex", color: active ? "hsl(var(--primary) / 0.9)" : "hsl(var(--foreground) / 0.5)" }}>
        {icon}
      </span>
      {label}
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="button"
            aria-label="help"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center justify-center text-muted-foreground/60 hover:text-foreground/80 transition-colors ml-0.5"
          >
            <HelpCircle className="w-3 h-3" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[280px] text-xs leading-relaxed">
          {blurb}
        </TooltipContent>
      </Tooltip>
    </button>
  );
}

function EmotionChipBtn({
  chip,
  active,
  onClick,
}: {
  chip: EmotionChip;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "3px 10px",
        fontSize: 10.5,
        letterSpacing: 0.2,
        background: active ? ACCENT_SOFT_BG : "transparent",
        border: `1px solid ${active ? ACCENT_SOFT_BORDER : "hsl(var(--foreground) / 0.12)"}`,
        color: active ? "hsl(var(--primary) / 0.9)" : "hsl(var(--foreground) / 0.7)",
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      {chip.label}
    </button>
  );
}

function QuickBtn({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "transparent",
        border: "1px solid hsl(var(--foreground) / 0.12)",
        color: "hsl(var(--foreground) / 0.7)",
        padding: "3px 8px",
        fontSize: 10.5,
        cursor: "pointer",
        letterSpacing: 0.2,
      }}
    >
      {label}
    </button>
  );
}

function IconBtn({
  onClick,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        width: 28,
        padding: 0,
        background: "hsl(var(--foreground) / 0.04)",
        border: "1px solid hsl(var(--foreground) / 0.1)",
        color: disabled ? "hsl(var(--foreground) / 0.25)" : "hsl(var(--foreground) / 0.75)",
        cursor: disabled ? "not-allowed" : "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {children}
    </button>
  );
}

function backBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    background: "transparent",
    border: "1px solid hsl(var(--foreground) / 0.14)",
    color: "hsl(var(--foreground) / 0.8)",
    padding: "6px 10px",
    fontSize: 12,
    cursor: disabled ? "not-allowed" : "pointer",
    marginRight: "auto",
  };
}

const sectionLabelStyle: React.CSSProperties = {
  color: "hsl(var(--foreground) / 0.85)",
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  marginBottom: 6,
};

const miniLabelStyle: React.CSSProperties = {
  color: "hsl(var(--foreground) / 0.5)",
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: 0.6,
  textTransform: "uppercase",
  marginBottom: 4,
};

/* ━━━ status summaries ━━━ */
type Translator = (key: string, vars?: Record<string, string | number>) => string;

function summarizeSlots(slots: Record<string, VariationSlot>, t: Translator): string {
  const vals = Object.values(slots);
  if (vals.length === 0) return t("cameraVar.noVariations");
  const done = vals.filter((s) => s.status === "success").length;
  const failed = vals.filter((s) => s.status === "error").length;
  const active = vals.filter((s) => s.status === "generating" || s.status === "queued").length;
  const parts: string[] = [];
  if (active > 0) parts.push(t("cameraVar.nInProgress", { n: active }));
  if (done > 0) parts.push(t("cameraVar.nReady", { n: done }));
  if (failed > 0) parts.push(t("cameraVar.nFailed", { n: failed }));
  return parts.join(" · ");
}

function summarizeSetup(
  selected: Set<string>,
  slots: Record<string, VariationSlot>,
  toGenerateCount: number,
  t: Translator,
): string {
  if (selected.size === 0) return t("cameraVar.pickAtLeastOnePreset");
  const alreadyDone = Array.from(selected).filter((id) => slots[id]?.status === "success").length;
  if (toGenerateCount === 0 && alreadyDone > 0) {
    return t("cameraVar.allDoneInSelection", { n: alreadyDone });
  }
  const pieces: string[] = [
    t("cameraVar.willGenerate", { n: toGenerateCount, s: toGenerateCount === 1 ? "" : "s" }),
  ];
  if (alreadyDone > 0) pieces.push(t("cameraVar.alreadyDone", { n: alreadyDone }));
  return pieces.join(" · ");
}
