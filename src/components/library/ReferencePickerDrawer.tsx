import { useEffect, useMemo, useState } from "react";
import { Check, Film, ImageIcon, Link2, Loader2, Search, Sparkles, Youtube } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { listReferences, type ReferenceItem, type ReferenceKind } from "@/lib/referenceLibrary";
import { resolveFormatLabel } from "@/lib/linkPlatform";
import {
  scoreReferences,
  type BriefSignals,
  type SceneSignals,
} from "@/lib/referenceRecommender";
import { useT } from "@/lib/uiLanguage";

const TARGET_LABEL: Record<NonNullable<ReferencePickerDrawerProps["target"]>, string> = {
  brief: "Brief",
  agent: "Agent",
  conti: "Conti",
};

function formatDate(value?: string | null, noDateLabel = "No date"): string {
  if (!value) return noDateLabel;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return noDateLabel;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function getKindIcon(kind: ReferenceKind) {
  if (kind === "video") return Film;
  if (kind === "youtube") return Youtube;
  if (kind === "link") return Link2;
  return ImageIcon;
}

interface ReferencePickerDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target?: "brief" | "agent" | "conti";
  selectedIds?: string[];
  maxSelectable?: number;
  onImport: (items: ReferenceItem[]) => Promise<void> | void;
  /** Phase 9 — scene/brief 신호로 자료를 점수 매겨 위로 끌어올리고 reason 칩
   *  을 카드에 띄운다. null/undefined 면 기존 검색 + 최신순 그대로. */
  recommendFor?: BriefSignals | SceneSignals | null;
}

