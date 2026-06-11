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

interface ProjectCardProps {
  project: Project;
  onRefresh: () => void;
  onEdit: (project: Project) => void;
  /** Phase 3 — .preflowproj 팩으로 단일 프로젝트 export 다이얼로그를 띄울 때
   *  부모(DashboardPage)에 알리는 콜백. 미정의면 케밥 메뉴에 항목이 안 나온다. */
  onExport?: (project: Project) => void;
  sceneStats?: SceneStats;
  /** 프로젝트의 모든 버킷에 누적된 이미지/파일 사용량(바이트). DashboardPage 가
   *  idle 시점에 한 번 계산해 내려준다. 0/undefined 면 칩을 숨겨 카드 레이아웃이
   *  비어 있는 동안 깜빡이지 않도록 한다. */
  storageBytes?: number;
  /** Phase 4 — 다중 선택. true 면 카드에 selected 시각(ring + 체크박스 fill)
   *  을 적용. */
  selected?: boolean;
  /** 부모(Dashboard)에 선택이 1개 이상 존재해 "선택 모드" 진입 상태인지.
   *  true 일 때는 카드의 평범한 클릭도 navigate 대신 토글로 흡수한다 (Finder
   *  / Lightroom 패턴). false 이면 평범 클릭은 기존대로 navigate. */
  selectionActive?: boolean;
  /** 사용자가 카드 본체를 클릭했을 때 부모가 결정하는 핸들러. modifier 정보
   *  를 함께 전달. 미정의면 다중 선택 기능 자체가 꺼진 것으로 본다 (선택
   *  모드 진입 불가). */
  onSelectClick?: (project: Project, mods: { ctrlOrMeta: boolean; shift: boolean }) => void;
}

