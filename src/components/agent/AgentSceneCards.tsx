import React, { useEffect, useLayoutEffect, useState, useRef, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import { GripVertical, Trash2, X } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  KR,
  DIV_LINE,
  FORMAT_MOOD_SLOT,
  type Asset,
  type Scene,
  type ParsedScene,
  type FocalPoint,
  buildAssetMap,
  resolveAsset,
  loadFocalMap,
  getFocalStyle,
  ACFG,
  ASSET_ICON,
} from "./agentTypes";
import { useT } from "@/lib/uiLanguage";

/* ━━━━━ TagChip ━━━━━
 * 콘티탭 씬카드(`contiInternals.TagChip`)와 동일 스타일로 통일:
 *   · 대문자 강제(textTransform: uppercase) 제거 — 에셋 등록 시 대소문자
 *     가 리졸버에 의미를 가지므로(@BG_medium ≠ @BG_MEDIUM) 그대로 노출.
 *   · fontWeight 600, 0.5px border, borderRadius 2, 좁은 padding 등
 *     씬카드 칩과 동일한 타이포/테두리/간격을 맞춤.
 *   · monospace 폰트 스택도 씬카드와 동일하게 사용. */
export const TagChip = React.memo(({ name, assetType }: { name: string; assetType: string }) => {
  const cfg = ACFG[assetType] || ACFG.character;
  const ico = ASSET_ICON[assetType] || ASSET_ICON.character;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        fontSize: 9,
        fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
        fontWeight: 600,
        letterSpacing: "0.04em",
        padding: "1px 6px 1px 4px",
        borderRadius: 2,
        background: cfg.bg,
        color: cfg.color,
        border: `0.5px solid ${cfg.bd}`,
        verticalAlign: "middle",
        lineHeight: 1,
        position: "relative",
        top: -1,
        margin: "0 1px",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          width: 0,
          height: 0,
          overflow: "hidden",
          opacity: 0,
          pointerEvents: "none",
        }}
      >
        @
      </span>
      <svg
        width={9}
        height={9}
        viewBox="0 0 24 24"
        fill="none"
        stroke={cfg.color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ display: "inline-block", flexShrink: 0 }}
      >
        <path d={ico} />
      </svg>
      {name}
    </span>
  );
});

const getClickTextOffset = (e: React.MouseEvent<HTMLElement>, fallback: number): number => {
  const root = e.currentTarget;
  const doc = root.ownerDocument;
  const point = doc.caretPositionFromPoint?.(e.clientX, e.clientY);
  const range = point
    ? null
    : typeof doc.caretRangeFromPoint === "function"
      ? doc.caretRangeFromPoint(e.clientX, e.clientY)
      : null;
  const node = point?.offsetNode ?? range?.startContainer ?? null;
  const offset = point?.offset ?? range?.startOffset ?? 0;
  if (!node || !root.contains(node)) return fallback;

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  let current = walker.nextNode();
  while (current) {
    if (current === node) return total + offset;
    total += current.textContent?.length ?? 0;
    current = walker.nextNode();
  }
  return fallback;
};
TagChip.displayName = "TagChip";

