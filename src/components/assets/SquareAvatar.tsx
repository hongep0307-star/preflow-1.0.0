import { memo } from "react";
import { type FocalPoint, KR } from "./types";

interface Props {
  url: string | null;
  focal: FocalPoint;
  name: string;
  /** "circle" (default) is the round portrait frame for the original photo.
   *  "fill" shows the image edge-to-edge in a 16:9 box (for sheet/board). */
  variant?: "circle" | "fill";
}

export const SquareAvatar = memo(function SquareAvatar({
  url,
  focal,
  name,
  variant = "circle",
}: Props) {
  if (variant === "fill") {
    return (
      <div
        className="w-full overflow-hidden"
        style={{ aspectRatio: "16 / 9", background: "hsl(var(--elevated))" }}
      >
        {url ? (
          <img src={url} alt={name} className="w-full h-full object-contain" />
        ) : (
          <div
            className="w-full h-full flex items-center justify-center text-white font-bold text-3xl"
            style={{ background: KR }}
          >
            {name.charAt(0)}
          </div>
        )}
      </div>
    );
  }

  return (
  // Same 16:9 footprint as the "fill" variant so the text below every card
  // lines up at the same height regardless of original/sheet/board.
  <div
    className="w-full flex items-center justify-center"
    style={{ aspectRatio: "16 / 9" }}
  >
    <div
      className="rounded-full overflow-hidden group-hover:ring-2 group-hover:ring-primary/40 transition-all"
      // 20% smaller than before (was 92%); the 16:9 container height is
      // unchanged so the text below the thumbnail stays put.
      style={{ height: "74%", aspectRatio: "1 / 1", background: "hsl(var(--elevated))" }}
    >
      {url ? (
        <div
          className="w-full h-full"
          style={{
            backgroundImage: `url(${url})`,
            backgroundSize: `${Math.round((focal.scale ?? 1.4) * 100)}%`,
            backgroundPosition: `${focal.x}% ${focal.y}%`,
          }}
        />
      ) : (
        <div
          className="w-full h-full flex items-center justify-center text-white font-bold text-3xl"
          style={{ background: KR }}
        >
          {name.charAt(0)}
        </div>
      )}
    </div>
  </div>
  );
});
