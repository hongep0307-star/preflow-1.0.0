import { useMemo, useState, type ReactNode } from "react";
import {
  ArrowDownAZ,
  ArrowUpAZ,
  Check,
  ChevronRight,
  CircleDashed,
  Download,
  Drama,
  Eraser,
  Eye,
  EyeOff,
  FileType2,
  Folder,
  Grid2X2,
  HardDrive,
  Hash,
  Layers,
  LayoutDashboard,
  List,
  MessageSquare,
  Minus,
  MoreHorizontal,
  PackageOpen,
  Palette,
  Plus,
  RectangleHorizontal,
  RectangleVertical,
  RefreshCw,
  Search,
  Sparkles,
  Square,
  Star,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/uiLanguage";
import { formatTitleShortcuts } from "@/lib/shortcutLabel";
import type { LibraryFilterRow, LibraryFolderRow } from "./LibrarySidebar";
import { normalizeFolderPath, type ReferenceItem, type ReferenceKind } from "@/lib/referenceLibrary";
import { BRIEF_MATCH_ROOT, isBriefMatchPath } from "@/lib/briefMatch";
import { ETC_LEAF, TYPE_CATEGORY_SPECS, typeLeafLabel, type TypeCategory } from "@/lib/typeFilter";
import { aspectOf } from "./LibraryGrid";
import { ColorPicker } from "./ColorPicker";
import { MoodFilterChip } from "./MoodFilterChip";
import type { MoodFilterSpec } from "@/lib/moodSearch";
import type { ClassifyQueueSnapshot } from "@/lib/classifyQueue";
import type { KoreanTagAliasIndex } from "@/lib/koreanTagAliasIndex";
import { containsHangul } from "@/lib/koreanSearchSuggest";

/* ───────────────── Public types ─────────────────
 * Eagle 의 필터 모델을 옮긴 것. 단일 값(원래의 RatingFilter/NoteFilter 등)
 * 대신 다중 선택 + include/exclude 의 두 셋을 가진 MultiFilter, 별점/모양
 * 같은 작은 enum 셋, 그리고 자유 텍스트 키워드를 함께 가진 Note 상태로
 * 분리한다. LibraryPage 가 이 타입들을 그대로 useState 에 들고 있고
 * filteredItems predicate 도 동일한 타입을 소비한다. */

/** include / exclude 양방향 다중 필터. 한 값을 동시에 양쪽에 두지 않으며,
 *  토글 시 반대편을 자동 제거(상호 배타). include 가 비어 있으면 "포함
 *  제약 없음" 으로 해석해 모든 값이 통과한다. */
export interface MultiFilter<T extends string | number> {
  readonly include: ReadonlySet<T>;
  readonly exclude: ReadonlySet<T>;
}

/** 빈 multi 필터를 만드는 헬퍼. ReadonlySet 가 invariant 라 단순 const
 *  공용 객체로는 ReferenceKind 등 좁은 타입의 자리에 못 박혀 들어가서
 *  매번 새로 만들어 반환한다(메모리 비용 무시 가능). */
export function emptyMulti<T extends string | number>(): MultiFilter<T> {
  return { include: new Set<T>(), exclude: new Set<T>() };
}

export function multiFilterCount<T extends string | number>(f: MultiFilter<T>): number {
  return f.include.size + f.exclude.size;
}

export function multiFilterActive<T extends string | number>(f: MultiFilter<T>): boolean {
  return f.include.size > 0 || f.exclude.size > 0;
}

export function toggleInclude<T extends string | number>(
  f: MultiFilter<T>,
  value: T,
): MultiFilter<T> {
  const include = new Set(f.include);
  const exclude = new Set(f.exclude);
  if (include.has(value)) {
    include.delete(value);
  } else {
    include.add(value);
    exclude.delete(value);
  }
  return { include, exclude };
}

export function toggleExclude<T extends string | number>(
  f: MultiFilter<T>,
  value: T,
): MultiFilter<T> {
  const include = new Set(f.include);
  const exclude = new Set(f.exclude);
  if (exclude.has(value)) {
    exclude.delete(value);
  } else {
    exclude.add(value);
    include.delete(value);
  }
  return { include, exclude };
}

/** 단일 값 매칭(예: item.kind ∈ types). exclude 1순위, include 가 비면 통과. */
export function matchMulti<T extends string | number>(value: T, f: MultiFilter<T>): boolean {
  if (f.exclude.has(value)) return false;
  if (f.include.size === 0) return true;
  return f.include.has(value);
}

/** 다값 매칭(예: item.tags vs Tags 필터). exclude 가 하나라도 매칭되면 탈락.
 *  include 는 OR — 셋 중 아무거나 매치되면 통과. include 비면 통과. */
export function matchMultiAny<T extends string>(
  values: readonly T[],
  f: MultiFilter<T>,
): boolean {
  if (values.some((v) => f.exclude.has(v))) return false;
  if (f.include.size === 0) return true;
  return values.some((v) => f.include.has(v));
}

export type RatingValue = 1 | 2 | 3 | 4 | 5 | "none";
export type ShapeValue =
  | "horizontal"
  | "vertical"
  | "square"
  | "ratio_43"
  | "ratio_169"
  | "custom";

export interface NoteFilterState {
  /** all = 무시 / with = 노트 있음 / without = 노트 없음. keyword 와 AND 결합. */
  mode: "all" | "with" | "without";
  /** item.notes 에 대한 substring 검사. 공백만 있으면 무시. */
  keyword: string;
}

export const EMPTY_NOTE_FILTER: NoteFilterState = { mode: "all", keyword: "" };

/** 비율 → Shape 버킷(들). 한 항목이 동시에 여러 버킷에 속할 수 있다 — 예를
 *  들어 1920×1080 이미지는 horizontal 과 ratio_169 양쪽에 매칭되어, 사용자가
 *  "Horizontal" 만 골라도 잡히고 "16:9" 로 좁혀도 잡힌다(Eagle 패리티).
 *
 *  중요: aspectOf 의 kind 폴백(image=4:3, video=16:9)은 그리드 레이아웃용으로
 *  필요하지만, 분류에 그대로 쓰면 측정 안 된 모든 이미지가 4:3 버킷에 일괄
 *  흡수되어 필터 결과가 오염된다. 그래서 이 함수는 DB 의 `item.width/height`
 *  를 직접 검사하고, 값이 비어 있으면 "custom" 한 칸만 돌려준다 — 필터에서
 *  Custom 을 골랐을 때만 매칭된다. */
export function aspectBuckets(item: ReferenceItem): ShapeValue[] {
  const w = typeof item.width === "number" ? item.width : NaN;
  const h = typeof item.height === "number" ? item.height : NaN;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return ["custom"];
  }
  const a = w / h;
  const out: ShapeValue[] = [];
  // Orientation — 항상 정확히 하나가 매칭되도록 경계는 [0.9, 1.1) / [1.1, ∞).
  if (a < 0.9) out.push("vertical");
  else if (a < 1.1) out.push("square");
  else out.push("horizontal");
  // 추가 라벨 — orientation 과 겹쳐서 함께 매칭(±5%). 4:3 ≈ 1.27~1.40,
  // 16:9 ≈ 1.69~1.87. 이전 4% 보다 살짝 넓혀 1920×1200(=1.6) 같은 16:10 은
  // 여전히 제외되지만 1.28~1.4 의 일반적 4:3 변형은 모두 포함되도록.
  if (Math.abs(a - 4 / 3) / (4 / 3) < 0.05) out.push("ratio_43");
  if (Math.abs(a - 16 / 9) / (16 / 9) < 0.05) out.push("ratio_169");
  return out;
}

/** "canvas" 는 PureRef 스타일 자유 배치 보드. LibraryPage 의 폴더 컨텍스트
 *  (`activeTag?.startsWith("folder:")`) 일 때만 메뉴에 노출되며, 폴더를
 *  벗어나면 LibraryPage 의 useEffect 가 자동으로 "grid" 로 폴백한다.
 *  뷰가 캔버스여도 폴더 콘텐츠는 grid/list 와 동일하게 유지된다 — 캔버스는
 *  단지 ref 별 위치 메타데이터(`canvasLayout.ts`) 를 시각화할 뿐이다. */
export type LibraryViewMode = "grid" | "list" | "canvas";
export type LibrarySortKey =
  | "recent"
  | "name"
  | "rating"
  | "size"
  | "lastUsed"
  | "manual"
  /** 자료의 픽셀 해상도(width × height) 기준 — 리스트 뷰의 Dimensions 컬럼
   *  헤더 클릭으로 진입. width 또는 height 가 비어 있는 항목(link/youtube
   *  중 메타 미수집)은 0 으로 취급되어 desc 정렬 시 가장 아래로. */
  | "dimensions"
  /** MIME subtype 또는 파일 확장자 알파벳 기준 — 같은 종류의 자료를 한
   *  덩어리로 모아 보고 싶을 때 유용. 리스트 뷰의 Extension 컬럼 헤더에서
   *  진입한다. resolveTypeLabel 의 platform 폴백까지 포함해 link/youtube 도
   *  의미 있는 그룹으로 묶인다. */
  | "extension";
export type LibrarySortOrder = "asc" | "desc";

/* Deprecated single-value filter aliases — 외부에서 import 가 남아 있을 때만
 * 빌드 깨짐을 막기 위해 보존. 새 컴포넌트는 절대 이걸 쓰지 않는다. */
