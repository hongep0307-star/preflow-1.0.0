import { useEffect, useState } from "react";
import { Minus, Square, X } from "lucide-react";
import { useT } from "@/lib/uiLanguage";

/**
 * 커스텀 윈도우 컨트롤 — Windows / Linux 전용. macOS 는 native traffic
 * light 가 좌상단에 그려지므로 렌더하지 않는다.
 *
 * Electron 기본 `titleBarOverlay` 가 ─ □ × 를 윈도우 최상단(y=0) 에
 * 강제 배치하는 한계 때문에 — 네비바를 키우면 버튼이 위로 치우치고
 * 호버 박스도 네비바 전체 높이를 덮어 정사각형이 안 나옴 — preload 의
 * IPC 채널을 통해 React 가 직접 그린다.
 *
 * UX 디자인:
 * - 버튼 컨테이너 폭 46px × 네비바 전체 높이 (Win11 캡션 버튼 폭에 맞춤).
 * - 호버 박스는 32×32 정사각형 + 중앙 정렬 → 네비바 상단/하단으로 여백
 *   균등하게 떨어져 Eagle 같은 외관이 나옴.
 * - 닫기 버튼은 호버 시 Windows 관행대로 #E81123 으로 변함.
 * - `-webkit-app-region: no-drag` 로 드래그 영역 안에서도 클릭 가능.
 */

declare global {
  interface Window {
    preflowWindow?: {
      minimize: () => void;
      toggleMaximize: () => void;
      close: () => void;
      isMaximized: () => Promise<boolean>;
      onMaximizeChange: (cb: (maximized: boolean) => void) => () => void;
      /** Electron 32+ 에서 dragged File 의 절대경로를 얻기 위한 헬퍼.
       *  실패 시 빈 문자열을 반환 — 호출 측이 fallback 을 결정. */
      getPathForFile?: (file: File) => string;
      /** OS-level file copy — 절대경로 배열을 시스템 클립보드에 *파일 객체*
       *  로 등록한다(탐색기/Finder 에서 Ctrl+V 로 진짜 파일 복사). 영상 등
       *  Web Clipboard API 가 미지원하는 MIME 을 Eagle 식으로 복사하기
       *  위해 사용. 성공 true / 실패·미지원 false. */
      copyFilesToClipboard?: (filePaths: string[]) => Promise<boolean>;
      /** Electron 네이티브 clipboard.readImage() — 컨텍스트 메뉴 흐름에서
       *  navigator.clipboard.read() 가 포커스/권한 문제로 실패하는 경우의
       *  안전한 대체 경로. 클립보드 이미지를 PNG 바이트로 반환하고,
       *  이미지가 없으면 null. */
      readClipboardImage?: () => Promise<Uint8Array | null>;
      /** 탐색기/Finder 에서 이미지 파일을 Ctrl/Cmd+C 한 경우(클립보드에 비트맵이
       *  아니라 파일 경로가 들어감)의 fallback. 첫 이미지 파일의 바이트 + MIME +
       *  파일명을 반환하고, 이미지 파일이 없으면 null. */
      readClipboardImageFile?: () => Promise<{ bytes: Uint8Array; mime: string; name: string } | null>;
      /** OS-level drag-out — HTML5 dragstart 핸들러 안에서 호출하면 Electron
       *  이 즉시 OS 가 인식하는 파일 드래그로 인계받는다. Photoshop·탐색기·
       *  Finder·바탕화면 등 외부 앱에 라이브러리 자료를 그대로 드롭 가능.
       *
       *  `items` 는 카드 한 장당 메타. 파일 자료는 `fileUrl` 만 채우고
       *  URL 자료(YouTube/link bookmark) 는 `sourceUrl` 만 채워 넘긴다
       *  — 메인이 임시 `.url` 인터넷 바로가기 파일을 만들어 인계.
       *  `title` 은 임시 파일명 prefix.
       *
       *  true 면 OS 드래그가 정상 시작, false 면 (예: 파일/URL 무효)
       *  HTML5 폴백으로 처리해야 한다. */
      startDragOut?: (
        items: Array<{
          fileUrl?: string | null;
          sourceUrl?: string | null;
          title?: string | null;
        }>,
        iconUrl: string | null,
      ) => boolean;
      /** ZIP/EXE/HTML/code/audio 처럼 자연 미리보기가 없는 doc 자료의 OS
       *  셸 아이콘을 PNG 로 추출한다. 메인이 임시 파일을 만들어 `app.
       *  getFileIcon` 으로 뽑은 뒤 즉시 정리한다. 추출 실패 시 null. */
      getFileIcon?: (filename: string, bytes: Uint8Array) => Promise<Uint8Array | null>;
      /** 300MB 초과 영상을 ffmpeg 로 목표 용량 이하 mp4 로 재인코딩한다. 입력은
       *  원본 디스크 경로(getPathForFile). 성공 시 references 버킷의 scratch
       *  상대경로를 반환 — 렌더러가 /storage/file/ 로 다시 fetch 해 업로드한다. */
      transcodeVideo?: (args: {
        id: string;
        inputPath: string;
        durationSec: number;
        targetBytes: number;
      }) => Promise<{ ok: true; scratchRelPath: string } | { ok: false; reason: string }>;
      /** 트랜스코딩 진행률(0~1) 구독. 반환값은 unsubscribe 함수. */
      onTranscodeProgress?: (cb: (p: { id: string; ratio: number }) => void) => () => void;
      /** 진행 중인 트랜스코딩 취소. */
      cancelTranscode?: (id: string) => void;
    };
  }
}

