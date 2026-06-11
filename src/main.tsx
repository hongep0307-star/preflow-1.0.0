import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { ensureWorkspacesLoaded } from "./lib/workspaceClient";

// 워크스페이스 캐시 fetch 시작 — 첫 페인트는 default 라벨로 그려져도
// 무방하지만 React 트리 마운트 직후 진짜 이름으로 swap 되어야 사용자가
// 깜빡임을 거의 느끼지 못한다. await 하지 않음 — 네트워크 지연이
// 첫 렌더를 잡지 못하게.
void ensureWorkspacesLoaded();

/* 플랫폼 클래스 1 회 부여 — index.css 의 `.platform-win .app-topbar`,
   `.platform-mac .app-topbar` 같은 OS 컨트롤/트래픽 라이트 회피용 셀렉터를
   활성화한다. 클래스가 없으면 위 규칙들이 죽은 코드처럼 무시되어 우상단
   ─ □ × 영역과 컨텐츠가 겹친다. ContiStudio 등 fixed inset-0 풀스크린
   오버레이에서도 같은 클래스를 이용한 padding-right 138px 가 적용된다. */
const ua = navigator.userAgent;
const platformClass = /Mac|iPhone|iPad|iPod/i.test(ua)
  ? "platform-mac"
  : /Windows/i.test(ua)
  ? "platform-win"
  : "platform-linux";
document.documentElement.classList.add(platformClass);

createRoot(document.getElementById("root")!).render(<App />);
