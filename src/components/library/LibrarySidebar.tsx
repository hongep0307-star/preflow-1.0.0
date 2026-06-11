import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Clock,
  Copy,
  HelpCircle,
  Inbox,
  Library,
  Network,
  Pin,
  Search,
  Sparkles,
  Star,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useDroppable } from "@dnd-kit/core";
import { WorkspaceSwitcher } from "@/components/WorkspaceSwitcher";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/uiLanguage";
import { BRIEF_MATCH_ROOT } from "@/lib/briefMatch";
import {
  FOLDER_PREFS_CHANGED_EVENT,
  getAllFolderMeta,
  setAllFoldersExpanded,
  setFolderMeta,
} from "@/lib/folderPreferences";
import {
  FOLDER_MANUAL_ORDER_CHANGED_EVENT,
  getAllFolderManualOrder,
} from "@/lib/folderManualOrder";
import type { SavedFilter } from "@/lib/referenceLibrary";
import { FolderRow } from "./FolderRow";
import { PinnedFolderShortcut } from "./PinnedFolderShortcut";

/** 빈 '스마트 브리프 매치' 섹션의 드롭존 — 일반 폴더를 끌어다 놓으면 브리프 매치
 *  루트(`브리프 매치`)의 자식으로 이동(드롭 타깃이 없어 못 옮기던 문제 해결). */
function BriefMatchEmptyDropZone({ label }: { label: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: `folder:${BRIEF_MATCH_ROOT}` });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "mx-1 px-3 py-3 text-meta text-muted-foreground border border-dashed transition-colors",
        isOver ? "border-primary/60 bg-primary/[0.06] text-foreground" : "border-transparent",
      )}
    >
      {label}
    </div>
  );
}

export type QuickFilter = "all" | "favorites" | "untagged" | "recentlyUsed" | "unclassified" | "variations" | "duplicates" | "trash";

export interface LibraryFilterRow {
  id: string;
  label: string;
  count: number;
  /** Optional 출처 표시 — Tags 칩이 사용자 머지 태그(`user`) 와 AI 가
   *  제안만 한 미수락 태그(`ai`) 를 함께 노출할 때 작은 sparkle 마커로 구분
   *  하기 위해 사용. 기본값은 `user` 로 가정해 기존 호출부(folder rows 등)
   *  는 손대지 않아도 안전. */
  source?: "user" | "ai";
}

export interface LibraryFolderRow extends LibraryFilterRow {
  tag: string;
  depth: number;
  /** 폴더 안 항목의 last_used_at 중 가장 최근 값(ISO string).
   *  Folders 의 "Recently used" 정렬에서 사용. 비어 있으면 한 번도
   *  쓰이지 않았거나 빈 폴더 — 정렬상 뒤로 밀린다. */
  lastUsedAt?: string | null;
}

