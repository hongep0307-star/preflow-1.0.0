import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";

/* 태그 빈도순 칩 행. 접힘 상태에선 상위 N 개만 보이고 "더보기" 로 펼친다.
 * 선택된 태그는 AND 필터로 동작(부모 App 이 결합) — 칩 자체는 토글만 알린다. */

interface TagChipsProps {
  frequencies: Array<{ tag: string; count: number }>;
  selected: ReadonlySet<string>;
  onToggle: (tag: string) => void;
  /** 접힘 상태에서 보여줄 칩 수. 기본 12. */
  collapsedLimit?: number;
}

export function TagChips({ frequencies, selected, onToggle, collapsedLimit = 12 }: TagChipsProps) {
  const [expanded, setExpanded] = useState(false);

  /* 선택된 태그는 빈도가 낮아 잘려 나가도 항상 보이도록 앞쪽으로 끌어온다. */
  const ordered = useMemo(() => {
    const sel = frequencies.filter((f) => selected.has(f.tag));
    const rest = frequencies.filter((f) => !selected.has(f.tag));
    return [...sel, ...rest];
  }, [frequencies, selected]);

  if (ordered.length === 0) return null;

  const visible = expanded ? ordered : ordered.slice(0, collapsedLimit);
  const hiddenCount = ordered.length - visible.length;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {visible.map(({ tag, count }) => {
        const isSelected = selected.has(tag);
        return (
          <button
            key={tag}
            type="button"
            onClick={() => onToggle(tag)}
            className={cn(
              "inline-flex items-center gap-1 border px-2 py-0.5 text-caption transition-colors",
              isSelected
                ? "border-primary bg-primary/15 text-foreground"
                : "border-border-subtle text-muted-foreground hover:border-primary/40 hover:text-foreground",
            )}
            style={{ borderRadius: 0 }}
            title={`${tag} (${count})`}
          >
            <span className="max-w-[160px] truncate">{tag}</span>
            <span className="font-mono text-2xs opacity-60">{count}</span>
          </button>
        );
      })}
      {hiddenCount > 0 && !expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="px-1.5 py-0.5 text-caption text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          +{hiddenCount}
        </button>
      ) : null}
      {expanded && ordered.length > collapsedLimit ? (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="px-1.5 py-0.5 text-caption text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          less
        </button>
      ) : null}
    </div>
  );
}