/* ━━━━━ MentionDropdown ━━━━━ */
export const MentionDropdown = React.memo(function MentionDropdown({
  suggestions,
  selIdx,
  onSelect,
  onHover,
  focalMap = {},
  upward = false,
  anchorRef,
}: {
  suggestions: Asset[];
  selIdx: number;
  onSelect: (a: Asset) => void;
  onHover: (i: number) => void;
  focalMap?: Record<string, FocalPoint>;
  upward?: boolean;
  // 입력 필드 ref를 넘기면 드롭다운을 body 포털 + fixed 위치로 렌더해
  // 컷 카드의 overflow 영역에 잘리지 않게 한다.
  anchorRef?: React.RefObject<HTMLElement>;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const usePortal = !!anchorRef;
  const [pos, setPos] = useState<{ left: number; width: number; top: number; bottom: number; openUp: boolean } | null>(
    null,
  );

  // 포털 모드: 입력 필드의 화면 좌표를 측정해 fixed 위치를 잡는다.
  // 카드/리스트가 스크롤되거나 창 크기가 바뀌면 다시 계산한다.
  useLayoutEffect(() => {
    if (!usePortal) return;
    const update = () => {
      const el = anchorRef?.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const estH = Math.min(260, suggestions.length * 46 + 8);
      const spaceBelow = window.innerHeight - r.bottom;
      const openUp = spaceBelow < estH && r.top > spaceBelow;
      setPos({
        left: r.left,
        width: r.width,
        top: r.bottom,
        bottom: window.innerHeight - r.top,
        openUp,
      });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [usePortal, anchorRef, suggestions.length]);

  useEffect(() => {
    if (selIdx < 0) return;
    const list = listRef.current;
    const item = itemRefs.current[selIdx];
    if (!list || !item) return;
    // 드롭다운(listRef) 내부에서만 스크롤한다. scrollIntoView는 스크롤 가능한
    // 상위 컨테이너(컷 카드/씬 리스트)까지 함께 스크롤해 카드가 통째로
    // 움직이는 문제가 있어, scrollTop을 직접 조정해 누수를 차단한다.
    const itemTop = item.offsetTop;
    const itemBottom = itemTop + item.offsetHeight;
    if (itemTop < list.scrollTop) {
      list.scrollTop = itemTop;
    } else if (itemBottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = itemBottom - list.clientHeight;
    }
  }, [selIdx]);

  const listStyle: React.CSSProperties = usePortal
    ? {
        position: "fixed",
        left: pos?.left ?? -9999,
        width: pos?.width ?? 0,
        ...(pos?.openUp ? { bottom: (pos?.bottom ?? 0) + 6 } : { top: (pos?.top ?? 0) + 6 }),
        zIndex: 9999,
        background: "hsl(var(--card))",
        border: "1px solid hsl(var(--border))",
        borderRadius: 0,
        overflowY: "auto",
        maxHeight: 260,
        boxShadow: "0 8px 28px rgba(0,0,0,0.14)",
        visibility: pos ? "visible" : "hidden",
      }
    : {
        position: "absolute",
        left: 0,
        right: 0,
        ...(upward ? { bottom: "calc(100% + 6px)" } : { top: "calc(100% + 6px)" }),
        zIndex: 200,
        background: "hsl(var(--card))",
        border: "1px solid hsl(var(--border))",
        borderRadius: 0,
        overflowY: "auto",
        maxHeight: 260,
        boxShadow: "0 8px 28px rgba(0,0,0,0.14)",
      };

  const content = (
    <div ref={listRef} style={listStyle}>
      {suggestions.map((a, idx) => {
        const isSel = idx === selIdx;
        const focalSt = getFocalStyle(a, focalMap);
        const typeLabel = a.asset_type === "character" ? "캐릭터" : a.asset_type === "item" ? "아이템" : "배경";
        const cfg = ACFG[a.asset_type || "character"] || ACFG.character;
        return (
          <button
            key={a.tag_name}
            type="button"
            ref={(el) => {
              itemRefs.current[idx] = el;
            }}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(a);
            }}
            onMouseEnter={() => onHover(idx)}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 9,
              padding: "8px 12px",
              // 항목 수가 적어 스크롤이 없어도 어떤 항목이 선택됐는지 확실히
              // 보이도록 강조를 뚜렷하게 한다(브랜드 컬러 틴트 + 좌측 액센트 바).
              background: isSel ? "rgba(249,66,58,0.16)" : "none",
              border: "none",
              boxShadow: isSel ? `inset 3px 0 0 ${KR}` : "none",
              cursor: "pointer",
              textAlign: "left",
              fontFamily: "inherit",
              transition: "background 0.1s, box-shadow 0.1s",
            }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: "50%",
                flexShrink: 0,
                overflow: "hidden",
                position: "relative",
                background: cfg.bg,
              }}
            >
              {a.photo_url ? (
                <div
                  style={{
                    width: "100%",
                    height: "100%",
                    backgroundRepeat: "no-repeat",
                    ...(focalSt
                      ? focalSt
                      : {
                          backgroundImage: `url(${a.photo_url})`,
                          backgroundSize: "cover",
                          backgroundPosition: "center",
                        }),
                  }}
                />
              ) : (
                <span
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 11,
                    fontWeight: 700,
                    color: cfg.color,
                  }}
                >
                  {a.tag_name.replace(/^@/, "").slice(0, 1)}
                </span>
              )}
            </div>
            <span style={{ fontSize: 12, fontWeight: 600, color: KR }}>@{a.tag_name.replace(/^@/, "")}</span>
            {a.asset_type && (
              <span
                style={{
                  fontSize: 10,
                  marginLeft: "auto",
                  padding: "1px 7px",
                  borderRadius: 0,
                  background: cfg.bg,
                  color: cfg.color,
                  border: `0.5px solid ${cfg.bd}`,
                  fontWeight: 600,
                }}
              >
                {typeLabel}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );

  return usePortal ? createPortal(content, document.body) : content;
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   AgentInlineField
   ✅ Fix: defaultValue + useRef (uncontrolled) — IME 간섭 없음
   commit은 blur / Enter 시에만 부모 onChange 호출
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
export const AgentInlineField = ({
  value,
  onChange,
  placeholder,
  style = {},
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
}) => {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const clickOffsetRef = useRef<number | null>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      const el = inputRef.current;
      el.focus();
      const len = el.value.length;
      const pos = Math.min(clickOffsetRef.current ?? len, len);
      el.setSelectionRange(pos, pos);
      clickOffsetRef.current = null;
    }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const newVal = inputRef.current?.value ?? value;
    if (newVal !== value) onChange(newVal);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        defaultValue={value} // ✅ uncontrolled — React가 IME 도중 DOM에 개입하지 않음
        onBlur={commit}
        onKeyDown={handleKeyDown}
        style={{
          ...style,
          outline: "none",
          border: `1.5px solid ${KR}`,
          borderRadius: 0,
          padding: "2px 6px",
          background: "hsl(var(--background))",
          fontFamily: "inherit",
          width: "100%",
          boxSizing: "border-box" as const,
        }}
      />
    );
  }

  return (
    <span
      onClick={(e) => {
        clickOffsetRef.current = getClickTextOffset(e, value.length);
        setEditing(true);
      }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "hsl(var(--muted))")}
      onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
      style={{
        ...style,
        display: "block",
        cursor: "text",
        borderRadius: 0,
        padding: "2px 5px",
        margin: "-2px -5px",
        transition: "background 0.1s",
      }}
    >
      {value || <span style={{ opacity: 0.3 }}>{placeholder}</span>}
    </span>
  );
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   AgentDescriptionField
   ✅ Fix: isComposing ref — IME 조합 중 mention 감지 오작동 방지
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
export const AgentDescriptionField = ({
  value,
  assets,
  projectId = "",
  onChange,
}: {
  value: string;
  assets: Asset[];
  projectId?: string;
  onChange: (v: string, tags: string[]) => void;
}) => {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value);
  const [mentionState, setMentionState] = useState<{ query: string; startIdx: number } | null>(null);
  const [selIdx, setSelIdx] = useState(-1);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const clickOffsetRef = useRef<number | null>(null);
  const focalMap = useMemo(() => loadFocalMap(projectId), [projectId]);
  // ✅ IME 조합 중 여부
  const isComposing = useRef(false);

  useEffect(() => {
    if (editing && taRef.current) {
      const ta = taRef.current;
      ta.focus();
      const len = ta.value.length;
      const pos = Math.min(clickOffsetRef.current ?? len, len);
      ta.setSelectionRange(pos, pos);
      clickOffsetRef.current = null;
    }
  }, [editing]);
  useEffect(() => {
    if (!editing) setVal(value);
  }, [value, editing]);
  useEffect(() => {
    setSelIdx(-1);
  }, [mentionState?.query]);

  const extractTags = (text: string) => [
    ...new Set(
      (text.match(/@([\w가-힣-]+)/g) ?? [])
        .map((m) => {
          const r = resolveAsset(m, assets);
          return r?.name ?? null;
        })
        .filter((n): n is string => n !== null),
    ),
  ];

  const commit = () => {
    setEditing(false);
    setMentionState(null);
    setSelIdx(-1);
    onChange(val, extractTags(val));
  };

  const detectMention = (v: string, pos: number) => {
    const m = v.slice(0, pos).match(/@([\w가-힣-]*)$/);
    setMentionState(m ? { query: m[1], startIdx: pos - m[0].length } : null);
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setVal(v);
    // ✅ IME 조합 중에는 mention 감지 건너뜀
    if (!isComposing.current) {
      detectMention(v, e.target.selectionStart ?? v.length);
    }
  };

  const handleCompositionEnd = (e: React.CompositionEvent<HTMLTextAreaElement>) => {
    isComposing.current = false;
    const ta = e.target as HTMLTextAreaElement;
    detectMention(ta.value, ta.selectionStart ?? ta.value.length);
  };

  const insertMention = (asset: Asset) => {
    if (!mentionState || !taRef.current) return;
    const ta = taRef.current;
    const name = asset.tag_name.startsWith("@") ? asset.tag_name.slice(1) : asset.tag_name;
    const before = val.slice(0, mentionState.startIdx);
    const after = val.slice(ta.selectionStart ?? mentionState.startIdx);
    const newVal = `${before}@${name} ${after}`;
    setVal(newVal);
    setMentionState(null);
    setSelIdx(-1);
    const newPos = before.length + name.length + 2;
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(newPos, newPos);
    });
  };

  const suggestions = mentionState
    ? assets
        .filter((a) => a.tag_name.replace(/^@/, "").toLowerCase().includes(mentionState.query.toLowerCase()))
        .slice(0, 6)
    : [];

  if (editing) {
    return (
      <div style={{ position: "relative" }}>
        <textarea
          ref={taRef}
          value={val}
          rows={3}
          onChange={handleChange}
          onCompositionStart={() => {
            isComposing.current = true;
          }}
          onCompositionEnd={handleCompositionEnd}
          onBlur={() => setTimeout(commit, 150)}
          onKeyDown={(e) => {
            if (suggestions.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelIdx((p) => (p + 1) % suggestions.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelIdx((p) => (p - 1 + suggestions.length) % suggestions.length);
                return;
              }
              if (e.key === "Enter" && selIdx >= 0) {
                e.preventDefault();
                insertMention(suggestions[selIdx]);
                return;
              }
            }
            if (e.key === "Escape") {
              e.stopPropagation();
              commit();
            }
          }}
          placeholder={t("agent.sceneDescriptionPlaceholder")}
          style={{
            width: "100%",
            outline: "none",
            resize: "none",
            fontSize: 12,
            lineHeight: 1.65,
            borderRadius: 0,
            padding: "6px 8px",
            border: `1.5px solid ${KR}`,
            background: "hsl(var(--background))",
            color: "hsl(var(--foreground))",
            fontFamily: "inherit",
            boxSizing: "border-box",
          }}
        />
        {suggestions.length > 0 && (
          <MentionDropdown
            suggestions={suggestions}
            selIdx={selIdx}
            onSelect={insertMention}
            onHover={setSelIdx}
            focalMap={focalMap}
            anchorRef={taRef}
          />
        )}
      </div>
    );
  }

  return (
    <div
      onClick={(e) => {
        clickOffsetRef.current = getClickTextOffset(e, value.length);
        setEditing(true);
      }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "hsl(var(--muted))")}
      onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
      style={{
        fontSize: 12,
        color: "hsl(var(--foreground))",
        lineHeight: 1.65,
        cursor: "text",
        borderRadius: 0,
        padding: "3px 5px",
        margin: "-3px -5px",
        minHeight: 20,
        transition: "background 0.1s",
      }}
    >
      {value ? (
        value.split(/(@[\w가-힣-]+)/g).map((p, i) => {
          if (/^@[\w가-힣-]+$/.test(p)) {
            const resolved = resolveAsset(p, assets);
            if (resolved)
              return <TagChip key={i} name={resolved.name} assetType={resolved.asset.asset_type || "character"} />;
          }
          return <span key={i}>{p}</span>;
        })
      ) : (
        <span style={{ opacity: 0.3 }}>{t("agent.sceneDescriptionEmpty")}</span>
      )}
    </div>
  );
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   AgentLocationField
   ✅ Fix: isComposing ref — @멘션 자동완성 유지하면서 IME 보호
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
export const AgentLocationField = ({
  value,
  assets,
  projectId = "",
  onChange,
}: {
  value: string;
  assets: Asset[];
  projectId?: string;
  onChange: (v: string) => void;
}) => {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value);
  const [mentionState, setMentionState] = useState<{ query: string; startIdx: number } | null>(null);
  const [selIdx, setSelIdx] = useState(-1);
  const inpRef = useRef<HTMLInputElement>(null);
  const clickOffsetRef = useRef<number | null>(null);
  const focalMap = useMemo(() => loadFocalMap(projectId), [projectId]);
  // ✅ IME 조합 중 여부
  const isComposing = useRef(false);

  useEffect(() => {
    if (editing && inpRef.current) {
      const input = inpRef.current;
      input.focus();
      const len = input.value.length;
      const pos = Math.min(clickOffsetRef.current ?? len, len);
      input.setSelectionRange(pos, pos);
      clickOffsetRef.current = null;
    }
  }, [editing]);
  useEffect(() => {
    if (!editing) setVal(value);
  }, [value, editing]);
  // 멘션이 열리거나 검색어가 바뀌면 첫 항목을 바로 하이라이트해 둔다.
  // (선택 인덱스를 0으로 두면 방향키 이동이 시각적으로 분명해지고,
  //  Enter로 곧바로 첫 후보를 등록할 수 있다.)
  useEffect(() => {
    setSelIdx(mentionState ? 0 : -1);
  }, [mentionState?.query, mentionState]);

  const bgAssets = assets.filter((a) => a.asset_type === "background");

  const commit = () => {
    setEditing(false);
    setMentionState(null);
    setSelIdx(-1);
    onChange(val);
  };

  const detectMention = (v: string, pos: number) => {
    const m = v.slice(0, pos).match(/@([\w가-힣-]*)$/);
    setMentionState(m ? { query: m[1], startIdx: pos - m[0].length } : null);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setVal(v);
    // ✅ IME 조합 중에는 mention 감지 건너뜀
    if (!isComposing.current) {
      detectMention(v, e.target.selectionStart ?? v.length);
    }
  };

  const handleCompositionEnd = (e: React.CompositionEvent<HTMLInputElement>) => {
    isComposing.current = false;
    const el = e.target as HTMLInputElement;
    detectMention(el.value, el.selectionStart ?? el.value.length);
  };

  const handleSelect = (asset: Asset, andCommit = false) => {
    const name = asset.tag_name.startsWith("@") ? asset.tag_name.slice(1) : asset.tag_name;
    let newVal: string;
    if (mentionState && inpRef.current) {
      const before = val.slice(0, mentionState.startIdx);
      const after = val.slice(inpRef.current.selectionStart ?? mentionState.startIdx);
      newVal = `${before}@${name}${after}`;
    } else {
      newVal = `@${name}`;
    }
    setVal(newVal);
    setMentionState(null);
    setSelIdx(-1);
    if (andCommit) {
      // 자동완성에서 Enter로 선택하면 바로 커밋해 에셋을 등록한다.
      setEditing(false);
      onChange(newVal);
    } else {
      requestAnimationFrame(() => inpRef.current?.focus());
    }
  };

  const bgSuggestions = mentionState
    ? bgAssets
        .filter((a) => a.tag_name.replace(/^@/, "").toLowerCase().includes(mentionState.query.toLowerCase()))
        .slice(0, 5)
    : [];

  if (editing) {
    return (
      <div style={{ position: "relative", flex: 1 }}>
        <input
          ref={inpRef}
          value={val}
          onChange={handleChange}
          onCompositionStart={() => {
            isComposing.current = true;
          }}
          onCompositionEnd={handleCompositionEnd}
          onBlur={() => setTimeout(commit, 150)}
          onKeyDown={(e) => {
            if (bgSuggestions.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelIdx((p) => (p + 1) % bgSuggestions.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelIdx((p) => (p - 1 + bgSuggestions.length) % bgSuggestions.length);
                return;
              }
              if (e.key === "Enter" && selIdx >= 0) {
                e.preventDefault();
                handleSelect(bgSuggestions[selIdx], true);
                return;
              }
            }
            if (e.key === "Enter" || e.key === "Escape") commit();
          }}
          placeholder={t("agent.locationPlaceholder")}
          style={{
            width: "100%",
            outline: "none",
            border: `1.5px solid ${KR}`,
            borderRadius: 0,
            padding: "2px 6px",
            fontSize: 12,
            background: "hsl(var(--background))",
            color: "hsl(var(--foreground))",
            fontFamily: "inherit",
          }}
        />
        {bgSuggestions.length > 0 && (
          <MentionDropdown
            suggestions={bgSuggestions}
            selIdx={selIdx}
            onSelect={handleSelect}
            onHover={setSelIdx}
            focalMap={focalMap}
            anchorRef={inpRef}
          />
        )}
      </div>
    );
  }

  return (
    <span
      onClick={(e) => {
        clickOffsetRef.current = getClickTextOffset(e, value.length);
        setEditing(true);
      }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "hsl(var(--muted))")}
      onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
      style={{
        flex: 1,
        fontSize: 12,
        cursor: "text",
        borderRadius: 0,
        padding: "2px 5px",
        margin: "-2px -5px",
        transition: "background 0.1s",
      }}
    >
      {value ? (
        value.split(/(@[\w가-힣-]+)/g).map((p, i) => {
          if (/^@[\w가-힣-]+$/.test(p)) {
            const resolved = resolveAsset(p, assets);
            if (resolved)
              return <TagChip key={i} name={resolved.name} assetType={resolved.asset.asset_type || "character"} />;
          }
          return <span key={i}>{p}</span>;
        })
      ) : (
        <span style={{ opacity: 0.3 }}>{t("agent.enterLocation")}</span>
      )}
    </span>
  );
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   AgentMetaRows
   ✅ Fix: inputRefs + defaultValue (uncontrolled)
   핵심 버그: onChange에서 onUpdate 직접 호출 → 부모 setState →
   씬카드 전체 리렌더 → input 교체 → IME 파괴 → ㅇㄷㅇㅁ
   수정: commitField 시점(blur/Enter)에만 onUpdate 호출
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
export const AgentMetaRows = ({
  fields,
  assets,
  projectId,
  onUpdate,
}: {
  fields: { camera_angle: string; mood: string; location: string; duration_sec: string };
  assets: Asset[];
  projectId?: string;
  onUpdate: (k: string, v: string) => void;
}) => {
  const t = useT();
  const [ek, setEk] = useState<string | null>(null);
  // ✅ 각 input ref를 map으로 관리
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const clickOffsetRefs = useRef<Record<string, number | null>>({});

  // commit 시점에만 부모에게 값 전달
  const commitField = (k: string) => {
    const newVal = inputRefs.current[k]?.value ?? (fields as any)[k] ?? "";
    setEk(null);
    onUpdate(k, newVal);
  };

  const startEdit = (k: string, offset?: number) => {
    clickOffsetRefs.current[k] = typeof offset === "number" ? offset : null;
    setEk(k);
    setTimeout(() => {
      const el = inputRefs.current[k];
      if (el) {
        el.focus();
        const len = el.value.length;
        if (el.type !== "number") {
          const pos = Math.min(clickOffsetRefs.current[k] ?? len, len);
          el.setSelectionRange(pos, pos);
        }
        clickOffsetRefs.current[k] = null;
      }
    }, 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, k: string) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitField(k);
    } else if (e.key === "Escape") {
      setEk(null);
    } // 취소 — 변경 버림
  };

  const topRows = [
    {
      k: "camera_angle",
      icon: "M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2zM12 17a4 4 0 100-8 4 4 0 000 8",
      color: KR,
      label: t("agent.camera"),
    },
    {
      k: "mood",
      icon: "M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z",
      color: "#f59e0b",
      label: t("agent.mood"),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {topRows.map(({ k, icon, color, label }) => {
        const val = (fields as any)[k] as string;
        return (
          <div key={k} style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 26 }}>
            <svg
              width={12}
              height={12}
              viewBox="0 0 24 24"
              fill="none"
              stroke={color}
              strokeWidth={1.75}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ flexShrink: 0 }}
            >
              <path d={icon} />
            </svg>
            <span style={{ fontSize: 11, color: "hsl(var(--muted-foreground))", width: 56, flexShrink: 0 }}>
              {label}
            </span>
            {ek === k ? (
              <input
                // ✅ ref 콜백으로 등록, defaultValue로 초기값 세팅 (uncontrolled)
                ref={(el) => {
                  inputRefs.current[k] = el;
                }}
                defaultValue={val}
                onBlur={() => commitField(k)}
                onKeyDown={(e) => handleKeyDown(e, k)}
                autoFocus
                style={{
                  flex: 1,
                  border: `1.5px solid ${KR}`,
                  outline: "none",
                  borderRadius: 0,
                  padding: "2px 6px",
                  fontSize: 12,
                  background: "hsl(var(--background))",
                  color: "hsl(var(--foreground))",
                  fontFamily: "inherit",
                }}
              />
            ) : (
              <span
                onClick={(e) => startEdit(k, getClickTextOffset(e, val.length))}
                onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "hsl(var(--muted))")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
                style={{
                  flex: 1,
                  fontSize: 12,
                  cursor: "text",
                  borderRadius: 0,
                  padding: "2px 6px",
                  margin: "-2px -6px",
                  color: val ? "hsl(var(--foreground))" : "hsl(var(--muted-foreground))",
                  opacity: val ? 1 : 0.35,
                  transition: "background 0.1s",
                }}
              >
                {val || t("agent.enterField", { label })}
              </span>
            )}
          </div>
        );
      })}

      {/* Location — AgentLocationField (자체 IME 처리) */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 26 }}>
        <svg
          width={12}
          height={12}
          viewBox="0 0 24 24"
          fill="none"
          stroke="#6b7280"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0 }}
        >
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0zM12 13a3 3 0 100-6 3 3 0 000 6" />
        </svg>
        <span style={{ fontSize: 11, color: "hsl(var(--muted-foreground))", width: 56, flexShrink: 0 }}>{t("agent.location")}</span>
        <AgentLocationField
          value={fields.location}
          assets={assets}
          projectId={projectId}
          onChange={(v) => onUpdate("location", v)}
        />
      </div>

      {/* Duration */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 26 }}>
        <svg
          width={12}
          height={12}
          viewBox="0 0 24 24"
          fill="none"
          stroke="#94a3b8"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0 }}
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
        <span style={{ fontSize: 11, color: "hsl(var(--muted-foreground))", width: 56, flexShrink: 0 }}>{t("agent.duration")}</span>
        {ek === "duration_sec" ? (
          <input
            ref={(el) => {
              inputRefs.current["duration_sec"] = el;
            }}
            defaultValue={fields.duration_sec}
            type="number"
            min={1}
            max={60}
            onBlur={() => commitField("duration_sec")}
            onKeyDown={(e) => handleKeyDown(e, "duration_sec")}
            autoFocus
            style={{
              flex: 1,
              border: `1.5px solid ${KR}`,
              outline: "none",
              borderRadius: 0,
              padding: "2px 6px",
              fontSize: 12,
              background: "hsl(var(--background))",
              color: "hsl(var(--foreground))",
              fontFamily: "inherit",
            }}
          />
        ) : (
          <span
            onClick={() => startEdit("duration_sec")}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "hsl(var(--muted))")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
            style={{
              flex: 1,
              fontSize: 12,
              cursor: "text",
              borderRadius: 0,
              padding: "2px 6px",
              margin: "-2px -6px",
              transition: "background 0.1s",
              color: fields.duration_sec ? "hsl(var(--foreground))" : "hsl(var(--muted-foreground))",
              opacity: fields.duration_sec ? 1 : 0.35,
            }}
          >
            {fields.duration_sec ? `${fields.duration_sec}s` : "+ Enter time"}
          </span>
        )}
      </div>
    </div>
  );
};

