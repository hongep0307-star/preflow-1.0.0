import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, protocol, session, shell } from "electron";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { closeDb } from "./db";
import { startLocalServer } from "./local-server";
import { getLocalServerAuthToken, getLocalServerPort, REAL_UA } from "./constants";
import { getStorageBasePath } from "./paths";
import { initWorkspace, shutdownWorkspace } from "./workspace";
import { sweepOrphanFiles } from "./orphanSweep";
import { MAX_VIDEO_DURATION_SEC, REFERENCE_UPLOAD_MAX_BYTES } from "../shared/constants";

// ── Native OLE drag-out addon (v2 — Phase 0) ───────────────────────────────
// Windows 전용 OLE drag source. Electron 33 의 `webContents.startDrag` 가
// .png/.jpg/.jpeg/.webp/.bmp 경로를 만나면 자동으로 image dataObject 를
// 첨부해 Chromium 의 image-content cursor mode (빨간 ⓧ) 를 켜는 quirk 를
// 우회하기 위해 IDataObject(CF_HDROP only) + IDropSource
// (DRAGDROP_S_USEDEFAULTCURSORS) 를 직접 구현했음.
//
// **v1 사고 (2026-05-14)**: libuv AsyncWorker 패턴으로 `DoDragDrop` 을 worker
// thread 에서 호출 → SetCapture 실패 → 영구 deadlock → 앱 freeze. 폐기.
//
// **v2 (2026-06-05, Phase 0)**: `DoDragDrop` 을 *메인 UI thread* 에서 동기
// 호출. 메인 스레드가 BrowserWindow 를 소유해 SetCapture 가 성공한다. IPC
// 핸들러가 `event.returnValue` 를 *먼저* set 한 뒤 `startDrag` 를 호출하므로,
// 렌더러 dragstart 는 즉시 unblock 되고 메인은 drag 동안 블록된다.
//   Phase 0 검증: (1) freeze 재발 없음, (2) drag 동안 렌더러 dragover/drop
//   생존(내부 폴더 이동). 자세한 절차는 DRAG-AND-DROP-RESEARCH.md §B-v2.
//
// 플랫폼별 네이티브 드래그 경로:
//   - Windows: OLE DoDragDrop (addon.cc) — image-mode cursor quirk 우회.
//   - macOS:   NSDraggingSession (addon_mac.mm) — webContents.startDrag 폴백의
//              종료 콜백 미발동 → mouse capture stuck(hang) 회피.
//   - 그 외 OS: index.js 가 null 반환 → webContents.startDrag 폴백.
type NativeDragResult = {
  ok: boolean;
  effect: number;
  hr: number;
  elapsedMs: number;
  threadId: number;
};
type NativeDragAddon = {
  /** Windows 는 drop/cancel 까지 *동기 블록* 후 결과 반환(호출 전 sendSync 응답
   *  필수). macOS 는 *비동기* — 세션 시작 직후 즉시 반환하고 run loop 가 드래그를
   *  구동(반환의 ok=세션 시작 성공 여부). 두 번째 인자는
   *  BrowserWindow.getNativeWindowHandle() (win=HWND / mac=NSView*). */
  startDrag: (paths: string[], handle?: Buffer) => NativeDragResult;
  DROPEFFECT_NONE: number;
  DROPEFFECT_COPY: number;
  DROPEFFECT_MOVE: number;
  DROPEFFECT_LINK: number;
};
let nativeDragAddon: NativeDragAddon | null = null;
try {
  // 빌드된 .node 의 위치는 `<repo>/native/drag-out/build/Release/preflow_drag_out.node`.
  // 패키징되면 asar 바깥의 동일 상대 경로 (electron-builder files 에 명시).
  // 개발에서는 dist-electron 이 repo 안에 있으므로 ../native/... 로 도달.
  const candidate = path.join(__dirname, "..", "native", "drag-out");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const loaded = require(candidate) as NativeDragAddon | null;
  if (loaded && typeof loaded.startDrag === "function") {
    nativeDragAddon = loaded;
    console.log(
      `[native-drag] addon loaded (platform=${process.platform}: ` +
        (process.platform === "darwin"
          ? "NSDraggingSession"
          : "OLE DoDragDrop") +
        ")",
    );
  } else {
    console.log("[native-drag] addon returned null — webContents.startDrag fallback will be used");
  }
} catch (err) {
  nativeDragAddon = null;
  console.warn(
    "[native-drag] addon load failed — webContents.startDrag fallback will be used:",
    (err as Error)?.message ?? err,
  );
}

const profile = process.env.PREFLOW_PROFILE?.trim();
// `PREFLOW_PROFILE=production` 은 *격리 해제* 명시 토큰 — dev 가 production
// userData(`appData/preflow/`) 를 그대로 보는 escape hatch 다. PowerShell 의
// `$env:VAR = ""` 가 spawn 시 변수를 제거해 wait-and-electron.mjs 의 fallback
// 이 다시 발동하는 cross-platform 문제 때문에 빈 문자열 대신 명시 토큰을
// 쓴다. 그 외 비어 있지 않은 모든 값(`dev`, `qa`, `staging` …)은 그 이름으로
// `appData/preflow-<value>/` 격리.
if (profile && profile !== "production") {
  const profileName = `preflow-${profile}`;
  app.setName(profileName);
  app.setPath("userData", path.join(app.getPath("appData"), profileName));
  console.log(`[profile] Using isolated userData: ${app.getPath("userData")}`);
} else if (profile === "production") {
  console.warn(
    `[profile] PREFLOW_PROFILE=production — dev is sharing production userData at ${app.getPath("userData")}.`,
  );
} else if (process.env.VITE_DEV_SERVER_URL) {
  console.warn("[profile] PREFLOW_PROFILE is not set. Development is using production userData.");
}

// Chromium의 native UI(달력 피커, context menu 등) 언어를 영문으로 강제.
// app.whenReady() 이전에 호출되어야 적용됨.
app.commandLine.appendSwitch("lang", "en-US");

// ── Single-instance lock ──────────────────────────────────────────
// 두 번째 실행 시 새 Electron 프로세스를 띄우지 않고, 기존 창에 포커스를
// 주는 것으로 교체. 이 작업이 없으면 두 번째 인스턴스가 19876 포트 바인딩
// 에서 EADDRINUSE 로 크래시한다.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

// 부팅/런타임의 미처리 promise rejection 을 콘솔에 남긴다. 과거 잠금 충돌이
// whenReady 콜백을 reject 시켜 "조용한 죽은 부팅" 이 됐을 때 단서가 전혀 없었다.
process.on("unhandledRejection", (reason) => {
  console.error("[main] unhandledRejection:", reason);
});

let mainWindow: BrowserWindow | null = null;

const DIST = path.join(__dirname, "../dist");

// ── 팩 파일(.preflowlib / .preflowproj) 더블클릭 열기 ───────────────────────
// OS 가 파일 연결로 앱을 띄우면서 넘겨주는 팩 경로를 받아 렌더러로 전달한다.
//   · Windows: 첫 실행은 process.argv 끝에, 이미 실행 중이면 second-instance 의
//     argv 에 경로가 들어온다.
//   · macOS: open-file 이벤트(앱 ready 이전에 올 수 있어 모듈 로드 시 일찍 등록).
// 렌더러가 아직 mount 전이면 push 해도 유실되므로, 렌더러가 부팅 시 한 번
// pull(get-pending) 하고 이후엔 push(onOpenPack) 로 받는 이중 채널을 둔다.
let pendingPackPath: string | null = null;
let packRendererReady = false;

function extractPackPathFromArgv(argv: string[]): string | null {
  for (const arg of argv) {
    if (typeof arg !== "string") continue;
    const lower = arg.toLowerCase();
    if (lower.endsWith(".preflowlib") || lower.endsWith(".preflowproj")) {
      try {
        if (fs.existsSync(arg)) return arg;
      } catch {
        /* 접근 불가 경로 — 무시 */
      }
    }
  }
  return null;
}

function deliverPendingPack(): void {
  if (!pendingPackPath || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("preflow-pack:open", pendingPackPath);
  pendingPackPath = null;
}

function setPendingPack(p: string | null): void {
  if (!p) return;
  const lower = p.toLowerCase();
  if (!lower.endsWith(".preflowlib") && !lower.endsWith(".preflowproj")) return;
  pendingPackPath = p;
  // 렌더러가 이미 살아 있으면(웜 스타트) 곧장 push, 아니면 pull 을 기다린다.
  if (packRendererReady) deliverPendingPack();
}

// 콜드 스타트(Windows): 첫 실행 argv 에서 팩 경로 추출.
pendingPackPath = extractPackPathFromArgv(process.argv);

// macOS: Finder 더블클릭 / Dock 드롭. ready 이전에도 올 수 있어 모듈 로드 시 등록.
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  setPendingPack(filePath);
});

// 렌더러가 부팅 시 1회 호출 — 대기 중인 팩 경로를 가져가며 ready 로 표시한다.
ipcMain.handle("preflow-pack:get-pending", () => {
  packRendererReady = true;
  const p = pendingPackPath;
  pendingPackPath = null;
  return p ?? null;
});

/** <webview> 게스트 전용 세션 파티션.
 *
 *  메인 윈도우 세션과 cookie/storage 가 섞이지 않도록 격리. 라이브러리 자료의
 *  외부 페이지 임베드는 사용자가 임시로 보는 용도라, 영구 보관이 필요한 경우
 *  (사이트 로그인 유지)만 persist:* prefix 로 디스크에 남긴다. UA 는 Chrome
 *  으로 위장해 YouTube/Instagram 같은 봇 가드를 회피(메인 윈도우와 동일 정책). */
