import { useEffect, useMemo, useRef, useState } from "react";
import { Film, Image as ImageIcon, Link2, MessageSquare, Youtube } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { resolveTypeLabel } from "./linkPlatform";
import type { ReferenceItem, ReferenceKind } from "./types";

/* Viewer 의 간소화 그리드.
 *
 * 메인 앱 LibraryGrid 의 justified-rows 알고리즘과 동일한 시각 결과를
 * 노리지만, 다음을 의도적으로 빼서 단순화한다:
 *   - 멀티 선택 / 드래그 / 마키 / 리오더
 *   - 컨텍스트 메뉴
 *   - 사이즈 슬라이더 (목표 행 높이 고정 180px)
 *
 * 클릭/더블클릭은 분리:
 *   - 싱글 클릭 → onSelect (우측 사이드바 인스펙터 활성)
 *   - 더블 클릭 → onOpen (이미지/영상은 큰 화면 모달, link/youtube 는 외부 브라우저)
 *
 * 키보드 포커스 보장 — Tab 으로 카드 이동, Enter/Space 로 onOpen. */

const TARGET_ROW_HEIGHT = 180;
const GRID_GAP = 8;
const LABEL_HEIGHT = 22;

interface ViewerGridProps {
  items: ReferenceItem[];
  selectedId: string | null;
  onSelect: (item: ReferenceItem) => void;
  onOpen: (item: ReferenceItem) => void;
}