/** @deprecated Use `MultiFilter<RatingValue>` / `ReadonlySet<RatingValue>`. */
export type RatingFilter = "all" | "rated" | "unrated" | "fourPlus";
/** @deprecated Use `NoteFilterState`. */
export type NoteFilter = "all" | "with" | "without";
/** @deprecated Eagle 패리티로 Source 필터는 제거되었다. */
export type SourceFilter = "all" | "eagle" | "manual" | "youtube";

/* ───────────────── Constants ───────────────── */

/* 별점 옵션 — id 만 정적이고 라벨은 ratingLabel(t, id) 로 런타임 빌드.
   ★ 글리프는 그대로 두고 "None" 만 i18n. */
const RATING_IDS: RatingValue[] = [5, 4, 3, 2, 1, "none"];
function ratingLabel(t: ReturnType<typeof useT>, id: RatingValue): string {
  if (id === "none") return t("library.rating.none");
  return "★".repeat(id) + "☆".repeat(5 - id);
}

const SHAPE_OPTIONS_STATIC: Array<{ id: ShapeValue; key: string; icon: LucideIcon }> = [
  { id: "horizontal", key: "library.shape.horizontal", icon: RectangleHorizontal },
  { id: "vertical", key: "library.shape.vertical", icon: RectangleVertical },
  { id: "square", key: "library.shape.square", icon: Square },
  { id: "ratio_43", key: "library.shape.ratio43", icon: RectangleHorizontal },
  { id: "ratio_169", key: "library.shape.ratio169", icon: RectangleHorizontal },
  { id: "custom", key: "library.shape.custom", icon: CircleDashed },
];

/* 리스트 뷰의 컬럼 헤더 클릭 진입점과 일관되도록 토올바 드롭다운에도
   Dimensions / Extension 을 노출. 그리드 뷰에서도 같은 키로 정렬되어
   두 뷰 사이를 오갈 때 사용자의 정렬 의도가 끊기지 않는다. */
const SORT_OPTIONS_STATIC: Array<{ id: LibrarySortKey; key: string }> = [
  { id: "recent", key: "library.sort.recent" },
  { id: "lastUsed", key: "library.sort.lastUsed" },
  { id: "name", key: "library.sort.name" },
  { id: "rating", key: "library.sort.rating" },
  { id: "size", key: "library.sort.size" },
  { id: "dimensions", key: "library.sort.dimensions" },
  { id: "extension", key: "library.sort.extension" },
  { id: "manual", key: "library.sort.manual" },
];

/* ───────────────── 칩 외형 ─────────────────
 * 7 개 필터가 모두 공유. label/icon/배지/active 톤만 다르고 popover 본문은
 * 각자 따로. PopoverTrigger asChild 패턴이라 Radix 가 ref/aria 를 Button
 * 까지 forward 한다. */
interface FilterChipShellProps {
  icon: LucideIcon;
  label: string;
  count: number;
  active: boolean;
  popoverContent: ReactNode;
  contentWidth?: number;
  disabledTitle?: string;
  /** Color 칩 전용 — 카운트 배지 자리에 16×16 swatch 를 그려 현재 어떤 색이
   *  선택돼 있는지 한눈에 보여 준다. 다른 칩들은 이 prop 을 비워 두면 기존
   *  count 배지가 그대로 동작. */
  accentSwatch?: string;
  /** 칩 좌측 아이콘을 LucideIcon 대신 임의 노드로 그리고 싶을 때.
   *  Color 칩이 컬러휠(레인보우 도넛) 노드를 넘기는 데 사용. 비어 있으면
   *  기본 `icon` LucideIcon 이 그대로 렌더된다. */
  iconNode?: ReactNode;
  /** 활성 상태에서 칩 우상단에 작은 × 버튼을 노출해 한 번 클릭으로 이
   *  필터만 해제하는 단축키. 정의되지 않으면 ×는 그려지지 않음(즉 칩이
   *  active 여도 popover 를 열어 안에서 Clear 해야 함). */
  onClear?: () => void;
}

function FilterChipShell({
  icon: Icon,
  label,
  count,
  active,
  popoverContent,
  contentWidth = 240,
  disabledTitle,
  accentSwatch,
  iconNode,
  onClear,
}: FilterChipShellProps) {
  const t = useT();
  /* × 버튼을 popover trigger 의 *형제* 로 두기 위해 relative 래퍼로 감싼다.
   * trigger 안에 두면 클릭이 popover 를 여는 동작과 충돌하고, asChild
   * 패턴 상 추가 자식을 둘 수도 없다. */
  return (
    <span className="relative inline-flex">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              "h-8 gap-1.5 px-2 text-caption",
              active && "border-primary/60 bg-primary/15 text-primary",
            )}
            title={disabledTitle}
          >
            {iconNode ?? <Icon className="h-3.5 w-3.5" />}
            <span>{label}</span>
            {accentSwatch ? (
              <span
                className="ml-0.5 inline-block h-3.5 w-3.5 border border-border-subtle ring-1 ring-border-subtle/40"
                style={{ background: accentSwatch }}
                title={accentSwatch}
              />
            ) : count > 0 ? (
              <span
                className={cn(
                  "ml-0.5 inline-flex h-4 min-w-[16px] items-center justify-center px-1 font-mono text-micro",
                  active ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
                )}
              >
                {count}
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="rounded-none p-0"
          style={{ width: contentWidth }}
        >
          {/* 하단 "Select L-Click · Exclude R-Click · Close ESC" 가이드는 시각
              소음으로 판단해 제거. 동작 자체(좌클릭=include, 우클릭=exclude,
              ESC=close) 는 picker / Radix Popover 가 그대로 처리하므로 기능
              손실 없음. */}
          {popoverContent}
        </PopoverContent>
      </Popover>
      {active && onClear ? (
        <button
          type="button"
          aria-label={t("library.toolbar.clearFilterAria", { label })}
          title={t("library.toolbar.clearFilterAria", { label })}
          /* pointerDown 을 잡아서 Radix popover 의 outside-click 핸들링과
             경쟁하기 전에 동작을 가로챈다. preventDefault 로 trigger 가
             focus 를 가져가는 것까지 막는다. */
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onClear();
          }}
          /* 어두운 회색 톤 — 흰색은 active 칩(특히 빨강) 위에서 너무
             튀어 보였다. neutral-700 은 다크 토템 위에서 자연스럽게 가라
             앉으면서, 옅은 회색 X 와 살짝 어두운 ring 으로 칩 경계와
             구분되게. */
          className="absolute -right-1.5 -top-1.5 z-10 inline-flex h-4 w-4 items-center justify-center rounded-full bg-neutral-700 text-neutral-200 ring-1 ring-neutral-900 transition-colors hover:bg-neutral-600 hover:text-white"
        >
          <X className="h-2.5 w-2.5" strokeWidth={3} />
        </button>
      ) : null}
    </span>
  );
}

/* ───────────────── 토글 행 ─────────────────
 * L-click=include / R-click=exclude. 빈 상태 / include / exclude 3 가지가
 * 한 번에 시각적으로 구분되도록 좌측 체크박스 + 텍스트 스타일을 함께 바꾼다. */
interface ToggleRowProps<T extends string | number> {
  id: T;
  label: string;
  rightLabel?: string;
  icon?: LucideIcon;
  state: "include" | "exclude" | "none";
  onInclude: () => void;
  onExclude: () => void;
  indent?: number;
  /** 아이콘 색 override (예: 스마트 브리프 매치 폴더는 레드). 미지정 시 기본 톤. */
  iconClassName?: string;
  /** label 우측에 작게 표시되는 보조 텍스트. Tags 피커에서 한글 검색이
   *  활성일 때 매칭에 기여한 KO 별칭을 ("야경, 도시" 식으로) 보여줘 사용자
   *  가 "왜 이 row 가 떴는지" 알 수 있게 한다. label 자체는 영어를 유지. */
  hint?: string;
  /** 이 row 가 어떤 자료에도 사용자에 의해 머지되지 않은(AI 제안만 존재하는)
   *  토큰임을 작은 Sparkles 아이콘으로 표시. Tags / Moods 칩이 AI 가 분류한
   *  미수락 토큰까지 노출할 때, 사용자에게 "이건 아직 내가 단 적이 없는
   *  AI 제안이야" 라는 시각 단서를 준다. label 색은 그대로 두어 가독성 유지. */
  aiSuggested?: boolean;
}

function ToggleRow<T extends string | number>({
  id,
  label,
  rightLabel,
  icon: Icon,
  state,
  onInclude,
  onExclude,
  indent = 0,
  hint,
  aiSuggested,
  iconClassName,
}: ToggleRowProps<T>) {
  const t = useT();
  return (
    <button
      key={String(id)}
      type="button"
      onClick={onInclude}
      onContextMenu={(event) => {
        event.preventDefault();
        onExclude();
      }}
      className={cn(
        "flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-muted",
        state === "exclude" && "text-destructive line-through",
        state === "include" && "text-foreground",
      )}
    >
      <span
        className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center border border-border-subtle bg-background"
        style={{ marginLeft: indent }}
      >
        {state === "include" ? (
          <Check className="h-3 w-3 text-primary" />
        ) : state === "exclude" ? (
          <Minus className="h-3 w-3 text-destructive" />
        ) : null}
      </span>
      {Icon ? <Icon className={cn("h-3.5 w-3.5 flex-shrink-0", iconClassName ?? "text-muted-foreground")} /> : null}
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5 truncate">
        <span className="truncate">{label}</span>
        {/* AI-only 토큰 마커 — Tags/Moods 칩이 라이브러리에 사용자 머지 적이
            없는 AI 제안 토큰까지 노출할 때 사용자에게 "AI가 제안한 후보" 임을
            시각으로 알린다. amber 톤은 인스펙터 Mood 섹션·classify pill 과
            동일 계열로, "AI 신호" 라는 의미를 한 라인으로 통일한다. */}
        {aiSuggested ? (
          <Sparkles
            className="h-2.5 w-2.5 flex-shrink-0 text-amber-500/80"
            aria-label={t("library.toolbar.aiSuggestedAria")}
          />
        ) : null}
        {hint ? (
          <span className="truncate text-2xs text-muted-foreground/70">{hint}</span>
        ) : null}
      </span>
      {rightLabel ? (
        <span className="font-mono text-2xs text-muted-foreground">{rightLabel}</span>
      ) : null}
    </button>
  );
}

