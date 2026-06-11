// preflow_drag_out (macOS) — NSDraggingSession 기반 drag-source 네이티브 애드온.
//
// 왜 만들었나
// -----------
// macOS 에서는 그동안 `index.js` 가 null 을 반환해서 IPC 핸들러가 Electron 의
// `webContents.startDrag` 폴백으로만 빠졌다(electron/main.ts). 그 폴백이 만드는
// NSDraggingSession 의 `draggingSession:endedAtPoint:operation:` 종료 콜백이
// 안정적으로 발동하지 않는 케이스가 있어, drop/cancel 후에도 AppKit 의 mouse
// capture 가 풀리지 않고 OS 전역이 묶이는 hang 이 발생했다.
//
// 이 모듈은 드래그 세션을 *우리가 직접 소유* 하고, 종료 델리게이트에서
// delegate 를 강한 참조 컨테이너에서 제거(=명시적 cleanup)한다. 그래서 세션이
// 끝나면 자원이 즉시 정리되고 mouse capture stuck 이 사라진다. Windows 의
// OLE `DoDragDrop` addon(addon.cc) 과 *동일한 호출 계약/반환 형태* 를 유지해
// main.ts 의 네이티브 디스패치 경로를 그대로 재사용한다.
//
// 호출 계약 (main.ts 와 동일)
// ---------------------------
//   const drag = require("preflow-drag-out");
//   const res = drag.startDrag(filePaths: string[], handle?: Buffer);
//   // res = { ok, effect, hr, elapsedMs, threadId }
//
// - filePaths: 절대 경로 배열. 호출자(메인 프로세스) 가 sandbox 검증을 마친
//   storage 안의 파일이거나 임시 `.url` 바로가기. 디스크에 이미 존재하므로
//   NSFilePromiseProvider 가 아니라 NSURL fileURL 로 곧장 드래그한다.
// - handle: BrowserWindow.getNativeWindowHandle() — macOS 에서는 content
//   NSView* 포인터. 이 view 에서 드래그 세션을 시작한다.
//
// ⚠️ Windows 와의 결정적 차이: macOS `beginDraggingSessionWithItems:event:source:`
//    는 *비동기* 다 — 즉시 반환하고 드래그는 메인 run loop 가 구동한다. 그래서
//    이 함수는 Windows 의 DoDragDrop 처럼 drop/cancel 까지 블록하지 *않는다*.
//    반환값은 "세션이 시작됐는가(ok)" 이고, 실제 종료(operation)는 델리게이트의
//    stderr 로그로 관찰한다. 호출자는 어차피 이 함수 전에 sendSync 응답
//    (event.returnValue) 을 먼저 보내므로 계약상 문제 없다.

#ifdef __APPLE__

#import <Cocoa/Cocoa.h>

#include <napi.h>

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

// 진행 중인 transient drag-source delegate 들을 살려두는 강한 참조 컨테이너.
// ARC 환경에서 delegate 를 지역 변수로만 두면 begin 호출 직후 dealloc 되어
// 세션 도중 콜백을 못 받는다. 시작 시 add, endedAtPoint 에서 remove → 해제.
static NSMutableArray *gPreflowActiveDragSources = nil;

// ────────────────────────────────────────────────────────────────────────
//  NSDraggingSource delegate
// ────────────────────────────────────────────────────────────────────────

@interface PreflowDragSource : NSObject <NSDraggingSource>
@end

@implementation PreflowDragSource

- (NSDragOperation)draggingSession:(NSDraggingSession *)session
    sourceOperationMaskForDraggingContext:(NSDraggingContext)context {
  // copy/link 모두 허용 — Finder/Slack/Photoshop 등 외부 destination 이 파일
  // 사본을 받게 한다. (Windows 의 DROPEFFECT_COPY | DROPEFFECT_LINK 와 동치)
  return NSDragOperationCopy | NSDragOperationLink;
}

- (void)draggingSession:(NSDraggingSession *)session
           endedAtPoint:(NSPoint)screenPoint
              operation:(NSDragOperation)operation {
  // ★ hang fix 의 핵심 지점.
  //   Electron 폴백이 누락하던 "세션 종료 후 명시적 cleanup" 을 여기서 한다.
  //   delegate 를 강한 참조 컨테이너에서 제거하면 ARC 가 즉시 해제하고,
  //   세션이 잡고 있던 자원/마우스 capture 도 정상적으로 풀린다.
  std::fprintf(stderr,
               "[native-drag-mac] session ENDED operation=%lu at=(%.1f,%.1f)\n",
               static_cast<unsigned long>(operation),
               static_cast<double>(screenPoint.x),
               static_cast<double>(screenPoint.y));
  std::fflush(stderr);
  if (gPreflowActiveDragSources != nil) {
    [gPreflowActiveDragSources removeObject:self];
  }
}

@end

// ────────────────────────────────────────────────────────────────────────
//  helpers
// ────────────────────────────────────────────────────────────────────────

// beginDraggingSession 은 마우스 NSEvent 를 요구한다. dragstart(sendSync) 가
// 메인을 블록한 시점에 [NSApp currentEvent] 가 mouse 계열이면 그대로 쓰고,
// 아니면 현재 커서 위치로 left-mouse-dragged 이벤트를 합성한다.
static NSEvent *PreflowResolveDragEvent(NSView *view) {
  NSWindow *window = view.window;
  NSEvent *current = NSApp.currentEvent;
  if (current != nil) {
    NSEventType t = current.type;
    if (t == NSEventTypeLeftMouseDragged || t == NSEventTypeLeftMouseDown ||
        t == NSEventTypeRightMouseDragged || t == NSEventTypeOtherMouseDragged) {
      return current;
    }
  }
  NSPoint inWindow =
      window ? [window mouseLocationOutsideOfEventStream] : NSZeroPoint;
  NSInteger windowNumber = window ? window.windowNumber : 0;
  return [NSEvent mouseEventWithType:NSEventTypeLeftMouseDragged
                            location:inWindow
                       modifierFlags:0
                           timestamp:[NSProcessInfo processInfo].systemUptime
                        windowNumber:windowNumber
                             context:nil
                         eventNumber:0
                          clickCount:1
                            pressure:1.0];
}