export const ProjectCard = ({
  project,
  onRefresh,
  onEdit,
  onExport,
  sceneStats,
  storageBytes,
  selected = false,
  selectionActive = false,
  onSelectClick,
}: ProjectCardProps) => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const t = useT();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showCropModal, setShowCropModal] = useState(false);
  // 별 토글은 지연 없이 시각만 즉시 갱신되도록 옵티미스틱 업데이트.
  // 실제 DB 응답 후 onRefresh() 가 다시 진실값으로 덮어씀.
  const [favoriteOptimistic, setFavoriteOptimistic] = useState<boolean | null>(null);
  const isFavorite = favoriteOptimistic ?? !!project.is_favorite;

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
      // 실패 시 시각 롤백.
      setFavoriteOptimistic(!next);
      toast({ variant: "destructive", title: t("project.toast.favoriteFailed"), description: e?.message ?? "" });
    }
  };

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

  const isCompleted = project.status === "completed";
  const crop = project.thumbnail_crop as CropSettings | null;

  const deadlineDate = project.deadline ? new Date(project.deadline) : null;
  const hasValidDeadline = !!deadlineDate && isValid(deadlineDate);
  const deadlineStr = hasValidDeadline ? format(deadlineDate, "MMM dd yyyy") : "—";
  const dDay = computeDDay(project.deadline);

  // 호버 오버레이에 표시할 "마지막 수정 시간". updated_at 이 비어 있는 (마이
  // 그레이션 직후 한순간) 경우만 last_visited_at → created_at 으로 폴백한다.
  const updatedRel = computeRelativeTime(
    project.updated_at ?? project.last_visited_at ?? project.created_at,
  );
  const updatedRelLabel = updatedRel
    ? updatedRel.key === "justNow"
      ? t("dashboard.justNow")
      : t(`dashboard.${updatedRel.key}`, { n: String(updatedRel.value) })
    : null;

  /* 비율 표기 */
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

  // 진행 행에 들어갈 상태 라벨. completed 가 우선이고, 그 외엔 "IN PROGRESS"
  // 로 통일. status 컬럼에 다른 값이 들어 있어도 fallback 으로 IN PROGRESS.
  const statusLabel = isCompleted
    ? t("dashboard.completedLabel")
    : t("dashboard.inProgress");
  const progressPercent = sceneStats && sceneStats.total > 0
    ? Math.round((sceneStats.finalCount / sceneStats.total) * 100)
    : 0;

  /* ── 카드 본체 클릭 라우팅 ──
   *  modifier (Ctrl/Cmd/Shift) 가 눌렸거나 부모 페이지가 이미 "선택 모드"(다른
   *  카드가 선택되어 있음) 라면 navigate 하지 않고 onSelectClick 으로 위임 →
   *  부모가 selectedIds 를 조정. 그 외에는 기존대로 프로젝트 페이지로 이동.
   *  onSelectClick 미정의면 다중 선택 기능이 꺼진 것으로 보고 modifier 도 무시. */
  const handleCardClick = (e: React.MouseEvent) => {
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
      {/* ━━━ 썸네일 중심 카드 ━━━ */}
      <div
        onClick={handleCardClick}
        aria-selected={selected || undefined}
        className={cn(
          "group flex h-full min-w-0 flex-col bg-card border cursor-pointer transition-all duration-150",
          selected
            ? "border-primary bg-primary/[0.06] ring-1 ring-primary/60"
            : "border-border hover:border-primary/25 hover:bg-surface-elevated",
        )}
        style={{ borderRadius: 0 }}
      >
        {/* ── 썸네일 — 프로젝트 video_format 과 무관하게 16:9 고정. */}
        <div
          className="relative aspect-video w-full overflow-hidden bg-background border-b border-border flex items-center justify-center group/thumb"
          style={{ borderRadius: 0 }}
        >
          {/* 선택 체크박스 — 좌상단. 평소엔 호버 시에만 fade-in, selected 면
              항상 표시. z-20 으로 format chip(z-10) 위에 떠서 선택 모드일 때
              format label 을 잠시 가린다 (의도된 우선순위). dnd-kit 의 Pointer
              Sensor 가 mouseDown 으로 드래그를 시작하지 않도록 stopPropagation. */}
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
          {/* 좌상단 배지 스택 — formatLabel(비율) + 즐겨찾기 Badge.
              Library 카드와 동일한 좌상단 세로 스택 패턴(타입 라벨 → 즐겨찾기
              Badge, `flex flex-col items-start gap-1`)으로 통일.

              슬라이드 동작: selection mode 진입 시 좌상단 체크박스 자리
              (left-1.5, w-5)를 비켜 줘야 한다. 이전엔 스택 wrapper 자체를
              left-2 → left-8 로 옮겨 두 배지가 함께 밀리는 부수 효과가
              있었다(즐겨찾기 위치까지 변동 → 시각 잡음). 지금은 wrapper 는
              고정해 두고, formatLabel 한 칸에만 `translate-x-6`(=24px,
              left-2 ↔ left-8 거리와 동일) 을 걸어 비율 라벨만 비켜 가고
              즐겨찾기는 항상 같은 자리에 머문다. */}
          <div className="absolute left-2 top-2 z-10 flex flex-col items-start gap-1 pointer-events-none">
            {formatLabel && (
              <span
                className={cn(
                  "pointer-events-auto bg-black/70 px-1.5 py-0.5 font-mono text-2xs font-semibold text-white transition-transform duration-150",
                  !onSelectClick
                    ? ""
                    : selected
                    ? "translate-x-6"
                    : "group-hover:translate-x-6",
                )}
                style={{ borderRadius: 0 }}
              >
                {formatLabel}
              </span>
            )}
            {/* 즐겨찾기 — favorited 면 KR 빨간 Badge 로 항상 노출(Library 와
                동일). non-favorited 는 호버 시 가벼운 outline 으로 등장해
                토글 affordance 만 제공. 카드 클릭으로 프로젝트 진입이 일어
                나면 안 되므로 e.stopPropagation 필수. */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                void handleToggleFavorite();
              }}
              className={cn(
                // 위쪽 체크박스(h-5 w-5)와 동일한 정사각 hit-target.
                // 이전엔 px-1 로 가로만 컨텐츠 폭에 맞춰 22px 가까이 부풀어
                // 체크박스보다 한 픽셀씩 더 커 보였음. w-5 로 강제 정사각.
                "pointer-events-auto flex h-5 w-5 items-center justify-center transition-opacity duration-150",
                isFavorite
                  ? "bg-primary/90 text-primary-foreground opacity-100 hover:bg-primary"
                  : "border border-white/40 bg-black/55 text-white/80 opacity-0 group-hover:opacity-100 hover:bg-black/75 hover:border-white/70",
              )}
              style={{ borderRadius: 0 }}
              title={isFavorite ? t("dashboard.removeFromFavorites") : t("dashboard.addToFavorites")}
              aria-pressed={isFavorite}
              aria-label={isFavorite ? t("dashboard.removeFromFavorites") : t("dashboard.addToFavorites")}
            >
              <Star
                className="h-3 w-3"
                fill={isFavorite ? "currentColor" : "none"}
                strokeWidth={2.5}
              />
            </button>
          </div>

          {/* D-day 칩 — 마감일 있을 때만. 임박/초과는 빨강(primary), 그 외는 중립.
              completed 프로젝트도 카드가 dim 처리되지 않는 한 같이 보여 사용자가
              "마감을 어느 정도 여유 있게 끝냈는지" 회고할 수 있게 한다. */}
          {dDay.label && (
            <span
              className={cn(
                "absolute right-2 top-2 z-10 px-1.5 py-0.5 font-mono text-2xs font-semibold tracking-wide",
                dDay.isUrgent
                  ? "bg-primary/90 text-white"
                  : "bg-black/70 text-white",
              )}
              style={{ borderRadius: 0 }}
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

          {/* 호버 오버레이 — 썸네일을 어둡게 깔고 좌하단에 시계 아이콘 + 마지막
              수정 시간. 정보를 가리지 않도록 평소엔 opacity 0, 카드 hover 시
              부드럽게 페이드. 마지막 수정 시간이 없으면(이론상 거의 없음)
              오버레이 자체를 띄우지 않는다. pointer-events-none 으로 둬서 카드
              본체의 클릭 핸들러를 그대로 통과시킨다. */}
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

          {/* 별 토글은 좌상단 배지 스택으로 이전됨 — Library 좋아요 표시와
              동일 코너/동일 시각 언어로 정합. 우하단의 옛 토글 위치는 호버
              다크어닝(z-5) 위에 떠 있어 시인성은 확보됐지만, 대시보드와
              Library 가 같은 좋아요를 다른 위치에서 다른 모양으로 보이게 해
              사용자 인지 비용이 컸음. */}
        </div>

        {/* ── 하단 정보: 제목+subtitle / 상태+진척 / 메타 ── */}
        <div className="flex min-h-[88px] flex-1 flex-col justify-between gap-2 px-3 py-2.5">
          <div className="flex items-start gap-2 min-w-0">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 min-w-0">
                <h3
                  className="min-w-0 flex-1 truncate text-body font-bold tracking-wide group-hover:text-primary transition-colors"
                  style={{ color: isCompleted ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.9)" }}
                >
                  {project.title}
                </h3>
              </div>
              {project.client && (
                <div
                  className="truncate text-caption tracking-wide text-text-tertiary mt-0.5"
                  title={project.client}
                >
                  {project.client}
                </div>
              )}
            </div>

            {/* 별 토글은 썸네일 우하단으로 이전됨 (제목 행과의 시각 충돌 제거 +
                favorited 상태가 멀리서도 한눈에 보이도록). 여긴 더보기(⋯) 메뉴만
                남음. */}
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

          {/* 상태 라벨 + 진행 바 + 카운트 — 진행도는 sceneStats.finalCount 기준 */}
          <div
            className="flex items-center gap-2 min-w-0"
            title={
              sceneStats && sceneStats.total > 0
                ? t("project.scenesFinalizedTooltip", { done: sceneStats.finalCount, total: sceneStats.total })
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

          {/* 메타 행 — 좌측에 마감일(Calendar 아이콘 + 텍스트), 우측에 디스크
              사용량(HardDrive 아이콘 + 텍스트). bordered 칩 대신 inline 표기로
              시각 노이즈를 줄이고 아이콘으로 정보 종류를 즉시 인지하게 함.
              D-day 는 썸네일 우상단, client 는 subtitle 로 이미 이전됨. */}
          <div className="flex items-center justify-between gap-2 min-w-0">
            <span
              className="inline-flex items-center gap-1 min-w-0 text-2xs tabular-nums tracking-wide text-white/45"
              title={hasValidDeadline ? deadlineStr : undefined}
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

      {/* Crop Modal */}
      {showCropModal && project.thumbnail_url && (
        <ThumbnailCropModal
          imageUrl={project.thumbnail_url}
          initial={crop}
          onSave={handleSaveCrop}
          onClose={() => setShowCropModal(false)}
        />
      )}

      {/* Delete Dialog */}
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