/* ───────────────── 다중 선택 picker (Tags/Folder/Types 공용) ───────────────── */

interface OptionRow<T extends string> {
  id: T;
  label: string;
  count?: number;
  icon?: LucideIcon;
  depth?: number;
  /** 아이콘 색 override (스마트 브리프 매치 폴더는 레드 등). */
  iconClassName?: string;
  /** AI 가 분류만 했고 어떤 자료에도 사용자가 직접 머지하지 않은 토큰임을
   *  ToggleRow 가 sparkle 마커로 표기하는 데 사용. 기본 false. */
  aiSuggested?: boolean;
}

interface MultiPickerProps<T extends string> {
  value: MultiFilter<T>;
  onChange: (next: MultiFilter<T>) => void;
  rows: ReadonlyArray<OptionRow<T>>;
  /** 빈 문자열이면 검색창 자체를 숨김. */
  searchPlaceholder?: string;
  maxHeight?: number;
  emptyLabel?: string;
  /** 한글 입력 시 row.id(영어 태그) 를 alias 매칭으로 필터링하기 위한 인덱스.
   *  제공되지 않으면 영어 substring 매칭만 동작 (기존 동작 그대로). Tags 칩
   *  처럼 row.id 가 EN canonical 토큰인 경우에만 의미 있음 (Folder 등에는
   *  넘기지 않는다). */
  koreanAliasIndex?: KoreanTagAliasIndex;
  /** 한글 매칭 시 어느 lookup 을 쓸지 — Tags 칩이면 일반 tag 인덱스(기본),
   *  Moods 칩이면 mood 인덱스. row.id 의 의미 차원과 일치하는 lookup 을
   *  쓰지 않으면 매칭이 비거나 노이즈가 늘어난다. */
  koreanAliasMode?: "tags" | "moods";
}

function MultiPicker<T extends string>({
  value,
  onChange,
  rows,
  searchPlaceholder,
  maxHeight = 320,
  emptyLabel,
  koreanAliasIndex,
  koreanAliasMode = "tags",
}: MultiPickerProps<T>) {
  const t = useT();
  const resolvedPlaceholder = searchPlaceholder ?? t("library.toolbar.searchPickerPlaceholder");
  const resolvedEmpty = emptyLabel ?? t("library.toolbar.noMatches");
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  /* id → label 룩업. 선택된 토큰이 현재 picker 의 rows 에 더 이상 존재하지
     않는 경우(예: 자료가 삭제되어 카운트가 0 으로 떨어진 태그)도 SelectedSummary
     에서 그대로 보이도록, 빠진 항목은 id 자체를 라벨로 폴백한다. */
  const labelById = useMemo(() => {
    const m = new Map<T, string>();
    for (const row of rows) m.set(row.id, row.label);
    return m;
  }, [rows]);
  /* 한글 입력이면 별칭 인덱스 기반 EN 후보 집합을 만들고 row.id 가 그
     집합에 들어 있는지로 통과 여부를 가린다. 매칭된 row 옆에는 발견된
     KO 별칭을 작은 보조 텍스트로 함께 보여줘 사용자가 "왜 이 row 가
     떴는지" 알 수 있게 한다. 인덱스가 없거나 영어 쿼리면 기존
     `label.includes` 경로 그대로. */
  const koMatch = useMemo(() => {
    if (!q || !koreanAliasIndex?.hasData) return null;
    if (!containsHangul(q)) return null;
    const candidates = new Map<string, ReadonlyArray<string>>();
    /* row.id 의 의미 차원에 맞춰 lookup 을 선택. Tags 칩은 lookupTags
       (사용자 머지 + AI suggested 인덱스), Moods 칩은 lookupMoods
       (mood_labels 평행 페어 + 시드 사전의 family="mood"). 잘못 선택하면
       정상 매칭이 비어 보이거나 다른 차원 토큰이 흘러와 노이즈가 된다. */
    const matches =
      koreanAliasMode === "moods"
        ? koreanAliasIndex.lookupMoods(q)
        : koreanAliasIndex.lookupTags(q);
    for (const m of matches) {
      candidates.set(m.tag, m.aliases);
    }
    return candidates;
  }, [q, koreanAliasIndex, koreanAliasMode]);
  const filtered = useMemo(() => {
    if (!q) return rows;
    /* 한글 q: koMatch (별칭→EN canonical) ∪ label substring 합집합으로
       매칭. 라이브러리에 한글 raw 토큰("차량 실내")이 row.id 로 들어와
       있을 때 koMatch 결과(EN 인덱스 만 담음)에는 누락되지만 label 직접
       매칭으로 잡혀야 한다 — 그렇지 않으면 한글 태그가 한글 검색에 안
       보이는 모순이 생긴다. 영어 q 는 기존처럼 label substring 만 사용
       (영어→한글 매핑은 픽커 사용성 면에서 가치 낮음 + 노이즈 위험). */
    if (containsHangul(q)) {
      const matched = new Set<(typeof rows)[number]>();
      if (koMatch) {
        for (const row of rows) {
          if (koMatch.has(row.id.toLowerCase())) matched.add(row);
        }
      }
      for (const row of rows) {
        if (row.label.toLowerCase().includes(q)) matched.add(row);
      }
      /* 원래 rows 의 정렬(빈도 desc 등)을 그대로 유지하기 위해 Set 멤버십
         으로 다시 필터 — 두 path 결과를 단순 concat 하면 koMatch 결과가
         앞에 몰리고 한글 row 가 뒤로 밀려 흐름이 어색해진다. */
      return rows.filter((row) => matched.has(row));
    }
    if (koMatch) {
      return rows.filter((row) => koMatch.has(row.id.toLowerCase()));
    }
    return rows.filter((row) => row.label.toLowerCase().includes(q));
  }, [rows, q, koMatch]);

  return (
    <div className="flex flex-col">
      {/* ── 선택된 항목 요약 바 ─────────────────────────────────
          많은 태그가 선택될수록 목록을 위아래로 스크롤하지 않고는
          현재 무엇을 골랐는지 파악하기가 어렵다. 그래서 활성 시에만
          최상단에 pinned 헤더를 띄워 include/exclude 셋을 작은 칩으로
          모아 보여주고, 각 칩의 × 클릭으로 즉시 해당 항목만 토글한다.
          비활성 상태(아무것도 안 골랐을 때) 에서는 자체적으로 null 을
          그려 자리를 차지하지 않는다 — 평시 노이즈 0. */}
      <SelectedSummary
        include={value.include}
        exclude={value.exclude}
        labelById={labelById}
        onRemoveInclude={(id) => onChange(toggleInclude(value, id))}
        onRemoveExclude={(id) => onChange(toggleExclude(value, id))}
        onClearIncludes={() =>
          onChange({ include: new Set<T>(), exclude: value.exclude })
        }
        onClearExcludes={() =>
          onChange({ include: value.include, exclude: new Set<T>() })
        }
      />
      {resolvedPlaceholder ? (
        <div className="flex items-center gap-1.5 border-b border-border-subtle px-2 py-1.5">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={resolvedPlaceholder}
            className="h-6 flex-1 bg-transparent text-caption outline-none placeholder:text-muted-foreground"
          />
        </div>
      ) : null}
      <div className="overflow-y-auto" style={{ maxHeight }}>
        {filtered.length === 0 ? (
          <div className="px-3 py-3 text-center text-caption text-muted-foreground">{resolvedEmpty}</div>
        ) : (
          filtered.map((row) => {
            const state: "include" | "exclude" | "none" = value.include.has(row.id)
              ? "include"
              : value.exclude.has(row.id)
              ? "exclude"
              : "none";
            /* aliasHint 산출 — 두 경로:
               (1) 사용자가 한글을 입력한 경우(koMatch 활성): 그 쿼리에
                   *매칭된* KO 별칭만 보여 줘 "왜 이 row 가 떴는지"를 답한다.
               (2) 검색 전 평상시 (Tags / Moods 모드 공통): 라벨이 영어
                   (예: "energetic", "nightscape") 라 어떤 한글로 쳐야
                   하는지 사용자가 모를 수 있으므로, 인덱스에 알려진 KO
                   별칭(시드 + 라이브러리 평행 페어) 상위 2 개를 미리
                   보조 텍스트로 노출 — 검색 ergonomic + 한글 검색 가능성
                   발견. Folder picker 는 koreanAliasIndex 를 prop 으로
                   받지 않아 hasData=falsy 가 되어 자연 비활성된다. */
            const aliasHint = (() => {
              if (koMatch) {
                return koMatch.get(row.id.toLowerCase())?.slice(0, 2).join(", ");
              }
              if (koreanAliasIndex?.hasData) {
                /* primary: 현재 픽커 모드의 인덱스에서 우선 조회. 비대칭
                   폴백 — primary 가 비면 반대 버킷도 한 번 본다. "cute" 가
                   시드에는 mood, 라이브러리에는 tag 인 경우처럼 두 버킷이
                   의도적으로 분리된 토큰의 hint 누락을 메꾼다. */
                const primary =
                  koreanAliasMode === "moods"
                    ? koreanAliasIndex.koAliasesForMood(row.id)
                    : koreanAliasIndex.koAliasesFor(row.id);
                let aliases = primary;
                if (aliases.length === 0) {
                  aliases =
                    koreanAliasMode === "moods"
                      ? koreanAliasIndex.koAliasesFor(row.id)
                      : koreanAliasIndex.koAliasesForMood(row.id);
                }
                if (aliases.length > 0) return aliases.slice(0, 2).join(", ");
              }
              return undefined;
            })();
            return (
              <ToggleRow
                key={row.id}
                id={row.id}
                label={row.label}
                rightLabel={row.count !== undefined ? String(row.count) : undefined}
                icon={row.icon}
                state={state}
                onInclude={() => onChange(toggleInclude(value, row.id))}
                onExclude={() => onChange(toggleExclude(value, row.id))}
                indent={(row.depth ?? 0) * 12}
                hint={aliasHint}
                aiSuggested={row.aiSuggested}
                iconClassName={row.iconClassName}
              />
            );
          })
        )}
      </div>
      {multiFilterActive(value) ? (
        <button
          type="button"
          onClick={() => onChange(emptyMulti<T>())}
          className="border-t border-border-subtle px-2 py-1.5 text-left text-caption text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {t("library.toolbar.clearThisFilter")}
        </button>
      ) : null}
    </div>
  );
}

