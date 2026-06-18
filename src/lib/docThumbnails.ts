/**
 * doc 카테고리 자료의 *진짜* 썸네일 생성기.
 *
 * generic 카드(아이콘 + 확장자 배지) 만으론 시각적으로 구분이 어려운 두
 * 자료군을 직접 픽셀로 그려서 일반 이미지 썸네일 흐름에 합류시킨다:
 *
 * 1) PDF — pdfjs 로 1페이지를 256-px 캔버스에 렌더 → PNG Blob
 * 2) Font(TTF/OTF/WOFF/WOFF2) — `FontFace` 동적 로드 → "Aa Gg 가나" 단문을
 *    캔버스에 그려 PNG Blob
 *
 * 두 함수 모두 *실패 시 null* 을 반환 — 호출부(uploadReferenceFile) 가
 * 자연스럽게 generic 카드(thumbnail_url=null) 로 폴백한다. 어떤 의존성도
 * 강제하지 않고 오로지 *베스트 에포트* 로 동작한다.
 *
 * 출력 형식: PNG Blob — Supabase Storage 업로드는 호출부가 진행. 동영상
 * 썸네일(`extractFirstFrame` → `poster.png`) 와 동일한 컨트랙트.
 */
import JSZip from "jszip";
import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/* GlobalWorkerOptions 는 모듈 1회 설정. BriefTab 에서 이미 한 번 설정하지만
   이쪽 helper 가 단독 호출돼도 안전하게 동작하도록 idempotent 하게 한 번 더
   덮어 쓴다(같은 값이면 부작용 없음). */
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

const THUMB_LONGER_EDGE = 512;

/* PSD 풀해상도 프리뷰의 긴 변 상한. Eagle 처럼 원본 크기로 줌·팬 하려면
   합성 이미지를 가능한 한 큰 해상도로 굽되, 브라우저 <canvas> 한 변 제한
   (Chromium ~16384px, 총면적 ~268M px) 과 메모리를 고려해 8192px 로 캡한다.
   native 가 이보다 작으면 다운스케일 없이 원본 해상도 그대로 굽는다. */
const PSD_PREVIEW_LONGER_EDGE = 8192;

/* PSD 그리드/폴백용 작은 썸네일 — 일반 이미지 다운스케일(1024)과 동일 톤.
   풀해상도 프리뷰는 별도(preview.webp)로 저장하므로 그리드 카드는 가벼운
   썸네일만 디코드한다. */
const PSD_THUMB_LONGER_EDGE = 1024;

/* 합성 소스를 지정 크기 캔버스에 흰 배경 위로 그려 Blob 으로 굽는 헬퍼. */
async function rasterizePsdSource(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  maxEdge: number,
  type: string,
  quality: number,
): Promise<Blob | null> {
  const longest = Math.max(srcW, srcH);
  if (longest <= 0) return null;
  const scale = Math.min(1, maxEdge / longest);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(srcW * scale));
  canvas.height = Math.max(1, Math.round(srcH * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

/**
 * PDF 첫 페이지를 PNG 썸네일로 렌더. 페이지의 자연 폭/높이에 비례해 긴 변
 * 이 THUMB_LONGER_EDGE 가 되도록 scale 조정 — 가로/세로 어떤 페이지든
 * 일관된 시각 무게로 그리드에 박힌다.
 */
export async function renderPdfFirstPageThumbnail(file: File): Promise<Blob | null> {
  try {
    const buffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    const page = await pdf.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const longest = Math.max(baseViewport.width, baseViewport.height);
    if (longest <= 0) return null;
    const scale = THUMB_LONGER_EDGE / longest;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    /* 흰 배경 fill — PDF 페이지가 배경 투명이면 다크 모드 그리드에서 텍스트
       만 동동 떠 보인다. 흰 종이 위에 인쇄된 것처럼 보이는 것이 편집기에서
       제일 직관적. */
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    /* pdfjs RenderParameters 는 환경별 typing 차이가 있다 — 일부 버전엔
       `canvas` 가 필요하고, 일부 버전엔 없다. RenderParameters 인터페이스
       만 따라가면 unknown property 라며 거부되므로 `any` 캐스트 한 번으로
       양쪽 모두 통과시킨다. 런타임에선 어떤 빌드든 무시되거나 사용된다. */
    await page.render({ canvasContext: ctx, viewport } as any).promise;
    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), "image/png", 0.92);
    });
  } catch (err) {
    console.warn("[docThumbnails] pdf render failed", err);
    return null;
  }
}