/* ━━━━━ EditablePendingSceneCard ━━━━━ */
export const EditablePendingSceneCard = React.memo(function EditablePendingSceneCard({
  scene,
  assets,
  projectId = "",
  onUpdate,
}: {
  scene: ParsedScene;
  assets: Asset[];
  projectId?: string;
  onUpdate: (u: ParsedScene) => void;
}) {
  const t = useT();
  const [local, setLocal] = useState<ParsedScene>({ ...scene });
  useEffect(() => setLocal({ ...scene }), [scene]);
  const assetMap = buildAssetMap(assets);
  const update = (patch: Partial<ParsedScene>) => {
    const next = { ...local, ...patch };
    setLocal(next);
    onUpdate(next);
  };
  // Location tags come FIRST in tagged_assets so fetchTaggedAssets
  // preserves the scene's primary background (bgAssets[0] downstream).
  const handleDescChange = (desc: string, tags: string[]) => {
    const locMentions = (local.location ?? "").match(/@([\w가-힣-]+)/g) ?? [];
    const locFiltered = locMentions.map((t) => t.slice(1)).filter((n) => assetMap[n]);
    update({ description: desc, tagged_assets: [...new Set([...locFiltered, ...tags])] });
  };
  const handleLocChange = (loc: string) => {
    const locMentions = (loc.match(/@([\w가-힣-]+)/g) ?? [])
      .map((t) => t.slice(1))
      .filter((n) => {
        const a = assetMap[n];
        return a && a.asset_type === "background";
      });
    const descTags = (local.description ?? "").match(/@([\w가-힣-]+)/g) ?? [];
    const descFiltered = descTags.map((t) => t.slice(1)).filter((n) => assetMap[n]);
    update({ location: loc, tagged_assets: [...new Set([...locMentions, ...descFiltered])] });
  };
  return (
    <div className="border bg-card p-3" style={{ borderRadius: 0, borderColor: "rgba(255,255,255,0.07)" }}>
      <div className="flex items-center gap-2 mb-2.5">
        <span
          className="font-mono text-micro font-bold px-1.5 py-0.5 text-white shrink-0"
          style={{ background: KR, borderRadius: 0 }}
        >
          #{String(scene.scene_number).padStart(2, "0")}
        </span>
        <button
          type="button"
          onClick={() => {
            const next = !local.is_highlight;
            update({
              is_highlight: next,
              highlight_kind: next ? (local.highlight_kind ?? "hero") : null,
              highlight_reason: next ? (local.highlight_reason ?? "User-marked key visual candidate.") : null,
            });
          }}
          title={local.is_highlight ? "Unmark Highlight" : "Mark as Highlight"}
          aria-pressed={!!local.is_highlight}
          className="font-mono text-micro font-bold px-1.5 py-0.5 shrink-0 inline-flex items-center gap-1 cursor-pointer"
          style={{
            borderRadius: 0,
            border: local.is_highlight ? `1px solid ${KR}` : "1px solid rgba(255,255,255,0.12)",
            background: local.is_highlight ? "rgba(249,66,58,0.14)" : "rgba(255,255,255,0.03)",
            color: local.is_highlight ? "#fff" : "rgba(255,255,255,0.38)",
          }}
        >
          <span>H</span>
        </button>
        <div style={{ flex: 1 }}>
          <AgentInlineField
            value={local.title ?? ""}
            onChange={(v) => update({ title: v })}
            placeholder={t("agent.shotTitlePlaceholder")}
            style={{ fontSize: 12, fontWeight: 600, color: "hsl(var(--foreground))" } as any}
          />
        </div>
      </div>
      <div className="mb-2">
        <AgentDescriptionField
          value={local.description ?? ""}
          assets={assets}
          projectId={projectId}
          onChange={handleDescChange}
        />
      </div>
      <div style={{ borderTop: DIV_LINE, paddingTop: 6 }}>
        <AgentMetaRows
          fields={{
            camera_angle: local.camera_angle ?? "",
            mood: local.mood ?? "",
            location: local.location ?? "",
            duration_sec: local.duration_sec != null ? String(local.duration_sec) : "",
          }}
          assets={assets}
          projectId={projectId}
          onUpdate={(k, v) => {
            if (k === "location") handleLocChange(v);
            else if (k === "duration_sec") update({ duration_sec: v ? parseFloat(v) : undefined });
            else update({ [k]: v });
          }}
        />
      </div>
    </div>
  );
});