/* ───────────────── 선택된 항목 요약 바 (MultiPicker 공용) ─────────────────
 *
 * Tags 처럼 옵션이 수십 개에 달하는 picker 에서, 활성 토글이 여러 개일 때
 * 목록을 위아래로 훑지 않고도 "지금 뭘 골랐지?" 가 즉시 보이도록 popover
 * 최상단에 pinned 헤더로 띄운다.
 *
 * 디자인 메모:
 *   · 포함(include) 은 primary 톤(브랜드 레드), 제외(exclude) 는 destructive
 *     톤으로 색을 분리해 두 셋이 한 화면에서 자연스럽게 구분된다.
 *   · 칩 자체가 버튼이라 어디를 클릭해도 그 항목만 토글로 해제된다 (× 아이콘
 *     은 시각 신호일 뿐). 매번 picker 목록까지 내려가 같은 행을 찾을 필요 없음.
 *   · 그룹 헤더 우측에 "전부 해제" 단축 액션 — include / exclude 를 한 번에
 *     비울 때 유용. 단, 다른 쪽 셋은 보존한다 (양쪽 모두 비우려면 기존
 *     하단 "이 필터 해제" 사용). */
interface SelectedSummaryProps<T extends string> {
  include: ReadonlySet<T>;
  exclude: ReadonlySet<T>;
  labelById: ReadonlyMap<T, string>;
  onRemoveInclude: (id: T) => void;
  onRemoveExclude: (id: T) => void;
  onClearIncludes: () => void;
  onClearExcludes: () => void;
}

function SelectedSummary<T extends string>({
  include,
  exclude,
  labelById,
  onRemoveInclude,
  onRemoveExclude,
  onClearIncludes,
  onClearExcludes,
}: SelectedSummaryProps<T>) {
  const t = useT();
  if (include.size === 0 && exclude.size === 0) return null;
  /* Set 은 반복 순서가 보장되지만 라벨 알파벳 정렬이 사용자 인지에 더
     쾌적하다 — "어디로 갔지?" 가 줄어든다. 한글 ↔ 영어 혼재 환경이라
     `localeCompare` 의 기본 동작(유니코드 순)에 맡긴다. */
  const sortByLabel = (a: T, b: T) =>
    (labelById.get(a) ?? a).localeCompare(labelById.get(b) ?? b);
  const includeList = Array.from(include).sort(sortByLabel);
  const excludeList = Array.from(exclude).sort(sortByLabel);

  return (
    <div className="flex flex-col gap-1.5 border-b border-border-subtle bg-muted/30 px-2 py-1.5">
      {includeList.length > 0 ? (
        <SummaryGroup
          tone="include"
          heading={t("library.toolbar.selectedIncluded")}
          count={includeList.length}
          ids={includeList}
          labelById={labelById}
          onRemove={onRemoveInclude}
          onClearAll={onClearIncludes}
          clearLabel={t("library.toolbar.selectedClearGroup")}
          removeAriaTemplate={(label) =>
            t("library.toolbar.selectedRemoveAria", { label })
          }
        />
      ) : null}
      {excludeList.length > 0 ? (
        <SummaryGroup
          tone="exclude"
          heading={t("library.toolbar.selectedExcluded")}
          count={excludeList.length}
          ids={excludeList}
          labelById={labelById}
          onRemove={onRemoveExclude}
          onClearAll={onClearExcludes}
          clearLabel={t("library.toolbar.selectedClearGroup")}
          removeAriaTemplate={(label) =>
            t("library.toolbar.selectedRemoveAria", { label })
          }
        />
      ) : null}
    </div>
  );
}

interface SummaryGroupProps<T extends string> {
  tone: "include" | "exclude";
  heading: string;
  count: number;
  ids: ReadonlyArray<T>;
  labelById: ReadonlyMap<T, string>;
  onRemove: (id: T) => void;
  onClearAll: () => void;
  clearLabel: string;
  removeAriaTemplate: (label: string) => string;
}

