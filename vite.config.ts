import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  // Electron 프로덕션 빌드는 file:// 프로토콜로 index.html 을 로드한다.
  // base 가 비어있으면 Vite 가 절대경로(/assets/main.js)로 박아 file 시스템 루트를 가리키게 되어
  // 모든 JS/CSS 가 404 → 화면이 검게 뜨는 사고가 발생한다. 상대경로로 강제.
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@shared": path.resolve(__dirname, "./shared"),
    },
  },
  server: {
    host: "::",
    port: 8080,
    hmr: { overlay: false },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        // 메인 앱 entry. viewer 는 별도 빌드(vite.viewer.config.ts)로 분리
        // 했다 — 같은 vite build 에 두면 코드 스플리팅이 viewer 를 여러
        // chunk 로 쪼개 외부 공유 시 검은 화면이 나는 문제 때문.
        main: path.resolve(__dirname, "index.html"),
      },
    },
  },
});
