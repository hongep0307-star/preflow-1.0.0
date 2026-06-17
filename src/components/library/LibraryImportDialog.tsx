import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Search, Star, Clock, Folder, Library, Check } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { useT, useUiLanguage } from "@/lib/uiLanguage";
import { useToast } from "@/hooks/use-toast";
import {
  listLibraryReferences,
  getActiveLibraryWorkspace,
  crossRefToReferenceItem,
  type CrossWorkspaceReference,
  type CrossWorkspaceFilter,
} from "@/lib/crossWorkspaceLibrary";
import { buildAgentAttachmentForRef } from "@/lib/agentAttach";
import { appendAgentChatImages, CHAT_IMAGE_MAX, type ChatImage } from "@/components/agent/agentTypes";
import { referenceToRefItem } from "@/lib/referenceLibrary";
import { makeCompareLibraryEntry, appendCompareLibraryEntries } from "@/lib/compareLibraryStore";
import { BRIEF_MATCH_ROOT, isBriefMatchPath } from "@/lib/briefMatch";

export type LibraryImportTarget = "brief" | "conti" | "agent";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: LibraryImportTarget;
  projectId: string;
  /** "전체 라이브러리 열기" — 기존 워크스페이스 전환 플로우(무거운 브라우징/다른 워크스페이스). */
  onOpenFullLibrary?: () => void;
}

const MEDIA_KINDS = new Set(["image", "webp", "gif", "video", "youtube"]);

