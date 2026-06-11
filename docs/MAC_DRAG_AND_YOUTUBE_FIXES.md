# macOS 드래그아웃 hang & YouTube 검은 화면 수정 가이드

> **이 문서와 `docs/YOUTUBE_EMBED_FIX.md` 의 차이**
> - `YOUTUBE_EMBED_FIX.md` 는 **임베드 거부(player error 153 / `ERR_BLOCKED_BY_RESPONSE`)** — 즉 영상이 *아예 안 뜨는* 1차 문제를 다룹니다.
> - **이 문서**는 그 1차 수정이 끝난 *뒤* 남은 두 개의 별도 이슈를 다룹니다:
>   1. **macOS 에서 라이브러리 자료를 외부로 드래그하면 OS 레벨로 마우스가 묶이는(hang) 문제**
>   2. **YouTube 가 153 은 안 뜨는데 재생 버튼을 누르면 빈 검정 화면만 나오는 문제** (segment fetch 실패)
> 두 이슈는 원인·수정 위치가 전혀 다릅니다. 혼동하지 마세요.
>
> 메인 개발 환경(branch: `beta/2.0.0`, OS: Windows) 에 적용할 때 참고. 이 문서의 변경은 **Windows 동작에 영향을 주지 않도록** 설계돼 있습니다.

---

## 섹션 1 — 드래그아웃 OS-level hang (macOS)

### 1.1 최신 푸시본 패치가 *푸는 것* 과 *못 푸는 것*

**푸시본 위치:** `electron/main.ts` 1069–1094 (`webContents.startDrag` 폴백 경로)

```1069:1094:electron/main.ts
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
```

이 패치는 `respond(true)` 를 `win.webContents.startDrag(...)` *앞으로* 옮긴 것입니다.

- **푸는 것 (✅):** 드래그가 진행되는 동안 **renderer JS 스레드가 `sendSync` 응답을 기다리며 통째로 락** 되는 문제. `startDrag` 는 드래그 세션(drop/cancel)까지 메인 프로세스를 동기 점유하는데, 그 전에 `respond(true)` 로 동기 응답을 먼저 보내므로 렌더러의 `dragstart` 가 즉시 unblock 됩니다. 그래서 드래그 도중에도 React 의 내부 `dragover`/`drop`(폴더 이동·그리드 재정렬) 이 계속 dispatch 됩니다.

- **못 푸는 것 (❌):** **macOS `NSDraggingSession` 의 `draggingSession:endedAtPoint:operation:` 델리게이트 콜백이 발동하지 않는** 케이스. Electron 의 `webContents.startDrag` 가 만든 NSDraggingSession 이 종료 콜백을 제대로 받지 못하면, AppKit 이 잡아둔 **mouse capture 가 해제되지 않아** 드래그가 끝났는데도 OS 가 여전히 드래그 중이라고 믿습니다. 이건 renderer JS 락과는 **완전히 별개의 레이어(OS/AppKit)** 라서, `respond(true)` 타이밍을 아무리 손봐도 풀리지 않습니다.

> 참고: `native/drag-out/` 의 네이티브 OLE addon 은 `index.js` 가 `process.platform !== "win32"` 일 때 `null` 을 반환하는 **Windows 전용** 모듈입니다. 따라서 macOS 에서는 위 네이티브 경로(`main.ts` 1034–1066) 를 절대 타지 않고 **항상** 이 `webContents.startDrag` 폴백으로 빠집니다. 즉 위 hang 은 macOS 전용 폴백 경로에서만 발생합니다.

### 1.2 증상 매트릭스

