// 브랜드 색 단일 출처(Single Source of Truth).
//
// JS / canvas / SVG / HTML-export 등 *CSS 변수(var(--primary)) 를 해석할 수 없는*
// 컨텍스트에서 브랜드 레드를 참조할 때 쓴다. DOM 의 className / style 에서는
// 가능한 한 Tailwind `primary` 토큰(= hsl(var(--primary))) 을 우선 사용하고,
// 토큰을 쓸 수 없는 곳에서만 아래 상수를 쓴다.
//
// ⚠️ 값은 반드시 index.css 의 `--primary` 와 동기화 상태를 유지한다.
//    --primary: 2 95% 60%  ==  #f9423a  ==  rgb(249,66,58)
//
// 과거 contiTypes / agentTypes / assets/types + 6 개 컴포넌트에 각각 흩어져
// 중복 정의돼 있던 `KR` / `KR_BG` 를 여기로 통합했다(값 동일 → 시각 변화 없음).
// 이제 브랜드색을 바꾸려면 이 파일과 index.css 두 곳만 수정하면 된다.

/** 브랜드 레드 (= --primary). */
export const KR = "#f9423a";

/** 브랜드 레드 10% — 선택/활성 표면의 반투명 채움. */
export const KR_BG = "rgba(249,66,58,0.10)";
