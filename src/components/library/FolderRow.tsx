import { useCallback, useEffect, useState, type DragEvent, type KeyboardEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FolderInput,
  FolderTree,
  Maximize2,
  Minimize2,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Rocket,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/uiLanguage";
import {
  type FolderMeta,
  clearFolderMeta,
  setFolderMeta,
} from "@/lib/folderPreferences";
import {
  getActiveLibraryDrag,
  getCopyModifier,
  INTERNAL_DRAG_MIME,
  subscribeCopyModifier,
  subscribeDragHover,
  type DropTarget,
} from "@/lib/libraryDragChannel";
import type { LibraryFolderRow } from "./LibrarySidebar";
import { resolveFolderColor, resolveFolderIcon } from "./folderIcons";
import { FolderIconPicker } from "./FolderIconPicker";

/**
 * 사이드바의 폴더 한 행. WorkspaceSwitcher 에서 검증한 "split target"
 * 패턴 — 행 자체는 <div role=button>, 안의 아이콘 버튼은 별도 <button>
 * 으로 두 개의 클릭 타겟을 분리한다 (HTML 은 <button> 중첩 금지).
 *
 * 구성 (왼쪽 → 오른쪽):
 *   [chevron]   자식 폴더가 있으면 표시. 클릭 → expanded 토글.
 *               자식이 없을 땐 visibility:hidden 으로 자리만 차지해
 *               같은 깊이 행끼리 들여쓰기가 어긋나지 않게 한다.
 *   [icon]      좌클릭 → Popover 로 FolderIconPicker. 색·글리프 즉시 변경.
 *   [label]     클릭 → 필터 활성/비활성 (기존 onTagChange 동작).
 *   [count]     해당 폴더의 reference 수 (직속 only — recursive 계산은
 *               `Show subfolder content` 토글이 담당하므로 여기선 X).
 *
 * 행 전체는 ContextMenuTrigger 로 감싸 우클릭 메뉴를 띄운다 — 메뉴
 * 내용은 Eagle 의 균형 잡힌 부분집합 (플랜 참고).
 */

export interface FolderRowProps {
  row: LibraryFolderRow;
  /** 이 폴더가 현재 활성 필터인가 (그리드가 이 폴더 내용을 보고 있나). */
  isActive: boolean;
  /** 행에 좌측 들여쓰기를 더할 깊이. row.depth 와 동일하지만 명시적으로
   *  prop 화해 미래에 가상화 등으로 깊이를 다른 식으로 산출할 여지를
   *  남겨둔다. */
  indentDepth: number;
  /** 자식 폴더가 하나라도 있는가 — chevron 노출 여부 결정. */
  hasChildren: boolean;
  /** localStorage 의 prefs 값. undefined 면 기본값. */
  meta: FolderMeta;
  /** Show subfolder content 가 켜져 있어 그리드가 자식 항목까지 표시
   *  중인지. 우클릭 체크박스 메뉴 표시 상태에만 사용. */
  isShowingSubfolderContent: boolean;

  /** 사이드바에서 계산한 표시용 카운트.
   *  - 펼친 상태: 직속 항목 수 (= row.count)
   *  - 접은 상태(자식 폴더 있음): 직속 + 자손 합산 */
  displayCount: number;
  /** 위 displayCount 가 합산값인지(=접힘+자식 보유) 여부. true 면 시각
   *  적으로 약간 흐리게 표기해 "이건 직속 수가 아님" 임을 암시. */
  isAggregatedCount: boolean;

  /** 현재 DnD 로 드래그 중인 다른 폴더의 tag (또는 reference 카드의 id).
   *  종류는 `activeDragKind` 로 구분. 자기 자신 / 자기 자식 폴더로의
   *  드롭은 사이클이라 droppable 을 disable 해 isOver 시각 피드백도 끄게
   *  한다 — 단 reference drag 일 때는 사이클 검증이 의미 없으므로 항상
   *  enabled. */
  activeDragId: string | null;
  /** 드래그 중인 객체가 폴더 행인지, 그리드의 reference 카드인지.
   *  - "folder"   : 기존 동작(into = 자식, before = 같은 레벨).
   *  - "reference": into 만 활성 — 폴더 안으로 이 항목들을 이동.
   *  - null       : idle. */
  activeDragKind?: "folder" | "reference" | null;

  /** Pinned (Quick Access) 상태. true 면 사이드바 상단의 별도 영역에
   *  단축으로 노출되며, 본 행에는 우측 상단 핀 배지가 표시된다. */
  isPinned: boolean;
  /** Phase D: 이 폴더가 AI 자동 분류를 켜둔 상태인지(=autoClassify true).
   *  true 면 라벨 옆에 작은 sparkles 아이콘으로 표시. 부모는 localStorage
   *  의 folderAiSettings 를 구독해 즉시 sync 한다. */
  hasAiAutoClassify?: boolean;

  onToggleActive: () => void;
  onToggleExpanded: () => void;
  onCreateSubfolder: () => void;
  onRename: () => void;
  onMove: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onToggleShowSubfolderContent: () => void;
  onExport: () => void;
  /** HTML Viewer Export — read-only 정적 뷰어 패키지(.zip / .html) 생성.
   *  Eagle 식 폴더 공유 시나리오: 받는 사람은 앱 없이 더블클릭만으로 본다. */
  onExportAsHtml: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
  onDuplicate: () => void;
  /** Phase D: 우클릭 → "AI settings…" 클릭 시 호출. 부모가
   *  FolderAiSettingsDialog 를 띄운다. */
  onOpenAiSettings?: () => void;
  /** Picker 에서 색·아이콘이 바뀌었음을 알리는 외부 콜백. 부모가
   *  prefsVersion 을 bump 해 visibleFolderRows 재계산을 트리거한다.
   *  Picker 의 즉시 반영 정책상 매 클릭마다 호출됨. */
  onMetaChanged: () => void;
  /** native HTML5 DnD 로 라이브러리 카드 ids 가 이 폴더 안으로 떨어졌을 때
   *  호출. dnd-kit 이 아닌 native 이벤트라 LibraryPage 에서 따로 받아
   *  `handleDropReferencesToFolder(ids, path)` 로 dispatch 한다. */
  onReferenceDrop?: (ids: string[]) => void;
  /** 설정 시: 호버하면 카운트가 좌측으로 슬라이드되며 "프로젝트로 생성" 버튼이
   *  나타난다(브리프 매치 폴더 전용, Dashboard 폴더 hover 패턴과 동일). */
  onCreateProject?: () => void;
  createProjectLabel?: string;
  /** 우클릭 메뉴를 축약(브리프 매치 폴더용) — 구조 변경 계열(하위폴더/이동/복제/
   *  AI설정/Quick Access/펼치기·접기/하위표시)을 숨기고 이름변경·아이콘·내보내기·
   *  삭제만 남긴다. */
  compactMenu?: boolean;
  /** 사용자가 명시적으로 색을 고르지 않았을 때의 기본 폴더 색 id
   *  (브리프 매치 폴더는 "red"). 미지정 시 카탈로그 기본값(gray). */
  defaultColorId?: string;
}

export function FolderRow({
  row,
  isActive,
  indentDepth,
  hasChildren,
  meta,
  isShowingSubfolderContent,
  displayCount,
  isAggregatedCount,
  activeDragId,
  activeDragKind = "folder",
  isPinned,
  hasAiAutoClassify = false,
  onToggleActive,
  onToggleExpanded,
  onCreateSubfolder,
  onRename,
  onMove,
  onExpandAll,
  onCollapseAll,
  onToggleShowSubfolderContent,
  onExport,
  onExportAsHtml,
  onDelete,
  onTogglePin,
  onDuplicate,
  onOpenAiSettings,
  onMetaChanged,
  onReferenceDrop,
  onCreateProject,
  createProjectLabel,
  compactMenu = false,
  defaultColorId,
}: FolderRowProps) {
  const t = useT();
  const path = row.tag.replace(/^folder:/, "");
  const isExpanded = meta.expanded !== false;
  const color = resolveFolderColor(meta.color ?? defaultColorId);
  const iconOption = resolveFolderIcon(meta.icon);
  const Icon = iconOption.Icon;

  // depth 는 0/1/2/3 까지만 들여쓰기에 반영. 더 깊으면 같은 레벨로
  // 묶어 사이드바 폭이 좁을 때 가독성이 무너지지 않게 한다.
  // 한 단계당 12px — chevron 하나 폭과 비슷.
  const depthIndent = Math.min(indentDepth, 3) * 12;

  // ─────── DnD: 폴더 행은 draggable + 두 가지 droppable. ───────
  //   1) "into"   : 행 전체. 떨어지면 source 가 이 행의 자식이 됨.
  //                 (Eagle 의 "폴더 위 hover → 풀 하이라이트" 패턴.)
  //   2) "before" : 행 상단 엣지의 얇은 strip. 떨어지면 source 가
  //                 이 행과 동일한 레벨(=같은 부모)로 들어감.
  //                 시각은 행 위쪽에 가는 수평 라인. 상위 폴더로
  //                 빼낼 때 사용 — root 로 빼려면 임의의 root 행
  //                 상단 엣지에 떨어뜨리면 됨(전용 영역 불필요).
  //
  // 사이클 / no-op 은 droppable disabled 로 차단해 isOver 시각
  // 피드백조차 뜨지 않게 한다.
  //
  // ── reference 카드 드래그 시 동작 ──
  //   - "into"   : 항상 활성. 폴더 안으로 카드를 이동.
  //   - "before" : 항상 비활성 — 사이드바에서 reference 의 sibling
  //                관계는 의미 없음(폴더 트리 구조상).
  const isReferenceDrag = activeDragKind === "reference";
  const isDragSource = !isReferenceDrag && activeDragId === row.tag;
  const sourcePath = !isReferenceDrag && activeDragId
    ? activeDragId.replace(/^folder:/, "")
    : null;
  const isDescendantOfSource = sourcePath
    ? path === sourcePath || path.startsWith(`${sourcePath}/`)
    : false;
  const sourceCurrentParent = sourcePath
    ? sourcePath.includes("/")
      ? sourcePath.slice(0, sourcePath.lastIndexOf("/"))
      : ""
    : null;
  // "before" 일 때의 새 부모 = 이 행의 부모. root 행이면 "".
  const beforeNewParent = path.includes("/")
    ? path.slice(0, path.lastIndexOf("/"))
    : "";

  // into 비활성: 드래그 안 함 / (folder 한정) 자기·자손·이미 직속 자식.
  const intoDisabled = !activeDragId
    ? true
    : isReferenceDrag
      ? false
      : isDescendantOfSource || sourceCurrentParent === path;
  // before 비활성: 드래그 안 함 / reference drag / (folder 한정) 자기 자신 ·
  // 자손. 같은 부모(=형제) ::before 는 유효 — Eagle 처럼 형제 순서 재배치에
  // 사용된다(부모 변경 없이 manual order 만 갱신). LibraryPage 의 통합 DnD
  // 핸들러가 부모 동일 / 상이를 보고 적절히 분기한다.
  const beforeDisabled = !activeDragId
    ? true
    : isReferenceDrag
      ? true
      : isDescendantOfSource;

  const {
    setNodeRef: setDragRef,
    attributes,
    listeners,
    isDragging,
  } = useDraggable({
    id: row.tag,
    data: { kind: "folder", row },
  });
  const { setNodeRef: setIntoRef, isOver: isOverInto } = useDroppable({
    id: row.tag,
    disabled: intoDisabled,
    data: { kind: "folder-into", row },
  });
  const { setNodeRef: setBeforeRef, isOver: isOverBefore } = useDroppable({
    id: `${row.tag}::before`,
    disabled: beforeDisabled,
    data: { kind: "folder-before", row },
  });

  const setRowRef = useCallback(
    (node: HTMLDivElement | null) => {
      setDragRef(node);
      setIntoRef(node);
    },
    [setDragRef, setIntoRef],
  );

  /* ── 라이브러리 카드 native HTML5 DnD 수신 ───────────────────────
   * dnd-kit 시절엔 useDroppable 한 줄로 충분했으나, LibraryCard 가 OS-수준
   * 드래그를 인계받기 위해 native draggable 로 전환되어 dnd-kit 의 droppable
   * 시각/이벤트가 더 이상 동작하지 않는다. 이 자리에 동일한 효과를 native
   * DnD + 글로벌 tracker 로 재구현한다.
   *
   * 두 채널로 hover 시각이 들어온다:
   *   1) native onDragOver → setIsReferenceDropHover(true)
   *      비-image kind 의 내부 드래그에서 fire. 즉시 반응.
   *   2) subscribeDragHover → setIsReferenceDropHover(target.path === path)
   *      image kind 의 image-mode 환경에서 native 가 fire 되지 않을 때
   *      좌표 기반 tracker 가 publish 한 hover 를 받아 시각을 살린다.
   *
   * dispatch 책임은 글로벌 tracker (libraryDragChannel.installDragTracker)
   * 가 dragend 에서 단독으로 가지며, 본 컴포넌트의 onDrop 은 시각 정리만
   * 한다. */
  const [isReferenceDropHover, setIsReferenceDropHover] = useState(false);
  // Ctrl/⌘ 누른 채 드래그 중인지 — hover 시각을 "추가"(다중 소속) 모드로 전환.
  const [additiveDrop, setAdditiveDrop] = useState(false);

  useEffect(() => {
    setAdditiveDrop(getCopyModifier());
    return subscribeCopyModifier(setAdditiveDrop);
  }, []);

  useEffect(() => {
    return subscribeDragHover((target: DropTarget | null) => {
      if (target && target.kind === "folder" && target.path === path) {
        setIsReferenceDropHover(true);
      } else {
        setIsReferenceDropHover(false);
      }
    });
  }, [path]);

  const isInternalReferenceDrag = (event: DragEvent<HTMLDivElement>): boolean => {
    const types = event.dataTransfer?.types;
    if (types) {
      for (let i = 0; i < types.length; i += 1) {
        if (types[i] === INTERNAL_DRAG_MIME) return true;
      }
    }
    return getActiveLibraryDrag() !== null;
  };

  const handleReferenceDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!isInternalReferenceDrag(event)) return;
      // 내부 카드 드래그라면 폴더 자기 자신으로 떨어뜨리는 것도 자연스럽다
      // (예: 메타 폴더에 다시 넣기) — sidebar.tsx 가 처리. 사이클 검증은
      // 폴더-폴더 드래그(dnd-kit) 영역에서만 의미가 있다.
      event.preventDefault();
      event.stopPropagation();
      // dragstart 의 effectAllowed="copy" 와 짝 — image-mode 호환.
      event.dataTransfer.dropEffect = "copy";
      if (!isReferenceDropHover) {
        // 같은 행에서 dragover 는 수십 번 발생 — 첫 진입에만 1회 로그.
        // 진단용; 안정되면 제거. Vite 는 console.warn 만 터미널로 전달.
        console.warn("[FolderRow] dragover (internal reference) on", path);
      }
      setIsReferenceDropHover(true);
    },
    [isReferenceDropHover, path],
  );

  const handleReferenceDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      // 자식 노드 사이를 가로지를 때 dragleave 가 false positive 로 발생 →
      // currentTarget 이 relatedTarget 을 포함하면 사실상 떠나지 않은 것.
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setIsReferenceDropHover(false);
    },
    [],
  );

  /* native onDrop — dispatch 는 글로벌 tracker 가 단독으로 담당 (libraryDragChannel
   * .installDragTracker 가 dragend 시점에 onFolderDrop 을 호출). 본 핸들러는
   * preventDefault + 시각 정리만 한다. 이전 구현은 여기서 onReferenceDrop
   * 을 직접 부르고 사이드채널까지 clear 했는데, image-mode 환경에서 tracker
   * 가 같은 dispatch 를 또 트리거하는 케이스를 dedup 하기 위해 single
   * source 로 통합. */
  const handleReferenceDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const active = getActiveLibraryDrag();
      if (!active || active.ids.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      setIsReferenceDropHover(false);
    },
    [],
  );

  const handleRowKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onToggleActive();
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setRowRef}
          {...attributes}
          {...listeners}
          /* 글로벌 dragover tracker 가 elementFromPoint → closest("[data-drop-
             folder-path]") 로 hover 대상을 식별. native onDragOver 가
             image-mode 에 가려도 좌표만 있으면 폴더 hover 시각이 살아 있다. */
          data-drop-folder-path={path}
          onDragOver={handleReferenceDragOver}
          onDragLeave={handleReferenceDragLeave}
          onDrop={handleReferenceDrop}
          className={cn(
            "group relative flex w-full items-center gap-1 pr-2 text-body border-l-2 transition-colors",
            isActive
              ? "border-l-primary bg-primary/10 text-foreground"
              : "border-l-transparent text-foreground/80 hover:bg-muted/40 hover:text-foreground",
            // 드래그 중인 본인은 자리만 비워 둔 듯한 ghost 처리.
            isDragging && "opacity-40",
            // 유효한 "into" 드롭 대상 hover — 풀 행 강조 (Eagle 패턴).
            // disabled 인 droppable 은 isOverInto 가 절대 true 가 아니므로
            // 자기 자신 / 자손에는 가드 불필요. dnd-kit 폴더-폴더 드래그와
            // reference "이동" 드롭은 primary ring 으로 일관.
            ((isOverInto && !isDragSource) || (isReferenceDropHover && !additiveDrop))
              && "ring-2 ring-inset ring-primary/60 bg-primary/5",
            // reference "추가"(Ctrl/⌘) 드롭은 amber ring 으로 구분 — 카드 "복사"
            // 배지(bg-amber-500)와 같은 노란색으로 "기존 유지 + 여기 추가" 신호.
            isReferenceDropHover && additiveDrop
              && "ring-2 ring-inset ring-amber-500/80 bg-amber-500/10",
          )}
          style={{ paddingLeft: `${4 + depthIndent}px` }}
        >
          {/* "before" insertion strip — 행 상단 엣지 + 위쪽 4 px 까지
              덮는 8 px 높이의 투명 영역. pointer-events-none 이라
              실제 클릭/드래그 input 에는 영향 없음(dnd-kit 은 geometry
              기반이라 detection 가능). 활성화 시 가는 수평 라인을
              그려 "여기 같은 레벨로 들어감" 을 표현. */}
          <div
            ref={setBeforeRef}
            aria-hidden
            className="pointer-events-none absolute inset-x-0 -top-1 z-10 h-2"
          >
            {isOverBefore ? (
              <div
                className="absolute right-1 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-primary"
                style={{ left: `${4 + depthIndent}px` }}
              />
            ) : null}
          </div>
          {/* Chevron — 자식 폴더 있을 때만 활성. 없을 때도 자리만 차지해
              같은 들여쓰기 레벨끼리 정렬을 맞춘다. */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpanded();
            }}
            className={cn(
              "flex h-5 w-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground transition-colors",
              !hasChildren && "invisible pointer-events-none",
            )}
            aria-label={isExpanded ? "Collapse folder" : "Expand folder"}
            tabIndex={hasChildren ? 0 : -1}
          >
            {isExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </button>

          {/* Icon button — 좌클릭으로 IconPicker Popover. 같은 행의 다른
              요소(라벨/카운트)에 대한 클릭은 stopPropagation 으로
              막아 popover 가 의도치 않게 활성 토글을 트리거하지 않게. */}
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  "relative flex h-5 w-5 shrink-0 items-center justify-center rounded-none transition-colors",
                  color.bgClass,
                  color.fgClass,
                  "hover:brightness-125",
                )}
                aria-label={`Change icon for ${row.label}`}
                title={isPinned ? "Pinned · Click to change icon & color" : "Click to change icon & color"}
              >
                <Icon className="h-3 w-3" />
                {isPinned ? (
                  // 우측 상단 핀 배지 — 본 행에서도 한눈에 "이건 Pinned"
                  // 임을 알 수 있게.
                  //
                  // 배지 크기 14px, Pin glyph 9px → 원 안 양쪽 ~2.5px 여백.
                  // Pin lucide 글리프는 머리(넓은 면)가 위, 바늘(좁은 면)이
                  // 아래로 비대칭이라 flex 의 기하학적 중심에 둬도 살짝
                  // 위로 떠 보인다 → translate-y 0.5px 로 광학적 중심
                  // 보정. fill="currentColor" 로 작은 사이즈에서도 형태가
                  // 또렷하게 보이게 채움.
                  <span
                    aria-hidden
                    className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary ring-1 ring-surface-sidebar"
                  >
                    <Pin
                      className="h-[9px] w-[9px] translate-y-[0.5px] text-primary-foreground"
                      strokeWidth={2.5}
                      fill="currentColor"
                    />
                  </span>
                ) : null}
              </button>
            </PopoverTrigger>
            <PopoverContent
              side="right"
              align="start"
              sideOffset={6}
              className="border-border-subtle bg-popover p-0"
            >
              <FolderIconPicker
                colorId={meta.color ?? defaultColorId}
                iconId={meta.icon}
                onSelectColor={(id) => {
                  setFolderMeta(path, { color: id });
                  onMetaChanged();
                }}
                onSelectIcon={(id) => {
                  setFolderMeta(path, { icon: id });
                  onMetaChanged();
                }}
                onReset={() => {
                  // expanded 만 보존하고 색·아이콘은 초기화. 사용자가
                  // "이 폴더 접어둠" 상태까지 잃으면 답답하니까.
                  const wasCollapsed = meta.expanded === false;
                  clearFolderMeta(path);
                  if (wasCollapsed) setFolderMeta(path, { expanded: false });
                  onMetaChanged();
                }}
              />
            </PopoverContent>
          </Popover>

          {/* Label area — 클릭 시 필터 토글 (활성↔비활성). 행 전체가
              아닌 라벨만 클릭 타겟으로 두면 chevron / icon 미스터치
              위험을 줄인다. */}
          <div
            role="button"
            tabIndex={0}
            onClick={onToggleActive}
            onKeyDown={handleRowKeyDown}
            className="flex min-w-0 flex-1 cursor-pointer items-center justify-between py-1 text-left"
          >
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="line-clamp-1">{row.label}</span>
              {hasAiAutoClassify ? (
                <Sparkles
                  className="h-3 w-3 shrink-0 text-amber-400/80"
                  aria-hidden
                  /* title 은 Lucide 의 ref 패스스루로 SVG 에 그대로 전달되어
                     hover tooltip 으로 자연스럽게 표시된다. */
                />
              ) : null}
            </span>
            <span
              className={cn(
                "ml-2 shrink-0 tabular-nums text-caption text-text-tertiary",
                // 합산값은 "직속 수가 아님" 시그널을 위해 살짝 흐리게.
                // (Eagle 도 접힌 폴더에 자손 합산을 dim 처리한다.)
                isAggregatedCount && "opacity-60",
                // 프로젝트 생성 버튼이 있는 행은 호버 시 카운트가 좌측으로 슬라이드.
                onCreateProject && "transition-transform duration-150 group-hover:-translate-x-[24px]",
              )}
              title={
                isAggregatedCount
                  ? t("library.folder.countTooltipWithSubfolders", { n: displayCount })
                  : undefined
              }
            >
              {displayCount}
            </span>
          </div>
          {onCreateProject ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onCreateProject();
              }}
              className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center text-muted-foreground opacity-0 transition-opacity hover:text-primary group-hover:opacity-100"
              title={createProjectLabel}
              aria-label={createProjectLabel}
              style={{ borderRadius: 0 }}
            >
              <Rocket className="h-3 w-3" />
            </button>
          ) : null}
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent className="min-w-56 rounded-none">
        {!compactMenu ? (
          <ContextMenuItem onSelect={onCreateSubfolder}>
            <Plus className="mr-2 h-3.5 w-3.5" />
            {t("library.folder.newSubfolder")}
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem onSelect={onRename}>
          <Pencil className="mr-2 h-3.5 w-3.5" />
          {t("library.folder.renameItem")}
        </ContextMenuItem>
        {!compactMenu ? (
          <>
            <ContextMenuItem onSelect={onMove}>
              <FolderInput className="mr-2 h-3.5 w-3.5" />
              {t("library.folder.moveItem")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={onDuplicate}>
              <Copy className="mr-2 h-3.5 w-3.5" />
              {t("library.folder.duplicateItem")}
            </ContextMenuItem>
          </>
        ) : null}

        <ContextMenuSeparator />

        {/* 구조 변경 계열 — 브리프 매치 폴더(compactMenu)에서는 전부 숨김. */}
        {!compactMenu ? (
          <>
            {/* Phase D: 폴더 단위 AI 자동 분류 설정. */}
            {onOpenAiSettings ? (
              <>
                <ContextMenuItem onSelect={onOpenAiSettings}>
                  <Sparkles
                    className={cn(
                      "mr-2 h-3.5 w-3.5",
                      hasAiAutoClassify ? "text-amber-400" : undefined,
                    )}
                  />
                  {t("library.folderAi.menuItem")}
                </ContextMenuItem>
                <ContextMenuSeparator />
              </>
            ) : null}

            {/* Pin (Quick Access). 토글 형식 — 동일 위치에서 켜고 끄게 둠. */}
            <ContextMenuItem onSelect={onTogglePin}>
              {isPinned ? (
                <PinOff className="mr-2 h-3.5 w-3.5" />
              ) : (
                <Pin className="mr-2 h-3.5 w-3.5" />
              )}
              {isPinned ? t("library.folder.removeFromQuickAccess") : t("library.folder.addToQuickAccess")}
            </ContextMenuItem>

            <ContextMenuSeparator />

            <ContextMenuItem onSelect={onToggleExpanded} disabled={!hasChildren}>
              {isExpanded ? (
                <Minimize2 className="mr-2 h-3.5 w-3.5" />
              ) : (
                <Maximize2 className="mr-2 h-3.5 w-3.5" />
              )}
              {isExpanded ? t("library.folder.collapse") : t("library.folder.expand")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={onExpandAll}>
              <Maximize2 className="mr-2 h-3.5 w-3.5" />
              {t("library.folder.expandAll")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={onCollapseAll}>
              <Minimize2 className="mr-2 h-3.5 w-3.5" />
              {t("library.folder.collapseAll")}
            </ContextMenuItem>

            <ContextMenuSeparator />

            <ContextMenuCheckboxItem
              checked={isShowingSubfolderContent}
              onCheckedChange={() => onToggleShowSubfolderContent()}
            >
              <FolderTree className="mr-2 h-3.5 w-3.5" />
              {t("library.folder.showSubfolderContent")}
            </ContextMenuCheckboxItem>
          </>
        ) : null}

        {/* Change Icon — Popover 와 동일한 picker 를 서브메뉴 contents
            로 한 번 더 노출. 좌클릭이 어색한 사용자(트랙패드 더블탭
            오발 우려 등)도 우클릭 경로로 같은 작업을 할 수 있게. */}
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Icon className={cn("mr-2 h-3.5 w-3.5", color.fgClass)} />
            {t("library.folder.changeIcon")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="border-border-subtle bg-popover p-0">
            <FolderIconPicker
              colorId={meta.color ?? defaultColorId}
              iconId={meta.icon}
              onSelectColor={(id) => {
                setFolderMeta(path, { color: id });
                onMetaChanged();
              }}
              onSelectIcon={(id) => {
                setFolderMeta(path, { icon: id });
                onMetaChanged();
              }}
              onReset={() => {
                const wasCollapsed = meta.expanded === false;
                clearFolderMeta(path);
                if (wasCollapsed) setFolderMeta(path, { expanded: false });
                onMetaChanged();
              }}
            />
          </ContextMenuSubContent>
        </ContextMenuSub>

        <ContextMenuSeparator />

        <ContextMenuItem onSelect={onExport} disabled={row.count === 0}>
          <Download className="mr-2 h-3.5 w-3.5" />
          {t("library.folder.exportItem")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onExportAsHtml} disabled={row.count === 0}>
          <Download className="mr-2 h-3.5 w-3.5" />
          {t("library.folder.exportAsHtmlItem")}
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={onDelete}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="mr-2 h-3.5 w-3.5" />
          {t("library.folder.deleteItem")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
