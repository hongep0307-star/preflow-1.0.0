import { useState, useRef, useCallback, useEffect } from "react";
import { X, ZoomIn, ZoomOut, RotateCcw } from "lucide-react";
import { useT } from "@/lib/uiLanguage";

export interface CropSettings {
  x: number; // 0-100 object-position x %
  y: number; // 0-100 object-position y %
  scale: number; // 1-3
}

interface Props {
  imageUrl: string;
  initial?: CropSettings | null;
  onSave: (crop: CropSettings) => void;
  onClose: () => void;
}

const PREVIEW_W = 400;
// 대시보드 카드 썸네일은 `aspect-video`(16:9). 프리뷰가 옛 5:3(400×240)로
// 남아 있어 같은 crop 값이라도 프레이밍이 미묘하게 달라 보였다. 카드와 동일한
// 16:9 로 맞춰(400×225) objectPosition/scale 이 1:1 로 매핑되게 한다.
const PREVIEW_H = 225; // 16:9 (= dashboard card aspect-video)
const MIN_SCALE = 1;
const MAX_SCALE = 3;
const STEP = 0.1;

export const ThumbnailCropModal = ({ imageUrl, initial, onSave, onClose }: Props) => {
  const t = useT();
  const [scale, setScale] = useState(initial?.scale ?? 1);
  const [pos, setPos] = useState<{ x: number; y: number }>({
    x: initial?.x ?? 50,
    y: initial?.y ?? 50,
  });
  const dragging = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      const img = imgRef.current;
      if (!img) return;
      const dx = e.clientX - lastMouse.current.x;
      const dy = e.clientY - lastMouse.current.y;
      lastMouse.current = { x: e.clientX, y: e.clientY };

      // 마우스-이미지 1:1 이동을 위해 실제 표시된 이미지 크기 기반으로 %→px 매핑.
      // object-fit: cover 로 natW×natH 를 PREVIEW 에 덮어 맞추고, 거기에 다시
      // transform: scale(scale) 이 걸림. overflow 픽셀 수를 알면 드래그 1px 당
      // object-position 이 얼마나 바뀌어야 하는지 정확히 계산 가능.
      const natW = img.naturalWidth || PREVIEW_W;
      const natH = img.naturalHeight || PREVIEW_H;
      const fit = Math.max(PREVIEW_W / natW, PREVIEW_H / natH);
      const dispW = natW * fit * scale;
      const dispH = natH * fit * scale;
      const overflowX = Math.max(0, dispW - PREVIEW_W);
      const overflowY = Math.max(0, dispH - PREVIEW_H);

      const pctX = overflowX > 0 ? (dx / overflowX) * 100 : 0;
      const pctY = overflowY > 0 ? (dy / overflowY) * 100 : 0;

      setPos((prev) => ({
        x: clamp(prev.x - pctX, 0, 100),
        y: clamp(prev.y - pctY, 0, 100),
      }));
    },
    [scale]
  );

  const handlePointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setScale((prev) => clamp(prev + (e.deltaY > 0 ? -STEP : STEP), MIN_SCALE, MAX_SCALE));
  }, []);

  const reset = () => {
    setScale(1);
    setPos({ x: 50, y: 50 });
  };

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80"
      onClick={onClose}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        className="flex flex-col gap-4 p-5 bg-card border border-border-subtle shadow-lg"
        style={{
          width: PREVIEW_W + 40,
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-foreground">{t("thumbnailCrop.title")}</span>
          <button onClick={onClose} className="p-1 hover:bg-white/10 transition-colors">
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        {/* Preview area */}
        <div
          ref={containerRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onWheel={handleWheel}
          className="relative overflow-hidden mx-auto"
          style={{
            width: PREVIEW_W,
            height: PREVIEW_H,
            cursor: scale > 1 ? "grab" : "default",
            border: "1px solid rgba(255,255,255,0.1)",
            background: "#000",
          }}
        >
          <img
            ref={imgRef}
            src={imageUrl}
            alt={t("thumbnailCrop.previewAlt")}
            draggable={false}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              objectPosition: `${pos.x}% ${pos.y}%`,
              transform: `scale(${scale})`,
              transformOrigin: `${pos.x}% ${pos.y}%`,
              pointerEvents: "none",
              userSelect: "none",
            }}
          />
          {/* Crosshair guides */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              border: "2px solid rgba(255,255,255,0.15)",
            }}
          />
        </div>

        {/* Controls */}
        <div className="flex items-center gap-3 justify-center">
          <button
            onClick={() => setScale((s) => clamp(s - STEP * 2, MIN_SCALE, MAX_SCALE))}
            className="p-1.5 hover:bg-white/10 transition-colors"
            title={t("thumbnailCrop.zoomOut")}
          >
            <ZoomOut className="w-4 h-4 text-muted-foreground" />
          </button>

          <div className="flex items-center gap-2 w-48">
            <input
              type="range"
              min={MIN_SCALE * 100}
              max={MAX_SCALE * 100}
              value={scale * 100}
              onChange={(e) => setScale(Number(e.target.value) / 100)}
              className="w-full accent-primary h-1"
              style={{ cursor: "pointer" }}
            />
            <span className="text-caption text-muted-foreground font-mono w-10 text-right">
              {Math.round(scale * 100)}%
            </span>
          </div>

          <button
            onClick={() => setScale((s) => clamp(s + STEP * 2, MIN_SCALE, MAX_SCALE))}
            className="p-1.5 hover:bg-white/10 transition-colors"
            title={t("thumbnailCrop.zoomIn")}
          >
            <ZoomIn className="w-4 h-4 text-muted-foreground" />
          </button>

          <div className="w-px h-4 bg-white/10" />

          <button
            onClick={reset}
            className="p-1.5 hover:bg-white/10 transition-colors"
            title={t("thumbnailCrop.reset")}
          >
            <RotateCcw className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 h-8 text-xs font-medium text-muted-foreground hover:bg-white/5 border border-white/10 transition-colors"
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={() => onSave({ x: pos.x, y: pos.y, scale })}
            className="px-4 h-8 text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            {t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
};