| 관찰되는 증상 | 의미 |
|---|---|
| 마우스 커서가 **손바닥/grab 모양**에서 고정 | NSDraggingSession 이 아직 active 라고 OS 가 판단 |
| 화면 **전 영역 클릭이 dead** (버튼·메뉴·다른 앱 전부 무반응) | AppKit mouse capture 가 메인 윈도우에 묶여 이벤트가 라우팅 안 됨 |
| **Esc 눌러도 안 풀림** | drag cancel 키 이벤트가 capture 된 세션에 전달 안 됨 |
| **앱 focus toggle(다른 앱 클릭 → 복귀)** 해도 안 풀림 | 세션 종료 콜백 미발동이라 focus 전환으로도 capture 해제 안 됨 |
| 강제로 푸는 유일한 방법: 앱 재시작 또는 다른 데스크톱으로 전환 후 재진입 | OS 가 세션을 강제 정리해야만 capture 가 풀림 |

위 네 가지가 동시에 보이면 "renderer 락" 이 아니라 **OS-level mouse capture stuck** 입니다. (renderer 락이면 CSS hover/리플로우는 죽고 OS 윈도우 크롬만 살아있는, 정반대 패턴이 보입니다.)

### 1.3 즉시 우회 — `ENABLE_STARTDRAG_OLE` 의 Mac 분기

가장 빠르고 안전한 우회는 **macOS 에서는 OS 드래그아웃을 아예 호출하지 않는 것**입니다. (외부 export 기능을 macOS 한정으로 잠시 끄는 대신, hang 을 100% 차단.)

**적용 위치:** `src/components/library/LibraryGrid.tsx:356`

현재 코드:

```356:356:src/components/library/LibraryGrid.tsx
const ENABLE_STARTDRAG_OLE = true;
```

변경:

```ts
/* macOS 분기: Electron webContents.startDrag 폴백이 NSDraggingSession 종료
 * 콜백 미발동으로 OS 마우스 capture 를 stuck 시키는 회귀가 있어, macOS 에서는
 * OS 드래그아웃 자체를 비활성화한다(외부 export 기능을 Mac 한정으로 잠시 포기).
 * Windows 는 native/drag-out OLE addon 으로 정상 동작하므로 영향 없음.
 * 장기 해결: 섹션 4 의 native NSDraggingSession addon. */
const ENABLE_STARTDRAG_OLE =
  typeof navigator !== "undefined" &&
  navigator.userAgent.toLowerCase().includes("mac")
    ? false
    : true;
```

이 플래그가 `false` 면 드래그 핸들러(`LibraryGrid.tsx:1481` 의 `if (ENABLE_STARTDRAG_OLE) { ... }`)가 `window.preflowWindow.startDragOut(...)` 호출 자체를 건너뜁니다. → macOS 에서 OS 드래그가 시작되지 않으므로 hang 이 원천 차단됩니다. (앱 내부 드래그/그리드 재정렬은 HTML5 DnD 라 그대로 동작.)

**메인 개발 환경(Windows) 영향:** 위 분기는 `userAgent` 가 Mac 일 때만 `false`. Windows 에서는 항상 `true` 로 평가되어 **기존 네이티브 OLE 경로가 그대로 유지**됩니다. → Windows 동작 변화 0.

### 1.4 장기 해결책 개요 (Mac native addon)

즉시 우회는 macOS 에서 외부 export 를 포기하는 trade-off 입니다. 기능을 살리려면 Windows 의 `native/drag-out/` 와 **동일한 패턴의 macOS 네이티브 addon** 이 필요합니다(섹션 4 스케치 참조). 핵심은 `draggingSession:endedAtPoint:operation:` delegate 에서 **명시적으로 세션을 정리**해 mouse capture stuck 을 막는 것입니다.

---

## 섹션 2 — YouTube 검은 화면 / 재생 불가

### 2.1 원인 추적

