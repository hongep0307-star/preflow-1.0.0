import { createRoot } from "react-dom/client";
import "../index.css";
import { ViewerApp } from "./App";
import type { ViewerData } from "./types";

/* 플랫폼 클래스 — Pretendard 로딩과 일부 폼 컨트롤 스타일이 OS 별로
 * 약간 다른 케이스를 메인 앱과 동일하게 처리하기 위해 동일 패턴 사용.
 * 메인 앱과 달리 wsl/iOS 같은 케이스는 가능성이 거의 없어 단순화. */
const ua = navigator.userAgent;
const platformClass = /Mac/i.test(ua)
  ? "platform-mac"
  : /Windows/i.test(ua)
    ? "platform-win"
    : "platform-linux";
document.documentElement.classList.add(platformClass);

/* viewer.html 의 inline <script> 가 placeholder 를 항상 박아두므로
 * 정상 경로에서는 항상 객체. export 시점에 빌더가 덮어쓴 실제 데이터를
 * 그대로 받는다. 형식이 어긋난 경우(외부에서 손댄 HTML 등) 대비로
 * 안전한 기본값을 1회 보강. */
const fallback: ViewerData = {
  title: "Pre-Flow Viewer",
  generated_at: "",
  item_count: 0,
  items: [],
};
const raw = window.__PREFLOW_VIEWER_DATA__ ?? fallback;
const data: ViewerData = {
  title: typeof raw.title === "string" && raw.title.length > 0 ? raw.title : fallback.title,
  generated_at: typeof raw.generated_at === "string" ? raw.generated_at : "",
  item_count: typeof raw.item_count === "number" ? raw.item_count : (raw.items?.length ?? 0),
  items: Array.isArray(raw.items) ? raw.items : [],
};

const root = document.getElementById("viewer-root");
if (root) {
  createRoot(root).render(<ViewerApp data={data} />);
}
