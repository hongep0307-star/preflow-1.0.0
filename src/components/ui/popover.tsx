import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "@/lib/utils";

const Popover = PopoverPrimitive.Root;

const PopoverTrigger = PopoverPrimitive.Trigger;

/* Radix 의 auto-focus 동작 기본 비활성화 — 마우스로 popover trigger 를 클릭해
   열 때 첫 자식이 자동 focus 되어 focus-visible ring 이 뜨거나, ESC 로 닫힐
   때 trigger 로 focus 가 복원되며 trigger 에 ring 이 뜨는 시각 소음을 제거.
   브라우저는 키보드 이벤트 체인 안에서 발생한 .focus() 호출을 "키보드 유발"
   focus 로 간주해 :focus-visible 매칭이 일어나므로, CSS 만으로는 회피 불가
   능 — Radix 단에서 auto-focus 자체를 막아야 한다.

   다만 preventDefault 만으로는 부족한 케이스가 있다 — 마우스 클릭으로
   trigger 에 focus 가 박힌 직후 onOpenAutoFocus 를 prevent 하면, focus 가
   trigger 에 그대로 남는다. 그 상태에서 ESC 를 누르면 ESC 라는 *키보드*
   이벤트로 인해 trigger 가 :focus-visible 로 매칭되어 ring 이 뜬다.
   따라서 onCloseAutoFocus 단계에서 명시적으로 activeElement.blur() 까지
   호출해야 한다 — focus 를 body 로 보내면 ring 자체가 사라진다.

   소비자가 명시적으로 콜백을 넘기면 그 콜백이 (스프레드 순서로) 우선. */
const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "center", sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      onOpenAutoFocus={(event) => event.preventDefault()}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      }}
      className={cn(
        "z-50 w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverContent };
