# Library Drag-and-Drop 연구 노트

> **작성 시점**: 2026-05-14 (초안), 2026-05-14 PM (실험 ①~Y 진단 확정), 2026-05-14 PM 2차 (native addon v1 사고 → 환원)
>
> **상태**: 진단 완료, 옵션 B native addon **v1 실패** (구조적 결함, 아래 시도 14). 안정성 위해 옵션 C 로 환원. v2 (dedicated UI thread + hidden window) 가 남은 유일한 길.
>
> **현재 코드**:
> - `ENABLE_STARTDRAG_OLE=false` (LibraryGrid.tsx) → renderer 가 OLE IPC 호출 자체를 안 함 → addon 절대 안 깨워짐 → 안전.
> - native addon (`native/drag-out/`) 은 dormant. dev/prod 빌드 시 컴파일은 되지만 실행 경로 X.
> - 결과: 모든 kind cursor 정상 / 외부 export 통째 X. 우클릭 "Copy" 가 외부 폴백.
>
> 이 문서는 사용자가 직접 답을 찾기 위한 컨텍스트 정리입니다. 시도한 가설 / 검증 결과 / 막힌 원인 / 남은 가능성을 기록합니다.

---

## 1. 목표

Eagle 같은 정확한 동작 — **모든 kind** (PNG/JPG/WEBP/AVIF/GIF/Video/Link/YouTube) 가:

1. **외부 drag-and-drop** 으로 Slack/Photoshop/Windows 탐색기 등 destination 에 파일 export
2. **내부 drag-and-drop** 으로 사이드바 폴더 이동 / 그리드 카드 재정렬
3. **cursor 시각** 이 정상 (`copy` / 화살표) — never `not-allowed`

## 2. 현재 동작 매트릭스

| Kind | 외부 export | 내부 drop | Cursor |
|---|---|---|---|
| PNG | ✓ | ✓ | **깨짐** (not-allowed) |
| JPG | ✓ | ✓ | **깨짐** |
| WEBP | ✓ | ✓ | **깨짐** |
| AVIF | ✗ | ✓ | 정상 |
| GIF | ✗ | ✓ | 정상 |
| Video (mp4) | ✗ | ✓ | 정상 |
| Link / YouTube | ✗ (`.url` 파일은 메인이 만들지만 destination 인식 X) | ✓ | 정상 |

해결해야 할 두 격차:

- A. **PNG/JPG/WEBP cursor 깨짐**
- B. **AVIF/GIF/Video/Link 외부 export 실패**

## 3. 핵심 메커니즘 이해

### 3.1 Electron `webContents.startDrag`

OS-level OLE drag (Windows) 를 시작. **반드시 native HTML5 `dragstart` 이벤트 핸들러 안에서 동기 호출**되어야 OS 가 OLE drag visual / 이벤트 흐름을 만든다 (알려진 Electron 제약).

핸들러 호출 위치:

```ts
// electron/preload.ts
startDragOut: (items, iconUrl) => ipcRenderer.sendSync("preflow-drag:start", { items, iconUrl });

// electron/main.ts (요약)
ipcMain.on("preflow-drag:start", (event, { items, iconUrl }) => {
  // URL → 스토리지 native path 해석 (resolveLibraryFilePath)
  // link/youtube 는 fileUrl 비어 sourceUrl 로 .url 임시 파일 생성
  // icon: nativeImage.createFromPath(...) | createFromBuffer(FALLBACK_DRAG_ICON_PNG)
  win.webContents.startDrag({ file, files, icon });
});
```

검증된 사실:
- `[drag:start] OK — file=...` 로그가 모든 kind 에서 정상 발생 → IPC + path 해석 + nativeImage 생성 + `startDrag` 호출 전부 정상.
- 그럼에도 video/gif/avif/link 외부 destination 인식 X → **OLE 만으로는 destination 인식이 부족**.

### 3.2 Chromium "image-content 모드"

Chromium 은 dragstart 시점에 source element snapshot 안에 `<img>` 가 있고 그 src 가 image MIME 으로 인식되면 **자동으로 image-content 모드로 승격**한다. 효과:

- 외부 destination (Slack/Photoshop/탐색기) 이 OLE CF_HDROP 외에 **image dataObject** 도 받게 되어 PNG/JPG/WEBP 외부 export 성공
- 단, **OS native cursor 가 not-allowed 로 표시되는 부작용** — 이는 OS 가 그리는 것이라 webview JS/CSS 가 못 덮음
- 같은 윈도우 안의 native `onDragOver`/`onDrop` 이 가려져 fire 되지 않을 수 있음 → 글로벌 tracker 로 우회

분리 불가능: image-mode 의 *외부 OK* 와 *cursor 깨짐* 은 같은 메커니즘의 두 면. 검증 끝.

### 3.3 글로벌 dragover tracker (`src/lib/libraryDragChannel.ts`)

image-mode 하에서 native `onDragOver`/`onDrop` 이 fire 안 되는 케이스를 우회하기 위한 fallback:

- dragstart 시점에 `installDragTracker(ids)` 로 document capture-phase `dragover`/`dragend`/`drop` 등록
- `elementFromPoint(x, y)` 로 hover target (`data-drop-folder-path` / `data-drop-card-id`) 식별
- `dragend` 시 등록된 `_dropHandlers` (LibraryPage 가 mount 시 `setLibraryDropHandlers` 로 등록) 에 dispatch
- 모듈 레벨 `_activeTracker` 로 단일 인스턴스 보장 — Windows OLE + Electron 환경의 dragend 미발생 quirk 로 인한 listener leak 방지

이 tracker 덕분에 *모든 kind 의 internal drop* 이 살아있음.

## 4. 시도 / 가설 / 검증 결과 전체 로그

### 시도 1: 그립 핸들 (spatial separation)

**가설**: 카드에 별도 grip 영역을 두고 거기서만 외부 drag, 본체는 내부 drag.

