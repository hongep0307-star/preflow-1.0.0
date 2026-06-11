// preflow_drag_out — Windows OLE drag-source 네이티브 애드온.
//
// v2 (2026-06-05) — Phase 0: 메인 UI thread 동기 DoDragDrop.
//   v1 의 libuv AsyncWorker 패턴은 worker thread 가 윈도우 미소유 →
//   SetCapture 실패 → DoDragDrop 영구 deadlock → 앱 freeze 로 폐기
//   (DRAG-AND-DROP-RESEARCH.md §시도 14 / §B-v1).
//
//   v2 는 `DoDragDrop` 을 *호출 스레드(=메인 UI thread)* 에서 동기로 돌린다.
//   메인 UI thread 는 BrowserWindow 를 소유하므로 SetCapture 가 성공한다.
//   이는 Electron 자체 `webContents.startDrag` 가 내부적으로 하는 것과 동일
//   패턴이다. 호출자(main.ts) 는 이 함수를 부르기 *전에* sendSync 의
//   `event.returnValue=true` 를 먼저 set 해 렌더러 dragstart 를 즉시 unblock
//   시키고, 그 뒤 이 함수가 drag 가 끝날 때까지 메인 스레드를 블록한다.
//   DoDragDrop 이 도는 동안 자체 modal message pump 가 윈도우 메시지를
//   계속 펌프하므로 OS drag 비주얼/드롭 인식은 정상 동작한다.
//
//   ⚠️ Phase 0 검증 포인트 (DRAG-AND-DROP-RESEARCH.md §B-v2):
//     (1) freeze 가 재발하지 않는가 (메인 스레드 SetCapture 성공 → return 정상).
//     (2) drag 동안 렌더러가 dragover/drop 을 계속 dispatch 받는가
//         (내부 폴더 이동/재정렬 생존 여부).
//   실패 시 dedicated UI thread + hidden window + TSFN 변형으로 전환.
//
//   IDataObject / IDropSource 구현은 v1 그대로 재사용.
//
// 왜 만들었나
// -----------
// Electron 33 의 `webContents.startDrag` 는 Windows 에서 파일 경로의 확장자
// (.png/.jpg/.jpeg/.webp/.bmp) 를 보고 *자동으로* OLE drag 의 IDataObject 에
// image dataObject (CF_BITMAP / CF_DIB / image/* MIME) 를 함께 박는다. 이렇게
// 박히면 Chromium 의 IDropSource 가 image-content cursor mode 로 진입해 OS
// 기본 + cursor 가 아닌 Chromium 자체의 "이 자료를 사본으로 받을 수 없다는
// 빨간 ⓧ" cursor 가 그려진다. 이 cursor 는 OS 네이티브 컴포지터 단에서 합성
// 되므로 webview 의 JS/CSS 로는 절대 덮어쓸 수 없다.
//
// 이 모듈은 OLE drag 를 직접 시작해서 *image dataObject 를 의도적으로 박지
// 않고*, IDropSource::GiveFeedback 이 DRAGDROP_S_USEDEFAULTCURSORS 를 반환
// 하도록 만든다. 결과: 모든 file 확장자에 대해 OS 기본 copy cursor (` + `)
// 가 정상적으로 보이면서, 외부 destination (탐색기/Slack/Photoshop) 도
// CF_HDROP 를 받아 파일로 인식한다.
//
// 진단 근거: DRAG-AND-DROP-RESEARCH.md 의 시도 ① ~ Y (특히 12·13).
//
// API
// ---
// JS:
//   const drag = require("preflow-drag-out");
//   const res = drag.startDrag(filePaths: string[], allowedEffects?: number);
//   // res = { ok, effect, hr, elapsedMs, threadId }
//
// - filePaths: 절대 경로 배열 (CF_HDROP 에 그대로 박힘). 검증은 호출자 책임.
// - allowedEffects: 옵셔널 DWORD (DROPEFFECT_COPY | LINK 기본).
// - 반환: drag 가 *끝난 뒤* (drop 또는 cancel) 동기 반환. effect 는 최종
//   DROPEFFECT, hr 은 DoDragDrop 의 HRESULT (DRAGDROP_S_DROP / _CANCEL).
//   호출 스레드는 drag 동안 블록되므로, 호출자는 이 함수를 부르기 전에
//   sendSync 응답(event.returnValue)을 먼저 보내야 한다.
//
// 구현 메모
// --------
// - DoDragDrop 은 modal message loop 를 돌리므로 호출 스레드가 *블록*된다.
//   v2 는 이를 *메인 UI thread* 에서 동기로 돌린다. 메인 UI thread 가
//   BrowserWindow 를 소유하므로 SetCapture 가 성공하고 DoDragDrop 이 정상
//   종료한다 (v1 의 worker-thread deadlock 회피).
//
// - OLE 는 thread-affinity 가 있어 OleInitialize / DoDragDrop / Release /
//   OleUninitialize 가 *같은 스레드* 에서 일어나야 한다. 이 함수 한 번의
//   호출 안에서 전부 처리하므로 보장됨. 메인 UI thread 는 Chromium 이 이미
//   OLE 초기화해 둔 상태라 OleInitialize 는 보통 S_FALSE (이미 init) 를
//   반환하며, 그래도 ref count 균형을 위해 OleUninitialize 로 짝맞춘다.
//
// - Phase 0 진단: StartDrag 진입/DoDragDrop 시작·종료 시점에 thread id 와
//   경과 ms 를 stderr 로 찍어, freeze(=종료 로그 없음) 여부와 메인 스레드
//   사용 여부를 즉시 확인할 수 있게 한다.