/* ━━━━━ SortableSceneCard ━━━━━ */
export const SortableSceneCard = React.memo(function SortableSceneCard({
  scene,
  onDelete,
  onUpdate,
  onClearImage,
  assets,
  onLightboxMood,
  videoFormat = "vertical",
  sharedHeight,
  onContentHeight,
  showImages = true,
  onDropMoodImage,
  maxImgWidth,
}: {
  scene: Scene;
  onDelete: (id: string) => void;
  onUpdate: (id: string, f: Partial<Scene>) => void;
  onClearImage: (scene: Scene) => void;
  assets: Asset[];
  onLightboxMood: (url: string) => void;
  videoFormat?: string;
  sharedHeight: number;
  onContentHeight: (id: string, h: number) => void;
  showImages?: boolean;
  onDropMoodImage?: (
    sceneId: string,
    sceneNumber: number,
    payload: { moodImageId: string; url: string },
  ) => void;
  /** 패널 폭 대비 이미지 컬럼 최대 폭(px). 미지정 시 제한 없음. */
  maxImgWidth?: number;
}) {
  const t = useT();
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: scene.id });
  const [moodHovered, setMoodHovered] = useState(false);
  const [dropOver, setDropOver] = useState(false);
  const assetMap = buildAssetMap(assets);
  const slotCfg = FORMAT_MOOD_SLOT[videoFormat] ?? FORMAT_MOOD_SLOT.vertical;
  const [wr, hr] = slotCfg.aspectRatio.split("/").map(Number);
  // imgWidth 가 sharedHeight 에서만 파생되면 (sharedHeight → imgWidth → content 폭 축소
  // → content 높이↑ → sharedHeight↑) 피드백 루프가 발생한다.
  // 패널 폭을 기준으로 상한(maxImgWidth)을 걸어 피드백 루프를 차단한다.
  const naturalImgWidth = Math.round((sharedHeight * wr) / hr);
  const imgWidth =
    maxImgWidth && maxImgWidth > 0 ? Math.min(naturalImgWidth, Math.round(maxImgWidth)) : naturalImgWidth;
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const h = el.getBoundingClientRect().height;
      if (h > 0) onContentHeight(scene.id, h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [scene.id, onContentHeight]);

  // Location tags come FIRST in tagged_assets so fetchTaggedAssets
  // preserves the scene's primary background (bgAssets[0] downstream).
  const handleDescChange = (desc: string, tags: string[]) => {
    const locMentions = (scene.location ?? "").match(/@([\w가-힣-]+)/g) ?? [];
    const locFiltered = locMentions
      .map((t) => t.slice(1))
      .filter((n) => assetMap[n] && assetMap[n].asset_type === "background");
    onUpdate(scene.id, { description: desc, tagged_assets: [...new Set([...locFiltered, ...tags])] });
  };

  const handleLocChange = (loc: string) => {
    const locMentions = (loc.match(/@([\w가-힣-]+)/g) ?? [])
      .map((t) => t.slice(1))
      .filter((n) => {
        const a = assetMap[n];
        return a && a.asset_type === "background";
      });
    const descTags = (scene.description ?? "").match(/@([\w가-힣-]+)/g) ?? [];
    const descFiltered = descTags.map((t) => t.slice(1)).filter((n) => assetMap[n]);
    onUpdate(scene.id, { location: loc, tagged_assets: [...new Set([...locMentions, ...descFiltered])] });
  };

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, borderRadius: 0 }}
      className="border border-border bg-card overflow-hidden flex"
    >
      {showImages && (
        <div
          style={{
            width: imgWidth,
            minWidth: imgWidth,
            height: sharedHeight,
            flexShrink: 0,
            position: "relative",
            overflow: "hidden",
            background: "hsl(var(--muted))",
            cursor: scene.conti_image_url ? "pointer" : "default",
          }}
          onMouseEnter={() => setMoodHovered(true)}
          onMouseLeave={() => setMoodHovered(false)}
          onDragEnter={(e) => {
            if (!onDropMoodImage) return;
            if (e.dataTransfer.types.includes("application/x-mood-image")) {
              e.preventDefault();
              setDropOver(true);
            }
          }}
          onDragOver={(e) => {
            if (!onDropMoodImage) return;
            if (e.dataTransfer.types.includes("application/x-mood-image")) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }
          }}
          onDragLeave={(e) => {
            const related = e.relatedTarget as Node | null;
            if (related && (e.currentTarget as Node).contains(related)) return;
            setDropOver(false);
          }}
          onDrop={(e) => {
            if (!onDropMoodImage) return;
            const data = e.dataTransfer.getData("application/x-mood-image");
            setDropOver(false);
            if (!data) return;
            e.preventDefault();
            try {
              const payload = JSON.parse(data) as { moodImageId: string; url: string };
              if (payload?.url && payload?.moodImageId) {
                onDropMoodImage(scene.id, scene.scene_number, payload);
              }
            } catch {
              /* ignore */
            }
          }}
          onClick={() => {
            if (scene.conti_image_url) onLightboxMood(scene.conti_image_url);
          }}
        >
          {scene.conti_image_url ? (
            <img
              src={scene.conti_image_url}
              alt="mood"
              loading="lazy"
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "cover",
                display: "block",
              }} decoding="async" />
          ) : (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
              }}
            >
              <svg
                width={16}
                height={16}
                viewBox="0 0 24 24"
                fill="none"
                stroke="hsl(var(--muted-foreground))"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ opacity: 0.3 }}
              >
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M3 9h18M9 21V9" />
              </svg>
              <span
                style={{
                  fontSize: 8,
                  color: "hsl(var(--muted-foreground))",
                  opacity: 0.4,
                  textAlign: "center",
                  lineHeight: 1.4,
                }}
              ></span>
            </div>
          )}
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: moodHovered ? "rgba(0,0,0,0.28)" : "rgba(0,0,0,0)",
              transition: "background 0.12s",
              pointerEvents: "none",
            }}
          />
          {dropOver && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
                background: "rgba(249,66,58,0.14)",
                border: `2px dashed ${KR}`,
                pointerEvents: "none",
                zIndex: 4,
              }}
            >
              <svg
                width={20}
                height={20}
                viewBox="0 0 24 24"
                fill="none"
                stroke={KR}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              <span
                className="font-mono"
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  letterSpacing: "0.12em",
                  color: KR,
                  textTransform: "uppercase",
                }}
              >
                Drop to attach
              </span>
            </div>
          )}
          {moodHovered && scene.conti_image_url && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClearImage(scene);
              }}
              style={{
                position: "absolute",
                top: 5,
                right: 5,
                width: 20,
                height: 20,
                borderRadius: "50%",
                background: "rgba(0,0,0,0.55)",
                border: "none",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 2,
              }}
            >
              <X style={{ width: 9, height: 9, color: "#fff" }} />
            </button>
          )}
          {moodHovered && scene.conti_image_url && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onLightboxMood(scene.conti_image_url!);
              }}
              style={{
                position: "absolute",
                bottom: 5,
                right: 5,
                width: 20,
                height: 20,
                borderRadius: 0,
                background: "rgba(0,0,0,0.45)",
                border: "none",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 2,
              }}
            >
              <svg
                width={9}
                height={9}
                viewBox="0 0 24 24"
                fill="none"
                stroke="rgba(255,255,255,.85)"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
              </svg>
            </button>
          )}
        </div>
      )}
      <div
        ref={contentRef}
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          borderLeft: showImages ? "0.5px solid hsl(var(--border))" : "none",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 3,
            padding: "7px 6px 6px 10px",
            borderBottom: "0.5px solid hsl(var(--border))",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              display: "inline-block",
              fontSize: 9,
              fontWeight: 700,
              fontFamily: "monospace",
              padding: "2px 6px",
              borderRadius: 0,
              background: KR,
              color: "#fff",
              letterSpacing: "0.05em",
              flexShrink: 0,
            }}
          >
            #{String(scene.scene_number).padStart(2, "0")}
          </span>
          <button
            type="button"
            onClick={() => {
              const next = !scene.is_highlight;
              onUpdate(scene.id, {
                is_highlight: next,
                highlight_kind: next ? (scene.highlight_kind ?? "hero") : null,
                highlight_reason: next ? (scene.highlight_reason ?? "User-marked key visual candidate.") : null,
              });
            }}
            title={scene.is_highlight ? "Unmark Highlight" : "Mark as Highlight"}
            aria-pressed={!!scene.is_highlight}
            className="font-mono text-micro font-bold px-1.5 py-0.5 shrink-0 inline-flex items-center gap-1 cursor-pointer"
            style={{
              borderRadius: 0,
              border: scene.is_highlight ? `1px solid ${KR}` : "1px solid rgba(255,255,255,0.12)",
              background: scene.is_highlight ? "rgba(249,66,58,0.14)" : "rgba(255,255,255,0.03)",
              color: scene.is_highlight ? "#fff" : "rgba(255,255,255,0.38)",
            }}
          >
            <span>H</span>
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <AgentInlineField
              value={scene.title ?? ""}
              onChange={(v) => onUpdate(scene.id, { title: v })}
              placeholder={t("agent.shotTitlePlaceholder")}
              style={{ fontSize: 13, fontWeight: 600, color: "hsl(var(--foreground))" } as any}
            />
          </div>
          <button
            {...attributes}
            {...listeners}
            className="p-1 text-muted-foreground cursor-grab active:cursor-grabbing touch-none"
          >
            <GripVertical className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => onDelete(scene.id)} className="p-1 text-muted-foreground hover:text-destructive">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
        <div style={{ padding: "6px 10px", borderBottom: "0.5px solid hsl(var(--border))", flexShrink: 0 }}>
          <AgentDescriptionField
            value={scene.description ?? ""}
            assets={assets}
            projectId={scene.project_id}
            onChange={handleDescChange}
          />
        </div>
        <div style={{ padding: "6px 10px 8px", flex: 1 }}>
          <AgentMetaRows
            fields={{
              camera_angle: scene.camera_angle ?? "",
              mood: scene.mood ?? "",
              location: scene.location ?? "",
              duration_sec: scene.duration_sec != null ? String(scene.duration_sec) : "",
            }}
            assets={assets}
            projectId={scene.project_id}
            onUpdate={(k, v) => {
              if (k === "location") handleLocChange(v);
              else if (k === "duration_sec") onUpdate(scene.id, { duration_sec: v ? parseFloat(v) : null });
              else onUpdate(scene.id, { [k]: v });
            }}
          />
        </div>
      </div>
    </div>
  );
});