// ────────────────────────────────────────────────────────────────────────
//  N-API 진입점
// ────────────────────────────────────────────────────────────────────────

static Napi::Value StartDrag(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsArray()) {
    Napi::TypeError::New(
        env, "startDrag: arg 0 must be string[] of absolute file paths")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Array arr = info[0].As<Napi::Array>();
  const uint32_t len = arr.Length();
  std::vector<std::string> paths;
  paths.reserve(len);
  for (uint32_t i = 0; i < len; i++) {
    Napi::Value v = arr.Get(i);
    if (v.IsString()) paths.push_back(v.As<Napi::String>().Utf8Value());
  }
  if (paths.empty()) {
    Napi::Error::New(env, "startDrag: file paths array is empty")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // arg 1: content NSView* 포인터 (BrowserWindow.getNativeWindowHandle()).
  void *viewPtr = nullptr;
  if (info.Length() >= 2 && info[1].IsBuffer()) {
    auto buf = info[1].As<Napi::Buffer<uint8_t>>();
    if (buf.Length() >= sizeof(void *)) {
      std::memcpy(&viewPtr, buf.Data(), sizeof(void *));
    }
  }

  __block bool started = false;

  // AppKit 호출은 반드시 메인 스레드에서. Electron 메인 프로세스의 N-API 호출은
  // 이미 메인(AppKit) 스레드이므로 보통 즉시 실행된다.
  void (^begin)(void) = ^{
    @autoreleasepool {
      NSView *view = (__bridge NSView *)viewPtr;
      if (view == nil) {
        std::fprintf(stderr, "[native-drag-mac] no NSView handle — abort\n");
        std::fflush(stderr);
        return;
      }

      NSEvent *event = PreflowResolveDragEvent(view);
      NSPoint inWindow = event.locationInWindow;
      NSPoint inView = [view convertPoint:inWindow fromView:nil];

      NSMutableArray<NSDraggingItem *> *items = [NSMutableArray array];
      NSWorkspace *ws = [NSWorkspace sharedWorkspace];
      CGFloat stagger = 0;
      for (const auto &p : paths) {
        if (p.empty()) continue;
        NSString *nsPath = [NSString stringWithUTF8String:p.c_str()];
        if (nsPath.length == 0) continue;
        NSURL *url = [NSURL fileURLWithPath:nsPath];
        NSDraggingItem *item =
            [[NSDraggingItem alloc] initWithPasteboardWriter:url];
        NSImage *icon = [ws iconForFile:nsPath];
        NSRect frame = NSMakeRect(inView.x - 16 + stagger, inView.y - 16 - stagger,
                                  32, 32);
        [item setDraggingFrame:frame contents:icon];
        [items addObject:item];
        stagger += 4;  // 다중 파일은 살짝 어긋나게 쌓아 보이게.
      }
      if (items.count == 0) {
        std::fprintf(stderr,
                     "[native-drag-mac] no valid dragging items — abort\n");
        std::fflush(stderr);
        return;
      }

      if (gPreflowActiveDragSources == nil) {
        gPreflowActiveDragSources = [NSMutableArray array];
      }
      PreflowDragSource *src = [[PreflowDragSource alloc] init];
      [gPreflowActiveDragSources addObject:src];  // endedAtPoint 까지 alive 유지

      std::fprintf(
          stderr,
          "[native-drag-mac] beginDraggingSession items=%lu eventType=%lu\n",
          static_cast<unsigned long>(items.count),
          static_cast<unsigned long>(event.type));
      std::fflush(stderr);

      [view beginDraggingSessionWithItems:items event:event source:src];
      started = true;
    }
  };

  if ([NSThread isMainThread]) {
    begin();
  } else {
    dispatch_sync(dispatch_get_main_queue(), begin);
  }

  // 비동기 세션 — 즉시 반환. Windows 와 같은 필드를 채워 main.ts 디스패치/로그가
  // 수정 없이 동작하게 한다. 실제 operation 은 endedAtPoint 콜백 로그로 관찰.
  Napi::Object result = Napi::Object::New(env);
  result.Set("ok", Napi::Boolean::New(env, started));
  result.Set("effect", Napi::Number::New(env, 0));
  result.Set("hr", Napi::Number::New(env, 0));
  result.Set("elapsedMs", Napi::Number::New(env, 0));
  result.Set("threadId", Napi::Number::New(env, 0));
  return result;
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("startDrag", Napi::Function::New(env, StartDrag));
  // Windows addon 과 동일한 DROPEFFECT 상수 표면 — NativeDragAddon 타입/로그
  // 호환용. 값도 Win32 DROPEFFECT 와 동일하게 둔다.
  exports.Set("DROPEFFECT_NONE", Napi::Number::New(env, 0));
  exports.Set("DROPEFFECT_COPY", Napi::Number::New(env, 1));
  exports.Set("DROPEFFECT_MOVE", Napi::Number::New(env, 2));
  exports.Set("DROPEFFECT_LINK", Napi::Number::New(env, 4));
  return exports;
}

NODE_API_MODULE(preflow_drag_out, Init)

#endif  // __APPLE__
