import React, { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { Send, Users, Package, MapPin } from "lucide-react";

/* ━━━━━ Krafton 컬러 ━━━━━ */
import { KR, KR_BG } from "@/lib/brand";

const ASSET_COLORS: Record<AssetType, { color: string; bg: string }> = {
  character: { color: "#6366f1", bg: "rgba(99,102,241,0.12)" },
  item: { color: "#d97706", bg: "rgba(245,158,11,0.12)" },
  background: { color: "#059669", bg: "rgba(16,185,129,0.12)" },
};

type AssetType = "character" | "item" | "background";

const TYPE_META: Record<AssetType, { icon: React.ReactNode; label: string }> = {
  character: { icon: <Users className="w-3 h-3" />, label: "character" },
  item: { icon: <Package className="w-3 h-3" />, label: "item" },
  background: { icon: <MapPin className="w-3 h-3" />, label: "background" },
};

interface Asset {
  id?: string;
  tag_name: string;
  photo_url: string | null;
  ai_description: string | null;
  asset_type?: AssetType;
}

interface MentionInputProps {
  assets: Asset[];
  onSend?: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Controlled mode: external value */
  value?: string;
  /** Controlled mode: called on every keystroke / mention insert */
  onChange?: (text: string) => void;
  /** Minimum height for textarea (default 40) */
  minHeight?: number;
  /** Optional external textarea ref for caret-based insertions */
  textareaRef?: React.RefObject<HTMLTextAreaElement>;
  /** Called when Enter is pressed in controlled mode */
  onSubmit?: () => void;
  /** Remove rounded corners on the textarea (e.g. Inpaint prompt). */
  squareCorners?: boolean;
}

/* ━━━━━ 드롭다운 아이템 ━━━━━ */
const AssetDropdownItem = ({
  asset,
  isSelected,
  onSelect,
  onHover,
}: {
  asset: Asset;
  isSelected: boolean;
  onSelect: () => void;
  onHover: () => void;
}) => {
  const type: AssetType = asset.asset_type ?? "character";
  const meta = TYPE_META[type];
  const itemRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isSelected && itemRef.current) {
      itemRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [isSelected]);

  return (
    <button
      ref={itemRef}
      onClick={onSelect}
      onMouseEnter={onHover}
      className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors ${
        isSelected ? "bg-accent" : "hover:bg-accent/50"
      }`}
    >
      {asset.photo_url ? (
        <img src={asset.photo_url} className="w-8 h-8 rounded-full object-cover border border-border shrink-0" alt="" loading="lazy" decoding="async" />
      ) : (
        <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ background: ASSET_COLORS[type]?.bg ?? KR_BG }}>
          <span className="text-sm font-semibold" style={{ color: ASSET_COLORS[type]?.color ?? KR }}>
            {asset.tag_name.replace("@", "")[0]?.toUpperCase() ?? "?"}
          </span>
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-foreground">{asset.tag_name}</span>
          <span
            className="inline-flex items-center gap-0.5 text-2xs px-1.5 py-0.5 rounded-full"
            style={{ background: ASSET_COLORS[type]?.bg ?? KR_BG, color: ASSET_COLORS[type]?.color ?? KR }}
          >
            {meta.icon}
            {meta.label}
          </span>
        </div>
        {asset.ai_description && (
          <div className="text-xs text-muted-foreground truncate mt-0.5">{asset.ai_description.slice(0, 50)}</div>
        )}
      </div>
    </button>
  );
};

/* ━━━━━ MentionInput ━━━━━ */
const MentionInput: React.FC<MentionInputProps> = ({
  assets,
  onSend,
  disabled,
  placeholder = "Type a message...",
  value,
  onChange,
  minHeight,
  textareaRef: externalTextareaRef,
  onSubmit,
  squareCorners,
}) => {
  const isControlled = value !== undefined && onChange !== undefined;
  const [internalText, setInternalText] = useState("");
  const rawText = isControlled ? value : internalText;
  const setRawText = isControlled ? onChange : setInternalText;
  const [showDropdown, setShowDropdown] = useState(false);
  const [dropdownQuery, setDropdownQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const fallbackTextareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = externalTextareaRef ?? fallbackTextareaRef;
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [hasRangeSelection, setHasRangeSelection] = useState(false);

  const filteredAssets = assets.filter((a) =>
    a.tag_name.replace(/^@/, "").toLowerCase().includes(dropdownQuery.toLowerCase()),
  );

  const grouped: { type: AssetType; items: Asset[] }[] = (["character", "item", "background"] as AssetType[])
    .map((t) => ({ type: t, items: filteredAssets.filter((a) => (a.asset_type ?? "character") === t) }))
    .filter((g) => g.items.length > 0);

  const flatFiltered = grouped.flatMap((g) => g.items);

  const syncSelectionState = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    setHasRangeSelection(textarea.selectionStart !== textarea.selectionEnd);
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    const pos = e.target.selectionStart ?? 0;
    setHasRangeSelection(false);
    setRawText(val);
    const atMatch = val.slice(0, pos).match(/@([^\s@]*)$/);
    if (atMatch) {
      setDropdownQuery(atMatch[1]);
      setShowDropdown(true);
      setSelectedIndex(0);
    } else {
      setShowDropdown(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showDropdown && flatFiltered.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, flatFiltered.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectAsset(flatFiltered[selectedIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowDropdown(false);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !showDropdown) {
      e.preventDefault();
      if (isControlled && onSubmit) {
        onSubmit();
      } else if (!isControlled) {
        handleSend();
      }
    }
  };

  const selectAsset = (asset: Asset) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const currentVal = textarea.value;
    const pos = textarea.selectionStart ?? currentVal.length;
    const before = currentVal.slice(0, pos);
    const tagName = asset.tag_name.startsWith("@") ? asset.tag_name : `@${asset.tag_name}`;
    // Find the @query portion to replace
    const atMatch = before.match(/@[^\s@]*$/);
    if (!atMatch) return;
    const atStart = before.lastIndexOf(atMatch[0]);
    const replacement = tagName + " ";
    // Use native selection + execCommand to preserve undo stack
    textarea.focus();
    textarea.setSelectionRange(atStart, pos);
    document.execCommand("insertText", false, replacement);
    // Sync React state from the updated textarea value
    setRawText(textarea.value);
    setShowDropdown(false);
    setHasRangeSelection(false);
  };

  const handleSend = () => {
    if (!rawText.trim() || disabled || !onSend) return;
    onSend(rawText.trim());
    if (!isControlled) setRawText("");
    setShowDropdown(false);
  };

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setShowDropdown(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  /* ━━━ 포탈 드롭다운 위치 계산 ━━━ */
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showDropdown && flatFiltered.length > 0 && wrapperRef.current) {
      const rect = wrapperRef.current.getBoundingClientRect();
      setDropdownPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    }
  }, [showDropdown, flatFiltered.length, rawText]);

  /* ━━━ @멘션 하이라이트 렌더링 ━━━ */
  const assetColorMap = new Map<string, { color: string; bg: string }>();
  assets.forEach((a) => {
    const tag = a.tag_name.startsWith("@") ? a.tag_name : `@${a.tag_name}`;
    const type = (a.asset_type ?? "character") as AssetType;
    assetColorMap.set(tag, ASSET_COLORS[type] ?? { color: KR, bg: KR_BG });
  });

  const renderHighlightedText = () => {
    if (!rawText) return null;
    // Sort by length DESCENDING before building the alternation so that
    // sibling tags like `@BG_medium` are matched before their parent
    // `@BG`. JS regex alternation matches left-to-right, so without
    // this the shorter `@BG` wins and `_medium` is left as plain text
    // (with our new sibling-asset model this is the common case —
    // every background gets a parent + a handful of `{parent}_{framing}`
    // children that share the same prefix).
    const tags = assets
      .map((a) => (a.tag_name.startsWith("@") ? a.tag_name : `@${a.tag_name}`))
      .sort((a, b) => b.length - a.length);
    if (tags.length === 0) return <span>{rawText}</span>;
    const pattern = new RegExp(`(${tags.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
    const parts = rawText.split(pattern);
    return (
      <>
        {parts.map((part, i) => {
          const colors = assetColorMap.get(part);
          return colors ? (
            <span
              key={i}
              style={{
                display: "inline",
                fontSize: "inherit",
                fontWeight: 600,
                background: colors.bg,
                color: colors.color,
                borderRadius: "3px",
              }}
            >
              {part}
            </span>
          ) : (
            <React.Fragment key={i}>{part}</React.Fragment>
          );
        })}
      </>
    );
  };

  let globalIdx = 0;

  const dropdownEl = showDropdown && flatFiltered.length > 0 && dropdownPos && createPortal(
    <div
      ref={dropdownRef}
      className="rounded border border-border bg-popover shadow-lg overflow-hidden"
      style={{
        position: "fixed",
        top: dropdownPos.top,
        left: dropdownPos.left,
        width: Math.max(288, dropdownPos.width),
        zIndex: 9999,
      }}
    >
      <div className="px-3 py-2 border-b border-border">
        <span className="text-xs font-medium text-muted-foreground">Select Asset</span>
      </div>
      <div className="max-h-52 overflow-y-auto">
        {grouped.map((group) => (
          <div key={group.type}>
            {grouped.length > 1 && (
              <div className="flex items-center gap-1.5 px-3 py-1 bg-muted/40">
                <span className="text-muted-foreground">{TYPE_META[group.type].icon}</span>
                <span className="text-2xs font-semibold text-muted-foreground uppercase tracking-wide">
                  {TYPE_META[group.type].label}
                </span>
              </div>
            )}
            {group.items.map((asset) => {
              const idx = globalIdx++;
              return (
                <AssetDropdownItem
                  key={asset.tag_name}
                  asset={asset}
                  isSelected={idx === selectedIndex}
                  onSelect={() => selectAsset(asset)}
                  onHover={() => setSelectedIndex(idx)}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="px-3 py-2 border-t border-border">
        <span className="text-caption text-muted-foreground/60">+ Add from Assets tab</span>
      </div>
    </div>,
    document.body,
  );

  return (
    <div className="relative flex items-end gap-2" ref={wrapperRef}>
      {!hasRangeSelection && (
        <div
          className="absolute inset-0 pointer-events-none px-3 py-2.5 text-sm leading-relaxed overflow-hidden whitespace-pre-wrap break-words text-foreground"
          style={{ minHeight: minHeight ?? 40, zIndex: 1, userSelect: "none", WebkitUserSelect: "none" }}
          aria-hidden
        >
          {renderHighlightedText()}
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={rawText}
        onChange={handleTextChange}
        onKeyDown={handleKeyDown}
        onSelect={syncSelectionState}
        onMouseUp={syncSelectionState}
        onKeyUp={syncSelectionState}
        onBlur={() => setHasRangeSelection(false)}
        disabled={disabled}
        placeholder={placeholder}
        rows={isControlled ? undefined : 1}
        className={`flex-1 max-h-[120px] resize-none border border-border bg-background px-3 py-2.5 text-sm leading-relaxed text-foreground outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ring-offset-background placeholder:text-muted-foreground/40 disabled:cursor-not-allowed disabled:opacity-50 ${squareCorners ? "rounded-none" : "rounded"}`}
        style={{
          scrollbarWidth: "none",
          minHeight: minHeight ?? 40,
          caretColor: "hsl(var(--foreground))",
          color: hasRangeSelection ? "hsl(var(--foreground))" : "transparent",
          background: "transparent",
        }}
      />
      {!isControlled && (
        <button
          onClick={handleSend}
          disabled={!rawText.trim() || disabled}
          className="w-9 h-9 shrink-0 rounded-lg bg-primary flex items-center justify-center text-primary-foreground disabled:opacity-40 transition-opacity mb-0.5"
        >
          <Send className="w-4 h-4" />
        </button>
      )}
      {dropdownEl}
    </div>
  );
};

export default MentionInput;

/* ━━━━━ MentionTextarea (씬 편집용) ━━━━━ */
export const MentionTextarea: React.FC<{
  assets: Asset[];
  defaultValue: string;
  onDone: (value: string) => void;
  onCancel: () => void;
  rows?: number;
  className?: string;
}> = ({ assets, defaultValue, onDone, onCancel, rows = 3, className = "" }) => {
  const [text, setText] = useState(defaultValue);
  const [showDropdown, setShowDropdown] = useState(false);
  const [dropdownQuery, setDropdownQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const filteredAssets = assets.filter((a) =>
    a.tag_name.replace(/^@/, "").toLowerCase().includes(dropdownQuery.toLowerCase()),
  );

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    const pos = e.target.selectionStart ?? 0;
    setText(val);
    const atMatch = val.slice(0, pos).match(/@([^\s@]*)$/);
    if (atMatch) {
      setDropdownQuery(atMatch[1]);
      setShowDropdown(true);
      setSelectedIndex(0);
    } else {
      setShowDropdown(false);
    }
  };

  const selectAsset = (asset: Asset) => {
    const textarea = ref.current;
    if (!textarea) return;
    const currentVal = textarea.value;
    const pos = textarea.selectionStart ?? currentVal.length;
    const before = currentVal.slice(0, pos);
    const tagName = asset.tag_name.startsWith("@") ? asset.tag_name : `@${asset.tag_name}`;
    const atMatch = before.match(/@[^\s@]*$/);
    if (!atMatch) return;
    const atStart = before.lastIndexOf(atMatch[0]);
    const replacement = tagName + " ";
    textarea.focus();
    textarea.setSelectionRange(atStart, pos);
    document.execCommand("insertText", false, replacement);
    setText(textarea.value);
    setShowDropdown(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showDropdown && filteredAssets.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filteredAssets.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectAsset(filteredAssets[selectedIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowDropdown(false);
        return;
      }
    }
    if (e.key === "Escape" && !showDropdown) onCancel();
  };

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setShowDropdown(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div className="relative">
      <textarea
        ref={ref}
        autoFocus
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          if (!showDropdown) onDone(text);
        }}
        rows={rows}
        className={`w-full bg-background border border-primary rounded-md text-body text-muted-foreground leading-relaxed px-2 py-1 outline-none resize-none ${className}`}
      />
      {showDropdown && filteredAssets.length > 0 && (
        <div
          ref={dropdownRef}
          className="absolute bottom-full left-0 mb-1 w-64 rounded border border-border bg-popover shadow-lg overflow-hidden z-50"
        >
          <div className="max-h-40 overflow-y-auto">
            {filteredAssets.map((asset, idx) => (
              <AssetDropdownItem
                key={asset.tag_name}
                asset={asset}
                isSelected={idx === selectedIndex}
                onSelect={() => selectAsset(asset)}
                onHover={() => setSelectedIndex(idx)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
