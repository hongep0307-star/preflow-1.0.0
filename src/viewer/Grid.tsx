import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Film, FileText, Image as ImageIcon, Link2, MessageSquare, Youtube } from "lucide-react";
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

const DEFAULT_TARGET_ROW_HEIGHT = 180;
const GRID_GAP = 8;
const LABEL_HEIGHT = 22;
/* hover 후 미리재생까지 지연 — 그리드를 빠르게 훑을 때 매 카드가 즉시
 *  디코드를 시작하지 않도록(특히 single-html base64 대량 디코드 방지). */
const HOVER_PLAY_DELAY_MS = 400;

interface ViewerGridProps {
  items: ReferenceItem[];
  selectedId: string | null;
  onSelect: (item: ReferenceItem) => void;
  onOpen: (item: ReferenceItem) => void;
  /** 목표 행 높이 (px). 툴바 크기 슬라이더로 구동. 기본 180. */
  targetRowHeight?: number;
}

export function ViewerGrid({
  items,
  selectedId,
  onSelect,
  onOpen,
  targetRowHeight = DEFAULT_TARGET_ROW_HEIGHT,
}: ViewerGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  /* 방향키 네비게이션 — 카드 button 들을 id 로 추적해 roving tabindex +
   *  프로그램적 focus 로 이동한다. */
  const cardRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());
  const [focusedId, setFocusedId] = useState<string | null>(null);

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

  const rows = useMemo(
    () => layoutJustifiedRows(items, width, targetRowHeight),
    [items, width, targetRowHeight],
  );

  /* 평탄 순서 + 행/열 좌표 — 방향키 이동 계산용. */
  const { order, posMap, rowIds } = useMemo(() => {
    const order: string[] = [];
    const rowIds: string[][] = [];
    const posMap = new Map<string, { row: number; col: number }>();
    rows.forEach((row, r) => {
      const ids: string[] = [];
      row.cards.forEach((card, col) => {
        order.push(card.item.id);
        posMap.set(card.item.id, { row: r, col });
        ids.push(card.item.id);
      });
      rowIds.push(ids);
    });
    return { order, posMap, rowIds };
  }, [rows]);

  /* focusedId 가 목록에서 사라지면(필터 변경 등) 첫 항목 또는 선택 항목으로 보정. */
  useEffect(() => {
    if (order.length === 0) {
      if (focusedId !== null) setFocusedId(null);
      return;
    }
    if (!focusedId || !posMap.has(focusedId)) {
      setFocusedId(selectedId && posMap.has(selectedId) ? selectedId : order[0]);
    }
  }, [order, posMap, focusedId, selectedId]);

  const moveFocus = useCallback(
    (id: string | undefined) => {
      if (!id) return;
      setFocusedId(id);
      cardRefs.current.get(id)?.focus();
      /* 인스펙터가 열려 있으면(=selectedId 존재) 포커스 이동을 따라 인스펙터도
       *  갱신한다. 닫혀 있으면 포커스만 옮기고 열지 않는다. */
      if (selectedId !== null) {
        const item = items.find((it) => it.id === id);
        if (item) onSelect(item);
      }
    },
    [items, onSelect, selectedId],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!focusedId) return;
      const pos = posMap.get(focusedId);
      if (!pos) return;
      const idx = order.indexOf(focusedId);
      switch (event.key) {
        case "ArrowRight":
          event.preventDefault();
          moveFocus(order[Math.min(order.length - 1, idx + 1)]);
          break;
        case "ArrowLeft":
          event.preventDefault();
          moveFocus(order[Math.max(0, idx - 1)]);
          break;
        case "ArrowDown": {
          event.preventDefault();
          const nextRow = rowIds[pos.row + 1];
          if (nextRow) moveFocus(nextRow[Math.min(pos.col, nextRow.length - 1)]);
          break;
        }
        case "ArrowUp": {
          event.preventDefault();
          const prevRow = rowIds[pos.row - 1];
          if (prevRow) moveFocus(prevRow[Math.min(pos.col, prevRow.length - 1)]);
          break;
        }
        case "Enter": {
          event.preventDefault();
          const item = items.find((it) => it.id === focusedId);
          if (item) onOpen(item);
          break;
        }
        default:
          break;
      }
    },
    [focusedId, posMap, order, rowIds, moveFocus, items, onOpen],
  );

  return (
    <div ref={containerRef} className="p-4" onKeyDown={handleKeyDown}>
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
                isFocused={focusedId === item.id}
                onSelect={() => onSelect(item)}
                onOpen={() => onOpen(item)}
                onFocus={() => setFocusedId(item.id)}
                registerRef={(el) => {
                  if (el) cardRefs.current.set(item.id, el);
                  else cardRefs.current.delete(item.id);
                }}
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
  /** 방향키 네비게이션의 현재 포커스 대상 — roving tabindex. */
  isFocused: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onFocus: () => void;
  registerRef: (el: HTMLButtonElement | null) => void;
}