#ifdef _WIN32

#include <napi.h>

#include <windows.h>
#include <ole2.h>
#include <shlobj.h>
#include <shellapi.h>
#include <objidl.h>

#include <atomic>
#include <new>
#include <string>
#include <vector>
#include <cstring>
#include <cstdio>

// ────────────────────────────────────────────────────────────────────────
//  IDataObject — CF_HDROP 전용.
// ────────────────────────────────────────────────────────────────────────
//
// 표준 Shell IDataObject 를 우리가 직접 만들어서 published format 을
// CF_HDROP 한 가지로 한정한다. 외부 앱 (Slack/Photoshop/탐색기) 이 보는
// 페이로드는 "여러 파일 경로의 목록" 그 자체 — image data 없음.
//
// Chromium 이 startDrag wrapper 안에서 image dataObject 를 *자동 첨부* 하던
// 코드 경로를 통째로 우회하므로, image-mode cursor 가 켜질 trigger 자체가
// 사라진다 (사용자 노트의 진단 6 메커니즘).

class FileDataObject : public IDataObject {
public:
  // paths 는 wide string 배열 — Win32 API 는 UTF-16. 호출부에서 UTF-8 →
  // UTF-16 변환을 미리 마치고 넘긴다.
  explicit FileDataObject(std::vector<std::wstring> paths) : paths_(std::move(paths)) {}

  // IUnknown ─────────────────────────────────────────────────────────────

  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
    if (ppv == nullptr) return E_POINTER;
    if (riid == IID_IUnknown || riid == IID_IDataObject) {
      *ppv = static_cast<IDataObject*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }

  ULONG STDMETHODCALLTYPE AddRef() override {
    return static_cast<ULONG>(++ref_);
  }

  ULONG STDMETHODCALLTYPE Release() override {
    LONG c = --ref_;
    if (c == 0) delete this;
    return static_cast<ULONG>(c);
  }

  // IDataObject ──────────────────────────────────────────────────────────

