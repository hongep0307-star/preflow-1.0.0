import { useMemo, useState } from "react";
import { Check, Download, ExternalLink, Film, Image as ImageIcon, Link2, Maximize2, Youtube } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { resolveTypeLabel } from "./linkPlatform";
import { vt, type ViewerLang } from "./i18n";
import type { ReferenceItem, ReferenceAiSuggestions, TimestampNote } from "./types";

/* Viewer 인스펙터 패널 — 메인 앱 LibraryInspector 의 read-only 사본.
 *
 * 책임:
 *   - 그리드에서 카드 싱글 클릭 시 노출되는 우측 사이드바
 *   - 프리뷰 + 메타 + 태그 + AI 분석 + 노트 표시 (편집 일체 없음)
 *   - 더 보기 버튼 → 큰 화면 모달(혹은 외부 링크) 열기 진입점
 *
 * 메인 앱 인스펙터의 편집 UI (입력란, 저장/삭제 버튼, AI 재분석) 는
 * viewer 의 read-only 정책상 모두 제거. 노출 데이터의 모양은 동일하게
 * 유지해 사용자 경험이 메인 앱과 끊김 없이 이어진다. */

interface ViewerInspectorProps {
  item: ReferenceItem;
  /** "Open large" 버튼 / 썸네일 클릭 시 호출 — App 이 모달/외부 URL 분기. */
  onOpen: () => void;
  /** AI 분석 표시 언어 — App 의 언어 토글이 구동. */
  language: "ko" | "en";
}