const WEBVIEW_PARTITION = "persist:webview-preview";
let webviewSessionConfigured = false;
function configureWebviewSession(): void {
  if (webviewSessionConfigured) return;
  const s = session.fromPartition(WEBVIEW_PARTITION, { cache: true });
  s.setUserAgent(REAL_UA);
  /* 게스트 페이지가 카메라/마이크/지오로케이션/노티 등을 요청해도 즉시 거부.
     라이브러리 프리뷰 용도라 자료 페이지에 권한을 부여할 이유가 없다. */
  s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  /* 다운로드도 차단 — 미리보기가 의도치 않게 파일을 받아 디스크에 떨어뜨리는
     사고 방지(필요하면 사용자가 OS 브라우저에서 직접 받게). */
  s.on("will-download", (e) => e.preventDefault());

  /* Referer / Origin override.
   *
   *  prod build (특히 mac) 에선 호스트 origin 이 `file://` 또는 사용자 정의
   *  protocol 이라, youtube embed 같은 *Referer 화이트리스트* 서비스가 외부
   *  로딩을 거부한다 (ERR_BLOCKED_BY_RESPONSE = -153). 게스트 webview 의
   *  요청에 한해 Referer 를 destination origin 으로, Origin 헤더는 제거해
   *  same-origin 요청처럼 보이게 만든다.
   *
   *  사이드 이펙트는 거의 없다 — 이 세션은 *프리뷰 전용* 격리 파티션이고,
   *  로그인 같은 사용자 인증 흐름이 일어나지 않으므로 Referer 위조가 보안에
   *  미치는 영향은 ~0. */
  s.webRequest.onBeforeSendHeaders((details, callback) => {
    try {
      const target = new URL(details.url);
      const headers = { ...details.requestHeaders };
      headers["Referer"] = `${target.protocol}//${target.host}/`;
      // Origin 헤더가 file:// 로 박힌 채 외부 도메인에 전송되면 CORS 거부
      // 가능 — 제거해 simple GET 으로 보이게.
      delete headers["Origin"];
      callback({ requestHeaders: headers });
    } catch {
      callback({ requestHeaders: details.requestHeaders });
    }
  });

  /* 응답 헤더에서 frame-blocking 정책을 제거해, 외부 사이트가 X-Frame-Options
   * 나 CSP frame-ancestors 로 임베드를 막더라도 우리 webview 안에선 표시되게
   * 한다. 이 세션은 사용자 데이터를 다루지 않는 *프리뷰 sandbox* 라 frame
   * embed 거부를 강제 해제해도 위협 모델이 거의 없다. */
  s.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase();
      if (lower === "x-frame-options" || lower === "content-security-policy" || lower === "content-security-policy-report-only") {
        delete headers[key];
      }
    }
    callback({ responseHeaders: headers });
  });

  webviewSessionConfigured = true;
}

/** <webview> 게스트 webContents 가 생성될 때마다 호출되는 가드.
 *
 *  - http(s) 외 스킴 navigate 차단(file://, javascript:, electron: 등)
 *  - 새 창/팝업/_blank 링크는 OS 기본 브라우저로 위임 (앱 안에 새 BrowserWindow
 *    안 띄움 — 사용자가 "프리뷰가 갑자기 다른 페이지로 튄다" 느낌 방지)
 *  - 권한 요청은 모두 deny (세션 핸들러가 못 잡는 경우 대비 이중 가드) */
function installWebviewGuards(contents: Electron.WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === "http:" || u.protocol === "https:") {
        void shell.openExternal(url);
      }
    } catch {
      /* drop invalid */
    }
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, targetUrl) => {
    try {
      const u = new URL(targetUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        event.preventDefault();
      }
    } catch {
      event.preventDefault();
    }
  });
  contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
}

