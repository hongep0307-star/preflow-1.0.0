import { useRef, useState } from "react";
import { ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/uiLanguage";
import { type FocalPoint, KR } from "./types";

interface Props {
  url: string;
  initial: FocalPoint;
  onSave: (p: FocalPoint) => void;
  onClose: () => void;
}

export const FocalEditor = ({ url, initial, onSave, onClose }: Props) => {
  const t = useT();
  const [pos, setPos] = useState<FocalPoint>(initial);
  const [scale, setScale] = useState<number>(initial.scale ?? 1.4);
  const dragging = useRef(false);
  const last = useRef({ x: 0, y: 0 });

  const onDown = (e: React.MouseEvent | React.TouchEvent) => {
    dragging.current = true;
    const pt = "touches" in e ? e.touches[0] : e;
    last.current = { x: pt.clientX, y: pt.clientY };
  };
  const onMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (!dragging.current) return;
    const pt = "touches" in e ? e.touches[0] : e;
    const dx = pt.clientX - last.current.x,
      dy = pt.clientY - last.current.y;
    last.current = { x: pt.clientX, y: pt.clientY };
    setPos((p) => ({
      ...p,
      x: Math.max(0, Math.min(100, p.x - dx * 0.3)),
      y: Math.max(0, Math.min(100, p.y - dy * 0.3)),
    }));
  };
  const onUp = () => {
    dragging.current = false;
  };

  const bsz = `${Math.round(scale * 100)}%`;
  const fillPct = ((scale * 100 - 80) / (300 - 80)) * 100;
  const trackStyle = {
    background: `linear-gradient(to right, ${KR} 0%, ${KR} ${fillPct}%, #e2e2e2 ${fillPct}%, #e2e2e2 100%)`,
    accentColor: KR,
    height: "4px",
    borderRadius: "2px",
    outline: "none",
    border: "none",
    cursor: "pointer",
    WebkitAppearance: "none" as const,
    appearance: "none" as const,
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
      onClick={onClose}
    >
      <div className="bg-card rounded-none border border-border-subtle p-6 w-80 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <p className="text-sm font-semibold text-foreground mb-1">{t("assets.focal.title")}</p>
        <p className="text-xs text-muted-foreground mb-4">{t("assets.focal.hint")}</p>
        <div className="flex justify-center mb-4">
          <div
            className="w-44 h-44 rounded-full overflow-hidden cursor-grab active:cursor-grabbing select-none"
            style={{
              backgroundImage: `url(${url})`,
              backgroundSize: bsz,
              backgroundPosition: `${pos.x}% ${pos.y}%`,
              outline: `2px solid ${KR}`,
            }}
            onMouseDown={onDown}
            onMouseMove={onMove}
            onMouseUp={onUp}
            onMouseLeave={onUp}
            onTouchStart={onDown}
            onTouchMove={onMove}
            onTouchEnd={onUp}
          />
        </div>
        <div className="mb-5">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-meta text-muted-foreground">{t("assets.focal.size")}</span>
            <span className="text-meta font-medium" style={{ color: KR }}>
              {Math.round(scale * 100)}%
            </span>
          </div>
          <div className="flex items-center gap-2">
            <ZoomOut className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <input
              type="range"
              min={80}
              max={300}
              value={Math.round(scale * 100)}
              onChange={(e) => setScale(Number(e.target.value) / 100)}
              className="flex-1"
              style={trackStyle}
            />
            <ZoomIn className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          </div>
        </div>
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            className="text-white"
            style={{ background: KR }}
            onClick={() => {
              onSave({ ...pos, scale });
              onClose();
            }}
          >
            {t("common.apply")}
          </Button>
        </div>
      </div>
    </div>
  );
};
