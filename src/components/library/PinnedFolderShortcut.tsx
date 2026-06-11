import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { PinOff } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FolderMeta } from "@/lib/folderPreferences";
import { resolveFolderColor, resolveFolderIcon } from "./folderIcons";
import type { LibraryFolderRow } from "./LibrarySidebar";
import { useT } from "@/lib/uiLanguage";

/**
 * 사이드바 상단 "Pinned" 영역의 단일 단축. 본 계층의 FolderRow 와는
 * 분리된 가벼운 표현으로:
 *   - chevron 없음 (자식 트리는 본 계층에서 보면 됨)
 *   - 들여쓰기 없음 (어디 깊이의 폴더든 평평하게 단축)
 *   - DnD 미참여 (구조 이동은 본 계층에서만)
 *   - 좌클릭 → 해당 폴더 활성, 우클릭 → "Open" / "Remove from Quick Access"
 *
 * Eagle 의 Quick Access 영역과 같은 의도 — 자주 가는 폴더의 1-click
 * 단축. 본 계층에서는 사라지지 않으므로 사용자가 두 번 보는 일이
 * 있을 수 있지만, 그게 표준 패턴이다(VSCode Open Editors / Finder
 * Sidebar 와 동일).
 */
export interface PinnedFolderShortcutProps {
  row: LibraryFolderRow;
  isActive: boolean;
  meta: FolderMeta;
  /** 좌클릭 — 폴더 활성/비활성 토글. 이미 활성 상태면 해제(=All Items). */
  onActivate: () => void;
  /** 우클릭 메뉴 "Open folder" — 항상 폴더를 활성화한다. 토글 X.
   *  활성 상태에서 호출되면 사실상 no-op 이지만, 사용자 의도상
   *  "이 폴더를 본다" 가 맞으므로 절대 비활성으로 떨어뜨리지 않는다. */
  onOpen: () => void;
  onUnpin: () => void;
}

export function PinnedFolderShortcut({
  row,
  isActive,
  meta,
  onActivate,
  onOpen,
  onUnpin,
}: PinnedFolderShortcutProps) {
  const t = useT();
  const color = resolveFolderColor(meta.color);
  const iconOption = resolveFolderIcon(meta.icon);
  const Icon = iconOption.Icon;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={onActivate}
          className={cn(
            "group flex w-full items-center gap-2 px-3 py-1.5 text-left text-body border-l-2 transition-colors",
            isActive
              ? "border-l-primary bg-primary/10 text-foreground"
              : "border-l-transparent text-foreground/80 hover:bg-muted/40 hover:text-foreground",
          )}
          title={row.tag.replace(/^folder:/, "")}
        >
          <span
            className={cn(
              "flex h-5 w-5 shrink-0 items-center justify-center rounded-none",
              color.bgClass,
              color.fgClass,
            )}
          >
            <Icon className="h-3 w-3" />
          </span>
          <span className="line-clamp-1 flex-1">{row.label}</span>
          <span className="ml-2 shrink-0 tabular-nums text-caption text-text-tertiary">
            {row.count}
          </span>
        </button>
      </ContextMenuTrigger>

      <ContextMenuContent className="min-w-52 rounded-none">
        <ContextMenuItem onSelect={onOpen}>{t("library.pinned.openFolder")}</ContextMenuItem>
        <ContextMenuItem onSelect={onUnpin}>
          <PinOff className="mr-2 h-3.5 w-3.5" />
          {t("library.folder.removeFromQuickAccess")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