const RestoreIcon = ({ size = 11 }: { size?: number }) => (
  // 두 사각형이 겹친 Windows "Restore Down" 글리프. lucide 의 Copy 가
  // 모서리 둥글기 때문에 인라인 SVG 로 정확한 모양을 그린다.
  <svg
    width={size}
    height={size}
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    aria-hidden
  >
    <rect x="2.5" y="3.5" width="6.5" height="6" />
    <path d="M4 3.5 V1.5 H10.5 V8 H8.5" />
  </svg>
);

export function WindowControls() {
  const t = useT();
  // SSR / Electron-less 환경(웹 빌드, 테스트) 에서는 렌더링하지 않는다.
  const hasApi = typeof window !== "undefined" && !!window.preflowWindow;
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!hasApi) return;
    const api = window.preflowWindow!;
    void api.isMaximized().then(setIsMaximized);
    return api.onMaximizeChange(setIsMaximized);
  }, [hasApi]);

  if (!hasApi) return null;
  // macOS 는 platform-mac 클래스가 html 에 붙어 있을 때 native traffic
  // light 가 좌상단에 자동 배치된다. 거기서 ─ □ × 를 또 그리면 buttons
  // 가 중복되므로 숨김.
  if (
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("platform-mac")
  ) {
    return null;
  }

  const api = window.preflowWindow!;

  return (
    <div className="window-controls" data-no-drag>
      <button
        type="button"
        onClick={() => api.minimize()}
        className="window-ctrl"
        aria-label={t("window.minimize")}
        title={t("window.minimize")}
      >
        <span className="window-ctrl-box">
          <Minus className="w-3 h-3" strokeWidth={2} />
        </span>
      </button>
      <button
        type="button"
        onClick={() => api.toggleMaximize()}
        className="window-ctrl"
        aria-label={isMaximized ? t("window.restore") : t("window.maximize")}
        title={isMaximized ? t("window.restore") : t("window.maximize")}
      >
        <span className="window-ctrl-box">
          {isMaximized ? <RestoreIcon size={11} /> : <Square className="w-[11px] h-[11px]" strokeWidth={1.8} />}
        </span>
      </button>
      <button
        type="button"
        onClick={() => api.close()}
        className="window-ctrl window-ctrl-close"
        aria-label={t("window.close")}
        title={t("window.close")}
      >
        <span className="window-ctrl-box">
          <X className="w-[14px] h-[14px]" strokeWidth={2} />
        </span>
      </button>
    </div>
  );
}
