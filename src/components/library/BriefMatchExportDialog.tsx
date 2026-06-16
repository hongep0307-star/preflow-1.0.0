/**
 * BriefMatchExportDialog — "스마트 브리프 매치 폴더 → 프로젝트 내보내기" 설정 다이얼로그.
 *
 * 로켓 버튼에서 열린다. 한 곳에서:
 *   - 프로젝트로 넘길 레퍼런스 다중 선택(폴더 전체가 기본, 빼기 가능)
 *   - 대상 프로젝트 워크스페이스 / 대시보드 폴더 / 제목
 *   - 화면 비율(필수) + (선택) 마감 일정 · 요청 부서
 *   - 생성 후 브리프 탭 이동 vs 라이브러리 머무르기
 * 를 받고 onConfirm 으로 부모에 넘긴다. 부모(LibraryPage)는 reload 전에 선택
 * 레퍼런스를 사전 분석한 뒤 stash + activateWorkspace 한다. onConfirm 이 그 비동기
 * 작업을 await 하는 동안 다이얼로그는 진행 상태("분석 중")를 표시한다.
 */
import { useEffect, useMemo, useState } from "react";
import { Loader2, CalendarIcon, Check, Image as ImageIcon, Film, Youtube as YoutubeIcon, Link as LinkIcon, FileText } from "lucide-react";
import { format, parse } from "date-fns";
import { useT } from "@/lib/uiLanguage";
import { cn } from "@/lib/utils";
import type { ReferenceItem } from "@/lib/referenceLibrary";
import { resolveTypeLabel } from "@/lib/linkPlatform";
import { getCachedWorkspaces } from "@/lib/workspaceClient";
import { listCrossWorkspaceProjectFolders } from "@/lib/crossWorkspaceLibrary";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** 레퍼런스 kind → 썸네일이 없을 때 보여줄 폴백 아이콘. 타입 라벨 자체는
 *  앱 표준(resolveTypeLabel)을 써서 다른 화면과 표기를 통일한다. */
function kindIcon(kind: ReferenceItem["kind"]): typeof ImageIcon {
  switch (kind) {
    case "video":
      return Film;
    case "youtube":
      return YoutubeIcon;
    case "link":
      return LinkIcon;
    case "doc":
      return FileText;
    default:
      return ImageIcon;
  }
}

export type VideoFormat = "horizontal" | "vertical" | "square";

export interface BriefMatchExportResult {
  targetWsId: string;
  folderId: string | null;
  title: string;
  videoFormat: VideoFormat;
  deadline: string | null;
  client: string | null;
  openInBrief: boolean;
  selectedRefIds: string[];
}

export interface BriefMatchExportDialogProps {
  open: boolean;
  onClose: () => void;
  /** 폴더 leaf 이름 — 제목 기본값. */
  defaultTitle: string;
  /** 폴더 멤버(선택 후보). */
  members: ReferenceItem[];
  /** 확인 → 부모가 사전 분석 + stash + activate(reload). await 동안 진행 상태 표시. */
  onConfirm: (result: BriefMatchExportResult) => Promise<void>;
}

const UNGROUPED = "__ungrouped__";

export function BriefMatchExportDialog({
  open,
  onClose,
  defaultTitle,
  members,
  onConfirm,
}: BriefMatchExportDialogProps) {
  const t = useT();

  // 다이얼로그는 briefMatchExport 가 set 될 때마다 새로 마운트되므로, 마운트 시점의
  // 워크스페이스 캐시(LibraryPage 가 이미 로드)를 한 번 읽으면 충분하다.
  const projectWorkspaces = useMemo(
    () => getCachedWorkspaces().filter((w) => w.kind === "project"),
    [],
  );

  const [targetWsId, setTargetWsId] = useState("");
  const [folders, setFolders] = useState<Array<{ id: string; name: string }> | null>(null);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [folderId, setFolderId] = useState<string>(UNGROUPED);
  const [title, setTitle] = useState(defaultTitle);
  const [videoFormat, setVideoFormat] = useState<VideoFormat>("vertical");
  const [deadline, setDeadline] = useState("");
  const [client, setClient] = useState("");
  const [openInBrief, setOpenInBrief] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [moreOpen, setMoreOpen] = useState(false);
  const [deadlineOpen, setDeadlineOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // 열릴 때마다 초기화 — 멤버 전체 선택 + 기본값.
  useEffect(() => {
    if (!open) return;
    setTargetWsId(projectWorkspaces[0]?.id ?? "");
    setFolders(null);
    setFolderId(UNGROUPED);
    setTitle(defaultTitle);
    setVideoFormat("vertical");
    setDeadline("");
    setClient("");
    setOpenInBrief(true);
    setSelectedIds(new Set(members.map((m) => m.id)));
    setMoreOpen(false);
    setSubmitting(false);
  }, [open, defaultTitle, members, projectWorkspaces]);

  // 대상 워크스페이스 선택 시 대시보드 폴더 로드(전환 없이 크로스-워크스페이스).
  useEffect(() => {
    if (!open || !targetWsId) {
      setFolders(null);
      return;
    }
    let cancelled = false;
    setFoldersLoading(true);
    setFolders(null);
    setFolderId(UNGROUPED);
    listCrossWorkspaceProjectFolders(targetWsId)
      .then((rows) => {
        if (!cancelled) setFolders(rows);
      })
      .catch(() => {
        if (!cancelled) setFolders([]);
      })
      .finally(() => {
        if (!cancelled) setFoldersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, targetWsId]);

  const toggleRef = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allSelected = members.length > 0 && selectedIds.size === members.length;
  const toggleAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(members.map((m) => m.id)));
  };

  const canConfirm = !!targetWsId && !submitting;

  const handleConfirm = async () => {
    if (!canConfirm) return;
    setSubmitting(true);
    try {
      await onConfirm({
        targetWsId,
        folderId: folderId === UNGROUPED ? null : folderId,
        title: title.trim() || defaultTitle,
        videoFormat,
        deadline: deadline.trim() || null,
        client: client.trim() || null,
        openInBrief,
        selectedRefIds: [...selectedIds],
      });
      // 성공 시 부모가 activateWorkspace(reload) → 이 컴포넌트는 곧 언마운트.
    } catch {
      // 실패(예: 분석 오류) 시 다이얼로그를 닫지 않고 재시도 가능하게 둔다.
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => (!v && !submitting ? onClose() : undefined)}>
      <DialogContent size="md" className="max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("briefMatch.export.title")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* 레퍼런스 다중 선택 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{t("briefMatch.export.references")}</Label>
              {members.length > 0 && (
                <button
                  type="button"
                  onClick={toggleAll}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  {t("briefMatch.export.selectAll")} · {t("briefMatch.export.selected", { n: selectedIds.size })}
                </button>
              )}
            </div>
            {members.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("briefMatch.export.noRefs")}</p>
            ) : (
              <div className="grid grid-cols-4 gap-2 max-h-72 overflow-y-auto border border-border p-2">
                {members.map((m) => {
                  const checked = selectedIds.has(m.id);
                  const thumb = m.thumbnail_url ?? m.file_url ?? "";
                  const Icon = kindIcon(m.kind);
                  return (
                    <button
                      type="button"
                      key={m.id}
                      onClick={() => toggleRef(m.id)}
                      className={cn(
                        "group relative aspect-square overflow-hidden border bg-surface-panel transition-all",
                        checked
                          ? "border-primary/80 shadow-[0_0_0_1px_hsl(var(--primary)/0.35)]"
                          : "border-border-subtle opacity-70 hover:opacity-100 hover:border-primary/40",
                      )}
                      style={{ borderRadius: 0 }}
                      title={m.title ?? ""}
                    >
                      {thumb ? (
                        <img src={thumb} alt={m.title ?? ""} className="h-full w-full object-cover" />
                      ) : (
                        <span className="flex h-full w-full items-center justify-center">
                          <Icon className="h-6 w-6 text-muted-foreground" />
                        </span>
                      )}
                      {/* 타입 라벨 — 앱 전역과 동일하게 좌상단 secondary Badge */}
                      <Badge variant="secondary" className="absolute left-2 top-2 h-5 rounded-none px-1.5 text-micro">
                        {resolveTypeLabel(m)}
                      </Badge>
                      {/* 선택 표시 — 앱 전역과 동일하게 우상단 primary 체크마크 */}
                      {checked ? (
                        <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center bg-primary text-primary-foreground">
                          <Check className="h-3.5 w-3.5" />
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* 대상 워크스페이스 */}
          <div className="space-y-1.5">
            <Label>{t("briefMatch.export.targetWorkspace")}</Label>
            {projectWorkspaces.length === 0 ? (
              <p className="text-xs text-destructive">{t("briefMatch.export.noProjectWorkspaces")}</p>
            ) : (
              <Select value={targetWsId} onValueChange={setTargetWsId}>
                <SelectTrigger>
                  <SelectValue placeholder={t("briefMatch.export.targetWorkspacePlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {projectWorkspaces.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* 폴더 */}
          <div className="space-y-1.5">
            <Label>{t("briefMatch.export.folder")}</Label>
            <Select value={folderId} onValueChange={setFolderId} disabled={!targetWsId || foldersLoading}>
              <SelectTrigger>
                <SelectValue
                  placeholder={foldersLoading ? t("briefMatch.export.loadingFolders") : t("common.ungrouped")}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNGROUPED}>{t("common.ungrouped")}</SelectItem>
                {(folders ?? []).map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* 제목 */}
          <div className="space-y-1.5">
            <Label htmlFor="bm-export-title">{t("briefMatch.export.projectTitle")}</Label>
            <Input
              id="bm-export-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={defaultTitle}
            />
          </div>

          {/* 화면 비율 */}
          <div className="space-y-1.5">
            <Label>{t("briefMatch.export.videoFormat")}</Label>
            <div className="grid grid-cols-3 gap-2">
              {(["horizontal", "vertical", "square"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setVideoFormat(f)}
                  className={cn(
                    "border px-2 py-1.5 text-xs",
                    videoFormat === f ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground",
                  )}
                >
                  {t(`briefMatch.export.format.${f}`)}
                </button>
              ))}
            </div>
          </div>

          {/* 추가 정보(선택) */}
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setMoreOpen((v) => !v)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              {moreOpen ? "▾" : "▸"} {t("briefMatch.export.moreInfo")}
            </button>
            {moreOpen && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>{t("briefMatch.export.deadline")}</Label>
                  <Popover open={deadlineOpen} onOpenChange={setDeadlineOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        className={cn(
                          "w-full justify-start text-left font-normal",
                          !deadline && "text-muted-foreground",
                        )}
                      >
                        <CalendarIcon className="mr-2 h-4 w-4" />
                        {deadline
                          ? format(parse(deadline, "yyyy-MM-dd", new Date()), "yyyy-MM-dd")
                          : t("briefMatch.export.pickDate")}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={deadline ? parse(deadline, "yyyy-MM-dd", new Date()) : undefined}
                        onSelect={(d) => {
                          setDeadline(d ? format(d, "yyyy-MM-dd") : "");
                          setDeadlineOpen(false);
                        }}
                        initialFocus
                      />
                    </PopoverContent>
                  </Popover>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="bm-export-client">{t("briefMatch.export.client")}</Label>
                  <Input id="bm-export-client" value={client} onChange={(e) => setClient(e.target.value)} />
                </div>
              </div>
            )}
          </div>

          {/* 생성 후 동작 */}
          <div className="space-y-1.5">
            <Label>{t("briefMatch.export.afterCreate")}</Label>
            <RadioGroup
              value={openInBrief ? "brief" : "stay"}
              onValueChange={(v) => setOpenInBrief(v === "brief")}
              className="flex flex-col gap-1.5"
            >
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="brief" /> {t("briefMatch.export.openBrief")}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="stay" /> {t("briefMatch.export.stayLibrary")}
              </label>
            </RadioGroup>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleConfirm} disabled={!canConfirm}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {submitting ? t("briefMatch.export.preparing") : t("briefMatch.export.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