- `YOUTUBE_EMBED_FIX.md` 의 수정으로 **임베드 거부(153)** 는 사라졌습니다.
- 하지만 **재생 버튼을 누르면** 플레이어가 영상 segment 를 `googlevideo.com` CDN 에서 fetch 하는데, **이 fetch 가 실패**해서 화면만 검게 됩니다.
- **진범:** `electron/main.ts` 의 `configureDefaultSessionForYoutubeEmbed()` 안 `onBeforeSendHeaders` 가 **matched URL 의 Referer 를 일괄 spoof** 하던 것.
  - iframe 첫 로드 (Referer=`file://`) → spoof 가 **도움** (153 fix).
  - iframe 내부 video stream fetch (플레이어가 이미 올바른 `Referer=youtube-nocookie.com` 을 실어 보냄) → spoof 가 이걸 `googlevideo.com` 으로 덮어써서 **googlevideo 의 hot-link 검증을 깸** → segment 차단 → **검은 화면**.
- **timeline scrubber 만 움직이는 이유:** scrubber 는 iframe 내부 JS 의 클라이언트 상태일 뿐이고, 실제 미디어 segment fetch 가 같은 이유로 실패하기 때문에 영상만 안 나옵니다.

### 2.2 검증 방법

DevTools(`Cmd+Option+I`) → **Network** 탭 → `googlevideo` 로 필터 → **4xx(403 등) 응답**이 보이면 hot-link 검증 실패가 확정입니다. (메인 세션 트래픽이 안 보이면 Console 에 `153` 이 없는데 화면만 검은지로 판별.)

### 2.3 현재 푸시본 상태 — 이미 수정됨 (googlevideo 제외 방식)

> ⚠️ **중요:** 이 검은 화면 수정은 **이미 현재 푸시본 코드에 반영돼 있습니다.** 방식은 "조건부 spoof" 가 아니라 **googlevideo 도메인을 Referer spoof 대상에서 제외** 하는 방식입니다. 따라서 코드 변경 없이도 **재빌드만 하면** 해결될 가능성이 큽니다. (macOS 에서 여전히 검다면 §2.5 의 재빌드 체크 먼저.)

**현재 코드:** `electron/main.ts` 1149–1211

응답 헤더 제거(frame-block/CORP)는 **googlevideo 포함 전체**에 적용하되, **요청 Referer/Origin spoof 는 임베드 호스트(youtube.com / youtube-nocookie.com / ytimg)에만** 적용하도록 필터를 둘로 나눴습니다:

```1150:1168:electron/main.ts
  // 응답 헤더(frame-block / CORP 등) 제거는 *영상 CDN(googlevideo) 포함* 전체에
  // 적용해야 한다 — 안 그러면 cross-origin 영상 응답이 CORP 로 차단될 수 있다.
  const filter = {
    urls: [
      "https://*.youtube.com/*",
      "https://*.youtube-nocookie.com/*",
      "https://*.ytimg.com/*",
      "https://*.googlevideo.com/*",
    ],
  };
  // 요청 Referer/Origin spoof 는 *임베드 호스트에만* 적용한다 — googlevideo 는
  // 의도적으로 제외한다. (아래 onBeforeSendHeaders 주석 참조: 재생 불가 fix)
  const embedReferrerFilter = {
    urls: [
      "https://*.youtube.com/*",
      "https://*.youtube-nocookie.com/*",
      "https://*.ytimg.com/*",
    ],
  };
```

```1200:1210:electron/main.ts
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
```

`googlevideo.com` 은 `embedReferrerFilter` 에서 빠져 있으므로 플레이어가 보낸 정상 Referer(`https://www.youtube-nocookie.com/`)가 **보존**되고, segment fetch 가 정상화됩니다.

### 2.4 (대안) 조건부 spoof 방식 — 단일 필터 리팩터링

도메인 제외 대신 **Referer 가 로컬 스킴일 때만 덮어쓰는** 조건부 방식도 기능적으로 동등하며, 필터를 하나로 합칠 수 있어 더 간결합니다. 향후 정리 시 선택지로 고려하세요. (현재 푸시본은 §2.3 의 제외 방식이므로 *지금 당장은 변경 불필요*.)

**적용 위치:** `electron/main.ts` 의 `onBeforeSendHeaders` 블록 (함수 `configureDefaultSessionForYoutubeEmbed` 내부, `filter` 사용)

