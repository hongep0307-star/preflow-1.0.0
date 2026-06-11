import { useMemo } from "react";
import { BoxSelect } from "lucide-react";
import { cn } from "@/lib/utils";
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
 * 의미 없어 콜백을 받지 않는다. */

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
}

export function NotesPanel({
  item,
  onSeekSec,
  onSeekFrame,
  activeAtSec,
  activeFrameIndex,
}: NotesPanelProps) {
  const sorted = useMemo(() => sortNotes(item.timestamp_notes ?? [], item.kind), [item.kind, item.timestamp_notes]);

  if (sorted.length === 0) {
    return (
      <div className="flex h-full flex-col bg-card">
        <PanelHeader kind={item.kind} count={0} />
        <div className="flex-1 px-3 py-4 text-meta text-muted-foreground/50">
          No notes.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-card">
      <PanelHeader kind={item.kind} count={sorted.length} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sorted.map((note) => (
          <NoteRow
            key={note.id}
            note={note}
            kind={item.kind}
            isActive={isActiveNote(note, item.kind, activeAtSec, activeFrameIndex)}
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
    </div>
  );
}

function PanelHeader({ kind, count }: { kind: ReferenceKind; count: number }) {
  const label =
    kind === "video" ? "Timestamp Notes" : kind === "gif" ? "Frame Notes" : "Region Notes";
  return (
    <div className="flex flex-shrink-0 items-center justify-between border-b border-border-subtle bg-surface-panel px-3 py-2">
      <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
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
}: {
  note: TimestampNote;
  kind: ReferenceKind;
  isActive: boolean;
  onClick: () => void;
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
      disabled={!clickable}
      className={cn(
        "flex w-full items-start gap-2 border-b border-border-subtle/40 px-3 py-2 text-left transition-colors",
        clickable && "hover:bg-muted/20",
        !clickable && "cursor-default",
        isActive && "bg-primary/10",
      )}
    >
      <div className="flex flex-shrink-0 flex-col items-end gap-0.5 pt-0.5" style={{ minWidth: 44 }}>
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