interface LibrarySidebarProps {
  /** 사이드바 폭 — 부모(LibraryPage) 가 SidebarResizeHandle 과 함께 단일
   *  진실원으로 보유. 기존 하드코딩 260 을 대체. */
  width: number;
  /** 사이드바 헤더의 검색창 — 기존 LibraryToolbar 의 검색을 대체.
   *  Project Dashboard 와 동일한 위치/UX (48px header). */
  query: string;
  onQueryChange: (value: string) => void;
  /** 검색창 바로 아래에 부모가 끼워넣는 슬롯 — 한글 입력 시 영어 태그
   *  추천 칩 행이 여기에 들어간다 (B2). 비활성 상태에서는 null 이라
   *  높이를 차지하지 않게 호출부가 책임진다. */
  searchSuggestSlot?: ReactNode;
  ingestSlot: ReactNode;
  quickFilter: QuickFilter;
  onQuickFilterChange: (filter: QuickFilter) => void;
  savedFilters: SavedFilter[];
  activeSavedFilterId: string | null;
  onSavedFilterChange: (id: string | null) => void;
  folderRows: LibraryFolderRow[];
  activeTag: string | null;
  onTagChange: (tag: string | null) => void;
  /** 그리드가 활성 폴더의 자식 항목까지 포함해 보고 있는지. FolderRow
   *  의 "Show subfolder content" 체크박스 표시 상태에만 사용. 활성
   *  폴더가 아닌 다른 폴더의 행에서는 항상 false 로 표시되어 토글 시
   *  부모(LibraryPage)가 활성화 + recursive on 을 한꺼번에 처리한다. */
  recursiveActiveFolder: boolean;
  onToggleRecursiveActiveFolder: (row: LibraryFolderRow) => void;
  onCreateFolder?: (parentPath?: string) => void;
  onRenameFolder?: (row: LibraryFolderRow) => void;
  onMoveFolder?: (row: LibraryFolderRow) => void;
  onDeleteFolder?: (row: LibraryFolderRow) => void;
  onExportFolder?: (row: LibraryFolderRow) => void;
  /** HTML Viewer Export — Export folder 와 같은 자리에서 read-only viewer
   *  패키지(.zip / .html)로 외부 공유. LibraryPage 가 dialog state 를
   *  세팅해 HtmlExportDialog 를 띄운다. */
  onExportFolderAsHtml?: (row: LibraryFolderRow) => void;
  /** 폴더 복제 — referenceLibrary.duplicateFolder 호출 + prefs 카피 +
   *  목록 reload 까지 부모가 책임짐. UI 단에서는 우클릭 메뉴 호출만. */
  onDuplicateFolder?: (row: LibraryFolderRow) => void;
  /** Phase D: 폴더 단위 AI 자동 분류 설정 다이얼로그를 띄우는 콜백. */
  onOpenFolderAiSettings?: (row: LibraryFolderRow) => void;
  /** Phase D: path → autoClassify 여부 lookup. 부모가
   *  `listFolderAiSettings()` 결과를 가공해 넘긴다. true 인 폴더는 행
   *  라벨 옆에 sparkles 가 표시되고 컨텍스트 메뉴 항목에도 강조 표시. */
  folderAiAutoClassify?: ReadonlySet<string>;
  /** native HTML5 DnD 로 라이브러리 카드 ids 가 폴더 안으로 떨어졌을 때
   *  호출. dnd-kit 시절의 통합 DnD 핸들러 대신 FolderRow 가 직접 native
   *  이벤트를 받아 이 콜백으로 dispatch — 부모가 보통
   *  `handleDropReferencesToFolder(ids, path)` 를 연결한다. */
  onDropReferencesToFolder?: (ids: string[], path: string) => void;

  /** "브리프 매치" 섹션의 + 클릭 — 부모(LibraryPage)가 플라이아웃을 연다.
   *  미전달 시 섹션 자체를 렌더하지 않는다. */
  onOpenBriefMatch?: () => void;
  /** 저장된 브리프 매치 폴더 목록(일반 폴더 트리와 분리되어 이 섹션에만 표시).
   *  일반 폴더와 동일하게 FolderRow 로 렌더 — 드롭/우클릭/카운트 전부 동일. */
  briefMatchFolders?: LibraryFolderRow[];
  /** 브리프 매치 폴더 행의 "프로젝트로 생성" 액션. */
  onCreateProjectFromBriefMatch?: (path: string) => void;

  /** 현재 DnD 가 누구를 끌고 있는가 — folder 행/reference 카드 의 두 종류가
   *  같은 DndContext(LibraryPage 가 보유) 안에서 함께 처리된다. FolderRow
   *  내부 droppable disabled 판정에 사용. null 이면 idle.
   *
   *  ※ 폴더↔폴더 이동/사이클 검증은 모두 부모(LibraryPage)의 통합
   *  DndContext 핸들러가 책임진다 — 사이드바는 더 이상 onDragMoveFolder
   *  prop 을 받지 않는다. */
  activeDragId?: string | null;
  activeDragKind?: "folder" | "reference" | null;
}

interface QuickFilterDef {
  id: QuickFilter;
  /** i18n 키 — 라벨은 렌더 시점에 t() 로 해석한다. */
  labelKey: string;
  icon: LucideIcon;
}

/** Quick Filters — Eagle 의 좌측 상단 항목들과 의미 매핑. 각 항목에
 *  의미가 또렷한 lucide 아이콘을 붙여, 라벨이 줄어도 (사이드바 폭이
 *  좁아져도) 한눈에 식별되게 한다. */
const QUICK_FILTERS: QuickFilterDef[] = [
  { id: "all",           labelKey: "library.sidebar.all",          icon: Library },
  { id: "favorites",     labelKey: "library.sidebar.favorites",    icon: Star },
  { id: "untagged",      labelKey: "library.sidebar.untagged",     icon: Inbox },
  { id: "recentlyUsed",  labelKey: "library.sidebar.recentlyUsed", icon: Clock },
  { id: "unclassified",  labelKey: "library.sidebar.unclassified", icon: HelpCircle },
  { id: "variations",    labelKey: "library.sidebar.variations",   icon: Network },
  { id: "duplicates",    labelKey: "library.sidebar.duplicates",   icon: Copy },
  { id: "trash",         labelKey: "library.sidebar.trash",        icon: Trash2 },
];

