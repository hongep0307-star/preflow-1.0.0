import * as React from "react";
import * as ToastPrimitives from "@radix-ui/react-toast";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

const ToastProvider = ToastPrimitives.Provider;

/* ────────────────────────────────────────────────────────────────────────
 *  Toast — unified Eagle-style top-center compact bar
 *
 *  과거에는 default / destructive (큰 카드, 우측 하단 슬라이드) 와 bar
 *  (작은 컴팩트, 상단 중앙 페이드) 가 별도 variant 로 공존했지만, 이 앱의
 *  실제 사용 패턴(좁은 화면, 캔버스/그리드 중심 작업, 81px 정도의 빈 navbar
 *  중앙) 을 보면 *모든 토스트* 를 navbar-inline 컴팩트 바로 통일하는 게
 *  화면 점유도 적고 시각 위치도 일관된다. 따라서:
 *
 *    default     → 중립 surface(neutral elevated) + 흰 텍스트
 *    destructive → 빨간 surface + 흰 텍스트   (시각 강조는 색으로만 유지)
 *
 *  둘 모두 동일한 컴팩트 레이아웃(한 줄, 작은 padding, 페이드 in/out). 위치
 *  기본값 = 상단 중앙. 우측 하단 viewport 는 escape hatch 로 남겨두지만
 *  명시적으로 `position: "bottom-right"` 를 박지 않는 한 모든 토스트는
 *  상단 중앙으로 간다.
 *
 *  ── Drag region ──
 *  `.app-topbar` / `.studio-titlebar` 는 `-webkit-app-region: drag`. 토스트
 *  가 그 위에 떠 있어도 OS drag 로 흡수되지 않도록 (1) 모든 토스트 root /
 *  버튼에 `[-webkit-app-region:no-drag]` 를 박고, (2) 네비바 안에 같은 좌표
 *  의 `<TopbarToastCarveOut />` 로 carve-out 을 둔다(common 폴더 컴포넌트).
 *  이 속성은 *상속되지 않으므로* 각 인터랙티브 자식에 명시 필요. */

type ToastPosition = "top-center" | "bottom-right";

const ToastViewport = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Viewport>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Viewport> & { position?: ToastPosition }
>(({ className, position = "top-center", ...props }, ref) => (
  <ToastPrimitives.Viewport
    ref={ref}
    data-position={position}
    className={cn(
      "fixed z-[100] flex max-h-screen outline-none",
      position === "top-center"
        // .app-topbar(h-[81px]) 의 *세로 정중앙* 에 배치. topbar 의 가운데
        // breadcrumb 컨텍스트 존(`flex-1`)은 보통 비어 있고, 좌측 brand zone
        // (260px+) 과 우측 actions / WindowControls 는 절대 침범하지 않으므로
        // 한 번 두면 Library / Project / Dashboard / Settings 모든 페이지에
        // 일관되게 떠 있는 navbar-inline notification 이 된다.
        //
        // - top 좌표 = (81 - 토스트 약 36) / 2 ≈ 22px. 토스트 높이가 살짝
        //   변해도 시각적으로 거의 정중앙.
        // - pointer-events-none: 빈 viewport 가 topbar 의 클릭(브레드크럼/
        //   설정 버튼 등) 을 가로채지 않게. 자식 토스트는 pointer-events-auto.
        // - h-[81px] 같은 강제 높이는 두지 않는다 — 다중 토스트(LIMIT=3) 시
        //   topbar 아래로 자연스럽게 흘러 쌓이도록.
        ? "top-[22px] left-1/2 -translate-x-1/2 flex-col items-center gap-2 w-auto max-w-[min(720px,90vw)] pointer-events-none p-0"
        : "top-0 sm:bottom-0 sm:right-0 sm:top-auto flex-col-reverse sm:flex-col w-full md:max-w-[420px] p-4",
      className,
    )}
    {...props}
  />
));
ToastViewport.displayName = ToastPrimitives.Viewport.displayName;

/* 모든 토스트는 *컴팩트 바* 한 가지 레이아웃. 색만 variant 로 분기.
 *
 *  ─ Base ─
 *  flex / items-center / gap-3 / rounded-md / w-auto / py-2 pl-3 pr-2 / text-sm
 *  ring-1 / shadow / fade-in-out / [-webkit-app-region:no-drag]
 *
 *  ─ Default ─
 *  bg-surface-elevated (--surface-elevated, ~11% L. tooltip/popover 와 동일
 *  surface — 캔버스/카드 톤보다 한 단계 위로 떠 있어 분리감 확보)
 *  text-popover-foreground, ring-white/15
 *
 *  ─ Destructive ─
 *  bg-destructive (브랜드 빨강 surface), text-destructive-foreground (흰),
 *  ring-red-500/40 (테두리도 톤 일치). visual prominence 가 다른 어떤
 *  토스트보다 위에 있어 critical error 가 묻히지 않음. */
