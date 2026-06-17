import type { ReactNode } from "react";
import { KR, type DirectionMode, type ParsedDirection } from "./agentTypes";

interface Props {
  data: ParsedDirection;
  /** Active confirmed mode (for showing a "선택됨" state). */
  activeMode?: DirectionMode | null;
  /** Fired when the user picks a mode via a card button. */
  onPick: (mode: DirectionMode) => void;
  renderText?: (text: string) => ReactNode;
}

const MODE_FALLBACK: Record<DirectionMode, { title: string; reason: string }> = {
  narrative: { title: "서사 중심", reason: "스토리 구조·감정 흐름을 우선합니다." },
  motion: { title: "모션 연출 중심", reason: "컷 간 트랜지션·시각 에너지를 우선합니다." },
  hybrid: { title: "균형", reason: "서사 척추 + 모션 실행을 균형 있게 가져갑니다." },
};

const MODE_ORDER: DirectionMode[] = ["narrative", "motion", "hybrid"];

export const DirectionCard = ({ data, activeMode, onPick, renderText }: Props) => {
  const render = renderText ?? ((text: string) => text);

  // confirmed-only 펜스(자유채팅 확정)는 카드를 그리지 않는다 — 모드 세팅은
  // AgentTab 이 세그먼트에서 직접 읽어 처리한다.
  if ((!data.options || data.options.length === 0) && data.confirmed) return null;

  const byMode = new Map<DirectionMode, { title?: string; reason?: string }>();
  for (const o of data.options ?? []) if (o?.mode) byMode.set(o.mode, o);
  const modes = MODE_ORDER.filter((m) => byMode.has(m));
  const shown = modes.length ? modes : MODE_ORDER;
  const recommended = data.recommended;

  return (
    <div className="my-2 space-y-2">
      <div className="text-2xs font-bold uppercase tracking-wider text-muted-foreground/70 px-0.5">
        연출 방향 선택
      </div>
      {shown.map((mode) => {
        const opt = byMode.get(mode) ?? {};
        const fb = MODE_FALLBACK[mode];
        const title = opt.title || fb.title;
        const reason = opt.reason || fb.reason;
        const isRec = recommended === mode;
        const isActive = activeMode === mode;
        return (
          <div
            key={mode}
            className="border overflow-hidden"
            style={{
              borderRadius: 0,
              borderColor: isActive ? KR : "rgba(255,255,255,0.07)",
              background: "hsl(var(--elevated))",
            }}
          >
            <div
              className="flex items-center gap-2 px-3 py-2"
              style={{ background: "rgba(249,66,58,0.06)", borderBottom: "1px solid rgba(255,255,255,0.06)" }}
            >
              <span className="text-label font-bold uppercase tracking-wide text-foreground flex-1">
                {render(title)}
              </span>
              {isRec && (
                <span
                  className="text-2xs font-bold uppercase tracking-wider px-1.5 py-0.5 text-white shrink-0"
                  style={{ background: KR, borderRadius: 0 }}
                >
                  추천
                </span>
              )}
            </div>
            <div className="px-3 py-2.5">
              <p className="text-label text-muted-foreground leading-relaxed">{render(reason)}</p>
              <button
                onClick={() => onPick(mode)}
                disabled={isActive}
                className="mt-2.5 flex items-center gap-1 text-2xs font-medium uppercase tracking-wider px-3 py-1.5 transition-opacity hover:opacity-80 disabled:opacity-50"
                style={{
                  background: "rgba(249,66,58,0.1)",
                  color: KR,
                  border: `1px solid rgba(249,66,58,0.2)`,
                  borderRadius: 0,
                }}
              >
                {isActive ? "선택됨" : "이 방향으로 →"}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};