function resolveStorageFilePath(rawUrl: string): string {
  const raw = rawUrl.replace(/^local-file:\/\//i, "");
  const noQuery = raw.split(/[?#]/)[0];
  const decoded = decodeURIComponent(noQuery);
  const cleaned = decoded.replace(/^\/+/, "");
  const filePath = path.resolve(path.normalize(cleaned));
  // 활성 워크스페이스의 storage 디렉터리를 sandbox 루트로 사용. 워크스페이스
  // 전환 후에도 즉시 새 path 가 반영되도록 매 호출 동적으로 조회.
  const storageRoot = path.resolve(getStorageBasePath());
  const rel = path.relative(storageRoot, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Blocked local-file outside storage: ${filePath}`);
  }
  return filePath;
}

function createWindow() {
  // OS chrome 을 자체 nav 로 흡수해 Eagle / VS Code / Linear 같은 외형을 만든다.
  // - Windows/Linux: titleBarStyle="hidden" 로 OS 타이틀바 완전 제거.
  //   ─ □ × 는 React 의 <WindowControls/> 가 직접 그린다(preload.ts 의
  //   IPC 채널로 윈도우를 minimize/maximize/close). native overlay 를
  //   쓰면 OS 가 ─ □ × 를 윈도우 최상단(y=0) 부터 강제 배치해서
  //   네비바를 키우면 버튼이 위로 치우치고 호버 박스도 정사각형이
  //   안 나오는 한계가 있어 자체 구현.
  // - macOS: titleBarStyle="default" 로 OS 표준 타이틀바를 별도 영역에
  //   그대로 두고, 그 아래에 React 네비바를 얹는다(Cursor / Finder 식
  //   레이아웃). 과거의 "hiddenInset" 은 traffic light 가 콘텐츠 영역에
  //   오버레이로 떠 BrandLogo 와 겹쳐 보이는 부작용이 있었고, 이를 피하기
  //   위해 `.platform-mac .app-topbar { padding-left: 72px }` 같은 좌측
  //   여백 회피 규칙이 필요했다. 표준 타이틀바로 돌리면 트래픽 라이트가
  //   자기 영역에 머물러 회피 padding 도 필요 없다. WindowControls 는
  //   platform-mac 에서 자기 자신을 그리지 않으므로 양쪽이 깔끔히 분리.
  // 메뉴바(File/Edit/View/Window/Help) 는 Menu.setApplicationMenu(null) 로 제거.
  const isMac = process.platform === "darwin";

  // 윈도우 아이콘 — Windows 는 멀티사이즈 비트맵을 담은 .ico 를 우선,
  // 그 외 플랫폼(macOS/Linux) 은 .png 를 사용. .ico 가 16/24/32/48/64/128/256
  // 비트맵을 담고 있어서 Electron 이 컨텍스트(작업표시줄·Alt+Tab·트레이) 에
  // 맞춰 *가장 가까운* 사이즈를 직접 선택 → 1024 PNG 한 장만 줬을 때 발생하는
  // 큰 비율 downsample 흐림을 피한다.
  // dev: __dirname=dist-electron, 프로젝트 루트의 build/icon.{png,ico}.
  // prod: app.asar/dist-electron, asar 내부의 build/icon.{png,ico}.
  //       (package.json build.files 에 두 파일이 포함되어 동봉됨.)
  // 파일이 없거나 로드 실패 시 OS 기본 아이콘으로 자연 fallback —
  // 신규 셋업 단계에서 build/ 가 비어 있어도 윈도우 생성이 막히지 않게.
  let windowIcon: Electron.NativeImage | undefined;
  try {
    const iconBase = process.platform === "win32" ? "icon.ico" : "icon.png";
    const iconPath = path.join(__dirname, "..", "build", iconBase);
    if (fs.existsSync(iconPath)) {
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) windowIcon = img;
    }
  } catch (err) {
    console.warn("[main] failed to load window icon:", err);
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: "Pre-Flow",
    backgroundColor: "#0a0a0a",
    titleBarStyle: isMac ? "default" : "hidden",
    ...(windowIcon ? { icon: windowIcon } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      /* URL / HTML 자료의 인앱 프리뷰는 <webview> 게스트로 렌더한다.
         일반 <iframe> 은 대부분의 외부 사이트(Google, Instagram, Pinterest …)
         가 X-Frame-Options/CSP frame-ancestors 로 거부해 사용 불가. <webview>
         는 별도 webContents 프로세스에서 돌아 frame-busting 헤더에 영향받지
         않고, 게스트 권한·팝업·네비게이션을 아래 web-contents-created 가드
         에서 엄격하게 통제한다. */
      webviewTag: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // ── User-Agent 위장 ─────────────────────────────────────────────
  // Electron 기본 UA(`... Chrome/<v> Electron/<v> Safari/...`) 의 "Electron"
  // 토큰을 본 YouTube 임베드 서버(www.youtube.com/embed, i.ytimg.com) 가
  // 곧장 503 Service Unavailable 을 돌려준다. 라이브러리 우측 인스펙터의
  // <iframe src="…/embed/…"> 가 항상 503 으로 죽고, 사용자가 "Watch on
  // YouTube" 버튼만 마주하던 원인. webContents 레벨에서 일반 Chrome UA 로
  // 갈아끼우면 main frame 뿐 아니라 임베디드 iframe / 서브리소스(썸네일 등)
  // 모두 같은 UA 로 나가 503 이 사라진다. 같은 UA 를 link-preview-handler
  // 도 공유 — 한 곳(constants.ts) 에서만 관리.
  mainWindow.webContents.setUserAgent(REAL_UA);

  // ── 윈도우 컨트롤 IPC ─────────────────────────────────────────
  // 커스텀 ─ □ × 버튼이 호출. preload.ts 와 채널 이름이 1:1 로 짝이 맞아야
  // 동작. mainWindow 가 null 인 케이스(렌더러가 종료 이후 보낸 stray
  // 메시지) 는 안전하게 무시.
  const sendMaximizedState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("preflow-window:maximized-changed", mainWindow.isMaximized());
  };
  mainWindow.on("maximize", sendMaximizedState);
  mainWindow.on("unmaximize", sendMaximizedState);

  // 렌더러가 local-server 의 실제 포트를 알 수 있도록 URL query 로 주입.
  // startLocalServer() 가 19876 이 아닌 다른 포트로 fallback 했을 때도
  // 렌더러가 올바른 URL 로 통신하게 된다.
  const port = getLocalServerPort();
  const portQuery = `preflowPort=${port}&preflowToken=${encodeURIComponent(getLocalServerAuthToken())}`;

  if (process.env.VITE_DEV_SERVER_URL) {
    const devUrl = new URL(process.env.VITE_DEV_SERVER_URL);
    devUrl.searchParams.set("preflowPort", String(port));
    devUrl.searchParams.set("preflowToken", getLocalServerAuthToken());
    mainWindow.loadURL(devUrl.toString());
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(DIST, "index.html"), {
      search: portQuery,
    });
  }

  // ── 윈도우 단축키 (Ctrl/Cmd+R 새로고침 등) ──
  // 우리는 위/아래에서 Menu.setApplicationMenu(null) 로 기본 메뉴를
  // 통째로 없애 화면을 깔끔히 유지한다. 그 부수효과로 기본 View 메뉴에
  // 딸려있던 Reload / DevTools 단축키도 사라지는데, 개발/디버깅에서
  // 새로고침은 자주 쓰니 webContents 레벨에서 직접 가로채 처리한다.
  // globalShortcut 이 아니라 before-input-event 라 이 윈도우에 포커스
  // 가 있을 때만 동작 — 다른 앱과 절대 충돌 안 함.
  // 워크스페이스 전환은 location.reload() 로 렌더러를 새로 로드한다 — 이때
  // 메인 프레임의 in-place 아닌 내비게이션이 발생한다. 진행 중이던 영상 변환은
  // 렌더러와 함께 버려지므로, ffmpeg 자식 프로세스를 여기서 정리한다(고아 방지).
  // 같은 문서 내 해시 라우팅(isInPlace=true) 이나 iframe 로드는 제외.
  mainWindow.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) killAllTranscodes();
  });

  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const mod = process.platform === "darwin" ? input.meta : input.control;
    const key = input.key.toLowerCase();
    // Ctrl/Cmd+R or F5 → 새로고침. Shift 같이 누르면 캐시 무시 강력 새로고침.
    if ((mod && key === "r") || key === "f5") {
      event.preventDefault();
      if (input.shift) mainWindow?.webContents.reloadIgnoringCache();
      else mainWindow?.webContents.reload();
      return;
    }
    // F12 또는 Ctrl/Cmd+Shift+I → DevTools 토글.
    if (key === "f12" || (mod && input.shift && key === "i")) {
      event.preventDefault();
      mainWindow?.webContents.toggleDevTools();
    }
  });
}

// ── 윈도우 컨트롤 IPC: ─ □ × ──────────────────────────────────
// preload.ts(`window.preflowWindow`) 가 호출하는 채널. 핸들러는 앱 전역
// 1 회만 등록되면 충분 — 윈도우가 재생성되어도 mainWindow 참조가 새 값을
// 가리키므로 동일 핸들러가 항상 "현재 메인 윈도우" 를 대상으로 동작.
ipcMain.on("preflow-window:minimize", () => {
  mainWindow?.minimize();
});
ipcMain.on("preflow-window:toggle-maximize", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on("preflow-window:close", () => {
  mainWindow?.close();
});
ipcMain.handle("preflow-window:is-maximized", () => mainWindow?.isMaximized() ?? false);

// ── 영상 트랜스코딩(ffmpeg) IPC ──────────────────────────────────────
// 300MB 초과 영상을 목표 용량 이하로 재인코딩한다. 입력은 *원본 디스크 경로*
// 만 받는다 — 대용량을 base64/IPC 로 실어 나르면 메모리/전송이 터지기 때문.
// 출력은 references 버킷의 `.scratch/<id>.mp4` 에 써서 렌더러가 /storage/file/
// 로 다시 fetch → uploadReferenceFile 파이프에 합류시킨다.
function resolveFfmpegPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  }
  // dev: ffmpeg-static 은 바이너리 절대경로 문자열을 default export 한다.
  return require("ffmpeg-static") as string;
}

const activeTranscodes = new Map<string, ReturnType<typeof spawn>>();
const AUDIO_KBPS = 128;

/** ffmpeg 로 컨테이너의 실제 재생 길이(초)를 읽는다. 브라우저 <video>.duration
 *  은 일부 mp4(YouTube 다운로드본 등)에서 Infinity 로 나와 신뢰할 수 없어,
 *  변환 직전 권위 있는 길이를 ffmpeg stderr 의 `Duration:` 에서 파싱한다.
 *  `ffmpeg -i <file>` 은 출력이 없어 code 1 로 끝나지만 메타데이터는 출력한다. */
function probeDurationSec(inputPath: string): Promise<number> {
  return new Promise((resolve) => {
    let stderr = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(resolveFfmpegPath(), ["-i", inputPath]);
    } catch {
      resolve(0);
      return;
    }
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    child.on("error", () => resolve(0));
    child.on("close", () => {
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (m) resolve(Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3]));
      else resolve(0);
    });
  });
}

ipcMain.handle(
  "preflow-video:transcode",
  async (
    _event,
    args: { id: string; inputPath: string; durationSec: number; targetBytes: number },
  ): Promise<{ ok: true; scratchRelPath: string } | { ok: false; reason: string }> => {
    const { id, inputPath, targetBytes } = args;
    let durationSec = args.durationSec;
    try {
      if (!inputPath || !fs.existsSync(inputPath)) {
        return { ok: false, reason: "원본 파일 경로를 찾을 수 없습니다." };
      }
      // 렌더러의 <video>.duration 이 신뢰 불가(Infinity→0)면 ffmpeg 로 실측.
      if (!Number.isFinite(durationSec) || durationSec <= 0) {
        durationSec = await probeDurationSec(inputPath);
      }
      if (!Number.isFinite(durationSec) || durationSec <= 0) {
        return { ok: false, reason: "영상 길이를 확인할 수 없습니다." };
      }
      // 길이 초과는 변환으로 해결 불가 — 명확한 사유로 거부.
      if (durationSec > MAX_VIDEO_DURATION_SEC) {
        return {
          ok: false,
          reason: `${MAX_VIDEO_DURATION_SEC / 60}분 이하 영상만 지원합니다 (현재 약 ${Math.ceil(durationSec / 60)}분). 영상 길이는 변환으로 줄일 수 없습니다.`,
        };
      }
      const outDir = path.join(getStorageBasePath(), "references", ".scratch");
      await fs.promises.mkdir(outDir, { recursive: true });
      const outPath = path.join(outDir, `${id}.mp4`);
      const scratchRelPath = `.scratch/${id}.mp4`;

      // 목표 바이트 → 총 비트레이트(kbps). 오디오/컨테이너 여유를 빼고 안전계수.
      const computeVideoKbps = (factor: number): number => {
        const totalKbps = (targetBytes * 8) / durationSec / 1000;
        return Math.max(200, Math.floor((totalKbps - AUDIO_KBPS) * factor));
      };

      const runOnce = (videoKbps: number): Promise<number> =>
        new Promise<number>((resolve, reject) => {
          const ffmpegBin = resolveFfmpegPath();
          const ffmpegArgs = [
            "-y",
            "-i", inputPath,
            "-c:v", "libx264",
            "-preset", "medium",
            "-b:v", `${videoKbps}k`,
            "-maxrate", `${Math.floor(videoKbps * 1.5)}k`,
            "-bufsize", `${videoKbps * 2}k`,
            "-vf", "scale='min(1920,iw)':-2",
            "-c:a", "aac",
            "-b:a", `${AUDIO_KBPS}k`,
            "-movflags", "+faststart",
            outPath,
          ];
          const child = spawn(ffmpegBin, ffmpegArgs);
          activeTranscodes.set(id, child);
          child.stderr?.on("data", (buf: Buffer) => {
            const m = buf.toString().match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
            if (m) {
              const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3]);
              const ratio = Math.max(0, Math.min(0.99, sec / durationSec));
              mainWindow?.webContents.send("preflow-video:transcode-progress", { id, ratio });
            }
          });
          child.on("error", reject);
          child.on("close", (code) => {
            activeTranscodes.delete(id);
            resolve(code ?? -1);
          });
        });

      let code = await runOnce(computeVideoKbps(0.95));
      if (code !== 0) {
        await fs.promises.rm(outPath, { force: true }).catch(() => undefined);
        return { ok: false, reason: "변환이 취소되었거나 실패했습니다." };
      }
      // 사이즈 초과 시 더 낮은 비트레이트로 1회 재시도.
      let stat = await fs.promises.stat(outPath);
      if (stat.size > targetBytes) {
        code = await runOnce(computeVideoKbps(0.8));
        if (code === 0) stat = await fs.promises.stat(outPath);
      }
      if (stat.size > REFERENCE_UPLOAD_MAX_BYTES) {
        await fs.promises.rm(outPath, { force: true }).catch(() => undefined);
        return { ok: false, reason: "변환 후에도 용량이 너무 큽니다." };
      }
      mainWindow?.webContents.send("preflow-video:transcode-progress", { id, ratio: 1 });
      return { ok: true, scratchRelPath };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  },
);

ipcMain.on("preflow-video:transcode-cancel", (_event, id: string) => {
  const child = activeTranscodes.get(id);
  if (child) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    activeTranscodes.delete(id);
  }
});

// ── 영상 포스터(첫 프레임) 추출(ffmpeg) IPC ─────────────────────────────
// 브라우저 <video> 가 디코드하지 못하는 코덱(ProRes/HEVC MOV 등) 의 첫 프레임을
// ffmpeg 로 PNG 1장으로 뽑아 references 버킷의 scratch 에 쓴다. 렌더러는
// /storage/file/ 로 다시 fetch 해 thumbnail 로 업로드한다. stderr 에서 길이/
// 해상도도 함께 파싱해 돌려줘 렌더러가 VideoMeta 를 채울 수 있게 한다.
ipcMain.handle(
  "preflow-video:extract-poster",
  async (
    _event,
    args: { id: string; inputPath: string },
  ): Promise<
    | { ok: true; scratchRelPath: string; durationSec: number; width: number; height: number }
    | { ok: false; reason: string }
  > => {
    const { id, inputPath } = args;
    try {
      if (!inputPath || !fs.existsSync(inputPath)) {
        return { ok: false, reason: "원본 파일 경로를 찾을 수 없습니다." };
      }
      const outDir = path.join(getStorageBasePath(), "references", ".scratch");
      await fs.promises.mkdir(outDir, { recursive: true });
      const outPath = path.join(outDir, `${id}.poster.png`);
      const scratchRelPath = `.scratch/${id}.poster.png`;

      const ffmpegBin = resolveFfmpegPath();
      const ffmpegArgs = [
        "-y",
        // 0.1s 지점의 첫 프레임 — 완전 검은 첫 프레임을 피한다.
        "-ss", "0.1",
        "-i", inputPath,
        "-frames:v", "1",
        // 긴 변 1024로 다운스케일(짝수 유지). 일반 이미지 썸네일과 비슷한 무게.
        "-vf", "scale='min(1024,iw)':-2",
        outPath,
      ];

      const stderr = await new Promise<string>((resolve, reject) => {
        let buf = "";
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(ffmpegBin, ffmpegArgs);
        } catch (e) {
          reject(e);
          return;
        }
        child.stderr?.on("data", (b: Buffer) => {
          buf += b.toString();
        });
        child.on("error", reject);
        child.on("close", () => resolve(buf));
      });

      if (!fs.existsSync(outPath)) {
        return { ok: false, reason: "포스터 프레임 추출에 실패했습니다." };
      }
      const stat = await fs.promises.stat(outPath);
      if (stat.size === 0) {
        await fs.promises.rm(outPath, { force: true }).catch(() => undefined);
        return { ok: false, reason: "포스터 프레임이 비어 있습니다." };
      }

      const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      const durationSec = durMatch
        ? Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + parseFloat(durMatch[3])
        : 0;
      // 스트림 해상도 — "1920x1080" 의 첫 매치(보통 비디오 스트림).
      const dimMatch = stderr.match(/,\s*(\d{2,5})x(\d{2,5})/);
      const width = dimMatch ? Number(dimMatch[1]) : 0;
      const height = dimMatch ? Number(dimMatch[2]) : 0;

      return { ok: true, scratchRelPath, durationSec, width, height };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  },
);

/** 진행 중인 모든 ffmpeg 변환을 종료한다. 워크스페이스 전환(렌더러 reload) 시
 *  렌더러 측 변환 루프는 사라지지만 메인의 ffmpeg 자식은 살아남아 고아가 되므로,
 *  내비게이션 시점에 호출해 정리한다. */
function killAllTranscodes(): void {
  for (const child of activeTranscodes.values()) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  activeTranscodes.clear();
}

// ── OS-level file copy ──────────────────────────────────────────────
// 렌더러(라이브러리의 Ctrl+C) 가 호출한다. Web Clipboard API 는 image/png |
// jpeg | webp(일부) 정도만 지원하므로 GIF 애니메이션·동영상·다중 파일 같이
// "Eagle 처럼 OS 차원에서 파일을 복사" 하려면 네이티브 셸 API 가 필요하다.
//
// ⚠ Electron 의 `clipboard.writeBuffer("CF_HDROP", buf)` 는 실제로는 *커스텀
// 포맷명* "CF_HDROP" 으로 등록될 뿐 윈도우 표준 CF_HDROP(=15) 가 아니다 —
// 탐색기/Discord/Slack 같은 앱이 못 읽는다. 마찬가지로 macOS 의
// `NSFilenamesPboardType` 도 커스텀 NSPasteboardType 으로 들어가 Finder 가
// 인식하지 못한다.  그래서 표준 포맷을 안정적으로 채우는 가장 신뢰성 높은
// 방법으로 *각 OS 의 내장 도구* 를 자식 프로세스로 호출한다:
//
//   • Windows : PowerShell `Set-Clipboard -Path`  → 표준 CF_HDROP
//   • macOS   : `osascript` 로 Finder 의 clipboard 에 alias 들 등록
//   • Linux   : xclip 가 있으면 text/uri-list, 없으면 Electron writeBuffer
//               (대부분의 Nautilus/Dolphin/Thunar 가 text/uri-list 만 본다)
function spawnAsync(
  cmd: string,
  args: string[],
  stdin?: string,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = "";
    const child = spawn(cmd, args, { windowsHide: true });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", () => resolve({ code: -1, stderr }));
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
    if (stdin) {
      child.stdin?.write(stdin);
      child.stdin?.end();
    } else {
      child.stdin?.end();
    }
  });
}

async function copyFilesWindows(filePaths: string[]): Promise<boolean> {
  // PowerShell 의 `Set-Clipboard -Path` 는 Windows 10+ 에서 기본 제공되며
  // 정확히 표준 CF_HDROP 을 채워준다. 경로 안의 single-quote 는 PowerShell
  // 문자열 규칙에 따라 두 번 써서 escape. 추가로 -LiteralPath 를 쓰면
  // wildcard 해석을 피할 수 있어 [], * 가 들어간 파일명도 안전하다.
  const literal = filePaths.map((p) => `'${p.replace(/'/g, "''")}'`).join(",");
  const psCmd = `Set-Clipboard -LiteralPath @(${literal})`;
  const { code, stderr } = await spawnAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-Command", psCmd,
  ]);
  if (code !== 0) {
    console.error("[clipboard:copy-files][win] powershell failed", code, stderr);
    return false;
  }
  return true;
}

