import { Lightbulb } from "lucide-react";
import { KR } from "./agentTypes";
import type { ReactNode } from "react";
import { useT } from "@/lib/uiLanguage";

export const StrategyCard = ({ content, renderText }: { content: string; renderText?: (text: string) => ReactNode }) => {
  const t = useT();
  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const render = renderText ?? ((text: string) => text);
  return (
    <div
      className="my-2 border overflow-hidden text-left"
      style={{ borderRadius: 0, borderColor: "rgba(255,255,255,0.07)", background: "hsl(var(--elevated))" }}
    >
      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{ background: "rgba(249,66,58,0.06)", borderBottom: "1px solid rgba(255,255,255,0.06)" }}
      >
        <Lightbulb className="w-3.5 h-3.5 shrink-0" style={{ color: KR }} />
        <span className="text-2xs font-bold uppercase tracking-wider" style={{ color: KR }}>
          {t("agent.strategy")}
        </span>
      </div>
      <div className="px-3 py-1">
        {lines.map((line, i) => {
          const ai = line.indexOf("→");
          const st = i < lines.length - 1 ? { borderBottom: "1px solid rgba(255,255,255,0.04)" } : {};
          if (ai !== -1)
            return (
              <div key={i} className="py-2 text-body leading-relaxed" style={st}>
                <span className="block label-meta text-muted-foreground mb-0.5">{render(line.slice(0, ai).trim())}</span>
                <span className="text-foreground/80">{render(line.slice(ai + 1).trim())}</span>
              </div>
            );
          return (
            <div key={i} className="py-2 text-body leading-relaxed text-foreground/60" style={st}>
              {render(line)}
            </div>
          );
        })}
      </div>
    </div>
  );
};