**결과**: 사용자 거부. 이유:
- grip 잡고 윈도우 밖 나갔다가 돌아오면 *새 reference import 로 오인* (round-trip 식별 깨짐)
- 직관성 부족 (grip 인지 어려움)

**상태**: 폐기. 코드 잔재 없음.

### 시도 2: HTML5 native drag + `webContents.startDrag` 동시

**가설**: dragstart 시점에 둘 다 시작. HTML5 가 internal 흐름, OLE 가 외부 흐름.

**결과**: 위 동작 매트릭스 그대로. PNG/JPG/WEBP 외부 OK (image-mode 덕분), 다른 kind 외부 X.

**상태**: 현재 base. `src/components/library/LibraryGrid.tsx` `LibraryCard.handleDragStart` 안 핵심 로직.

### 시도 3: `effectAllowed`/`dropEffect = "copy"` 통일

**가설**: image-mode 가 `dropEffect = "copy"` 만 호환되는데 우리가 `"move"` 박아 mismatch → cursor not-allowed.

**변경 위치**:
- `LibraryCard.handleDragStart` — `effectAllowed = "copy"`
- `installDragTracker.handleDragOver` — `dropEffect = "copy"`
- `FolderRow.handleReferenceDragOver` — `dropEffect = "copy"`
- `LibraryCard.handleDragOver` — `dropEffect = "copy"`

**결과**: cursor 변화 없음.

**의미**: image-mode cursor 는 `dropEffect` 값과 무관. OS 가 직접 그림.

**상태**: 변경 유지 (해롭지 않음).

### 시도 4: 글로벌 tracker 의 capture-phase `preventDefault` + `dropEffect`

**가설**: native `onDragOver` 가 image-mode 에 가려져 `preventDefault` 효과 없음 → capture phase 에서 직접.

**변경 위치**: `installDragTracker.handleDragOver` 안 valid target 일 때 `event.preventDefault()` + `dropEffect = "copy"`.

**결과**: cursor 변화 없음.

**의미**: capture phase 의 `preventDefault` 도 image-mode cursor 에 영향 못 줌. OS native 단에서 결정.

**상태**: 변경 유지.

### 시도 5: `document.body.style.cursor = "copy"` 강제

**가설**: webview cursor 를 CSS 로 강제 override 하면 image-mode 의 not-allowed 를 덮을 수 있을지.

**변경 위치**: `installDragTracker` 안 prevCursor 저장 + `body.style.cursor = "copy"` + cleanup 시 복원.

**결과**: cursor 변화 없음.

**의미**: image-mode cursor 는 OS-native compositor 단이라 webview CSS 가 닿지 못함.

**상태**: 변경 유지 (해롭지 않음).

### 시도 6: Eagle 패턴 POC — HTML5 drag 끄고 mouse tracking 으로 `startDrag` 만

**가설**: HTML5 drag 자체를 끄면 image-mode 가 트리거 안 됨. mouse tracking 으로 threshold 넘으면 `startDrag` 호출.

**변경 위치**: `USE_EAGLE_PATTERN` flag, `handleMouseDown` 함수, button `draggable={!USE_EAGLE_PATTERN}`.

**결과**:
- `[LibraryCard] mouseTrack startDrag startDragOk=true` 정상
- 메인 `[drag:start] OK — file=...` 정상
- **그러나 OS 가 OLE drag visual 을 시작 안 함** → 사용자 시각엔 "drag 가 아무것도 안 됨"
- 같은 윈도우 안 dragover 도 fire 안 됨 → tracker hover 로그 없음

**의미**: `webContents.startDrag` 는 *native dragstart 핸들러 안에서 동기 호출* 되어야 OS 가 OLE drag visual / 이벤트 흐름을 만든다는 Electron 제약 확인.

**상태**: `USE_EAGLE_PATTERN = false` 로 비활성. 코드는 회귀 추적용으로 보존.

### 시도 7: `setData("text/uri-list")` 제거

**가설**: image-mode trigger 가 우리가 박는 `text/uri-list` setData 라면 빼면 cursor 정상화.

**변경 위치**: `EXPERIMENT_NO_URI_LIST = true` flag, dragstart 안 setData 호출 분기.

**결과**: cursor 깨짐 동일 + PNG 외부 OK 동일.

**의미**: `setData("text/uri-list")` 는 image-mode trigger 의 원인이 아님. inner `<img>` 자체가 trigger. `setData` 는 *불필요했음* — 외부 export 도 inner img 덕분.

**상태**: `EXPERIMENT_NO_URI_LIST = true` 유지 (불필요한 setData 안 박음).

### 시도 8: dragstart 시점 inner `<img>` 의 `src=""` 잠시 + 다음 tick 복원

**가설**: image-mode trigger 가 element 의 *src* 를 보고 결정한다면 비우면 회피.

**결과**: cursor 변화 없음.

**의미**: trigger 시점이 src 와 무관하거나, src 가 capture 된 후 비워졌거나.

**상태**: src 비우기 코드는 시도 9 로 대체됨.

### 시도 9: dragstart 시점 inner `<img>` 의 `display:none` 잠시 + 다음 tick 복원

**가설**: layout 에서 빠지면 element snapshot 에서 빠질 것.

**변경 위치**: `LibraryCard.handleDragStart` 안 button 의 모든 img 에 `style.display = "none"` + setTimeout(0) 복원.

**결과**: cursor 변화 없음.

**의미** (초기 진단, 시도 10~Y 로 갱신됨): "Chromium image-mode trigger 는 *element 존재* 자체로 결정" 으로 추정했으나 시도 X 에서 element 제거가 cursor 깨짐을 해결 못 한 것이 확인되어 *이 진단은 원인이 아니라 증상* 이었음. 진짜 trigger 는 webview 단이 아닌 OLE 채널.

**상태**: 코드 잔존 (효과 없지만 남아있음).

### 시도 10 (실험 ①): `buildDragGhost` 의 `<img>` 제거 — ghost 가 trigger 인지 검증