async function copyFilesMac(filePaths: string[]): Promise<boolean> {
  // macOS 시스템 클립보드(NSPasteboard)에 file-URL 들을 직접 기록한다.
  //
  // 과거 방식(`tell application "Finder" to set the clipboard to {alias...}`)은
  //   (1) Finder 제어에 Automation(TCC) 권한이 필요 → 권한 미부여 시 *조용히*
  //       실패(코드 0 이 아닌 채 폴백), 사용자는 파일 대신 텍스트 경로만 붙여짐,
  //   (2) Finder 클립보드 의미가 앱마다 들쭉날쭉이라 외부 Cmd+V 가 불안정,
  // 이라 드래그아웃이 막힌 macOS 에서 "복사→외부 붙여넣기(파일)"가 동작하지
  // 않는 핵심 원인이었다.
  //
  // JXA(ObjC 브리지)로 NSPasteboard.generalPasteboard.writeObjects([NSURL...])
  // 를 호출하면 표준 `public.file-url` 포맷으로 들어가 Finder/Slack/메일/메모/
  // 카톡 등이 Cmd+V 로 *진짜 파일* 을 받는다. 다른 앱을 제어하지 않으므로 권한
  // 프롬프트도 없다. 경로는 osascript 의 argv 로 넘겨(run(argv)) escaping 이슈를
  // 원천 차단한다. writeObjects 의 BOOL 결과를 stdout 으로 받아 성공을 검증한다.
  const script = [
    "ObjC.import('AppKit');",
    "function run(argv) {",
    "  const pb = $.NSPasteboard.generalPasteboard;",
    "  pb.clearContents;",
    "  const urls = $.NSMutableArray.alloc.init;",
    "  for (let i = 0; i < argv.length; i++) {",
    "    urls.addObject($.NSURL.fileURLWithPath(argv[i]));",
    "  }",
    "  return pb.writeObjects(urls) ? 'ok' : 'fail';",
    "}",
  ].join("\n");
  const { code, stdout } = await spawnAsyncCapture("osascript", [
    "-l",
    "JavaScript",
    "-e",
    script,
    ...filePaths,
  ]);
  if (code !== 0 || !stdout.includes("ok")) {
    console.error("[clipboard:copy-files][mac] NSPasteboard write failed", code, stdout);
    return false;
  }
  return true;
}

async function copyFilesLinux(filePaths: string[]): Promise<boolean> {
  // xclip 이 있으면 text/uri-list 로 박는다. Nautilus/Dolphin/Thunar 등이
  // 인식. xclip 가 없으면 Electron writeBuffer 폴백 (저신뢰).
  const uriList = filePaths.map((p) => "file://" + encodeURI(p)).join("\r\n");
  const xclip = await spawnAsync(
    "xclip",
    ["-selection", "clipboard", "-t", "text/uri-list"],
    uriList,
  );
  if (xclip.code === 0) return true;
  try {
    clipboard.writeBuffer("text/uri-list", Buffer.from(uriList, "utf8"));
    return true;
  } catch (err) {
    console.error("[clipboard:copy-files][linux] writeBuffer failed", err);
    return false;
  }
}

ipcMain.handle(
  "preflow-clipboard:copy-files",
  async (_event, rawPaths: unknown): Promise<boolean> => {
    if (!Array.isArray(rawPaths) || rawPaths.length === 0) return false;
    // 보안 — 문자열만 통과시키고, 존재하는 경로만 추린다. 존재하지 않는 경로를
    // 클립보드에 넣으면 일부 OS 셸에서 클립보드 자체가 깨지는 사례가 있어
    // 사전에 필터링.
    const filePaths: string[] = [];
    for (const p of rawPaths) {
      if (typeof p !== "string" || p.length === 0) continue;
      try {
        if (fs.existsSync(p)) filePaths.push(p);
      } catch {
        /* skip — 권한 등으로 stat 실패하면 그냥 무시 */
      }
    }
    if (filePaths.length === 0) return false;

    try {
      if (process.platform === "win32") return await copyFilesWindows(filePaths);
      if (process.platform === "darwin") return await copyFilesMac(filePaths);
      return await copyFilesLinux(filePaths);
    } catch (err) {
      console.error("[clipboard:copy-files]", err);
      return false;
    }
  },
);

