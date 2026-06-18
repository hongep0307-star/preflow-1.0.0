/**
 * Preload script — 렌더러(브라우저 컨텍스트) 에서 사용할 수 있는 안전한
 * Electron API 를 `contextBridge` 로 노출한다.
 *
 * 현재는 윈도우 컨트롤(─ □ ×) 하나만 노출. `titleBarOverlay` 가 OS 가
 * 그리는 ─ □ × 를 강제로 윈도우 최상단(y=0) 부터 배치하기 때문에 ─
 * 네비바 높이를 키우면 버튼이 위쪽으로 치우치고, 호버 박스도 네비바
 * 전체 높이를 덮어 정사각형이 안 나온다. 그래서 native overlay 대신
 * React 가 직접 그리는 커스텀 ─ □ × 컴포넌트(WindowControls.tsx) 가
 * 호출할 IPC 채널만 이 파일이 책임진다.
 *
 * macOS 의 traffic light(빨/노/초) 는 `titleBarStyle: "hiddenInset"` 으로
 * OS 가 좌상단에 그대로 그려주므로 이 API 를 macOS 에서 사용할 필요가
 * 없다 — WindowControls 컴포넌트가 `platform-mac` 일 때 자기 자신을
 * 렌더하지 않는 것으로 충분히 분리된다.
 */
import { contextBridge, ipcRenderer, webUtils } from "electron";