/**
 * Photoshop 문서(PSD / PSB) → 합성(composite) PNG 썸네일.
 *
 * 브라우저는 PSD/PSB 를 <img> 로 디코드하지 못해 그냥 깨지거나 셸 아이콘으로
 * 떨어진다. Eagle 처럼 *진짜* 미리보기를 보여주기 위해 `ag-psd` 로 파일을
 * 읽어 합성 캔버스를 얻은 뒤 THUMB_LONGER_EDGE 로 다운스케일해 PNG 로 굽는다.
 *
 * 우선순위:
 *  1) `psd.canvas`            — 파일에 저장된 합성(merged) 이미지. 가장 충실.
 *  2) imageResources 썸네일   — "호환성 최대화" 옵션으로 저장된 PSD 의 임베디드
 *                               미리보기(보통 저해상도). 합성 데이터가 없을 때 폴백.
 *
 * 둘 다 없으면(=레이어만 저장된 비호환 PSD) null → 호출부가 셸 아이콘으로 폴백.
 *
 * 성능: 레이어 픽셀 디코드는 썸네일에 불필요하므로 `skipLayerImageData: true`
 * 로 꺼서 대형 PSD 의 메인스레드 점유를 줄인다. 합성 캔버스만 받는다.
 */
export async function renderPsdThumbnail(file: File): Promise<Blob | null> {
  try {
    const buffer = await file.arrayBuffer();
    /* ag-psd 는 무겁고 PSD 자료에서만 필요하므로 동적 import 로 메인 번들에서
       분리. (PDF/Office 파서가 동적 import 되는 것과 동일 톤) */
    const { readPsd } = await import("ag-psd");
    const psd = readPsd(buffer, {
      skipLayerImageData: true,
      skipCompositeImageData: false,
      skipThumbnail: false,
      useImageData: false,
    });
    const source: CanvasImageSource | null =
      (psd.canvas as CanvasImageSource | undefined)
      ?? (psd.imageResources?.thumbnail as CanvasImageSource | undefined)
      ?? null;
    if (!source) return null;
    /* CanvasImageSource 는 width/height 직접 노출 안 하므로 psd 메타에서 폭/높이
       를 읽는다. 임베디드 썸네일 폴백 시엔 thumbnail 자체 크기를 쓴다. */
    const srcW = psd.canvas?.width ?? psd.imageResources?.thumbnail?.width ?? psd.width;
    const srcH = psd.canvas?.height ?? psd.imageResources?.thumbnail?.height ?? psd.height;
    const longest = Math.max(srcW, srcH);
    if (longest <= 0) return null;
    const scale = Math.min(1, THUMB_LONGER_EDGE / longest);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(srcW * scale));
    canvas.height = Math.max(1, Math.round(srcH * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    /* PSD 가 투명 배경이면 다크 그리드에서 일부 픽셀만 떠 보인다 — PDF 썸네일과
       동일하게 흰 종이 위에 합성. (불투명 PSD 는 그대로 덮인다) */
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), "image/png", 0.92);
    });
  } catch (err) {
    console.warn("[docThumbnails] psd render failed", err);
    return null;
  }
}