  HRESULT STDMETHODCALLTYPE GetData(FORMATETC* pformatetcIn, STGMEDIUM* pmedium) override {
    if (pformatetcIn == nullptr || pmedium == nullptr) return E_POINTER;
    if (pformatetcIn->cfFormat != CF_HDROP) return DV_E_FORMATETC;
    if (!(pformatetcIn->tymed & TYMED_HGLOBAL)) return DV_E_TYMED;

    // DROPFILES 구조체 + 모든 wide path 를 NUL 로 구분 + 끝에 추가 NUL.
    // 표준 CF_HDROP 레이아웃.
    size_t totalChars = 0;
    for (const auto& p : paths_) {
      totalChars += p.size() + 1; // NUL terminator per path
    }
    totalChars += 1; // final NUL terminator (double-null at end)

    const size_t headerBytes = sizeof(DROPFILES);
    const size_t pathsBytes = totalChars * sizeof(wchar_t);
    const size_t totalBytes = headerBytes + pathsBytes;

    HGLOBAL hMem = GlobalAlloc(GHND, totalBytes);
    if (hMem == nullptr) return E_OUTOFMEMORY;

    auto* dropFiles = static_cast<DROPFILES*>(GlobalLock(hMem));
    if (dropFiles == nullptr) {
      GlobalFree(hMem);
      return E_OUTOFMEMORY;
    }

    dropFiles->pFiles = static_cast<DWORD>(headerBytes);
    dropFiles->pt.x = 0;
    dropFiles->pt.y = 0;
    dropFiles->fNC = FALSE;
    dropFiles->fWide = TRUE;

    auto* cursor = reinterpret_cast<wchar_t*>(
        reinterpret_cast<BYTE*>(dropFiles) + headerBytes);
    for (const auto& p : paths_) {
      std::memcpy(cursor, p.c_str(), (p.size() + 1) * sizeof(wchar_t));
      cursor += p.size() + 1;
    }
    *cursor = L'\0';

    GlobalUnlock(hMem);

    pmedium->tymed = TYMED_HGLOBAL;
    pmedium->hGlobal = hMem;
    pmedium->pUnkForRelease = nullptr;
    return S_OK;
  }

  HRESULT STDMETHODCALLTYPE GetDataHere(FORMATETC*, STGMEDIUM*) override {
    return E_NOTIMPL;
  }

  HRESULT STDMETHODCALLTYPE QueryGetData(FORMATETC* pformatetc) override {
    if (pformatetc == nullptr) return E_POINTER;
    if (pformatetc->cfFormat == CF_HDROP && (pformatetc->tymed & TYMED_HGLOBAL)) {
      return S_OK;
    }
    return S_FALSE;
  }

  HRESULT STDMETHODCALLTYPE GetCanonicalFormatEtc(
      FORMATETC* /*pformatectIn*/, FORMATETC* pformatetcOut) override {
    if (pformatetcOut == nullptr) return E_POINTER;
    pformatetcOut->ptd = nullptr;
    return E_NOTIMPL;
  }

  HRESULT STDMETHODCALLTYPE SetData(FORMATETC*, STGMEDIUM*, BOOL) override {
    // 우리는 source 만 만든다. 외부에서 우리 dataObject 에 setData 시도
    // (드물지만 일부 destination 이 IDataObject 에 추가 정보 박으려고 시도)
    // 는 거부.
    return E_NOTIMPL;
  }

  HRESULT STDMETHODCALLTYPE EnumFormatEtc(
      DWORD dwDirection, IEnumFORMATETC** ppenumFormatEtc) override {
    if (ppenumFormatEtc == nullptr) return E_POINTER;
    *ppenumFormatEtc = nullptr;
    if (dwDirection != DATADIR_GET) return E_NOTIMPL;

    // Shell 이 만들어주는 표준 enumerator 를 빌려 쓴다 — formatetc 한 개짜리
    // 짧은 배열이므로 직접 구현해도 되지만, SHCreateStdEnumFmtEtc 가 가장
    // 단순하고 메모리 누수 없이 안전.
    FORMATETC fmt;
    fmt.cfFormat = CF_HDROP;
    fmt.ptd = nullptr;
    fmt.dwAspect = DVASPECT_CONTENT;
    fmt.lindex = -1;
    fmt.tymed = TYMED_HGLOBAL;

    return SHCreateStdEnumFmtEtc(1, &fmt, ppenumFormatEtc);
  }

  HRESULT STDMETHODCALLTYPE DAdvise(FORMATETC*, DWORD, IAdviseSink*, DWORD*) override {
    return OLE_E_ADVISENOTSUPPORTED;
  }

  HRESULT STDMETHODCALLTYPE DUnadvise(DWORD) override {
    return OLE_E_ADVISENOTSUPPORTED;
  }

  HRESULT STDMETHODCALLTYPE EnumDAdvise(IEnumSTATDATA**) override {
    return OLE_E_ADVISENOTSUPPORTED;
  }

private:
  std::atomic<LONG> ref_{1};
  std::vector<std::wstring> paths_;
};

