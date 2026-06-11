import { useCallback, useEffect, useRef } from "react";
import {
  DEFAULT_DASHBOARD_SIDEBAR_WIDTH,
  clampDashboardSidebarWidth,
  saveDashboardSidebarWidth,
} from "@/lib/dashboardPreferences";
import { useT } from "@/lib/uiLanguage";

interface SidebarResizeHandleProps {
  /** 현재 사이드바 폭. 부모(DashboardPage / LibraryPage)가 단일 진실원으로 보유. */
  width: number;
  /** 드래그 중 라이브 갱신용 콜백. clamp 는 부모에서 받은 값을 그대로 setState
   *  해도 되도록 핸들 내부에서 미리 clamp 적용해 넘긴다. */
  onWidthChange: (next: number) => void;
  /** 더블클릭 시 복원할 기본 폭. 미지정 시 Dashboard 기본값(legacy 호환). */
  defaultWidth?: number;
  /** 외부 입력을 안전 범위로 강제. 미지정 시 Dashboard clamp 사용. */
  clamp?: (value: unknown) => number;
  /** mouseup / 더블클릭 시점에 영구화. 미지정 시 Dashboard saver 사용. */
  onCommit?: (next: number) => void;
  /** 핸들이 어느 쪽 패널의 폭을 조정하는지.
   *  "left"(기본): 사이드바가 핸들 *왼쪽* 에 있고, 마우스를 오른쪽으로 끌면 폭이 커진다.
   *  "right":     인스펙터가 핸들 *오른쪽* 에 있고, 마우스를 왼쪽으로 끌면 폭이 커진다.
   *  내부적으로는 mousemove delta 의 부호만 반전한다. */
  side?: "left" | "right";
  /** 보조기술/툴팁 라벨. 기본 "Resize sidebar — double-click to reset". */
  ariaLabel?: string;
}

/** 사이드바와 메인 영역 사이의 4 px 짜리 vertical resize handle.
 *
 *  요구사항 한 줄 요약:
 *    1. 드래그하면 사이드바 폭이 실시간으로 반영 (rAF 로 throttle 해 60fps 보장)
 *    2. 더블클릭하면 기본값으로 즉시 복원
 *    3. 드래그 종료 시점에만 localStorage 에 영구화 — 드래그 중간 1000 회 쓰기 방지
 *    4. 드래그 중 텍스트 선택/커서 깜빡임을 막기 위해 body 에 임시 스타일 주입
 *
 *  defaultWidth/clamp/onCommit 을 props 로 받아 Dashboard·Library 등 다중 사이드바
 *  에서 동일 핸들을 재사용한다. 미지정 시 Dashboard 기본값으로 폴백 — 기존
 *  호출부(DashboardPage)는 인자 추가 없이 그대로 동작.
 *
 *  접근성:
 *    role="separator" + aria-orientation="vertical" 로 보조기술이 분리자임을
 *    인지. 키보드 조작은 본 옵션에선 의도적으로 빼 — 사용 빈도가 낮고 mouseup
 *    영구화 정책과 어긋나기 쉬움. 필요해지면 별도 PR. */