function SummaryGroup<T extends string>({
  tone,
  heading,
  count,
  ids,
  labelById,
  onRemove,
  onClearAll,
  clearLabel,
  removeAriaTemplate,
}: SummaryGroupProps<T>) {
  /* 두 톤이 같은 헤더/칩 구조를 공유 — tone 만 className 으로 분기한다.
     · include: primary 톤(브랜드 레드, 활성 칩과 동일 계열).
     · exclude: destructive 톤 + 텍스트 line-through 로 "빼는 중" 임을 강조. */
  const chipClass =
    tone === "include"
      ? "border-primary/50 bg-primary/15 text-primary hover:bg-primary/25"
      : "border-destructive/50 bg-destructive/10 text-destructive line-through hover:bg-destructive/20";
  const headingClass =
    tone === "include"
      ? "text-primary/90"
      : "text-destructive/90";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span
          className={cn(
            "text-2xs font-semibold tracking-normal",
            headingClass,
          )}
        >
          {heading}
          <span className="ml-1 font-mono text-muted-foreground/70">{count}</span>
        </span>
        <button
          type="button"
          onClick={onClearAll}
          className="text-2xs text-muted-foreground hover:text-foreground"
        >
          {clearLabel}
        </button>
      </div>
      <div className="flex flex-wrap gap-1">
        {ids.map((id) => {
          const label = labelById.get(id) ?? id;
          return (
            <button
              key={id}
              type="button"
              title={removeAriaTemplate(label)}
              aria-label={removeAriaTemplate(label)}
              onClick={() => onRemove(id)}
              className={cn(
                "inline-flex h-6 max-w-[180px] items-center gap-1 rounded-none border px-1.5 text-caption transition-colors",
                chipClass,
              )}
            >
              <span className="truncate">{label}</span>
              <X className="h-2.5 w-2.5 flex-shrink-0 opacity-80" aria-hidden />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ───────────────── Types hierarchy picker ─────────────────
 *
 * 단일 MultiFilter<string>(typeFilter.ts) 로 4개 카테고리(image/video/doc/url) +
 * 각 카테고리의 하위 리프(포맷/플랫폼/기타)를 한 popover 에서 계층적으로 렌더한다.
 * 카테고리 행은 chevron 클릭으로 하위 리프를 펼친다. */

interface TypesHierarchyPickerProps {
  typeFilter: MultiFilter<string>;
  onTypeFilterChange: (next: MultiFilter<string>) => void;
  /** 카테고리 id + 리프 id 별 카운트 (computeTypeCounts). */
  typeCounts: ReadonlyMap<string, number>;
}

/* 계층형 Types picker — 4개 최상위 카테고리(이미지/영상/문서/URL) + 행 클릭(chevron)
 * 으로 펼치는 하위 리프(포맷/플랫폼/기타).
 *   · 카테고리 체크 = 그 종류 전체. 펼쳐서 리프 체크 = 그 리프만(카테고리 전체와 상호
 *     배타 — 리프를 고르면 카테고리 전체 선택은 해제, 그 반대도).
 *   · 좌클릭=include, 우클릭=exclude (ToggleRow 와 동일).
 *   · 단일 MultiFilter<string> 로 표현(typeFilter.ts). */
function TypesHierarchyPicker({
  typeFilter,
  onTypeFilterChange,
  typeCounts,
}: TypesHierarchyPickerProps) {
  const t = useT();
  const [expanded, setExpanded] = useState<Set<TypeCategory>>(() => new Set());

  const stateOf = (id: string): "include" | "exclude" | "none" =>
    typeFilter.include.has(id) ? "include" : typeFilter.exclude.has(id) ? "exclude" : "none";

  const clearCategoryLeaves = (set: Set<string>, catId: string) => {
    for (const id of [...set]) if (id.startsWith(`${catId}/`)) set.delete(id);
  };
  // 카테고리 전체 토글 — 선택 시 그 카테고리의 리프 선택은 비운다(상호 배타).
  const toggleCategoryInclude = (catId: string) => {
    const include = new Set(typeFilter.include);
    const exclude = new Set(typeFilter.exclude);
    if (include.has(catId)) include.delete(catId);
    else {
      include.add(catId);
      exclude.delete(catId);
      clearCategoryLeaves(include, catId);
      clearCategoryLeaves(exclude, catId);
    }
    onTypeFilterChange({ include, exclude });
  };
  const toggleCategoryExclude = (catId: string) => {
    const include = new Set(typeFilter.include);
    const exclude = new Set(typeFilter.exclude);
    if (exclude.has(catId)) exclude.delete(catId);
    else {
      exclude.add(catId);
      include.delete(catId);
      clearCategoryLeaves(include, catId);
      clearCategoryLeaves(exclude, catId);
    }
    onTypeFilterChange({ include, exclude });
  };
  // 리프 토글 — 선택 시 그 카테고리 전체 선택(catId)은 해제(리프가 우선).
  const toggleLeafInclude = (leafId: string) => {
    const catId = leafId.split("/")[0];
    const include = new Set(typeFilter.include);
    const exclude = new Set(typeFilter.exclude);
    if (include.has(leafId)) include.delete(leafId);
    else {
      include.add(leafId);
      exclude.delete(leafId);
      include.delete(catId);
    }
    onTypeFilterChange({ include, exclude });
  };
  const toggleLeafExclude = (leafId: string) => {
    const catId = leafId.split("/")[0];
    const include = new Set(typeFilter.include);
    const exclude = new Set(typeFilter.exclude);
    if (exclude.has(leafId)) exclude.delete(leafId);
    else {
      exclude.add(leafId);
      include.delete(leafId);
      exclude.delete(catId);
    }
    onTypeFilterChange({ include, exclude });
  };

  const leafLabel = (leafId: string) =>
    leafId.endsWith(`/${ETC_LEAF}`) ? t("library.types.etc") : typeLeafLabel(leafId);

  return (
    <div className="flex flex-col">
      <div className="overflow-y-auto" style={{ maxHeight: 360 }}>
        {TYPE_CATEGORY_SPECS.map((spec) => {
          const isOpen = expanded.has(spec.id);
          const catState = stateOf(spec.id);
          const hasLeafSel = spec.leaves.some(
            (l) => typeFilter.include.has(l) || typeFilter.exclude.has(l),
          );
          return (
            <div key={spec.id}>
              <div
                className={cn(
                  "flex w-full items-center hover:bg-muted",
                  catState !== "none" && "bg-muted/40",
                )}
              >
                <button
                  type="button"
                  onClick={() => toggleCategoryInclude(spec.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    toggleCategoryExclude(spec.id);
                  }}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-xs",
                    catState === "exclude" && "text-destructive line-through",
                    catState === "include" && "text-foreground",
                  )}
                >
                  <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center border border-border-subtle bg-background">
                    {catState === "include" ? (
                      <Check className="h-3 w-3 text-primary" />
                    ) : catState === "exclude" ? (
                      <Minus className="h-3 w-3 text-destructive" />
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{t(spec.labelKey)}</span>
                  {/* 카테고리 전체는 아니지만 하위 리프가 선택돼 있으면 부분 선택 점 표시. */}
                  {hasLeafSel && catState === "none" ? (
                    <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" />
                  ) : null}
                  <span className="font-mono text-2xs text-muted-foreground">
                    {typeCounts.get(spec.id) ?? 0}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(spec.id)) next.delete(spec.id);
                      else next.add(spec.id);
                      return next;
                    })
                  }
                  className="flex h-7 w-7 flex-shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
                  aria-label={t(isOpen ? "library.types.collapse" : "library.types.expand")}
                >
                  <ChevronRight
                    className={cn("h-3.5 w-3.5 transition-transform", isOpen && "rotate-90")}
                  />
                </button>
              </div>
              {isOpen
                ? spec.leaves.map((leafId) => (
                    <ToggleRow
                      key={leafId}
                      id={leafId}
                      label={leafLabel(leafId)}
                      rightLabel={String(typeCounts.get(leafId) ?? 0)}
                      state={stateOf(leafId)}
                      onInclude={() => toggleLeafInclude(leafId)}
                      onExclude={() => toggleLeafExclude(leafId)}
                      indent={16}
                    />
                  ))
                : null}
            </div>
          );
        })}
      </div>
      {multiFilterActive(typeFilter) ? (
        <button
          type="button"
          onClick={() => onTypeFilterChange(emptyMulti<string>())}
          className="border-t border-border-subtle px-2 py-1.5 text-left text-caption text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {t("library.toolbar.clearThisFilter")}
        </button>
      ) : null}
    </div>
  );
}

/* ───────────────── Rating picker ───────────────── */

interface RatingPickerProps {
  value: ReadonlySet<RatingValue>;
  onChange: (next: ReadonlySet<RatingValue>) => void;
}

function RatingPicker({ value, onChange }: RatingPickerProps) {
  const t = useT();
  const toggle = (id: RatingValue) => {
    const next = new Set(value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };
  return (
    <div className="flex flex-col">
      {RATING_IDS.map((id) => {
        const selected = value.has(id);
        const label = ratingLabel(t, id);
        return (
          <button
            key={id}
            type="button"
            onClick={() => toggle(id)}
            className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-muted"
          >
            <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center border border-border-subtle bg-background">
              {selected ? <Check className="h-3 w-3 text-primary" /> : null}
            </span>
            {/* 별점 라벨은 ★ 글리프 정렬을 위해 font-mono 유지. "None" 은
                의미 텍스트라 본문과 같은 Pretendard (default) 로 — 별점들
                사이에서 본문 폰트로 자연스럽게 읽히도록. */}
            <span
              className={cn(
                id === "none"
                  ? "text-muted-foreground"
                  : "font-mono text-amber-500",
              )}
            >
              {label}
            </span>
          </button>
        );
      })}
      {value.size > 0 ? (
        <button
          type="button"
          onClick={() => onChange(new Set())}
          className="border-t border-border-subtle px-2 py-1.5 text-left text-caption text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {t("library.toolbar.clearThisFilter")}
        </button>
      ) : null}
    </div>
  );
}

/* ───────────────── Shape picker ───────────────── */

interface ShapePickerProps {
  value: ReadonlySet<ShapeValue>;
  onChange: (next: ReadonlySet<ShapeValue>) => void;
}

function ShapePicker({ value, onChange }: ShapePickerProps) {
  const t = useT();
  const toggle = (id: ShapeValue) => {
    const next = new Set(value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };
  return (
    <div className="flex flex-col">
      {SHAPE_OPTIONS_STATIC.map((option) => {
        const selected = value.has(option.id);
        const Icon = option.icon;
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => toggle(option.id)}
            className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-muted"
          >
            <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center border border-border-subtle bg-background">
              {selected ? <Check className="h-3 w-3 text-primary" /> : null}
            </span>
            <Icon className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="flex-1 truncate">{t(option.key)}</span>
          </button>
        );
      })}
      {value.size > 0 ? (
        <button
          type="button"
          onClick={() => onChange(new Set())}
          className="border-t border-border-subtle px-2 py-1.5 text-left text-caption text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {t("library.toolbar.clearThisFilter")}
        </button>
      ) : null}
    </div>
  );
}

/* ───────────────── Note picker ───────────────── */

interface NotePickerProps {
  value: NoteFilterState;
  onChange: (next: NoteFilterState) => void;
}

function NotePicker({ value, onChange }: NotePickerProps) {
  const t = useT();
  const modes: Array<{ id: NoteFilterState["mode"]; label: string }> = [
    { id: "all", label: t("library.note.all") },
    { id: "with", label: t("library.note.hasNote") },
    { id: "without", label: t("library.note.empty") },
  ];
  return (
    <div className="flex flex-col">
      {modes.map((mode) => (
        <button
          key={mode.id}
          type="button"
          onClick={() => onChange({ ...value, mode: mode.id })}
          className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-muted"
        >
          <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center border border-border-subtle bg-background">
            {value.mode === mode.id ? <Check className="h-3 w-3 text-primary" /> : null}
          </span>
          <span className="flex-1">{mode.label}</span>
        </button>
      ))}
      {/* Keyword 검색 — Search folders... 와 동일한 양식. 별도 라벨은 본문
          Pretendard 로 자연스럽게 읽히도록 대소문자 유지 (uppercase 제거,
          font-mono 제거). 입력칸 자체는 좌측 Search 아이콘 + 보더 래퍼로 묶어
          "여기 클릭해서 입력하는 곳" 임이 시각적으로 명확하게 인지되도록. */}
      <div className="border-t border-border-subtle p-2">
        <div className="mb-1 text-2xs text-muted-foreground">{t("library.toolbar.searchKeywordLabel")}</div>
        <div className="flex items-center gap-1.5 border border-border-subtle bg-background px-2">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            value={value.keyword}
            onChange={(event) => onChange({ ...value, keyword: event.target.value })}
            placeholder={t("library.toolbar.searchNotePlaceholder")}
            className="h-7 flex-1 bg-transparent text-caption outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>
      {value.mode !== "all" || value.keyword.length > 0 ? (
        <button
          type="button"
          onClick={() => onChange(EMPTY_NOTE_FILTER)}
          className="border-t border-border-subtle px-2 py-1.5 text-left text-caption text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {t("library.toolbar.clearThisFilter")}
        </button>
      ) : null}
    </div>
  );
}

/* ───────────────── Color wheel icon ─────────────────
 * Color 칩 좌측에 표시할 레인보우 컬러휠. Lucide 의 단색 Palette 아이콘
 * 대신 conic-gradient + radial mask 로 도넛 형태를 만들어 "이건 컬러
 * 필터다" 라는 신호를 강하게 준다. 가운데 구멍은 mask 로 진짜로 비워
 * 두기 때문에 어떤 배경(툴바 색)에서도 자연스럽게 비쳐 보인다.
 *
 * active 상태에서도 칩의 text-primary 색에 영향받지 않도록 background
 * 와 mask 만 사용 — currentColor 의존 없음. */
function ColorWheelIcon({ color }: { color?: string | null }) {
  // 색이 선택되면 그 hex 로 그라데이션(짙음→옅음)을, 없으면 무채색을 그린다.
  // stopOpacity 방식이라 임의 hex 에도 색 계산 없이 자연스러운 그라데이션이 난다.
  const gradId = color ? "colorWheelTint" : "colorWheelGray";
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className="inline-block h-3.5 w-3.5 flex-shrink-0"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
          {color ? (
            <>
              <stop offset="0%" stopColor={color} stopOpacity={1} />
              <stop offset="100%" stopColor={color} stopOpacity={0.35} />
            </>
          ) : (
            <>
              <stop offset="0%" stopColor="#ededed" />
              <stop offset="100%" stopColor="#5a5a5a" />
            </>
          )}
        </linearGradient>
      </defs>
      <circle
        cx="8"
        cy="8"
        r="5.25"
        fill="none"
        stroke={`url(#${gradId})`}
        strokeWidth="3.75"
      />
    </svg>
  );
}