export function ViewerGrid({ items, selectedId, onSelect, onOpen }: ViewerGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rows = useMemo(() => layoutJustifiedRows(items, width), [items, width]);

  return (
    <div ref={containerRef} className="p-4">
      <div className="flex flex-col" style={{ gap: GRID_GAP }}>
        {rows.map((row, rowIdx) => (
          <div key={rowIdx} className="flex" style={{ gap: GRID_GAP }}>
            {row.cards.map(({ item, width: cardW, height: cardH }) => (
              <Card
                key={item.id}
                item={item}
                width={cardW}
                height={cardH}
                isSelected={selectedId === item.id}
                onSelect={() => onSelect(item)}
                onOpen={() => onOpen(item)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

interface CardProps {
  item: ReferenceItem;
  /** 카드 가로 (px). 자연 비율로 행 안에서 균형 잡힌 값. */
  width: number;
  /** 썸네일 영역 세로 (px). 라벨 높이는 별도. */
  height: number;
  isSelected: boolean;
  onSelect: () => void;
  onOpen: () => void;
}

function Card({ item, width, height, isSelected, onSelect, onOpen }: CardProps) {
  const noteCount = item.timestamp_notes?.length ?? 0;
  const isMediaLike = item.kind === "video" || item.kind === "gif";
  const showDurationBadge = isMediaLike && (item.duration_sec ?? 0) > 0;
  return (
    <button
      type="button"
      onClick={onSelect}
      onDoubleClick={onOpen}
      className={cn(
        "group relative flex flex-col overflow-hidden border bg-card text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        isSelected ? "border-primary" : "border-border-subtle hover:border-primary/40",
      )}
      style={{ width, borderRadius: 0 }}
      title={item.title}
    >
      <div
        className="relative flex items-center justify-center overflow-hidden bg-muted/30"
        style={{ width, height }}
      >
        <Thumbnail item={item} />

        {/* 좌상단 type 라벨 — 메인 앱 LibraryGrid 의 Badge variant="secondary"
            패턴을 그대로 사용. Behance/Pinterest/YouTube 등 source_url 기반
            라벨이 들어가도록 resolveTypeLabel 거침. */}
        <div className="pointer-events-none absolute left-2 top-2 flex flex-col items-start gap-1">
          <Badge className="h-5 px-1.5 text-micro" variant="secondary">
            {resolveTypeLabel(item)}
          </Badge>
        </div>

        {/* 우상단 노트 카운트 — primary tint, MessageSquare 아이콘. */}
        {noteCount > 0 ? (
          <div className="pointer-events-none absolute right-2 top-2 flex items-end gap-1">
            <Badge
              className="h-5 bg-primary/85 px-1 text-micro text-primary-foreground"
              title={`${noteCount} note${noteCount === 1 ? "" : "s"}`}
            >
              <MessageSquare className="mr-0.5 h-3 w-3" />
              {noteCount}
            </Badge>
          </div>
        ) : null}

        {/* 우하단 duration — 메인 앱과 동일한 검은 반투명 라벨. */}
        {showDurationBadge ? (
          <span className="pointer-events-none absolute bottom-2 right-2 bg-black/70 px-1.5 py-0.5 font-mono text-2xs text-white">
            {formatDuration(item.duration_sec ?? 0)}
          </span>
        ) : null}
      </div>
      <div
        className="truncate px-1.5 py-1 text-caption text-foreground/85"
        style={{ height: LABEL_HEIGHT }}
      >
        {item.title}
      </div>
    </button>
  );
}

function Thumbnail({ item }: { item: ReferenceItem }) {
  const src = item.thumbnail_url || item.file_url || null;
  if (!src) {
    return <FallbackIcon kind={item.kind} />;
  }
  if (item.kind === "video") {
    if (!item.thumbnail_url) return <FallbackIcon kind={item.kind} />;
    return (
      <img
        src={item.thumbnail_url}
        alt={item.title}
        className="h-full w-full object-cover"
        loading="lazy"
        decoding="async"
        draggable={false}
      />
    );
  }
  return (
    <img
      src={src}
      alt={item.title}
      className="h-full w-full object-cover"
      loading="lazy"
      decoding="async"
      draggable={false}
    />
  );
}

function FallbackIcon({ kind }: { kind: ReferenceKind }) {
  const Icon = kind === "youtube" ? Youtube : kind === "link" ? Link2 : kind === "video" ? Film : ImageIcon;
  return <Icon className="h-10 w-10 text-white/15" />;
}

function formatDuration(value: number): string {
  if (!Number.isFinite(value)) return "00:00";
  const total = Math.max(0, Math.floor(value));
  const minutes = Math.floor(total / 60).toString().padStart(2, "0");
  const seconds = (total % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

/* ── Justified row layout ──────────────────────────────────────────────────
 * 항목들의 자연 비율(width/height) 로 한 행에 가능한 만큼 채우고, 행 마지막
 * 직전까지 누적 가로가 컨테이너에 맞도록 비율 스케일링. 마지막 행만 자연
 * 크기로 둬서 외로운 카드가 컨테이너 폭을 통째로 차지하지 않게 한다. */
interface Card {
  item: ReferenceItem;
  width: number;
  height: number;
}
interface Row {
  cards: Card[];
  height: number;
}

function aspectOf(item: ReferenceItem): number {
  if (item.width && item.height && item.width > 0 && item.height > 0) {
    const ratio = item.width / item.height;
    return Math.max(0.3, Math.min(4, ratio));
  }
  if (item.kind === "image" || item.kind === "webp" || item.kind === "gif") return 4 / 3;
  return 16 / 9;
}

function layoutJustifiedRows(items: ReferenceItem[], containerWidth: number): Row[] {
  if (containerWidth <= 0 || items.length === 0) return [];
  const targetH = TARGET_ROW_HEIGHT;
  const rows: Row[] = [];

  let buf: Array<{ item: ReferenceItem; aspect: number }> = [];

  const flush = (lastRow: boolean) => {
    if (buf.length === 0) return;
    const aspectsSum = buf.reduce((acc, b) => acc + b.aspect, 0);
    const naturalRowWidth = targetH * aspectsSum + GRID_GAP * (buf.length - 1);
    const scale = lastRow
      ? Math.min(1, containerWidth / naturalRowWidth)
      : containerWidth / naturalRowWidth;
    const rowH = Math.max(80, Math.round(targetH * scale));
    const cards: Card[] = buf.map(({ item, aspect }) => ({
      item,
      width: Math.round(rowH * aspect),
      height: rowH,
    }));
    rows.push({ cards, height: rowH });
    buf = [];
  };

  for (const item of items) {
    const aspect = aspectOf(item);
    const pendingNaturalWidth =
      targetH * (buf.reduce((s, b) => s + b.aspect, 0) + aspect) + GRID_GAP * buf.length;
    buf.push({ item, aspect });
    if (pendingNaturalWidth > containerWidth * 1.05) {
      flush(false);
    }
  }
  flush(true);

  return rows;
}