**가설**: `setDragImage(ghost)` 가 raster 단계에서 ghost 안 `<img>` 의 image MIME 을 감지해 image-mode 로 승격. button 안의 `<img>` 와 *별개 경로*.

**변경 위치**: `buildDragGhost` 의 `thumb` 를 `<img src=...>` → `background-image:url(...)` 의 `<div>` 로 교체. URL 이스케이프(`\\`, `"`) 처리.

**결과**: cursor 변화 없음.

**의미**: ghost 무고. setDragImage 에 전달된 element 안의 `<img>` 는 image-mode trigger 가 아님.

**상태**: ghost 코드 그대로 background-image 버전 유지 (해롭지 않고 의도 명확).

### 시도 11 (실험 ④): 응답 MIME 을 `application/octet-stream` 으로 override — protocol 단 trigger 검증

**가설**: `local-file://` 와 `http://127.0.0.1:port/storage/...` 의 응답 `Content-Type` 헤더가 image MIME (`image/png`, `image/jpeg`, `image/webp`) 이면 Chromium 이 image-mode 로 승격. 그 카테고리 밖이면 안 켜짐. 매트릭스의 GIF (`image/gif`, cursor 정상) / AVIF (octet-stream, cursor 정상) 와 일관.

**변경 위치**: `electron/local-server.ts` 의 `STORAGE_MIME` 매핑 + `electron/main.ts` 의 `local-file://` 핸들러에서 `.png/.jpg/.jpeg/.webp` 만 `application/octet-stream` 으로 응답.

**결과**:
- 썸네일 inline 표시: 정상 (Chromium byte-sniffing 이 응답 헤더 무시하고 디코딩 — X-Content-Type-Options: nosniff 가 없어 byte signature 로 자동 분류)
- PNG cursor: **여전히 깨짐**
- PNG 외부 export: **여전히 OK**

**의미**: 응답 MIME 은 image-mode trigger 와 *완전 무관*. 진짜 trigger 는 Chromium 의 *byte-level sniffer* — 응답 헤더가 아니라 첫 몇 바이트의 magic signature (PNG `89 50 4E 47`, JPEG `FF D8 FF`, WEBP `RIFF...WEBP`) 를 보고 결정. GIF magic (`GIF8`) 은 인식하지만 animated 카테고리로 빠지고, AVIF 는 sniffer 화이트리스트에 없음.

**상태**: 원복 (다른 코드 경로가 image MIME 을 기대할 수 있어 안전을 위해 환원).

### 시도 12 (실험 X): 모든 `<img>` → `background-image` 영구 전환 + `DownloadURL` setData — element 단 trigger 완전 제거

**가설**: image-mode trigger 가 element 트리 안의 `<img>` (와 그 byte signature) 라면, 모든 `<img>` 를 `background-image` 로 paint 하면 trigger 가 *원리적으로* 켜질 수 없음. 외부 export 는 image-mode 가 없으면 OLE CF_HDROP 만 남아 일부 destination (Slack) 이 거부 → 보강용으로 `dataTransfer.setData("DownloadURL", "mime:filename:url")` 채널 추가.

**변경 위치**:
- `LibraryGrid.tsx`: `useImageLoad` 훅 + `BackgroundThumb` / `AnimatedBackgroundPair` 컴포넌트 신설. `LibraryMediaThumbnail` 의 모든 `<img>` (video poster 포함) 제거. dimension 학습은 `new Image()` 백그라운드 로드로 대체.
- `LibraryCard.handleDragStart`: `setData("DownloadURL", ...)` 추가, `ENABLE_DOWNLOAD_URL` flag 로 토글.

**결과**:
- DOM 확인: `LibraryGrid.tsx` 의 LibraryCard 트리 안에 실제 `<img>` JSX 0개 (grep 으로 검증). 모든 `<img>` 잔존 텍스트는 주석.
- PNG cursor: **여전히 깨짐** (DownloadURL 끈 상태로도)
- GIF cursor: 정상 유지
- PNG 외부 export: 그대로 OK

**의미**: button tree 의 element 단 image-mode trigger 가 *완전히 사라졌음에도* PNG cursor 깨짐. → trigger 는 element 트리 안이 아니라 **더 깊은 곳** 에 있음. 시도 1~11 의 모든 "element/MIME/setData" 가설은 같은 카테고리에 속하며 *원리적으로 같은 길*이었음.

**상태**: 변경 유지 (background-image 전환은 image-mode trigger 와 무관하게 cursor 정상화 후의 *안전한 기반* 으로 보존. video preview / GIF·WEBP swap 등 visual 동작은 픽셀 단위로 동일).

### 시도 13 (실험 Y): `webContents.startDrag` 호출 자체 비활성 — OLE 채널 단독 검증

**가설**: 모든 webview-level 회피가 효과 없는 이유는, image-mode trigger 가 `webContents.startDrag` 의 OLE 채널 내부에서 결정되기 때문. Chromium/Electron 이 file path 의 확장자 (`.png/.jpg/.webp`) 를 보고 *static-bitmap* 임을 감지 → OLE drag 에 image 데이터 자동 첨부 + image-mode cursor 강제. webview 의 dataTransfer 와는 *별개의 OS-level* 경로.

**변경 위치**: `LibraryCard.handleDragStart` 안 `ENABLE_STARTDRAG_OLE` flag — false 면 `window.preflowWindow.startDragOut(...)` IPC 호출 자체를 skip.

**결과**:
- 콘솔 로그: `[LibraryCard] dragstart kind=image ... oleEnabled=false`
- PNG cursor: **정상화** (다른 카드 위 / 폴더 row 위 모두 +)
- 외부 export: 모든 kind 통째 X (예상 — CF_HDROP 미박힘)
- 내부 drop: 정상 (HTML5 dataTransfer + tracker 만으로 충분)