```ts
session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
  try {
    const headers = { ...details.requestHeaders };
    const original = headers["Referer"] ?? headers["referer"] ?? "";
    // 플레이어가 이미 정상 Referer(youtube-nocookie 등)를 실어 보낸 요청
    // (특히 googlevideo segment fetch)은 절대 건드리지 않는다 — 덮어쓰면
    // hot-link 검증이 깨져 검은 화면이 된다. file://, app:// 또는 비어 있을
    // 때(=prod 빌드에서 새는 로컬 origin)만 destination host 로 spoof.
    if (!original || original.startsWith("file://") || original.startsWith("app://")) {
      const target = new URL(details.url);
      headers["Referer"] = `${target.protocol}//${target.host}/`;
    }
    delete headers["Origin"];
    callback({ requestHeaders: headers });
  } catch {
    callback({ requestHeaders: details.requestHeaders });
  }
});
```

> **두 방식 비교**
> - **제외 방식 (현재):** 필터 2개. googlevideo 를 spoof 대상에서 빼서 보존. 명시적이고 이미 검증됨.
> - **조건부 방식 (대안):** 필터 1개. Referer 가 로컬일 때만 개입 → googlevideo 뿐 아니라 플레이어가 설정한 *모든* 정상 Referer 를 자동 보존. spoof 적용 범위가 더 좁아 **보안상 덜 침해적**.
> 둘 다 검은 화면을 고칩니다. 굳이 지금 바꿀 필요는 없고, 리팩터링 타이밍에 조건부로 통합하면 코드가 단순해집니다.

### 2.5 macOS 에서 여전히 검다면 — 재빌드 체크 (가장 흔한 원인)

검은 화면 수정은 §2.3 처럼 **이미 소스에 들어가 있습니다.** macOS 빌드에서 여전히 검다면 다음 순서로 확인하세요:

1. 테스트 중인 `.app` 이 **이 fix 가 들어간 커밋 이후** 로 빌드된 것인가? (이전 빌드를 열고 있을 확률 높음)
2. `npm run build:mac` 으로 **재빌드** 후 새 `.app` 으로 재현.
3. 그래도 검으면 §2.2 의 Network 탭으로 googlevideo 4xx 가 정말 사라졌는지 확인.

---

## 섹션 3 — 적용 순서, 검증, 보안 영향

### 3.1 적용 순서 권장

1. **YouTube 부터** — 위험이 작고 범위가 좁음. (현재 푸시본은 이미 §2.3 적용 상태이므로 사실상 *재빌드 확인*만; 조건부 방식으로 바꾸고 싶으면 §2.4.)
2. **Mac OLE 분기** — `LibraryGrid.tsx:356` 한 줄을 §1.3 으로 교체.
3. **재빌드.**

### 3.2 빌드 / 검증 절차

```bash
# Windows (메인 개발 환경) — 동작 변화 없음을 회귀 확인
npm run build