// ── Read clipboard image ────────────────────────────────────────────
// 렌더러 의 navigator.clipboard.read() 는 컨텍스트 메뉴 클릭 직후 *문서
// 포커스* 가 메뉴에 있어 자주 NotAllowedError / DOMException 으로 거부된다.
// Electron 의 `clipboard.readImage()` 는 권한 게이팅 없이 즉시 NativeImage 를
// 반환하므로, "Custom thumbnail (From clipboard)" 같은 메뉴 액션에서 더 안전.
// 렌더러로 넘기기 위해 PNG 바이트(Uint8Array) 로 직렬화한다. 클립보드에
// 이미지가 없거나 빈 NativeImage 면 null 을 반환해 호출부가 적절히 토스트.
ipcMain.handle("preflow-clipboard:read-image", (): Uint8Array | null => {
  try {
    const img = clipboard.readImage();
    if (!img || img.isEmpty()) return null;
    const png = img.toPNG();
    return png.length > 0 ? new Uint8Array(png) : null;
  } catch (err) {
    console.error("[clipboard:read-image]", err);
    return null;
  }
});

// ── Read clipboard FILE (CF_HDROP) ──────────────────────────────────
// 탐색기/Finder 에서 이미지 *파일* 을 Ctrl/Cmd+C 하면 클립보드에는 비트맵이
// 아니라 *파일 경로 목록* (Windows CF_HDROP / macOS public.file-url /
// Linux text/uri-list) 이 들어간다. `clipboard.readImage()` 는 이걸 못 읽어
// null 을 주므로, 여기서 OS 내장 도구로 경로 목록을 받아 첫 이미지 파일을
// 디스크에서 읽어 바이트로 돌려준다. 호출부는 비트맵 경로가 비었을 때만
// fallback 으로 이 채널을 시도한다.
function spawnAsyncCapture(
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn(cmd, args, { windowsHide: true });
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolve({ code: -1, stdout }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout }));
    child.stdin?.end();
  });
}

async function readClipboardFilePaths(): Promise<string[]> {
  try {
    if (process.platform === "win32") {
      const psCmd = "Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }";
      const { code, stdout } = await spawnAsyncCapture("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-Command", psCmd,
      ]);
      if (code !== 0) return [];
      return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    }
    if (process.platform === "darwin") {
      // 단일 파일 best-effort. 여러 파일이면 AppleScript 가 throw → try 로 보호.
      const script =
        'set p to ""\ntry\nset p to POSIX path of (the clipboard as «class furl»)\nend try\nreturn p';
      const { code, stdout } = await spawnAsyncCapture("osascript", ["-e", script]);
      if (code !== 0) return [];
      const p = stdout.trim();
      return p ? [p] : [];
    }
    // Linux: xclip 가 file:// URI 들을 준다.
    const { code, stdout } = await spawnAsyncCapture("xclip", [
      "-selection", "clipboard",
      "-t", "text/uri-list",
      "-o",
    ]);
    if (code !== 0) return [];
    return stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("#"))
      .map((s) => (s.startsWith("file://") ? decodeURI(s.replace(/^file:\/\//, "")) : s))
      .filter(Boolean);
  } catch (err) {
    console.error("[clipboard:read-image-file] path read failed", err);
    return [];
  }
}

const IMAGE_EXT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
};
const MAX_CLIPBOARD_FILE_BYTES = 50 * 1024 * 1024;

ipcMain.handle(
  "preflow-clipboard:read-image-file",
  async (): Promise<{ bytes: Uint8Array; mime: string; name: string } | null> => {
    try {
      const paths = await readClipboardFilePaths();
      for (const p of paths) {
        const ext = path.extname(p).toLowerCase();
        const mime = IMAGE_EXT_MIME[ext];
        if (!mime) continue;
        try {
          const stat = fs.statSync(p);
          if (!stat.isFile() || stat.size === 0 || stat.size > MAX_CLIPBOARD_FILE_BYTES) continue;
          const buf = fs.readFileSync(p);
          if (buf.length === 0) continue;
          return { bytes: new Uint8Array(buf), mime, name: path.basename(p) };
        } catch {
          /* 권한/삭제 등으로 읽기 실패 → 다음 후보 */
        }
      }
      return null;
    } catch (err) {
      console.error("[clipboard:read-image-file]", err);
      return null;
    }
  },
);

// ── doc 자료의 OS 셸 아이콘 추출 ─────────────────────────────────────
// ZIP/EXE/HTML/code/audio 등 *자연 미리보기가 없는* doc sub-type 의 카드를
// 채우기 위해, Windows 셸 (또는 macOS Finder) 의 파일 연결 아이콘을
// `app.getFileIcon` 으로 뽑아 PNG 로 돌려준다. 렌더러는 이 PNG 를 캔버스에
// 다시 그려 "Eagle 식 아이콘 카드" 모양을 만든다.
//
// `app.getFileIcon` 은 *경로* 만 받고 *파일 내용* 도 일부 본다 — EXE 의
// 임베디드 아이콘 (PureRef·BANDIZIP 같은 앱별 로고) 은 바이트가 없으면
// 얻을 수 없다. 그래서 IPC 는 (filename, bytes) 두 인자를 받아 temp 파일을
// 만들고, 그 경로로 셸 아이콘을 뽑은 뒤 즉시 temp 를 지운다.
//
// 보안 — 받은 바이트는 *실행되지 않고* 그냥 디스크에 쓰여 셸 아이콘 호출에
// 만 쓰이고 finally 에서 삭제. 외부 코드 실행 표면을 늘리지 않는다.
ipcMain.handle(
  "preflow-doc:get-file-icon",
  async (
    _e,
    payload: unknown,
  ): Promise<Uint8Array | null> => {
    if (!payload || typeof payload !== "object") {
      console.warn("[doc:get-file-icon] invalid payload (not an object)");
      return null;
    }
    const { filename, bytes } = payload as {
      filename?: unknown;
      bytes?: unknown;
    };
    if (typeof filename !== "string") {
      console.warn("[doc:get-file-icon] invalid filename type", typeof filename);
      return null;
    }
    /* IPC 결과로 받는 바이트의 실제 타입은 환경마다 다르다:
       - 정상: Uint8Array (`Buffer` 도 subclass 이므로 통과)
       - 일부 케이스: 순수 ArrayBuffer (structured clone 의 변종)
       - 매우 드물게: { type: "Buffer", data: number[] } JSON 직렬화 결과
       모두 `Buffer.from` 으로 흡수 가능한 형태로 정규화. */
    let buf: Buffer;
    if (bytes instanceof Uint8Array) {
      buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    } else if (bytes instanceof ArrayBuffer) {
      buf = Buffer.from(bytes);
    } else if (
      bytes && typeof bytes === "object"
      && Array.isArray((bytes as { data?: unknown }).data)
    ) {
      buf = Buffer.from((bytes as { data: number[] }).data);
    } else {
      console.warn("[doc:get-file-icon] unrecognized bytes payload",
        bytes && typeof bytes === "object" ? Object.prototype.toString.call(bytes) : typeof bytes);
      return null;
    }
    // 확장자 sanitization — `..` / 경로 구분자 차단, 알파벳·숫자만 통과.
    // 길이 ≤ 16 으로 제한해 path traversal/긴 이름 공격을 차단.
    const rawExt = path.extname(filename).replace(/^\./, "");
    const safeExt = /^[a-zA-Z0-9]{1,16}$/.test(rawExt) ? `.${rawExt.toLowerCase()}` : ".bin";
    let tempDir: string | null = null;
    try {
      tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "preflow-icon-"));
      const tempPath = path.join(tempDir, `f${safeExt}`);
      await fs.promises.writeFile(tempPath, buf);
      /* `size: "large"` 는 macOS 에선 256×256, Windows 에선 48×48 ~ 256×256
         (셸이 갖고 있는 가장 큰 크기) 을 반환. 작은 사이즈로 받으면 렌더러
         캔버스에서 8× scale up 이라 흐려지므로 항상 large 요청. */
      const img = await app.getFileIcon(tempPath, { size: "large" });
      if (img.isEmpty()) {
        console.warn("[doc:get-file-icon] empty NativeImage for", safeExt);
        return null;
      }
      const png = img.toPNG();
      if (png.length === 0) {
        console.warn("[doc:get-file-icon] toPNG() returned empty buffer for", safeExt);
        return null;
      }
      console.log("[doc:get-file-icon] ok", safeExt, "→", png.length, "bytes");
      return new Uint8Array(png);
    } catch (err) {
      console.warn("[doc:get-file-icon] failed", err);
      return null;
    } finally {
      if (tempDir) {
        fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {
          /* temp 정리 실패는 무시 — OS 가 reboot 시 청소. */
        });
      }
    }
  },
);

// ── OS-level drag-out (Eagle 식 외부 끌어 쓰기) ──────────────────────
// `webContents.startDrag` 는 OS 가 인식하는 진짜 파일 드래그를 시작한다.
// HTML5 native DnD 의 `dragstart` 핸들러 안에서 IPC 로 호출하면 OS 가
// 즉시 드래그 비주얼/페이로드를 인계받아, Photoshop·탐색기·Finder·
// 슬랙 등 어떤 외부 앱/바탕화면에도 그대로 떨어뜨릴 수 있다.
//
// 입력은 렌더러가 보는 `local-file://...` URL 배열이다. resolveStorageFilePath
// 가 *userData/storage* 바깥을 차단하므로 임의 경로를 끌어가는 사고를 막는다.
// 첫 번째 인자가 비어있거나 모두 무효 URL 이면 조용히 무시.
//
// icon 은 NativeImage 가 비어있으면 macOS 에서 throw 가 나므로, thumbnail URL
// 이 없거나 잘못된 경우를 대비해 첫 파일 자체 또는 1×1 투명 PNG 로 fallback.
const FALLBACK_DRAG_ICON_PNG = Buffer.from(
  // 16×16 진한 회색 사각형. NativeImage 가 빈 이미지인 경우 startDrag 가
  // macOS 에서 즉시 throw 한다. 어떤 자료든 안전하게 드래그를 시작할 수
  // 있도록 데이터 URL 형태로 박아둔다(외부 파일 참조 X — 빌드/배포 영향 X).
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJUlEQVR4nO3OMQEAAAjDMOpfNB7BQYI3KNF1lP7e3p+kkpKSktImNyEAA0i52JEAAAAASUVORK5CYII=",
  "base64",
);