export const SidebarResizeHandle = ({
  width,
  onWidthChange,
  defaultWidth = DEFAULT_DASHBOARD_SIDEBAR_WIDTH,
  clamp = clampDashboardSidebarWidth,
  onCommit = saveDashboardSidebarWidth,
  side = "left",
  ariaLabel,
}: SidebarResizeHandleProps) => {
  const t = useT();
  const resolvedAriaLabel = ariaLabel ?? t("sidebar.resizeAria");
  // 우측 패널(인스펙터) 핸들은 마우스가 *왼쪽* 으로 갈 때 패널이 커져야
  // 직관적이라 delta 부호를 반전. ref 로 잡아 mousedown 클로저가 stale 한
  // prop 을 참조하지 않게 한다.
  const sideSignRef = useRef(side === "right" ? -1 : 1);
  useEffect(() => {
    sideSignRef.current = side === "right" ? -1 : 1;
  }, [side]);
  // mousedown 시점의 픽셀 좌표와 시작 폭을 ref 로 잡아 둬, 이후 mousemove
  // 콜백마다 closure 가 stale 한 width state 를 읽지 않게 한다.
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);
  // rAF id — 동일 프레임 안에서 mousemove 가 여러 번 발사돼도 한 번만
  // setState 하도록 합치는 용도.
  const rafIdRef = useRef<number | null>(null);
  // 가장 최근에 계산된 폭 — 드래그 종료 시 영구화할 값.
  const latestWidthRef = useRef(width);
  // mousedown 핸들러가 등록한 mousemove/mouseup 리스너의 cleanup 함수. 컴포넌트
  // 가 드래그 중간에 unmount 돼도 listener 가 dangling 으로 남지 않게 한다.
  const cleanupRef = useRef<(() => void) | null>(null);
  // clamp/onCommit 은 부모에서 ref-stable 한 함수가 아닐 수 있어 ref 로 잡아
  // mousedown 클로저가 stale 값을 읽지 않게 한다.
  const clampRef = useRef(clamp);
  const commitRef = useRef(onCommit);

  useEffect(() => {
    clampRef.current = clamp;
    commitRef.current = onCommit;
  }, [clamp, onCommit]);

  // width prop 이 갱신될 때마다 latestWidthRef 도 동기화 — 드래그가 아닌
  // 다른 경로(다른 윈도우 storage 이벤트 등)로 폭이 바뀐 경우를 위해.
  useEffect(() => {
    latestWidthRef.current = width;
  }, [width]);

  // unmount 시 리스너 정리 + body 스타일 원복.
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // 좌클릭만 처리 — 우클릭은 컨텍스트 메뉴가 떠야 자연스러움.
      if (e.button !== 0) return;
      // DnD 컨텍스트가 카드 드래그로 오인하지 않도록 이벤트 차단. 핸들은
      // 드래그 가능한 카드/폴더 행과 형제 위치라 propagate 시 부모의
      // PointerSensor 가 잘못 활성화될 수 있다.
      e.preventDefault();
      e.stopPropagation();

      startXRef.current = e.clientX;
      startWidthRef.current = latestWidthRef.current;

      // 드래그 중 텍스트 선택 / I-beam 커서 깜빡임 방지. mouseup 시점에
      // 원복하지 않으면 사용자가 아무 데나 클릭할 때마다 col-resize 커서가
      // 따라다니는 사고가 생긴다.
      const previousUserSelect = document.body.style.userSelect;
      const previousCursor = document.body.style.cursor;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";

      const handleMouseMove = (ev: MouseEvent) => {
        const delta = (ev.clientX - startXRef.current) * sideSignRef.current;
        const next = clampRef.current(startWidthRef.current + delta);
        latestWidthRef.current = next;
        // rAF 로 throttle — 같은 프레임 안의 여러 mousemove 가 한 번만 setState.
        if (rafIdRef.current !== null) return;
        rafIdRef.current = window.requestAnimationFrame(() => {
          rafIdRef.current = null;
          onWidthChange(latestWidthRef.current);
        });
      };

      const cleanup = () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
        document.body.style.userSelect = previousUserSelect;
        document.body.style.cursor = previousCursor;
        if (rafIdRef.current !== null) {
          window.cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = null;
        }
        cleanupRef.current = null;
      };

      const handleMouseUp = () => {
        cleanup();
        // 마지막 폭을 한 번만 영구화. 드래그 중 매 프레임 localStorage 를
        // 두드리던 구현 대비 쓰기 1000 배 절약.
        commitRef.current(latestWidthRef.current);
      };

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
      cleanupRef.current = cleanup;
    },
    [onWidthChange],
  );

  // 더블클릭 → 기본값 복원. 드래그 mousedown 보다 먼저 처리되도록 onDoubleClick
  // 은 같은 엘리먼트에 둠. 기본값 복원은 즉시 영구화 (사용자가 명시적으로
  // 의도한 액션이라 드래그처럼 mouseup 까지 기다릴 필요 없음).
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onWidthChange(defaultWidth);
      commitRef.current(defaultWidth);
    },
    [defaultWidth, onWidthChange],
  );

  return (
    <div
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      role="separator"
      aria-orientation="vertical"
      aria-label={resolvedAriaLabel}
      title={t("sidebar.resizeTitle")}
      // hit area 6 px, 그 중심선이 사이드바 border-r 와 정확히 같은 x 좌표가
      // 되도록 -ml-[3px] / -mr-[3px] 대칭 음수 마진. 이러면:
      //  - 핸들 시각 폭 0 (next 메인 영역 위치 변동 없음)
      //  - 핸들 인너 1 px 라인이 사이드바 border 위에 정확히 겹쳐, hover 시
      //    border 색이 그대로 primary 로 강조 — 사용자에게 "한 줄" 로 보임
      //  - 클릭 영역은 사이드바 좌우 3 px 씩 뻗어 hit miss 가 줄어듦
      // 또한 default 상태에서는 핸들의 라인을 bg-transparent 로 둬 사이드바
      // border 의 subtle 회색만 한 겹 보이게 한다 (이중 라인 방지).
      className="
        relative w-[6px] -ml-[3px] -mr-[3px] cursor-col-resize select-none flex-shrink-0
        z-20 group
      "
    >
      <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-transparent group-hover:bg-primary/70 transition-colors duration-150" />
    </div>
  );
};