/* ───────────────── Toolbar props / main component ───────────────── */

export interface LibraryToolbarProps {
  filteredCount: number;
  totalCount: number;
  isCapped: boolean;
  gridSize: number;
  onGridSizeChange: (size: number) => void;
  viewMode: LibraryViewMode;
  onViewModeChange: (mode: LibraryViewMode) => void;
  /** 그리드뷰 전용 숨김 항목을 노출할지(전역). 켜면 숨긴 항목이 흐릿하게 보이고
   *  우클릭으로 해제할 수 있다. */
  showHidden: boolean;
  onToggleShowHidden: () => void;
  /** 현재 숨겨진 항목 수 — 토글 버튼 활성/배지 표시에 사용. */
  hiddenCount: number;
  /** 폴더 컨텍스트일 때만 "canvas" 메뉴 항목을 노출하기 위한 게이트.
   *  null 이면 Canvas 옵션은 메뉴에서 숨김 (`viewMode === "canvas"` 상태에서
   *  폴더를 벗어난 경우는 LibraryPage 의 useEffect 가 자동으로 grid 로 폴백). */
  activeFolderTag: string | null;

  /* 계층형 Types 필터 — 카테고리(image/video/doc/url) + 리프(포맷/플랫폼/기타)를
     단일 MultiFilter<string> 로 표현(typeFilter.ts). */
  typeFilter: MultiFilter<string>;
  onTypeFilterChange: (next: MultiFilter<string>) => void;
  /** 카테고리 id + 리프 id 별 항목 카운트 — LibraryPage 의 computeTypeCounts 결과. */
  typeCounts: ReadonlyMap<string, number>;
  tagsFilter: MultiFilter<string>;
  onTagsFilterChange: (next: MultiFilter<string>) => void;
  /** Moods 칩 — `ai.mood_labels` 기반 multi-select. row.id 는 lowercase EN
   *  canonical 한 줄로 통일되어 있고, picker 라벨만 effectiveAiTagLanguage
   *  에 따라 EN/KO 로 렌더된다. tagsFilter 와 직교 — 같이 활성이면 두 조건이
   *  AND 결합. */
  moodsFilter: MultiFilter<string>;
  onMoodsFilterChange: (next: MultiFilter<string>) => void;
  /** Moods 칩 옵션 행. LibraryPage 의 `moodCountsList(activeItems, lang)` 가
   *  생성한다. row.id = lowercase EN, label = lang 에 따라 EN/KO. */
  moodRows: LibraryFilterRow[];
  foldersFilter: MultiFilter<string>;
  onFoldersFilterChange: (next: MultiFilter<string>) => void;
  ratingsFilter: ReadonlySet<RatingValue>;
  onRatingsFilterChange: (next: ReadonlySet<RatingValue>) => void;
  shapesFilter: ReadonlySet<ShapeValue>;
  onShapesFilterChange: (next: ReadonlySet<ShapeValue>) => void;
  noteFilter: NoteFilterState;
  onNoteFilterChange: (next: NoteFilterState) => void;
  /** Color 필터 — 단일 hex (예: "#1e88e5") 또는 null(=비활성).
   *  활성화 시 LibraryPage 가 자동으로 정렬을 "색상 일치도" 로 전환한다. */
  colorFilter: string | null;
  onColorFilterChange: (next: string | null) => void;

  /** Mood AI 필터(Phase C) — 자연어 → BriefSignals 로 확장된 스펙. null
   *  이면 비활성. 활성 상태에서는 LibraryPage 가 정렬을 score desc 로 강제
   *  하고 score < minScore 인 자료는 자동 탈락. */
  moodFilter: MoodFilterSpec | null;
  onMoodFilterChange: (next: MoodFilterSpec | null) => void;

  /** 라이브러리 자료 전체의 매칭 가능 토큰 union Set.
   *  MoodFilterChip 의 신호 칩 노출 단에서 "이 LLM 토큰이 어느 자료에라도
   *  실제 매치 되는가" 를 O(1) 로 판정해 0건 칩을 자동 숨김 처리한다.
   *  점수 계산엔 영향 없음 — 단순 표시 잡음 제거용. */
  moodInventoryTokens?: ReadonlySet<string>;

  tagRows: LibraryFilterRow[];
  folderRows: LibraryFolderRow[];

  /** 라이브러리 EN↔KO 별칭 인덱스 — Tags 칩 피커에서 한글 입력 시 영어
   *  태그 row 를 alias 매칭으로 필터링하는 데 사용. 인덱스가 비어 있어도
   *  안전(영어 substring 매칭으로 그대로 폴백). */
  koreanAliasIndex?: KoreanTagAliasIndex;

  sortKey: LibrarySortKey;
  onSortKeyChange: (key: LibrarySortKey) => void;
  sortOrder: LibrarySortOrder;
  onSortOrderChange: (order: LibrarySortOrder) => void;

  onClearFilters: () => void;
  selectedCount: number;
  storageUsageLabel?: string;
  canExportProject: boolean;
  onRefreshStorageUsage: () => void;
  onCleanupOrphans: () => void;
  onImportPack: () => void;
  onExportSelected: () => void;
  onExportFiltered: () => void;
  onExportAll: () => void;
  onExportProject: () => void;

  /** Phase D5: 분류 큐 상태. pending+running 가 0 이면 pill 이 자동
   *  숨겨진다 — 평시 노이즈 0. */
  classifyQueue?: ClassifyQueueSnapshot;
  /** 현재 활성 프로젝트 컨텍스트 — 라이브러리에서 attach 시 자동 사용되는
   *  projectId 와 그 표시용 title. 있으면 우상단에 칩으로 표시 → 사용자가
   *  "지금 어느 프로젝트로 attach 되는지" 한눈에 알 수 있다. 클릭하면 그
   *  프로젝트로 돌아간다. null 이면 chip 숨김 (라이브러리 단독 진입 상태). */
}

