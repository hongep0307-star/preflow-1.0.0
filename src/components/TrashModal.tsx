import { useState } from "react";
import { Trash2, RotateCcw, ImageIcon, Loader2, AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
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
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { restoreProject, deleteProjectCompletely } from "@/lib/deleteProject";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/lib/uiLanguage";
import { cn } from "@/lib/utils";
import { computeRelativeTime } from "@/lib/dashboardCardHelpers";
import type { Project } from "@/pages/DashboardPage";

interface TrashModalProps {
  open: boolean;
  onClose: () => void;
  /** deleted_at 이 채워진 프로젝트들 (삭제 최신순 정렬되어 전달됨). */
  projects: Project[];
  /** 복원/영구삭제 후 대시보드 데이터를 다시 읽도록 부모에 알린다. */
  onChanged: () => void;
}

/** 프로젝트 휴지통 — soft delete 된 프로젝트의 복원 / 영구 삭제 전용 패널.
 *  사이드바 "휴지통" 항목 클릭 시 열린다. 영구 삭제는 deleteProjectCompletely
 *  를 호출해 DB 행 + storage 파일 + workspace-independent 캐시를 모두 정리한다. */
export const TrashModal = ({ open, onClose, projects, onChanged }: TrashModalProps) => {
  const t = useT();
  const { toast } = useToast();
  // 진행 중 행 id (스피너 표시 + 중복 클릭 방지).
  const [busyId, setBusyId] = useState<string | null>(null);
  // 영구 삭제 확인 대상 (단일) / 휴지통 비우기 확인 플래그.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [emptying, setEmptying] = useState(false);

  const handleRestore = async (id: string) => {
    setBusyId(id);
    try {
      await restoreProject(id);
      toast({ title: t("dashboard.restoredToast") });
      onChanged();
    } catch (e: any) {
      toast({ variant: "destructive", title: t("project.toast.deleteFailed"), description: e?.message });
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteForever = async (id: string) => {
    setBusyId(id);
    try {
      await deleteProjectCompletely(id);
      toast({ title: t("dashboard.deletedForeverToast") });
      onChanged();
    } catch (e: any) {
      toast({ variant: "destructive", title: t("project.toast.deleteFailed"), description: e?.message });
    } finally {
      setBusyId(null);
      setConfirmDeleteId(null);
    }
  };

  const handleEmptyTrash = async () => {
    setEmptying(true);
    try {
      // 순차 삭제 — 각 삭제가 storage purge + DB + 캐시 정리를 포함하므로
      // 동시성 폭주보다 직렬이 안전하고 진행 표시도 자연스럽다.
      for (const p of projects) {
        await deleteProjectCompletely(p.id);
      }
      toast({ title: t("dashboard.deletedForeverToast") });
      onChanged();
    } catch (e: any) {
      toast({ variant: "destructive", title: t("project.toast.deleteFailed"), description: e?.message });
    } finally {
      setEmptying(false);
      setConfirmEmpty(false);
    }
  };

  const confirmTarget = projects.find((p) => p.id === confirmDeleteId) ?? null;

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent
          size="xl"
          className="p-0 gap-0"
        >
          <DialogHeader className="px-5 pt-5 pb-3 border-b border-border-subtle">
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="h-4 w-4" /> {t("dashboard.trashTitle")}
              <span className="text-caption font-normal tabular-nums text-text-tertiary">
                {projects.length}
              </span>
            </DialogTitle>
            <DialogDescription>
              {t("dashboard.trashDesc")}
            </DialogDescription>
          </DialogHeader>

          {projects.length === 0 ? (
            <div className="px-5 py-10">
              <EmptyState
                icon={<Trash2 className="w-8 h-8" />}
                title={t("dashboard.trashEmpty")}
              />
            </div>
          ) : (
            <div className="max-h-[55vh] overflow-y-auto px-3 py-3">
              <div className="flex flex-col gap-1">
                {projects.map((p) => {
                  const rel = computeRelativeTime(p.deleted_at);
                  const whenLabel = rel
                    ? rel.key === "justNow"
                      ? t("dashboard.justNow")
                      : t(`dashboard.${rel.key}`, { n: String(rel.value) })
                    : "";
                  const busy = busyId === p.id;
                  return (
                    <div
                      key={p.id}
                      className="group flex items-center gap-3 border border-border-subtle bg-background/40 px-3 py-2"
                      style={{ borderRadius: 0 }}
                    >
                      {/* 썸네일 */}
                      <div className="relative h-10 w-[71px] flex-shrink-0 overflow-hidden border border-border bg-background flex items-center justify-center">
                        {p.thumbnail_url ? (
                          <img
                            src={p.thumbnail_url}
                            alt={p.title}
                            className="h-full w-full object-cover opacity-70"
                            loading="lazy"
                          />
                        ) : (
                          <ImageIcon className="h-4 w-4 text-muted-foreground/20" />
                        )}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="truncate text-body font-semibold text-foreground/90">
                          {p.title || t("common.untitled")}
                        </div>
                        <div className="truncate text-caption text-text-tertiary">
                          {whenLabel ? t("dashboard.trashedAt", { when: whenLabel }) : ""}
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button
                          variant="outline"
                          className="h-7 gap-1.5 rounded-none px-2 text-caption"
                          disabled={busy || emptying}
                          onClick={() => void handleRestore(p.id)}
                          title={t("dashboard.restore")}
                        >
                          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                          {t("dashboard.restore")}
                        </Button>
                        <Button
                          variant="outline"
                          className={cn(
                            "h-7 gap-1.5 rounded-none px-2 text-caption",
                            "border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive",
                          )}
                          disabled={busy || emptying}
                          onClick={() => setConfirmDeleteId(p.id)}
                          title={t("dashboard.deleteForever")}
                        >
                          <Trash2 className="h-3 w-3" />
                          {t("dashboard.deleteForever")}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {projects.length > 0 && (
            <div className="flex items-center justify-between border-t border-border-subtle px-5 py-3">
              <span className="inline-flex items-center gap-1.5 text-caption text-text-tertiary">
                <AlertTriangle className="h-3 w-3" />
                {t("dashboard.emptyTrashDesc")}
              </span>
              {/* 휴지통 비우기는 의도적으로 중립(흰색) 처리 — 개별 "영구 삭제"
                  (빨강)와 같은 시각 레벨로 경쟁하지 않도록 한 단계 낮춘다.
                  실제 위험 경고는 클릭 후 확인 다이얼로그가 담당. */}
              <Button
                variant="outline"
                className="h-8 gap-1.5 rounded-none px-2.5 text-caption"
                disabled={emptying}
                onClick={() => setConfirmEmpty(true)}
              >
                {emptying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                {t("dashboard.emptyTrash")}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 단일 영구 삭제 확인 */}
      <AlertDialog open={!!confirmDeleteId} onOpenChange={(o) => !o && setConfirmDeleteId(null)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("dashboard.deleteForeverTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmTarget ? `“${confirmTarget.title || t("common.untitled")}” — ` : ""}
              {t("dashboard.deleteForeverDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-border hover:bg-secondary h-9 text-body">
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmDeleteId && void handleDeleteForever(confirmDeleteId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 h-9 text-body"
            >
              {t("dashboard.deleteForever")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 휴지통 비우기 확인 */}
      <AlertDialog open={confirmEmpty} onOpenChange={(o) => !o && setConfirmEmpty(false)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("dashboard.emptyTrashTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("dashboard.emptyTrashDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-border hover:bg-secondary h-9 text-body">
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleEmptyTrash()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 h-9 text-body"
            >
              {t("dashboard.emptyTrash")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
