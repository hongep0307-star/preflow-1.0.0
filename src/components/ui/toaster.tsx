import { useToast } from "@/hooks/use-toast";
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
  type ToastPosition,
} from "@/components/ui/toast";

/* 토스트 라우팅 — top-center(default) / bottom-right(escape hatch).
 *
 *  모든 토스트는 *컴팩트 바* 한 레이아웃으로 그려지고 (title · description
 *  · action · close 가 한 줄로 나열), 위치 기본값은 상단 중앙. 우측 하단
 *  viewport 는 호환성 + 장차 long-form 디버그용으로 남겨두지만 호출부에서
 *  명시적으로 `position: "bottom-right"` 를 박지 않는 한 사용되지 않는다.
 *
 *  ── single-line 렌더링 ──
 *  title 옆에 description 이 따라오면 가운데 점(·) 으로 구분한 인라인
 *  형식. flex 컨테이너에 `min-w-0` 를 줘야 자식 truncate 가 동작.
 *  내용이 잘리면 마우스 호버로 full text 가 native tooltip 으로 노출되도록
 *  부모 div 에 title 속성을 부여(짧으면 무해, 길면 도움). */
export function Toaster() {
  const { toasts } = useToast();

  const renderToast = (
    toastRow: (typeof toasts)[number],
  ) => {
    const { id, title, description, action, position: _position, ...props } = toastRow;
    /* hover-tooltip 용 fallback text — title/description 이 string 일 때만
       활성. ReactNode 가 들어오면 굳이 stringify 하지 않고 비워둠. */
    const hoverText = [
      typeof title === "string" ? title : "",
      typeof description === "string" ? description : "",
    ]
      .filter(Boolean)
      .join(" · ");

    return (
      <Toast key={id} {...props}>
        <div
          className="flex min-w-0 flex-1 items-center gap-2"
          title={hoverText || undefined}
        >
          {title && <ToastTitle>{title}</ToastTitle>}
          {description && (
            <>
              {title && (
                <span aria-hidden className="shrink-0 text-foreground/30 group-[.destructive]:text-white/40">
                  ·
                </span>
              )}
              <ToastDescription>{description}</ToastDescription>
            </>
          )}
        </div>
        {action}
        <ToastClose />
      </Toast>
    );
  };

  const filterByPosition = (target: ToastPosition) =>
    toasts.filter((t) => (t.position ?? "top-center") === target);

  const topToasts = filterByPosition("top-center");
  const bottomToasts = filterByPosition("bottom-right");

  return (
    <>
      {/* 상단 중앙 — 기본 자리. 거의 모든 토스트가 여기. */}
      <ToastProvider swipeDirection="up" duration={5000}>
        {topToasts.map(renderToast)}
        <ToastViewport position="top-center" />
      </ToastProvider>

      {/* 우측 하단 — escape hatch. 명시적으로 position: "bottom-right" 를
          박은 토스트만 여기로 라우팅된다(현재 호출부 없음). */}
      <ToastProvider swipeDirection="right">
        {bottomToasts.map(renderToast)}
        <ToastViewport position="bottom-right" />
      </ToastProvider>
    </>
  );
}
