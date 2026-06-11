/**
 * scrollToScene — 콘티 씬 카드 DOM 으로 부드럽게 스크롤하고 짧게 강조한다.
 *
 * 생성 완료 토스트(앵글/조명/카메라 변형 등)의 "보기" 액션에서 호출한다.
 * 카드 루트에는 `data-scene-id={scene.id}` 속성이 있어야 한다
 * (SortableContiCard 루트에 부여됨). 구버전 경로 호환을 위해 scene_number
 * 기반의 `#conti-scene-{n}` id 폴백도 함께 시도한다.
 */

const HIGHLIGHT_MS = 1500;

function findSceneEl(sceneId: string): HTMLElement | null {
  const byData = document.querySelector<HTMLElement>(`[data-scene-id="${CSS.escape(sceneId)}"]`);
  if (byData) return byData;
  return null;
}

/**
 * @param sceneId  대상 씬의 안정적 id (scene.id)
 * @param fallbackSceneNumber  data-scene-id 가 없을 때 쓰는 scene_number 폴백
 */
export function scrollToScene(sceneId: string, fallbackSceneNumber?: number): void {
  const run = () => {
    let el = findSceneEl(sceneId);
    if (!el && fallbackSceneNumber != null) {
      el = document.getElementById(`conti-scene-${fallbackSceneNumber}`);
    }
    if (!el) return;

    el.scrollIntoView({ behavior: "smooth", block: "center" });

    // 일시적 강조 링. 인라인 style 로 적용 후 타이머로 원복 — 별도 CSS 의존 없음.
    const prevOutline = el.style.outline;
    const prevOffset = el.style.outlineOffset;
    const prevTransition = el.style.transition;
    el.style.transition = "outline-color 200ms ease";
    el.style.outline = "2px solid hsl(var(--primary))";
    el.style.outlineOffset = "2px";
    window.setTimeout(() => {
      el.style.outline = prevOutline;
      el.style.outlineOffset = prevOffset;
      el.style.transition = prevTransition;
    }, HIGHLIGHT_MS);
  };

  // 토스트 직후 카드가 리렌더로 위치를 바꿀 수 있어 한 프레임 양보.
  requestAnimationFrame(() => requestAnimationFrame(run));
}
