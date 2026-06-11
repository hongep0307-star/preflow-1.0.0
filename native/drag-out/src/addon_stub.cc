// Non-Windows stub. `binding.gyp` 가 OS!='win' 일 때 본 파일을 사용해서
// 비어 있는 N-API 모듈만 만들어둔다. Windows 전용 OLE API 호출이 들어 있는
// `addon.cc` 는 mac/linux 빌드에서 사실상 미사용. `index.js` 가 win32 외
// platform 에서 null 을 반환하므로 본 stub 은 실제로는 require 되지 않지만,
// node-gyp 가 항상 컴파일 대상 소스 1개 이상을 요구하므로 자리만 채운다.

#include <napi.h>

static Napi::Object Init(Napi::Env env, Napi::Object exports) { return exports; }

NODE_API_MODULE(preflow_drag_out, Init)
