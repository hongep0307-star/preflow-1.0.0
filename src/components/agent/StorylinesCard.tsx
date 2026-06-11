import { KR } from "./agentTypes";
import type { StorylineOption } from "./prompts";
import type { ReactNode } from "react";
import { useT } from "@/lib/uiLanguage";

interface Props {
  options: StorylineOption[];
  onSelect: (text: string) => void;
  renderText?: (text: string) => ReactNode;
}

export const StorylinesCard = ({ options, onSelect, renderText }: Props) => {
  const t = useT();
  const render = renderText ?? ((text: string) => text);
  return (
    <div className="my-2 space-y-2">
      {options.map((opt, i) => {
        const label = opt.id || String.fromCharCode(65 + i);
        return (
          <div
            key={opt.id ?? i}
            className="border overflow-hidden"
            style={{ borderRadius: 0, borderColor: "rgba(255,255,255,0.07)", background: "hsl(var(--elevated))" }}
          >
            <div
              className="flex items-center gap-2 px-3 py-2"
              style={{ background: "rgba(249,66,58,0.06)", borderBottom: "1px solid rgba(255,255,255,0.06)" }}
            >
              <span
                className="text-2xs font-bold w-5 h-5 flex items-center justify-center text-white shrink-0"
                style={{ background: KR, borderRadius: 0 }}
              >
                {label}
              </span>
              <span className="text-label font-bold uppercase tracking-wide text-foreground flex-1">{render(opt.title)}</span>
              {opt.mood && (
                <span className="font-mono text-caption text-muted-foreground/50 shrink-0 uppercase">{render(opt.mood)}</span>
              )}
            </div>
            <div className="px-3 py-2.5">
              <p className="text-label text-muted-foreground leading-relaxed">{render(opt.synopsis)}</p>
              <button
                onClick={() => onSelect(`${label}안 "${opt.title}" 선택합니다.`)}
                className="mt-2.5 flex items-center gap-1 text-2xs font-medium uppercase tracking-wider px-3 py-1.5 transition-opacity hover:opacity-80"
                style={{
                  background: "rgba(249,66,58,0.1)",
                  color: KR,
                  border: `1px solid rgba(249,66,58,0.2)`,
                  borderRadius: 0,
                }}
              >
                {t("agent.selectArrow")}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};