export function ViewerInspector({ item, onOpen, language }: ViewerInspectorProps) {
  /* swatch 클릭 → 색상 코드 클립보드 복사(메인 앱과 동일). 방금 복사한 색은
   *  잠깐 체크 표시로 피드백. */
  const [copiedColor, setCopiedColor] = useState<string | null>(null);
  /* AI 분석의 KO/EN 필드 선택 — App 의 언어 토글(localStorage / export
   *  source_language / navigator 기본값)에서 내려온 language prop 을 따른다. */
  const preferKo = language === "ko";

  /* tags 중 folder: prefix 가 붙은 가상 폴더 태그는 제외하고, 사용자가 직접
   *  남긴 라벨만 표시. 메인 앱과 동일 정책. */
  const visibleTags = useMemo(
    () => (item.tags ?? []).filter((tag) => !tag.startsWith("folder:")),
    [item.tags],
  );

  // ratio(면적 비중) 내림차순 표시 — extract-colors 의 power 정렬은 작은
  // 액센트색이 dominant 색보다 앞에 와서 시각 직관과 어긋남. 메인 앱
  // 인스펙터와 동일한 정책으로 표시 시점에만 정렬, raw 데이터는 보존.
  const palette = useMemo(() => {
    const raw = item.color_palette ?? [];
    return [...raw].sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0));
  }, [item.color_palette]);
  const ai = item.ai_suggestions ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex-1 overflow-y-auto p-4">
        <PreviewBlock item={item} onOpen={onOpen} language={language} />

        {palette.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
            {palette.slice(0, 8).map((swatch, idx) => {
              const copied =
                copiedColor !== null && copiedColor.toLowerCase() === swatch.color.toLowerCase();
              return (
                <button
                  key={`${swatch.color}-${idx}`}
                  type="button"
                  /* 이중 윤곽 — 메인 앱 인스펙터와 동일 패턴. 외곽선
                     border-border 가 밝은 swatch 와 패널 배경 분리를,
                     내부 ring-white/20 가 검정/짙은 swatch 와 dark 배경
                     분리를 담당. */
                  className="relative flex h-5 w-5 items-center justify-center border border-border shadow-sm ring-1 ring-inset ring-white/20 transition-transform hover:scale-110"
                  style={{ backgroundColor: swatch.color, borderRadius: 0 }}
                  title={`${swatch.color} — ${vt(language, copied ? "colorCopied" : "copyColor")}`}
                  onClick={() => {
                    if (typeof navigator === "undefined" || !navigator.clipboard) return;
                    navigator.clipboard
                      .writeText(swatch.color)
                      .then(() => {
                        setCopiedColor(swatch.color);
                        window.setTimeout(
                          () => setCopiedColor((c) => (c === swatch.color ? null : c)),
                          1200,
                        );
                      })
                      .catch(() => {});
                  }}
                >
                  {copied ? (
                    <Check className="h-3 w-3 text-white [filter:drop-shadow(0_0_1px_rgba(0,0,0,0.8))]" />
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}

        <div className="mt-4">
          <Badge variant="secondary" className="mb-2 text-2xs font-medium">
            {resolveTypeLabel(item)}
          </Badge>
          <div className="text-label font-semibold leading-snug">{item.title || "—"}</div>
        </div>

        <DownloadButton item={item} language={language} />

        {item.notes ? (
          <div className="mt-4 border-t border-border-subtle/60 pt-3 text-meta whitespace-pre-wrap text-foreground/85">
            {item.notes}
          </div>
        ) : null}

        {item.source_url ? (
          <div className="mt-3 flex items-center gap-2 border-t border-border-subtle/60 pt-3">
            <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1 truncate text-meta" title={item.source_url}>
              {item.source_url}
            </div>
            <a
              href={item.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-primary"
              title={vt(language, "openInBrowser")}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        ) : null}

        {visibleTags.length > 0 ? (
          <div className="mt-5 border-t border-border-subtle/60 pt-4">
            <SectionLabel>{vt(language, "tags")}</SectionLabel>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {visibleTags.map((tag) => (
                <Badge key={tag} variant="outline" className="text-caption">
                  {tag}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}

        {ai ? <AiSection ai={ai} preferKo={preferKo} language={language} /> : null}

        <PropertiesGrid item={item} language={language} />

        {item.timestamp_notes && item.timestamp_notes.length > 0 ? (
          <NotesList notes={item.timestamp_notes} kind={item.kind} language={language} />
        ) : null}
      </div>
    </div>
  );
}

/* ── 프리뷰 블록 ─────────────────────────────────────────────
 *
 * 사이드바 상단의 *작은* 프리뷰 — 그리드 카드와 동일한 썸네일을 그대로
 * 보여주고, 우상단 Maximize 버튼으로 큰 화면(모달/외부 URL) 진입.
 * GIF/영상의 자동 재생은 사이드바에서는 잡음이 많아 정지된 첫 프레임만
 * 노출. */
function PreviewBlock({ item, onOpen, language }: { item: ReferenceItem; onOpen: () => void; language: ViewerLang }) {
  const src = item.thumbnail_url || item.file_url || null;
  const aspect =
    item.width && item.height && item.width > 0 && item.height > 0
      ? Math.max(0.3, Math.min(4, item.width / item.height))
      : item.kind === "video" || item.kind === "youtube"
        ? 16 / 9
        : 4 / 3;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onOpen}
        className="group/preview relative block w-full overflow-hidden border border-border-subtle bg-muted/30 transition-colors hover:border-primary/40"
        style={{ borderRadius: 0, aspectRatio: `${aspect}` }}
        title={vt(language, "openLarge")}
      >
        {src && item.kind !== "youtube" && item.kind !== "link" ? (
          <img
            src={src}
            alt={item.title}
            className="absolute inset-0 h-full w-full object-contain"
            draggable={false}
          />
        ) : (
          <PreviewFallback item={item} />
        )}
        <div className="pointer-events-none absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center bg-black/60 text-white opacity-0 transition-opacity group-hover/preview:opacity-100">
          <Maximize2 className="h-3 w-3" />
        </div>
      </button>
    </div>
  );
}

/* 원본 다운로드 — single-html 은 file_url 이 data: URI, ZIP 은 상대경로라
 *  두 경우 모두 <a download> 으로 받을 수 있다. youtube/link 는 원본 파일이
 *  없으므로 (source_url 외부 링크는 아래 별도 표시) 버튼을 숨긴다. */
function downloadFilename(item: ReferenceItem): string {
  const MIME_EXT: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/avif": ".avif",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
  };
  const fromUrl = (item.file_url ?? "").match(/\.([a-z0-9]{1,5})(?:[?#]|$)/i);
  const ext = (fromUrl ? `.${fromUrl[1]}` : "") || MIME_EXT[item.mime_type ?? ""] || "";
  const base = (item.title || item.id || "download")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .slice(0, 80);
  return ext && !base.toLowerCase().endsWith(ext) ? `${base}${ext}` : base;
}

function DownloadButton({ item, language }: { item: ReferenceItem; language: ViewerLang }) {
  if (!item.file_url || item.kind === "youtube" || item.kind === "link") return null;
  /* single-html(=data: URI) 은 <a download> 으로 실제 다운로드가 되지만, ZIP
   *  (=상대경로) 은 file:// 에서 download 속성이 무시돼 그냥 열린다. 그래서
   *  스킴에 따라 동작/라벨을 바꾼다: data → 다운로드, 상대경로 → 원본 파일 열기. */
  const isData = item.file_url.startsWith("data:");
  const label = vt(language, isData ? "download" : "openOriginal");
  const Icon = isData ? Download : ExternalLink;
  return (
    <a
      href={item.file_url}
      {...(isData
        ? { download: downloadFilename(item) }
        : { target: "_blank", rel: "noopener noreferrer" })}
      className="mt-3 inline-flex h-8 items-center gap-1.5 border border-primary bg-primary/10 px-2.5 text-caption font-medium text-primary transition-colors hover:bg-primary/20"
      style={{ borderRadius: 0 }}
      title={label}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </a>
  );
}

function PreviewFallback({ item }: { item: ReferenceItem }) {
  const Icon = item.kind === "youtube" ? Youtube : item.kind === "link" ? Link2 : item.kind === "video" ? Film : ImageIcon;
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80 text-white/80">
      <Icon className="h-10 w-10" />
      {item.source_url ? (
        <div className="max-w-[80%] truncate px-2 text-center text-caption text-white/60">
          {item.source_url}
        </div>
      ) : null}
    </div>
  );
}

/* ── AI 분석 섹션 ─────────────────────────────────────────────
 *
 * 메인 앱 LibraryInspector 의 ai 탭에서 read-only 영역만 추림. Accept/
 * Reanalyze 같은 mutation 액션은 viewer 에 의미 없어 제거. Mood 와 분석
 * 본문 (Style/Motion/Brief/Conti) 만 노출. */
function AiSection({ ai, preferKo, language }: { ai: ReferenceAiSuggestions; preferKo: boolean; language: ViewerLang }) {
  const pickArr = (en?: string[], ko?: string[]): string[] => {
    if (preferKo) return ko && ko.length > 0 ? ko : en ?? [];
    return en && en.length > 0 ? en : ko ?? [];
  };
  const pickStr = (en?: string, ko?: string): string => {
    if (preferKo) return ko && ko.trim() ? ko : (en ?? "").trim();
    return en && en.trim() ? en : (ko ?? "").trim();
  };

  const suggestedTags = pickArr(ai.suggested_tags, ai.suggested_tags_ko).slice(0, 12);
  const moods = pickArr(ai.mood_labels, ai.mood_labels_ko).slice(0, 8);
  /* scene 은 객관적 관찰(Style/Motion 의 해석과 분리된 차원). LibraryInspector
     와 동일하게 항상 분석 본문 맨 위에 둔다. 라벨은 KO/EN 토글에 맞춰
     "장면" / "Scene". */
  const scene = pickStr(ai.scene_description, ai.scene_description_ko);
  const style = pickStr(ai.visual_style, ai.visual_style_ko);
  const motion = pickStr(ai.motion_notes, ai.motion_notes_ko);
  const brief = pickStr(ai.brief_fit, ai.brief_fit_ko);
  const conti = pickStr(ai.conti_use, ai.conti_use_ko);
  const blocks: { key: string; label: string; body: string }[] = [];
  if (scene) blocks.push({ key: "scene", label: vt(language, "sceneLabel"), body: scene });
  if (style) blocks.push({ key: "style", label: vt(language, "styleLabel"), body: style });
  if (motion) blocks.push({ key: "motion", label: vt(language, "motionLabel"), body: motion });
  if (brief) blocks.push({ key: "brief", label: vt(language, "briefLabel"), body: brief });
  if (conti) blocks.push({ key: "conti", label: vt(language, "contiLabel"), body: conti });

  if (suggestedTags.length === 0 && moods.length === 0 && blocks.length === 0) {
    return null;
  }
  return (
    <div className="mt-5 border-t border-border-subtle/60 pt-4">
      <SectionLabel>{vt(language, "aiAnalysis")}</SectionLabel>
      {suggestedTags.length > 0 ? (
        <div className="mt-2">
          <div className="text-2xs font-semibold tracking-wide text-muted-foreground">
            {vt(language, "suggestedTags")}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {suggestedTags.map((tag, idx) => (
              <Badge key={`s-${idx}-${tag}`} variant="outline" className="text-caption">
                {tag}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}
      {moods.length > 0 ? (
        <div className="mt-3 border-t border-border-subtle/60 pt-3">
          <div className="text-2xs font-semibold tracking-wide text-muted-foreground">
            {vt(language, "moodSection")}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {moods.map((mood, idx) => (
              <Badge key={`m-${idx}-${mood}`} variant="outline" className="text-caption">
                {mood}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}
      {blocks.length > 0 ? (
        <div className="mt-3 border-t border-border-subtle/60 pt-3">
          <div className="space-y-2.5">
            {blocks.map((block) => (
              <div key={block.key}>
                <div className="text-2xs font-semibold tracking-wide text-muted-foreground">
                  {block.label}
                </div>
                <div className="mt-1 whitespace-pre-wrap text-caption leading-relaxed text-foreground/80">
                  {block.body}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ── 속성 격자 ─────────────────────────────────────────────
 *
 * 메인 앱 Eagle 풍 Properties 격자의 viewer 사본. Rating/즐겨찾기 같은
 * 사용자별 상태는 viewer 에 의미 없으니 제거. Dimensions/Duration/Type/
 * Size/Date Created/Date Modified/Date Imported 만 표시. 정보가 없으면
 * 해당 행 자체를 숨겨 빈 자리에 "—" 가 줄지어 보이지 않도록. */
function PropertiesGrid({ item, language }: { item: ReferenceItem; language: ViewerLang }) {
  const rows: Array<{ label: string; value: string }> = [];
  if (item.width && item.height) {
    rows.push({ label: vt(language, "propDimensions"), value: `${item.width} × ${item.height}` });
  }
  if (item.kind === "video" || (item.duration_sec ?? 0) > 0) {
    rows.push({ label: vt(language, "propDuration"), value: formatDuration(item.duration_sec) });
  }
  rows.push({ label: vt(language, "propType"), value: item.mime_type || resolveTypeLabel(item) });
  if (item.file_size) {
    rows.push({ label: vt(language, "propSize"), value: formatBytes(item.file_size) });
  }
  if (item.imported_at || item.created_at) {
    rows.push({ label: vt(language, "propImported"), value: formatDateTime(item.imported_at ?? item.created_at) });
  }
  if (item.created_at) {
    rows.push({ label: vt(language, "propCreated"), value: formatDateTime(item.created_at) });
  }
  if (item.updated_at) {
    rows.push({ label: vt(language, "propModified"), value: formatDateTime(item.updated_at) });
  }
  if (rows.length === 0) return null;
  return (
    <div className="mt-5 border border-border-subtle bg-surface-panel p-3" style={{ borderRadius: 0 }}>
      <SectionLabel className="mb-3">{vt(language, "properties")}</SectionLabel>
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-caption">
        {rows.map((row) => (
          <span key={row.label} className="contents">
            <div className="text-muted-foreground">{row.label}</div>
            <div className="truncate text-right font-mono" title={row.value}>
              {row.value}
            </div>
          </span>
        ))}
      </div>
    </div>
  );
}

/* ── 타임스탬프 노트 리스트 ─────────────────────────────────────────────
 *
 * read-only 라 시각/프레임/region 표시만. 영상 자료의 시각 시크는 모달
 * 안 NotesPanel 이 책임 — 사이드바는 진입 전 미리보기 정도라 단순 텍스트
 * 리스트로 노출. */
function NotesList({ notes, kind, language }: { notes: TimestampNote[]; kind: string; language: ViewerLang }) {
  const sorted = useMemo(() => {
    return [...notes].sort((a, b) => {
      if (kind === "video" || kind === "youtube") {
        return (a.atSec ?? 0) - (b.atSec ?? 0);
      }
      if (kind === "gif") {
        return (a.frameIndex ?? 0) - (b.frameIndex ?? 0);
      }
      return 0;
    });
  }, [notes, kind]);
  return (
    <div className="mt-5 border-t border-border-subtle/60 pt-4">
      <SectionLabel className="mb-2">
        {kind === "image" || kind === "webp" ? vt(language, "regionNotes") : vt(language, "notesSection")}
      </SectionLabel>
      <div className="space-y-2">
        {sorted.map((note) => (
          <div
            key={note.id}
            className="border border-border-subtle bg-surface-panel p-2 text-caption"
            style={{ borderRadius: 0 }}
          >
            <div className="flex items-center gap-2 text-muted-foreground">
              {kind === "video" || kind === "youtube" ? (
                <span className="font-mono">{formatDuration(note.atSec)}</span>
              ) : null}
              {kind === "gif" && note.frameIndex !== undefined ? (
                <span className="font-mono">#{note.frameIndex + 1}</span>
              ) : null}
              {note.region ? (
                <Badge variant="outline" className="text-micro">
                  region
                </Badge>
              ) : null}
            </div>
            <div className="mt-1 whitespace-pre-wrap text-foreground/90">{note.text}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── helpers ────────────────────────────────────────────── */

function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "text-2xs font-semibold tracking-wide text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

function formatDuration(value?: number | null): string {
  if (!value || !Number.isFinite(value)) return "00:00";
  const total = Math.max(0, Math.floor(value));
  const minutes = Math.floor(total / 60).toString().padStart(2, "0");
  const seconds = (total % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx += 1;
  }
  const formatted = value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return `${formatted} ${units[unitIdx]}`;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}