function Card({ item, width, height, isSelected, isFocused, onSelect, onOpen, onFocus, registerRef }: CardProps) {
  const noteCount = item.timestamp_notes?.length ?? 0;
  const isMediaLike = item.kind === "video" || item.kind === "gif";
  const showDurationBadge = isMediaLike && (item.duration_sec ?? 0) > 0;

  /* hover 미리재생 — video/gif 이고 원본(file_url) 이 있을 때만. 400ms 지연
   *  타이머로 빠른 훑기에선 디코드를 시작하지 않는다. */
  const canHoverPlay = isMediaLike && Boolean(item.file_url);
  const [hoverPlay, setHoverPlay] = useState(false);
  const hoverTimerRef = useRef<number | null>(null);
  /* gif 는 이미 디코드된 <img> 라 즉시 재생해도 부담이 없어 지연 0.
   *  video 만 대량 base64 디코드 부담 때문에 400ms 지연을 유지한다. */
  const startHover = () => {
    if (!canHoverPlay) return;
    if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current);
    const delay = item.kind === "video" ? HOVER_PLAY_DELAY_MS : 0;
    if (delay === 0) {
      setHoverPlay(true);
      return;
    }
    hoverTimerRef.current = window.setTimeout(() => setHoverPlay(true), delay);
  };
  const endHover = () => {
    if (hoverTimerRef.current) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHoverPlay(false);
  };
  useEffect(
    () => () => {
      if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current);
    },
    [],
  );

  return (
    <button
      type="button"
      id={`viewer-card-${item.id}`}
      ref={registerRef}
      tabIndex={isFocused ? 0 : -1}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onFocus={onFocus}
      onMouseEnter={startHover}
      onMouseLeave={endHover}
      className={cn(
        /* 포커스(방향키 이동)/선택 모두 빨간 테두리만 — 흰색 focus ring 은 쓰지
         *  않는다(빨강 아웃라인만 원함). */
        "group relative flex flex-col overflow-hidden border bg-card text-left transition-colors focus:outline-none",
        isSelected || isFocused
          ? "border-primary"
          : "border-border-subtle hover:border-primary/40",
      )}
      style={{ width, borderRadius: 0 }}
      title={item.title}
    >
      <div
        className="relative flex w-full items-center justify-center overflow-hidden bg-muted/30"
        style={{ height }}
      >
        <Thumbnail item={item} />

        {/* hover 미리재생 오버레이 — src 는 hover 시점에만 주입(지연 디코드).
            leave 시 언마운트되어 디코더가 해제된다. 배지보다 DOM 앞이라
            type/duration/note 배지는 위에 그대로 보인다. */}
        {hoverPlay && canHoverPlay ? <HoverMedia item={item} /> : null}

        {/* 좌상단 type 라벨 — 메인 앱 LibraryGrid 의 Badge variant="secondary"
            패턴을 그대로 사용. Behance/Pinterest/YouTube 등 source_url 기반
            라벨이 들어가도록 resolveTypeLabel 거침. */}
        <div className="pointer-events-none absolute left-2.5 top-2.5 flex flex-col items-start gap-1">
          <Badge className="h-5 px-1.5 text-micro" variant="secondary">
            {resolveTypeLabel(item)}
          </Badge>
        </div>

        {/* 우상단 노트 카운트 — primary tint, MessageSquare 아이콘. */}
        {noteCount > 0 ? (
          <div className="pointer-events-none absolute right-2.5 top-2.5 flex items-end gap-1">
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
          <span className="pointer-events-none absolute bottom-2.5 right-2.5 bg-black/70 px-1.5 py-0.5 font-mono text-2xs text-white">
            {formatDuration(item.duration_sec ?? 0)}
          </span>
        ) : null}
      </div>
      <div
        className={cn(
          "w-full truncate px-1.5 text-center text-caption",
          isSelected ? "font-medium text-foreground" : "text-text-secondary group-hover:text-foreground",
        )}
        style={{ height: LABEL_HEIGHT, lineHeight: `${LABEL_HEIGHT}px` }}
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

/* hover 시점에만 마운트되는 미리재생 미디어.
 *   - video: <video muted loop playsInline autoPlay>, cover_at_sec 으로 시작 seek.
 *   - gif / 애니메이션 webp: 원본 <img> 를 그대로 띄워 애니메이션 재생
 *     (브라우저가 gif/animated-webp 를 <video> 로 디코드하지 못하므로 img).
 *  pointer-events-none 으로 카드 버튼의 click/dblclick 을 가리지 않는다. */
function HoverMedia({ item }: { item: ReferenceItem }) {
  if (item.kind === "video") {
    return (
      <video
        src={item.file_url ?? undefined}
        poster={item.thumbnail_url ?? undefined}
        muted
        loop
        autoPlay
        playsInline
        preload="metadata"
        className="pointer-events-none absolute inset-0 h-full w-full object-cover"
        onLoadedMetadata={(event) => {
          const v = event.currentTarget;
          if (item.cover_at_sec && Number.isFinite(item.cover_at_sec)) {
            try {
              v.currentTime = item.cover_at_sec;
            } catch {
              /* seek 실패는 무시 — 0 부터 재생. */
            }
          }
          v.play?.().catch(() => {});
        }}
      />
    );
  }
  return (
    <img
      src={item.file_url ?? undefined}
      alt={item.title}
      draggable={false}
      className="pointer-events-none absolute inset-0 h-full w-full object-cover"
    />
  );
}

function FallbackIcon({ kind }: { kind: ReferenceKind }) {
  const Icon =
    kind === "youtube"
      ? Youtube
      : kind === "link"
        ? Link2
        : kind === "video"
          ? Film
          : kind === "doc"
            ? FileText
            : ImageIcon;
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

function layoutJustifiedRows(
  items: ReferenceItem[],
  containerWidth: number,
  targetRowHeight: number,
): Row[] {
  if (containerWidth <= 0 || items.length === 0) return [];
  const targetH = targetRowHeight;
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
