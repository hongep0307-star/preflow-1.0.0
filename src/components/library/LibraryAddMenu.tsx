import { FolderOpen, Link2, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useT } from "@/lib/uiLanguage";

interface LibraryAddMenuProps {
  /**
   * Choose Files > Folder 분기 또는 Eagle 미리보기/import 가 진행 중일 때 true.
   * Files / Paste URL 항목은 자유롭게 쓸 수 있어야 하므로 Folder 항목만
   * 비활성화 한다.
   */
  folderBusy: boolean;
  onChooseFiles: () => void;
  onChooseFolder: () => void;
  onPasteUrl: () => void;
}

/* ───────── 메뉴 시각 토큰 ─────────
 * Add 버튼이 라이브러리 사이드바 안에 있어서, 기본 popover 색(--popover, 8%
 * 회색)이 사이드바 색(--surface-sidebar, 4% 회색)과 4 포인트밖에 차이 나지
 * 않아 메뉴 경계가 사이드바와 거의 구분되지 않았다(첫 스크린샷 이슈).
 *
 * 1) 메뉴 본체를 한 단계 더 밝은 surface-elevated(11%) 로 띄우고
 * 2) 상단 2px 브랜드 라인으로 "팝업 카드" 라는 시각 단서를 주고
 * 3) shadow-2xl 로 사이드바 위로 확실히 떠 보이게 하고
 * 4) sideOffset 6 으로 Add 버튼 바로 아래에 살짝 띄워 분리감을 살린다. */
const ADD_MENU_CLASSES =
  "w-56 rounded-none p-1.5 bg-surface-elevated border-t-2 border-t-primary border-x border-b border-border-subtle shadow-2xl shadow-black/70";
const ADD_MENU_SUB_CLASSES =
  "w-44 rounded-none p-1.5 bg-surface-elevated border-t-2 border-t-primary border-x border-b border-border-subtle shadow-2xl shadow-black/70";
/** 행 자체도 사이드바 quick-filter 목록(높이 비슷, py-1.5)과 시각적으로 분리
 *  되도록 살짝 더 키운다. 메뉴는 짧고(2~3 항목) 길이 비용도 적다. */
const ADD_MENU_ITEM_CLASSES = "py-2 text-body";

export function LibraryAddMenu({
  folderBusy,
  onChooseFiles,
  onChooseFolder,
  onPasteUrl,
}: LibraryAddMenuProps) {
  const t = useT();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className="h-9 w-full gap-2 text-meta" style={{ borderRadius: 0 }}>
          <Upload className="h-4 w-4" />
          {t("library.addMenu.trigger")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={6}
        className={ADD_MENU_CLASSES}
      >
        {/* Choose Files 는 단순 액션이 아니라 "Files / Folder" 두 갈래로
            나뉘는 진입점. submenu 로 묶어 메인 메뉴를 단순하게 유지한다.
            폴더는 Eagle Library / 일반 폴더를 알아서 구분해서 흡수. */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className={ADD_MENU_ITEM_CLASSES}>
            <Upload className="mr-2 h-4 w-4 text-primary" />
            {t("library.addMenu.chooseFiles")}
          </DropdownMenuSubTrigger>
          <DropdownMenuPortal>
            <DropdownMenuSubContent className={ADD_MENU_SUB_CLASSES}>
              <DropdownMenuItem onSelect={onChooseFiles} className={ADD_MENU_ITEM_CLASSES}>
                <Upload className="mr-2 h-4 w-4 text-primary" />
                {t("library.addMenu.files")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={onChooseFolder}
                disabled={folderBusy}
                className={ADD_MENU_ITEM_CLASSES}
              >
                {folderBusy ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin text-primary" />
                ) : (
                  <FolderOpen className="mr-2 h-4 w-4 text-primary" />
                )}
                {t("library.addMenu.folder")}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
        <DropdownMenuItem onSelect={onPasteUrl} className={ADD_MENU_ITEM_CLASSES}>
          <Link2 className="mr-2 h-4 w-4 text-primary" />
          {t("library.addMenu.pasteUrl")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
