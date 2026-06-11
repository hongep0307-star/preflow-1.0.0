import { MoreHorizontal, Edit2, Trash2, Crop, ImageIcon, Star, Calendar, HardDrive, Clock, Download, Check } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { format, isValid } from "date-fns";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { trashProject } from "@/lib/deleteProject";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { ThumbnailCropModal, type CropSettings } from "@/components/ThumbnailCropModal";
import type { Project, SceneStats } from "@/pages/DashboardPage";
import { useT } from "@/lib/uiLanguage";
import { formatBytes } from "@/lib/storageMaintenance";
import { cn } from "@/lib/utils";
import { computeDDay, computeRelativeTime, resolveProjectRoute } from "@/lib/dashboardCardHelpers";

interface ProjectListRowProps {
  project: Project;
  onRefresh: () => void;
  onEdit: (project: Project) => void;
  /** Phase 3 — .preflowproj 팩으로 단일 프로젝트 export. ProjectCard 와
   *  동일한 콜백. 미정의면 케밥 메뉴에 항목이 안 나온다. */
  onExport?: (project: Project) => void;
  sceneStats?: SceneStats;
  storageBytes?: number;
  /** Phase 4 — 다중 선택. ProjectCard 와 동일 의미. */
  selected?: boolean;
  selectionActive?: boolean;
  onSelectClick?: (project: Project, mods: { ctrlOrMeta: boolean; shift: boolean }) => void;
}

/** 그리드의 ProjectCard 와 동일한 정보를 한 줄짜리 가로 레이아웃으로 압축한 변형.
 *  대시보드 메인바 우측의 뷰 토글에서 List 모드를 골랐을 때 노출되며, 카드와
 *  같은 라우팅/즐겨찾기/편집/삭제 동작을 공유한다. 차이점은 시각 밀도뿐이라
 *  핵심 로직은 카드와 의도적으로 동일하게 유지(중복 코드의 사회적 비용 < 두
 *  컴포넌트가 따로 진화해 어긋나는 위험). */
