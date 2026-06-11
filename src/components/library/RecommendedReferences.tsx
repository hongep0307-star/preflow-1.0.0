import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { listReferences, type ReferenceItem, type ReferenceKind } from "@/lib/referenceLibrary";
import {
  scoreReferences,
  type BriefSignals,
  type RecommendedReference,
  type SceneSignals,
} from "@/lib/referenceRecommender";

type ImportTarget = "brief" | "agent" | "conti";

interface RecommendedReferencesProps {
  /** 어떤 신호로 점수를 매길지. brief 분석 결과 또는 scene 컨텍스트. */
  signals: BriefSignals | SceneSignals;
  /** 어떤 target 으로 가져갈지 — 라벨/버튼 문구에 영향. */
  target: ImportTarget;
  /** 이미 attach 된 reference id 들 (제외 + 뱃지 표시용). */
  attachedIds?: string[];
  /** 로딩이 끝난 후의 점수 cutoff override. */
  minScore?: number;
  /** 한 번에 보여줄 개수 (기본 6). */
  limit?: number;
  /** 가져올 자료 종류 제한 (기본: image/gif/video/youtube). */
  allowedKinds?: ReadonlySet<ReferenceKind>;
  /** 사용자가 카드의 Add 를 누르면 호출. 호출부가 link 생성 + state 갱신. */
  onAdd: (item: ReferenceItem) => Promise<void> | void;
  /** 추천이 0 개일 때 보여줄 hint. 기본: 일반 안내 문구. */
  emptyHint?: string;
  className?: string;
}

/**
 * Brief / Agent scene / Conti scene 어디서든 같은 모양으로 표시되는 추천 패널.
 *
 * 이 컴포넌트는 자체적으로 listReferences() 를 한 번 호출해 캐시된 후,
 * `signals` 가 바뀔 때마다 메모리에서 다시 스코어링한다 — 매 분석/scene 변경
 * 마다 DB 쿼리를 새로 치지 않는다.
 */
export function RecommendedReferences({
  signals,
  target,
  attachedIds,
  minScore,
  limit = 6,
  allowedKinds,
  onAdd,
  emptyHint,
  className,
}: RecommendedReferencesProps) {
  const [items, setItems] = useState<ReferenceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listReferences({ limit: 1000 })
      .then((rows) => {
        if (cancelled) return;
        setItems(rows);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const exclude = useMemo(() => new Set(attachedIds ?? []), [attachedIds]);
  const recs = useMemo<RecommendedReference[]>(() => {
    if (items.length === 0) return [];
    return scoreReferences(signals, items, {
      excludeIds: exclude,
      allowedKinds,
      minScore,
      limit,
    });
  }, [allowedKinds, exclude, items, limit, minScore, signals]);

  const handleAdd = async (item: ReferenceItem) => {
    if (pendingId) return;
    setPendingId(item.id);
    try {
      await onAdd(item);
    } finally {
      setPendingId(null);
    }
  };

  if (loading) {
    return (
      <section className={cn("border border-border-subtle bg-surface-panel p-3", className)} style={{ borderRadius: 0 }}>
        <header className="mb-2 flex items-center gap-1.5 text-2xs font-mono tracking-[0.12em] text-muted-foreground">
          <Sparkles className="h-3 w-3" />
          RECOMMENDED REFERENCES
        </header>
        <div className="flex items-center gap-2 text-caption text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Scoring Library matches…
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className={cn("border border-destructive/40 bg-destructive/10 p-3 text-caption text-destructive", className)} style={{ borderRadius: 0 }}>
        Library recommendations failed: {error}
      </section>
    );
  }

  if (recs.length === 0) {
    return (
      <section className={cn("border border-border-subtle bg-surface-panel p-3", className)} style={{ borderRadius: 0 }}>
        <header className="mb-1 flex items-center gap-1.5 text-2xs font-mono tracking-[0.12em] text-muted-foreground">
          <Sparkles className="h-3 w-3" />
          RECOMMENDED REFERENCES
        </header>
        <div className="text-caption text-muted-foreground">
          {emptyHint ?? "No matches yet — tag a few Library items so future briefs can borrow from them."}
        </div>
      </section>
    );
  }

  const targetLabel = target === "brief" ? "Brief" : target === "agent" ? "Agent" : "Conti";

  return (
    <section className={cn("border border-border-subtle bg-surface-panel p-3", className)} style={{ borderRadius: 0 }}>
      <header className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-2xs font-mono tracking-[0.12em] text-muted-foreground">
          <Sparkles className="h-3 w-3" />
          RECOMMENDED REFERENCES
        </div>
        <div className="text-2xs font-mono text-muted-foreground">
          for {targetLabel}
        </div>
      </header>
      <ul className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
        {recs.map(({ item, score, reasons }) => (
          <li key={item.id} className="flex items-stretch border border-border-subtle bg-background" style={{ borderRadius: 0 }}>
            <div className="aspect-square w-20 flex-shrink-0 overflow-hidden bg-muted/30">
              {item.thumbnail_url || item.file_url ? (
                <img
                  src={item.thumbnail_url || item.file_url || ""}
                  alt={item.title}
                  className="h-full w-full object-cover"
                  loading="lazy"
                  decoding="async"
                />
              ) : null}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5 px-2.5 py-2">
              <div className="flex items-start justify-between gap-1.5">
                <div className="line-clamp-2 min-h-[28px] text-caption font-semibold text-foreground">{item.title}</div>
                <Badge variant="outline" className="rounded-none px-1 py-0 text-micro font-mono">{item.kind}</Badge>
              </div>
              {reasons.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {reasons.map((reason) => (
                    <Badge key={reason} variant="secondary" className="rounded-none px-1.5 py-0 text-micro font-mono">
                      {reason}
                    </Badge>
                  ))}
                </div>
              ) : null}
              <div className="mt-auto flex items-center justify-between gap-1.5">
                <span className="font-mono text-micro text-muted-foreground">score {score.toFixed(1)}</span>
                <Button
                  variant="outline"
                  className="h-6 gap-1 px-2 text-2xs"
                  style={{ borderRadius: 0 }}
                  disabled={pendingId === item.id}
                  onClick={() => void handleAdd(item)}
                >
                  {pendingId === item.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                  Add
                </Button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
