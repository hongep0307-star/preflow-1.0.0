/**
 * Library 툴바 Color 칩의 picker.
 *
 * Eagle 의 1번 스크린샷 popover 와 거의 동일한 구성:
 *   ┌─────────────────────────────┐
 *   │  ┌──────────────┐ ┌─┐       │
 *   │  │  SV square   │ │H│       │
 *   │  └──────────────┘ └─┘       │
 *   │  [프리셋 swatch grid 14 개]  │
 *   │  [mini swatch] [#hex input] │
 *   │  [Clear color filter]       │
 *   └─────────────────────────────┘
 *
 * 외부 라이브러리 없이 순수 React + Tailwind. 드래그는 pointer events
 * + setPointerCapture 로 popover 밖으로 마우스가 빠져나가도 안정적.
 *
 * 상태 모델: 내부적으로 HSV 를 진실의 원천으로 들고 있고, 외부엔 hex 만
 * 노출한다. value(prop) 가 바뀌면 hex → HSV 역산해 picker 핸들 위치를
 * 동기화. 사용자 입력은 HSV 갱신 + hex onChange 의 두 흐름이 동시에 발생.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface ColorPickerProps {
  /** 현재 선택된 hex. 필터가 비활성이면 null. */
  value: string | null;
  /** 사용자가 색을 바꾸면 호출. null = clear (현재 picker 안에서 직접
   *  발신하지 않지만, 같은 핸들러를 toolbar 의 chip 에서도 쓰기 위해
   *  signature 통일). */
  onChange: (next: string | null) => void;
  /** Clear 버튼 표시 여부. 기본 true. 노트 텍스트 색처럼 *항상 값이 필요한*
   *  필드에서 false 로 두면 "비우기" 옵션 자체가 사라진다. 필터 컨텍스트에서는
   *  기본값 그대로 사용. */
  allowClear?: boolean;
  /** Clear 버튼 라벨 커스텀. 기본 "Clear color filter". 노트 배경에선 "투명" 등.
   *  null 도 같은 onChange(null) 시그널을 발신하므로 caller 가 의미를 해석. */
  clearLabel?: string;
  /** Clear 슬롯(좌상단 사선 패턴)을 프리셋 1열 첫 칸으로 같이 보여줄지.
   *  기본 true (라이브러리 필터 호환). 노트 텍스트(allowClear=false)에서는
   *  자동으로 false 처리 — 다른 프리셋이 한 칸 옆으로 옮긴다. */
  showClearPreset?: boolean;
}

interface Hsv {
  h: number; // 0..360
  s: number; // 0..1
  v: number; // 0..1
}

/* ───────────────── HSV ↔ RGB ↔ Hex (picker 내부 한정) ─────────────────
 * colorMatch.ts 가 LAB 만 다루므로 여기에서 자체 HSV 변환을 따로 갖는다.
 * picker UI 만 쓰는 좁은 변환이라 외부 export 하지 않음. */

function hsvToRgb({ h, s, v }: Hsv): { r: number; g: number; b: number } {
  const c = v * s;
  const hh = (h % 360) / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hh >= 0 && hh < 1) [r, g, b] = [c, x, 0];
  else if (hh < 2) [r, g, b] = [x, c, 0];
  else if (hh < 3) [r, g, b] = [0, c, x];
  else if (hh < 4) [r, g, b] = [0, x, c];
  else if (hh < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = v - c;
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

function rgbToHsv(r: number, g: number, b: number): Hsv {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  const v = max;
  return { h, s, v };
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
  return `#${c.toString(16).padStart(6, "0")}`;
}

function hexToRgbLocal(hex: string): { r: number; g: number; b: number } | null {
  const clean = hex.trim().replace(/^#/, "");
  if (clean.length !== 6) return null;
  const num = Number.parseInt(clean, 16);
  if (!Number.isFinite(num)) return null;
  return { r: (num >> 16) & 0xff, g: (num >> 8) & 0xff, b: num & 0xff };
}

function hexFromHsv(hsv: Hsv): string {
  const { r, g, b } = hsvToRgb(hsv);
  return rgbToHex(r, g, b);
}

/* ───────────────── 프리셋 swatch ─────────────────
 * Eagle 의 14개 프리셋과 동일한 톤. 행 1: 중성색(투명/짙은회색/검정/흰색/회색/
 * 갈색/핑크), 행 2: 채도색(빨/주/노/초/청록/파/보). "투명" 은 라이브러리
 * 컬러 필터에서는 의미가 모호해(매칭 불가) 대신 "색 없음 = 필터 끔" 의
 * 의미로 둔다 — 클릭하면 onChange(null) 발신. */
const PRESET_ROWS: ReadonlyArray<ReadonlyArray<{ hex: string | null; label: string }>> = [
  [
    { hex: null, label: "Clear" },
    { hex: "#3a3a3a", label: "Dark gray" },
    { hex: "#1f1f1f", label: "Black" },
    { hex: "#e6e6e6", label: "White" },
    { hex: "#9aa0a6", label: "Gray" },
    { hex: "#a47551", label: "Brown" },
    { hex: "#e6a4b4", label: "Pink" },
  ],
  [
    { hex: "#e53935", label: "Red" },
    { hex: "#fb8c00", label: "Orange" },
    { hex: "#fdd835", label: "Yellow" },
    { hex: "#43a047", label: "Green" },
    { hex: "#26a69a", label: "Teal" },
    { hex: "#1e88e5", label: "Blue" },
    { hex: "#7e57c2", label: "Purple" },
  ],
];

/* ───────────────── 드래그 가능한 평면 / 슬라이더 공용 hook ───────────────── */

type Pt = { x: number; y: number };

function usePointerDrag(onMove: (pt: Pt, rect: DOMRect) => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const compute = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
      const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
      onMove({ x, y }, rect);
    },
    [onMove],
  );

  const handlers = {
    ref,
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      draggingRef.current = true;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* setPointerCapture 가 일부 환경에서 throw 할 수 있음 — 무시 */
      }
      compute(event);
    },
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      compute(event);
    },
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {
      draggingRef.current = false;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        /* noop */
      }
    },
    onPointerCancel: () => {
      draggingRef.current = false;
    },
  };

  return handlers;
}