export const ProjectListRow = ({
  project,
  onRefresh,
  onEdit,
  onExport,
  sceneStats,
  storageBytes,
  selected = false,
  selectionActive = false,
  onSelectClick,
}: ProjectListRowProps) => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const t = useT();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showCropModal, setShowCropModal] = useState(false);
  const [favoriteOptimistic, setFavoriteOptimistic] = useState<boolean | null>(null);
  const isFavorite = favoriteOptimistic ?? !!project.is_favorite;

  const handleDelete = async () => {
    try {
      await trashProject(project.id);
      toast({ title: t("dashboard.movedToTrash") });
      onRefresh();
    } catch (e: any) {
      toast({ variant: "destructive", title: t("project.toast.deleteFailed"), description: e.message });
    }
    setShowDeleteDialog(false);
  };

  const handleSaveCrop = async (crop: CropSettings) => {
    try {
      const { error } = await supabase
        .from("projects")
        .update({ thumbnail_crop: crop } as any)
        .eq("id", project.id);
      if (error) throw error;
      setShowCropModal(false);
      toast({ title: t("dashboard.thumbnailAdjusted") });
      onRefresh();
    } catch (e: any) {
      toast({ variant: "destructive", title: t("project.toast.saveFailed"), description: e.message });
    }
  };

  const handleToggleFavorite = async () => {
    const next = !isFavorite;
    setFavoriteOptimistic(next);
    try {
      const { error } = await supabase
        .from("projects")
        .update({ is_favorite: next } as Record<string, unknown>)
        .eq("id", project.id);
      if (error) throw error;
      onRefresh();
    } catch (e: any) {
      setFavoriteOptimistic(!next);
      toast({ variant: "destructive", title: t("project.toast.favoriteFailed"), description: e?.message ?? "" });
    }
  };

  const isCompleted = project.status === "completed";
  const crop = project.thumbnail_crop as CropSettings | null;
  const deadlineDate = project.deadline ? new Date(project.deadline) : null;
  const hasValidDeadline = !!deadlineDate && isValid(deadlineDate);
  const deadlineStr = hasValidDeadline ? format(deadlineDate, "MMM dd yyyy") : null;
  const dDay = computeDDay(project.deadline);
  const statusLabel = isCompleted
    ? t("dashboard.completedLabel")
    : t("dashboard.inProgress");

  // 카드와 동일한 정책의 호버 오버레이 라벨. updated_at 우선, 없으면 폴백.
  const updatedRel = computeRelativeTime(
    project.updated_at ?? project.last_visited_at ?? project.created_at,
  );
  const updatedRelLabel = updatedRel
    ? updatedRel.key === "justNow"
      ? t("dashboard.justNow")
      : t(`dashboard.${updatedRel.key}`, { n: String(updatedRel.value) })
    : null;

  const formatLabel = (() => {
    switch ((project.video_format ?? "").toLowerCase()) {
      case "vertical":
        return "9:16";
      case "horizontal":
        return "16:9";
      case "square":
        return "1:1";
      default:
        return project.video_format?.toUpperCase() ?? null;
    }
  })();

  const progressPercent = sceneStats && sceneStats.total > 0
    ? Math.round((sceneStats.finalCount / sceneStats.total) * 100)
    : 0;

  const handleRowClick = (e: React.MouseEvent) => {
    const ctrlOrMeta = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    if (onSelectClick && (selectionActive || ctrlOrMeta || shift)) {
      e.preventDefault();
      onSelectClick(project, { ctrlOrMeta, shift });
      return;
    }
    navigate(resolveProjectRoute(project.id, sceneStats));
  };

  return (
    <>
      <div
        onClick={handleRowClick}
        aria-selected={selected || undefined}
        className={cn(
          "group flex items-stretch h-[168px] bg-card border cursor-pointer transition-all duration-150",
          selected
            ? "border-primary bg-primary/[0.06] ring-1 ring-primary/60"
            : "border-border hover:border-primary/25 hover:bg-surface-elevated",
        )}
        style={{ borderRadius: 0 }}
      >
        {/* ── 좌측 썸네일 — 16:9 비율 (298×168). 그리드 카드와 동일한 비율을 써
            그리드↔리스트 전환 시 동일 시각 무게감을 유지한다. */}
        <div
          className="relative w-[298px] h-[168px] flex-shrink-0 overflow-hidden bg-background border-r border-border flex items-center justify-center"
          style={{ borderRadius: 0 }}
        >
          {/* 선택 체크박스 — ProjectCard 와 동일한 위치/동작 (그리드↔리스트
              전환 시 시각 일관성). */}
          {onSelectClick && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onSelectClick(project, {
                  ctrlOrMeta: e.ctrlKey || e.metaKey,
                  shift: e.shiftKey,
                });
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className={cn(
                "absolute top-2 left-2 z-20 flex h-5 w-5 items-center justify-center border transition-all duration-150",
                selected
                  ? "bg-primary border-primary text-white opacity-100"
                  : "bg-black/55 border-white/40 text-transparent opacity-0 group-hover:opacity-100 hover:bg-black/75 hover:border-white/70",
              )}
              style={{ borderRadius: 0 }}
              aria-pressed={selected}
              title={t("dashboard.selection.toggleHint")}
            >
              <Check className="w-3 h-3" strokeWidth={3} />
            </button>
          )}
          {formatLabel && (
            <span
              className={cn(
                "absolute z-10 bg-black/70 px-1.5 py-0.5 font-mono text-2xs font-semibold text-white transition-all duration-150",
                // ProjectCard 와 동일 — 이 카드가 selected 이거나 직접 호버
                // 중일 때만 슬라이드. selectionActive 만으로는 움직이지 않음.
                // y(top) 는 항상 동일하게 유지 — x 만 슬라이드 (체크박스 등장
                // 과 동시에 라벨이 위로 튀어 오르는 잡음 제거).
                !onSelectClick
                  ? "left-2 top-2"
                  : selected
                  ? "left-8 top-2"
                  : "left-2 top-2 group-hover:left-8",
              )}
            >
              {formatLabel}
            </span>
          )}

          {/* D-day 칩 — 그리드 카드와 동일하게 우상단으로 이동. 메타 영역과
              중복 표기되는 것을 막고 마감 임박을 한눈에 보여준다. */}
          {dDay.label && (
            <span
              className={cn(
                "absolute right-2 top-2 z-10 px-1.5 py-0.5 font-mono text-2xs font-semibold tracking-wide",
                dDay.isUrgent
                  ? "bg-primary/90 text-white"
                  : "bg-black/70 text-white",
              )}
              style={{ borderRadius: 0 }}
              title={deadlineStr ?? undefined}
            >
              {dDay.label}
            </span>
          )}

          {project.thumbnail_url ? (
            <img
              src={project.thumbnail_url}
              alt={project.title}
              className={cn(
                "w-full h-full object-cover transition-opacity",
                isCompleted && "opacity-60",
              )}
              loading="lazy"
              style={{
                objectPosition: crop ? `${crop.x}% ${crop.y}%` : "center",
                transform: crop && crop.scale > 1 ? `scale(${crop.scale})` : undefined,
                transformOrigin: crop ? `${crop.x}% ${crop.y}%` : undefined,
              }}
              decoding="async"
            />
          ) : (
            <ImageIcon className="w-8 h-8 text-muted-foreground/15" />
          )}

          {/* 호버 다크어닝 + 마지막 수정 시간 — 그리드 카드와 동일한 시각 언어. */}
          {updatedRelLabel && (
            <div
              className="pointer-events-none absolute inset-0 z-[5] bg-black/55 opacity-0 group-hover:opacity-100 transition-opacity duration-150 flex items-end"
              aria-hidden
            >
              <div className="flex items-center gap-1 px-2 py-1.5 text-2xs font-medium tracking-wide text-white/85">
                <Clock className="w-3 h-3 opacity-80" />
                <span className="truncate">{updatedRelLabel}</span>
              </div>
            </div>
          )}

          {/* 별 토글 — 그리드 ProjectCard 와 동일하게 썸네일 우하단 코너. 동일
              시각 언어로 통일해 그리드↔리스트 전환 시 별 위치가 흔들리지 않게. */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              void handleToggleFavorite();
            }}
            className={cn(
              "absolute right-1.5 bottom-1.5 z-10 flex h-7 w-7 items-center justify-center transition-all duration-150",
              isFavorite
                ? "text-primary opacity-100"
                : "text-white opacity-0 group-hover:opacity-60 hover:!opacity-100",
            )}
            style={{
              borderRadius: 0,
              filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.55))",
            }}
            title={isFavorite ? t("dashboard.removeFromFavorites") : t("dashboard.addToFavorites")}
            aria-pressed={isFavorite}
          >
            <Star className="w-4 h-4" fill={isFavorite ? "currentColor" : "none"} strokeWidth={2} />
          </button>
        </div>

        {/* ── 우측 본문 — 그리드 카드 하단부와 동일한 3 단 구조(헤더/진행/메타).
            세로 배치로 펼쳐 더 많은 메타가 깨지지 않게 호흡을 둔다. */}
        <div className="flex-1 min-w-0 flex flex-col justify-between gap-2 px-4 py-3">
          {/* 헤더: 제목 + subtitle, 우측에 더보기 메뉴 (별 토글은 썸네일 우하단으로
              이전됨 — 그리드 카드와 시각 언어 통일). */}
          <div className="flex items-start gap-2 min-w-0">
            <div className="min-w-0 flex-1">
              <div className="truncate text-label font-bold tracking-wide text-foreground group-hover:text-primary transition-colors">
                {project.title}
              </div>
              {project.client && (
                <div className="truncate text-meta text-text-tertiary mt-0.5">
                  {project.client}
                </div>
              )}
            </div>

            <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-150">
              <DropdownMenu>
                <DropdownMenuTrigger
                  onClick={(e) => e.stopPropagation()}
                  className="p-1 hover:bg-secondary transition-colors"
                  style={{ borderRadius: 0 }}
                >
                  <MoreHorizontal className="w-3.5 h-3.5 text-muted-foreground/50 hover:text-muted-foreground transition-colors" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="bg-card border-border min-w-[110px]">
                  {project.thumbnail_url && (
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowCropModal(true);
                      }}
                      className="text-meta gap-2 cursor-pointer"
                    >
                      <Crop className="w-3 h-3" /> {t("dashboard.editThumbnail")}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      onEdit(project);
                    }}
                    className="text-meta gap-2 cursor-pointer"
                  >
                    <Edit2 className="w-3 h-3" /> {t("common.edit")}
                  </DropdownMenuItem>
                  {onExport && (
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation();
                        onExport(project);
                      }}
                      className="text-meta gap-2 cursor-pointer"
                    >
                      <Download className="w-3 h-3" /> {t("dashboard.exportProject")}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowDeleteDialog(true);
                    }}
                    className="text-meta gap-2 text-destructive focus:text-destructive cursor-pointer"
                  >
                    <Trash2 className="w-3 h-3" /> {t("common.delete")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* 진행: 상태 라벨 + 진행 바 + 카운트 (그리드 카드와 동일 패턴) */}
          <div
            className="flex items-center gap-2 min-w-0"
            title={
              sceneStats && sceneStats.total > 0
                ? `${sceneStats.finalCount} of ${sceneStats.total} scenes finalized`
                : undefined
            }
          >
            <span
              className={cn(
                "shrink-0 text-micro font-semibold tracking-[0.12em]",
                isCompleted ? "text-emerald-400/80" : "text-primary/85",
              )}
            >
              {statusLabel}
            </span>
            <div
              className="flex-1 h-[2px] overflow-hidden"
              style={{ background: "rgba(255,255,255,0.07)", borderRadius: 0 }}
            >
              {sceneStats && sceneStats.total > 0 && (
                <div
                  className="h-full transition-all duration-300"
                  style={{
                    width: `${progressPercent}%`,
                    background: isCompleted ? "rgba(52,211,153,0.9)" : "#f9423a",
                    borderRadius: 0,
                  }}
                />
              )}
            </div>
            <span className="text-2xs font-mono tabular-nums text-white/30 flex-shrink-0 whitespace-nowrap">
              {sceneStats && sceneStats.total > 0
                ? `${sceneStats.finalCount} / ${sceneStats.total}`
                : "0 / 0"}
            </span>
          </div>

          {/* 메타: 좌측 마감일(아이콘+텍스트) / 우측 디스크 사용량(아이콘+텍스트). */}
          <div className="flex items-center justify-between gap-2 min-w-0">
            <span
              className="inline-flex items-center gap-1 min-w-0 text-2xs tabular-nums tracking-wide text-white/45"
              title={hasValidDeadline ? deadlineStr ?? undefined : undefined}
            >
              <Calendar className="w-3 h-3 shrink-0 opacity-70" />
              <span className="truncate">
                {hasValidDeadline ? deadlineStr : t("dashboard.noDeadline")}
              </span>
            </span>

            {typeof storageBytes === "number" && storageBytes > 0 && (
              <span
                className="inline-flex shrink-0 items-center gap-1 text-2xs tabular-nums tracking-wide text-white/45"
                title={t("dashboard.storageUsageTooltip", { size: formatBytes(storageBytes) })}
              >
                <HardDrive className="w-3 h-3 shrink-0 opacity-70" />
                <span className="whitespace-nowrap">{formatBytes(storageBytes)}</span>
              </span>
            )}
          </div>
        </div>
      </div>

      {showCropModal && project.thumbnail_url && (
        <ThumbnailCropModal
          imageUrl={project.thumbnail_url}
          initial={crop}
          onSave={handleSaveCrop}
          onClose={() => setShowCropModal(false)}
        />
      )}

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dashboard.moveToTrashTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("dashboard.moveToTrashDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-border hover:bg-secondary h-9 text-body">{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 h-9 text-body"
            >
              {t("dashboard.moveToTrash")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
