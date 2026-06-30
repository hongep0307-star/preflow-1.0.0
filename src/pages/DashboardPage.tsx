import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
  type DragEndEvent,
  type DragStartEvent,
  type DragOverEvent,
  type Modifier,
} from "@dnd-kit/core";
import { getEventCoordinates } from "@dnd-kit/utilities";
import { supabase } from "@/lib/supabase";
import { Navbar } from "@/components/Navbar";
import { WorkspaceSwitcher } from "@/components/WorkspaceSwitcher";
import { ProjectCard } from "@/components/ProjectCard";
import { ProjectListRow } from "@/components/ProjectListRow";
import { ProjectModal } from "@/components/ProjectModal";
import { TrashModal } from "@/components/TrashModal";
import { trashProject } from "@/lib/deleteProject";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ProjectExportDialog } from "@/components/ProjectExportDialog";
import { ProjectImportDialog } from "@/components/ProjectImportDialog";
import { previewProjectPackFromPath } from "@/lib/preflowProjClient";
import type { ProjPackPreview } from "@/lib/preflowProj";
import { activateWorkspace, ensureWorkspacesLoaded, getCachedActive, getCachedActiveId } from "@/lib/workspaceClient";
import {
  clearPendingPackPath,
  packKindFromPath,
  readPendingPackPath,
  subscribePendingPack,
} from "@/lib/packOpen";
import { prefetchLibraryPage } from "@/lib/pagePrefetch";
import { recordProjects, reconcileWorkspaceProjects } from "@/lib/recentProjectsCache";
import { createProjectFromPending } from "@/lib/briefMatch";
import {
  peekPendingBriefMatchProject,
  takePendingBriefMatchProject,
} from "@/lib/pendingBriefMatchProject";
import { SkeletonCard } from "@/components/SkeletonCard";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Plus,
  Film,
  Search,
  X,
  ChevronRight,
  Loader2,
  Trash2,
  Folder,
  Pencil,
  LayoutGrid,
  List as ListIcon,
  ArrowUp,
  ArrowDown,
  Package,
  Download,
  Upload,
  CheckSquare,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/uiLanguage";
import {
  DASHBOARD_CARDS_PER_ROW_CHANGED_EVENT,
  DASHBOARD_SIDEBAR_WIDTH_CHANGED_EVENT,
  DASHBOARD_SORT_CHANGED_EVENT,
  DASHBOARD_VIEW_MODE_CHANGED_EVENT,
  readDashboardCardsPerRow,
  readDashboardSidebarWidth,
  readDashboardSort,
  readDashboardViewMode,
  saveDashboardSort,
  saveDashboardViewMode,
  type DashboardCardsPerRow,
  type DashboardSortMode,
  type DashboardSortPreference,
  type DashboardViewMode,
} from "@/lib/dashboardPreferences";
import { SidebarResizeHandle } from "@/components/SidebarResizeHandle";
import { getStorageUsageByProject } from "@/lib/storageMaintenance";
import { computeRelativeTime, resolveProjectRoute } from "@/lib/dashboardCardHelpers";

/* ── 타입 ── */
// 드래그 오버레이를 "잡은 지점"이 아니라 커서 오른쪽-아래에 붙인다. 기본
// 동작은 잡은 카드의 원래 위치를 따라가서, 작은 썸네일로 바꾸면 커서와 멀리
// 떨어져 보였다. snapCenterToCursor 와 같은 원리(activator 좌표 - 노드 left
// = 오버레이 left 를 커서에 맞춤)에 작은 gap 을 더해 커서 우측에 배치.
const DRAG_PREVIEW_GAP_X = 14;
const DRAG_PREVIEW_GAP_Y = 10;
const snapPreviewToCursorRight: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  if (!draggingNodeRect || !activatorEvent) return transform;
  const coords = getEventCoordinates(activatorEvent);
  if (!coords) return transform;
  const offsetX = coords.x - draggingNodeRect.left;
  const offsetY = coords.y - draggingNodeRect.top;
  return {
    ...transform,
    x: transform.x + offsetX + DRAG_PREVIEW_GAP_X,
    y: transform.y + offsetY + DRAG_PREVIEW_GAP_Y,
  };
};

export interface Project {
  id: string;
  title: string;
  client: string | null;
  deadline: string | null;
  status: string;
  created_at: string;
  video_format?: string;
  thumbnail_url?: string | null;
  thumbnail_crop?: any;
  folder_id?: string | null;
  /** 사이드바 FAVORITES 섹션의 데이터 소스. db-utils 의 BOOLEAN_COLUMNS 에
   *  포함돼 있어 read 시 boolean 으로 자동 변환되어 들어옴 (legacy row 는 false). */
  is_favorite?: boolean;
  /** ProjectPage 마운트 시 갱신되는 ISO 8601 문자열. RECENT 섹션 정렬 키. */
  last_visited_at?: string | null;
  /** 프로젝트의 의미 있는 마지막 수정 시각 (ISO 8601). 자식 테이블 INSERT/
   *  UPDATE/DELETE 트리거 또는 콘텐츠 컬럼 dbUpdate 시 자동 갱신. 카드 호버 시
   *  "X 분 전" 라벨의 데이터 소스. */
  updated_at?: string | null;
  /** 휴지통(soft delete) 시각 (ISO 8601). NULL = 정상 프로젝트, 값 존재 =
   *  휴지통에 있음. 대시보드 본 목록은 NULL 만, 휴지통 뷰는 값이 있는 것만 표시. */
  deleted_at?: string | null;
}
export interface SceneStats {
  total: number;
  withConti: number;
  /** 유저가 수동으로 최종 확정(is_final=true)한 씬의 수. 대시보드 진행도는
   *  withConti 가 아니라 이 값을 기준으로 표시한다. */
  finalCount: number;
  /** 콘티 탭에 작업 중인 씬이 있는지 (scenes.source = 'conti') */
  hasContiScenes?: boolean;
  /** Agent 스토리보드에 씬 카드가 있는지 (scenes.source = 'agent') */
  hasAgentScenes?: boolean;
  /** Agent 에서 저장된 스토리보드 드래프트 버전이 있는지 */
  hasDraftVersion?: boolean;
}
export interface Folder {
  id: string;
  name: string;
  created_at: string;
}

/** projectId → 디스크 위 이미지 사용량(바이트 + 파일 수). 카드 사이즈 칩의
 *  데이터 소스. 백엔드 walk 결과를 그대로 캐시한다. */
export type StorageUsageMap = Record<string, { bytes: number; files: number }>;

/** 캐시는 어느 워크스페이스의 데이터인지 함께 기록한다. 워크스페이스 전환
 *  직후 옛 프로젝트/폴더가 새 워크스페이스 첫 페인트에 묻어 나오면 사용자가
 *  "내가 만들지도 않은 프로젝트가 보임" 으로 인지하므로, workspaceId 일치
 *  검사를 cache read 의 첫 줄에 둔다. */
type DashboardCache = {
  workspaceId: string;
  projects: Project[];
  folders: Folder[];
  sceneStatsMap: Record<string, SceneStats>;
  storageUsageMap?: StorageUsageMap;
};

const DASHBOARD_CACHE_KEY = "preflow.dashboard.cache.v1";
let dashboardCache: DashboardCache | null = null;

