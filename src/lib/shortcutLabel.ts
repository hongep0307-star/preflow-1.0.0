/**
 * 단축키 표기를 플랫폼에 맞게 변환한다.
 *
 * 코드 전반의 단축키 라벨은 Windows 식("Ctrl+Shift+E")으로 하드코딩돼 있다.
 * macOS 빌드에서는 같은 동작이 Cmd 로 매핑되므로(키 핸들러가 metaKey 를 처리),
 * 표기도 Mac 관례(⇧⌘E)로 보여줘야 자연스럽다.
 *
 * - 비-Mac: 입력을 그대로 반환(Windows/Linux 는 기존 "Ctrl+..." 유지).
 * - Mac: "+" 로 분해해 토큰을 글리프로 치환하고, modifier 는 Mac 표준 순서
 *   (⌃⌥⇧⌘)로 정렬해 구분자 없이 이어 붙인다.
 *
 * 공용 메뉴 컴포넌트(ContextMenu/DropdownMenu/Menubar/Command 의 *Shortcut)에서
 * children 문자열을 이 함수로 통과시키면 앱 전역 메뉴 단축키가 한 번에 Mac
 * 표기로 바뀐다. 툴팁 등 인라인 라벨에도 직접 사용 가능.
 */

const IS_MAC =
  typeof navigator !== "undefined" &&
  navigator.userAgent.toLowerCase().includes("mac");

export function isMacPlatform(): boolean {
  return IS_MAC;
}

/** 토큰(소문자) → Mac 글리프. modifier 와 일부 특수 키를 함께 다룬다. */
const MAC_GLYPH: Record<string, string> = {
  // modifiers — 앱 단축키의 "Ctrl" 은 Mac 에서 Cmd(⌘) 로 동작한다.
  ctrl: "⌘",
  control: "⌘",
  cmd: "⌘",
  command: "⌘",
  meta: "⌘",
  alt: "⌥",
  option: "⌥",
  opt: "⌥",
  shift: "⇧",
  // 특수 키
  enter: "↵",
  return: "↵",
  esc: "⎋",
  escape: "⎋",
  del: "⌫",
  delete: "⌫",
  backspace: "⌫",
  tab: "⇥",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
};

/** Mac modifier 표준 표시 순서. */
const MOD_ORDER = ["⌃", "⌥", "⇧", "⌘"];

/**
 * "Ctrl+Shift+E" → (Mac) "⇧⌘E" / (그 외) "Ctrl+Shift+E".
 * 인식 못 하는 토큰(문자/숫자/Space/F2/[ ] 등)은 그대로 둔다.
 */
export function formatShortcut(label: string): string {
  if (!IS_MAC || !label) return label;
  const parts = label
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return label;

  const mods: string[] = [];
  const keys: string[] = [];
  for (const part of parts) {
    const glyph = MAC_GLYPH[part.toLowerCase()];
    if (glyph && MOD_ORDER.includes(glyph)) {
      if (!mods.includes(glyph)) mods.push(glyph);
    } else {
      keys.push(glyph ?? part);
    }
  }
  mods.sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  return mods.join("") + keys.join("");
}

/**
 * 툴팁 제목 문자열 안의 *괄호 단축키* 만 Mac 표기로 바꾼다.
 * 예: "붙여넣기 (Ctrl+V)" → (Mac) "붙여넣기 (⌘V)".
 *
 * modifier 키워드(Ctrl/Cmd/Alt/Shift/Option/Meta)를 포함한 괄호 그룹만 건드려,
 * 일반 괄호 설명문은 그대로 둔다. 비-Mac 에서는 no-op.
 */
export function formatTitleShortcuts(title: string): string {
  if (!IS_MAC || !title) return title;
  return title.replace(
    /\(([^)]*(?:ctrl|cmd|command|alt|option|shift|meta)[^)]*)\)/gi,
    (_full, combo: string) => `(${formatShortcut(combo)})`,
  );
}
