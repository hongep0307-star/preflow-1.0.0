import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BoxSelect } from "lucide-react";
import { cn } from "@/lib/utils";
import { vt, type ViewerLang } from "./i18n";
import type { ReferenceItem, ReferenceKind, TimestampNote } from "./types";

/* 큰 화면 우측 노트 패널.
 *
 * 메인 앱 LibraryInspector 의 timestamp_notes 섹션을 read-only 로 옮겨온
 * 형태. 자료 종류에 따라 정렬·표시 방식이 다르다:
 *   - video : atSec 오름차순 + "MM:SS"
 *   - gif   : frameIndex 오름차순 + "#N"
 *   - image/webp : 입력 순서 유지 + region 라벨만
 *
 * 행 클릭은 자료 종류별 seek 콜백을 호출 — 영상은 `onSeekSec(noteSec)`,
 * GIF 는 `onSeekFrame(noteFrame)`. 이미지/링크/유튜브는 시각 점프가
 * 의미 없어 콜백을 받지 않는다.
 *
 * 영상 노트는 메인 앱처럼 행에 hover 하면 그 시점의 프레임 썸네일을 portal
 * 로 띄운다(좌측 우선, 공간 부족 시 우측). 행 사이 구분선 없이 spacing 만
 * 둬 메인 앱과 시각 통일. */

const HOVER_PREVIEW_WIDTH = 220;
const HOVER_PREVIEW_GAP = 12;

