/**
 * ProjectPickerDialog — Library 에서 cross-workspace 로 자료를 보낼 때 어느
 * 프로젝트로 보낼지 고르는 가벼운 picker.
 *
 * localStorage 캐시 (`recentProjectsCache`) 를 읽어 최근 방문 순으로 표시.
 * 검색 input 포함. 빈 캐시 안내 메시지 포함 (Dashboard 에 한 번 방문해 달라는
 * 안내).
 *
 * UX 패턴: 작은 dialog, 카드 리스트, 클릭 즉시 선택 → `onPick(project)` 후 close.
 */

import { useEffect, useMemo, useState } from "react";
import { Search, FolderInput } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getRecentProjects, type RecentProject } from "@/lib/recentProjectsCache";
import { useT } from "@/lib/uiLanguage";

export interface ProjectPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** picker 헤더에 표시할 작업 이름 — 예: "Brief 에 추가". */
  actionLabel: string;
  onPick: (project: RecentProject) => void | Promise<void>;
  /** 목록에서 제외할 projectId (예: 이미 즐겨찾기한 프로젝트). */
  excludeProjectIds?: string[];
}

export function ProjectPickerDialog({
  open,
  onOpenChange,
  actionLabel,
  onPick,
  excludeProjectIds,
}: ProjectPickerDialogProps) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [projects, setProjects] = useState<RecentProject[]>([]);

  useEffect(() => {
    if (open) {
      setProjects(getRecentProjects(50));
      setQuery("");
    }
  }, [open]);

  const filtered = useMemo(() => {
    const exclude = new Set(excludeProjectIds ?? []);
    const base = exclude.size > 0 ? projects.filter((p) => !exclude.has(p.projectId)) : projects;
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter((p) => p.title.toLowerCase().includes(q));
  }, [projects, query, excludeProjectIds]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderInput className="h-4 w-4 text-primary" />
            {actionLabel}
          </DialogTitle>
          <DialogDescription>{t("projectPicker.description")}</DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("projectPicker.searchPlaceholder")}
            className="h-9 pl-8 rounded-none text-sm"
          />
        </div>

        <div className="max-h-[360px] overflow-y-auto -mx-1 px-1">
          {filtered.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              {projects.length === 0
                ? t("projectPicker.emptyCache")
                : t("projectPicker.noMatch")}
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {filtered.map((p) => (
                <button
                  key={`${p.workspaceId}:${p.projectId}`}
                  onClick={async () => {
                    onOpenChange(false);
                    await onPick(p);
                  }}
                  className="flex items-center justify-between gap-2 rounded-none border border-border-subtle bg-surface-panel px-3 py-2 text-left text-xs transition-colors hover:border-primary/40 hover:bg-primary/5"
                >
                  <div className="flex flex-col min-w-0">
                    <span className="truncate font-semibold text-foreground">{p.title}</span>
                    <span className="text-2xs text-muted-foreground">
                      {formatLastSeen(p.lastSeenAt, t)}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatLastSeen(ts: number, t: ReturnType<typeof useT>): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (m < 1) return t("projectPicker.justNow");
  if (m < 60) return t("projectPicker.minutesAgo", { n: m });
  if (h < 24) return t("projectPicker.hoursAgo", { n: h });
  if (d < 7) return t("projectPicker.daysAgo", { n: d });
  return new Date(ts).toLocaleDateString();
}
