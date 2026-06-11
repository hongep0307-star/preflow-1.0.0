// preflow-drag-out 네이티브 애드온 빌드 스크립트.
//
// node-gyp 를 직접 호출해서 `native/drag-out` 를 *현재 Electron 헤더에 맞춰*
// 컴파일한다. better-sqlite3 가 이미 `@electron/rebuild` 로 같은 일을 하지만,
// 그쪽은 `node_modules` 안의 모듈만 스캔하므로 우리 in-repo 애드온은 자체 빌드.
//
// 환경변수 의미:
//   npm_config_target          → Electron 버전 (헤더 다운로드 키)
//   npm_config_runtime=electron → Electron headers URL 사용
//   npm_config_disturl         → headers 호스트
//   npm_config_arch / target_arch → 빌드 architecture (win: x64 / mac: arm64|x64)
//   npm_config_build_from_source → cached prebuilt 무시
//
// 출력: native/drag-out/build/Release/preflow_drag_out.node
//
// 빌드 캐시 (default):
//   `.node` 결과물이 이미 존재하고 source(binding.gyp / src/*.cc / package.json)
//   보다 새것이면 자동 skip. dev 워크플로에서 매 부팅마다 node-gyp 가 도는
//   비용 + Python/MSVC 의존성을 회피한다. source 가 변경되면 mtime 검사로
//   자동 감지되어 재빌드.
//
// 사용:
//   node scripts/build-native.mjs              # 일반 빌드 (캐시 활성)
//   node scripts/build-native.mjs --force      # 캐시 무시하고 강제 빌드
//   node scripts/build-native.mjs --rebuild    # 깨끗하게 재빌드 (build/ 삭제 후)
//   node scripts/build-native.mjs --clean      # build/ 만 삭제하고 종료

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const MODULE_DIR = path.join(ROOT, "native", "drag-out");
const BUILD_DIR = path.join(MODULE_DIR, "build");
const ADDON_OUT = path.join(BUILD_DIR, "Release", "preflow_drag_out.node");

const args = new Set(process.argv.slice(2));
const wantsClean = args.has("--clean") || args.has("--rebuild");
const cleanOnly = args.has("--clean");
const wantsForce =
  args.has("--force") ||
  args.has("--rebuild") ||
  process.env.PREFLOW_FORCE_NATIVE_BUILD === "1";

if (wantsClean && existsSync(BUILD_DIR)) {
  console.log("[build-native] cleaning", BUILD_DIR);
  rmSync(BUILD_DIR, { recursive: true, force: true });
}
if (cleanOnly) process.exit(0);

// 애드온은 Windows(OLE) + macOS(NSDraggingSession) 만 지원. 그 외 OS(Linux 등)
// 에서는 단순 skip — postinstall 이 다른 플랫폼에서 실패하면 안 되므로.
if (process.platform !== "win32" && process.platform !== "darwin") {
  console.log(
    "[build-native] unsupported platform — skipping (addon is Windows/macOS-only).",
  );
  process.exit(0);
}

// 빌드 캐시 검사 — `.node` 결과물이 이미 존재하고 source 가 더 새것이 아니면
// 통째로 skip. `--force` / `--rebuild` 또는 env 로 우회 가능.
function newestMtime(paths) {
  let newest = 0;
  for (const p of paths) {
    try {
      const st = statSync(p);
      if (st.isDirectory()) {
        for (const child of readdirSync(p, { withFileTypes: true })) {
          if (child.isFile()) {
            const cm = statSync(path.join(p, child.name)).mtimeMs;
            if (cm > newest) newest = cm;
          }
        }
      } else if (st.mtimeMs > newest) {
        newest = st.mtimeMs;
      }
    } catch {
      /* 누락 파일은 무시 — 캐시 판정에 영향 없음 */
    }
  }
  return newest;
}

if (!wantsForce && existsSync(ADDON_OUT)) {
  const outMtime = statSync(ADDON_OUT).mtimeMs;
  const srcMtime = newestMtime([
    path.join(MODULE_DIR, "binding.gyp"),
    path.join(MODULE_DIR, "package.json"),
    path.join(MODULE_DIR, "src"),
  ]);
  if (srcMtime > 0 && srcMtime <= outMtime) {
    console.log(
      `[build-native] up-to-date — skipping (cached at ${ADDON_OUT}). Use --force to rebuild.`,
    );
    process.exit(0);
  }
  console.log(
    `[build-native] source newer than cached addon (src=${new Date(srcMtime).toISOString()}, out=${new Date(outMtime).toISOString()}) — rebuilding.`,
  );
}

// Electron 헤더 매칭 — devDependencies 의 `electron` 에서 version 추출.
let electronVersion;
try {
  electronVersion = require("electron/package.json").version;
} catch (err) {
  console.error("[build-native] Cannot resolve electron package — is it installed?", err);
  process.exit(1);
}

// arch 격리: Windows 는 기존 동작을 그대로 유지(x64 기본, ia32 예외) 해
// 메인 개발 환경에 어떤 영향도 주지 않는다. macOS 만 process.arch 를 그대로
// 따라가 Apple Silicon(arm64) / Intel(x64) 을 각각 네이티브로 빌드한다.
const arch =
  process.platform === "darwin"
    ? process.arch // arm64 | x64 (Apple Silicon / Intel)
    : process.arch === "ia32"
      ? "ia32"
      : "x64";

const env = {
  ...process.env,
  npm_config_target: electronVersion,
  npm_config_runtime: "electron",
  npm_config_disturl: "https://electronjs.org/headers",
  npm_config_arch: arch,
  npm_config_target_arch: arch,
  npm_config_build_from_source: "true",
};

function runGyp(cmd) {
  console.log(`[build-native] node-gyp ${cmd} (electron=${electronVersion}, arch=${arch})`);
  const result = spawnSync(
    process.execPath,
    [require.resolve("node-gyp/bin/node-gyp.js"), cmd],
    {
      cwd: MODULE_DIR,
      stdio: "inherit",
      env,
    },
  );
  if (result.status !== 0) {
    console.error(`[build-native] node-gyp ${cmd} failed (exit=${result.status})`);
    process.exit(result.status ?? 1);
  }
}

runGyp("configure");
runGyp("build");

console.log("[build-native] OK — preflow-drag-out compiled at",
  path.join(MODULE_DIR, "build", "Release", "preflow_drag_out.node"));