export function LibraryToolbar({
  filteredCount,
  totalCount,
  isCapped,
  gridSize,
  onGridSizeChange,
  viewMode,
  onViewModeChange,
  showHidden,
  onToggleShowHidden,
  hiddenCount,
  activeFolderTag,
  typeFilter,
  onTypeFilterChange,
  typeCounts,
  tagsFilter,
  onTagsFilterChange,
  moodsFilter,
  onMoodsFilterChange,
  moodRows,
  foldersFilter,
  onFoldersFilterChange,
  ratingsFilter,
  onRatingsFilterChange,
  shapesFilter,
  onShapesFilterChange,
  noteFilter,
  onNoteFilterChange,
  colorFilter,
  onColorFilterChange,
  moodFilter,
  onMoodFilterChange,
  moodInventoryTokens,
  tagRows,
  folderRows,
  koreanAliasIndex,
  sortKey,
  onSortKeyChange,
  sortOrder,
  onSortOrderChange,
  onClearFilters,
  selectedCount,
  storageUsageLabel,
  canExportProject,
  onRefreshStorageUsage,
  onCleanupOrphans,
  onImportPack,
  onExportSelected,
  onExportFiltered,
  onExportAll,
  onExportProject,
  classifyQueue,
}: LibraryToolbarProps) {
  const t = useT();

  // 폴더 태그(`folder:` 접두)는 Tags 칩에선 빼고 Folder 칩이 따로 다룬다.
  // row.source === "ai" 이면 sparkle 마커로 노출 — 사용자가 머지한 적은 없는
  // 순수 AI 제안 토큰이라는 의미. 기본값(undefined / "user")은 마커 없음.
  const tagOptionRows: Array<OptionRow<string>> = useMemo(
    () =>
      tagRows
        .filter((row) => !row.id.startsWith("folder:"))
        .map((row) => ({
          id: row.id,
          label: row.label,
          count: row.count,
          aiSuggested: row.source === "ai",
        })),
    [tagRows],
  );

  /* Moods 픽커 옵션 — row.id = lowercase EN canonical, label = lang 의존.
     mood_labels 는 acceptReferenceAiSuggestions 가 머지하지 않는 의도된
     정책(referenceAi.ts 854) 때문에 사실상 모두 AI 분류 결과다. row 단위
     sparkle 마커는 의미 없으니 칩 자체에 Drama 아이콘(희극/비극 마스크)으로
     "감정·분위기 카탈로그" 시그널을 준다. */
  const moodOptionRows: Array<OptionRow<string>> = useMemo(
    () =>
      moodRows.map((row) => ({
        id: row.id,
        label: row.label,
        count: row.count,
      })),
    [moodRows],
  );

  const folderOptionRows: Array<OptionRow<string>> = useMemo(
    () =>
      folderRows
        // 브리프 매치 루트 컨테이너는 폴더 필터에서 숨긴다(하위만 단일 폴더로 노출).
        .filter((row) => normalizeFolderPath(row.tag) !== BRIEF_MATCH_ROOT)
        .map((row) => {
          const path = normalizeFolderPath(row.tag);
          const brief = isBriefMatchPath(path);
          return {
            id: row.tag,
            label: row.label,
            count: row.count,
            // 브리프 매치 폴더는 루트 아래 indent 를 제거해 단일 폴더처럼 보이게.
            depth: brief ? Math.max(0, (row.depth ?? 0) - 1) : row.depth,
            icon: Folder,
            // 스마트 브리프 매치 폴더는 레드 컬러.
            iconClassName: brief ? "text-red-500" : undefined,
          };
        }),
    [folderRows],
  );

  const sortOption = SORT_OPTIONS_STATIC.find((option) => option.id === sortKey);
  const sortLabel = sortOption ? t(sortOption.key) : t("library.sort.recent");
  const SortArrow = sortOrder === "asc" ? ArrowUpAZ : ArrowDownAZ;

  const noteCount =
    (noteFilter.mode !== "all" ? 1 : 0) + (noteFilter.keyword.trim().length > 0 ? 1 : 0);

  // 툴바 높이 48px — Project Dashboard 의 메인 바와 동일한 치수. 좌측 사이드바
  // 검색 헤더(48px) 와 같은 라인 위에 정확히 정렬되어 border-b 가 패널 경계 너머로
  // 한 줄로 이어지게 만든다.
  return (
    <div
      className="flex flex-shrink-0 items-center gap-2 border-b border-border-subtle bg-surface-nav px-4"
      style={{ height: 48 }}
    >
      {/* ── 좌측 필터 칩 그룹 ───────────────────────────────────
          self-stretch 가 핵심 — overflow-x-auto 가 자식의 vertical overflow
          까지 같이 클리핑해 버리기 때문에, 컨테이너 높이를 툴바 전체(48px)
          로 늘려 active 칩 우상단의 × 버튼(-top-1.5) 이 잘리지 않도록
          한다. 칩 자체는 items-center 로 여전히 수직 중앙 정렬. */}
      <div className="flex flex-1 items-center gap-1 self-stretch overflow-x-auto">
        {/* Mood AI 칩(C) — 가장 강력한 의미 검색이라 좌측 1번 자리. 비활성
            상태에서도 칩이 보이지만, 활성 시 amber 톤 + 라벨이 "Mood: ..."
            로 바뀌어 다른 칩과 시각적으로 분리된다. */}
        <MoodFilterChip
          spec={moodFilter}
          onChange={onMoodFilterChange}
          inventoryTokens={moodInventoryTokens}
          matchedCount={filteredCount}
        />
        <FilterChipShell
          icon={Palette}
          iconNode={<ColorWheelIcon color={colorFilter} />}
          label={t("library.filter.color")}
          count={colorFilter ? 1 : 0}
          active={!!colorFilter}
          popoverContent={
            <ColorPicker value={colorFilter} onChange={onColorFilterChange} />
          }
          contentWidth={232}
          onClear={() => onColorFilterChange(null)}
        />
        <FilterChipShell
          icon={Hash}
          label={t("library.filter.tags")}
          count={multiFilterCount(tagsFilter)}
          active={multiFilterActive(tagsFilter)}
          popoverContent={
            <MultiPicker
              value={tagsFilter}
              onChange={onTagsFilterChange}
              rows={tagOptionRows}
              searchPlaceholder={t("library.toolbar.searchTagsPlaceholder")}
              koreanAliasIndex={koreanAliasIndex}
              koreanAliasMode="tags"
            />
          }
          contentWidth={260}
          onClear={() => onTagsFilterChange(emptyMulti<string>())}
        />
        {/* Moods 칩 — `ai.mood_labels` 라벨 multi-picker. Mood AI(NL) 칩과는
            의도적으로 분리: NL 칩은 자유 문장 → BriefSignals 점수 매칭, Moods
            칩은 라이브러리에 *실제로 존재하는* mood 라벨만 카탈로그로 노출해
            "내 자료에 어떤 무드가 있지?" 를 즉시 둘러볼 수 있게 한다.
            moodOptionRows 가 비어 있으면(=AI 분류된 자료 없음) 카운트 배지가
            0 이라 칩이 시각적으로 비어 보이지만, 클릭 시 빈 picker 가 열려
            "AI 분류를 돌리세요" 의미는 자연 전달된다. */}
        <FilterChipShell
          icon={Drama}
          label={t("library.filter.moods")}
          count={multiFilterCount(moodsFilter)}
          active={multiFilterActive(moodsFilter)}
          popoverContent={
            <MultiPicker
              value={moodsFilter}
              onChange={onMoodsFilterChange}
              rows={moodOptionRows}
              searchPlaceholder={t("library.toolbar.searchMoodsPlaceholder")}
              emptyLabel={t("library.toolbar.noMoodsClassified")}
              koreanAliasIndex={koreanAliasIndex}
              koreanAliasMode="moods"
            />
          }
          contentWidth={240}
          onClear={() => onMoodsFilterChange(emptyMulti<string>())}
        />
        <FilterChipShell
          icon={Folder}
          label={t("library.filter.folder")}
          count={multiFilterCount(foldersFilter)}
          active={multiFilterActive(foldersFilter)}
          popoverContent={
            <MultiPicker
              value={foldersFilter}
              onChange={onFoldersFilterChange}
              rows={folderOptionRows}
              searchPlaceholder={t("library.toolbar.searchFoldersPlaceholder")}
              emptyLabel={t("library.toolbar.noFolders")}
            />
          }
          contentWidth={280}
          onClear={() => onFoldersFilterChange(emptyMulti<string>())}
        />
        <FilterChipShell
          icon={Star}
          label={t("library.filter.rating")}
          count={ratingsFilter.size}
          active={ratingsFilter.size > 0}
          popoverContent={<RatingPicker value={ratingsFilter} onChange={onRatingsFilterChange} />}
          contentWidth={200}
          onClear={() => onRatingsFilterChange(new Set())}
        />
        <FilterChipShell
          icon={FileType2}
          label={t("library.filter.types")}
          count={multiFilterCount(typeFilter)}
          active={multiFilterActive(typeFilter)}
          popoverContent={
            <TypesHierarchyPicker
              typeFilter={typeFilter}
              onTypeFilterChange={onTypeFilterChange}
              typeCounts={typeCounts}
            />
          }
          contentWidth={240}
          onClear={() => onTypeFilterChange(emptyMulti<string>())}
        />
        <FilterChipShell
          icon={MessageSquare}
          label={t("library.filter.note")}
          count={noteCount}
          active={noteCount > 0}
          popoverContent={<NotePicker value={noteFilter} onChange={onNoteFilterChange} />}
          contentWidth={240}
          onClear={() => onNoteFilterChange(EMPTY_NOTE_FILTER)}
        />
        <FilterChipShell
          icon={Layers}
          label={t("library.filter.shape")}
          count={shapesFilter.size}
          active={shapesFilter.size > 0}
          popoverContent={<ShapePicker value={shapesFilter} onChange={onShapesFilterChange} />}
          contentWidth={220}
          onClear={() => onShapesFilterChange(new Set())}
        />
        {/* Eagle 의 "+ 더 많은 필터" 슬롯 — 시각 패리티만. 실제 동작은 후속
            작업이라 disabled 로 둔다. */}
        <Button
          variant="ghost"
          className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
          title={t("library.toolbar.moreFilters")}
          disabled
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* ── 우측 액션 그룹 ────────────────────────────────────── */}
      <div className="flex items-center gap-2">

        {/* Phase D5: 분류 큐 상태 pill. pending+running 가 0 일 때는 자체
            적으로 null 을 그려 자리를 차지하지 않는다 — 평시 노이즈 0.
            라벨은 i18n, title 은 상세 (pending/running 분리) 제공. */}
        {classifyQueue && (classifyQueue.pending > 0 || classifyQueue.running > 0) ? (
          <span
            className="inline-flex h-8 items-center gap-1.5 rounded-none border border-amber-500/30 bg-amber-500/10 px-2 text-caption text-amber-200"
            title={t("library.folderAi.classifyingPillTitle", {
              running: classifyQueue.running,
              pending: classifyQueue.pending,
            })}
          >
            <Sparkles className="h-3 w-3 animate-pulse" aria-hidden />
            <span>
              {t("library.folderAi.classifyingPill", {
                n: classifyQueue.pending + classifyQueue.running,
              })}
            </span>
          </span>
        ) : null}

        {/* View 토글 — Grid / List / Canvas. 이전엔 ⋯ 드롭다운 안에 묻혀 있었
            지만 Canvas 뷰가 핵심 기능으로 강화되어 메인 바로 승격. Canvas 옵션
            은 폴더 컨텍스트일 때만 노출 (`activeFolderTag` 가 null 이면 hide).
            세그먼티드 토글 — 한 번에 한 모드만 active.
            이 그룹은 lg 이상에서만 표시. 좁은 화면에선 ⋯ 메뉴 fallback 이 ...
            아니라(드롭다운 View 항목은 제거됨) 의도적으로 보이지 않는다 —
            모바일 케이스는 v1 비범위. */}
        <div
          className="hidden h-8 items-center rounded-md border bg-card p-px sm:flex"
          role="tablist"
          aria-label={t("library.menu.view")}
        >
          <ViewModeToggleButton
            mode="grid"
            current={viewMode}
            onClick={onViewModeChange}
            title={formatTitleShortcuts(`${t("library.menu.gridView")} (Ctrl+1)`)}
          >
            <Grid2X2 className="h-3.5 w-3.5" />
          </ViewModeToggleButton>
          <ViewModeToggleButton
            mode="list"
            current={viewMode}
            onClick={onViewModeChange}
            title={formatTitleShortcuts(`${t("library.menu.listView")} (Ctrl+2)`)}
          >
            <List className="h-3.5 w-3.5" />
          </ViewModeToggleButton>
          {activeFolderTag ? (
            <ViewModeToggleButton
              mode="canvas"
              current={viewMode}
              onClick={onViewModeChange}
              title={formatTitleShortcuts(`${t("library.menu.canvasView")} (Ctrl+3)`)}
            >
              <LayoutDashboard className="h-3.5 w-3.5" />
            </ViewModeToggleButton>
          ) : null}
        </div>

        {/* 그리드 숨김 항목 표시 토글 — 숨긴 항목이 있을 때만 노출. ON 이면 숨긴
            항목이 흐릿하게 보이고 우클릭으로 해제 가능. 캔버스 숨김과는 무관. */}
        {hiddenCount > 0 || showHidden ? (
          <button
            type="button"
            onClick={onToggleShowHidden}
            title={showHidden ? t("library.toolbar.hideHiddenItems") : t("library.toolbar.showHiddenItems")}
            aria-pressed={showHidden}
            className={cn(
              "hidden h-8 items-center gap-1 rounded-md border px-2 text-caption sm:flex",
              showHidden
                ? "border-primary bg-primary/15 text-foreground"
                : "bg-card text-muted-foreground hover:bg-accent",
            )}
          >
            {showHidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
            {hiddenCount > 0 ? <span className="tabular-nums">{hiddenCount}</span> : null}
          </button>
        ) : null}

        {/* 썸네일 크기 슬라이더 — Conti 탭의 슬라이더와 동일한 패턴.
            Minus / Plus 클릭으로 step 만큼 이동, 트랙 accent 는 브랜드
            레드(#f9423a). 외곽 박스/아이콘 라벨 없이 컴팩트하게.
            캔버스 모드에서는 카드 크기가 자유 배치 transform 으로 결정되어
            이 슬라이더가 무의미하므로 회색 + 클릭 불가(disabled) 로 둔다. */}
        <div
          className={cn(
            "hidden items-center gap-1.5 lg:flex",
            viewMode === "canvas" && "pointer-events-none opacity-40",
          )}
          aria-disabled={viewMode === "canvas"}
          title={
            viewMode === "canvas"
              ? t("library.toolbar.thumbnailSizeDisabledCanvas")
              : t("library.toolbar.thumbnailSizeTitle", { size: gridSize })
          }
        >
          <Minus
            className={cn(
              "h-3 w-3 text-muted-foreground",
              viewMode === "canvas"
                ? "cursor-not-allowed"
                : "cursor-pointer hover:text-foreground",
            )}
            onClick={() => {
              if (viewMode === "canvas") return;
              onGridSizeChange(Math.max(140, gridSize - 20));
            }}
          />
          <input
            aria-label={t("library.toolbar.thumbnailSizeAria")}
            type="range"
            min={140}
            max={360}
            step={20}
            value={gridSize}
            disabled={viewMode === "canvas"}
            onChange={(event) => onGridSizeChange(Number(event.target.value))}
            /* w-40(160px) — 12단계(140~360 step 20) 를 한 칸에 약 13px 씩
               할애한다. 기존 w-16(64px) 은 한 칸이 5px 정도라 미세 조정이
               어렵고 트랙도 너무 짧아 보였다. lg 미만 화면에서는 부모 div 가
               통째로 hidden 이므로 폭을 늘려도 좁은 창에서 토올바를 침해하지
               않는다. */
            className="w-40 accent-primary disabled:cursor-not-allowed"
          />
          <Plus
            className={cn(
              "h-3 w-3 text-muted-foreground",
              viewMode === "canvas"
                ? "cursor-not-allowed"
                : "cursor-pointer hover:text-foreground",
            )}
            onClick={() => {
              if (viewMode === "canvas") return;
              onGridSizeChange(Math.min(360, gridSize + 20));
            }}
          />
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className="h-8 gap-1.5 px-2 text-caption"
              title={t("library.sort.byTitle", { label: sortLabel, order: sortOrder.toUpperCase() })}
            >
              <SortArrow className="h-3.5 w-3.5" />
              <span>{sortLabel}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44 rounded-none">
            <DropdownMenuLabel className="px-2 py-1 text-2xs font-medium text-muted-foreground">
              {t("library.sort.byHeader")}
            </DropdownMenuLabel>
            {SORT_OPTIONS_STATIC.map((option) => (
              <DropdownMenuItem
                key={option.id}
                className="px-2 py-1 text-caption"
                onSelect={() => onSortKeyChange(option.id)}
              >
                <span className="flex-1">{t(option.key)}</span>
                {sortKey === option.id ? <Check className="h-3 w-3 text-primary" /> : null}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="px-2 py-1 text-caption"
              onSelect={() => onSortOrderChange(sortOrder === "asc" ? "desc" : "asc")}
            >
              {sortOrder === "asc" ? (
                <>
                  <ArrowDownAZ className="mr-2 h-3 w-3" />
                  {t("library.sort.switchToDesc")}
                </>
              ) : (
                <>
                  <ArrowUpAZ className="mr-2 h-3 w-3" />
                  {t("library.sort.switchToAsc")}
                </>
              )}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="hidden items-center gap-1 font-mono text-2xs text-muted-foreground xl:flex">
          <span>{filteredCount}</span>
          <span className="text-muted-foreground/40">/</span>
          <span>{totalCount}</span>
          {isCapped ? <span className="text-amber-500">{t("library.toolbar.capped")}</span> : null}
        </div>

        {/* ⋯ 오버플로 케밥 — View / Storage / Cleanup / Import / Export /
            Clear filters. Eagle 의 우상단 액션을 한 메뉴로 묶어 툴바를
            가볍게 유지한다. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="h-8 w-8 p-0" title={t("library.toolbar.moreActions")}>
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52 rounded-none">
            {/* View 토글(Grid/List/Canvas)은 toolbar 메인 바의 segmented
                컨트롤로 승격됐다(이 파일 ~1530). 드롭다운에는 더 이상 두지
                않아 메뉴가 가벼워지고 사용자가 한눈에 현재 뷰를 인지한다. */}
            <DropdownMenuLabel className="px-2 py-1 text-caption font-medium text-muted-foreground">
              {t("library.menu.maintenance")}
            </DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={(event: Event) => {
                event.preventDefault();
                onRefreshStorageUsage();
              }}
            >
              <HardDrive className="mr-2 h-3.5 w-3.5" />
              <span className="flex-1">{storageUsageLabel ?? t("library.menu.storageMissing")}</span>
              <RefreshCw className="ml-2 h-3.5 w-3.5 text-muted-foreground" />
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onCleanupOrphans}>
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              {t("library.menu.cleanupOrphans")}
            </DropdownMenuItem>

            <DropdownMenuSeparator />
            <DropdownMenuLabel className="px-2 py-1 text-caption font-medium text-muted-foreground">
              {t("library.menu.transfer")}
            </DropdownMenuLabel>
            <DropdownMenuItem onSelect={onImportPack}>
              <PackageOpen className="mr-2 h-3.5 w-3.5" />
              {t("library.menu.importPack")}
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Download className="mr-2 h-3.5 w-3.5" />
                {t("library.menu.export")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-52 rounded-none">
                <DropdownMenuItem
                  disabled={selectedCount === 0}
                  onSelect={onExportSelected}
                >
                  {t("library.menu.exportSelected", { n: selectedCount })}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={filteredCount === 0}
                  onSelect={onExportFiltered}
                >
                  {t("library.menu.exportFiltered", { n: filteredCount })}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={totalCount === 0}
                  onSelect={onExportAll}
                >
                  {t("library.menu.exportAll")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={!canExportProject}
                  onSelect={onExportProject}
                >
                  {t("library.menu.exportProjectLinked")}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onClearFilters}>
              <Eraser className="mr-2 h-3.5 w-3.5" />
              {t("library.toolbar.clearAllFilters")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/** Segmented 뷰 토글 버튼 — Grid/List/Canvas 한 모드. active 면 primary
 *  배경, 아니면 ghost. role=tab 으로 키보드 내비게이션도 자연스럽게. */
function ViewModeToggleButton({
  mode,
  current,
  onClick,
  title,
  children,
}: {
  mode: LibraryViewMode;
  current: LibraryViewMode;
  onClick: (next: LibraryViewMode) => void;
  title: string;
  children: React.ReactNode;
}) {
  const active = current === mode;
  return (
    <Button
      type="button"
      role="tab"
      aria-selected={active}
      variant={active ? "default" : "ghost"}
      size="sm"
      className="h-7 w-7 p-0"
      title={title}
      onClick={() => onClick(mode)}
    >
      {children}
    </Button>
  );
}