/**
 * PSD/PSB → 풀해상도 프리뷰 + 작은 썸네일을 *한 번의 파싱* 으로 생성.
 *
 * Eagle 식 동작(원본 크기 로드 → 휠 줌인/줌아웃, 드래그 팬) 을 위해 합성
 * 이미지를 PSD_PREVIEW_LONGER_EDGE(최대 8192px) 해상도의 WebP 로 굽고
 * (`full`), 그리드 카드용으로 PSD_THUMB_LONGER_EDGE(1024px) PNG 도 함께
 * 굽는다(`thumb`). 풀해상도는 file_url 옆 preview.webp 로 저장되어 프리뷰
 * 패널의 이미지 줌·팬 분기가 그대로 재사용한다.
 *
 * `width`/`height` 는 합성 native 해상도라 인스펙터 "해상도" 가 썸네일이
 * 아닌 실제 PSD 크기를 표시한다.
 *
 * 합성/임베디드 썸네일 둘 다 없으면 null → 호출부가 셸 아이콘으로 폴백.
 */
export async function renderPsdRasters(file: File): Promise<{
  full: Blob;
  thumb: Blob;
  width: number;
  height: number;
} | null> {
  try {
    const buffer = await file.arrayBuffer();
    const { readPsd } = await import("ag-psd");
    const psd = readPsd(buffer, {
      skipLayerImageData: true,
      skipCompositeImageData: false,
      skipThumbnail: false,
      useImageData: false,
    });
    const source: CanvasImageSource | null =
      (psd.canvas as CanvasImageSource | undefined)
      ?? (psd.imageResources?.thumbnail as CanvasImageSource | undefined)
      ?? null;
    if (!source) return null;
    const srcW = psd.canvas?.width ?? psd.imageResources?.thumbnail?.width ?? psd.width;
    const srcH = psd.canvas?.height ?? psd.imageResources?.thumbnail?.height ?? psd.height;
    if (!srcW || !srcH) return null;
    const full = await rasterizePsdSource(source, srcW, srcH, PSD_PREVIEW_LONGER_EDGE, "image/webp", 0.9);
    const thumb = await rasterizePsdSource(source, srcW, srcH, PSD_THUMB_LONGER_EDGE, "image/png", 0.92);
    if (!full || !thumb) return null;
    return { full, thumb, width: srcW, height: srcH };
  } catch (err) {
    console.warn("[docThumbnails] psd rasterize failed", err);
    return null;
  }
}

/**
 * 폰트 파일 → "Aa Gg" 단문 미리보기.
 *
 * 1) 파일을 ArrayBuffer 로 읽어 FontFace API 로 등록(임의의 family 명).
 * 2) document.fonts.add 로 활성화한 뒤 캔버스 ctx.font 에 적용.
 * 3) 캔버스에 큰 글자 1줄을 그리고 PNG 로 export.
 *
 * - 일부 폰트(가변 폰트 등) 는 FontFace 가 거부할 수 있어 try/catch 로
 *   null 폴백.
 * - 한글 글리프가 없는 폰트라면 "가" 가 박스로 그려질 수 있지만, 라틴 글자
 *   "Aa" 는 거의 항상 보장되므로 사용자가 글꼴 식별에 충분.
 */