# macOS 빌드 (이전 빌드와 동일 절차)
npx electron-builder --mac zip --arm64
npx electron-builder --mac zip --x64
# zip 산출물이 깨질 경우 ditto 폴백:
#   ditto -c -k --sequesterRsrc --keepParent <App>.app <App>.zip
```

검증 체크리스트:

- **드래그(Mac):** 자료를 Finder/데스크톱으로 드래그 시도 → (우회 적용 후) 드래그가 시작되지 않고 앱이 멈추지 않는지. 앱 내부 폴더 이동/그리드 재정렬은 정상인지.
- **드래그(Windows):** 외부 export 가 기존처럼 동작하고 hang 회귀 없는지.
- **YouTube(Mac):** 인스펙터/프리뷰/뷰어 모달에서 재생 버튼 클릭 → 실제 영상이 나오는지. Console 에 `153` 없고 Network 의 googlevideo 가 200 인지.

### 3.3 보안 영향 평가

- **Referer 조건부/제외 spoof:** spoof 적용 범위가 줄어드는 방향이라 **덜 침해적**. youtube 관련 도메인 외부에는 영향 없고, 이 세션은 사용자 인증 흐름이 없음.
- **`ENABLE_STARTDRAG_OLE` 의 Mac 분기:** macOS 한정으로 *기능을 제거*하는 것이므로 **보안 영향 없음**(공격면 축소).

### 3.4 관련 파일 요약

| 파일 | 위치 | 변경 종류 |
|---|---|---|
| `src/components/library/LibraryGrid.tsx` | `356` | `ENABLE_STARTDRAG_OLE` 에 Mac 분기 추가 (Windows 무영향) |
| `electron/main.ts` | `1069–1094` | 드래그 폴백 — `respond(true)` 가 `startDrag` 앞 (이미 푸시됨) |
| `electron/main.ts` | `1149–1211` | YouTube 세션 — googlevideo 제외 Referer spoof (이미 푸시됨) / §2.4 조건부로 리팩터 가능 |
| `native/drag-out/` | 모듈 전체 | Windows 전용 OLE addon. macOS 대응은 섹션 4 |

---

## 섹션 4 (선택) — Mac native NSDraggingSession addon 스케치

즉시 우회(§1.3) 대신 macOS 에서도 외부 export 를 살리려면 Windows `native/drag-out/` 와 같은 패턴의 네이티브 addon 을 추가합니다.

### 4.1 디렉터리 구조 제안

```
native/
  drag-out/          # 기존 Windows (win32)
  drag-out-mac/      # 신규 macOS (darwin)
    src/addon.mm     # Objective-C++ (~200–300줄)
    binding.gyp
    index.js         # process.platform !== "darwin" → null 반환
    package.json
```

또는 같은 모듈에 `process.platform` 분기로 `.cc`(win) / `.mm`(mac) 소스를 나눠도 됩니다.

### 4.2 핵심 macOS API

- `NSFilePromiseProvider` — 파일 약속(promise) 기반 드래그 아이템 생성.
- `-[NSView beginDraggingSessionWithItems:event:source:]` — 드래그 세션 시작.
- `-[id<NSDraggingSource> draggingSession:endedAtPoint:operation:]` — **세션 종료 델리게이트.** 여기서 **명시적 cleanup** 을 해야 mouse capture stuck 이 풀립니다(이게 Electron 폴백이 빠뜨리는 지점).

### 4.3 N-API 시그니처 제안 (Windows v2 와 동일 패턴)

```ts
// const drag = require("preflow-drag-out-mac"); // darwin 외엔 null
// 반환(동기): 드래그가 끝난 뒤(drop/cancel) 결과.
drag.startDrag(
  filePaths: string[],
  allowedEffects?: number,
): { ok: boolean; operation: number; elapsedMs: number };
```

호출 계약은 Windows v2 와 동일합니다: 메인 프로세스가 `respond(true)` 로 sendSync 응답을 **먼저** 보낸 뒤 `startDrag` 를 동기 호출. macOS 구현은 종료 델리게이트에서 세션 자원을 해제해 capture 를 반드시 정리해야 합니다.

### 4.4 빌드 환경

```bash
xcode-select --install   # Xcode Command Line Tools
# 이후 scripts/build-native.mjs 가 Electron ABI 에 맞춰 node-gyp 빌드
```

---

## 영향 범위 요약

- **이 문서 작성 작업 자체**는 신규 파일 `docs/MAC_DRAG_AND_YOUTUBE_FIXES.md` **1개만** 생성 — 기존 코드/설정 변경 없음.
- `docs/YOUTUBE_EMBED_FIX.md` 와 별개 이슈를 다루며 공존(상단 비교 박스 참조).
- 실제 코드 적용은 위 스니펫을 메인 환경에서 따라 적용. **Windows 동작 변화 없음**(Mac 분기 / spoof 범위 축소 모두 Windows 무영향).