function formatDuration(value?: number | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return "00:00";
  const total = Math.max(0, Math.floor(value));
  const minutes = Math.floor(total / 60).toString().padStart(2, "0");
  const seconds = (total % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export interface NotesPanelProps {
  item: ReferenceItem;
  /** 영상에서만 의미 있음. NotesPanel 행 클릭 시 영상 currentTime 세팅. */
  onSeekSec?: (sec: number) => void;
  /** GIF 에서만 의미 있음. */
  onSeekFrame?: (frameIndex: number) => void;
  /** 현재 active 행 — 영상의 currentTime / GIF 의 frameIndex 와 가장 가까운
   *  노트를 시각적으로 강조. 미전달 시 강조 없음. */
  activeAtSec?: number;
  activeFrameIndex?: number;
  language: ViewerLang;
}

export function NotesPanel({
  item,
  onSeekSec,
  onSeekFrame,
  activeAtSec,
  activeFrameIndex,
  language,
}: NotesPanelProps) {
  const sorted = useMemo(() => sortNotes(item.timestamp_notes ?? [], item.kind), [item.kind, item.timestamp_notes]);

  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hoverPos, setHoverPos] = useState<{ top: number; left: number } | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement>(null);

  const canPreview = item.kind === "video" && Boolean(item.file_url);
  const hoveredNote = useMemo(
    () => sorted.find((note) => note.id === hoveredId) ?? null,
    [sorted, hoveredId],
  );

  /* 호버된 노트가 바뀌면 미리보기 video 의 currentTime 만 갱신. metadata 가
   *  아직 로드 안 됐으면 loadedmetadata 후 한 번 시크. */
  useEffect(() => {
    const v = previewVideoRef.current;
    if (!v || !hoveredNote) return;
    const target = Number.isFinite(hoveredNote.atSec) ? Number(hoveredNote.atSec) : 0;
    if (v.readyState >= 1) {
      try { v.currentTime = target; } catch { /* noop */ }
    } else {
      const onLoad = () => { try { v.currentTime = target; } catch { /* noop */ } };
      v.addEventListener("loadedmetadata", onLoad, { once: true });
      return () => v.removeEventListener("loadedmetadata", onLoad);
    }
  }, [hoveredNote]);

  const handleRowEnter = (noteId: string, event: React.MouseEvent<HTMLElement>) => {
    setHoveredId(noteId);
    if (!canPreview) return;
    const rect = event.currentTarget.getBoundingClientRect();
    /* 행의 좌측 우선, 좁으면 우측으로 폴백. 세로는 행 중심 정렬 + viewport clamp. */
    const wantLeft = rect.left - HOVER_PREVIEW_GAP - HOVER_PREVIEW_WIDTH;
    const left = wantLeft >= 8 ? wantLeft : rect.right + HOVER_PREVIEW_GAP;
    const approxHeight = (HOVER_PREVIEW_WIDTH * 9) / 16 + 22;
    let top = rect.top + rect.height / 2 - approxHeight / 2;
    top = Math.max(8, Math.min(window.innerHeight - approxHeight - 8, top));
    setHoverPos({ top, left });
  };
  const handleRowLeave = () => {
    setHoveredId(null);
    setHoverPos(null);
  };

  const previewVisible = Boolean(hoveredNote && hoverPos && canPreview);
  const portalTarget = typeof document !== "undefined" ? document.body : null;

  if (sorted.length === 0) {
    return (
      <div className="flex h-full flex-col bg-card">
        <PanelHeader kind={item.kind} count={0} language={language} />
        <div className="flex-1 px-3 py-4 text-meta text-muted-foreground/50">
          {vt(language, "noNotes")}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-card">
      <PanelHeader kind={item.kind} count={sorted.length} language={language} />
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
        {sorted.map((note) => (
          <NoteRow
            key={note.id}
            note={note}
            kind={item.kind}
            isActive={isActiveNote(note, item.kind, activeAtSec, activeFrameIndex)}
            onEnter={(event) => handleRowEnter(note.id, event)}
            onLeave={handleRowLeave}
            onClick={() => {
              if (item.kind === "video" && note.atSec !== undefined && onSeekSec) {
                onSeekSec(note.atSec);
              } else if (item.kind === "gif" && note.frameIndex !== undefined && onSeekFrame) {
                onSeekFrame(note.frameIndex);
              }
            }}
          />
        ))}
      </div>

      {/* 호버 미리보기 — viewport 좌표(fixed)로 portal. 노트가 있는 동안 상시
          마운트하고 opacity 만 토글해 첫 프레임 디코드 지연을 줄인다. */}
      {portalTarget && canPreview
        ? createPortal(
            <div
              className={cn(
                "pointer-events-none fixed z-[120] border border-border-subtle bg-background shadow-xl transition-opacity",
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
                src={item.file_url ?? undefined}
                poster={item.thumbnail_url ?? undefined}
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
    </div>
  );
}

function PanelHeader({ kind, count, language }: { kind: ReferenceKind; count: number; language: ViewerLang }) {
  const label =
    kind === "video"
      ? vt(language, "timestampNotesTitle")
      : kind === "gif"
        ? vt(language, "frameNotesTitle")
        : vt(language, "regionNotes");
  return (
    <div className="flex flex-shrink-0 items-center justify-between border-b border-border-subtle bg-surface-panel px-3 py-2">
      <span className="text-2xs font-semibold tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="font-mono text-2xs text-muted-foreground">{count}</span>
    </div>
  );
}

function NoteRow({
  note,
  kind,
  isActive,
  onClick,
  onEnter,
  onLeave,
}: {
  note: TimestampNote;
  kind: ReferenceKind;
  isActive: boolean;
  onClick: () => void;
  onEnter: (event: React.MouseEvent<HTMLElement>) => void;
  onLeave: () => void;
}) {
  const clickable = (kind === "video" && note.atSec !== undefined) || (kind === "gif" && note.frameIndex !== undefined);
  const tag = kind === "gif" && note.frameIndex !== undefined
    ? `#${note.frameIndex + 1}`
    : note.atSec !== undefined
      ? formatDuration(note.atSec)
      : null;
  return (
    <button
      type="button"
      onClick={clickable ? onClick : undefined}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      disabled={!clickable}
      className={cn(
        "flex w-full items-start gap-2 px-3 py-2 text-left transition-colors",
        clickable && "hover:bg-muted/20",
        !clickable && "cursor-default",
        isActive && "bg-primary/10",
      )}
    >
      {/* 시각/프레임 라벨 + region 인디케이터를 한 줄에 (메인 앱과 동일하게
          숫자 옆에 작은 BoxSelect). */}
      <div className="flex flex-shrink-0 items-center gap-1 pt-0.5">
        {tag ? (
          <span className="font-mono text-2xs text-primary">{tag}</span>
        ) : (
          <span className="font-mono text-2xs text-muted-foreground/50">—</span>
        )}
        {note.region ? (
          <BoxSelect className="h-3 w-3 text-muted-foreground/70" aria-label="region" />
        ) : null}
      </div>
      <p className="flex-1 text-meta leading-snug text-foreground/85">{note.text}</p>
    </button>
  );
}

function sortNotes(notes: TimestampNote[], kind: ReferenceKind): TimestampNote[] {
  if (kind === "video") {
    return [...notes].sort((a, b) => (a.atSec ?? 0) - (b.atSec ?? 0));
  }
  if (kind === "gif") {
    return [...notes].sort((a, b) => (a.frameIndex ?? a.atSec ?? 0) - (b.frameIndex ?? b.atSec ?? 0));
  }
  /* image/webp/link/youtube — 입력 순서 그대로. */
  return [...notes];
}

function isActiveNote(
  note: TimestampNote,
  kind: ReferenceKind,
  activeAtSec?: number,
  activeFrameIndex?: number,
): boolean {
  if (kind === "video" && activeAtSec !== undefined && note.atSec !== undefined) {
    return Math.abs(activeAtSec - note.atSec) < 0.25;
  }
  if (kind === "gif" && activeFrameIndex !== undefined && note.frameIndex !== undefined) {
    return activeFrameIndex === note.frameIndex;
  }
  return false;
}
