/* ─────────────────────────────────────────────────────────────────────────
 *  TopbarToastCarveOut
 *
 *  Why this exists
 *  ───────────────
 *  Pre-Flow 의 모든 페이지(Library / Dashboard / Project / Settings) 의
 *  네비바(`.app-topbar`) 와 ContiStudio 의 `.studio-titlebar` 는 OS 타이틀바
 *  를 숨긴 frameless window 의 *드래그 핸들* 역할을 한다 — `index.css` 에서
 *  `-webkit-app-region: drag` 가 박혀 있고, 내부의 인터랙티브 요소는 별도
 *  blacklist 셀렉터로 no-drag 처리한다.
 *
 *  그런데 라이브러리에서 추가된 "navbar-inline 토스트(top-center bar)" 는
 *  네비바의 세로 정중앙(top-[22px]) 에 떠 있어 시각적으로 drag region 과
 *  겹친다. 이 토스트는 Radix Portal 로 *<body> 직속* 에 그려져 네비바와
 *  *다른 DOM 트리* 에 속하기 때문에, 토스트와 그 자식 버튼 자체에 no-drag
 *  를 박아도 Chromium 의 drag region 합성이 토스트의 사각 영역을 네비바의
 *  drag mask 에서 carve-out 하지 못한다(같은 트리 안 drag/no-drag 합성은
 *  정상 동작이지만, sibling tree 의 no-drag 가 큰 drag rect 를 깎는 케이스
 *  는 잘 처리되지 않는 알려진 한계).
 *
 *  실측으로도 *네비바 안쪽* 에 떠 있는 토스트는 Undo / X 버튼이 OS drag 로
 *  흡수되어 클릭이 안 됐고, 네비바 아래로 흐른 두 번째 토스트는 정상 클릭
 *  됐다(같은 React 컴포넌트·같은 className·같은 computed `-webkit-app-region:
 *  no-drag`. 차이는 *오직 좌표뿐*. 결정적 증거).
 *
 *  How this works
 *  ──────────────
 *  네비바/타이틀바의 *직속 자식* 으로 토스트와 동일한 좌표·크기의 빈 div 를
 *  두고 `data-no-drag` 를 박는다. `index.css` 의
 *
 *    .app-topbar [data-no-drag]    { -webkit-app-region: no-drag; }
 *    .studio-titlebar [data-no-drag] { -webkit-app-region: no-drag; }
 *
 *  selector 가 잡아 carve-out 이 성립한다. 같은 DOM 트리 안에서의 drag /
 *  no-drag 합성은 Chromium 이 정확히 처리하므로, Electron 의 drag region
 *  map 이 그 사각 영역만 깔끔하게 비워두고, 그 위에 z-100 으로 떠 있는
 *  토스트의 버튼 click 이 OS 단에서 흡수되지 않는다.
 *
 *  Layout 영향
 *  ───────────
 *  부모는 `position: relative` 가 필요하다(이 div 의 `absolute` 기준점).
 *  `pointer-events: none` 로 click/hit-test 에는 끼지 않아 네비바 안의 다른
 *  인터랙티브 요소(BrandLogo, breadcrumb, 설정 버튼 등) 의 동작을 방해하지
 *  않는다.
 *
 *  Sizing
 *  ──────
 *  - top:    16px  — 토스트의 top-[22px] 보다 살짝 위로 시작(여유 6px)
 *  - height: 52px  — 토스트 base(약 36~46px) + 여유
 *  - width:  min(736px, 92vw) — 토스트 viewport 의 max-w-[min(720px,90vw)]
 *                              보다 살짝 큼. 텍스트가 길어져도 안전하게 덮음.
 *
 *  Conditional mount
 *  ─────────────────
 *  과거에는 무조건 마운트했지만, 그러면 토스트가 없을 때도 네비바 중앙
 *  ~92vw 가 OS 드래그에서 제외돼 "네비바 가운데를 잡고 창 이동" 동작이
 *  죽었다. `useToast()` 의 `toasts` 배열을 구독해 *top-center 위치의 토스트
 *  가 하나라도 살아 있을 때만* 마운트한다. dismiss 직후에도 토스트는
 *  `TOAST_REMOVE_DELAY = 1000ms` 동안 state 에 남아 fade-out 되므로, 그
 *  애니메이션 동안 carve-out 도 자동으로 유지돼 X/Undo 클릭이 끝까지
 *  살아 있다. position 이 "bottom-right" 인 토스트는 네비바에 뜨지 않으니
 *  카운트에서 제외.
 *
 *  4 개 페이지 + ContiStudio 의 네비바마다 동일하게 한 줄 (`<TopbarToastCarveOut />`)
 *  로 박으면 끝. 향후 다른 컨테이너에서 동일 패턴이 필요해도 이 컴포넌트
 *  하나만 끼우면 된다. ───────────────────────────────────────────────── */
import { useToast } from "@/hooks/use-toast";

export const TopbarToastCarveOut = () => {
  const { toasts } = useToast();
  const hasTopCenterToast = toasts.some((t) => (t.position ?? "top-center") === "top-center");
  if (!hasTopCenterToast) return null;
  return (
    <div
      aria-hidden
      data-no-drag
      className="pointer-events-none absolute left-1/2 top-[16px] h-[52px] w-[min(736px,92vw)] -translate-x-1/2"
    />
  );
};
