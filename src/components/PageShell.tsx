import { createContext, useContext, type ReactNode, useRef } from "react";

interface PageShellProps {
  /** 현재 라우트가 이 페이지인지. true 일 땐 정상 표시, false 일 땐 hide. */
  active: boolean;
  children: ReactNode;
}

/**
 * 현재 페이지가 사용자에게 *보이는* 상태인지를 자식 트리에 전달.
 *
 * PageShell 로 감싸지 않은 컴포넌트(예: /dashboard, /project/:id) 도 같은 hook
 * 을 호출할 수 있도록 기본값을 `true` 로 둔다 — 그 페이지들은 라우트 매칭이
 * 곧 active 상태이므로 의미상 일치한다.
 *
 * keep-mount 된 페이지(현재는 LibraryPage 만) 가 `display: none` 으로 숨어
 * 있을 때, 비싼 외부 subscription(예: classify 큐) 의 자동 발화로 사용자가
 * 다른 라우트에서 작업 중일 때 메인스레드를 점유당하는 문제를 회피하기 위해
 * 자식 컴포넌트가 active 전환 타이밍을 알 수 있게 한다.
 */
const PageActiveContext = createContext<boolean>(true);

export function usePageActive(): boolean {
  return useContext(PageActiveContext);
}

/**
 * 페이지 keep-mount shell — 라우트 왕복 시 *두번째 진입부터* 진짜로 즉시
 * 보이게 한다.
 *
 * 동작:
 *   - `active` 가 한 번이라도 true 였으면 children 을 *항상 mount* 상태로
 *     유지하고, 비활성 시 wrapper 를 `display: none` 으로 숨긴다. 같은
 *     라우트로 돌아오면 DOM / state / IntersectionObserver / 디코드된 이미지
 *     raster cache 가 모두 살아 있어 0ms 로 표시.
 *   - 첫 visit 전에는 `null` 을 반환 — lazy chunk fetch / 첫 mount 비용이
 *     진짜 진입 순간까지 미뤄진다(메모리/번들 안전).
 *
 * 디자인 결정 — wrapper 는 *그냥 block div*. `display: contents` 같은
 * 침습적 패턴은 자식이 부모의 positioning context / flex/grid container 를
 * 의존할 때 layout 을 깨뜨리는 사례가 있어(특히 page root 가 `position:
 * absolute; inset: 0` 패턴인 경우), *page root 가 viewport-fill 자체로
 * 자기 영역을 결정* (예: `h-screen`) 하는 페이지에만 안전하게 사용한다.
 * 적용 대상이 그 계약을 만족하는지 확인한 뒤 도입할 것.
 *
 * `display: none` 자체가 (a) tab focus 차단 (자식 포함) (b) click event
 * 차단 (c) layout/paint 비용 0 을 보장하므로 별도의 `inert` 가 필요 없다.
 * `aria-hidden` 만 추가해 스크린리더가 명시적으로 무시하게 한다.
 */
export function PageShell({ active, children }: PageShellProps) {
  // 한 번이라도 활성이었는지 — false → true 전환을 기록. 비활성으로 돌아가도
  // 이 ref 는 true 로 남아 children 이 계속 mount 된다.
  const hasMountedRef = useRef(false);
  if (active) hasMountedRef.current = true;
  if (!hasMountedRef.current) return null;

  return (
    <div
      aria-hidden={active ? undefined : true}
      style={{ display: active ? "block" : "none" }}
    >
      <PageActiveContext.Provider value={active}>
        {children}
      </PageActiveContext.Provider>
    </div>
  );
}
