import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/* 테마 일치 커스텀 드롭다운.
 *
 * 네이티브 <select> 는 OS 가 그리는 팝업이라 (1) 포커스 시 흰색 outline,
 * (2) 선택 항목 파란 하이라이트를 테마(빨강 primary)로 바꿀 수 없다. 그래서
 * 뷰어 전역에서 쓰는 작은 커스텀 select 로 대체 — radix 의존 없이
 * (ShortcutsPopover 와 동일하게) 자체 토글 + 바깥 클릭/Esc 닫기.
 *
 * placement:
 *   - "bottom"(기본): 버튼 아래로 펼침 (상단 툴바용)
 *   - "top": 버튼 위로 펼침 (하단 컨트롤 바의 배속 select 용) */

export interface ViewerSelectOption<T extends string> {
  value: T;
  label: string;
}

interface ViewerSelectProps<T extends string> {
  value: T;
  options: ReadonlyArray<ViewerSelectOption<T>>;
  onChange: (value: T) => void;
  title?: string;
  ariaLabel?: string;
  placement?: "top" | "bottom";
  /** 버튼에 추가할 클래스(폭/shrink 등). */
  className?: string;
}

export function ViewerSelect<T extends string>({
  value,
  options,
  onChange,
  title,
  ariaLabel,
  placement = "bottom",
  className,
}: ViewerSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        /* 모달 Esc 핸들러로 전파하지 않고 드롭다운만 닫는다. */
        event.stopPropagation();
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const selected = options.find((option) => option.value === value);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-8 items-center justify-between gap-1.5 border border-border-subtle bg-background px-2 text-caption text-foreground outline-none transition-colors hover:border-primary/40 focus-visible:border-primary/40",
          open && "border-primary/40",
          className,
        )}
        style={{ borderRadius: 0 }}
        title={title}
        aria-label={ariaLabel ?? title}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="truncate">{selected?.label ?? ""}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
      </button>
      {open ? (
        <div
          role="listbox"
          className={cn(
            "absolute right-0 z-50 min-w-full border border-border-subtle bg-background shadow-xl",
            placement === "top" ? "bottom-full mb-1" : "top-full mt-1",
          )}
          style={{ borderRadius: 0 }}
        >
          {options.map((option) => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-3 px-2.5 py-1.5 text-left text-caption transition-colors",
                  active
                    ? "bg-primary/15 text-foreground"
                    : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                )}
              >
                <span className="truncate">{option.label}</span>
                {active ? <Check className="h-3 w-3 shrink-0 text-primary" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