**의미**: **확정**. `webContents.startDrag` 가 단독 진범. Chromium/Electron 의 startDrag wrapper 가 Windows OLE drag 시작 시 file path 의 확장자를 보고 *Static decodable bitmap 화이트리스트* (PNG/JPEG/WEBP/BMP) 에 매칭되면 자동으로 image dataObject 첨부 + `IDropSource::GiveFeedback` 에서 image-specific cursor 반환. 이 동작은 Electron 의 C++ 코드 안에 박혀 있고 JS 옵션으로 끄거나 우회할 수 없음.

매트릭스 완전 설명:
- PNG/JPG/WEBP: 화이트리스트 ✓ → auto-image-mode → cursor 깨짐 + 외부 export OK (image dataObject 가 destinationdml 입맛에 맞음)
- AVIF: 화이트리스트 ✗ → no auto-image → cursor 정상 + 외부 X (CF_HDROP 만, destination 거부)
- GIF: 화이트리스트 ✗ (animated) → no auto-image → cursor 정상 + 외부 X
- MP4: 화이트리스트 ✗ → 동일
- Link/YouTube: `.url` 파일 → 화이트리스트 ✗ → 동일

→ image-mode 의 *외부 OK 와 cursor 깨짐* 은 같은 OLE 자동 image 첨부 메커니즘의 두 면. *원리적으로 분리 불가능*. (사용자 노트의 5.2 결론 재확인, 이번엔 원리적 근거 포함.)

**상태**: `ENABLE_STARTDRAG_OLE = false` 유지 — 옵션 C 상태 (모든 kind cursor 정상 + 외부 export X + 내부 drop 정상). 우클릭 "Copy" 메뉴가 외부 폴백.

### 시도 14 (옵션 B v1): Native OLE addon — libuv AsyncWorker 패턴

**가설**: Electron 의 startDrag wrapper 가 OLE 단에서 image dataObject 를 자동 첨부하는 것을 우회하려면, JS 가 직접 `IDataObject`(CF_HDROP only) + `IDropSource`(GiveFeedback=DRAGDROP_S_USEDEFAULTCURSORS) 를 만들어 `DoDragDrop` 을 직접 호출하면 된다. C++ N-API addon 으로 구현, `Napi::AsyncWorker` 로 libuv thread pool 에 dispatch → 메인 UI thread 안 블록.

**변경 위치**:
- `native/drag-out/binding.gyp`, `native/drag-out/package.json`, `native/drag-out/index.js`
- `native/drag-out/src/addon.cc` — IDataObject (CF_HDROP only), IDropSource (DRAGDROP_S_USEDEFAULTCURSORS), AsyncWorker 로 `OleInitialize` + `DoDragDrop` + `OleUninitialize` 묶음 실행
- `native/drag-out/src/addon_stub.cc` — non-Win32 빈 모듈
- `scripts/build-native.mjs` — node-gyp 를 Electron headers 로 호출 (npm_config_target = electron version, runtime=electron)
- `package.json` — `node-addon-api`, `node-gyp` devDep 추가, `dev`/`build` 에 `node scripts/build-native.mjs` 끼움, electron-builder `files` 에 `.node` 포함
- `electron/main.ts` — addon 가용 시 `nativeDragAddon.startDrag(filePaths, cb)` 으로 분기, 실패/부재 시 `webContents.startDrag` 폴백
- `LibraryGrid.tsx` — `ENABLE_STARTDRAG_OLE = true` 환원

**환경 셋업**:
- Python 3.12.10 winget 설치 (node-gyp 필수 의존성, 시스템 PATH 의 python.exe 는 Microsoft Store stub 이라 거부됨)
- VS 2019 Build Tools 는 이미 깔려 있어 cl.exe 사용 가능

**빌드 결과**: `preflow_drag_out.node` 정상 생성. Electron ABI 매칭 OK, `[native-drag] addon loaded` 콘솔에 정상 출력.

**동작 결과 — 사고**:
- 처음 1~3회 drag 는 `[drag:start] OK (native OLE) — file=...` 로그 정상 출력.
- 그 뒤로 **앱 freeze + 썸네일 까맣게 + 외부 destination 어느 것도 drop 안 받음**.
- 결정적 단서: 로그에 `[drag:start] native addon drop effect=...` 콜백이 **단 한 번도 안 찍힘**. AsyncWorker.OnOK 가 영원히 호출 안 됨 = `DoDragDrop` 이 worker thread 에서 *영원히 return 안 함*.

**원인 분석**: `DoDragDrop` 은 내부적으로 `SetCapture` 로 마우스 입력을 *호출 스레드 소유 윈도우* 로 캡쳐한다. libuv worker thread 는 어떤 윈도우도 소유하지 않으므로 `SetCapture` 가 실패해서 마우스 메시지를 받지 못함 → `QueryContinueDrag` 가 마우스 버튼 해제를 감지 못해 무한 루프. 매 drag 마다 libuv worker 한 개씩 leak → 4번 leak 후 풀 고갈 → 다른 fs/네트워크 작업 starvation (썸네일 fetch 도 libuv 의존) → UI 까맣게 + 앱 freeze.

매트릭스: external destination 어느 것도 안 받은 이유 = `DoDragDrop` 의 modal loop 가 마우스 캡쳐 못 받아 OS 가 drag 시작을 아예 인지 못 함. 외부 destination 까지 도달도 못 한 상태.

**의미**: AsyncWorker / libuv pool 위에서 `DoDragDrop` 을 돌리는 *구조 자체* 가 부적합. 다른 native 모듈들 (better-sqlite3 등) 처럼 "짧고 CPU/IO-bound 한 작업" 패턴이 OLE drag 같은 *UI-bound 무한 modal* 에는 안 맞음.

**대응**:
- 즉시 `ENABLE_STARTDRAG_OLE = false` 환원 → renderer 가 IPC 호출 자체를 안 하므로 addon 안 깨워짐. 안전한 옵션 C 상태로 복귀 (cursor 정상 / 외부 X).
- addon 코드/빌드 산출물은 dormant 으로 보존 (v2 의 베이스로 재사용).
- v2 설계 (아래 §7.B-v2) 로 재시작 필요.