/**
 * Library 자료의 URL → storage sandbox 안의 실제 파일 경로 해석.
 *
 * 렌더러는 자료마다 두 가지 URL 중 하나를 들고 있다:
 *   - `local-file://<absolute path>`  (legacy / protocol handler 경로)
 *   - `http://127.0.0.1:<port>/storage/file/<bucket>/<relative>`
 *     (local-server.ts 가 만들어 주는 publicUrl — 현재 raw file_url 의
 *      기본 포맷. 패키지 임포트·업로드 양쪽에서 사용.)
 *
 * 두 포맷 모두 *storage base* (= `<userData>/storage/`) 바깥을 가리키면
 * sandbox 위반으로 throw 한다. 어느 쪽이든 매칭되지 않으면 null.
 *
 * 외부 끌어쓰기(`webContents.startDrag`) 와 향후 클립보드 등 OS-수준 파일
 * 핸드오프에서 공통으로 쓰는 핵심 라우터.
 */
function resolveLibraryFilePath(rawUrl: string): string | null {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return null;
  // 1) local-file:// — 별도 protocol handler 가 보장하는 sandbox.
  if (rawUrl.startsWith("local-file://")) {
    try {
      return resolveStorageFilePath(rawUrl);
    } catch {
      return null;
    }
  }
  // 2) http(s) 로 시작하면 path 만 떼내어 /storage/file/<relative> 패턴인지
  //    확인. ?t=cacheBuster, #frag 등은 strip. 호스트는 검증하지 않는다
  //    (개발/배포에서 127.0.0.1/localhost 양쪽이 모두 가능).
  if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
    let pathname = "";
    try {
      pathname = new URL(rawUrl).pathname;
    } catch {
      return null;
    }
    const prefix = "/storage/file/";
    if (!pathname.startsWith(prefix)) return null;
    const relative = decodeURIComponent(pathname.slice(prefix.length));
    if (!relative) return null;
    // storage base 안에서만 해석. ../ traversal 은 path.resolve + relative
    // 검사로 차단 (local-server.ts 의 resolveStorageReadPath 동일 정책).
    const base = path.resolve(getStorageBasePath());
    const target = path.resolve(base, relative);
    const rel = path.relative(base, target);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return target;
  }
  return null;
}

/**
 * URL 자료(예: YouTube / 일반 link bookmark) 를 외부로 끌어쓰려면 OS 에
 * 인계할 *실제 파일* 이 있어야 한다 — Eagle 도 같은 이유로 임시 `.url`
 * (Windows 인터넷 바로가기) / `.webloc` (macOS) 을 만들어 드래그한다.
 * 본 함수는 임시 디렉터리에 한 번 만들어두면 같은 URL 에 대해 캐시처럼
 * 재사용한다(이름 충돌 회피 + 파일 갱신은 URL 이 바뀌었을 때만).
 *
 * 정리 정책: 매 앱 시작 시 1시간 넘은 캐시는 일괄 삭제(orphanSweep 와
 * 동일 패턴) — 드래그 동안에만 파일이 살아 있으면 되고, drop 후에는
 * 외부 앱이 자기 사본을 갖고 있으므로 우리 쪽 임시본은 언제 지워도 안전.
 */
