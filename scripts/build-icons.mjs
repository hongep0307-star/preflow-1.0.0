// build/ 안의 PNG 아이콘들을 Windows 용 .ico + macOS dock 용 라운딩 PNG 로 변환.
//
// 입력 (사용자가 직접 저장):
//   build/icon.png           — 메인 프로그램 아이콘 (1024×1024 권장)
//   build/preflowproj.png    — .preflowproj File Association 아이콘
//   build/preflowlib.png     — .preflowlib File Association 아이콘
//
// 출력 (변환 산출물 — gitignore 가능):
//   build/icon.ico, build/preflowproj.ico, build/preflowlib.ico
//   build/icon.mac.png       — macOS dock 용 라운딩(squircle 근사)+여백 아이콘
//
// 라운딩 정책 (왜 빌드 타임에 마스크를 씌우나):
//   소스 아트는 꽉 찬 정사각이라 OS dock/작업표시줄에서 다른 앱들의 둥근
//   아이콘과 대조돼 "각지고 더 커" 보인다. 특히 macOS 는 모든 앱이 동일한
//   squircle 그리드(1024 캔버스 안 824 본체 + 여백)를 따르는데, 꽉 찬 정사각
//   PNG 는 그 여백을 안 가져 dock 에서 유독 크게 튄다. 그래서:
//     · Windows/공통 .ico : 풀블리드 둥근 모서리 (OS 가 추가 라운딩을 안 하므로
//       투명 모서리를 우리가 직접 만든다)
//     · macOS icon.mac.png : Big Sur 그리드(본체 ~80.5% + 둥근 모서리)로 합성해
//       dock 크기/모양이 표준 앱과 맞게.
//   알파 마스크는 1px 안티에일리어싱(서명 거리 기반 coverage)으로 부드럽게.
//
// 리샘플링 전략:
//   png-to-ico 기본 동작은 *입력 PNG → 256 → 16/32/48* 의 **2단계 리사이즈**
//   라 작은 사이즈가 흐릿해진다. 또 24/64/128 처럼 Windows 가 작업표시줄·
//   Alt+Tab 에서 자주 쓰는 사이즈가 빠져 OS 가 또 한 번 downsample 한다.
//   여기서는 png-to-ico 내부의 readPNG / resize / imagesToIco 를 직접 호출해
//   1024 원본(마스크 적용 후) → 각 target 사이즈로 **한 번만** bicubic
//   리사이즈한 PNG 7장을 ICO 에 묶는다. 결과적으로 작업표시줄(24) 도 1단계
//   손실로 끝. mask 가 먼저 적용된 뒤 다운스케일되므로 모서리 AA 도 보존된다.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { imagesToIco } from "png-to-ico";
import { readPNG, resize } from "png-to-ico/lib/png.js";
// png-to-ico 가 돌려주는 PNG 인스턴스에는 `.sync` 가 붙어있지 않으므로(내부
// 복사본), 새 PNG 인코딩은 직접 import 한 pngjs 의 PNG.sync.write 로 한다.
// png-to-ico 가 pngjs 에 의존하긴 하지만 hoisting 보장을 위해 package.json
// devDependencies 에도 pngjs 를 명시했다.
import { PNG } from "pngjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BUILD_DIR = path.resolve(__dirname, "..", "build");

// 이 생성 스크립트 자신의 mtime. 라운딩/마스크 로직이 바뀌면 소스 PNG mtime
// 은 그대로여도 출력이 stale 해진다 — 스크립트가 출력보다 최신이면 재생성해
// 캐시가 옛 결과(예: 라운딩 없던 .ico)에 고착되는 걸 막는다.
const SCRIPT_MTIME = fs.statSync(__filename).mtimeMs;

// src: 입력 PNG / ico: Windows .ico 출력 / mac: (있으면) macOS dock PNG 출력.
const TARGETS = [
  { src: "icon.png", ico: "icon.ico", mac: "icon.mac.png" },
  { src: "preflowproj.png", ico: "preflowproj.ico" },
  { src: "preflowlib.png", ico: "preflowlib.ico" },
];

// Windows 가 컨텍스트별로 자주 요청하는 모든 사이즈를 ICO 에 동봉.
// 16/24/32 = 작업표시줄·트레이, 48 = 탐색기 중간 아이콘,
// 64/128 = 큰 아이콘 보기, 256 = Vista+ 점보 / file properties 미리보기.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

// ── 라운딩 파라미터 ──────────────────────────────────────────────────
// 풀블리드(.ico)용 모서리 반경 = 변 길이 × 비율. 0.18 ≈ 적당히 둥글되 너무
// macOS 처럼은 아닌 정도. 값을 키우면 더 둥글어진다.
const WIN_CORNER_RATIO = 0.18;
// macOS Big Sur 아이콘 그리드: 1024 캔버스 안 본체 824(≈80.47%), 본체 변
// 길이 대비 모서리 반경 ≈ 22.37%(Apple continuous-corner 근사 — 정확한
// squircle 은 superellipse 지만 둥근 사각형으로 충분히 근접).
const MAC_BODY_RATIO = 0.8047;
const MAC_RADIUS_RATIO = 0.2237;

function needsBuild(srcPath, outPath) {
  if (!fs.existsSync(outPath)) return true;
  const srcMtime = fs.statSync(srcPath).mtimeMs;
  const outMtime = fs.statSync(outPath).mtimeMs;
  // 소스가 더 최신이거나, 생성 스크립트(로직)가 출력보다 최신이면 재생성.
  return Math.max(srcMtime, SCRIPT_MTIME) > outMtime;
}