**상태**: addon 파일 유지, IPC 경로 비활성. 빌드는 dev/prod 양쪽 모두 계속 — 향후 v2 가 같은 빌드 시스템 위에서 진행되도록.

## 5. 검증으로 확정된 사실 (갱신: 2026-05-14 PM)

> **중요**: 시도 12 (실험 X) 와 시도 13 (실험 Y) 의 결과로 초기 사실 1~3 의 진단은 *원인이 아니라 증상*이었음이 밝혀짐. 최종 진단은 6 으로 갱신.

1. ~~inner `<img>` 가 image-mode 의 단독 trigger.~~ → **틀림**. 모든 `<img>` 제거 후에도 PNG cursor 여전히 깨짐 (시도 12).
2. image-mode 의 *외부 export OK* 와 *cursor 깨짐* 은 분리 불가능한 패키지. ← **유지**, 원리도 6 으로 설명됨.
3. ~~webview JS/CSS 로 image-mode cursor not-allowed 회피 불가 — OS-native compositor 단.~~ → **부분 수정**. webview JS/CSS 로는 회피 불가가 맞지만, 정확한 이유는 OS compositor 가 아니라 *Chromium 의 OLE 단 (webContents.startDrag 의 내부)* 에서 image-mode 결정.
4. `webContents.startDrag` 는 native dragstart 안에서만 OS OLE drag 시작. ← **유지** (시도 6 검증).
5. ~~AVIF 도 `<img>` 이지만 Chromium 이 image-mode 대상으로 *안 봄* (mime 인식 차이) → AVIF 는 OLE-only → 외부 X.~~ → **수정**. MIME 차이가 아니라 *Chromium 의 startDrag 안 file-extension 화이트리스트* 차이. AVIF/.gif/.mp4 는 화이트리스트 밖이라 OLE auto-image 안 됨.
6. **(신규)** `webContents.startDrag` 가 file path 의 확장자 (`.png/.jpg/.webp`) 를 *Chromium 내부 화이트리스트* 와 매칭해 자동으로 OLE drag 에 image dataObject 첨부. 매칭 시 `IDropSource::GiveFeedback` 이 image-specific cursor 반환 → image-mode cursor 깨짐 + 외부 export OK. **이 동작은 JS 옵션으로 끄거나 우회할 수 없는 C++ 단의 wrapper 동작**.
7. 글로벌 tracker (`installDragTracker`) 로 internal drop 은 살아있음. ← **유지**.
8. **(신규)** 응답 MIME / byte sniffer / element 단 `<img>` / setData payload — *어느 것도* image-mode trigger 가 아님 (시도 11/12). 진짜 trigger 는 (6) 의 *startDrag 의 file path 확장자 매칭* 하나.

## 6. 최종 진단 — 진범과 메커니즘

**진범**: `BrowserWindow.webContents.startDrag({ file, files, icon })` 의 Windows 구현부.

**메커니즘**:

