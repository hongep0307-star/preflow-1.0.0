import React from "react";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
import { pickCharacterRefUrl, type CharacterRefAsset } from "@/lib/characterSheetStore";
import { useT } from "@/lib/uiLanguage";

/** Minimal asset shape needed to render the @mention hover preview. Both the
 *  agent chat `Asset` and the conti `Asset` are structurally compatible. */
export type MentionPreviewAsset = CharacterRefAsset & {
  asset_type?: string | null;
  ai_description?: string | null;
};

/** Asset-type color config — kept self-contained so this shared preview
 *  doesn't couple the conti and agent modules together. Mirrors ACFG. */
const CFG: Record<string, { color: string; bg: string; bd: string }> = {
  character: { color: "#6366f1", bg: "rgba(99,102,241,0.10)", bd: "rgba(99,102,241,0.22)" },
  item: { color: "#d97706", bg: "rgba(245,158,11,0.10)", bd: "rgba(245,158,11,0.22)" },
  background: { color: "#059669", bg: "rgba(16,185,129,0.10)", bd: "rgba(16,185,129,0.22)" },
};

/**
 * Wraps a mention chip (the agent's or conti's `TagChip`) and, on hover, shows
 * a rich preview: the asset's reference image at its natural aspect ratio
 * (respecting the selected ref mode — original/sheet/board), a type badge, the
 * asset name, and a short description. When neither an image nor description is
 * available, it renders the chip alone (no hover card).
 */
export const AssetMentionHover = ({
  asset,
  name,
  children,
}: {
  asset: MentionPreviewAsset;
  name: string;
  children: React.ReactNode;
}) => {
  const t = useT();
  const type = asset.asset_type || "character";
  const cfg = CFG[type] || CFG.character;
  const typeLabel =
    type === "item" ? t("assets.item") : type === "background" ? t("assets.background") : t("assets.character");
  const previewUrl = pickCharacterRefUrl(asset) ?? asset.photo_url ?? null;

  if (!previewUrl && !asset.ai_description) return <>{children}</>;

  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>
        <span className="cursor-default">{children}</span>
      </HoverCardTrigger>
      <HoverCardContent
        align="start"
        side="top"
        sideOffset={6}
        className="w-auto max-w-[360px] p-1.5 rounded-none border-border bg-popover"
      >
        {previewUrl && (
          <img
            src={previewUrl}
            alt={name}
            loading="lazy"
            decoding="async"
            className="block object-contain"
            style={{
              width: "auto",
              height: "auto",
              maxWidth: 344,
              maxHeight: 440,
              borderRadius: 0,
              border: `2px solid ${cfg.color}`,
            }}
          />
        )}
        <div className="mt-1.5 flex items-center gap-1.5 px-0.5">
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: "0.04em",
              padding: "1px 6px",
              borderRadius: 0,
              lineHeight: 1.6,
              background: cfg.bg,
              color: cfg.color,
              border: `0.5px solid ${cfg.bd}`,
            }}
          >
            {typeLabel}
          </span>
          <span
            style={{ color: cfg.color, fontFamily: "'SF Mono','Fira Code',monospace", fontWeight: 700, fontSize: 11 }}
          >
            {name}
          </span>
        </div>
        {asset.ai_description && (
          <p
            className="mt-1 px-0.5 text-2xs leading-snug text-muted-foreground"
            style={{
              maxWidth: 344,
              display: "-webkit-box",
              WebkitLineClamp: 3,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {asset.ai_description}
          </p>
        )}
      </HoverCardContent>
    </HoverCard>
  );
};