function getDragOutTempDir(): string {
  const dir = path.join(app.getPath("temp"), "preflow-drag-out");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeFilenameForFs(name: string): string {
  // Windows 가 금지하는 문자(<>:"/\|?*) + 제어문자를 _ 로 치환. 길이는 64.
  //
  // 추가로 URI-특수 문자(`#`, `&`, `%`) 까지 같이 제거한다. NTFS 는 이들을
  // 허용하지만, Chromium·Shell·다른 Electron 앱(Slack 등) 이 드래그 페이
  // 로드를 처리할 때 경로 문자열을 *URL 처럼* 해석하는 경우가 있어 `#`
  // 이후가 fragment 로 잘려나가 "🚫 못 받음" 오인 사고를 일으킨다.
  // 예: "Delta Force #1-abc.url" → URL 파싱 후 "Delta Force " 만 인식.
  //
  // 그리고 공백(스페이스/탭) → `_` 로 압축한다. URL-기반으로 명명되는 Behance
  // 의 `.url` 은 공백이 없어 Slack/탐색기가 그대로 받아 처리하는데, 영상
  // 제목으로 명명되는 YouTube `.url` 은 공백이 끼어 있어 같은 외부 앱이
  // 그 한 가지 차이만으로 다르게 처리(첨부 거부, 경로 잘림 등)하는 케이스
  // 가 관찰됐다. 공백을 없애 두 케이스의 파일명 형태를 동일 패턴으로 통일.
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
    .replace(/[#&%]+/g, "_")
    .replace(/\s+/g, "_")
    .trim();
  const trimmed = cleaned.length > 64 ? cleaned.slice(0, 64) : cleaned;
  return trimmed.length > 0 ? trimmed : "link";
}

function hashStringShort(s: string): string {
  // FNV-1a 32-bit — Node import 없이 가벼운 32비트 해시면 충분(충돌 가능
  // 성이 있어도 같은 URL→같은 파일 이름이라 캐시 hit 만 영향).
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/* AVIF → PNG 변환은 제거됨.
 *
 * 과거에는 외부 앱 호환성을 위해 AVIF 파일을 PNG 로 미리 변환해 인계했지만,
 * Electron 33 의 nativeImage AVIF 디코더가 main process 에서 ACCESS_VIOLATION
 * 으로 죽는 회귀가 관찰됐다(같은 AVIF 를 짧은 시간 내 재드래그하면 두 번째
 * 호출에서 크래시). 변환을 안 해도 받는 앱(Photoshop/Affinity/Discord/탐색기
 * 등) 이 알아서 처리하므로, 원본 AVIF 경로를 그대로 인계한다.
 *
 * Slack 의 file-drop UI 에서 AVIF 가 generic file 로 떨어지는 정도의 미세한
 * UX 손실은 받아들이고, 안정성과 단순성을 우선시. 향후 변환이 필요해지면
 * 렌더러 OffscreenCanvas → IPC 패턴으로 main 의 native 디코더를 우회. */

function materializeUrlShortcut(sourceUrl: string, title: string): string | null {
  try {
    const dir = getDragOutTempDir();
    const safeTitle = sanitizeFilenameForFs(title);
    const stamp = hashStringShort(sourceUrl);
    // Windows: `.url` (INI 형식). macOS Finder 도 plain text 로 열어준다.
    // 별도 .webloc 분기는 후속 — 우선 cross-platform 가용성 있는 .url 로.
    const filename = `${safeTitle}-${stamp}.url`;
    const target = path.join(dir, filename);
    // CRLF 가 Windows 표준 — Notepad 등에서도 깨지지 않게.
    const body =
      "[InternetShortcut]\r\n" +
      `URL=${sourceUrl}\r\n`;
    // 이미 같은 내용이 있으면 다시 쓰지 않아 mtime 보존(외부 앱이 락 잡고
    // 있는 동안 우리가 덮어쓰는 사고 회피).
    let needsWrite = true;
    try {
      const existing = fs.readFileSync(target, "utf-8");
      if (existing === body) needsWrite = false;
    } catch {
      /* not present → write */
    }
    if (needsWrite) fs.writeFileSync(target, body, "utf-8");
    return target;
  } catch (err) {
    console.warn("[drag:start] materializeUrlShortcut failed", err);
    return null;
  }
}

interface DragItemInput {
  fileUrl?: string | null;
  sourceUrl?: string | null;
  title?: string | null;
}

ipcMain.on(
  "preflow-drag:start",
  (
    event,
    payload:
      | {
          /** legacy — 파일 URL 만 있는 단순 배열 */
          fileUrls?: unknown;
          /** preferred — 카드 한 장당 file/source/title 메타. URL 자료는
           *  fileUrl 이 비고 sourceUrl 이 채워져 들어옴. */
          items?: unknown;
          iconUrl?: unknown;
        }
      | null,
  ) => {
    // sendSync 계약: 반드시 `event.returnValue` 를 설정해 렌더러 dragstart
    // 가 블록 해제되며 같은 tick 에 OLE drag 가 파일 페이로드를 attach 한
    // 상태로 출발한다. try/catch 는 외부 디버거 등이 returnValue 를 잠그는
    // 극단적 케이스 방어용.
    const respond = (ok: boolean): void => {
      try { event.returnValue = ok; } catch { /* defensive */ }
    };

    if (!payload || typeof payload !== "object") {
      console.warn("[drag:start] invalid payload");
      respond(false);
      return;
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) {
      console.warn("[drag:start] no window");
      respond(false);
      return;
    }

    // 카드 메타 우선, 없으면 legacy fileUrls 배열 변환.
    const items: DragItemInput[] = [];
    if (Array.isArray(payload.items)) {
      for (const raw of payload.items) {
        if (!raw || typeof raw !== "object") continue;
        items.push(raw as DragItemInput);
      }
    } else if (Array.isArray(payload.fileUrls)) {
      for (const raw of payload.fileUrls) {
        if (typeof raw === "string") items.push({ fileUrl: raw });
      }
    }

    const filePaths: string[] = [];
    const rejected: string[] = [];
    for (const item of items) {
      const fileUrl = typeof item.fileUrl === "string" ? item.fileUrl : "";
      const sourceUrl = typeof item.sourceUrl === "string" ? item.sourceUrl : "";
      const title = typeof item.title === "string" ? item.title : "link";

      // 우선순위 1: file_url 이 storage 안의 실제 파일이면 그걸 그대로 인계.
      // 포맷 변환 없이 원본 path 를 그대로 OS drag 에 넘긴다 — AVIF/MP4 등
      // 모든 미디어는 받는 앱이 알아서 처리.
      if (fileUrl) {
        const resolved = resolveLibraryFilePath(fileUrl);
        if (resolved) {
          try {
            if (fs.existsSync(resolved)) {
              filePaths.push(resolved);
              continue;
            }
            rejected.push(fileUrl + " (missing on disk: " + resolved + ")");
          } catch (err) {
            rejected.push(fileUrl + " (stat failed: " + (err as Error).message + ")");
          }
        } else {
          rejected.push(fileUrl + " (unsupported URL or sandbox violation)");
        }
        // file_url 실패해도 source_url 이 있으면 그 쪽으로 fallback 시도.
      }

      // 우선순위 2: source_url → 임시 `.url` 인터넷 바로가기 materialize.
      //   Eagle 과 동일하게 OS 가 인식하는 진짜 파일을 만들어 넘긴다.
      if (sourceUrl) {
        const trimmed = sourceUrl.trim();
        const okScheme =
          trimmed.startsWith("http://") ||
          trimmed.startsWith("https://") ||
          trimmed.startsWith("ftp://");
        if (!okScheme) {
          rejected.push(sourceUrl + " (unsupported scheme for shortcut)");
          continue;
        }
        const shortcutPath = materializeUrlShortcut(trimmed, title);
        if (shortcutPath) {
          filePaths.push(shortcutPath);
          continue;
        }
        rejected.push(sourceUrl + " (shortcut materialize failed)");
        continue;
      }

      rejected.push(JSON.stringify(item) + " (no fileUrl/sourceUrl)");
    }

    if (filePaths.length === 0) {
      console.warn(
        "[drag:start] no valid files; rejected:",
        rejected.slice(0, 3),
      );
      respond(false);
      return;
    }

    // icon — 우선 명시된 thumbnail URL, 다음으로 첫 파일 자체, 최후 fallback PNG.
    let iconImage = nativeImage.createEmpty();
    let iconSource = "none";
    const iconUrl = typeof payload.iconUrl === "string" ? payload.iconUrl : "";
    if (iconUrl) {
      const iconPath = resolveLibraryFilePath(iconUrl);
      if (iconPath && fs.existsSync(iconPath)) {
        try {
          iconImage = nativeImage.createFromPath(iconPath);
          if (!iconImage.isEmpty()) iconSource = "iconUrl:" + iconPath;
        } catch {
          /* fall through */
        }
      } else {
        // iconUrl 이 storage 안의 파일이 아니면(예: 외부 CDN i.ytimg.com)
        // resolveLibraryFilePath 가 null 을 반환 → 자체 다운로드 회피해
        // 그냥 fallback 으로 빠진다.
        iconSource = "iconUrl-unresolvable:" + iconUrl.slice(0, 80);
      }
    }
    // nativeImage.createFromPath 는 일부 포맷(mp4, .url 바로가기, AVIF 의 특
    // 정 빌드 등)에서 native 코드 내부에서 ACCESS_VIOLATION 으로 죽이는 사례
    // 가 관찰됐다. drag 중 메인 크래시 = 전체 윈도우가 꺼지는 최악 회귀이므로
    // 확장자 화이트리스트로 nativeImage 디코더 진입 자체를 차단하고,
    // 비호환 확장자는 곧장 fallback PNG 로 빠진다.
    const SAFE_ICON_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
    if (iconImage.isEmpty()) {
      const ext0 = path.extname(filePaths[0] || "").toLowerCase();
      if (SAFE_ICON_EXT.has(ext0)) {
        try {
          iconImage = nativeImage.createFromPath(filePaths[0]);
          if (!iconImage.isEmpty()) iconSource = "firstFile:" + filePaths[0];
        } catch {
          /* even on safe ext, keep empty and fall through */
        }
      } else {
        iconSource = "skipped-unsafe-ext:" + ext0;
      }
    }
    if (iconImage.isEmpty()) {
      iconImage = nativeImage.createFromBuffer(FALLBACK_DRAG_ICON_PNG);
      iconSource = "fallback-png";
    }
    console.log("[drag:start] icon-source=" + iconSource);
    // 드래그 미리보기 아이콘 사이즈 정리 — 너무 큰 이미지는 macOS Mission
    // Control 같은 곳에서 어색하게 보인다. 64×64 로 통일(다중 파일이면
    // OS 가 "+N" 뱃지를 자동으로 얹어준다).
    try {
      const size = iconImage.getSize();
      if (size.width > 96 || size.height > 96) {
        iconImage = iconImage.resize({ width: 64, quality: "best" });
      }
    } catch {
      /* keep as-is */
    }

    // Native addon (v2) 이 로드돼 있으면 메인 UI thread 에서 OLE drag 를 직접
    // 시작 — image-mode cursor 트리거 우회. `startDrag` 는 drop/cancel 까지
    // *동기 블록* 하므로, 먼저 sendSync 응답(returnValue)을 보내 렌더러
    // dragstart 를 unblock 한 뒤 호출한다. 이렇게 해야 drag 동안 렌더러의
    // HTML5 dragover/drop (내부 폴더 이동) 이 계속 dispatch 된다.
    if (nativeDragAddon) {
      // ⚠️ returnValue 를 *먼저* set. 이후 startDrag 가 메인 스레드를 블록해도
      //    렌더러는 이미 unblock 됨. Phase 0 의 핵심 타이밍.
      respond(true);
      console.log(
        "[drag:start] native OLE BEGIN — file=" +
          filePaths[0] +
          (filePaths.length > 1 ? ` (+${filePaths.length - 1} more)` : ""),
      );
      try {
        const wallT0 = Date.now();
        // own-window cursor 보정을 위해 메인 창 HWND 를 함께 넘긴다.
        let hwnd: Buffer | undefined;
        try {
          hwnd = win.getNativeWindowHandle();
        } catch {
          hwnd = undefined;
        }
        const res = nativeDragAddon.startDrag(filePaths, hwnd);
        console.log(
          "[drag:start] native OLE END — effect=" + res.effect +
            " hr=0x" + (res.hr >>> 0).toString(16) +
            " elapsedMs=" + res.elapsedMs +
            " threadId=" + res.threadId +
            " wallMs=" + (Date.now() - wallT0),
        );
      } catch (err) {
        console.warn(
          "[drag:start] native OLE threw (renderer already unblocked):",
          (err as Error)?.message ?? err,
        );
      }
      return;
    }

    try {
      // ⚠️ returnValue 를 *먼저* set. macOS 의 `webContents.startDrag` 는 드래그
      //    세션 동안 메인을 점유하는데, sendSync 응답을 그 *뒤*에 주면 렌더러
      //    JS 스레드가 드래그 내내 sendSync 에 묶여 통째로 얼어붙는다(마우스
      //    클릭/호버/선택 전부 멈춤, 단 OS 윈도우 크롬·CSS 리플로우만 생존).
      //    Electron 에서 `event.returnValue = x` 는 *대입 즉시* 동기 응답을
      //    보내므로, 핸들러가 이후 startDrag 로 블록돼도 렌더러는 바로 unblock
      //    된다. Windows 네이티브 경로(위)와 동일한 타이밍 계약.
      respond(true);
      // Electron 의 `Item` 타입은 `file` (단수) 가 필수이고 `files` 가 옵션.
      // 한 장 드래그일 때도 동일한 시그니처를 유지해야 OS 가 인계받는다.
      win.webContents.startDrag({
        file: filePaths[0],
        files: filePaths.length > 1 ? filePaths : undefined,
        icon: iconImage,
      });
      console.log(
        "[drag:start] OK (webContents.startDrag fallback) — file=" +
          filePaths[0] +
          (filePaths.length > 1 ? ` (+${filePaths.length - 1} more)` : ""),
      );
    } catch (err) {
      // respond(true) 는 startDrag 이전에 이미 전송됐다 — 여기서 다시 응답하면
      // "Object has been destroyed" / 중복 응답이 되므로 로그만 남긴다.
      console.error("[drag:start] webContents.startDrag failed (renderer already unblocked)", err);
    }
  },
);

/* 모든 webContents 생성 시 한 번씩 호출 — 게스트(webview) 만 가드를 걸고
   메인 윈도우/devtools 는 건드리지 않는다. attach 단계에서 webPreferences
   를 잠그려면 `will-attach-webview` 가 더 적합하지만, Electron 33 부터는
   `webContents-created` 의 type 체크로도 동일 효과(게스트가 자식 webContents
   로 등장하므로 여기서 잡힌다). */
app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() === "webview") {
    installWebviewGuards(contents);
  }
});

/* will-attach-webview: 렌더러가 <webview> 를 마운트할 때 호출되어 게스트의
   webPreferences 를 메인 프로세스가 최종 결정한다. 렌더러가 nodeIntegration
   등을 켜려 시도해도 여기서 무시 — 정책을 코드 한 곳에서 강제한다. */
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (_e, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    /* partition 은 항상 우리가 만든 격리 파티션으로 강제. allowpopups 는
       false 로 강제해 새 창 생성 자체를 차단(위 setWindowOpenHandler 가 한
       번 더 거른다). */
    params.partition = WEBVIEW_PARTITION;
    delete (params as Record<string, unknown>).allowpopups;
  });
});

/** 메인(default) 세션에서도 *유튜브 임베드 응답의 frame-block 헤더만* 제거.
 *
 *  배경 — LibraryPreviewPanel / LibraryInspector / viewer PreviewModal 에서
 *  youtube embed 를 *iframe* 으로 마운트한다. iframe 은 메인 BrowserWindow 의
 *  *기본 세션* 을 사용하므로, configureWebviewSession 에 박은 정책이 적용되지
 *  않아 prod 빌드 (file:// origin) 에서 ERR_BLOCKED_BY_RESPONSE / player
 *  error 153 가 뜬다.
 *
 *  처리 두 단계:
 *    (a) 응답 헤더에서 X-Frame-Options / CSP / Cross-Origin-* 제거 (영상 CDN
 *        googlevideo 포함 전체 도메인)
 *    (b) 요청 헤더의 Referer 를 youtube 도메인으로 spoof + Origin 제거 (단,
 *        googlevideo 는 제외 — 재생 segment fetch 의 정상 Referer 를 보존해야
 *        재생이 깨지지 않는다. 아래 onBeforeSendHeaders 주석 참조)
 *
 *  (b) 가 빠진 채로 (a) 만 있던 게 v2.0.0 초기 빌드의 잔존 153 에러 원인.
 *  webview 세션과 동일한 spoof 를 default 세션에도 적용해 prod 빌드의
 *  file:// Referer 가 youtube 외부로 새는 일이 없게 한다.
 *
 *  도메인 화이트리스트로 제한 — youtube 도메인 트래픽에만 적용. 다른 외부
 *  도메인 / 우리 앱 자체 요청에는 영향 없음. 화이트리스트가 짧으므로 보안
 *  영향도 제한적이고, 이 세션은 사용자 인증 흐름이 일어나지 않는다. */