// 둥근 사각형 내부 coverage(0~1). 서명 거리(signed distance) 기반이라 경계
// 1px 구간에서 매끄러운 안티에일리어싱이 나온다. (px,py)=픽셀 중심,
// (cx,cy)=중심, (hx,hy)=반(half) 폭/높이, r=모서리 반경.
function roundRectCoverage(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - (hx - r);
  const qy = Math.abs(py - cy) - (hy - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  const sd = Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r; // <0 = 내부
  return Math.max(0, Math.min(1, 0.5 - sd));
}

// png 의 알파 채널에 둥근 사각형 마스크를 곱한다(in place). 중심/반폭/반경은
// 픽셀 단위. 본체 영역 바깥은 coverage 0 → 완전 투명.
function applyRoundRectMask(png, cx, cy, hx, hy, r) {
  const { width: w, height: h, data } = png;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const cov = roundRectCoverage(x + 0.5, y + 0.5, cx, cy, hx, hy, r);
      const ai = (y * w + x) * 4 + 3;
      if (cov >= 1) continue;
      data[ai] = Math.round(data[ai] * cov);
    }
  }
}

// macOS dock 용 합성: 투명 캔버스 안에 본체를 축소 배치(여백 확보)하고
// 둥근 모서리 마스크를 씌운다. src 는 *원본 픽셀* 이어야 한다(풀블리드
// 마스크를 적용하기 *전*에 호출).
function composeMacIcon(src) {
  const canvasSize = src.width;
  const bodySize = Math.round(canvasSize * MAC_BODY_RATIO);
  const radius = bodySize * MAC_RADIUS_RATIO;
  const offset = Math.round((canvasSize - bodySize) / 2);

  const body = src.width === bodySize ? src : resize(src, bodySize, bodySize);

  // 투명 캔버스(top-level pngjs 인스턴스 — PNG.sync.write 로 인코딩 가능).
  const canvas = new PNG({ width: canvasSize, height: canvasSize });
  canvas.data.fill(0);

  for (let y = 0; y < bodySize; y += 1) {
    for (let x = 0; x < bodySize; x += 1) {
      const s = (y * bodySize + x) * 4;
      const d = ((y + offset) * canvasSize + (x + offset)) * 4;
      canvas.data[d] = body.data[s];
      canvas.data[d + 1] = body.data[s + 1];
      canvas.data[d + 2] = body.data[s + 2];
      canvas.data[d + 3] = body.data[s + 3];
    }
  }

  applyRoundRectMask(
    canvas,
    canvasSize / 2,
    canvasSize / 2,
    bodySize / 2,
    bodySize / 2,
    radius,
  );
  return canvas;
}

async function buildIco(src, outPath) {
  // 한 번에 target 으로 직접 리사이즈 — 2단계 손실 제거.
  // 원본이 target 사이즈와 정확히 같다면 그대로 사용.
  const images = ICO_SIZES.map((size) =>
    src.width === size ? src : resize(src, size, size /* default: bicubicInterpolation */),
  );
  const buf = imagesToIco(images);
  fs.writeFileSync(outPath, buf);
  return buf.length;
}

async function main() {
  if (!fs.existsSync(BUILD_DIR)) {
    console.log(`[build-icons] no build/ directory yet — skip.`);
    return;
  }
  let converted = 0;
  let skipped = 0;
  for (const { src, ico, mac } of TARGETS) {
    const srcPath = path.join(BUILD_DIR, src);
    const icoPath = path.join(BUILD_DIR, ico);
    const macPath = mac ? path.join(BUILD_DIR, mac) : null;
    if (!fs.existsSync(srcPath)) {
      console.log(`[build-icons] ${src} not found — skip.`);
      continue;
    }

    const icoStale = needsBuild(srcPath, icoPath);
    const macStale = macPath ? needsBuild(srcPath, macPath) : false;
    if (!icoStale && !macStale) {
      skipped += 1;
      continue;
    }

    try {
      const source = await readPNG(srcPath);
      if (source.width !== source.height) {
        throw new Error(`${src} must be a square PNG (got ${source.width}x${source.height}).`);
      }

      // macOS dock 아이콘은 *원본 픽셀* 로 먼저 합성(여백 + squircle). 아래
      // 풀블리드 마스크가 source 의 알파를 깎기 전에 수행해야 본체가 안 잘린다.
      if (macPath && macStale) {
        const macIcon = composeMacIcon(source);
        const macBuf = PNG.sync.write(macIcon);
        fs.writeFileSync(macPath, macBuf);
        console.log(`[build-icons] ${src} -> ${mac} (${(macBuf.length / 1024).toFixed(1)} KB, mac dock squircle)`);
        converted += 1;
      }

      if (icoStale) {
        // 풀블리드 둥근 모서리 마스크를 원본 해상도에서 1회 적용 후 다운스케일.
        const r = source.width * WIN_CORNER_RATIO;
        applyRoundRectMask(source, source.width / 2, source.height / 2, source.width / 2, source.height / 2, r);
        const bytes = await buildIco(source, icoPath);
        console.log(`[build-icons] ${src} -> ${ico} (${(bytes / 1024).toFixed(1)} KB, ${ICO_SIZES.length} sizes, rounded)`);
        converted += 1;
      }
    } catch (err) {
      console.error(`[build-icons] failed to convert ${src}:`, err);
      process.exitCode = 1;
    }
  }
  console.log(`[build-icons] done — converted: ${converted}, cached: ${skipped}.`);
}

main();