const api = {
  minimize: (): void => {
    ipcRenderer.send("preflow-window:minimize");
  },
  toggleMaximize: (): void => {
    ipcRenderer.send("preflow-window:toggle-maximize");
  },
  close: (): void => {
    ipcRenderer.send("preflow-window:close");
  },
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke("preflow-window:is-maximized"),
  /**
   * 윈도우 maximize/unmaximize 상태가 바뀔 때마다 호출되는 listener 등록.
   * 반환값은 unsubscribe 함수.
   */
  onMaximizeChange: (cb: (maximized: boolean) => void): (() => void) => {
    const listener = (_e: unknown, maximized: boolean) => cb(maximized);
    ipcRenderer.on("preflow-window:maximized-changed", listener);
    return () => {
      ipcRenderer.removeListener("preflow-window:maximized-changed", listener);
    };
  },
  /**
   * Electron 32+ 부터 `File.path` 는 제거되었기 때문에 dragged file/folder 의
   * 절대경로가 필요할 때는 `webUtils.getPathForFile` 을 통해서 받아야 한다.
   * 폴더 드래그-드랍에서 Eagle Library 자동 감지 + 미디어 재귀 수집을 하기
   * 위해 렌더러에 노출. 빈 문자열을 반환하면 호출 측이 fallback(예: HTML
   * `webkitGetAsEntry`) 을 시도한다.
   */
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  /**
   * OS-level file copy — 선택한 파일들을 시스템 클립보드에 *파일 객체* 로
   * 등록한다(탐색기/Finder 에서 Ctrl+V 로 붙여넣으면 진짜 파일이 복사됨).
   * Web Clipboard API 는 video/* 같은 임의 MIME 을 지원하지 않으므로,
   * 영상 등을 "Eagle 식으로" 복사하려면 이 네이티브 경로가 필요하다.
   *
   * Windows 는 CF_HDROP, macOS 는 public.file-url / NSFilenamesPboardType
   * 포맷으로 메인 프로세스가 직접 클립보드에 기록한다. 성공 시 true.
   * 실패하거나 미지원 플랫폼이면 false 를 반환해 호출부가 텍스트 폴백을
   * 시도하도록 한다.
   */
  copyFilesToClipboard: (filePaths: string[]): Promise<boolean> =>
    ipcRenderer.invoke("preflow-clipboard:copy-files", filePaths),
  /**
   * navigator.clipboard.read() 는 컨텍스트 메뉴 클릭 직후 문서 포커스가
   * 메뉴에 있어 자주 NotAllowedError 로 거부된다. Electron 의 네이티브
   * clipboard.readImage() 는 권한 게이팅 없이 동작하므로, "From clipboard"
   * 같은 액션에서 사용. PNG 바이트(Uint8Array) 로 반환되며, 이미지가 없으면
   * null. 호출부는 `new Blob([bytes], { type: "image/png" })` 로 감싸 Web
   * API 흐름에 합류시킨다.
   */
  readClipboardImage: (): Promise<Uint8Array | null> =>
    ipcRenderer.invoke("preflow-clipboard:read-image"),
  /**
   * 탐색기/Finder 에서 이미지 *파일* 을 Ctrl/Cmd+C 한 경우(클립보드에 비트맵이
   * 아니라 파일 경로 목록이 들어감). OS 내장 도구로 경로를 읽어 첫 이미지
   * 파일의 바이트 + MIME + 파일명을 반환한다. 이미지 파일이 없으면 null.
   * 호출부는 `readClipboardImage()`(비트맵) 가 비었을 때 fallback 으로 쓴다.
   */
  readClipboardImageFile: (): Promise<{ bytes: Uint8Array; mime: string; name: string } | null> =>
    ipcRenderer.invoke("preflow-clipboard:read-image-file"),
  /**
   * OS-level drag-out — HTML5 `dragstart` 핸들러 안에서 호출하면 Electron 이
   * 즉시 OS 가 인식하는 파일 드래그로 인계받는다. 사용자는 Photoshop·
   * Premiere·탐색기·Finder·바탕화면·메신저 등 어떤 외부 앱에도 라이브러리
   * 자료를 그대로 떨어뜨릴 수 있다.
   *
   * `items` 는 카드 한 장당 메타. file 자료는 `fileUrl` 만 채우고, URL 자료
   * (YouTube/link bookmark) 는 `sourceUrl` 만 채워 넘기면 메인이 임시
   * `.url` (Windows 인터넷 바로가기) 파일을 materialize 해 끌어준다 —
   * Eagle 과 동일한 패턴. `title` 은 임시 파일명 prefix 로 사용.
   * `iconUrl` 은 드래그 미리보기 썸네일. 비어 있으면 메인이 첫 파일 또는
   * 기본 아이콘으로 폴백한다.
   *
   * ⚠ 반드시 **동기 IPC (sendSync)** — Windows OLE drag 는 `dragstart`
   * 핸들러가 *반환되는 시점* 에 시작되므로, 그 전에 메인이 startDrag 를
   * 호출해 파일 페이로드를 attach 해 둬야 OS 가 "파일 드래그" 로 인식한다.
   * 비동기 send 로는 OLE 가 페이로드 없는 HTML5 drag 로 먼저 출발해 Slack/
   * 탐색기 등이 거부한다.
   *
   * ⚠ 호출 측은 `event.preventDefault()` 를 호출하면 안 된다 — 그렇게 하면
   * HTML5 drag 비주얼이 끊겨 내부 폴더/카드 drop 도 firing 되지 않는다.
   * preventDefault 없이 두면 OS 는 OLE 의 파일 페이로드(외부 destination
   * 용) 와 HTML5 dataTransfer (내부 drop 식별 용) 를 모두 운반한다.
   *
   * 메인이 실패해도 dataTransfer 의 text/uri-list 가 살아 있어 Slack 채팅
   * 입력 등은 받아준다. 강한 파일 전송 폴백은 우클릭 메뉴의 "Copy"
   * (CF_HDROP 클립보드).
   */
  startDragOut: (
    items: Array<{
      fileUrl?: string | null;
      sourceUrl?: string | null;
      title?: string | null;
    }>,
    iconUrl: string | null,
  ): boolean => {
    try {
      const ok = ipcRenderer.sendSync("preflow-drag:start", { items, iconUrl });
      return ok === true;
    } catch {
      return false;
    }
  },
  /**
   * ZIP/EXE/HTML 같이 자연 미리보기가 없는 doc 자료의 *OS 셸(파일 연결) 아이콘*
   * 을 PNG 로 받아온다. Electron 메인의 `app.getFileIcon` 을 호출해야 하므로
   * 임시 파일을 만든 뒤 그 경로로 추출한다 — 파일 *바이트* 를 함께 넘기는 이유
   * 는 EXE/MSI 의 임베디드 아이콘 (앱 로고) 이 바이트 의존이기 때문.
   *
   * 추출 실패(미지원 플랫폼, 빈 NativeImage 등) 시 null. 호출부는 generic
   * hue 카드로 자연 폴백한다.
   */
  getFileIcon: (filename: string, bytes: Uint8Array): Promise<Uint8Array | null> =>
    ipcRenderer.invoke("preflow-doc:get-file-icon", { filename, bytes }),
  /**
   * 영상 트랜스코딩 — 원본 디스크 경로를 받아 ffmpeg 로 목표 용량 이하 mp4 로
   * 재인코딩하고, references 버킷의 scratch 경로(상대)를 돌려준다. 진행률은
   * `onTranscodeProgress` 로 별도 스트리밍되며, `cancelTranscode(id)` 로 중단.
   */
  transcodeVideo: (args: {
    id: string;
    inputPath: string;
    durationSec: number;
    targetBytes: number;
  }): Promise<{ ok: true; scratchRelPath: string } | { ok: false; reason: string }> =>
    ipcRenderer.invoke("preflow-video:transcode", args),
  /** 트랜스코딩 진행률 구독. 반환값은 unsubscribe 함수. */
  onTranscodeProgress: (cb: (p: { id: string; ratio: number }) => void): (() => void) => {
    const listener = (_e: unknown, p: { id: string; ratio: number }) => cb(p);
    ipcRenderer.on("preflow-video:transcode-progress", listener);
    return () => {
      ipcRenderer.removeListener("preflow-video:transcode-progress", listener);
    };
  },
  /** 진행 중인 트랜스코딩 취소(ffmpeg 프로세스 kill). */
  cancelTranscode: (id: string): void => {
    ipcRenderer.send("preflow-video:transcode-cancel", id);
  },
  /**
   * 영상 포스터(첫 프레임) 추출 — 브라우저 <video> 가 디코드 못 하는 코덱
   * (ProRes/HEVC MOV 등) 의 첫 프레임을 ffmpeg 로 PNG 로 뽑아 references 버킷
   * scratch 경로(상대) + 길이/해상도를 돌려준다. 렌더러는 /storage/file/ 로
   * 다시 fetch 해 thumbnail 로 업로드한다.
   */
  extractVideoPoster: (args: {
    id: string;
    inputPath: string;
  }): Promise<
    | { ok: true; scratchRelPath: string; durationSec: number; width: number; height: number }
    | { ok: false; reason: string }
  > => ipcRenderer.invoke("preflow-video:extract-poster", args),
};

contextBridge.exposeInMainWorld("preflowWindow", api);

export type PreflowWindowApi = typeof api;
