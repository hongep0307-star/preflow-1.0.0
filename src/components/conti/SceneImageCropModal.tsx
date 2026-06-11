import { useState, useRef, useCallback, useEffect } from "react";
import { ZoomIn, ZoomOut, RotateCcw, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { Scene } from "./contiTypes";
import { useT } from "@/lib/uiLanguage";

export interface CropState {
  x: number;
  y: number;
  scale: number;
}

interface Props {
  scene: Scene;
  onClose: () => void;
  onSaved: (sceneId: string, crop: CropState) => void;
}

const PREVIEW_W = 480;
const PREVIEW_H = 320;
const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const STEP = 0.05;
import { KR } from "@/lib/brand";

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export const SceneImageCropModal = ({ scene, onClose, onSaved }: Props) => {
  const t = useT();
  const initial = (scene.conti_image_crop as CropState | null) ?? { x: 50, y: 50, scale: 1 };
  const [crop, setCrop] = useState<CropState>(initial);
  const dragging = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const [saving, setSaving] = useState(false);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - lastMouse.current.x;
      const dy = e.clientY - lastMouse.current.y;
      lastMouse.current = { x: e.clientX, y: e.clientY };
      const factor = 1 / Math.max(crop.scale - 0.5, 0.3);
      const pctX = (dx / PREVIEW_W) * 100 * factor;
      const pctY = (dy / PREVIEW_H) * 100 * factor;
      setCrop((prev) => ({
        ...prev,
        x: clamp(prev.x - pctX, 0, 100),
        y: clamp(prev.y - pctY, 0, 100),
      }));
    },
    [crop.scale]
  );

  const handlePointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setCrop((prev) => ({
      ...prev,
      scale: clamp(prev.scale + (e.deltaY > 0 ? -STEP : STEP), MIN_SCALE, MAX_SCALE),
    }));
  }, []);

  const reset = () => setCrop({ x: 50, y: 50, scale: 1 });

  const handleApply = async () => {
    setSaving(true);
    await supabase.from("scenes").update({ conti_image_crop: crop as any }).eq("id", scene.id);
    onSaved(scene.id, crop);
    setSaving(false);
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const imgUrl = scene.conti_image_url;
  if (!imgUrl) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex flex-col gap-4 rounded-none border border-border-subtle bg-card p-5 shadow-lg"
        style={{ width: PREVIEW_W + 40 }}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-foreground">{t("conti.adjustImage")}</span>
          <button onClick={onClose} className="p-1 hover:bg-foreground/10 transition-colors">
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        {/* Preview */}
        <div
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onWheel={handleWheel}
          className="relative overflow-hidden mx-auto"
          style={{
            width: PREVIEW_W,
            height: PREVIEW_H,
            cursor: crop.scale > 1 ? "grab" : "default",
            border: "1px solid hsl(var(--border-subtle))",
            backgroundColor: "hsl(var(--background))",
            backgroundImage: `url(${imgUrl})`,
            backgroundSize: `${Math.round(crop.scale * 100)}%`,
            backgroundPosition: `${crop.x}% ${crop.y}%`,
            backgroundRepeat: "no-repeat",
          }}
        />

        {/* Scale slider */}
        <div className="flex items-center gap-3 justify-center">
          <button
            onClick={() => setCrop((c) => ({ ...c, scale: clamp(c.scale - STEP * 2, MIN_SCALE, MAX_SCALE) }))}
            className="p-1.5 hover:bg-white/10 transition-colors"
          >
            <ZoomOut className="w-4 h-4 text-muted-foreground" />
          </button>

          <div className="flex items-center gap-2 w-48">
            <input
              type="range"
              min={MIN_SCALE * 100}
              max={MAX_SCALE * 100}
              value={crop.scale * 100}
              onChange={(e) => setCrop((c) => ({ ...c, scale: Number(e.target.value) / 100 }))}
              className="w-full h-1"
              style={{ cursor: "pointer", accentColor: KR }}
            />
            <span className="text-caption text-muted-foreground font-mono w-10 text-right">
              {Math.round(crop.scale * 100)}%
            </span>
          </div>

          <button
            onClick={() => setCrop((c) => ({ ...c, scale: clamp(c.scale + STEP * 2, MIN_SCALE, MAX_SCALE) }))}
            className="p-1.5 hover:bg-white/10 transition-colors"
          >
            <ZoomIn className="w-4 h-4 text-muted-foreground" />
          </button>

          <div className="w-px h-4 bg-white/10" />

          <button onClick={reset} className="p-1.5 hover:bg-white/10 transition-colors" title={t("conti.reset")}>
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
            onClick={handleApply}
            disabled={saving}
            className="px-4 h-8 text-xs font-medium text-white hover:opacity-90 transition-colors disabled:opacity-50"
            style={{ background: KR }}
          >
            {saving ? t("common.saving") : t("conti.apply")}
          </button>
        </div>
      </div>
    </div>
  );
};
