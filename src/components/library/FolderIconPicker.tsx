import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DEFAULT_FOLDER_COLOR_ID,
  DEFAULT_FOLDER_ICON_ID,
  FOLDER_COLORS,
  FOLDER_ICONS,
  resolveFolderColor,
} from "./folderIcons";

/**
 * 폴더 색·아이콘을 한 번에 고르는 작은 팔레트.
 *
 * 두 곳에서 재사용:
 *  1) FolderRow 의 좌측 아이콘 버튼을 좌클릭했을 때 뜨는 Popover 콘텐츠
 *  2) 우클릭 컨텍스트 메뉴의 "Change Icon" 서브메뉴 콘텐츠
 *
 * 정책:
 *  - 색상 / 아이콘은 클릭 즉시 반영 (확정 버튼 없음 — Eagle 동일).
 *    네트워크 호출이 없는 LocalStorage 작업이라 확정 단계가 의미 없음.
 *  - "Reset" 으로 메타 전체 삭제 → 기본 아이콘+컬러 복원.
 *  - 키보드 접근성: 각 swatch / icon 버튼은 진짜 <button> 이라 Tab
 *    이동 + Enter 작동. Popover 자체는 Radix 가 focus trap 처리.
 */

interface FolderIconPickerProps {
  /** 현재 선택된 색 id. undefined 면 기본값으로 표시. */
  colorId?: string;
  /** 현재 선택된 아이콘 id. undefined 면 기본값. */
  iconId?: string;
  /** 색 변경 콜백. 호출처에서 setFolderMeta + 상태 갱신을 책임진다. */
  onSelectColor: (id: string) => void;
  /** 아이콘 변경 콜백. */
  onSelectIcon: (id: string) => void;
  /** 메타 전체 초기화. clearFolderMeta 호출용. */
  onReset?: () => void;
}

export function FolderIconPicker({
  colorId,
  iconId,
  onSelectColor,
  onSelectIcon,
  onReset,
}: FolderIconPickerProps) {
  const activeColorId = colorId ?? DEFAULT_FOLDER_COLOR_ID;
  const activeIconId = iconId ?? DEFAULT_FOLDER_ICON_ID;
  // resolved color 의 fgClass 를 아이콘 grid 의 selected ring 색으로
  // 그대로 빌려와, "지금 이 폴더는 어떤 색이고 어떤 글리프냐" 를 한
  // 화면에서 확인할 수 있게 한다.
  const activeColor = resolveFolderColor(activeColorId);

  return (
    <div className="w-[224px] p-2">
      {/* ── Color swatches ── */}
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="text-2xs font-semibold tracking-normal text-muted-foreground">
          Color
        </span>
        {onReset ? (
          <button
            type="button"
            onClick={onReset}
            className="flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground transition-colors"
            title="Reset to default"
          >
            <RotateCcw className="h-3 w-3" />
            Reset
          </button>
        ) : null}
      </div>
      <div className="mb-3 grid grid-cols-10 gap-1.5 px-1">
        {FOLDER_COLORS.map((color) => {
          const isActive = activeColorId === color.id;
          return (
            <button
              key={color.id}
              type="button"
              onClick={() => onSelectColor(color.id)}
              title={color.label}
              aria-label={`Color: ${color.label}`}
              className={cn(
                "h-4 w-4 rounded-full transition-all",
                color.swatchClass,
                isActive
                  ? "ring-2 ring-foreground ring-offset-1 ring-offset-popover scale-110"
                  : "hover:scale-110",
              )}
            />
          );
        })}
      </div>

      {/* ── Icon grid ── */}
      <div className="mb-1.5 px-1 text-2xs font-semibold tracking-normal text-muted-foreground">
        Icon
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {FOLDER_ICONS.map((option) => {
          const isActive = activeIconId === option.id;
          const Icon = option.Icon;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => onSelectIcon(option.id)}
              title={option.label}
              aria-label={`Icon: ${option.label}`}
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-none transition-colors",
                isActive
                  ? cn("bg-muted", activeColor.fgClass)
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          );
        })}
      </div>
    </div>
  );
}