export function LibraryImportDialog({ open, onOpenChange, target, projectId, onOpenFullLibrary }: Props) {
  const t = useT();
  const { language: uiLanguage } = useUiLanguage();
  const { toast } = useToast();

  const [workspace, setWorkspace] = useState<{ id: string; name: string } | null>(null);
  const [references, setReferences] = useState<CrossWorkspaceReference[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [filter, setFilter] = useState<CrossWorkspaceFilter>("all");
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // 오픈 시 활성 라이브러리 워크스페이스 결정 + 초기화.
  useEffect(() => {
    if (!open) return;
    setSelectedIds(new Set());
    setFilter("all");
    setActiveFolder(null);
    setQuery("");
    setWorkspace(getActiveLibraryWorkspace());
  }, [open]);

  const load = useCallback(async () => {
    if (!open || !workspace) return;
    setLoading(true);
    try {
      const res = await listLibraryReferences(workspace.id, { filter, query });
      setReferences(res.references.filter((r) => MEDIA_KINDS.has(r.kind)));
      setFolders(res.folders);
    } catch (err) {
      console.error("[LibraryImportDialog] load failed:", err);
      setReferences([]);
      setFolders([]);
    } finally {
      setLoading(false);
    }
  }, [open, workspace, filter, query]);

  useEffect(() => {
    void load();
  }, [load]);

  // 선택 폴더 + 그 하위 폴더의 자료까지 보여준다(라이브러리 폴더 카운트와 동일 정책).
  const visible = useMemo(() => {
    if (!activeFolder) return references;
    const exact = `folder:${activeFolder}`;
    const prefix = `folder:${activeFolder}/`;
    return references.filter((r) => r.tags.some((tg) => tg === exact || tg.startsWith(prefix)));
  }, [references, activeFolder]);

  // 서버는 `folder:` 태그가 *직접* 달린 경로만 반환하므로, 중간(부모) 경로를
  // 보강해 완전한 트리를 만든 뒤 깊이별 들여쓰기로 렌더한다. (라이브러리 폴더
  // 트리와 동일한 중첩 표현.)
  //
  // 브리프 매치 특례: "브리프 매치" 상위 폴더 자체는 트리에서 제외하고, 그 하위
  // 폴더(각 브리프 매치 결과)는 한 단계 끌어올려 *최상위처럼* 보이게 한다 — 사용자가
  // 브리프 매치 하위에 묶여 있다고 느끼지 않도록. 또 브리프 매치 폴더는 폴더 아이콘을
  // 빨간색(text-primary)으로 구분한다.
  const folderTree = useMemo(() => {
    const all = new Set<string>();
    for (const f of folders) {
      const segs = f.split("/");
      for (let i = 1; i <= segs.length; i += 1) all.add(segs.slice(0, i).join("/"));
    }
    const comparePaths = (a: string, b: string): number => {
      const as = a.split("/");
      const bs = b.split("/");
      const n = Math.min(as.length, bs.length);
      for (let i = 0; i < n; i += 1) {
        if (as[i] !== bs[i]) return as[i].localeCompare(bs[i]);
      }
      return as.length - bs.length;
    };
    return [...all]
      .filter((p) => p !== BRIEF_MATCH_ROOT) // 브리프 매치 상위 폴더는 트리에서 제외
      .sort(comparePaths)
      .map((p) => {
        const segs = p.split("/");
        const briefMatch = isBriefMatchPath(p);
        // 브리프 매치 하위는 상위(숨김)를 한 칸 빼서 최상위처럼 보이게 한다.
        const depth = Math.max(0, briefMatch ? segs.length - 2 : segs.length - 1);
        return { path: p, name: segs[segs.length - 1] || p, depth, briefMatch };
      });
  }, [folders]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleConfirm = async () => {
    const selected = references.filter((r) => selectedIds.has(r.id));
    if (selected.length === 0 || !projectId) return;
    setAttaching(true);
    try {
      let count = 0;
      if (target === "agent") {
        const prefKo = uiLanguage !== "en";
        const imgs: ChatImage[] = [];
        for (const r of selected.slice(0, CHAT_IMAGE_MAX)) {
          const img = await buildAgentAttachmentForRef(r, prefKo);
          if (img) imgs.push(img);
        }
        if (imgs.length > 0) appendAgentChatImages(projectId, imgs);
        count = imgs.length;
      } else if (target === "brief") {
        // BriefTab 과의 순환 import 를 피하려고 동적 import.
        const { appendLibraryRefItemToProject } = await import("@/components/BriefTab");
        for (const r of selected) {
          try {
            const refItem = await referenceToRefItem(crossRefToReferenceItem(r));
            const res = appendLibraryRefItemToProject(projectId, refItem);
            if (res !== "no-project") count += 1;
          } catch (err) {
            console.warn("[LibraryImportDialog] brief attach failed:", err);
          }
        }
      } else {
        const entries = [];
        for (const r of selected) {
          try {
            entries.push(await makeCompareLibraryEntry(crossRefToReferenceItem(r)));
          } catch (err) {
            console.warn("[LibraryImportDialog] conti entry failed:", err);
          }
        }
        const res = appendCompareLibraryEntries(projectId, entries);
        count = res.added.length;
        // ContiStudio 가 같은 탭에서 즉시 반영하도록 커스텀 이벤트 발행(LibraryPage 와 동일).
        try {
          window.dispatchEvent(new CustomEvent("preflow:compare-library-changed", { detail: { projectId } }));
        } catch {
          /* CustomEvent 미지원 환경 */
        }
      }
      if (count > 0) {
        toast({ title: t("library.import.attached", { n: count }) });
        onOpenChange(false);
      } else {
        toast({ variant: "destructive", title: t("library.import.attachFailed") });
      }
    } finally {
      setAttaching(false);
    }
  };

  const filterChips: Array<{ id: CrossWorkspaceFilter; label: string; icon: typeof Star }> = [
    { id: "all", label: t("library.import.filterAll"), icon: Library },
    { id: "favorite", label: t("library.import.filterFavorite"), icon: Star },
    { id: "recent", label: t("library.import.filterRecent"), icon: Clock },
  ];

  const selectedCount = selectedIds.size;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Library className="h-4 w-4 text-primary" />
            {t("library.import.title")}
            {workspace ? <span className="text-meta font-normal text-muted-foreground">· {workspace.name}</span> : null}
          </DialogTitle>
          <DialogDescription>
            {t("library.import.description")}
          </DialogDescription>
        </DialogHeader>

        {!workspace ? (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <Library className="h-8 w-8 text-muted-foreground/50" />
            <div className="text-body text-muted-foreground">{t("library.import.noLibrary")}</div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {/* 필터 칩 + 검색 — 한 줄짜리 통합 툴바. 칩은 좌측 고정폭, 검색은
                남은 폭을 모두 채워(flex-1) 우측에 따로 떠 있지 않고 자연스럽게
                이어지게 한다. 아래 콘텐츠와 분리되도록 옅은 하단 보더 추가. */}
            <div className="flex items-center gap-2 border-b border-border-subtle pb-3">
              <div className="flex shrink-0 gap-1.5">
                {filterChips.map((c) => {
                  const active = filter === c.id;
                  const Icon = c.icon;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setFilter(c.id)}
                      className={cn(
                        "flex items-center gap-1.5 border px-2.5 py-1.5 text-meta transition",
                        active ? "border-primary/70 bg-primary/10 text-primary" : "border-border-subtle text-muted-foreground hover:border-primary/40",
                      )}
                      style={{ borderRadius: 0 }}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {c.label}
                    </button>
                  );
                })}
              </div>
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("library.import.searchPlaceholder")}
                  className="h-8 w-full rounded-none pl-8 text-meta"
                />
              </div>
            </div>

            {/* 콘텐츠 영역 — 폴더 자료 유무와 관계없이 높이 고정(420px)해서
                다이얼로그 전체 높이가 흔들리지 않게 한다. 각 칼럼은 내부에서
                스크롤. */}
            <div className="flex gap-3" style={{ height: 420 }}>
              {/* 폴더 트리 */}
              <div className="h-full w-40 shrink-0 overflow-y-auto border border-border-subtle p-1" style={{ borderRadius: 0 }}>
                <button
                  type="button"
                  onClick={() => setActiveFolder(null)}
                  className={cn(
                    "flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-meta transition",
                    !activeFolder ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent",
                  )}
                  style={{ borderRadius: 0 }}
                >
                  <Library className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{t("library.import.allFolders")}</span>
                </button>
                {folderTree.map((node) => (
                  <button
                    key={node.path}
                    type="button"
                    onClick={() => setActiveFolder(node.path)}
                    className={cn(
                      "flex w-full items-center gap-1.5 py-1.5 pr-2 text-left text-meta transition",
                      activeFolder === node.path ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent",
                    )}
                    style={{ borderRadius: 0, paddingLeft: 8 + node.depth * 14 }}
                    title={node.path}
                  >
                    <Folder className={cn("h-3.5 w-3.5 shrink-0", node.briefMatch && "text-primary")} />
                    <span className="truncate">{node.name}</span>
                  </button>
                ))}
              </div>

              {/* 그리드 */}
              <div className="h-full flex-1 overflow-y-auto">
                {loading ? (
                  <div className="flex h-full items-center justify-center text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin" />
                  </div>
                ) : visible.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-body text-muted-foreground">
                    {t("library.import.empty")}
                  </div>
                ) : (
                  /* 비율 보존 컬럼 메이슨리 — width/height 로 aspect-ratio 를 미리
                     잡아 로딩 시프트 없이 라이브러리처럼 원본 비율을 살린다. */
                  <div style={{ columnCount: 4, columnGap: 12, columnFill: "balance" }}>
                    {visible.map((r) => {
                      const selected = selectedIds.has(r.id);
                      const src = r.thumbnail_url || r.file_url || "";
                      const isMotion = r.kind === "video" || r.kind === "gif";
                      const ratio = r.width && r.height ? `${r.width} / ${r.height}` : undefined;
                      return (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => toggleSelect(r.id)}
                          className={cn(
                            "group relative mb-3 block w-full overflow-hidden border bg-muted/30 transition [break-inside:avoid]",
                            selected ? "border-primary shadow-[0_0_0_1px_hsl(var(--primary))]" : "border-border-subtle hover:border-primary/40",
                          )}
                          style={{ borderRadius: 0, aspectRatio: ratio }}
                          title={r.title}
                        >
                          {src ? (
                            <img
                              src={src}
                              alt={r.title}
                              className={cn("block w-full", ratio ? "h-full object-cover" : "h-auto")}
                              loading="lazy"
                              decoding="async"
                            />
                          ) : (
                            <div className="flex aspect-square w-full items-center justify-center text-2xs text-muted-foreground">{r.kind}</div>
                          )}
                          {/* 종류 배지 — LibraryCanvas 의 좌상단 타입 라벨과 동일한
                              디자인(bg-secondary, h-5, text-micro)으로 통일. */}
                          {isMotion && (
                            <span className="pointer-events-none absolute left-1 top-1 z-10 flex h-5 items-center justify-center bg-secondary px-1.5 text-micro font-medium uppercase text-secondary-foreground">
                              {r.kind}
                            </span>
                          )}
                          {selected && (
                            <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center bg-primary text-white" style={{ borderRadius: 0 }}>
                              <Check className="h-3 w-3" />
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <DialogFooter className="items-center">
          {onOpenFullLibrary ? (
            <Button
              variant="ghost"
              className="mr-auto h-9 rounded-none text-meta text-muted-foreground"
              onClick={() => {
                onOpenChange(false);
                onOpenFullLibrary();
              }}
            >
              {t("library.import.openFull")}
            </Button>
          ) : null}
          <Button variant="outline" className="h-9 rounded-none px-4 text-meta" onClick={() => onOpenChange(false)} disabled={attaching}>
            {t("common.cancel")}
          </Button>
          <Button
            className="h-9 gap-1.5 rounded-none px-5 text-meta"
            onClick={handleConfirm}
            disabled={attaching || selectedCount === 0 || !workspace}
          >
            {attaching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {t("library.import.import", { n: selectedCount })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
