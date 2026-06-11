import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

/* HTML Viewer Export 전용 Vite 빌드 구성.
 *
 * 왜 메인 vite.config.ts 와 분리하는가?
 *   메인 멀티 entry 빌드는 React / lucide / 공용 유틸을 두 entry 간
 *   공유 청크로 쪼개 dist/assets/chunk-*.js 로 분리한다. 이건 일반 SPA
 *   에는 최적이지만, 우리 viewer 는 *외부 공유용 단일 HTML* 로 패키징
 *   되어야 해 chunk 가 쪼개지면 인라인 시 import 가 모두 깨진다 (검은
 *   화면 원인).
 *
 *   이 config 는 viewer 만 입력으로 잡고 `inlineDynamicImports: true`
 *   로 모든 viewer 의존성 (React 포함) 을 단일 entry 청크에 합쳐 출력
 *   한다. 메인 빌드는 그대로 두고, 이 빌드는 dist 에 `emptyOutDir:
 *   false` 로 *추가* 만 한다 — 메인 산출물(`index.html` 등) 을 건드리지
 *   않는다.
 *
 *   결과: dist/viewer.html + dist/assets/viewer-bundle-*.js (단일) +
 *   dist/assets/viewer-asset-*.css (단일). electron/htmlExport.ts 의
 *   loadViewerBundle 정규식이 그대로 잡아 한 번에 인라인. */
export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@shared": path.resolve(__dirname, "./shared"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    /* Vite/Rollup 의 "single bundle" 모드. dynamic import 까지 모두 entry
     *  청크 안으로 인라인해 chunk-*.js 파일을 만들지 않는다. 외부 공유용
     *  단일 viewer 번들에 필수. (구버전의 inlineDynamicImports 와 동등.) */
    rollupOptions: {
      input: path.resolve(__dirname, "viewer.html"),
      output: {
        entryFileNames: "assets/viewer-bundle-[hash].js",
        chunkFileNames: "assets/viewer-bundle-[hash].js",
        assetFileNames: "assets/viewer-asset-[hash][extname]",
      },
    },
    // @ts-expect-error -- Rolldown 옵션 (Vite 8 + rolldown). 타입 정의에는
    // 아직 노출되지 않았지만 런타임에서는 정상 인식되어 inlineDynamicImports
    // deprecation 경고 없이 단일 청크 강제.
    codeSplitting: false,
  },
});