// ────────────────────────────────────────────────────────────────────────
//  own-window copy cursor — 듀얼 드래그 잔여 이슈 보정.
// ────────────────────────────────────────────────────────────────────────
//
// 우리 앱은 HTML5 drag(내부 폴더 이동) + OLE drag(외부 export) 를 동시에
// 돌린다. OLE drag 가 *우리 창* 위로 갈 때, Chromium 은 자기 HTML5 drag 중
// 이라 그 창으로의 OLE drop 을 NONE 으로 거부한다. OS 는 NONE → 빨간 금지
// 커서를 그린다(실제 폴더 이동은 HTML5 tracker 가 처리하므로 동작은 정상).
//
// GiveFeedback 에서 커서가 *우리 top-level 창* 위인지 WindowFromPoint 로
// 판정해, 그렇다면 OS 기본(빨간 금지) 대신 copy(+) 커서를 직접 SetCursor 하고
// S_OK 를 반환(=source 가 커서를 책임짐)한다. 외부 창 위에서는 기존대로
// DRAGDROP_S_USEDEFAULTCURSORS 로 OS 가 그리게 둔다.
//
// copy 커서는 ole32.dll 의 표준 OLE drag 커서 리소스에서 로드(비공식 리소스
// 번호라 실패 가능 → IDC_ARROW 폴백; 그래도 빨간 금지는 사라짐).

static HCURSOR GetOwnWindowDragCursor() {
  static HCURSOR cached = nullptr;
  static bool tried = false;
  if (!tried) {
    tried = true;
    // ole32.dll 의 OLE drag-drop 커서 리소스. 통상 3 = copy(+).
    HMODULE ole = GetModuleHandleW(L"ole32.dll");
    if (ole) {
      cached = static_cast<HCURSOR>(LoadImageW(
          ole, MAKEINTRESOURCEW(3), IMAGE_CURSOR, 0, 0,
          LR_DEFAULTSIZE | LR_SHARED));
    }
    if (!cached) {
      // 폴백: 일반 화살표. copy(+) 모양은 아니지만 빨간 금지(ⓧ) 는 제거됨.
      cached = LoadCursorW(nullptr, IDC_ARROW);
    }
  }
  return cached;
}

// ────────────────────────────────────────────────────────────────────────
//  IDropSource
// ────────────────────────────────────────────────────────────────────────
//
// QueryContinueDrag: 마우스 버튼이 떨어지면 DRAGDROP_S_DROP 으로 종료,
// Esc 가 눌리면 DRAGDROP_S_CANCEL 으로 취소.
//
// GiveFeedback: 외부 창 위는 OS 기본 cursor (image-mode 끼어들 여지 없음).
// 우리 창 위는 copy 커서로 덮어 빨간 금지 잔여 이슈 제거.

class DropSource : public IDropSource {
public:
  explicit DropSource(HWND ownRoot) : own_root_(ownRoot) {}

  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
    if (ppv == nullptr) return E_POINTER;
    if (riid == IID_IUnknown || riid == IID_IDropSource) {
      *ppv = static_cast<IDropSource*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }

  ULONG STDMETHODCALLTYPE AddRef() override {
    return static_cast<ULONG>(++ref_);
  }

  ULONG STDMETHODCALLTYPE Release() override {
    LONG c = --ref_;
    if (c == 0) delete this;
    return static_cast<ULONG>(c);
  }

  HRESULT STDMETHODCALLTYPE QueryContinueDrag(BOOL fEscapePressed, DWORD grfKeyState) override {
    if (fEscapePressed) return DRAGDROP_S_CANCEL;
    // 시작 시 눌렸던 버튼이 떨어지면 drop. 일반적으로 LBUTTON.
    // RBUTTON 으로 시작했을 가능성은 거의 없지만 보호.
    const bool leftDown = (grfKeyState & MK_LBUTTON) != 0;
    const bool rightDown = (grfKeyState & MK_RBUTTON) != 0;
    if (!leftDown && !rightDown) return DRAGDROP_S_DROP;
    return S_OK;
  }