export async function renderFontPreviewThumbnail(file: File): Promise<Blob | null> {
  try {
    const buffer = await file.arrayBuffer();
    /* family 명은 충돌만 피하면 무엇이든 OK. globalThis 의 FontFaceSet 에
       추가되므로 충돌하지 않게 random suffix. */
    const family = `__pf_doc_${Math.random().toString(36).slice(2, 8)}`;
    const face = new FontFace(family, buffer);
    await face.load();
    /* document.fonts 는 모든 모던 브라우저에서 존재 — 별도 가드 없이 호출. */
    document.fonts.add(face);

    const W = 512;
    const H = 384;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#1a1a1a";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    /* 큰 글자 1줄: 라틴 sample + 한글 sample. 라틴은 폰트의 weight/serif
       특성을 가장 잘 드러내는 "Aa Gg", 한글은 "가나" — 라틴-only 폰트라도
       fallback 글리프가 그려진다(boxy-tofu 가 아닌 시스템 폴백 글꼴). */
    const sampleLine = "Aa Gg 가나";
    ctx.font = `140px "${family}", "Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;
    ctx.fillText(sampleLine, W / 2, H / 2);
    /* 폰트 family 을 떠난 즉시 GC 되도록 등록 해제. 캔버스에는 이미 그려졌
       으니 시각적 영향 없음. */
    try {
      document.fonts.delete(face);
    } catch {
      // ignore — 일부 브라우저는 임시 등록 폰트 삭제를 거부할 수 있다.
    }
    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), "image/png", 0.92);
    });
  } catch (err) {
    console.warn("[docThumbnails] font render failed", err);
    return null;
  }
}

/**
 * Office Open XML (PPTX / XLSX / DOCX 등) 자료의 *임베디드 썸네일* 추출.
 *
 * 2007+ 의 OOXML 포맷은 사실상 ZIP 컨테이너라, "썸네일 저장" 옵션이 켜진 채로
 * 저장한 문서는 `docProps/thumbnail.jpeg` 또는 `.png` 엔트리를 갖는다(보통
 * 256×144 ~ 1280×720). 그 엔트리만 추출해 그대로 PNG/JPEG Blob 으로 돌려준다.
 *
 * 못 찾거나 ZIP 헤더가 아니거나 파일이 손상됐을 때는 모두 null. 호출부는
 * 다음 폴백(셸 아이콘)으로 넘어간다.
 *
 * - Keynote/Numbers/Pages (`.key` / `.numbers` / `.pages`) 도 zip 컨테이너에
 *   `preview.jpg` 를 두지만 경로가 다르다 — 1차 구현에선 OOXML 만 다루고,
 *   필요해지면 후속 PR 로 매칭 패턴 추가.
 * - 일부 PPTX 는 thumbnail 엔트리가 있어도 Content_Types 에 등록 안 된 케이스
 *   가 있어 JSZip 의 unsafe 옵션이 필요할 수 있는데, 경험상 검출률에 영향
 *   없으므로 기본 옵션으로 둔다.
 */
export async function renderOfficeEmbeddedThumbnail(file: File): Promise<Blob | null> {
  try {
    const buffer = await file.arrayBuffer();
    /* ZIP magic 빠른 거부 — `PK\x03\x04`. ZIP 가 아니면 JSZip.loadAsync 가
       던지는 에러 메시지를 콘솔에 남길 필요 없이 즉시 null. */
    const head = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
    if (head.length < 4 || head[0] !== 0x50 || head[1] !== 0x4b || head[2] !== 0x03 || head[3] !== 0x04) {
      return null;
    }
    const zip = await JSZip.loadAsync(buffer);
    /* OOXML 공식 경로는 `docProps/thumbnail.{jpeg|png}`. 일부 도구가
       `Thumbnail.png` 같은 변종을 쓰는 경우가 있어 case-insensitive 매칭. */
    const candidate = Object.keys(zip.files).find((name) =>
      /^docProps\/thumbnail\.(jpe?g|png)$/i.test(name),
    );
    if (!candidate) return null;
    const entry = zip.file(candidate);
    if (!entry) return null;
    const blob = await entry.async("blob");
    if (blob.size === 0) return null;
    /* MIME 보정 — JSZip 이 entry 자체엔 MIME 을 박아주지 않으므로 확장자 기준
       으로 type 만 채워 다음 단계(Supabase 업로드/<img> 디코드) 가 자연스럽게
       처리되도록 한다. */
    const ext = candidate.toLowerCase().match(/\.(jpe?g|png)$/)?.[1];
    const mime = ext === "png" ? "image/png" : "image/jpeg";
    return blob.type ? blob : new Blob([blob], { type: mime });
  } catch (err) {
    console.warn("[docThumbnails] office embedded thumbnail failed", err);
    return null;
  }
}

/**
 * OS 셸(파일 연결) 아이콘 → 그리드 카드용 *정사각형 PNG 썸네일*.
 *
 * Electron main process 가 `app.getFileIcon` 으로 추출한 PNG (보통 256×256
 * 또는 32×32) 를 받아, doc subtype 의 옅은 hue 표면 위 중앙에 배치한 512×512
 * 캔버스로 다시 그린다 — Eagle 식 "아이콘 카드" 모양을 유지하기 위함. 작은
 * 아이콘을 그대로 카드에 cover-fit 하면 가장자리가 잘리거나 흐려진다.
 *
 * Electron preload 가 아직 로드되지 않은 환경(브라우저 단독 dev 서버) 에서는
 * 즉시 null 반환 — 그 환경에선 generic hue 카드로 자연 폴백한다.
 */
export async function renderShellIconThumbnail(file: File): Promise<Blob | null> {
  try {
    /* preflowWindow 가 없으면 IPC 자체가 불가능 → null. test/storybook/
       브라우저 dev 서버에서 호출돼도 안전하게 빠짐. */
    const api = typeof window !== "undefined" ? window.preflowWindow : undefined;
    if (!api?.getFileIcon) return null;

    const bytes = new Uint8Array(await file.arrayBuffer());
    const iconPng = await api.getFileIcon(file.name || "file", bytes);
    if (!iconPng || iconPng.length === 0) return null;

    /* IPC 가 돌려준 PNG 를 <img> 로 디코드 → 캔버스 중앙에 contain-fit.
       Blob 컨스트럭터가 TS 5.x 에서 `Uint8Array<ArrayBuffer>` (SharedArrayBuffer
       제외) 만 받도록 좁아져서 명시 캐스트 — 프로젝트 내 videoToWebp/videoToGif
       와 동일한 패턴. */
    const iconBlob = new Blob([iconPng as Uint8Array<ArrayBuffer>], { type: "image/png" });
    const iconUrl = URL.createObjectURL(iconBlob);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("icon decode failed"));
        el.src = iconUrl;
      });
      const W = 512;
      const H = 512;
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      /* 배경 — 거의 흰 톤의 옅은 회색. 다크 모드 카드 위에서도 아이콘이 잘
         읽히고, 가벼운 비네팅 효과로 카드 가장자리에 자연스러운 패딩이
         생긴다. doc subtype hue 까지 끌어쓰면 색이 너무 강해져 도리어 아이콘
         이 안 보이므로, 일부러 중립색으로 두고 카드 좌상단 배지(hue) 가 색
         식별을 맡는다. */
      ctx.fillStyle = "#f5f5f5";
      ctx.fillRect(0, 0, W, H);

      /* 아이콘은 캔버스의 ~50% 사이즈로 중앙 배치. 256-px 원본이면 1:1, 32-px
         원본이면 8× scale up 되지만 OS shell 아이콘은 SVG/멀티-resolution PNG
         가 캐스케이드 되어 적당히 선명한 게 들어온다. nearest-neighbor 가 더
         또렷할 수 있으나 기본 bilinear 가 일관성 면에서 무난. */
      const target = Math.min(W, H) * 0.5;
      const scale = Math.min(target / img.naturalWidth, target / img.naturalHeight);
      const drawW = img.naturalWidth * scale;
      const drawH = img.naturalHeight * scale;
      ctx.drawImage(img, (W - drawW) / 2, (H - drawH) / 2, drawW, drawH);

      return await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((blob) => resolve(blob), "image/png", 0.92);
      });
    } finally {
      URL.revokeObjectURL(iconUrl);
    }
  } catch (err) {
    console.warn("[docThumbnails] shell icon render failed", err);
    return null;
  }
}