const toastVariants = cva(
  cn(
    "group pointer-events-auto relative flex w-auto items-center gap-3 overflow-hidden rounded-md py-2 pl-3 pr-2 text-sm",
    "ring-1 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.75)] transition-all",
    "data-[swipe=cancel]:translate-x-0 data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)] data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=move]:transition-none",
    "data-[state=open]:animate-in data-[state=closed]:animate-out data-[swipe=end]:animate-out",
    "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
    "[-webkit-app-region:no-drag]",
  ),
  {
    variants: {
      variant: {
        default: "bg-surface-elevated text-popover-foreground ring-white/15",
        destructive: "destructive bg-destructive text-destructive-foreground ring-red-500/40",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

const Toast = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Root> & VariantProps<typeof toastVariants>
>(({ className, variant, ...props }, ref) => {
  return (
    <ToastPrimitives.Root
      ref={ref}
      data-variant={variant ?? "default"}
      className={cn(toastVariants({ variant }), className)}
      {...props}
    />
  );
});
Toast.displayName = ToastPrimitives.Root.displayName;

/* Undo/Action 버튼 — 토스트 본문 옆 인라인 링크형.
 *
 *  default variant: text-primary (브랜드 빨강 액센트, 평소 톤)
 *  destructive   : 빨간 surface 위에 떠 있어 빨간 텍스트는 묻혀 보이므로
 *                  흰 톤 + underline-on-hover 로 액션감 유지.
 *
 *  -webkit-app-region:no-drag 도 명시 — 이 속성은 부모로부터 상속되지 않음. */
const ToastAction = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Action>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Action>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Action
    ref={ref}
    className={cn(
      "inline-flex h-7 shrink-0 items-center justify-center rounded-md border border-transparent bg-transparent px-2 text-xs font-semibold transition-colors",
      "text-primary hover:bg-primary/10",
      "group-[.destructive]:text-white group-[.destructive]:hover:bg-white/10",
      "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-0",
      "disabled:pointer-events-none disabled:opacity-50",
      "[-webkit-app-region:no-drag]",
      className,
    )}
    {...props}
  />
));
ToastAction.displayName = ToastPrimitives.Action.displayName;

/* X 버튼 — 항상 인라인(absolute corner 폐기), 항상 노출. */
const ToastClose = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Close>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Close>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Close
    ref={ref}
    className={cn(
      "shrink-0 rounded-sm p-1 opacity-80 transition-opacity",
      "text-foreground/60 hover:text-foreground hover:bg-primary/10",
      "group-[.destructive]:text-white/80 group-[.destructive]:hover:text-white group-[.destructive]:hover:bg-white/10",
      "focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring",
      "[-webkit-app-region:no-drag]",
      className,
    )}
    toast-close=""
    {...props}
  >
    <X className="h-3.5 w-3.5" />
  </ToastPrimitives.Close>
));
ToastClose.displayName = ToastPrimitives.Close.displayName;

const ToastTitle = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Title>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Title>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Title
    ref={ref}
    /* 컴팩트 바에서는 description 이 인라인 보조로 따라붙으므로 title 도
       너무 굵으면 비주얼 비중이 불균형. medium weight 로 본문과 한 호흡. */
    className={cn("truncate text-sm font-medium", className)}
    {...props}
  />
));
ToastTitle.displayName = ToastPrimitives.Title.displayName;

const ToastDescription = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Description>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Description>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Description
    ref={ref}
    /* 인라인 보조 텍스트 — 본문보다 한 단계 dim. truncate 는 wrapper(Toaster)
       의 flex 컨테이너가 min-w-0 일 때 동작. */
    className={cn("truncate text-sm opacity-70", className)}
    {...props}
  />
));
ToastDescription.displayName = ToastPrimitives.Description.displayName;

type ToastProps = React.ComponentPropsWithoutRef<typeof Toast>;

type ToastActionElement = React.ReactElement<typeof ToastAction>;

export {
  type ToastProps,
  type ToastActionElement,
  type ToastPosition,
  ToastProvider,
  ToastViewport,
  Toast,
  ToastTitle,
  ToastDescription,
  ToastClose,
  ToastAction,
};
