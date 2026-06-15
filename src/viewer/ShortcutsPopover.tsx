import { useEffect, useRef, useState } from "react";
import { Keyboard } from "lucide-react";

/* 단축키 안내 팝오버 — 메인 앱 LibraryPreviewPanel 의 Keyboard 팝오버와 동일
 * 시각/구성. radix 의존(viewer 번들 경량 + file:// 안정) 대신 자체 토글 패널.
 * 컨트롤 바가 하단이라 위쪽으로 펼친다. 바깥 클릭 / Esc 로 닫고, Esc 는
 * 모달까지 전파되지 않도록 capture 단계에서 가로챈다. */

interface ShortcutRow {
  keys: string;
  label: string;
}

interface ShortcutsPopoverProps {
  title: string;
  buttonTitle: string;
  rows: ShortcutRow[];
}

export function ShortcutsPopover({ title, buttonTitle, rows }: ShortcutsPopoverProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        /* 팝오버만 닫고 모달 Esc 핸들러로는 넘기지 않는다. */
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

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex h-8 w-8 items-center justify-center transition-colors hover:bg-muted/40"
        style={{ borderRadius: 0 }}
        title={buttonTitle}
        aria-label={buttonTitle}
        aria-expanded={open}
      >
        <Keyboard className="h-3.5 w-3.5" />
      </button>
      {open ? (
        <div
          className="absolute bottom-full right-0 z-50 mb-2 w-60 border border-border-subtle bg-background shadow-xl"
          style={{ borderRadius: 0 }}
        >
          <div className="border-b border-border-subtle px-3 py-2 text-caption font-semibold">
            {title}
          </div>
          <ul className="max-h-[50vh] overflow-auto py-1">
            {rows.map((row) => (
              <li
                key={row.label}
                className="flex items-center justify-between gap-3 px-3 py-1 text-caption"
              >
                <span className="text-muted-foreground">{row.label}</span>
                <kbd className="shrink-0 border border-border-subtle bg-muted/40 px-1.5 py-0.5 font-mono text-micro text-foreground">
                  {row.keys}
                </kbd>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
