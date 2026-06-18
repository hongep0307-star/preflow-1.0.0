import React, { useEffect, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import {
  KR,
  type Asset,
  type DirectionMode,
  type MessageSegment,
  parseMessageSegments,
  resolveAsset,
} from "./agentTypes";
import { TagChip } from "./AgentSceneCards";
import { AssetMentionHover } from "@/components/AssetMentionHover";
import { isBriefAnalysisMsg } from "./prompts";
import { BriefAnalysisCard } from "./BriefAnalysisCard";
import { StorylinesCard } from "./StorylinesCard";
import { DirectionCard } from "./DirectionCard";
import { StrategyCard } from "./StrategyCard";
import { useT } from "@/lib/uiLanguage";

interface Props {
  content: string;
  assets: Asset[];
  onSend?: (text: string) => void;
  segments?: MessageSegment[];
  /** Direction-mode pick handler (DirectionCard buttons). */
  onPickDirection?: (mode: DirectionMode) => void;
  /** Currently confirmed direction mode (for the card's selected state). */
  activeDirectionMode?: DirectionMode | null;
  /** 방금 완료된 메시지면 true — 긴 본문이라도 접지 않고 펼친 채로 시작한다. */
  defaultOpen?: boolean;
}

const normalizeShotRefs = (text: string) => text.replace(/#(\d{1,2})(?!\d)/g, (_, n) => `#${String(n).padStart(2, "0")}`);

// GPT 계열은 CJK 본문에서 전각 문장부호(＠ ＿ －)를 섞어 내보내는 경우가 있어,
// 멘션 정규식(@[\w가-힣-]+)이 통째로 놓치게 된다. 칩 변환 직전에 ASCII 로 정규화한다.
const normalizeMentions = (text: string) =>
  text
    .replace(/\uFF20/g, "@") // ＠ → @
    .replace(/\uFF3F/g, "_") // ＿ → _
    .replace(/\uFF0D/g, "-"); // － → -

// 긴 자유 대화 본문은 기본적으로 접어서 "벽 같은 텍스트" 를 줄인다.
// 임계치를 넘는 본문만 max-height + 하단 페이드로 클램프하고 더보기/접기 토글을 노출.
const PROSE_COLLAPSE_CHARS = 700;

const ProseBlock = ({
  source,
  components,
  defaultOpen = false,
}: {
  source: string;
  components: Components;
  defaultOpen?: boolean;
}) => {
  const t = useT();
  const collapsible = source.length > PROSE_COLLAPSE_CHARS;
  const [open, setOpen] = useState(defaultOpen);
  // 부모가 펼침 여부를 바꾸면(완료 직후 true → 탭 복귀 시 false) 동기화한다.
  // 탭 전환은 컴포넌트가 언마운트되지 않아 초기 useState 값만으로는 반영되지 않는다.
  useEffect(() => {
    setOpen(defaultOpen);
  }, [defaultOpen]);
  const clamp = collapsible && !open;
  return (
    <div className="relative">
      <div
        className={clamp ? "overflow-hidden" : undefined}
        style={
          clamp
            ? {
                maxHeight: 220,
                WebkitMaskImage: "linear-gradient(to bottom, black 62%, transparent)",
                maskImage: "linear-gradient(to bottom, black 62%, transparent)",
              }
            : undefined
        }
      >
        <ReactMarkdown components={components}>{source}</ReactMarkdown>
      </div>
      {collapsible && (
        <button
          onClick={() => setOpen((o) => !o)}
          className="mt-1 text-2xs font-bold uppercase tracking-wider px-2 py-1 transition-opacity hover:opacity-80"
          style={{ color: KR, background: "rgba(249,66,58,0.08)", border: "1px solid rgba(249,66,58,0.2)", borderRadius: 0 }}
        >
          {open ? t("agent.showLess") : t("agent.showMore")}
        </button>
      )}
    </div>
  );
};

/** 채팅 본문의 @멘션 칩 — hover 시 에셋 썸네일(원본 비율, 큼직하게) + 이름/설명
 *  프리뷰를 띄운다. 썸네일/설명이 둘 다 없으면 칩만 렌더한다. */
const MentionChip = ({ asset, name }: { asset: Asset; name: string }) => (
  <AssetMentionHover asset={asset} name={name}>
    <TagChip name={name} assetType={asset.asset_type || "character"} />
  </AssetMentionHover>
);

export const MessageContent = ({
  content,
  assets,
  onSend,
  segments: preSegments,
  onPickDirection,
  activeDirectionMode,
  defaultOpen = false,
}: Props) => {
  const t = useT();
  if (isBriefAnalysisMsg(content)) return <BriefAnalysisCard content={content} />;
  const segments = preSegments ?? parseMessageSegments(content);
  const renderWithTags = (text: string): React.ReactNode =>
    normalizeMentions(normalizeShotRefs(text)).split(/(@[\w가-힣-]+)/g).map((p, i) => {
      if (/^@[\w가-힣-]+$/.test(p)) {
        const resolved = resolveAsset(p, assets);
        if (resolved) {
          const clean = p.slice(1);
          const suffix = clean.slice(resolved.name.length);
          return (
            <React.Fragment key={i}>
              <MentionChip asset={resolved.asset} name={resolved.name} />
              {suffix}
            </React.Fragment>
          );
        }
      }
      return <span key={i}>{p}</span>;
    });

  // 마크다운 인라인 노드(굵게/기울임/헤더/인용구 등) 안에 들어간 @멘션도 칩으로
  // 변환되도록, 문자열 자식은 renderWithTags 로 처리하고 엘리먼트 자식은 재귀한다.
  // (이전 구현은 p·li 의 "직접 문자열 자식" 만 처리해서, GPT 처럼 태그를
  //  **굵게**/헤더 안에 넣는 출력은 칩 변환을 통째로 놓쳤다.)
  const processChildren = (children: React.ReactNode): React.ReactNode =>
    React.Children.map(children, (child, i) => {
      if (typeof child === "string") return <React.Fragment key={i}>{renderWithTags(child)}</React.Fragment>;
      if (React.isValidElement(child) && (child.props as { children?: React.ReactNode })?.children != null) {
        return React.cloneElement(
          child,
          undefined,
          processChildren((child.props as { children?: React.ReactNode }).children),
        );
      }
      return child;
    });
  const markdownComponents: Components = {
    // 헤더는 앞 단락과 시각적으로 끊어지도록 위쪽 여백을 크게 줘서 "섹션" 으로 묶이게 한다.
    h1: ({ children }) => (
      <h1 className="text-heading font-bold text-foreground mt-9 mb-2.5 first:mt-0">{processChildren(children)}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="text-subhead font-bold text-foreground mt-9 mb-2 first:mt-0">{processChildren(children)}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="text-title font-bold text-foreground mt-8 mb-2 first:mt-0 flex items-center gap-1.5">
        <span className="inline-block w-1 h-3.5 shrink-0" style={{ background: KR }} />
        {processChildren(children)}
      </h3>
    ),
    code: ({ children }) => (
      <code className="bg-background/50 px-1 py-0.5 rounded-none text-body font-mono text-muted-foreground">
        {children}
      </code>
    ),
    strong: ({ children }) => <strong className="font-bold text-foreground">{processChildren(children)}</strong>,
    em: ({ children }) => <em>{processChildren(children)}</em>,
    p: ({ children }) => (
      <p className="text-label leading-[1.75] mb-3.5 last:mb-0 text-foreground/80">{processChildren(children)}</p>
    ),
    ul: ({ children }) => (
      <ul className="list-disc pl-4 my-3 space-y-2.5 marker:text-[#f9423a]/70">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="list-decimal pl-4 my-3 space-y-2.5 marker:text-[#f9423a]/70 marker:font-bold">{children}</ol>
    ),
    li: ({ children }) => (
      <li className="text-label leading-[1.65] text-foreground/80 pl-1 [&>p]:mb-1 [&>ul]:my-1 [&>ul]:space-y-1 [&>ol]:my-1 [&>ol]:space-y-1">
        {processChildren(children)}
      </li>
    ),
    hr: () => <hr className="border-border/30 my-4" />,
    blockquote: ({ children }) => (
      <blockquote
        className="my-2 px-3 py-2 text-label font-medium text-foreground/90 not-italic"
        style={{ borderLeft: `3px solid ${KR}`, background: "rgba(249,66,58,0.07)", borderRadius: 0 }}
      >
        {processChildren(children)}
      </blockquote>
    ),
  };

  return (
    <div className="space-y-2">
      {segments.map((seg, i) => {
        if (seg.type === "strategy") return <StrategyCard key={i} content={seg.content} renderText={renderWithTags} />;
        if (seg.type === "direction") {
          if (!seg.data) return null;
          return (
            <DirectionCard
              key={i}
              data={seg.data}
              activeMode={activeDirectionMode}
              onPick={(m) => onPickDirection?.(m)}
              renderText={renderWithTags}
            />
          );
        }
        if (seg.type === "storylines")
          return <StorylinesCard key={i} options={seg.options} onSelect={(t) => onSend?.(t)} renderText={renderWithTags} />;
        if (seg.type === "scene") return null;
        // The production spec is consumed as draft state (and persisted on the
        // version), not rendered inline in the chat bubble.
        if (seg.type === "spec") return null;
        if (seg.type === "scene_alt") {
          const d = seg.data;
          if (!d) return null;
          return (
            <div
              key={i}
              className="my-2 px-3 py-2 border bg-card/40"
              style={{ borderRadius: 0, borderColor: "rgba(96,165,250,0.25)" }}
            >
              <div className="flex items-baseline gap-2 mb-0.5">
                <span className="font-mono text-2xs text-blue-300">
                  #{String(d.scene_number).padStart(2, "0")} · {t("agent.variantFallback", { label: d.variant || "B" })}
                </span>
                {d.title && <span className="text-meta font-semibold text-foreground/90">{d.title}</span>}
              </div>
              {d.description && <p className="text-meta leading-relaxed text-foreground/80">{renderWithTags(d.description)}</p>}
              {d.rationale && (
                <p className="mt-1 font-mono text-2xs text-muted-foreground">{t("agent.rationale")} {renderWithTags(d.rationale)}</p>
              )}
            </div>
          );
        }
        if (seg.type === "scene_audit") {
          const d = seg.data;
          if (!d) return null;
          const score = (k: "A" | "B" | "C" | "D") => {
            const v = d.abcd?.[k];
            if (typeof v !== "number") return null;
            // Legacy audits used 0.0-1.0 ratios; current prompt uses 0-10.
            return Math.round((v <= 1 ? v * 10 : v) * 10) / 10;
          };
          return (
            <div
              key={i}
              className="my-2 px-3 py-2 border bg-card/40"
              style={{ borderRadius: 0, borderColor: "rgba(34,197,94,0.22)" }}
            >
              <div className="font-mono text-2xs text-emerald-400 mb-1">{t("agent.cutAudit")}</div>
              <div className="flex flex-wrap gap-2 mb-1.5">
                {(["A", "B", "C", "D"] as const).map((k) => {
                  const s = score(k);
                  return (
                    <span
                      key={k}
                      className="font-mono text-2xs px-1.5 py-0.5 border"
                      style={{ borderRadius: 0, borderColor: "rgba(255,255,255,0.1)" }}
                    >
                      {k}: {s == null ? "—" : `${s}/10`}
                    </span>
                  );
                })}
              </div>
              {!!d.issues?.length && (
                <ul className="list-disc pl-4 mb-1">
                  {d.issues.map((it, j) => (
                    <li key={j} className="text-meta text-foreground/80 leading-snug">{renderWithTags(it)}</li>
                  ))}
                </ul>
              )}
              {!!d.suggested_fixes?.length && (
                <ul className="list-disc pl-4">
                  {d.suggested_fixes.map((it, j) => (
                    <li key={j} className="text-meta text-emerald-300/85 leading-snug">{renderWithTags(it)}</li>
                  ))}
                </ul>
              )}
            </div>
          );
        }
        if (seg.type === "reference_decomposition") {
          const d = seg.data;
          if (!d) return null;
          return (
            <div
              key={i}
              className="my-2 px-3 py-2 border bg-card/40"
              style={{ borderRadius: 0, borderColor: "rgba(244,114,182,0.25)" }}
            >
              <div className="font-mono text-2xs text-pink-300 mb-1">{t("agent.referenceDecomposition")}</div>
              {d.hook && (
                <p className="text-meta mb-1 text-foreground/85">
                  <span className="font-mono text-2xs text-muted-foreground mr-1">{t("agent.hook")}</span>
                  {renderWithTags(d.hook)}
                </p>
              )}
              {!!d.scenes?.length && (
                <div className="space-y-0.5 mb-1">
                  {d.scenes.map((s, j) => (
                    <p key={j} className="text-caption text-foreground/80 leading-snug">
                      <span className="font-mono text-2xs text-muted-foreground mr-1">
                        {normalizeShotRefs(s.t || `#${j + 1}`)}
                      </span>
                      {renderWithTags(s.beat || s.visual || s.audio || "")}
                    </p>
                  ))}
                </div>
              )}
              {!!d.motifs?.length && (
                <p className="text-caption text-foreground/75">
                  <span className="font-mono text-2xs text-muted-foreground mr-1">{t("agent.motifs")}</span>
                  {renderWithTags(d.motifs.join(" · "))}
                </p>
              )}
              {!!d.do_not_copy?.length && (
                <p className="text-caption text-pink-300/80 mt-0.5">
                  <span className="font-mono text-2xs mr-1">{t("agent.avoid")}</span>
                  {renderWithTags(d.do_not_copy.join(" · "))}
                </p>
              )}
            </div>
          );
        }
        return (
          <ProseBlock
            key={i}
            source={normalizeShotRefs(seg.content)}
            components={markdownComponents}
            defaultOpen={defaultOpen}
          />
        );
      })}
    </div>
  );
};