/** 사이드바의 한 섹션. 헤더 스타일은 Project Dashboard 의 FAVORITES /
 *  FOLDERS / RECENT 헤더와 동일하게 통일 — `font-semibold tracking-[0.12em]
 *  text-caption text-muted-foreground`. (전체 사이드바 / 네비바 텍스트 1px
 *  업스케일 — 컨텍스트 메뉴 본문 14px 와의 격차를 줄여 한 화면에 같이
 *  보였을 때 사이드바가 유난히 작아 보이던 현상을 완화.)
 *
 *  `titleAction` 은 타이틀 바로 옆(왼쪽 그룹 안)에 두는 작은 액션 슬롯.
 *  Project Dashboard 의 "Folders [+]" 처럼 1차 액션을 라벨에 붙여 둘 때
 *  사용. 우측 정렬되는 보조 액션(`action`) 과는 위치가 분리되므로
 *  같은 헤더에 두 종류의 액션을 자연스럽게 배치할 수 있다. */
function SidebarSection({
  title,
  icon,
  titleAction,
  action,
  divider = false,
  children,
}: {
  title: string;
  icon?: ReactNode;
  titleAction?: ReactNode;
  action?: ReactNode;
  /** 위쪽에 구분선을 그려 인접 메뉴 그룹과 시각적으로 분리한다. */
  divider?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn("mb-3", divider && "mt-1.5")}>
      {/* 메뉴 그룹 제목 — 톤다운(작고·muted). 하위 행은 톤업(약간 밝게)해
          제목↔내용 차이를 작게 유지하면서도 위계는 구분되게. */}
      <div className="mb-1 flex items-center gap-1.5 px-2 text-xs font-semibold tracking-[0.02em] text-muted-foreground">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {icon}
          <span>{title}</span>
          {titleAction}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

export function LibrarySidebar({
  width,
  query,
  onQueryChange,
  searchSuggestSlot,
  ingestSlot,
  quickFilter,
  onQuickFilterChange,
  savedFilters,
  activeSavedFilterId,
  onSavedFilterChange,
  folderRows,
  activeTag,
  onTagChange,
  recursiveActiveFolder,
  onToggleRecursiveActiveFolder,
  onCreateFolder,
  onRenameFolder,
  onMoveFolder,
  onDeleteFolder,
  onExportFolder,
  onExportFolderAsHtml,
  onDuplicateFolder,
  onOpenFolderAiSettings,
  folderAiAutoClassify,
  onDropReferencesToFolder,
  onOpenBriefMatch,
  briefMatchFolders,
  onCreateProjectFromBriefMatch,
  activeDragId = null,
  activeDragKind = null,
}: LibrarySidebarProps) {
  const t = useT();

  // Folder prefs (color/icon/expanded) 와 폴더 manual order 는 별도 storage 라
  // React 상태가 모르므로, 이벤트 구독으로 prefsVersion 을 bump 해
  // visibleFolderRows 와 collapsedAncestors 재계산을 트리거한다. 다른 윈도우의
  // 변경(storage 이벤트) 도 같이 받아 멀티 윈도우 동기화. */
  const [prefsVersion, setPrefsVersion] = useState(0);
  useEffect(() => {
    const sync = () => setPrefsVersion((v) => v + 1);
    const onStorage = (event: StorageEvent) => {
      if (
        event.key === "preflow.library.folderPrefs"
        || event.key === "preflow.library.folderManualOrder"
      ) sync();
    };
    window.addEventListener(FOLDER_PREFS_CHANGED_EVENT, sync);
    window.addEventListener(FOLDER_MANUAL_ORDER_CHANGED_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(FOLDER_PREFS_CHANGED_EVENT, sync);
      window.removeEventListener(FOLDER_MANUAL_ORDER_CHANGED_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // 한 번에 모든 prefs 를 읽어 두고, 행마다 lookup 으로 분배. Object
  // 한 번 읽기로 끝나 O(1) per row.
  // prefsVersion 은 prefs 구독에서 받는 tick counter — getAllFolderMeta()
  // / getAllFolderManualOrder() 둘 다 인자가 없어 ESLint 가 "unnecessary
  // dependency" 라 한다. 의도적으로 tick 변경 시 캐시를 다시 읽어 다른 컴포넌트
  // 의 폴더 prefs 변경을 즉시 반영하려는 패턴이라 dep 을 *유지* 한다.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const allMeta = useMemo(() => getAllFolderMeta(), [prefsVersion]);
  // 폴더 형제 순서(부모별) — sortedVisibleFolderRows 비교에서 사용. 빈 부모는
  // 알파벳 순으로 fallback.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const folderManualOrder = useMemo(() => getAllFolderManualOrder(), [prefsVersion]);

  // 부모 폴더가 collapsed 일 때 자식 행을 숨기기 위한 prefix 매칭 set.
  const collapsedRoots = useMemo(() => {
    const roots: string[] = [];
    for (const row of folderRows) {
      const path = row.tag.replace(/^folder:/, "");
      if (allMeta[path]?.expanded === false) roots.push(path);
    }
    return roots;
  }, [folderRows, allMeta]);

  // depth+1 직계 자식 path 가 하나라도 있는 부모 path 의 set.
  // 화살표(chevron) 노출 여부 결정용.
  const parentPathsWithChildren = useMemo(() => {
    const set = new Set<string>();
    for (const row of folderRows) {
      const path = row.tag.replace(/^folder:/, "");
      const lastSlash = path.lastIndexOf("/");
      if (lastSlash > 0) set.add(path.slice(0, lastSlash));
    }
    return set;
  }, [folderRows]);

  // collapsed root 의 자손은 숨김. root 자체는 표시 (자기 자신은 보여야
  // 다시 펼칠 수 있음).
  const visibleFolderRows = useMemo(() => {
    if (collapsedRoots.length === 0) return folderRows;
    return folderRows.filter((row) => {
      const path = row.tag.replace(/^folder:/, "");
      return !collapsedRoots.some((root) => path.startsWith(`${root}/`));
    });
  }, [folderRows, collapsedRoots]);

  // 모든 폴더 path — Expand all / Collapse all 일괄 적용 대상.
  const allFolderPaths = useMemo(
    () => folderRows.map((row) => row.tag.replace(/^folder:/, "")),
    [folderRows],
  );

  // ─────── Pinned (Quick Access) ───────
  // 본 계층에는 그대로 두고 별도 단축 영역으로 추가 표시. 사이드바
  // 폭이 좁을 때를 대비해 알파벳 정렬로 안정 순서 보장 (sortMode 의
  // 영향을 안 받게 — Pinned 는 사용자가 명시적으로 박은 항목들).
  const pinnedRows = useMemo(() => {
    const out = folderRows.filter((row) => {
      const path = row.tag.replace(/^folder:/, "");
      return allMeta[path]?.pinned === true;
    });
    return out.sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
    );
  }, [folderRows, allMeta]);

  // ─────── 계층 보존 정렬 (Eagle-style 수동 순서) ───────
  // 같은 부모를 가진 형제 폴더끼리 사용자가 드래그로 박아둔 manual order
  // 를 그대로 따른다. manual order 에 등록되지 않은 형제(처음 보는 신규
  // 폴더 등) 는 항상 뒤쪽에 알파벳순으로 모이게 한다 — 한 번도 reorder
  // 하지 않은 깨끗한 상태에선 사실상 알파벳 정렬과 같아 사용자 첫 인상이
  // 안정적이고, reorder 한 폴더만 사용자의 의도대로 박혀 있는 모델.
  // 부모/자식 관계는 절대 깨지지 않으며, depth-first 순서 출력은 동일.
  const sortedVisibleFolderRows = useMemo(() => {
    const childrenMap = new Map<string, LibraryFolderRow[]>();
    for (const row of visibleFolderRows) {
      const path = row.tag.replace(/^folder:/, "");
      const lastSlash = path.lastIndexOf("/");
      const parent = lastSlash > 0 ? path.slice(0, lastSlash) : "";
      const list = childrenMap.get(parent) ?? [];
      list.push(row);
      childrenMap.set(parent, list);
    }
    const sortChildren = (parent: string, list: LibraryFolderRow[]): LibraryFolderRow[] => {
      const order = folderManualOrder[parent] ?? [];
      if (order.length === 0) {
        return [...list].sort((a, b) =>
          a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
        );
      }
      const indexed = new Map<string, number>();
      order.forEach((p, i) => indexed.set(p, i));
      const known: LibraryFolderRow[] = [];
      const unknown: LibraryFolderRow[] = [];
      for (const row of list) {
        const path = row.tag.replace(/^folder:/, "");
        if (indexed.has(path)) known.push(row);
        else unknown.push(row);
      }
      known.sort((a, b) => {
        const ai = indexed.get(a.tag.replace(/^folder:/, "")) ?? Number.MAX_SAFE_INTEGER;
        const bi = indexed.get(b.tag.replace(/^folder:/, "")) ?? Number.MAX_SAFE_INTEGER;
        return ai - bi;
      });
      unknown.sort((a, b) =>
        a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
      );
      return [...known, ...unknown];
    };
    for (const [parent, list] of childrenMap) {
      childrenMap.set(parent, sortChildren(parent, list));
    }
    const out: LibraryFolderRow[] = [];
    const walk = (parent: string) => {
      const list = childrenMap.get(parent) ?? [];
      for (const row of list) {
        out.push(row);
        walk(row.tag.replace(/^folder:/, ""));
      }
    };
    walk("");
    return out;
  }, [visibleFolderRows, folderManualOrder]);

  // ─────── 합산 카운트 (option B). ───────
  // 펼친 폴더는 직속 수만, 접힌 폴더는 자기+모든 자손 수의 합. row.count
  // 는 항상 직속이므로 한 번 path→count Map 으로 인덱싱하고 prefix 매칭.
  const directCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of folderRows) {
      m.set(r.tag.replace(/^folder:/, ""), r.count);
    }
    return m;
  }, [folderRows]);

  const aggregatedCountFor = useCallback(
    (path: string): number => {
      let sum = directCounts.get(path) ?? 0;
      const prefix = `${path}/`;
      for (const [p, c] of directCounts) {
        if (p !== path && p.startsWith(prefix)) sum += c;
      }
      return sum;
    },
    [directCounts],
  );

  // ─────── DnD ───────
  // DnD 컨텍스트는 LibraryPage 가 소유 — 폴더↔폴더, reference→폴더 두 가지
  // 흐름을 한 컨텍스트에서 처리해야 grid 카드를 사이드바 폴더로 떨어뜨릴
  // 수 있다. 따라서 여기선 activeDragId/activeDragKind 만 prop 으로 받아
  // FolderRow 의 droppable disabled 판정에 그대로 흘려보낸다.

  return (
    <aside
      className="flex h-full min-h-0 flex-col flex-shrink-0 border-r border-border-subtle bg-surface-sidebar"
      style={{ width }}
    >
      {/* 검색 헤더 — Project Dashboard 와 동일한 48px 박스. */}
      <div
        className="flex items-center px-3 border-b border-border-subtle flex-shrink-0"
        style={{ height: 48 }}
      >
        <div
          className="flex items-center gap-2 px-3 py-2 bg-surface-panel border border-border-subtle w-full"
          style={{ borderRadius: 0 }}
        >
          <Search className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t("common.search")}
            className="bg-transparent border-none outline-none text-body text-text-secondary placeholder:text-muted-foreground w-full"
          />
          {query && (
            <button onClick={() => onQueryChange("")} type="button">
              <X className="w-3 h-3 text-muted-foreground hover:text-foreground transition-colors" />
            </button>
          )}
        </div>
      </div>

      {/* 한글 검색 → 영어 태그 추천 칩 행 (B2). 호출부가 null 일 땐 자리도
          차지하지 않는다 — 헤더 48px 라인이 그대로 유지되도록.
          내부 px-2 py-2 는 아래 스크롤 영역의 px-2 py-3 와 동일한 좌우
          여백 패턴 — 추천 영역의 "좌측 붉은 바 + 옅은 레드 틴트" 박스가
          Quick filters 의 active row("All") 와 같은 8px 검정 여백을 갖고
          정렬되도록. border-b 는 wrapper 의 바깥쪽에 그대로 두어 사이드바
          전체 구분선(풀폭)은 유지. */}
      {searchSuggestSlot ? (
        <div className="border-b border-border-subtle flex-shrink-0">
          <div className="px-2 py-2">{searchSuggestSlot}</div>
        </div>
      ) : null}

      {/* Add 메뉴 (LibraryAddMenu + 업로드 잡 카드). border-b 는 의도적으로
          제거 — 메인 영역은 검색 헤더(48px) 끝에 한 줄짜리 툴바 라인만
          있으므로, 사이드바에 두 번째 라인을 두면 패널 경계 너머로 라인이
          어긋나 보인다. Project Dashboard 와 동일한 단일 헤더 라인 패턴. */}
      <div className="px-3 py-3 flex-shrink-0">{ingestSlot}</div>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        {/* ── Quick Filters — 각 행에 의미 강한 아이콘 + 라벨. ── */}
        <SidebarSection title={t("library.sidebar.quickFilters")}>
          <div className="space-y-0.5">
            {QUICK_FILTERS.map((row) => {
              // "All Items" 는 사실상 기본값(no-op) 이라 필터 파이프라인
              // 에서 아무 일도 안 한다. 폴더(activeTag)나 Smart Folder
              // (activeSavedFilterId) 가 켜져 있으면 그쪽이 실질 필터이
              // 므로 "All Items" 의 강조는 죽여, 두 줄이 동시에 켜져
              // 보여 사용자가 혼동하는 일을 막는다.
              const isActive =
                quickFilter === row.id &&
                !(row.id === "all" && (activeTag !== null || activeSavedFilterId !== null));
              const Icon = row.icon;
              return (
                <button
                  key={row.id}
                  onClick={() => onQuickFilterChange(row.id)}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-1.5 text-body border-l-2 transition-colors text-left",
                    isActive
                      ? "border-l-primary bg-primary/10 text-foreground"
                      : "border-l-transparent text-foreground/80 hover:text-foreground hover:bg-muted/40",
                  )}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="flex-1 truncate">{t(row.labelKey)}</span>
                </button>
              );
            })}
          </div>
        </SidebarSection>

        {/* ── Brief Match — 브리프를 분석해 어울리는 레퍼런스를 모아 폴더/프로젝트로.
            헤더는 Folders 와 동일하게 아이콘 없이 라벨 + "+" 액션. 폴더가 없으면
            Folders 와 같은 빈 상태 문구로 통일. ── */}
        {onOpenBriefMatch ? (
          <div data-brief-match-section="">
          <SidebarSection
            title={t("library.sidebar.briefMatch")}
            divider
            titleAction={(
              <button
                type="button"
                onClick={onOpenBriefMatch}
                className="flex h-[18px] w-[18px] items-center justify-center border border-border-subtle text-body font-normal leading-none tracking-normal text-muted-foreground transition-all hover:border-primary/50 hover:bg-primary/[0.08] hover:text-primary"
                style={{ borderRadius: 2 }}
                title={t("library.sidebar.briefMatchNew")}
                aria-label={t("library.sidebar.briefMatchNew")}
              >
                +
              </button>
            )}
          >
            {(briefMatchFolders ?? []).length > 0 ? (
              <div className="space-y-0.5">
                {briefMatchFolders!.map((row) => {
                  const path = row.tag.replace(/^folder:/, "");
                  const meta = allMeta[path] ?? {};
                  const isActive = activeTag === row.tag;
                  return (
                    <FolderRow
                      key={row.tag}
                      row={row}
                      isActive={isActive}
                      indentDepth={0}
                      hasChildren={false}
                      meta={meta}
                      isShowingSubfolderContent={isActive && recursiveActiveFolder}
                      displayCount={row.count}
                      isAggregatedCount={false}
                      activeDragId={activeDragId}
                      activeDragKind={activeDragKind}
                      isPinned={meta.pinned === true}
                      hasAiAutoClassify={folderAiAutoClassify?.has(path) ?? false}
                      onToggleActive={() => onTagChange(isActive ? null : row.tag)}
                      onToggleExpanded={() => {}}
                      onCreateSubfolder={() => onCreateFolder?.(path)}
                      onRename={() => onRenameFolder?.(row)}
                      onMove={() => onMoveFolder?.(row)}
                      onExpandAll={() => setAllFoldersExpanded(allFolderPaths, true)}
                      onCollapseAll={() => setAllFoldersExpanded(allFolderPaths, false)}
                      onToggleShowSubfolderContent={() => onToggleRecursiveActiveFolder(row)}
                      onExport={() => onExportFolder?.(row)}
                      onExportAsHtml={() => onExportFolderAsHtml?.(row)}
                      onDelete={() => onDeleteFolder?.(row)}
                      onTogglePin={() => {
                        const current = allMeta[path]?.pinned === true;
                        setFolderMeta(path, { pinned: current ? undefined : true });
                      }}
                      onDuplicate={() => onDuplicateFolder?.(row)}
                      onOpenAiSettings={undefined}
                      onMetaChanged={() => setPrefsVersion((v) => v + 1)}
                      onReferenceDrop={(ids) => onDropReferencesToFolder?.(ids, path)}
                      onCreateProject={
                        onCreateProjectFromBriefMatch ? () => onCreateProjectFromBriefMatch(path) : undefined
                      }
                      createProjectLabel={t("briefMatch.createProject")}
                      compactMenu
                      defaultColorId="red"
                    />
                  );
                })}
              </div>
            ) : (
              <BriefMatchEmptyDropZone label={t("library.sidebar.noFolders")} />
            )}
          </SidebarSection>
          </div>
        ) : null}

        {/* ── Smart Folders — 저장된 검색 — 기존과 동일하되 행에 작은
            Sparkles 보조 아이콘으로 시각적 일관성 유지. ── */}
        {savedFilters.length > 0 ? (
          <SidebarSection title={t("library.sidebar.smartFolders")} icon={<Sparkles className="h-3 w-3" />} divider>
            <div className="space-y-0.5">
              <button
                onClick={() => onSavedFilterChange(null)}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-1.5 text-left text-body border-l-2",
                  // "None" 은 Saved filter 미선택 의 기본 표시 — 폴더가
                  // 활성이면 그 폴더가 실질 필터이므로 같이 켜놓지 않음.
                  activeSavedFilterId === null && activeTag === null
                    ? "border-l-primary bg-primary/10 text-foreground"
                    : "border-l-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                )}
              >
                <Sparkles className="h-3.5 w-3.5 shrink-0 opacity-60" />
                <span className="flex-1 truncate">{t("library.sidebar.smartFolderNone")}</span>
              </button>
              {savedFilters.slice(0, 24).map((filter) => (
                <button
                  key={filter.id}
                  onClick={() => onSavedFilterChange(filter.id)}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-1.5 text-left text-body border-l-2",
                    activeSavedFilterId === filter.id
                      ? "border-l-primary bg-primary/10 text-foreground"
                      : "border-l-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                  )}
                >
                  <Sparkles className="h-3.5 w-3.5 shrink-0 opacity-60" />
                  <span className="flex-1 truncate">{filter.name}</span>
                </button>
              ))}
            </div>
          </SidebarSection>
        ) : null}

        {/* ── Pinned (Quick Access) — 자주 가는 폴더의 평평한 단축.
            본 계층에서도 그대로 보이므로 시각적 중복은 의도적 (Eagle
            Quick Access / VSCode Open Editors 패턴). 1개 이상일 때만
            노출해 평소엔 사이드바를 깔끔히 유지. ── */}
        {pinnedRows.length > 0 ? (
          <SidebarSection title={t("library.sidebar.pinned")} icon={<Pin className="h-3 w-3" />} divider>
            <div className="space-y-0.5">
              {pinnedRows.map((row) => {
                const path = row.tag.replace(/^folder:/, "");
                const meta = allMeta[path] ?? {};
                const isActive = activeTag === row.tag;
                return (
                  <PinnedFolderShortcut
                    key={`pinned:${row.tag}`}
                    row={row}
                    isActive={isActive}
                    meta={meta}
                    onActivate={() => onTagChange(isActive ? null : row.tag)}
                    // 우클릭 "Open folder" 는 토글 X — 이미 활성이면 그대로
                    // 두고, 비활성이면 활성화. 단순/예측가능한 의미.
                    onOpen={() => {
                      if (!isActive) onTagChange(row.tag);
                    }}
                    onUnpin={() => {
                      setFolderMeta(path, { pinned: undefined });
                      setPrefsVersion((v) => v + 1);
                    }}
                  />
                );
              })}
            </div>
          </SidebarSection>
        ) : null}

        {/* ── Folders — 핵심 영역. FolderRow 가 chevron / icon picker /
            label / 우클릭 메뉴를 모두 책임진다. 헤더 자체에는 아이콘을
            두지 않는다 — 폴더 행마다 폴더 아이콘이 이미 노출되므로
            헤더 아이콘은 시각적 중복이라 제거. ── */}
        <SidebarSection
          title={t("library.sidebar.folders")}
          divider
          /* "+" 1차 액션은 타이틀 옆에 붙인다 — Project Dashboard 의
             "Folders [+]" 와 동일한 위치 / 18px bordered 박스 디자인.
             font-normal, tracking-normal 을 명시해 SidebarSection 헤더의
             font-semibold tracking-[0.12em] 상속을 끊고 "+" 글리프가
             가늘고 깔끔하게 보이도록 한다. literal "+" 사용도 dashboard
             와 일치 (Lucide Plus 아이콘 X). */
          titleAction={(
            <button
              type="button"
              onClick={() => onCreateFolder?.()}
              className="flex h-[18px] w-[18px] items-center justify-center border border-border-subtle text-body font-normal leading-none tracking-normal text-muted-foreground transition-all hover:border-primary/50 hover:bg-primary/[0.08] hover:text-primary"
              style={{ borderRadius: 2 }}
              title={t("library.sidebar.createFolder")}
              aria-label={t("library.sidebar.createFolder")}
            >
              +
            </button>
          )}
          /* Folders 헤더의 우측 액션 슬롯은 비워둔다 — 기존의 SORT BY /
             BEHAVIOR popover 는 Eagle 처럼 폴더 순서를 사용자가 직접 드래그로
             정하는 방식으로 대체되었기 때문에 더 이상 필요 없다. 같은 레벨
             자동 접힘 같은 보조 옵션도 함께 제거 — 수동 정렬이 자리 잡으면
             사용자가 트리를 의도대로 박아두는 게 자연스럽고, 자동 접힘이
             오히려 그 의도를 흔든다. */
          action={null}
        >
          {sortedVisibleFolderRows.length > 0 ? (
              <div className="space-y-0.5">
                {sortedVisibleFolderRows.slice(0, 200).map((row) => {
                  const path = row.tag.replace(/^folder:/, "");
                  const meta = allMeta[path] ?? {};
                  const isActive = activeTag === row.tag;
                  // 접혔고 자식이 있으면 합산 카운트(자기+자손).
                  // 그 외에는 직속 카운트만 (= row.count).
                  const isCollapsedAggregated =
                    meta.expanded === false && parentPathsWithChildren.has(path);
                  const displayCount = isCollapsedAggregated
                    ? aggregatedCountFor(path)
                    : row.count;
                  return (
                    <FolderRow
                      key={row.tag}
                      row={row}
                      isActive={isActive}
                      indentDepth={row.depth}
                      hasChildren={parentPathsWithChildren.has(path)}
                      meta={meta}
                      isShowingSubfolderContent={isActive && recursiveActiveFolder}
                      displayCount={displayCount}
                      isAggregatedCount={isCollapsedAggregated}
                      activeDragId={activeDragId}
                      activeDragKind={activeDragKind}
                      isPinned={meta.pinned === true}
                      hasAiAutoClassify={folderAiAutoClassify?.has(path) ?? false}
                      onToggleActive={() => onTagChange(isActive ? null : row.tag)}
                      onToggleExpanded={() => {
                        const current = allMeta[path]?.expanded;
                        const willExpand = current === false; // false → 펼침으로 전환
                        // expanded 의 기본값은 "펼침" 이라, 처음 접을 땐
                        // false 를 명시적으로 박는다. 다시 펼칠 땐 키를
                        // 지워 저장소를 깔끔히 유지 (setFolderMeta 가 빈
                        // 객체일 때 키 삭제 처리).
                        setFolderMeta(path, {
                          expanded: willExpand ? undefined : false,
                        });
                      }}
                      onCreateSubfolder={() => onCreateFolder?.(path)}
                      onRename={() => onRenameFolder?.(row)}
                      onMove={() => onMoveFolder?.(row)}
                      onExpandAll={() => setAllFoldersExpanded(allFolderPaths, true)}
                      onCollapseAll={() => setAllFoldersExpanded(allFolderPaths, false)}
                      onToggleShowSubfolderContent={() => onToggleRecursiveActiveFolder(row)}
                      onExport={() => onExportFolder?.(row)}
                      onExportAsHtml={() => onExportFolderAsHtml?.(row)}
                      onDelete={() => onDeleteFolder?.(row)}
                      onTogglePin={() => {
                        const current = allMeta[path]?.pinned === true;
                        // Pin 해제 시 키를 빼서 storage 비대화 방지.
                        setFolderMeta(path, { pinned: current ? undefined : true });
                      }}
                      onDuplicate={() => onDuplicateFolder?.(row)}
                      onOpenAiSettings={
                        onOpenFolderAiSettings ? () => onOpenFolderAiSettings(row) : undefined
                      }
                      onMetaChanged={() => setPrefsVersion((v) => v + 1)}
                      onReferenceDrop={(ids) => onDropReferencesToFolder?.(ids, path)}
                    />
                  );
                })}
              </div>
            ) : (
              <div className="px-3 py-2 text-meta text-muted-foreground">{t("library.sidebar.noFolders")}</div>
            )}
        </SidebarSection>
      </div>

      {/* Workspace switcher footer (Discord-style switch). */}
      <div className="border-t border-border-subtle p-1.5 flex-shrink-0">
        <WorkspaceSwitcher variant="full" />
      </div>
    </aside>
  );
}