export function ReferencePickerDrawer({
  open,
  onOpenChange,
  target = "brief",
  selectedIds = [],
  maxSelectable = 8,
  onImport,
  recommendFor = null,
}: ReferencePickerDrawerProps) {
  const [items, setItems] = useState<ReferenceItem[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targetLabel = TARGET_LABEL[target];
  const t = useT();

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    listReferences({ limit: 1000 })
      .then((rows) => {
        // listReferences excludes trashed rows by default; no client filter needed.
        setItems(rows);
        setSelected(new Set());
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      if (item.kind === "link") return false;
      if (!q) return true;
      return [item.title, item.notes, item.source_url, ...item.tags]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [items, query]);

  /** 추천 신호가 있으면 스코어/이유를 미리 계산해 두고, 검색어가 비어있을 때
   *  점수 내림차순으로 결과를 정렬한다. 검색어가 있을 때는 사용자의 의도(=
   *  특정 키워드 찾기) 가 우선이라 추천 점수로 재정렬하지 않는다. */
  const reasonsById = useMemo(() => {
    if (!recommendFor) return new Map<string, string[]>();
    const scored = scoreReferences(recommendFor, items, { limit: 100 });
    return new Map(scored.map((entry) => [entry.item.id, entry.reasons]));
  }, [items, recommendFor]);

  const orderedFiltered = useMemo(() => {
    if (!recommendFor || query.trim()) return filtered;
    const scoreById = new Map<string, number>();
    const scored = scoreReferences(recommendFor, items, { limit: 1000 });
    for (const entry of scored) scoreById.set(entry.item.id, entry.score);
    return [...filtered].sort((a, b) => (scoreById.get(b.id) ?? 0) - (scoreById.get(a.id) ?? 0));
  }, [filtered, items, query, recommendFor]);

  const selectedItems = useMemo(
    () => items.filter((item) => selected.has(item.id)),
    [items, selected],
  );

  const toggleItem = (item: ReferenceItem) => {
    if (selectedIds.includes(item.id)) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(item.id)) {
        next.delete(item.id);
      } else if (next.size < maxSelectable) {
        next.add(item.id);
      }
      return next;
    });
  };

  const handleImport = async () => {
    if (selectedItems.length === 0) return;
    setSubmitting(true);
    try {
      await onImport(selectedItems);
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="wide" className="flex max-h-[calc(100vh-48px)] flex-col p-0">
        <DialogHeader className="shrink-0 border-b border-border-subtle px-5 py-4">
          <DialogTitle className="flex items-center justify-between gap-3">
            {t("library.referencePicker.title")}
            <Badge variant="outline" className="rounded-none text-2xs tracking-normal">
              {target}
            </Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: "280px minmax(0, 1fr)" }}>
          <aside className="min-h-0 overflow-y-auto border-r border-border-subtle bg-surface-sidebar p-4">
            <div className="flex h-9 items-center gap-2 border border-border-subtle bg-background px-3" style={{ borderRadius: 0 }}>
              <Search className="h-3.5 w-3.5 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("library.referencePicker.searchPlaceholder")}
                className="min-w-0 flex-1 border-none bg-transparent text-meta outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div className="mt-4 space-y-2 text-caption text-muted-foreground">
              <div className="font-mono tracking-[0.12em]">{t("library.referencePicker.selectedHeader")}</div>
              <div className="text-foreground">{selectedItems.length} / {maxSelectable}</div>
              {selectedIds.length > 0 ? (
                <div>{t("library.referencePicker.alreadyAttached", { n: selectedIds.length, target: targetLabel })}</div>
              ) : null}
              <div>{t("library.referencePicker.linkHiddenHint")}</div>
            </div>
          </aside>

          <section className="min-h-0 overflow-y-auto p-4">
            {loading ? (
              <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="font-mono text-caption">{t("library.referencePicker.loading")}</span>
              </div>
            ) : error ? (
              <div className="border border-destructive/40 bg-destructive/10 p-4 text-meta text-destructive" style={{ borderRadius: 0 }}>
                {error}
              </div>
            ) : orderedFiltered.length === 0 ? (
              <div className="flex h-full min-h-[360px] items-center justify-center border border-dashed border-border-subtle text-meta text-muted-foreground" style={{ borderRadius: 0 }}>
                {t("library.referencePicker.empty")}
              </div>
            ) : (
              <>
                {recommendFor && !query.trim() ? (
                  <div className="mb-3 flex items-center gap-1.5 text-2xs font-mono tracking-[0.12em] text-muted-foreground">
                    <Sparkles className="h-3 w-3" />
                    {t("library.referencePicker.sortedByRelevance", { target: target.toUpperCase() })}
                  </div>
                ) : null}
                <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
                  {orderedFiltered.map((item) => {
                    const Icon = getKindIcon(item.kind);
                    const checked = selected.has(item.id);
                    const alreadyAttached = selectedIds.includes(item.id);
                    const reasons = reasonsById.get(item.id) ?? [];
                    return (
                      <button
                        key={item.id}
                        type="button"
                        disabled={alreadyAttached}
                        onClick={() => toggleItem(item)}
                        className={cn(
                          "group overflow-hidden border bg-surface-panel text-left transition-all disabled:cursor-not-allowed disabled:opacity-45",
                          checked ? "border-primary/80 shadow-[0_0_0_1px_hsl(var(--primary)/0.35)]" : "border-border-subtle hover:border-primary/40",
                        )}
                        style={{ borderRadius: 0 }}
                      >
                        <div className="relative flex aspect-video items-center justify-center overflow-hidden bg-muted/30">
                          {item.thumbnail_url || item.file_url ? (
                            <img src={item.thumbnail_url || item.file_url || ""} alt={item.title} className="h-full w-full object-cover" />
                          ) : (
                            <Icon className="h-7 w-7 text-muted-foreground" />
                          )}
                          <Badge variant="secondary" className="absolute left-2 top-2 h-5 rounded-none px-1.5 text-micro">
                            {resolveFormatLabel(item)}
                          </Badge>
                          {checked ? (
                            <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center bg-primary text-primary-foreground">
                              <Check className="h-3.5 w-3.5" />
                            </span>
                          ) : null}
                          {alreadyAttached ? (
                            <span className="absolute bottom-2 right-2 bg-black/70 px-1.5 py-0.5 font-mono text-micro text-white">
                              {t("library.referencePicker.badgeAttached")}
                            </span>
                          ) : null}
                        </div>
                        <div className="space-y-1.5 p-2.5">
                          <div className="line-clamp-2 min-h-[30px] text-caption font-semibold text-foreground">{item.title}</div>
                          {reasons.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {reasons.slice(0, 3).map((reason) => (
                                <Badge key={reason} variant="outline" className="rounded-none px-1 py-0 text-micro font-mono">
                                  {reason}
                                </Badge>
                              ))}
                            </div>
                          ) : null}
                          <div className="font-mono text-micro text-muted-foreground">{formatDate(item.created_at, t("common.noDate"))}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </section>
        </div>

        <DialogFooter className="shrink-0 border-t border-border-subtle px-5 py-4">
          <Button variant="outline" className="h-8 rounded-none text-caption" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button className="h-8 rounded-none text-caption" onClick={handleImport} disabled={selectedItems.length === 0 || submitting}>
            {submitting ? t("library.referencePicker.importing") : t("library.referencePicker.importN", { n: selectedItems.length || "" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