  HRESULT STDMETHODCALLTYPE GiveFeedback(DWORD /*dwEffect*/) override {
    // 커서가 우리 top-level 창 위면 copy 커서로 덮고 S_OK (source 가 커서
    // 책임). 그 외엔 OS 기본 cursor.
    if (own_root_ != nullptr) {
      POINT pt;
      if (GetCursorPos(&pt)) {
        HWND under = WindowFromPoint(pt);
        HWND root = under ? GetAncestor(under, GA_ROOT) : nullptr;
        if (root == own_root_) {
          HCURSOR cur = GetOwnWindowDragCursor();
          if (cur != nullptr) {
            SetCursor(cur);
            return S_OK;
          }
        }
      }
    }
    return DRAGDROP_S_USEDEFAULTCURSORS;
  }

private:
  std::atomic<LONG> ref_{1};
  HWND own_root_;
};

// ────────────────────────────────────────────────────────────────────────
//  RunDragSync — OLE drag 를 *호출 스레드(메인 UI thread)* 에서 동기로 돌린다.
// ────────────────────────────────────────────────────────────────────────
//
// v1 의 AsyncWorker(libuv worker thread) 를 제거. 메인 UI thread 는
// BrowserWindow 를 소유하므로 DoDragDrop 내부의 SetCapture 가 성공하고
// 드래그가 정상 종료한다. 호출자(main.ts)가 이 함수 호출 전에 sendSync 응답을
// 먼저 보내므로, 이 함수가 drag 동안 메인 스레드를 블록해도 렌더러 dragstart
// 는 이미 unblock 된 상태다.
//
// 반환: drop/cancel 완료 후의 (hr, effect). out 파라미터로 전달.

struct DragResult {
  HRESULT hr = E_FAIL;
  DWORD effect = DROPEFFECT_NONE;
  bool oleOk = false;
};

static DragResult RunDragSync(const std::vector<std::wstring>& paths, DWORD allowedEffects, HWND ownRoot) {
  DragResult out;

  // STA 로 초기화. 메인 UI thread 는 Chromium 이 이미 OLE 초기화해 둔 상태라
  // 보통 S_FALSE (이미 init) 를 반환한다. S_OK / S_FALSE 모두 OleUninitialize
  // 로 ref count 를 짝맞춘다. RPC_E_CHANGED_MODE(MTA) 면 uninit 하지 않는다.
  HRESULT initHr = OleInitialize(nullptr);
  const bool ownsOle = SUCCEEDED(initHr);
  out.oleOk = ownsOle;

  auto* data = new (std::nothrow) FileDataObject(paths);
  auto* src = new (std::nothrow) DropSource(ownRoot);
  if (data == nullptr || src == nullptr) {
    delete data;
    delete src;
    if (ownsOle) OleUninitialize();
    out.hr = E_OUTOFMEMORY;
    return out;
  }

  DWORD effect = 0;
  HRESULT hr = DoDragDrop(
      static_cast<IDataObject*>(data),
      static_cast<IDropSource*>(src),
      allowedEffects,
      &effect);

  data->Release();
  src->Release();
  if (ownsOle) OleUninitialize();

  out.hr = hr;
  out.effect = effect;
  return out;
}

// ────────────────────────────────────────────────────────────────────────
//  Utilities
// ────────────────────────────────────────────────────────────────────────

static std::wstring Utf8ToWide(const std::string& utf8) {
  if (utf8.empty()) return std::wstring();
  int needed = MultiByteToWideChar(CP_UTF8, 0,
                                   utf8.c_str(), static_cast<int>(utf8.size()),
                                   nullptr, 0);
  if (needed <= 0) return std::wstring();
  std::wstring wide(static_cast<size_t>(needed), L'\0');
  MultiByteToWideChar(CP_UTF8, 0,
                      utf8.c_str(), static_cast<int>(utf8.size()),
                      &wide[0], needed);
  return wide;
}

// ────────────────────────────────────────────────────────────────────────
//  N-API 진입점
// ────────────────────────────────────────────────────────────────────────