function configureDefaultSessionForVideoEmbeds(): void {
  // 응답 헤더(frame-block / CORP 등) 제거는 *영상 CDN(googlevideo / vimeocdn /
  // akamaized) 포함* 전체에 적용해야 한다 — 안 그러면 cross-origin 영상 응답이
  // CORP 로 차단될 수 있다. (Vimeo 세그먼트는 vimeocdn / akamaized 에서 온다.)
  const filter = {
    urls: [
      "https://*.youtube.com/*",
      "https://*.youtube-nocookie.com/*",
      "https://*.ytimg.com/*",
      "https://*.googlevideo.com/*",
      "https://player.vimeo.com/*",
      "https://*.vimeocdn.com/*",
      "https://*.akamaized.net/*",
    ],
  };
  // 요청 Referer/Origin spoof 는 *임베드 호스트에만* 적용한다 — 영상 segment CDN
  // (googlevideo / vimeocdn / akamaized) 은 의도적으로 제외한다(hot-link 토큰
  // 보존). Vimeo 는 임베드 문서/플레이어 JS 가 player.vimeo.com 에서 로드되므로
  // 그 호스트만 spoof 한다. (아래 onBeforeSendHeaders 주석 참조: 재생 불가 fix)
  const embedReferrerFilter = {
    urls: [
      "https://*.youtube.com/*",
      "https://*.youtube-nocookie.com/*",
      "https://*.ytimg.com/*",
      "https://player.vimeo.com/*",
    ],
  };
  session.defaultSession.webRequest.onHeadersReceived(filter, (details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase();
      if (
        lower === "x-frame-options" ||
        lower === "content-security-policy" ||
        lower === "content-security-policy-report-only" ||
        lower === "cross-origin-embedder-policy" ||
        lower === "cross-origin-opener-policy" ||
        lower === "cross-origin-resource-policy"
      ) {
        delete headers[key];
      }
    }
    callback({ responseHeaders: headers });
  });

  /* Referer / Origin override — *임베드 호스트(youtube.com / youtube-nocookie /
     ytimg)에만* 적용한다. prod 빌드의 file:// Referer 가 그대로 나가면 youtube 가
     embed 거부 (player error 153 / ERR_BLOCKED_BY_RESPONSE) 하므로 임베드 문서·
     플레이어 JS·썸네일 요청의 Referer 는 destination host 로 spoof 한다.

     ⚠️ googlevideo.com 은 일부러 제외(embedReferrerFilter)한다 — 재생 불가 fix:
       재생 버튼을 누르면 플레이어가 영상 segment 를 googlevideo CDN 에서 fetch
       하는데, 이 요청에는 플레이어가 *이미 올바른* Referer(`https://www.
       youtube-nocookie.com/`)를 실어 보낸다. 여기에 우리가 spoof 를 덮어
       `https://<...>.googlevideo.com/` 로 바꾸면 googlevideo 의 hot-link 검증이
       깨져 segment 가 차단되고 → 153 은 없는데 화면만 검게(재생 안 됨) 된다.
       제외하면 플레이어의 정상 Referer 가 보존돼 재생이 정상화된다. 임베드
       거부(153) fix 는 임베드 호스트 spoof 가 그대로 담당하므로 영향 없음. */
  session.defaultSession.webRequest.onBeforeSendHeaders(embedReferrerFilter, (details, callback) => {
    try {
      const target = new URL(details.url);
      const headers = { ...details.requestHeaders };
      headers["Referer"] = `${target.protocol}//${target.host}/`;
      delete headers["Origin"];
      callback({ requestHeaders: headers });
    } catch {
      callback({ requestHeaders: details.requestHeaders });
    }
  });
}

app.whenReady().then(async () => {
  configureWebviewSession();
  configureDefaultSessionForVideoEmbeds();
  protocol.handle("local-file", async (request) => {
    // local-file://C:/path/to/file.png?t=12345 → 디스크에서 직접 읽어 Response로 반환
    try {
      const filePath = resolveStorageFilePath(request.url);
      const data = await fs.promises.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      /* 실험 ④ (2026-05-14, 실패로 검증): 응답 MIME 을 application/octet-
       * stream 으로 박아도 Chromium byte sniffer 가 binary signature 로
       * image-mode 를 켜는 것이 확인됨. local-server.ts 의 STORAGE_MIME
       * 주석 참조. 응답 MIME 은 image-mode trigger 와 무관 → 원복. */
      const mime =
        ext === ".png" ? "image/png" :
        ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
        ext === ".webp" ? "image/webp" :
        ext === ".avif" ? "image/avif" :
        ext === ".gif" ? "image/gif" :
        ext === ".svg" ? "image/svg+xml" :
        ext === ".mp4" ? "video/mp4" :
        ext === ".webm" ? "video/webm" :
        ext === ".mov" ? "video/quicktime" :
        "application/octet-stream";
      return new Response(data, {
        status: 200,
        headers: {
          "Content-Type": mime,
          "Cache-Control": "no-cache",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch (err) {
      console.error("[local-file] failed:", request.url, err);
      return new Response("Not Found: " + request.url, { status: 404 });
    }
  });

  // 기본 application menu(File / Edit / View / Window / Help) 제거.
  // 앱 단축키는 React 쪽 keydown 핸들러로 모두 처리되므로 메뉴를 통한
  // 접근은 불필요하고, 두 번째 메뉴 띠가 사라져 화면 상단이 깔끔해진다.
  Menu.setApplicationMenu(null);

  // 워크스페이스 레지스트리 부트스트랩 + 활성 워크스페이스의 DB open.
  // userData 기본 경로를 인자로 — registry 가 처음 만들어지면 default
  // 워크스페이스 두 개(Project / Library) 가 자동 등록된다.
  //
  // 부팅은 절대 조용히 죽지 않아야 한다. initWorkspace 는 잠금 충돌을 내부에서
  // default 폴백으로 처리하므로 throw 하지 않지만, 그 외 예상 못 한 오류(예:
  // 디스크 권한, DB 손상)가 나도 최소한 창은 띄워 사용자가 상황을 인지하고
  // devtools/콘솔로 진단할 수 있게 try/catch 로 감싼다.
  try {
    await initWorkspace(app.getPath("userData"));
    await startLocalServer();
  } catch (err) {
    console.error("[main] workspace/local-server boot failed:", err);
  }
  if (!mainWindow) createWindow();

  // 앱 시작 시 orphan sweep 을 한 번 돌려 DB 에서 더 이상 참조되지 않는
  // 파일(과거 누수된 에셋 이미지, inpaint 중간 파일 등) 을 청소한다.
  // 윈도우 뜨는 것보다 나중에 시작해 UI 렌더에 영향을 주지 않도록 지연.
  // 실패해도 앱 기능에 영향 없음 — 다음 부팅에서 다시 시도.
  //
  // Phase 2.4: 부팅 직후 사용자가 즉시 Generate 를 누르는 시나리오에서
  // 3 초 시점에 동기 sweep 이 시작돼 main process 이벤트 루프를 수백 ms ~
  // 수 초간 블록했다. (a) 비동기 chunked 로 walk 자체가 양보하도록 변경
  // (orphanSweep.ts) 했고, (b) 시작 시점도 3s → 30s 로 미뤄 사용자가
  // 가장 활발히 조작하는 부팅 첫 30 초 동안엔 디스크/DB 경합을 0 으로
  // 만든다. 30 s 이후에 비로소 청크 walk 시작 — 그 시점엔 이벤트 루프
  // idle 이 충분히 확보된다.
  setTimeout(() => {
    void (async () => {
      try {
        await sweepOrphanFiles();
      } catch (err) {
        console.error("[orphanSweep] unexpected failure:", err);
      }
      // OS 드래그용 임시 `.url` 캐시 정리 — 1시간 넘은 파일은 다음 드래그
      // 에서 다시 만들어도 되므로 안전하게 삭제. 디렉터리가 없어도 무시.
      try {
        const dir = path.join(app.getPath("temp"), "preflow-drag-out");
        const entries = await fs.promises.readdir(dir).catch(() => []);
        const now = Date.now();
        const MAX_AGE_MS = 60 * 60 * 1000;
        await Promise.allSettled(
          entries.map(async (name) => {
            const full = path.join(dir, name);
            const stat = await fs.promises.stat(full).catch(() => null);
            if (!stat || !stat.isFile()) return;
            if (now - stat.mtimeMs > MAX_AGE_MS) {
              await fs.promises.unlink(full).catch(() => undefined);
            }
          }),
        );
      } catch (err) {
        console.warn("[drag:cleanup] tmpsweep failed", err);
      }
    })();
  }, 30_000);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Single-instance lock 2 nd 이벤트 — 두 번째 실행 시 기존 창을 전면으로.
// 팩 파일 더블클릭으로 두 번째 인스턴스가 뜬 경우, 그 argv 의 팩 경로를
// 받아 현재 실행 중인 렌더러로 전달한다(웜 스타트 임포트 흐름).
app.on("second-instance", (_event, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  setPendingPack(extractPackPathFromArgv(argv));
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  closeDb();
  // 워크스페이스 락 해제 — 다음 부팅 / 다른 PC 가 즉시 폴더를 사용 가능.
  shutdownWorkspace();
});
