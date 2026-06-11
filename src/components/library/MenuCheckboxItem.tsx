/**
 * MenuCheckboxItem — 그리드/캔버스 우클릭 메뉴에서 공유하는 토글 항목.
 *
 * 디자인 통일: 좌측에 *실제 체크박스 모양* 박스(언체크=빈 사각형 / 체크=primary
 * 채움 + ✓) + 카테고리 아이콘을 함께 그려, 두 메뉴가 동일한 시각 언어를 갖는다.
 *
 * 이벤트: onPointerDown 패턴 — Electron + 일부 OS 조합에서 Radix 의 click→onSelect
 * 체인이 mouseup/click 까지 도달하지 않는 회귀를 피한다. preventDefault +
 * stopPropagation 으로 select(닫힘)를 막아 메뉴를 *열린 채로* 유지하므로,
 * 사용자가 여러 옵션을 연달아 토글할 수 있다(설정 패널 UX).
 */
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export function MenuCheckboxItem({
  checked,
  onToggle,
  icon: Icon,
  disabled,
  children,
}: {
  checked: boolean;
  onToggle: () => void;
  icon: React.ComponentType<{ className?: string }>;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <ContextMenuPrimitive.CheckboxItem
      checked={checked}
      disabled={disabled}
      className="relative flex cursor-default select-none items-center gap-2 rounded-none py-1.5 pl-2 pr-2 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 focus:bg-accent focus:text-accent-foreground"
      onPointerDown={(ev) => {
        if (ev.button !== 0 || disabled) return;
        ev.preventDefault();
        ev.stopPropagation();
        onToggle();
      }}
    >
      <span
        className={cn(
          "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-none border transition-colors",
          checked ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/50",
        )}
      >
        {checked ? <Check className="h-3 w-3" /> : null}
      </span>
      <Icon className="h-4 w-4 shrink-0" />
      {children}
    </ContextMenuPrimitive.CheckboxItem>
  );
}