const readDashboardCache = (): DashboardCache | null => {
  const activeId = getCachedActiveId();
  if (!activeId) return null;

  if (dashboardCache && dashboardCache.workspaceId === activeId) return dashboardCache;
  if (dashboardCache && dashboardCache.workspaceId !== activeId) dashboardCache = null;

  try {
    const raw = sessionStorage.getItem(DASHBOARD_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DashboardCache>;
    if (!Array.isArray(parsed.projects) || !Array.isArray(parsed.folders)) return null;
    if (parsed.workspaceId !== activeId) {
      sessionStorage.removeItem(DASHBOARD_CACHE_KEY);
      return null;
    }
    dashboardCache = {
      workspaceId: parsed.workspaceId,
      projects: parsed.projects,
      folders: parsed.folders,
      sceneStatsMap: parsed.sceneStatsMap ?? {},
      storageUsageMap: parsed.storageUsageMap ?? {},
    };
    return dashboardCache;
  } catch {
    return null;
  }
};

const writeDashboardCache = (next: Omit<DashboardCache, "workspaceId">) => {
  const activeId = getCachedActiveId();
  if (!activeId) return;
  dashboardCache = { workspaceId: activeId, ...next };
  try {
    sessionStorage.setItem(DASHBOARD_CACHE_KEY, JSON.stringify(dashboardCache));
  } catch {
    // Cache is best-effort only.
  }
};

/* ── FolderModal ── */
const FolderModal = ({
  isOpen,
  onClose,
  onSuccess,
  editFolder,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  editFolder?: Folder | null;
}) => {
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const t = useT();

  useEffect(() => {
    setName(editFolder?.name ?? "");
  }, [editFolder, isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    if (editFolder) {
      const { error } = await (supabase as any).from("folders").update({ name }).eq("id", editFolder.id);
      if (error) toast({ variant: "destructive", title: t("dashboard.toast.updateFailed"), description: error.message });
      else {
        onSuccess();
        onClose();
      }
    } else {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const { error } = await (supabase as any).from("folders").insert([{ name, user_id: user?.id }]);
      if (error) toast({ variant: "destructive", title: t("dashboard.toast.createFailed"), description: error.message });
      else {
        onSuccess();
        onClose();
      }
    }
    setLoading(false);
  };

  const handleDelete = async () => {
    if (!editFolder) return;
    setLoading(true);
    // 폴더에 속한 프로젝트의 folder_id 를 먼저 비운다. 이게 빠져 있어 폴더만
    // 사라지고 프로젝트는 dangling folder_id 를 든 채 어떤 그룹에도 안 잡히는
    // "유령 프로젝트" 가 생겼다. (projects 는 삭제하지 않고 미분류로 되돌린다.)
    await (supabase as any).from("projects").update({ folder_id: null }).eq("folder_id", editFolder.id);
    const { error } = await (supabase as any).from("folders").delete().eq("id", editFolder.id);
    if (error) toast({ variant: "destructive", title: t("dashboard.toast.deleteFailed"), description: error.message });
    else {
      onSuccess();
      onClose();
    }
    setLoading(false);
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{editFolder ? t("dashboard.editFolder") : t("dashboard.newFolder")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-1.5">
            <Label className="text-muted-foreground text-body">{t("dashboard.folderName")}</Label>
            <Input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="bg-background border-border text-body h-9"
              style={{ borderRadius: 0 }}
            />
          </div>
          <div className="flex justify-between items-center pt-1">
            {editFolder ? (
              <Button
                type="button"
                variant="ghost"
                onClick={handleDelete}
                disabled={loading}
                className="text-destructive hover:text-destructive hover:bg-destructive/10 text-body h-9 px-3"
              >
                <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                {t("common.delete")}
              </Button>
            ) : (
              <div />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={onClose} className="text-body h-9">
                {t("common.cancel")}
              </Button>
              <Button
                disabled={loading}
                className="min-w-[80px] bg-primary hover:bg-primary/85 text-body h-9"
                style={{ borderRadius: 0 }}
              >
                {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : editFolder ? t("common.save") : t("common.create")}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/* ── 사이드바 FAVORITES / RECENT 한 줄 ──
   카드/리스트 행에 비해 정보 밀도가 훨씬 낮은 환경(폭 198px). 색 dot + 이름
   truncate + 우측 작은 보조 라벨(카운트 또는 "2h ago") 만 노출.
*/
const SidebarProjectRow = ({
  project,
  rightLabel,
  isCompleted,
  onClick,
}: {
  project: Project;
  rightLabel?: string;
  isCompleted: boolean;
  onClick: () => void;
}) => {
  return (
    <button
      type="button"
      onClick={onClick}
      title={project.title}
      className="group/row flex w-full items-center gap-2.5 pl-4 pr-2 py-1.5 border-l-2 border-l-transparent transition-colors hover:bg-surface-panel hover:border-l-border-subtle"
    >
      <span
        className="w-[6px] h-[6px] rounded-full flex-shrink-0"
        style={{ background: isCompleted ? "rgba(52,211,153,0.9)" : "#f9423a" }}
      />
      <span className="min-w-0 flex-1 truncate text-left text-body text-foreground/80 group-hover/row:text-foreground transition-colors">
        {project.title}
      </span>
      {rightLabel && (
        <span className="text-caption tabular-nums text-text-tertiary flex-shrink-0">
          {rightLabel}
        </span>
      )}
    </button>
  );
};

/* ── Draggable ProjectCard 래퍼 ── */
const DraggableCard = ({
  project,
  onRefresh,
  onEdit,
  onExport,
  sceneStats,
  storageBytes,
  selected,
  selectionActive,
  onSelectClick,
}: {
  project: Project;
  onRefresh: () => void;
  onEdit: (p: Project) => void;
  onExport?: (p: Project) => void;
  sceneStats?: SceneStats;
  storageBytes?: number;
  selected?: boolean;
  selectionActive?: boolean;
  onSelectClick?: (p: Project, mods: { ctrlOrMeta: boolean; shift: boolean }) => void;
}) => {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: project.id });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={cn("touch-none transition-opacity duration-100", isDragging && "opacity-20")}
    >
      <ProjectCard
        project={project}
        onRefresh={onRefresh}
        onEdit={onEdit}
        onExport={onExport}
        sceneStats={sceneStats}
        storageBytes={storageBytes}
        selected={selected}
        selectionActive={selectionActive}
        onSelectClick={onSelectClick}
      />
    </div>
  );
};

/* ── 사이드바 Ungrouped 드롭존 (드래그 중에만 노출) ── */
const DroppableUngroupedSidebar = ({ isOver }: { isOver: boolean }) => {
  const { setNodeRef } = useDroppable({ id: "sidebar-ungrouped" });
  const t = useT();
  return (
    <div ref={setNodeRef}>
      <div
        className={cn(
          "flex items-center gap-2 pl-4 pr-2 py-1.5 border-l-2 transition-all duration-100",
          isOver ? "bg-primary/15 border-l-primary" : "border-l-transparent",
        )}
      >
        <Folder
          className={cn(
            "w-3.5 h-3.5 flex-shrink-0 transition-colors",
            isOver ? "text-primary" : "text-muted-foreground",
          )}
        />
        <span
          className={cn(
            "text-body transition-colors",
            isOver ? "text-foreground font-semibold" : "text-muted-foreground",
          )}
        >
          {t("common.ungrouped")}
        </span>
      </div>
    </div>
  );
};

/* ── 사이드바 휴지통 — 드롭 타겟 겸 클릭 진입점 ──
   프로젝트 카드를 여기로 끌어다 놓으면 곧장 휴지통으로(soft delete). 폴더
   드롭과 동일한 over 하이라이트 시각 언어를 쓴다. 클릭 시엔 휴지통 모달. */
const DroppableTrashSidebar = ({
  count,
  isOver,
  isDragging,
  onClick,
}: {
  count: number;
  isOver: boolean;
  isDragging: boolean;
  onClick: () => void;
}) => {
  const { setNodeRef } = useDroppable({ id: "sidebar-trash" });
  const t = useT();
  return (
    <div ref={setNodeRef} className="mt-3 border-t border-border-subtle pt-2">
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex w-full items-center gap-2 border-l-2 px-2 py-1.5 text-body transition-all duration-100",
          isOver && isDragging
            ? "border-l-primary bg-primary/15 font-semibold text-foreground"
            : "border-l-transparent text-text-secondary hover:bg-secondary hover:text-foreground",
        )}
        style={{ borderRadius: 0 }}
        title={t("dashboard.trashTitle")}
      >
        <Trash2
          className={cn(
            "h-3.5 w-3.5 shrink-0 transition-colors",
            isOver && isDragging ? "text-primary" : "opacity-70",
          )}
        />
        <span className="flex-1 truncate text-left">{t("dashboard.trash")}</span>
        {count > 0 && (
          <span className="text-caption tabular-nums text-text-tertiary">{count}</span>
        )}
      </button>
    </div>
  );
};

/* ── 사이드바 드롭 가능 폴더 아이템 ── */
const DroppableSidebarFolder = ({
  folder,
  count,
  isSelected,
  isOver,
  isDragging,
  onSelect,
  onEdit,
}: {
  folder: Folder;
  count: number;
  isSelected: boolean;
  isOver: boolean;
  isDragging: boolean;
  onSelect: () => void;
  onEdit: () => void;
}) => {
  const { setNodeRef } = useDroppable({ id: `sidebar-folder-${folder.id}` });
  const t = useT();

  return (
    <div ref={setNodeRef}>
      {/* relative + Settings 를 absolute 로 분리해 카운트가 outer 의 우측
         가장자리(pr-2 = 사이드바 우측에서 8px 안쪽) 까지 밀착되게 했다.
         이전엔 Settings 가 layout flow 의 자식이라 24~28px 폭을 항상 차지해,
         호버 전에도 카운트가 어중간한 안쪽 자리에 머물러 보였다. 호버 시
         카운트는 그대로 왼쪽으로 슬라이드하고 그 자리에 Settings 가 페이드
         인 — 두 요소가 같은 우측 끝 자리를 시각적으로 swap 한다. */}
      <div
        className={cn(
          "group/folder relative flex items-center border-l-2 transition-all duration-100",
          isOver && isDragging
            ? "bg-primary/15 border-l-primary"
            : isSelected
              ? "border-l-primary bg-primary/[0.07]"
              : "border-l-transparent hover:bg-surface-panel",
        )}
      >
        <button
          type="button"
          onClick={onSelect}
          className="grid min-w-0 flex-1 grid-cols-[16px_minmax(0,1fr)_28px] items-center gap-2 py-1.5 pl-4 pr-2 text-left"
        >
          <Folder
            className={cn(
              "w-3.5 h-3.5 flex-shrink-0 transition-colors",
              isOver && isDragging ? "text-primary" : isSelected ? "text-primary" : "text-muted-foreground",
            )}
          />
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-body transition-colors",
              isOver && isDragging
                ? "text-foreground font-semibold"
                : isSelected
                  ? "text-foreground font-semibold"
                  : "text-foreground/80",
            )}
          >
            {folder.name}
          </span>
          <span
            className={cn(
              // 슬라이드 양은 Settings 의 폭(20px) + 우측 마진(8px) 안에서
              // 두 요소가 시각적으로 겹치지 않을 만큼만 — 26px 이면 카운트가
              // Settings 좌측에 1~2px 의 갭을 남기고 비켜 선다. 카운트 자체
              // 는 사라지지 않고 살짝 왼쪽 자리로 옮겨 정보 손실이 없도록.
              "text-right tabular-nums text-caption transition-all duration-150 group-hover/folder:-translate-x-[26px]",
              isOver && isDragging ? "text-text-secondary" : "text-text-tertiary",
            )}
          >
            {count}
          </span>
        </button>
        {/* Settings — outer 의 absolute 우측 가장자리에 부착. 카운트가 차지
            하던 자리와 시각적으로 swap 되도록 같은 right offset(8px) 에 둔다.
            stopPropagation 으로 onSelect 버블링 방지 — 옛 코드는 outer 의
            자식이 두 개라 자연 분리됐지만 absolute 로 옮기면 z-stacking 위
            클릭이라도 onSelect 가 같이 트리거되지 않게 명시. */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/folder:opacity-100"
          title={t("common.edit")}
          style={{ borderRadius: 0 }}
        >
          <Pencil className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
};

/* ── 프로젝트 그룹 (All 뷰 폴더별) ── */
const ProjectGroup = ({
  label,
  count,
  projects,
  sceneStatsMap,
  storageUsageMap,
  cardsPerRow,
  viewMode,
  onRefresh,
  onEditProject,
  onExportProject,
  isOver,
  droppableId,
  selectedIds,
  selectionActive,
  onSelectClick,
}: {
  label?: string;
  count?: number;
  projects: Project[];
  sceneStatsMap: Record<string, SceneStats>;
  storageUsageMap: StorageUsageMap;
  cardsPerRow: DashboardCardsPerRow;
  viewMode: DashboardViewMode;
  onRefresh: () => void;
  onEditProject: (p: Project) => void;
  onExportProject?: (p: Project) => void;
  isOver?: boolean;
  droppableId: string;
  selectedIds?: Set<string>;
  selectionActive?: boolean;
  onSelectClick?: (p: Project, mods: { ctrlOrMeta: boolean; shift: boolean }) => void;
}) => {
  const t = useT();
  const { setNodeRef } = useDroppable({ id: droppableId });
  // 그룹 라벨 옆 chevron 으로 접고/펼 수 있게. droppableId 기준으로 로컬 상태만
  // 관리 — 라우트 이동 시 리셋되는 게 자연스럽고, 저장까지 할 만한 정보는 아님.
  // 드래그가 그룹 헤더 근처로 들어오면(isOver) 자동으로 펼침.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (isOver) setCollapsed(false);
  }, [isOver]);
  if (projects.length === 0) return null;
  const gridStyle = { gridTemplateColumns: `repeat(${cardsPerRow}, minmax(0, 1fr))` };

  return (
    <div ref={setNodeRef}>
      {label && (
        <div className="flex items-center gap-2.5 mb-2">
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? t("dashboard.expandGroup") : t("dashboard.collapseGroup")}
            aria-expanded={!collapsed}
            className="flex items-center justify-center w-4 h-4 hover:bg-surface-panel transition-colors"
            style={{ borderRadius: 0 }}
          >
            <ChevronRight
              className={cn(
                "w-3 h-3 text-muted-foreground transition-transform duration-150",
                !collapsed && "rotate-90",
              )}
            />
          </button>
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="flex items-center gap-2.5 cursor-pointer"
          >
            <span className="text-caption tracking-[0.05em] text-muted-foreground hover:text-text-secondary transition-colors">
              {label}
            </span>
            {count !== undefined && (
              <span className="text-2xs tabular-nums text-text-tertiary">{count}</span>
            )}
          </button>
          <div className="flex-1 h-px bg-border-subtle" />
        </div>
      )}
      {!collapsed && (
        viewMode === "list" ? (
          // 리스트 뷰는 DnD 폴더 드롭 인디케이터를 적용하지 않는다 — 행 자체가
          // 가로로 길어 ring 강조가 카드 뷰만큼 의미 있게 동작하지 않고, list
          // 모드는 정렬/탐색에 더 가까운 사용 패턴이라는 가정. 폴더 이동은
          // 그리드 모드에서 익숙한 동작으로 안내하는 게 자연스러움.
          <div className="flex flex-col gap-1">
            {projects.map((p) => (
              <ProjectListRow
                key={p.id}
                project={p}
                onRefresh={onRefresh}
                onEdit={onEditProject}
                onExport={onExportProject}
                sceneStats={sceneStatsMap[p.id]}
                storageBytes={storageUsageMap[p.id]?.bytes}
                selected={selectedIds?.has(p.id)}
                selectionActive={selectionActive}
                onSelectClick={onSelectClick}
              />
            ))}
          </div>
        ) : (
          <div
            className={cn(
              "grid gap-3 transition-[box-shadow,background-color] duration-100",
              isOver && "ring-2 ring-primary/60 bg-primary/[0.05]",
            )}
            style={gridStyle}
          >
            {projects.map((p) => (
              <DraggableCard
                key={p.id}
                project={p}
                onRefresh={onRefresh}
                onEdit={onEditProject}
                onExport={onExportProject}
                sceneStats={sceneStatsMap[p.id]}
                storageBytes={storageUsageMap[p.id]?.bytes}
                selected={selectedIds?.has(p.id)}
                selectionActive={selectionActive}
                onSelectClick={onSelectClick}
              />
            ))}
          </div>
        )
      )}
    </div>
  );
};

/* ═══════════════════════ 메인 페이지 ═══════════════════════ */
const DashboardPage = () => {
  const t = useT();
  const initialCache = readDashboardCache();
  const [projects, setProjects] = useState<Project[]>(initialCache?.projects ?? []);
  const [folders, setFolders] = useState<Folder[]>(initialCache?.folders ?? []);
  const [loading, setLoading] = useState(!initialCache);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isFolderModalOpen, setIsFolderModalOpen] = useState(false);
  const [editProject, setEditProject] = useState<Project | null>(null);
  const [editFolder, setEditFolder] = useState<Folder | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "completed">("all");
  const [sceneStatsMap, setSceneStatsMap] = useState<Record<string, SceneStats>>(initialCache?.sceneStatsMap ?? {});
  // 디스크 walk 결과는 비교적 비용이 있어 idle 시점에 한 번만 가져온다.
  // 실패하더라도 카드 자체는 정상이므로 silent fail.
  const [storageUsageMap, setStorageUsageMap] = useState<StorageUsageMap>(
    initialCache?.storageUsageMap ?? {},
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  // 휴지통(soft delete) — fetchData 가 deleted_at 이 있는 프로젝트를 여기에
  // 분리해 담고, 사이드바 "휴지통" 항목이 이 목록의 개수를 표시한다. 모달로
  // 복원 / 영구 삭제를 처리.
  const [trashedProjects, setTrashedProjects] = useState<Project[]>([]);
  const [showTrash, setShowTrash] = useState(false);
  // 선택된 프로젝트 일괄 휴지통 이동 — Del 키 또는 선택 툴바 버튼으로 진입.
  // 실수 방지를 위해 확인 다이얼로그를 거친다(soft delete 라 복원은 가능).
  const [confirmBulkTrash, setConfirmBulkTrash] = useState(false);
  const [bulkTrashing, setBulkTrashing] = useState(false);
  /* ── Phase 4 — 다중 선택 (Project Dashboard) ──
     UX 패턴: Modifier 클릭(Ctrl/Cmd+클릭 토글, Shift+클릭 범위) + 호버 체크박스
     보조 + 1개 이상 선택 시 평범 클릭도 토글로 흡수 (Finder/Lightroom 패턴).
     선택 범위는 "현재 화면(폴더/필터/검색 적용된 visibleProjects) 안에서만" —
     폴더가 바뀌면 자동으로 클리어한다. anchor 는 Shift+클릭 범위 선택의 기준점.
     selectedIds 는 Set 으로 관리해 toggle / has 가 O(1). */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const anchorIdRef = useRef<string | null>(null);
  const [cardsPerRow, setCardsPerRow] = useState<DashboardCardsPerRow>(readDashboardCardsPerRow);
  // 그리드/리스트 뷰와 정렬 선호값. 두 토글 모두 localStorage 영구화 + 같은
  // 윈도우 내 다른 컴포넌트 동기화를 위한 CustomEvent 채널을 동시에 청취.
  const [viewMode, setViewMode] = useState<DashboardViewMode>(readDashboardViewMode);
  const [sortPref, setSortPref] = useState<DashboardSortPreference>(readDashboardSort);
  // 사이드바 폭 — 드래그/더블클릭으로 갱신. 영구화는 핸들 컴포넌트 내부에서
  // mouseup 시점에만 한 번 (드래그 중간 1000 회 쓰기 방지). 다른 윈도우에서
  // 변경됐을 때 storage 이벤트 + 같은 윈도우 CustomEvent 양쪽으로 동기화.
  const [sidebarWidth, setSidebarWidth] = useState<number>(readDashboardSidebarWidth);

  /* ── Phase 3 — .preflowproj 팩 export/import 다이얼로그 ──
     Project 카드/리스트 우상단 ⋯ 메뉴의 "Export project…" 와 메인바 우측의
     워크스페이스 메뉴(Export / Import) 가 같은 다이얼로그 컴포넌트를 공유.
     dragdrop 으로 떨어뜨린 .preflowproj 파일은 미리보기를 만든 뒤 import
     다이얼로그를 곧장 import-options 화면으로 띄운다.

     Phase 4 — 다중 선택 export 추가. scope="selection" + projectIds 배열. */
  const [exportDialog, setExportDialog] = useState<{
    open: boolean;
    scope: "single" | "selection" | "workspace";
    projectId?: string | null;
    projectIds?: string[] | null;
    scopeLabel: string;
    itemSummary?: string;
  } | null>(null);
  const [importDialog, setImportDialog] = useState<{
    open: boolean;
    initialPreview: ProjPackPreview | null;
  }>({ open: false, initialPreview: null });
  const [packDragOver, setPackDragOver] = useState(false);

  const { toast } = useToast();
  const navigate = useNavigate();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const projectGridStyle = { gridTemplateColumns: `repeat(${cardsPerRow}, minmax(0, 1fr))` };

  /* ── 스마트 브리프 매치 → 프로젝트 내보내기 drain ──
     라이브러리에서 stash + 대상 프로젝트 WS 로 전환(reload)된 직후, 이 DB(=대상 WS)에
     프로젝트/브리프(사전 분석 포함)를 생성한다. takePending 으로 원자적으로 소비해
     StrictMode/재마운트 이중 생성을 막는다(ref 가드로 한 번 더 보호).
     openInBrief 면 프로젝트 브리프 탭으로 이동, 아니면 라이브러리로 복귀. */
  const briefMatchDrainedRef = useRef(false);
  useEffect(() => {
    if (briefMatchDrainedRef.current) return;
    const pending = peekPendingBriefMatchProject();
    if (!pending) return;
    const activeId = getCachedActiveId();
    if (!activeId || pending.targetWsId !== activeId) return; // 아직 대상 WS 활성 아님
    briefMatchDrainedRef.current = true;
    const taken = takePendingBriefMatchProject();
    if (!taken) return;
    void (async () => {
      try {
        const projectId = await createProjectFromPending(taken);
        recordProjects(activeId, [
          { id: projectId, title: taken.title || null, updated_at: null, last_visited_at: null },
        ]);
        if (taken.openInBrief) {
          try {
            sessionStorage.setItem("preflow.return.sourceTab", "brief");
          } catch {
            /* private mode */
          }
          navigate(
            `/project/${encodeURIComponent(projectId)}?tab=brief&ws=${encodeURIComponent(activeId)}`,
          );
        } else {
          toast({ title: t("briefMatch.export.movedToast") });
          await activateWorkspace(taken.libraryWsId, false, "/#/library");
        }
      } catch (e) {
        toast({
          variant: "destructive",
          title: t("briefMatch.exportFailed"),
          description: (e as Error).message,
        });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── 데이터 패칭 ── */
  const fetchData = async () => {
    const [{ data: pData, error: pErr }, { data: fData }] = await Promise.all([
      supabase.from("projects").select("*, active_version_id").order("created_at", { ascending: false }),
      (supabase as any).from("folders").select("*").order("created_at", { ascending: true }),
    ]);
    if (pErr) toast({ variant: "destructive", title: t("common.error"), description: pErr.message });
    else {
      const allRows = (pData || []) as Project[];
      // deleted_at 이 있는 행은 휴지통으로 분리한다. 본 목록/카운트/최근항목은
      // 정상(deleted_at IS NULL) 프로젝트만 보므로, 삭제한 프로젝트가 카운트에
      // 잡히거나 RECENT 에 남거나 열리던 버그가 한 번에 사라진다.
      const projectRows = allRows.filter((p) => !p.deleted_at);
      const trashedRows = allRows
        .filter((p) => !!p.deleted_at)
        .sort((a, b) => new Date(b.deleted_at ?? 0).getTime() - new Date(a.deleted_at ?? 0).getTime());
      const folderRows = (fData ?? []) as Folder[];
      setProjects(projectRows);
      setTrashedProjects(trashedRows);
      setFolders(folderRows);
      writeDashboardCache({ projects: projectRows, folders: folderRows, sceneStatsMap, storageUsageMap });
      // 라이브러리에서 cross-workspace 로 attach 할 때 picker 가 사용하는
      // workspace-independent 캐시 갱신. 라이브러리 워크스페이스의 DB 에는
      // `projects` 가 없어 직접 조회 불가하므로 여기서 미러링.
      const activeWsId = getCachedActiveId();
      if (activeWsId) {
        recordProjects(
          activeWsId,
          projectRows.map((p) => ({
            id: p.id,
            title: p.title ?? null,
            updated_at: p.updated_at ?? null,
            last_visited_at: p.last_visited_at ?? null,
          })),
        );
        // 이 워크스페이스에서 더 이상 존재하지 않는(삭제됐거나 휴지통에 들어간)
        // 프로젝트의 옛 캐시 엔트리를 청소 — 라이브러리 picker / 최근 항목에
        // 남아 다시 열리던 zombie 데이터까지 한 번에 제거. (휴지통 항목은
        // 본 목록에서 숨겨야 하므로 active 만 known 으로 넘긴다.)
        reconcileWorkspaceProjects(
          activeWsId,
          projectRows.map((p) => p.id),
        );
      }
      setLoading(false);

      // Project cards should not wait for the heavier scene/version JSON
      // pass. During conti generation, scene_versions.scenes changes often,
      // so calculate progress after the dashboard shell is already visible.
      if (projectRows.length === 0) {
        setSceneStatsMap({});
        return;
      }
      {
        const ids = projectRows.map((p) => p.id);
        const [{ data: sc }, { data: sv }] = await Promise.all([
          supabase
            .from("scenes")
            .select("project_id, conti_image_url, is_transition, source, is_final")
            .in("project_id", ids),
          supabase.from("scene_versions").select("id, project_id, scenes").in("project_id", ids),
        ]);
        const statsMap = projectRows.reduce(
          (acc, p) => {
            const activeVersionId = (p as any).active_version_id;

            // 탭 결정용 보유 여부 (버전 우선 순위와 독립)
            // hasContiScenes: 콘티탭에 씬 카드가 한 장이라도 있으면 true
            //   - scenes 테이블에 source='conti' 가 하나라도 있거나
            //   - scene_versions(콘티탭 버전 스냅샷)가 하나라도 존재하면 콘티 작업이 시작된 것으로 간주
            const projScenes = sc?.filter((s) => s.project_id === p.id) ?? [];
            const projVersions = sv?.filter((v) => v.project_id === p.id) ?? [];
            const hasContiInScenesTable = projScenes.some((s: any) => s.source === "conti");
            const hasDraftVersion = projVersions.length > 0;
            const hasContiScenes = hasContiInScenesTable || hasDraftVersion;
            const hasAgentScenes = projScenes.some((s: any) => s.source === "agent");

            // 1순위: active_version_id 기준
            if (activeVersionId) {
              const activeVersion = sv?.find((v) => v.id === activeVersionId);
              if (activeVersion) {
                const allScenes = Array.isArray(activeVersion.scenes) ? activeVersion.scenes : [];
                const scenes = allScenes.filter((s: any) => !s.is_transition);
                if (scenes.length > 0) {
                  acc[p.id] = {
                    total: scenes.length,
                    withConti: scenes.filter((s: any) => s.conti_image_url).length,
                    finalCount: scenes.filter((s: any) => s.is_final === true).length,
                    hasContiScenes,
                    hasAgentScenes,
                    hasDraftVersion,
                  };
                  return acc;
                }
              }
            }

            // 2순위: scenes 테이블
            const ps = projScenes.filter((s) => !s.is_transition);
            if (ps.length > 0) {
              acc[p.id] = {
                total: ps.length,
                withConti: ps.filter((s) => s.conti_image_url).length,
                finalCount: ps.filter((s: any) => s.is_final === true).length,
                hasContiScenes,
                hasAgentScenes,
                hasDraftVersion,
              };
              return acc;
            }

            // 3순위: 마지막 버전
            const projectVersions = sv?.filter((v) => v.project_id === p.id) ?? [];
            if (projectVersions.length > 0) {
              const lastVersion = projectVersions[projectVersions.length - 1];
              const allScenes = Array.isArray(lastVersion.scenes) ? lastVersion.scenes : [];
              const scenes = allScenes.filter((s: any) => !s.is_transition);
              acc[p.id] = {
                total: scenes.length,
                withConti: scenes.filter((s: any) => s.conti_image_url).length,
                finalCount: scenes.filter((s: any) => s.is_final === true).length,
                hasContiScenes,
                hasAgentScenes,
                hasDraftVersion,
              };
            } else {
              acc[p.id] = {
                total: 0,
                withConti: 0,
                finalCount: 0,
                hasContiScenes,
                hasAgentScenes,
                hasDraftVersion,
              };
            }
            return acc;
          },
          {} as Record<string, SceneStats>,
        );
        setSceneStatsMap(statsMap);
        writeDashboardCache({
          projects: projectRows,
          folders: folderRows,
          sceneStatsMap: statsMap,
          storageUsageMap,
        });
      }
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchData();
    // fetchData 는 컴포넌트 scope 함수라 매 렌더마다 새 ref → deps 에 넣으면
    // 무한 fetch 루프. mount 1회만 부르려는 의도가 명확하므로 빈 deps 가 정답.
    // PR-3 에서 fetchData 를 useCallback 으로 승격시키면 정식 dep 으로 전환.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* LibraryPage chunk idle prefetch — Dashboard 진입은 곧 사용자가 좌측
     사이드바의 워크스페이스 스위처 / 라이브러리 탭을 클릭할 가능성이 높은
     컨텍스트. lazy() 가 클릭 응답에 직접 fetch 비용을 박지 않도록 미리
     warm up 한다. import() 가 같은 specifier 두 번이면 vite 가 캐시 hit 으로
     처리하므로 LibraryKeepMountSlot 이 실제로 mount 할 때 chunk 가 즉시
     resolve. cleanup 은 짧게 mount 됐다 unmount 되는 케이스(라우트 전환
     도중) 의 idle 잡 자체를 취소. */
  useEffect(() => {
    return prefetchLibraryPage();
  }, []);

  // 프로젝트별 디스크 사용량 1 회 fetch — fetchData 와 의도적으로 분리.
  // - 디스크 walk 비용이 있어 첫 페인트를 막지 않도록 idle 콜백에 위임
  // - 30s TTL 캐시는 백엔드 라우터 쪽에 있으므로 클라이언트는 mount 1 회면 충분
  // - 프로젝트 목록이 비어 있으면 굳이 호출하지 않음 (모든 by_project 가 빈 객체)
  useEffect(() => {
    if (projects.length === 0) return;
    let cancelled = false;
    const run = async () => {
      try {
        const result = await getStorageUsageByProject();
        if (cancelled) return;
        const next = result.by_project ?? {};
        setStorageUsageMap(next);
        // 캐시에도 반영. fetchData 가 이후 다시 쓸 수도 있어 최신 sceneStatsMap 으로 동기화.
        writeDashboardCache({ projects, folders, sceneStatsMap, storageUsageMap: next });
      } catch {
        // best-effort. 칩이 안 보이는 정도의 영향이라 토스트는 띄우지 않음.
      }
    };
    const idle = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
    }).requestIdleCallback;
    const handle = idle ? idle(() => void run(), { timeout: 1500 }) : window.setTimeout(() => void run(), 200);
    return () => {
      cancelled = true;
      const cancel = (window as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
      if (idle && cancel) cancel(handle as number);
      else window.clearTimeout(handle as number);
    };
    // projects.length / .id 가 바뀐 시점이면 dataset 자체가 갱신된 것이라
    // 새 사용량을 다시 한 번 받아오는 게 자연스럽다. folders 이동만으로는 트리거되지 않음.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects.length]);

  useEffect(() => {
    const syncCardsPerRow = () => setCardsPerRow(readDashboardCardsPerRow());
    const syncViewMode = () => setViewMode(readDashboardViewMode());
    const syncSort = () => setSortPref(readDashboardSort());
    const syncSidebarWidth = () => setSidebarWidth(readDashboardSidebarWidth());
    const onStorage = (event: StorageEvent) => {
      if (event.key === "preflow.dashboard.cardsPerRow") syncCardsPerRow();
      else if (event.key === "preflow.dashboard.viewMode") syncViewMode();
      else if (event.key === "preflow.dashboard.sort") syncSort();
      else if (event.key === "preflow.dashboard.sidebarWidth") syncSidebarWidth();
    };
    window.addEventListener(DASHBOARD_CARDS_PER_ROW_CHANGED_EVENT, syncCardsPerRow);
    window.addEventListener(DASHBOARD_VIEW_MODE_CHANGED_EVENT, syncViewMode);
    window.addEventListener(DASHBOARD_SORT_CHANGED_EVENT, syncSort);
    window.addEventListener(DASHBOARD_SIDEBAR_WIDTH_CHANGED_EVENT, syncSidebarWidth);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(DASHBOARD_CARDS_PER_ROW_CHANGED_EVENT, syncCardsPerRow);
      window.removeEventListener(DASHBOARD_VIEW_MODE_CHANGED_EVENT, syncViewMode);
      window.removeEventListener(DASHBOARD_SORT_CHANGED_EVENT, syncSort);
      window.removeEventListener(DASHBOARD_SIDEBAR_WIDTH_CHANGED_EVENT, syncSidebarWidth);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  /* ── 드래그 핸들러 ── */
  const handleDragStart = ({ active }: DragStartEvent) => setActiveId(active.id as string);
  const handleDragOver = ({ over }: DragOverEvent) => setOverId(over ? String(over.id) : null);
  const handleDragEnd = async ({ active, over }: DragEndEvent) => {
    setActiveId(null);
    setOverId(null);
    if (!over) return;
    const projectId = active.id as string;
    const dropZone = String(over.id);

    // 휴지통으로 드롭 → soft delete. 의도적인 드래그 제스처 + 복원 가능하므로
    // 별도 확인 없이 즉시 이동(OS 휴지통 드래그와 동일한 감각). 옵티미스틱으로
    // 본 목록에서 먼저 제거해 카드가 바로 사라지게 하고, fetchData 로 휴지통
    // 목록/카운트를 동기화한다.
    if (dropZone === "sidebar-trash") {
      const project = projects.find((p) => p.id === projectId);
      if (!project) return;
      setProjects((prev) => {
        const next = prev.filter((p) => p.id !== projectId);
        writeDashboardCache({ projects: next, folders, sceneStatsMap, storageUsageMap });
        return next;
      });
      setSelectedIds((prev) => {
        if (!prev.has(projectId)) return prev;
        const n = new Set(prev);
        n.delete(projectId);
        return n;
      });
      try {
        await trashProject(projectId);
        toast({ title: t("dashboard.movedToTrash") });
      } catch (e: any) {
        toast({ variant: "destructive", title: t("project.toast.deleteFailed"), description: e?.message });
      }
      await fetchData();
      return;
    }

    const newFolderId =
      dropZone === "ungrouped" || dropZone === "sidebar-ungrouped"
        ? null
        : dropZone.replace("sidebar-folder-", "").replace("folder-", "");
    const project = projects.find((p) => p.id === projectId);
    if (!project || (project.folder_id ?? null) === (newFolderId ?? null)) return;
    setProjects((prev) => {
      const next = prev.map((p) => (p.id === projectId ? { ...p, folder_id: newFolderId } : p));
      writeDashboardCache({ projects: next, folders, sceneStatsMap, storageUsageMap });
      return next;
    });
    const { error } = await (supabase as any).from("projects").update({ folder_id: newFolderId }).eq("id", projectId);
    if (error) {
      toast({ variant: "destructive", title: t("dashboard.toast.moveFailed"), description: error.message });
      fetchData();
    }
  };

  /* ── 필터 + 카운트 ── */
  const searchedProjects = projects.filter(
    (p) =>
      p.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (p.client ?? "").toLowerCase().includes(searchQuery.toLowerCase()),
  );

  // 메인바의 필터 칩에 표시할 카운트는 검색 + 폴더 선택까지 반영된 풀에서
  // 계산해야 사용자가 "필터 안에서의 분포"를 자연스럽게 인식한다.
  // statusFilter 자체는 카운트에 적용하지 않음(자기 자신을 0 으로 만드는 race 방지).
  const folderScopedProjects = selectedFolderId
    ? searchedProjects.filter((p) => p.folder_id === selectedFolderId)
    : searchedProjects;

  const statusCounts = {
    all: folderScopedProjects.length,
    active: folderScopedProjects.filter((p) => p.status === "active").length,
    completed: folderScopedProjects.filter((p) => p.status === "completed").length,
  };

  const baseFiltered = folderScopedProjects.filter(
    (p) => statusFilter === "all" || p.status === statusFilter,
  );

  // 정렬: deadline / size / name × asc/desc.
  // - deadline: 빈 마감일은 항상 뒤로(asc/desc 동일) — UI 의도상 마감 없는 건 secondary 정보
  // - size: storageUsageMap 미수신 시 0 으로 간주 (idle fetch 도착 후 자연스럽게 재정렬)
  // - name: 한국어 + 영어 혼재라 localeCompare("ko-KR") 가 안전
  const sortedProjects = [...baseFiltered].sort((a, b) => {
    const dirMul = sortPref.dir === "asc" ? 1 : -1;
    if (sortPref.mode === "deadline") {
      const ta = a.deadline ? new Date(a.deadline).getTime() : Number.POSITIVE_INFINITY;
      const tb = b.deadline ? new Date(b.deadline).getTime() : Number.POSITIVE_INFINITY;
      // 빈 마감일은 dir 와 무관하게 항상 뒤로 보내야 자연스러움
      if (!Number.isFinite(ta) && !Number.isFinite(tb)) return 0;
      if (!Number.isFinite(ta)) return 1;
      if (!Number.isFinite(tb)) return -1;
      return (ta - tb) * dirMul;
    }
    if (sortPref.mode === "size") {
      const sa = storageUsageMap[a.id]?.bytes ?? 0;
      const sb = storageUsageMap[b.id]?.bytes ?? 0;
      return (sa - sb) * dirMul;
    }
    return a.title.localeCompare(b.title, "ko-KR") * dirMul;
  });

  const visibleProjects = sortedProjects;

  /* ── 다중 선택 헬퍼 ──
     선택 범위는 (가) 정책상 "현재 화면 안" — 폴더/필터/검색 변경 시 useEffect
     로 통째로 클리어하므로, 카드 렌더 시점에는 selectedIds 의 모든 원소가
     visible 에 있다고 가정해도 안전하다 (race 가 발생하면 다음 tick 의 clear
     이 처리). 그래서 selectedCount 는 단순히 selectedIds.size. */
  const selectedCount = selectedIds.size;
  const selectionActive = selectedCount > 0;

  /* 폴더/필터/검색 변경 시 자동 클리어 — (가) 정책: "보이지 않는 선택을
     남기지 않는다". visible 과 교차해 남길 수도 있지만, 사용자가 "선택했던
     게 어디 갔지?" 라고 헷갈리는 것보다 깔끔하게 비우는 쪽이 디버그성이
     좋고 의도가 명확하다. */
  useEffect(() => {
    if (selectedIds.size === 0) return;
    setSelectedIds(new Set());
    anchorIdRef.current = null;
    // 의존성을 키만 잡아 visible 자체가 바뀌어도 매번 클리어하지 않게 함.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFolderId, statusFilter, searchQuery]);

  /* 키보드:
     - Esc        : 선택 클리어 (모달이 열려 있을 땐 모달이 먼저 잡으므로 안전)
     - Cmd/Ctrl+A : 현재 보이는 항목 전체 선택
     입력 요소(input/textarea/contenteditable)에 포커스가 있을 땐 무시 — 검색
     박스에서 Cmd+A 가 텍스트 전체 선택의 기본 동작을 깨면 안 됨. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const inEditable =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        target?.isContentEditable === true;
      if (e.key === "Escape") {
        if (selectedIds.size > 0) {
          setSelectedIds(new Set());
          anchorIdRef.current = null;
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) {
        if (inEditable) return;
        if (visibleProjects.length === 0) return;
        e.preventDefault();
        const all = new Set(visibleProjects.map((p) => p.id));
        setSelectedIds(all);
        anchorIdRef.current = visibleProjects[0]?.id ?? null;
      }
      // Del / Backspace : 선택된 프로젝트를 휴지통으로 (확인 다이얼로그 경유).
      // 입력 요소 포커스 / 확인 다이얼로그가 이미 열려 있을 땐 무시.
      if (e.key === "Delete" || e.key === "Backspace") {
        if (inEditable || confirmBulkTrash) return;
        if (selectedIds.size === 0) return;
        e.preventDefault();
        setConfirmBulkTrash(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedIds, visibleProjects, confirmBulkTrash]);

  /* 카드/리스트 행 클릭 핸들러:
     - Shift+클릭     : anchor↔current 사이 visible 항목 모두 추가
     - Cmd/Ctrl+클릭  : 토글 (anchor 갱신)
     - 무수정 클릭    : selectionActive 면 토글, 아니면 navigate (이건 카드가 처리)
                       — 카드의 handleCardClick 가 selectionActive 일 때만
                         onSelectClick 을 호출하므로 이 분기엔 도달 시 항상
                         "선택 모드 내 클릭" 으로 간주해 토글한다. */
  const handleProjectSelectClick = (
    project: Project,
    mods: { ctrlOrMeta: boolean; shift: boolean },
  ) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (mods.shift && anchorIdRef.current) {
        const ids = visibleProjects.map((p) => p.id);
        const aIdx = ids.indexOf(anchorIdRef.current);
        const bIdx = ids.indexOf(project.id);
        if (aIdx >= 0 && bIdx >= 0) {
          const [lo, hi] = aIdx <= bIdx ? [aIdx, bIdx] : [bIdx, aIdx];
          for (let i = lo; i <= hi; i += 1) next.add(ids[i]);
          return next;
        }
      }
      if (next.has(project.id)) next.delete(project.id);
      else next.add(project.id);
      anchorIdRef.current = project.id;
      return next;
    });
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
    anchorIdRef.current = null;
  };
  const selectAllVisible = () => {
    if (visibleProjects.length === 0) return;
    setSelectedIds(new Set(visibleProjects.map((p) => p.id)));
    anchorIdRef.current = visibleProjects[0]?.id ?? null;
  };

  /* 선택된 프로젝트를 한 번에 휴지통으로 이동. visible 순서를 유지해 처리하고
     (선택은 visible 안에서만 이뤄짐), 끝나면 목록을 다시 읽고 선택을 비운다.
     soft delete 라 복원 가능하지만, 다건 처리는 실수 시 파장이 커서 확인
     다이얼로그를 거친 뒤 이 함수가 실행된다. */
  const confirmTrashSelected = async () => {
    const ids = visibleProjects.filter((p) => selectedIds.has(p.id)).map((p) => p.id);
    if (ids.length === 0) {
      setConfirmBulkTrash(false);
      return;
    }
    setBulkTrashing(true);
    let failed = 0;
    for (const id of ids) {
      try {
        await trashProject(id);
      } catch {
        failed += 1;
      }
    }
    setBulkTrashing(false);
    setConfirmBulkTrash(false);
    clearSelection();
    await fetchData();
    if (failed === 0) {
      toast({
        title:
          ids.length === 1
            ? t("dashboard.movedToTrash")
            : t("dashboard.selection.movedToTrashMany", { n: ids.length - failed }),
      });
    } else {
      toast({
        variant: "destructive",
        title: t("project.toast.deleteFailed"),
        description: `${failed}/${ids.length}`,
      });
    }
  };

  /* ── Phase 3 export/import 핸들러 ──
     단일 프로젝트 export 는 project 객체를 그대로 받아 scope=single 로 다이
     얼로그를 연다. workspace export 는 scope=workspace 로 모든 프로젝트를
     한 팩에 묶는다. import 는 ProjectImportDialog 가 자체 file picker 를
     쓰거나 drop 된 파일의 미리보기를 initialPreview 로 받는다. */
  const handleExportProject = (project: Project) => {
    setExportDialog({
      open: true,
      scope: "single",
      projectId: project.id,
      scopeLabel: project.title || "project",
      itemSummary: t("projPack.export.summarySingle", { title: project.title || "Untitled" }),
    });
  };
  const handleExportWorkspace = () => {
    setExportDialog({
      open: true,
      scope: "workspace",
      projectId: null,
      scopeLabel: `workspace-${new Date().toISOString().slice(0, 10)}`,
      itemSummary: t("projPack.export.summaryWorkspace", { n: projects.length }),
    });
  };
  /* ── Phase 4 — 선택 export 핸들러 ──
     선택된 N개 프로젝트를 한 팩으로 묶는다. 기본 팩 이름은 첫 프로젝트
     제목 + "-and-N-more" — backend 가 같은 규칙으로 다이얼로그 default 를
     만들기 때문에 UI 가 보여주는 라벨과 실제 저장 파일명이 어긋나지 않는다.
     visibleProjects 의 화면 순서를 유지해 호출 (선택은 visible 안에서만
     이뤄지므로 안전). */
  const handleExportSelection = () => {
    if (selectedIds.size === 0) return;
    const orderedIds = visibleProjects.filter((p) => selectedIds.has(p.id)).map((p) => p.id);
    if (orderedIds.length === 0) return;
    const first = projects.find((p) => p.id === orderedIds[0]);
    const firstTitle = first?.title || "project";
    const sampleTitles = orderedIds
      .slice(0, 3)
      .map((id) => projects.find((p) => p.id === id)?.title || "Untitled")
      .join(", ");
    const sample =
      orderedIds.length > 3 ? `${sampleTitles}, …` : sampleTitles;
    setExportDialog({
      open: true,
      scope: "selection",
      projectId: null,
      projectIds: orderedIds,
      scopeLabel:
        orderedIds.length === 1 ? firstTitle : `${firstTitle}-and-${orderedIds.length - 1}-more`,
      itemSummary: t("projPack.export.summarySelection", { n: orderedIds.length, sample }),
    });
  };
  const handleImportProject = () => {
    setImportDialog({ open: true, initialPreview: null });
  };
  const handleProjPackDropped = async (file: File) => {
    /* Electron 32+ 부터 File.path 가 제거돼 항상 undefined → 곧장 picker 폴백
       으로 떨어져 사용자가 "팩 선택..." 을 다시 눌러야 했다. preload 의
       webUtils.getPathForFile 로 절대경로를 받아 곧장 미리보기를 만들고,
       다이얼로그는 import 옵션 화면(가져오기 버튼 활성) 으로 진입한다.
       경로 해석/미리보기 어느 단계든 실패하면 안내 토스트만 띄우고 옛
       경로(빈 다이얼로그)를 열지 않는다 — 빈 다이얼로그는 "왜 또 골라야
       하지?" 라는 사용성 회귀를 만든다. */
    const filePath = window.preflowWindow?.getPathForFile?.(file) ?? "";
    if (!filePath) {
      toast({
        variant: "destructive",
        title: t("projPack.import.cannotRead"),
        description: file.name,
      });
      return;
    }
    try {
      const preview = await previewProjectPackFromPath(filePath);
      setImportDialog({ open: true, initialPreview: preview });
    } catch (err) {
      toast({
        variant: "destructive",
        title: t("projPack.import.cannotRead"),
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  /* 팩 파일(.preflowproj) 더블클릭 임포트 — 활성 워크스페이스가 프로젝트일 때만
     소비한다. 종류 전환은 App 의 PackOpenRouter 가 담당하고, 프로젝트가 활성이
     된 시점에 pending 을 집어 미리보기 → ProjectImportDialog(확인/import)로 연다. */
  useEffect(() => {
    const consume = async () => {
      const pending = readPendingPackPath();
      if (!pending || packKindFromPath(pending) !== "project") return;
      await ensureWorkspacesLoaded();
      if (getCachedActive()?.kind !== "project") return;
      clearPendingPackPath();
      try {
        const preview = await previewProjectPackFromPath(pending);
        setImportDialog({ open: true, initialPreview: preview });
      } catch (err) {
        toast({
          variant: "destructive",
          title: t("projPack.import.cannotRead"),
          description: err instanceof Error ? err.message : String(err),
        });
      }
    };
    void consume();
    return subscribePendingPack(() => {
      void consume();
    });
  }, [toast, t]);

  function isProjPackFile(name: string): boolean {
    return /\.preflowproj$/i.test(name);
  }

  // ── 사이드바용 파생 리스트 ────────────────────────────────────────
  // 즐겨찾기는 statusFilter / 폴더 선택과 무관하게 "유저가 찍은 별"만 보여주는
  // 게 직관적이라 projects 풀에서 직접 추출. 검색은 반영 — 사이드바도 검색
  // 필드에 입력한 키워드의 영향권 안에 있는 게 자연스럽다.
  const favoriteProjects = searchedProjects
    .filter((p) => !!p.is_favorite)
    .sort((a, b) => a.title.localeCompare(b.title, "ko-KR"));

  // RECENT 는 last_visited_at 이 채워진 프로젝트 중 최근 5개. 한 번도 들어가
  // 본 적 없는 프로젝트(legacy / 신규)는 자연스럽게 제외돼 빈 섹션이 노출되지
  // 않는다. 검색은 동일하게 반영.
  const recentProjects = searchedProjects
    .filter((p) => !!p.last_visited_at)
    .sort((a, b) => {
      const ta = new Date(a.last_visited_at ?? 0).getTime();
      const tb = new Date(b.last_visited_at ?? 0).getTime();
      return tb - ta;
    })
    .slice(0, 5);

  const activeProject = projects.find((p) => p.id === activeId);
  const mainTitle = selectedFolderId
    ? (folders.find((f) => f.id === selectedFolderId)?.name ?? t("dashboard.allProjects"))
    : t("dashboard.allProjects");

  return (
    <div
      className="h-screen overflow-hidden flex flex-col bg-background relative"
      onDragOver={(event) => {
        /* DataTransfer 에 file 이 있을 때만 드롭 모드. text 드래그(검색 입력
           등) 와의 충돌을 막기 위해 type 이 "Files" 인 경우만 받는다. */
        if (Array.from(event.dataTransfer.types || []).includes("Files")) {
          event.preventDefault();
          if (!packDragOver) setPackDragOver(true);
        }
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setPackDragOver(false);
      }}
      onDrop={(event) => {
        if (!Array.from(event.dataTransfer.types || []).includes("Files")) return;
        event.preventDefault();
        setPackDragOver(false);
        const files = Array.from(event.dataTransfer.files || []);
        const packFile = files.find((f) => isProjPackFile(f.name));
        if (packFile) void handleProjPackDropped(packFile);
      }}
    >
      <Navbar />

      <div className="flex flex-1 min-h-0 overflow-hidden">
        <DndContext
          sensors={sensors}
          collisionDetection={pointerWithin}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          {/* ━━━ 좌측 사이드바 ━━━ */}
          <aside
            className="flex flex-col flex-shrink-0 border-r border-border-subtle bg-surface-sidebar"
            style={{ width: sidebarWidth }}
          >
            {/* 검색 */}
            <div className="flex items-center px-3 border-b border-border-subtle flex-shrink-0" style={{ height: 48 }}>
              <div
                className="flex items-center gap-2 px-3 py-2 bg-surface-panel border border-border-subtle w-full"
                style={{ borderRadius: 0 }}
              >
                <Search className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t("common.search")}
                  className="bg-transparent border-none outline-none text-body text-text-secondary placeholder:text-muted-foreground w-full"
                />
                {searchQuery && (
                  <button onClick={() => setSearchQuery("")}>
                    <X className="w-3 h-3 text-muted-foreground hover:text-foreground transition-colors" />
                  </button>
                )}
              </div>
            </div>

            {/* Create Project */}
            <div className="px-3 py-3 border-b border-border-subtle flex-shrink-0">
              <button
                onClick={() => setIsModalOpen(true)}
                className="w-full flex items-center justify-center h-9 bg-primary hover:bg-primary/85 text-white text-meta font-semibold transition-colors"
                style={{ borderRadius: 0 }}
              >
                {/* 옵티컬 중앙 — flex justify-center 만 쓰면 trailing
                   letter-spacing(tracking-wide) + "New Project" 의 시각 무게가
                   우측에 몰려 raw-center 보다 우측으로 보인다. inline-flex
                   그룹으로 [icon][label] 을 묶고 라벨에서 tracking 을 떼면
                   trailing 여백이 사라져 시각 중심이 그룹 중앙과 일치. */}
                <span className="inline-flex items-center gap-1.5">
                  <Plus className="w-4 h-4" />
                  <span className="leading-none">{t("dashboard.newProject")}</span>
                </span>
              </button>
            </div>

            {/* 사이드바 본문: FAVORITES → FOLDERS → RECENT 순으로 한 칸씩 stack.
                전체를 flex-1 overflow-y-auto 로 감싸 폴더가 많아져 화면을 가득
                채워도 RECENT 가 footer 위로 적절히 스크롤되어 보이게 한다.
                좌우 px-2 는 Library 사이드바와 동일한 8px inset — 선택 행의
                border-l-2 (red bar) 가 사이드바 외곽 경계에 붙어 잘려 보이지
                않도록, 행과 hover/active 배경을 모두 살짝 안쪽으로 들인다. */}
            <div className="flex-1 overflow-y-auto px-2 pb-2">

              {/* FAVORITES — 별을 찍은 프로젝트가 하나 이상일 때만 노출.
                  비어 있으면 헤더 자체를 그리지 않아 사이드바 첫 시야가 깔끔. */}
              {favoriteProjects.length > 0 && (
                <>
                  <div className="flex items-center gap-2 px-2 pt-3 pb-1">
                    <span className="text-xs font-semibold tracking-[0.02em] text-muted-foreground">
                      {t("dashboard.favorites")}
                    </span>
                    <span className="text-caption tabular-nums text-text-tertiary">{favoriteProjects.length}</span>
                  </div>
                  <div className="flex flex-col">
                    {favoriteProjects.map((p) => (
                      <SidebarProjectRow
                        key={p.id}
                        project={p}
                        isCompleted={p.status === "completed"}
                        onClick={() => navigate(resolveProjectRoute(p.id, sceneStatsMap[p.id]))}
                      />
                    ))}
                  </div>
                </>
              )}

              {/* FOLDERS 헤더 — 메인 메뉴 제목(크기/굵기/컬러로 위계). */}
              <div className="flex items-center gap-2 px-2 pt-3 pb-1">
                <span className="text-xs font-semibold tracking-[0.02em] text-muted-foreground">
                  {t("dashboard.folders")}
                </span>
                <button
                  onClick={() => {
                    setEditFolder(null);
                    setIsFolderModalOpen(true);
                  }}
                  className="w-[18px] h-[18px] flex items-center justify-center border border-border-subtle text-muted-foreground hover:border-primary/50 hover:text-primary hover:bg-primary/[0.08] transition-all text-body leading-none"
                  style={{ borderRadius: 2 }}
                  title={t("dashboard.newFolder")}
                >
                  +
                </button>
              </div>

              {/* 폴더 목록 */}
              {folders.length === 0 && !loading && (
                <div className="px-2 py-2 text-meta text-text-tertiary">
                  {t("dashboard.noFolders")}
                </div>
              )}
              {folders.map((folder) => {
                const count = projects.filter((p) => p.folder_id === folder.id).length;
                const isSelected = selectedFolderId === folder.id;
                return (
                  <DroppableSidebarFolder
                    key={folder.id}
                    folder={folder}
                    count={count}
                    isSelected={isSelected}
                    isOver={overId === `sidebar-folder-${folder.id}`}
                    isDragging={!!activeId}
                    onSelect={() => setSelectedFolderId(isSelected ? null : folder.id)}
                    onEdit={() => {
                      setEditFolder(folder);
                      setIsFolderModalOpen(true);
                    }}
                  />
                );
              })}
              {/* 드래그 중일 때 Ungrouped 드롭존 노출 */}
              {activeId && <DroppableUngroupedSidebar isOver={overId === "sidebar-ungrouped"} />}

              {/* RECENT — 한 번도 들어가지 않은 프로젝트는 자연스럽게 제외돼
                  빈 섹션이 보이지 않는다. 표시 항목은 최대 5개. */}
              {recentProjects.length > 0 && (
                <>
                  <div className="flex items-center gap-2 px-2 pt-3 pb-1">
                    <span className="text-xs font-semibold tracking-[0.02em] text-muted-foreground">
                      {t("dashboard.recent")}
                    </span>
                  </div>
                  <div className="flex flex-col">
                    {recentProjects.map((p) => {
                      const rel = computeRelativeTime(p.last_visited_at);
                      const rightLabel = rel
                        ? rel.key === "justNow"
                          ? t("dashboard.justNow")
                          : t(`dashboard.${rel.key}`, { n: String(rel.value) })
                        : undefined;
                      return (
                        <SidebarProjectRow
                          key={p.id}
                          project={p}
                          rightLabel={rightLabel}
                          isCompleted={p.status === "completed"}
                          onClick={() => navigate(resolveProjectRoute(p.id, sceneStatsMap[p.id]))}
                        />
                      );
                    })}
                  </div>
                </>
              )}

              {/* 휴지통 — 삭제(soft delete)한 프로젝트가 모이는 곳. 항상 노출해
                  사용자가 "내가 지운 게 어디 갔지?" 를 헤매지 않게 한다. 단일
                  네비 항목이라 별도 섹션 헤더 없이 한 줄로만 둔다(FOLDERS 행과
                  동일한 위계). 카드를 여기로 드래그하면 곧장 휴지통으로 이동,
                  클릭하면 모달로 복원 / 영구 삭제. */}
              <DroppableTrashSidebar
                count={trashedProjects.length}
                isOver={overId === "sidebar-trash"}
                isDragging={!!activeId}
                onClick={() => setShowTrash(true)}
              />
            </div>

            {/* Workspace switcher footer (Phase: Discord-style switch).
                Sits below the scroll area as a flex-shrink-0 row so it
                always docks at the bottom of the sidebar regardless of
                folder count. Replaces the legacy floating ModeSwitcher
                that collided with the bottom-right toast viewport. */}
            <div className="border-t border-border-subtle p-1.5 flex-shrink-0">
              <WorkspaceSwitcher variant="full" />
            </div>
          </aside>

          {/* 사이드바 ↔ 메인 사이의 리사이즈 핸들. DnD 컨텍스트 자식이지만
              자체 PointerSensor 활성 거리(8 px) 가 mousedown 즉시 발사되는
              col-resize 와 충돌하지 않게 stopPropagation 처리됨. 더블클릭으로
              기본값(230 px) 복원. */}
          <SidebarResizeHandle
            width={sidebarWidth}
            onWidthChange={setSidebarWidth}
          />

          {/* ━━━ 메인 영역 ━━━ */}
          <main className="relative flex-1 flex flex-col min-w-0 min-h-0">
            {/* External-file 드래그 오버레이 — Library 의 드롭 시각화와 동일
                한 2-레이어 패턴(흐림 배경 + 점선 박스). main 의 자식으로 두어
                좌측 사이드바와 상단 Navbar 는 가려지지 않고 메인 컨텐츠 영역
                에만 표시된다(라이브러리의 그리드 section 만 덮는 동작과 같은
                결). pointer-events-none 이라 dragover/drop 이벤트는 그대로
                outer 의 핸들러로 전달돼 드롭 로직은 변하지 않는다. */}
            {packDragOver && (
              <>
                <div
                  className="pointer-events-none absolute inset-0 z-40 bg-background/70 backdrop-blur-md animate-in fade-in duration-150"
                />
                <div
                  className="pointer-events-none absolute inset-5 z-50 flex items-center justify-center border-2 border-dashed border-primary/80 bg-primary/[0.04] animate-in fade-in duration-150"
                  style={{ borderRadius: 0 }}
                >
                  <div className="text-center">
                    <Upload className="mx-auto mb-3 h-9 w-9 text-primary" />
                    <div className="text-subhead font-semibold">
                      {t("dashboard.dropToImport")}
                    </div>
                    <div className="mt-1 text-meta text-muted-foreground">
                      {t("dashboard.dropToImportDesc")}
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* 메인 바 */}
            <div
              className="flex items-center px-5 border-b border-border-subtle bg-surface-nav flex-shrink-0"
              style={{ height: 48 }}
            >
              <span className="text-label font-bold text-foreground/80">{mainTitle}</span>

              {/* 필터 칩 (카운트 인라인) — 기존 탭/언더라인 패턴은 유지하되 라벨에 카운트를 같이 표기.
                  카운트는 statusCounts 가 status 필터를 자기 자신에 적용하지 않은 풀에서 계산해
                  탭 전환 도중 0 으로 깜빡이지 않는다. */}
              <div className="ml-6 flex items-center gap-1">
                {(["all", "active", "completed"] as const).map((key) => {
                  const label =
                    key === "all"
                      ? t("common.all")
                      : key === "active"
                        ? t("common.active")
                        : t("common.done");
                  const count = statusCounts[key];
                  return (
                    <button
                      key={key}
                      onClick={() => setStatusFilter(key)}
                      className={cn(
                        "inline-flex items-center gap-1.5 px-2.5 h-[26px] text-caption font-medium tracking-wide border transition-all duration-100",
                        statusFilter === key
                          ? "border-primary/60 bg-primary/[0.08] text-primary"
                          : "border-border-subtle text-muted-foreground hover:text-text-secondary hover:border-border",
                      )}
                      style={{ borderRadius: 0 }}
                    >
                      {label}
                      <span
                        className={cn(
                          "tabular-nums text-2xs",
                          statusFilter === key ? "text-primary/80" : "text-text-tertiary",
                        )}
                      >
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* 정렬 드롭다운 + 뷰 토글 — 메인바 우측 정렬 */}
              <div className="ml-auto flex items-center gap-2">
                {/* Phase 3 — 워크스페이스 단위 export / project import 진입.
                    개별 프로젝트 export 는 카드/리스트 행의 ⋯ 메뉴로, 워크스
                    페이스 전체 export 와 import 는 여기서 한 곳에 모아 발견성을
                    유지. */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    {/* 워크스페이스 메뉴 트리거 — LibraryToolbar 의 outlined
                        action 버튼과 동일한 치수/타이포 스케일. h-8 (32px) +
                        h-3.5 (14px) 아이콘으로 라이브러리 우상단 그룹과 시각
                        무게 통일. 사각 모서리(`rounded-none`) 는 대시보드의
                        나머지 카드/리스트 행과 일치하도록 보존. */}
                    <Button
                      variant="outline"
                      className="h-8 gap-1.5 rounded-none px-2 text-caption"
                      title={t("dashboard.workspaceTools")}
                    >
                      <Package className="h-3.5 w-3.5" />
                      <span>{t("dashboard.workspaceMenu")}</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="bg-card border-border min-w-[200px]">
                    <DropdownMenuItem
                      onClick={handleExportWorkspace}
                      className="text-meta gap-2 cursor-pointer"
                    >
                      <Download className="w-3 h-3" /> {t("dashboard.exportWorkspace")}
                    </DropdownMenuItem>
                    {/* 선택 개수에 따라 활성화. 0 일 때는 disabled + tooltip 으로
                        "선택이 필요하다" 는 점을 안내해 발견성을 보강. */}
                    <DropdownMenuItem
                      disabled={selectedCount === 0}
                      onClick={handleExportSelection}
                      className="text-meta gap-2 cursor-pointer"
                      title={
                        selectedCount === 0
                          ? t("dashboard.exportSelectedDisabled")
                          : undefined
                      }
                    >
                      <CheckSquare className="w-3 h-3" />{" "}
                      {t("dashboard.exportSelected", { n: selectedCount })}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={handleImportProject}
                      className="text-meta gap-2 cursor-pointer"
                    >
                      <Upload className="w-3 h-3" /> {t("dashboard.importProject")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    {/* 정렬 트리거 — LibraryToolbar 의 sort dropdown 과 같은
                        패턴. 라이브러리는 *방향성 화살표 하나 + 라벨* 만으로
                        현재 정렬을 표현 (ArrowDownAZ/ArrowUpAZ). 대시보드도
                        같은 형태로 단순화하면 redundant 한 ArrowUpDown 리딩
                        아이콘이 빠지고 시각 정보 밀도가 적절해진다. */}
                    <Button
                      variant="outline"
                      className="h-8 gap-1.5 rounded-none px-2 text-caption"
                      title={t("dashboard.sortBy")}
                    >
                      {sortPref.dir === "asc" ? (
                        <ArrowUp className="h-3.5 w-3.5" />
                      ) : (
                        <ArrowDown className="h-3.5 w-3.5" />
                      )}
                      <span>
                        {sortPref.mode === "deadline"
                          ? t("dashboard.sortDeadline")
                          : sortPref.mode === "size"
                            ? t("dashboard.sortSize")
                            : t("dashboard.sortName")}
                      </span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="bg-card border-border min-w-[160px]">
                    <DropdownMenuLabel className="text-2xs font-semibold tracking-wider text-text-tertiary">
                      {t("dashboard.sortBy")}
                    </DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={sortPref.mode}
                      onValueChange={(v) => {
                        const next: DashboardSortPreference = { ...sortPref, mode: v as DashboardSortMode };
                        setSortPref(next);
                        saveDashboardSort(next);
                      }}
                    >
                      <DropdownMenuRadioItem value="deadline" className="text-meta">
                        {t("dashboard.sortDeadline")}
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="size" className="text-meta">
                        {t("dashboard.sortSize")}
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="name" className="text-meta">
                        {t("dashboard.sortName")}
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={(e) => {
                        e.preventDefault();
                        const next: DashboardSortPreference = {
                          ...sortPref,
                          dir: sortPref.dir === "asc" ? "desc" : "asc",
                        };
                        setSortPref(next);
                        saveDashboardSort(next);
                      }}
                      className="text-meta gap-2 cursor-pointer"
                    >
                      {sortPref.dir === "asc" ? (
                        <>
                          <ArrowUp className="w-3 h-3" /> {t("dashboard.sortAscending")}
                        </>
                      ) : (
                        <>
                          <ArrowDown className="w-3 h-3" /> {t("dashboard.sortDescending")}
                        </>
                      )}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                {/* 뷰 토글 — LibraryToolbar 의 segmented 컨트롤과 동일한
                    패턴. `bg-card p-0.5` 트랙 안에 h-7×w-7 정사각 토글 두
                    개를 두고, 활성 모드는 `variant="default"` (primary 솔리드
                    fill) 로 강하게 표시. 이전의 옅은 tint(`bg-primary/[0.12]`)
                    보다 활성 상태가 한눈에 들어와 라이브러리 우상단 그룹과
                    시각 무게가 일치한다. 사각 모서리는 대시보드 일관성을
                    위해 `rounded-none` 으로 유지. */}
                <div
                  className="flex items-center rounded-none border bg-card p-0.5"
                  role="tablist"
                  aria-label={t("dashboard.viewGrid")}
                >
                  <Button
                    type="button"
                    role="tab"
                    aria-selected={viewMode === "grid"}
                    variant={viewMode === "grid" ? "default" : "ghost"}
                    size="sm"
                    className="h-7 w-7 rounded-none p-0"
                    title={t("dashboard.viewGrid")}
                    onClick={() => {
                      setViewMode("grid");
                      saveDashboardViewMode("grid");
                    }}
                  >
                    <LayoutGrid className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    role="tab"
                    aria-selected={viewMode === "list"}
                    variant={viewMode === "list" ? "default" : "ghost"}
                    size="sm"
                    className="h-7 w-7 rounded-none p-0"
                    title={t("dashboard.viewList")}
                    onClick={() => {
                      setViewMode("list");
                      saveDashboardViewMode("list");
                    }}
                  >
                    <ListIcon className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>

            {/* ── Phase 4 — 다중 선택 컨텍스트 바 ──
                메인바와 프로젝트 목록 사이에 conditional row 로 슬라이드 인.
                안에서 N selected 라벨 / 전체 선택 / Export / Clear 액션을
                한 곳에 모은다. Workspace ▾ 의 "Export Selected" 와 동일한
                동작이지만, 발견성 차원에서 사용자의 시선이 머무는 위치에 함께
                노출. 0 일 때는 통째로 숨겨 layout shift 없이 본문 영역을 회복. */}
            {selectionActive && (
              <div
                className="flex items-center gap-3 px-5 border-b border-border-subtle bg-primary/[0.08] flex-shrink-0"
                style={{ height: 34 }}
              >
                <CheckSquare size={12} className="text-primary" />
                <span className="text-caption font-medium text-primary tabular-nums">
                  {selectedCount === 1
                    ? t("dashboard.selection.countOne")
                    : t("dashboard.selection.countMany", { n: selectedCount })}
                </span>
                <span className="text-2xs text-muted-foreground hidden md:inline">
                  {t("dashboard.selection.toggleHint")}
                </span>
                <div className="ml-auto flex items-center gap-2">
                  <button
                    onClick={selectAllVisible}
                    className="inline-flex items-center gap-1.5 px-2.5 h-[24px] text-caption font-medium tracking-wide text-text-secondary border border-border-subtle hover:border-border hover:text-foreground transition-colors"
                    style={{ borderRadius: 0 }}
                    title={t("dashboard.selection.selectAll")}
                  >
                    {t("dashboard.selection.selectAll")}
                  </button>
                  <button
                    onClick={handleExportSelection}
                    className="inline-flex items-center gap-1.5 px-2.5 h-[24px] text-caption font-medium tracking-wide text-primary border border-primary/50 hover:border-primary hover:bg-primary/[0.12] transition-colors"
                    style={{ borderRadius: 0 }}
                  >
                    <Download size={11} /> {t("dashboard.selection.export")}
                  </button>
                  <button
                    onClick={() => setConfirmBulkTrash(true)}
                    className="inline-flex items-center gap-1.5 px-2.5 h-[24px] text-caption font-medium tracking-wide text-destructive border border-destructive/50 hover:border-destructive hover:bg-destructive/10 transition-colors"
                    style={{ borderRadius: 0 }}
                    title={t("dashboard.selection.delete")}
                  >
                    <Trash2 size={11} /> {t("dashboard.selection.delete")}
                  </button>
                  <button
                    onClick={clearSelection}
                    className="inline-flex items-center gap-1.5 px-2.5 h-[24px] text-caption font-medium tracking-wide text-muted-foreground border border-border-subtle hover:border-border hover:text-text-secondary transition-colors"
                    style={{ borderRadius: 0 }}
                    title={t("dashboard.selection.clear")}
                  >
                    <X size={11} /> {t("dashboard.selection.clearShort")}
                  </button>
                </div>
              </div>
            )}

            {/* 프로젝트 목록 */}
            <div className="flex-1 overflow-y-auto px-5 py-5">
              {loading ? (
                <div className="grid gap-3" style={projectGridStyle}>
                  {[...Array(cardsPerRow)].map((_, i) => (
                    <SkeletonCard key={i} />
                  ))}
                </div>
              ) : visibleProjects.length === 0 ? (
                <div
                  className="border border-dashed border-border-subtle"
                  style={{ borderRadius: 0 }}
                >
                  <EmptyState
                    icon={<Film className="w-8 h-8" />}
                    title={searchQuery || statusFilter !== "all" ? t("dashboard.noResults") : t("dashboard.noProjects")}
                    description={
                      searchQuery || statusFilter !== "all"
                        ? t("dashboard.noResultsDesc")
                        : t("dashboard.noProjectsDesc")
                    }
                  />
                </div>
              ) : selectedFolderId ? (
                /* 특정 폴더 선택 뷰 — viewMode 에 따라 그리드 또는 리스트 */
                viewMode === "list" ? (
                  <div className="flex flex-col gap-1">
                    {visibleProjects.map((p) => (
                      <ProjectListRow
                        key={p.id}
                        project={p}
                        onRefresh={fetchData}
                        onEdit={(proj) => {
                          setEditProject(proj);
                          setIsModalOpen(true);
                        }}
                        onExport={handleExportProject}
                        sceneStats={sceneStatsMap[p.id]}
                        storageBytes={storageUsageMap[p.id]?.bytes}
                        selected={selectedIds.has(p.id)}
                        selectionActive={selectionActive}
                        onSelectClick={handleProjectSelectClick}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="grid gap-3" style={projectGridStyle}>
                    {visibleProjects.map((p) => (
                      <DraggableCard
                        key={p.id}
                        project={p}
                        onRefresh={fetchData}
                        onEdit={(proj) => {
                          setEditProject(proj);
                          setIsModalOpen(true);
                        }}
                        onExport={handleExportProject}
                        sceneStats={sceneStatsMap[p.id]}
                        storageBytes={storageUsageMap[p.id]?.bytes}
                        selected={selectedIds.has(p.id)}
                        selectionActive={selectionActive}
                        onSelectClick={handleProjectSelectClick}
                      />
                    ))}
                  </div>
                )
              ) : (
                /* All 뷰 — 폴더별 그룹핑 */
                <div className="space-y-8">
                  {folders.map((folder) => {
                    const folderProjects = visibleProjects.filter((p) => p.folder_id === folder.id);
                    if (folderProjects.length === 0) return null;
                    return (
                      <ProjectGroup
                        key={folder.id}
                        label={folder.name}
                        count={folderProjects.length}
                        projects={folderProjects}
                        sceneStatsMap={sceneStatsMap}
                        storageUsageMap={storageUsageMap}
                        cardsPerRow={cardsPerRow}
                        viewMode={viewMode}
                        onRefresh={fetchData}
                        onEditProject={(proj) => {
                          setEditProject(proj);
                          setIsModalOpen(true);
                        }}
                        onExportProject={handleExportProject}
                        isOver={overId === `folder-${folder.id}`}
                        droppableId={`folder-${folder.id}`}
                        selectedIds={selectedIds}
                        selectionActive={selectionActive}
                        onSelectClick={handleProjectSelectClick}
                      />
                    );
                  })}

                  {/* 미분류 프로젝트 — folder_id 가 없거나, 이미 삭제된 폴더를
                      가리키는(orphan) 프로젝트를 모두 포함한다. 옛 폴더 삭제 시
                      folder_id 를 비우지 않아 어떤 그룹에도 안 잡혀 "전체에서
                      안 보이는데 카운트엔 남는" 유령 프로젝트가 됐던 것을, 여기로
                      흡수해 항상 화면에 드러나게(선택/삭제 가능하게) 한다. */}
                  {(() => {
                    const ungrouped = visibleProjects.filter(
                      (p) => !p.folder_id || !folders.some((f) => f.id === p.folder_id),
                    );
                    if (ungrouped.length === 0) return null;
                    return (
                      <ProjectGroup
                        label={folders.length > 0 ? t("common.ungrouped") : undefined}
                        count={ungrouped.length}
                        projects={ungrouped}
                        sceneStatsMap={sceneStatsMap}
                        storageUsageMap={storageUsageMap}
                        cardsPerRow={cardsPerRow}
                        viewMode={viewMode}
                        selectedIds={selectedIds}
                        selectionActive={selectionActive}
                        onSelectClick={handleProjectSelectClick}
                        onRefresh={fetchData}
                        onEditProject={(proj) => {
                          setEditProject(proj);
                          setIsModalOpen(true);
                        }}
                        onExportProject={handleExportProject}
                        isOver={overId === "ungrouped"}
                        droppableId="ungrouped"
                      />
                    );
                  })()}
                </div>
              )}
            </div>
          </main>

          {/* DragOverlay — 커서 우측-아래에 붙는 작은 썸네일 프리뷰. 실물
              크기 카드는 사이드바 폴더로 드래그할 때 시야를 가려 사용성이
              나빴다. 16:9 소형 썸네일 + 제목 칩만 띄워 가볍게. */}
          <DragOverlay dropAnimation={null} modifiers={[snapPreviewToCursorRight]}>
            {activeProject && (
              <div
                className="pointer-events-none flex w-[132px] items-center gap-2 border border-primary/60 bg-card/95 p-1 shadow-lg shadow-black/40 backdrop-blur-sm"
                style={{ borderRadius: 0 }}
              >
                <div className="relative aspect-video w-[68px] shrink-0 overflow-hidden bg-background flex items-center justify-center">
                  {activeProject.thumbnail_url ? (
                    <img
                      src={activeProject.thumbnail_url}
                      alt=""
                      className="h-full w-full object-cover"
                      draggable={false}
                    />
                  ) : (
                    <Film className="h-3.5 w-3.5 text-muted-foreground/30" />
                  )}
                </div>
                <span className="min-w-0 flex-1 truncate text-caption font-medium text-foreground/90">
                  {activeProject.title || t("common.untitled")}
                </span>
              </div>
            )}
          </DragOverlay>
        </DndContext>
      </div>

      {/* 하단 상태바(`app-footer`)는 v2.0.0 사용성 정리에서 제거.
          Library 페이지에는 동일한 푸터가 없어 좌하단 WorkspaceSwitcher
          를 클릭해 Projects ↔ Library 를 오갈 때 사이드바 컬럼 높이가
          28px 만큼 들썩이는 layout-shift 가 발생했음 — 정보량(서버
          상태/카운트/빌드 라벨) 대비 가치가 낮아 그냥 잘라낸다.
          공통 `.app-footer` 클래스는 SettingsPage 가 계속 쓰므로 그대로 둔다. */}

      {/* ━━━ 모달 ━━━ */}
      <ProjectModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setEditProject(null);
        }}
        onSuccess={(id) => {
          fetchData();
          if (id && !editProject) navigate(`/project/${id}`);
        }}
        editProject={editProject}
        folders={folders}
        initialFolderId={editProject ? undefined : selectedFolderId}
      />
      <FolderModal
        isOpen={isFolderModalOpen}
        onClose={() => {
          setIsFolderModalOpen(false);
          setEditFolder(null);
        }}
        onSuccess={fetchData}
        editFolder={editFolder}
      />

      {/* 프로젝트 휴지통 — 사이드바 "휴지통" 항목으로 진입. 복원/영구 삭제 후
          fetchData 로 본 목록과 휴지통 목록을 다시 동기화한다. */}
      <TrashModal
        open={showTrash}
        onClose={() => setShowTrash(false)}
        projects={trashedProjects}
        onChanged={fetchData}
      />

      {/* 선택 항목 일괄 휴지통 이동 확인 — Del 키 / 선택 툴바 "휴지통으로
          이동" 버튼이 띄운다. */}
      <AlertDialog open={confirmBulkTrash} onOpenChange={(o) => !o && !bulkTrashing && setConfirmBulkTrash(false)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {selectedCount === 1
                ? t("dashboard.selection.trashConfirmTitleOne")
                : t("dashboard.selection.trashConfirmTitle", { n: selectedCount })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("dashboard.selection.trashConfirmDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={bulkTrashing}
              className="border-border hover:bg-secondary h-9 text-body"
            >
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // AlertDialogAction 은 기본적으로 클릭 시 닫는다. 비동기 처리
                // 중 다이얼로그가 먼저 닫히지 않도록 기본 동작을 막고 직접 제어.
                e.preventDefault();
                void confirmTrashSelected();
              }}
              disabled={bulkTrashing}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 h-9 text-body"
            >
              {t("dashboard.selection.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Phase 3 — 프로젝트 팩 export/import 다이얼로그.
          export 는 ProjectCard 의 ⋯ 메뉴 또는 메인바 Workspace ▾ 에서, import
          는 메인바 Workspace ▾ 또는 .preflowproj 파일 드롭으로 진입. */}
      {exportDialog && (
        <ProjectExportDialog
          open={exportDialog.open}
          onOpenChange={(open) => {
            if (!open) setExportDialog(null);
            else setExportDialog((prev) => (prev ? { ...prev, open: true } : prev));
          }}
          scope={exportDialog.scope}
          projectId={exportDialog.projectId}
          projectIds={exportDialog.projectIds}
          scopeLabel={exportDialog.scopeLabel}
          itemSummary={exportDialog.itemSummary}
        />
      )}
      <ProjectImportDialog
        open={importDialog.open}
        onOpenChange={(open) => {
          setImportDialog((prev) => ({ ...prev, open, initialPreview: open ? prev.initialPreview : null }));
        }}
        onComplete={() => {
          fetchData();
        }}
        initialPreview={importDialog.initialPreview}
      />
    </div>
  );
};

export default DashboardPage;