/* ───────────────── 메인 컴포넌트 ───────────────── */

export function ColorPicker({
  value,
  onChange,
  allowClear = true,
  clearLabel,
  showClearPreset = true,
}: ColorPickerProps) {
  // 외부 value 가 바뀌면 hsv 동기화. 직접 입력 흐름과 충돌하지 않도록
  // value 변화에만 의존.
  const initialHsv = useMemo<Hsv>(() => {
    if (!value) return { h: 210, s: 0.6, v: 0.95 };
    const rgb = hexToRgbLocal(value);
    if (!rgb) return { h: 210, s: 0.6, v: 0.95 };
    return rgbToHsv(rgb.r, rgb.g, rgb.b);
  }, [value]);

  const [hsv, setHsv] = useState<Hsv>(initialHsv);
  const [hexInput, setHexInput] = useState<string>(value ?? "");

  // value(외부) → 내부 동기화. 사용자가 toolbar 에서 clear 했을 때 등.
  useEffect(() => {
    if (!value) {
      setHexInput("");
      return;
    }
    setHexInput(value);
    const rgb = hexToRgbLocal(value);
    if (rgb) setHsv(rgbToHsv(rgb.r, rgb.g, rgb.b));
  }, [value]);

  // hsv → emit. picker 내부에서 hsv 가 바뀔 때만 외부 onChange. 외부 value
  // 가 새로 들어와 hsv 가 갱신된 경우와 구분하기 위해 "hex 가 달라졌을 때"
  // 만 emit.
  const emit = useCallback(
    (next: Hsv) => {
      const hex = hexFromHsv(next);
      setHsv(next);
      setHexInput(hex);
      if (hex !== (value ?? "")) onChange(hex);
    },
    [onChange, value],
  );

  /* SV square 드래그. x/width = saturation, y/height = 1 - value. */
  const svDrag = usePointerDrag((pt, rect) => {
    const s = rect.width === 0 ? 0 : pt.x / rect.width;
    const v = rect.height === 0 ? 0 : 1 - pt.y / rect.height;
    emit({ ...hsv, s: Math.max(0, Math.min(1, s)), v: Math.max(0, Math.min(1, v)) });
  });

  /* 휴 스트립 드래그. y/height = hue 0..360. */
  const hueDrag = usePointerDrag((pt, rect) => {
    const ratio = rect.height === 0 ? 0 : pt.y / rect.height;
    const h = Math.max(0, Math.min(360, ratio * 360));
    emit({ ...hsv, h });
  });

  /* hex 입력 — 6자리가 채워지면 반영. 입력 중간(짧거나 비-hex 문자) 은
   *  무시하고 사용자가 자유롭게 타이핑할 수 있게 둔다. */
  const handleHexChange = (raw: string) => {
    setHexInput(raw);
    const trimmed = raw.trim().replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(trimmed)) return;
    const rgb = hexToRgbLocal(trimmed);
    if (!rgb) return;
    const next = rgbToHsv(rgb.r, rgb.g, rgb.b);
    setHsv(next);
    const hex = `#${trimmed.toLowerCase()}`;
    if (hex !== (value ?? "")) onChange(hex);
  };

  const handlePresetClick = (hex: string | null) => {
    if (!hex) {
      onChange(null);
      return;
    }
    const rgb = hexToRgbLocal(hex);
    if (!rgb) return;
    setHsv(rgbToHsv(rgb.r, rgb.g, rgb.b));
    setHexInput(hex);
    onChange(hex);
  };

  const currentHex = value ?? hexFromHsv(hsv);
  const hueColor = hexFromHsv({ h: hsv.h, s: 1, v: 1 });

  return (
    <div className="flex flex-col gap-2 p-2" style={{ width: 232 }}>
      {/* SV square + Hue strip ─ Eagle 1번 스크린샷 그대로 가로 정렬. */}
      <div className="flex gap-2">
        <div
          {...svDrag}
          className="relative h-[140px] flex-1 cursor-crosshair touch-none border border-border-subtle"
          style={{
            // saturation gradient(흰→포화색) 위에 value gradient(투명→검정).
            // hue 가 바뀌면 backgroundColor 만 갱신되어 두 그라디언트가 자연스럽게
            // 따라온다.
            backgroundColor: hueColor,
            backgroundImage:
              "linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)",
          }}
        >
          {/* 현재 위치 핸들 — 흰 외곽 + 검은 외곽으로 어떤 배경에서도 보이게. */}
          <div
            className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
            style={{
              left: `${hsv.s * 100}%`,
              top: `${(1 - hsv.v) * 100}%`,
            }}
          />
        </div>
        <div
          {...hueDrag}
          className="relative h-[140px] w-3 cursor-ns-resize touch-none border border-border-subtle"
          style={{
            backgroundImage:
              "linear-gradient(to bottom, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)",
          }}
        >
          <div
            className="pointer-events-none absolute -left-0.5 -right-0.5 h-1 -translate-y-1/2 border border-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
            style={{ top: `${(hsv.h / 360) * 100}%` }}
          />
        </div>
      </div>

      {/* 프리셋 swatch grid — 두 행 × 7 열. showClearPreset=false 일 때는
          첫 행의 "Clear" 슬롯을 제외하고 한 칸 줄여 표시한다 (노트 텍스트). */}
      <div className="flex flex-col gap-1">
        {PRESET_ROWS.map((row, rowIdx) => {
          const visibleRow = showClearPreset ? row : row.filter((p) => p.hex !== null);
          return (
            <div key={rowIdx} className="flex gap-1">
              {visibleRow.map((preset, colIdx) => {
                const isActive =
                  preset.hex !== null &&
                  value != null &&
                  preset.hex.toLowerCase() === value.toLowerCase();
                return (
                  <button
                    key={`${rowIdx}_${colIdx}_${preset.hex ?? "clear"}`}
                    type="button"
                    title={preset.label}
                    onClick={() => handlePresetClick(preset.hex)}
                    className={cn(
                      "relative h-6 w-6 border border-border-subtle transition-transform hover:scale-110",
                      isActive && "ring-2 ring-primary ring-offset-1 ring-offset-background",
                    )}
                    style={{
                      background:
                        preset.hex ??
                        // "Clear" 슬롯 — 대각선 사선으로 "비어 있음" 표시.
                        "repeating-linear-gradient(45deg, transparent 0 4px, var(--border-subtle, #555) 4px 5px)",
                      borderRadius: 0,
                    }}
                  />
                );
              })}
            </div>
          );
        })}
      </div>

      {/* mini swatch + hex input. mini swatch 클릭은 의도적으로 noop —
          현재 색 미리보기 전용. */}
      <div className="flex items-center gap-1.5 border border-border-subtle bg-background px-1.5 py-1">
        <span
          className="h-4 w-4 flex-shrink-0 border border-border-subtle"
          style={{ background: value ? currentHex : "transparent", borderRadius: 0 }}
          title={value ?? "No color filter"}
        />
        <input
          type="text"
          value={hexInput}
          onChange={(event) => handleHexChange(event.target.value)}
          placeholder="#FFFFFF"
          spellCheck={false}
          className="h-5 flex-1 bg-transparent font-mono text-caption uppercase outline-none placeholder:text-muted-foreground"
        />
      </div>

      {allowClear && value ? (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="border-t border-border-subtle px-2 py-1.5 text-left text-caption text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {clearLabel ?? "Clear color filter"}
        </button>
      ) : null}
    </div>
  );
}
