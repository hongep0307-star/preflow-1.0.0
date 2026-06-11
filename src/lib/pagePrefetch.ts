/**
 * Lazy 페이지 chunk 의 idle prefetch 헬퍼.
 *
 * 배경:
 *   App.tsx 가 `DashboardPage / ProjectPage / LibraryPage` 를 `lazy()` 로
 *   분할하면서 main bundle 은 가벼워졌지만, 사용자가 *처음* 해당 라우트로
 *   진입하는 순간 chunk fetch + parse 비용이 그 클릭의 응답으로 직접
 *   체감된다(특히 Library 는 단일 파일 5000+ 줄로 가장 큼).
 *
 * 해결:
 *   Dashboard / Project 페이지가 mount 된 직후 idle 시점에 dynamic import 를
 *   한 번만 발사. vite 는 같은 모듈 specifier 의 두 번째 dynamic import 를
 *   캐시 hit 으로 처리하므로, 사용자가 실제 Library 를 클릭하는 시점엔
 *   chunk 가 이미 메모리에 들어와 있어 fetch / parse 비용이 거의 0.
 *
 * 안전성:
 *   - workspace 전환은 `window.location.reload()` 로 전체 모듈 그래프를
 *     폐기하므로 prefetch 결과가 누수되지 않는다. 만약 사용자가 prefetch
 *     완료 *전* 에 workspace 를 전환해도, 진행 중인 fetch 는 reload 시
 *     abort 되고 새 페이지에서 다시 prefetch 가 시작된다.
 *   - 모듈 단위 가드로 한 세션 안에선 *한 번만* 실제 import 호출 — 같은
 *     페이지에서 mount/unmount 가 반복돼도 추가 fetch 가 발생하지 않는다.
 *   - import() 가 실패해도 silent — fallback 으로는 사용자가 클릭하는
 *     시점에 lazy 가 다시 정상 경로로 fetch 한다 (= 변경 전 동작과 동일).
 */

/** 같은 세션 안에서 두 번 이상 prefetch 가 시작되지 않게 결과 promise 를
 *  메모이즈. resolve / reject 모두 한 번이면 충분(실패해도 lazy 가 재시도). */
let libraryPrefetchPromise: Promise<unknown> | null = null;

/** requestIdleCallback 폴백 — Electron(Chromium) 은 항상 지원하지만 SSR /
 *  jsdom 환경 호환을 위한 안전망. */
function scheduleIdle(cb: () => void, timeout = 2000): number {
  const idle = (globalThis as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
  }).requestIdleCallback;
  if (idle) return idle(cb, { timeout });
  return (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout(cb, 0) as unknown as number;
}

function cancelIdle(handle: number): void {
  const cancel = (globalThis as unknown as {
    cancelIdleCallback?: (id: number) => void;
  }).cancelIdleCallback;
  if (cancel) cancel(handle);
  else (globalThis as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout(handle);
}

/**
 * LibraryPage chunk 를 idle 에 fetch + parse.
 *
 * 호출자(Dashboard / ProjectPage)는 mount useEffect 에서 한 번 호출하고
 * cleanup 에서 반환된 cancel 핸들을 사용해 idle 잡 자체를 취소할 수 있다 —
 * 페이지가 매우 짧게 mount 됐다가 unmount 되는 케이스(예: 라우트 전환
 * 도중 사용자가 즉시 다른 라우트로 이동) 에서 불필요한 chunk fetch 를
 * 피한다.
 *
 * 같은 specifier 를 App.tsx 의 lazy() 와 *반드시 일치* 시켜야 vite 가
 * 같은 chunk 로 deduplicate 한다 — `./pages/LibraryPage` (App.tsx 기준
 * 상대 경로) 와 동일 의미인 alias 경로를 사용한다.
 */
export function prefetchLibraryPage(): () => void {
  const handle = scheduleIdle(() => {
    if (libraryPrefetchPromise) return;
    libraryPrefetchPromise = import("@/pages/LibraryPage").catch((err) => {
      // 실패해도 silent — 사용자가 실제 클릭 시 lazy() 가 정상 경로로 재시도.
      console.warn("[pagePrefetch] LibraryPage prefetch failed:", err);
      libraryPrefetchPromise = null; // 다음 mount 에서 재시도 가능하도록 해제.
    });
  });
  return () => cancelIdle(handle);
}