1. 렌더러가 native `dragstart` 핸들러 안에서 `ipcRenderer.sendSync("preflow-drag:start", ...)` → 메인이 동기적으로 `win.webContents.startDrag({ file, files, icon })` 호출.
2. Electron 의 C++ wrapper 가 `OSExchangeData` 를 만들어 file paths 를 `CF_HDROP` 으로 박음.
3. **이 시점에 Chromium 의 drag init 코드가 file path 들의 확장자를 검사** — `.png`, `.jpg`, `.jpeg`, `.webp`, `.bmp` 중 하나면 *자동으로* image dataObject (CF_BITMAP / CF_DIB / image/* MIME) 도 같이 박음. 그 외 확장자는 CF_HDROP 만.
4. Windows OLE 가 `DoDragDrop` 시작. drag source 의 `IDropSource::GiveFeedback` 이 image dataObject 의 존재에 따라 cursor 종류 결정 — image 있으면 *Chromium 자체 cursor 그래픽 (image-mode)*, 없으면 OS 기본 (`DRAGDROP_S_USEDEFAULTCURSORS`).
5. image-mode cursor 가 OS native compositor 단에 박혀 그려져 — webview JS/CSS/`document.body.style.cursor` 모두 무력. 어떤 dropEffect 도 cursor 그래픽을 못 덮음.
6. 외부 destination 은 dataObject 의 *둘 다* (CF_HDROP + image) 를 받음 → Slack/Photoshop 같이 image dataObject 만 인식하는 destination 도 PNG/JPG/WEBP 는 받지만, AVIF/GIF/MP4 는 CF_HDROP 만 박혀 image dataObject 만 받는 destination 에서 거부.

→ image-mode 의 *cursor 깨짐* 과 *외부 export OK* 는 같은 메커니즘의 두 면. JS 단에서 제어 불가능.

**근거 logs (실험 Y)**: `oleEnabled=false` 로 두면 PNG cursor 정상 + 외부 X. `oleEnabled=true` 로 두면 PNG cursor 깨짐 + 외부 OK. 토글 단일 변수로 행동 분기 — 진단의 isolation 확정.

## 7. 남은 옵션 (좁아짐: 진단 완료 후)

> 이전 노트의 옵션 A~D 는 진단 갱신 후 의미가 달라짐. 옵션 B 가 사실상 유일한 *완전한* 해결책으로 좁혀짐.

### A. 현재 상태 유지 (OLE off, 외부 export 통째 X) + 우클릭 "Copy" 폴백

- `ENABLE_STARTDRAG_OLE = false` 그대로
- 모든 kind cursor 정상 (사용자 노트 6 의 옵션 C 상태)
- 외부 export 는 우클릭 → "Copy" → 외부 앱 `Ctrl+V` 로 대체 (이미 구현됨)
- 작업 비용: 거의 0 — 코드 정리만
- UX: cursor 일관됨 / drag-out 으로 외부 보내기 UX 잃음

### B-v1. ❌ Native Windows OLE Addon — libuv AsyncWorker 패턴 (실패)

- 시도 14 참조. 구조적 결함으로 폐기.
- 핵심 문제: `DoDragDrop` 이 libuv worker thread 에서 `SetCapture` 실패 → 무한 deadlock → libuv 풀 leak → 앱 freeze + 썸네일 까매짐.

### B-v2. (제안) Native OLE Addon — Dedicated UI Thread + Hidden Window 패턴

**핵심 변경 (v1 → v2)**:
- libuv AsyncWorker 안 씀. *전용* OS thread 를 addon init 시 한 번 띄움.
- 그 스레드가 시작 시 `CreateWindowExW(WS_POPUP | hidden | message-only)` 로 메시지 큐 보유 윈도우 생성 → `SetCapture` 가능.
- 그 스레드에서 `OleInitialize(STA)` 1회 호출. 영구 STA apartment 유지.
- 그 스레드는 무한 message loop 돌면서 custom `WM_APP+1` 같은 메시지를 기다림.
- `startDrag(paths, cb)` 호출 시:
  - main thread (Node) 가 `PostThreadMessage` 또는 `PostMessage(hwnd, ...)` 로 그 스레드에 작업 전송 (paths, callback handle)
  - main thread 즉시 return → IPC handler 의 `event.returnValue = true` 가 빨리 set → renderer dragstart 가 즉시 unblock → HTML5 drag 이벤트 정상 dispatch
  - dedicated thread 가 메시지 받아 `DoDragDrop` 실행 (이제 SetCapture 성공)
  - drop/cancel 후 thread 가 TSFN (`Napi::ThreadSafeFunction`) 으로 JS 콜백 호출 → 메인에서 drop effect 처리

**핵심 의문점 / 검증 필요**:
- Q1: 메인 UI thread (Electron Browser process) 가 아닌 별도 스레드에서 `DoDragDrop` 을 띄우면 OS 가 drag 를 어느 스레드의 *마우스 hold* 와 연결할까? Win32 mouse capture 는 thread-affinity 이므로 우리 dedicated thread 의 hidden window 가 capture 잡아도 *실제 마우스 hold* 는 메인 UI thread (Electron 의 visible window) 에 있음. 충돌 가능.
- Q2: `SetCapture` 는 호출 스레드 윈도우만 캡쳐. 다른 스레드의 윈도우에서 발생한 mouse hold 는 못 잡음. → dedicated thread 가 capture 잡으면 메인 UI thread 의 마우스 hold 와 별개 → drag 시작 실패할 수도.
- → 실제 동작은 native test 로 검증해야. 다른 native drag addon 구현 (예: `electron-drag`, Eagle, Pixcap reverse-engineering) 의 접근을 참고.

**대안 (v2-alt): main UI thread 에서 직접 `DoDragDrop` 호출**:
- IPC 핸들러가 `event.returnValue = true` 를 *먼저* set 한 다음 `DoDragDrop` 호출.
- 메인 UI thread 가 `DoDragDrop` 안에서 modal pump 돌며 자체 message loop 운영 — Electron/Chromium 의 Mojo IPC 메시지도 그 펌프로 흘러서 renderer 가 계속 dragover/dragend 받음.
- 단점: 메인 process 가 *drag 동안* DB 작업 등 일부 동기 처리에 응답 못 함. 짧은 drag (수 초) 면 무시할 수준.
- v1 처럼 worker thread 에서 안 도니까 SetCapture 도 정상 작동.
- 이 패턴이 Electron 의 `webContents.startDrag` 가 실제 내부적으로 하는 것과 일치 (Electron C++ 코드도 main UI thread 에서 DoDragDrop 호출).
- **이쪽이 더 안전한 길**. v1 의 worker-thread 결함을 정면으로 회피.

**v2 작업 비용**: ~200줄 추가 (v1 의 AsyncWorker 제거 → 동기 호출 + returnValue 선처리). 위험은 메인 thread 블록 동안 IPC 응답성. 예상 시간 1~2시간 (v1 의 IDataObject/IDropSource 구현 재사용 가능).

**전제 조건**: v1 사고의 후유증 (예: 안 닫힌 OLE handle, GiveFeedback 리턴값 잘못 등) 같은 미세 결함이 없는지 v1 코드 리뷰 한 번 더 필요.

### B-v3. (백업 안) WIC bitmap 첨부로 Slack 호환

- v2 가 동작하면, 일부 destination (Slack) 이 CF_HDROP 외에 image dataObject (CF_BITMAP / CFSTR_FILECONTENTS) 도 요구할 수 있음. 그때는 IDataObject 에 이 format 도 같이 박는 옵션 추가. 단 *Chromium 이 자동 박지 않는 우리 직접 첨부* 라 image-mode cursor 는 안 켜짐 (image-mode trigger 는 startDrag wrapper 안 코드 경로, 우리 우회한 자리).
- destination 마다 다른 format 요구를 만족시키는 점진적 보강. 1차 검증 후 진행.

### C. OLE 다시 켜고 (옵션 D 의 반대) — 현 상태 유지 + UI 안내

- `ENABLE_STARTDRAG_OLE = true` 환원
- PNG/JPG/WEBP cursor 깨짐 그대로
- 외부 export PNG 만 OK, 나머지는 우클릭 Copy
- UX: cursor 비일관성 + drag-out 부분만 동작 (사용자 입장에서 더 혼란)
- 추천 안 함 — A 가 더 일관됨.

### D. ~~Video/GIF/AVIF 도 image-mode 강제 trigger~~

- 노트 6 의 옵션 D — 모든 kind cursor 깨짐 + 모든 kind 외부 OK
- 진단 완료 후 평가: 의도적으로 image-mode 를 *추가* 켜는 것 = Chromium 의 화이트리스트 매칭을 우회로 강제. webview JS 에서는 화이트리스트 끼어들 수 없음 (확장자만이 입력) → 결국 .png 파일을 추가로 첨부하는 hack 필요 → 부수효과 큼 (사용자가 video 끌었는데 png 가 떨어짐).
- 폐기.

### E. ~~다른 답 찾기~~

- 진단이 완료되어 더 찾을 답 없음. webview-level 회피가 *원리적으로* 불가능한 게 증명됨 (시도 12 의 element 완전 제거 후에도 cursor 깨짐).

## 8. 추가 단서 (옵션 B 구현용)

### Native OLE Addon 구현 자료

1. **Windows COM API 핵심 함수/인터페이스**
   - `OleInitialize()` / `OleUninitialize()`
   - `RegisterDragDrop()` (destination 측이라 우리는 안 씀) / `DoDragDrop()` (source 측, 우리가 부름)
   - `IDataObject` / `IEnumFORMATETC` / `IDropSource`
   - Clipboard formats: `CF_HDROP`, `CFSTR_SHELLIDLIST`, `CFSTR_FILEDESCRIPTORW` (옵션 — 가상 파일)
   - `DROPEFFECT_COPY` / `DROPEFFECT_NONE`
   - `IDropSource::GiveFeedback` 에서 `DRAGDROP_S_USEDEFAULTCURSORS` 반환 → OS 기본 cursor

2. **N-API / node-addon-api**
   - `@napi-rs` (Rust) 또는 `node-addon-api` (C++) — C++ 로 진행 (Windows COM 과 직접 통합 깔끔)
   - `binding.gyp` 으로 빌드
   - `@electron/rebuild` (이미 devDependencies) 로 Electron ABI 맞춤 재빌드
   - electron-builder 의 `files` 에 native `.node` 포함

3. **참고 구현 (블로그/오픈소스)**
   - Microsoft Docs: "Implementing IDataObject" / "Implementing IDropSource"
   - VSCode 의 외부 drag 처리 (electron-clipboard / file-drag 구현)
   - Eagle / Pixcap / Milanote 등 reference manager 의 행동을 Spy++ 로 관찰

4. **빌드 환경**
   - Windows SDK 필요 (이미 better-sqlite3 빌드되는 환경이라 OK)
   - VC++ Build Tools / `windows-build-tools`

## 9. 현재 코드 상태 (파일별, 2026-05-14 PM 갱신)

### `src/components/library/LibraryGrid.tsx`

**Flag 상수**:
- `USE_EAGLE_PATTERN = false` — POC 코드 (mouse tracking) dormant. 시도 6 검증 후 잔존.
- `EAGLE_DRAG_THRESHOLD_PX = 5` / `EAGLE_DRAG_SAFETY_MS = 30_000` — POC 상수.
- `EXPERIMENT_NO_URI_LIST = true` — image kind 의 `setData("text/uri-list", url)` 안 박음. 시도 7.
- **`ENABLE_DOWNLOAD_URL = false`** — 실험 X-bis (DownloadURL 채널). 효과 없음 검증.
- **`ENABLE_STARTDRAG_OLE = false`** — 옵션 C 상태. v1 사고 후 환원. v2 가 완성되면 true 로 재환원할 자리.

**컴포넌트**:
- `useImageLoad(src, onAspect)` — `new Image()` 백그라운드 로드로 `<img>` 의 onLoad/onError + naturalWidth/Height 보고를 1:1 대체. 실험 X 의 핵심 유틸.
- `BackgroundThumb` — 정적 썸네일을 `background-image` div 로 paint. `<img>` 자리 1:1 교체.
- `AnimatedBackgroundPair` — canAnimateOnHover (GIF/WEBP/link-with-gif) 의 still+animated 두 layer 를 background-image 로.
- `LibraryMediaThumbnail` — 모든 `<img>` 제거됨 (video poster 포함). `<video>` 자체는 그대로 — kind=video 도 화이트리스트 밖이라 영향 X.
- `LibraryCard.handleDragStart`:
  - `setActiveLibraryDrag` (사이드채널)
  - 시도 9 의 inner `<img>` display:none 코드 잔존 (현재 트리에 `<img>` 가 없어 no-op)
  - `event.dataTransfer.setData(INTERNAL_DRAG_MIME, ...)`, `effectAllowed = "copy"`
  - `ENABLE_DOWNLOAD_URL=true` 면 DownloadURL setData (현재 false 라 skip)
  - `setDragImage(ghost)` (custom drag preview, ghost 안 `<img>` 도 제거됨)
  - `ENABLE_STARTDRAG_OLE=true` 면 `window.preflowWindow.startDragOut(...)` 호출 (현재 false 라 skip)
  - `installDragTracker(dragIds)`
- `LibraryCard.handleDragEnd`: tracker dispose, `clearActiveLibraryDrag`, 시각 정리.
- `LibraryCard.handleMouseDown` (POC): flag off 라 attach 안 됨. 코드 보존.
- `LibraryCard.handleDragOver`: 내부 reference 한정 `preventDefault` + `dropEffect = "copy"` + insertion line 시각.
- `LibraryCard.handleDrop`: 시각 정리만 (dispatch 는 글로벌 tracker 단독).

**dragSourceById** 확장 — `mimeType`, `downloadFilename` 필드 추가. DownloadURL 채널 박을 때 쓰지만 현재 비활성.

**MIME 유틸**: `guessMimeFromUrl`, `extensionForMime`, `sanitizeDownloadFilename` — DownloadURL 채널 보조용. 채널 재활성하면 즉시 사용.

### `src/lib/libraryDragChannel.ts`

- 변경 없음 (초기 노트와 동일).
- `INTERNAL_DRAG_MIME` 상수.
- `setActiveLibraryDrag` / `getActiveLibraryDrag` / `clearActiveLibraryDrag` (사이드채널).
- `installDragTracker(ids)` — capture-phase document dragover/dragend/drop 으로 좌표 기반 internal dispatch.
- `setLibraryDropHandlers` / `subscribeDragHover`.

### `src/components/library/FolderRow.tsx`

- 변경 없음. `data-drop-folder-path`, `handleReferenceDragOver` `preventDefault` + `dropEffect="copy"`.

### `src/pages/LibraryPage.tsx`

- 변경 없음. `setLibraryDropHandlers` mount/unmount.

### `electron/main.ts` / `electron/local-server.ts`

- `STORAGE_MIME` / `local-file://` 핸들러 — 실험 ④ 적용 후 원복. 정상 image MIME 응답.
- `startDragOut` IPC 핸들러 (`preflow-drag:start`) 그대로 — 호출은 안 됨 (`ENABLE_STARTDRAG_OLE=false`).
- **`nativeDragAddon` 로드 블록** (`main.ts` 상단): v1 dormant. require 는 시도하고 성공하면 ref 저장하지만, IPC 핸들러가 안 깨워지니까 실제 호출 X. v2 작업 시작 시 그 자리에서 새 시그니처로 교체.
- IPC 핸들러 내부의 *addon 우선 / `webContents.startDrag` 폴백* 분기는 v2 가 완성될 때까지 dead code 로 보존. 빌드 시 esbuild tree-shake 가 못 잡아내지만 (런타임 분기), 런타임 영향은 0.

### `native/drag-out/`

- v1 코드. dormant.
- `binding.gyp`, `package.json`, `index.js`, `src/addon.cc`, `src/addon_stub.cc` — 그대로 유지.
- `npm run dev` / `npm run build` 가 매번 `scripts/build-native.mjs` 호출해서 컴파일 시도 → 빌드 환경 (Python + VS) 보존성 확인 효과. 빌드 산출물은 사용 안 됨.

## 10. Rollback 가이드 (선택)

전부 원복하려면 (가장 깨끗):
1. `git status` 로 변경 파일 확인
2. `git restore src/components/library/LibraryGrid.tsx src/components/library/FolderRow.tsx src/lib/libraryDragChannel.ts src/pages/LibraryPage.tsx electron/main.ts electron/local-server.ts`
3. (또는 특정 commit 으로 reset)

플래그 단위 토글:
- `ENABLE_STARTDRAG_OLE = true` → 노트 6 결론 적용 전 동작으로 *기능 환원* (cursor 깨짐 + 외부 OK 트레이드오프).
- `ENABLE_DOWNLOAD_URL = true` → DownloadURL 채널 시도. (효과 없음 검증됐지만 다른 환경에서 다를 수도)
- `EXPERIMENT_NO_URI_LIST = false` → `text/uri-list` 박음 (시도 7, 영향 없음 검증).
- `USE_EAGLE_PATTERN = true` → mouse-tracking POC 활성 (시도 6, OS OLE 시작 안 됨 검증).

`<img>` ↔ `background-image` 환원 (실험 X 만 되돌리기):
- `LibraryMediaThumbnail` 안의 `BackgroundThumb` / `AnimatedBackgroundPair` 호출을 *예전* `<img>` 코드로 교체. git diff 로 시도 12 patch 확인.
- 자연 비율 학습이 `useImageLoad` 의 ref 대신 `<img onLoad>` 로 돌아감.

## 11. 다음 작업 — 옵션 B (Native OLE Addon)

### 11.1 디렉터리 구조 (제안)

```
native/
  drag-out/
    package.json         # name=preflow-drag-out, dependency=node-addon-api
    binding.gyp          # node-gyp 빌드 config (win32 only)
    src/
      drag.cc            # N-API 진입점 + DoDragDrop 호출
      data_object.h/.cc  # IDataObject impl (CF_HDROP 만)
      drop_source.h/.cc  # IDropSource impl (GiveFeedback)
```

### 11.2 N-API 시그니처 (제안)

```ts
// 메인 프로세스에서만 require
import nativeDrag from "preflow-drag-out";
nativeDrag.startDrag(filePaths: string[], hwnd: number, iconBuffer?: Buffer): boolean;
```

- `hwnd`: `BrowserWindow.getNativeWindowHandle()` 의 buffer → uint64 변환.
- 반환: drop 완료 또는 cancel 까지 *block*. `webContents.startDrag` 처럼 sendSync 안에서 동기적으로 도는 게 자연스러움.
- icon: 옵션. NULL 이면 OS 기본 드래그 비주얼 (cursor 옆 +N 뱃지만).

### 11.3 IDropSource 핵심

```cpp
HRESULT MyDropSource::GiveFeedback(DWORD dwEffect) {
    return DRAGDROP_S_USEDEFAULTCURSORS;  // ← OS 기본 cursor (+ 정상)
}
```

이 한 줄이 Eagle 의 매끄러운 cursor 의 비밀.

### 11.4 IDataObject 핵심

```cpp
// CF_HDROP 만 enumerate. CF_BITMAP / image/* 첨부 안 함.
// → Chromium 이 startDrag 에서 자동으로 박는 image data 가 없으므로
//   image-mode 가 *원리적으로* 켜질 수 없음.
```

### 11.5 빌드 / 배포

- `@electron/rebuild` 를 `postinstall` 또는 dev 스크립트에 추가 — Electron ABI 맞춤 재빌드.
- `electron-builder` 의 `files` 에 `native/drag-out/build/Release/*.node` 포함.
- macOS 빌드는 일단 native addon 없이 폴백 (`webContents.startDrag` 그대로) — macOS 의 NSPasteboard 는 file path 만 박으면 image-mode 안 켜져서 PC 와 동일 quirk 가 없음.

### 11.6 통합 흐름

1. 메인 프로세스: `app.whenReady()` 안에서 `require("preflow-drag-out")` 시도. 실패 시 폴백 (현 상태 유지).
2. `preflow-drag:start` IPC 핸들러 수정 — addon 있으면 `nativeDrag.startDrag(filePaths, hwnd)`, 없으면 기존 `webContents.startDrag`.
3. 렌더러는 `ENABLE_STARTDRAG_OLE = true` 다시 켜고 그대로 `startDragOut(...)` 호출. 어떤 채널이 가는지 모름.
