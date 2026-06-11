import React from "react";
import { ACFG, ASSET_ICON } from "@/components/conti/contiTypes";

interface Asset {
  tag_name: string;
  photo_url?: string | null;
  ai_description?: string | null;
  asset_type?: string;
}

/**
 * 콘티탭 씬카드의 TagChip 과 동일한 시각 규격으로 인라인 @멘션을 렌더링.
 *
 * 이전 구현과의 차이:
 *   · pill(borderRadius 9999) + fontSize 11 + `@` 접두사 그대로 표기 →
 *     콘티탭 칩(borderRadius 2, fontSize 9, `@` 미표시 + SVG 아이콘) 과
 *     크게 달라 같은 씬이 콘티탭 / 콘티스튜디오에서 서로 다른 UI 로
 *     보였다. 이제는 ACFG 팔레트와 ASSET_ICON 패스를 써서 씬카드 칩과
 *     완전히 동일한 외형을 낸다.
 *   · `asset_type` 이 비어 있거나 알 수 없는 값이면 character 로 폴백.
 */
export function renderMessageWithMentions(text: string, assets: Asset[]): React.ReactNode {
  if (!assets || assets.length === 0) return text;

  // tag (with leading `@`) → { cfg, ico, displayName } 매핑
  const tagInfo = new Map<
    string,
    { cfg: { color: string; bg: string; bd: string }; ico: string; name: string }
  >();
  assets.forEach((a) => {
    const clean = a.tag_name.startsWith("@") ? a.tag_name.slice(1) : a.tag_name;
    const tag = `@${clean}`;
    const type = a.asset_type ?? "character";
    const cfg = ACFG[type] || ACFG.character;
    const ico = ASSET_ICON[type] || ASSET_ICON.character;
    tagInfo.set(tag, { cfg, ico, name: clean });
  });

  // Sort longest-first so a longer tag (e.g. "@BG_medium") wins the regex
  // alternation against a shorter prefix tag ("@BG"). JS regex alternation
  // returns the leftmost-listed alternative that matches at a position, so
  // without this sort `@BG_medium` would be split into a `@BG` chip + a
  // stray `_medium` text node.
  const tags = [...tagInfo.keys()].sort((a, b) => b.length - a.length);
  if (tags.length === 0) return text;

  const pattern = new RegExp(
    `(${tags.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "g",
  );
  const parts = text.split(pattern);

  return (
    <>
      {parts.map((part, i) => {
        const info = tagInfo.get(part);
        if (!info) return <React.Fragment key={i}>{part}</React.Fragment>;
        const { cfg, ico, name } = info;
        return (
          <span
            key={i}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              fontSize: 9,
              fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
              fontWeight: 600,
              letterSpacing: "0.04em",
              padding: "1px 6px 1px 4px",
              borderRadius: 2,
              background: cfg.bg,
              color: cfg.color,
              border: `0.5px solid ${cfg.bd}`,
              verticalAlign: "middle",
              lineHeight: 1,
              position: "relative",
              top: -1,
              margin: "0 1px",
            }}
          >
            {/* `@` 는 시각적으로 숨기되 스크린리더용으로 텍스트에 남김 */}
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                width: 0,
                height: 0,
                overflow: "hidden",
                opacity: 0,
                pointerEvents: "none",
              }}
            >
              @
            </span>
            <svg
              width={9}
              height={9}
              viewBox="0 0 24 24"
              fill="none"
              stroke={cfg.color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ display: "inline-block", flexShrink: 0 }}
            >
              <path d={ico} />
            </svg>
            {name}
          </span>
        );
      })}
    </>
  );
}