static Napi::Value StartDrag(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsArray()) {
    Napi::TypeError::New(env, "startDrag: arg 0 must be string[] of absolute file paths")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Array arr = info[0].As<Napi::Array>();
  const uint32_t len = arr.Length();
  if (len == 0) {
    Napi::TypeError::New(env, "startDrag: file paths array is empty")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  std::vector<std::wstring> paths;
  paths.reserve(len);
  for (uint32_t i = 0; i < len; i++) {
    Napi::Value v = arr.Get(i);
    if (!v.IsString()) {
      Napi::TypeError::New(env, "startDrag: paths array must contain strings only")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    std::string utf8 = v.As<Napi::String>().Utf8Value();
    std::wstring wide = Utf8ToWide(utf8);
    if (wide.empty()) continue;
    paths.push_back(std::move(wide));
  }
  if (paths.empty()) {
    Napi::Error::New(env, "startDrag: no valid paths after UTF-16 conversion")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const DWORD allowed = DROPEFFECT_COPY | DROPEFFECT_LINK;

  // 두 번째 인자: 메인 BrowserWindow 의 native HWND (getNativeWindowHandle()
  // 가 돌려주는 Buffer). own-window cursor 보정에만 사용. 없으면 nullptr →
  // GiveFeedback 이 항상 OS 기본 cursor (기존 동작).
  HWND ownRoot = nullptr;
  if (info.Length() >= 2 && info[1].IsBuffer()) {
    auto buf = info[1].As<Napi::Buffer<uint8_t>>();
    if (buf.Length() >= sizeof(void*)) {
      void* p = nullptr;
      std::memcpy(&p, buf.Data(), sizeof(void*));
      ownRoot = reinterpret_cast<HWND>(p);
    }
  }

  // ── 진단 ──────────────────────────────────────────────────────────────
  // DoDragDrop 은 drag 가 끝날 때까지 이 스레드를 블록한다. 진입/종료 로그를
  // stderr 로 찍어 (1) 메인 스레드에서 도는지(thread id), (2) freeze 인지
  // (종료 로그 부재) 를 즉시 식별한다. fflush 로 버퍼링 없이 즉시 출력.
  const DWORD threadId = GetCurrentThreadId();
  std::fprintf(stderr,
               "[native-drag] StartDrag ENTER thread=%lu paths=%u allowed=0x%lx hwnd=%p\n",
               threadId, static_cast<unsigned>(paths.size()), allowed,
               static_cast<void*>(ownRoot));
  std::fflush(stderr);

  const ULONGLONG t0 = GetTickCount64();
  std::fprintf(stderr, "[native-drag] DoDragDrop BEGIN (blocking)\n");
  std::fflush(stderr);

  DragResult res = RunDragSync(paths, allowed, ownRoot);

  const ULONGLONG elapsed = GetTickCount64() - t0;
  std::fprintf(stderr,
               "[native-drag] DoDragDrop END hr=0x%lx effect=%lu elapsedMs=%llu oleOk=%d\n",
               static_cast<unsigned long>(res.hr), res.effect,
               static_cast<unsigned long long>(elapsed), res.oleOk ? 1 : 0);
  std::fflush(stderr);

  // 동기 결과 객체 반환: { ok, effect, hr, elapsedMs, threadId }
  Napi::Object result = Napi::Object::New(env);
  result.Set("ok", Napi::Boolean::New(env, SUCCEEDED(res.hr)));
  result.Set("effect", Napi::Number::New(env, static_cast<double>(res.effect)));
  result.Set("hr", Napi::Number::New(env, static_cast<double>(static_cast<int32_t>(res.hr))));
  result.Set("elapsedMs", Napi::Number::New(env, static_cast<double>(elapsed)));
  result.Set("threadId", Napi::Number::New(env, static_cast<double>(threadId)));
  return result;
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("startDrag", Napi::Function::New(env, StartDrag));
  // DROPEFFECT 상수도 함께 노출 — JS 콜백 해석에 편의.
  exports.Set("DROPEFFECT_NONE", Napi::Number::New(env, DROPEFFECT_NONE));
  exports.Set("DROPEFFECT_COPY", Napi::Number::New(env, DROPEFFECT_COPY));
  exports.Set("DROPEFFECT_MOVE", Napi::Number::New(env, DROPEFFECT_MOVE));
  exports.Set("DROPEFFECT_LINK", Napi::Number::New(env, DROPEFFECT_LINK));
  return exports;
}

NODE_API_MODULE(preflow_drag_out, Init)

#endif // _WIN32
