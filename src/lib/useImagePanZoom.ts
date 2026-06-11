import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/* Eagle/Figma 류의 이미지 줌·팬 인터랙션 훅.
 *
 * 모델:
 *   - scale: 현재 배율 (1 = fit). transform: scale 로 직접 그린다.
 *   - tx, ty: 컨테이너 좌상단 기준 translate (px).
 *   - transform-origin 은 항상 "0 0" 으로 둬서 zoom-to-cursor 수식을 단순화.
 *
 * 사용 패턴:
 *   const { onMouseDown, onDoubleClick, transformStyle, isPanning, reset } =
 *     useImagePanZoom({ containerRef, enabled });
 *
 *   <div ref={containerRef} className="relative overflow-hidden cursor-grab active:cursor-grabbing"
 *        onMouseDown={onMouseDown} onDoubleClick={onDoubleClick}>
 *     <div className="absolute inset-0" style={transformStyle}>
 *       <img className="absolute inset-0 h-full w-full object-contain" ... />
 *     </div>
 *   </div>
 *
 * 핵심 동작:
 *   - 좌클릭 드래그 → 팬 (스페이스 등 modifier 불필요).
 *   - 마우스 휠 → 커서 위치 중심 줌 (지수 스케일).
 *   - 트랙패드 핀치(ctrlKey + wheel) → 동일 동작, 감도만 다르게.
 *   - 더블클릭 → fit 으로 리셋 (scale=1, tx=ty=0).
 *
 * passive 처리:
 *   React 의 onWheel 은 17+ 부터 passive 가 기본이라 preventDefault 가 무시
 *   되는 환경이 있다 — 페이지가 휠로 스크롤되어 버린다. 그래서 ref 를 통해
 *   native addEventListener({ passive: false }) 로 직접 붙인다. */

interface UseImagePanZoomOptions {
  containerRef: RefObject<HTMLElement | null>;
  /** false 면 휠/드래그/더블클릭 모두 비활성화. region 모드 같은 외부 상태와
   *  결합해 일시적으로 끄는 용도. */
  enabled?: boolean;
  minScale?: number;
  maxScale?: number;
}

interface UseImagePanZoomResult {
  scale: number;
  tx: number;
  ty: number;
  isPanning: boolean;
  reset: () => void;
  onMouseDown: (event: React.MouseEvent) => void;
  onDoubleClick: (event: React.MouseEvent) => void;
  transformStyle: { transform: string; transformOrigin: "0 0" };
}

export function useImagePanZoom({
  containerRef,
  enabled = true,
  minScale = 0.1,
  maxScale = 16,
}: UseImagePanZoomOptions): UseImagePanZoomResult {
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [isPanning, setIsPanning] = useState(false);

  /* 드래그 시작 시점의 스냅샷. mousemove 가 매번 최신 tx/ty 를 setter 함수로
     읽어가지 않아도 되도록 시작 좌표 + 시작 tx/ty 를 함께 저장한다. */
  const panStartRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  /* 항상-켜진 window mousemove/mouseup 이 "지금 팬 중인지" 를 동기 ref 로
     확인. isPanning state 만 보면 setIsPanning(false) → re-render → cleanup
     사이 race 로 짧게 끊겨 보이는 케이스가 있다. */
  const panActiveRef = useRef(false);

  const reset = useCallback(() => {
    setScale(1);
    setTx(0);
    setTy(0);
  }, []);

  /* enabled 가 false 로 바뀌면 진행 중인 팬을 즉시 종료. region 모드 토글
     같은 외부 변화에 안전하게 반응하기 위함. */
  useEffect(() => {
    if (enabled) return;
    panActiveRef.current = false;
    panStartRef.current = null;
    setIsPanning(false);
  }, [enabled]);

  /* 휠 줌 — native event listener 로 등록해 { passive: false } 를 보장. */
  useEffect(() => {
    if (!enabled) return;
    const el = containerRef.current;
    if (!el) return;

    const onWheel = (event: WheelEvent) => {
      /* preventDefault 는 항상 호출 — 휠이 페이지/조상 스크롤로 새는 것을
         확실히 막는다. ctrlKey 휠은 OS/브라우저가 페이지 줌으로 해석하는데
         그것도 함께 막아 컨테이너 안에서만 줌이 동작하게 한다. */
      event.preventDefault();

      const rect = el.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;

      /* 트랙패드 핀치(ctrlKey+wheel) 는 deltaY 가 일반 휠보다 훨씬 크므로
         감도를 낮춰 자연스러운 핀치 줌 느낌을 낸다. */
      const sensitivity = event.ctrlKey ? 0.01 : 0.0015;
      const factor = Math.exp(-event.deltaY * sensitivity);

      setScale((prev) => {
        const next = Math.max(minScale, Math.min(maxScale, prev * factor));
        if (next === prev) return prev;
        const ratio = next / prev;
        /* 같은 wheel tick 안에서 tx/ty 도 함께 보정 — setter 함수형으로
           최신 값을 읽어 커서 위치(mx, my) 가 화면상 같은 픽셀에 머무르도록
           translate 를 조정한다 (zoom-to-cursor). */
        setTx((ptx) => mx - (mx - ptx) * ratio);
        setTy((pty) => my - (my - pty) * ratio);
        return next;
      });
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [containerRef, enabled, minScale, maxScale]);

  const onMouseDown = useCallback(
    (event: React.MouseEvent) => {
      if (!enabled) return;
      /* 좌클릭만 팬 — 우클릭은 컨텍스트 메뉴, 가운데 클릭은 OS 동작에 맡김. */
      if (event.button !== 0) return;
      /* 자식이 stopPropagation 한 mousedown 은 이미 다른 인터랙션이 잡았다는
         뜻 — 여기 도달조차 안 함. 도달했다면 컨테이너 본체 클릭이므로 팬 시작. */
      event.preventDefault();
      panStartRef.current = { x: event.clientX, y: event.clientY, tx, ty };
      panActiveRef.current = true;
      setIsPanning(true);
    },
    [enabled, tx, ty],
  );

  const onDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      if (!enabled) return;
      event.preventDefault();
      reset();
    },
    [enabled, reset],
  );

  /* mount 시 1회만 window 리스너 등록. ref 로 활성 여부 체크 → 항상 켜진
     리스너가 안전하게 노옵 처리한다. window 스코프라 컨테이너 바깥으로
     마우스가 나가도 안전하게 release. */
  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (!panActiveRef.current) return;
      const s = panStartRef.current;
      if (!s) return;
      setTx(s.tx + (event.clientX - s.x));
      setTy(s.ty + (event.clientY - s.y));
    };
    const onUp = () => {
      if (!panActiveRef.current) return;
      panActiveRef.current = false;
      panStartRef.current = null;
      setIsPanning(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  return {
    scale,
    tx,
    ty,
    isPanning,
    reset,
    onMouseDown,
    onDoubleClick,
    transformStyle: {
      transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
      transformOrigin: "0 0",
    },
  };
}
