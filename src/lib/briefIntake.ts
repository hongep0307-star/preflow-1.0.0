/**
 * briefIntake.ts — Brief 입력물(파일) → 텍스트/base64 변환 공용 헬퍼.
 *
 * BriefTab 의 composer 가 쓰던 PDF 텍스트 추출 / 이미지 base64 변환 로직을
 * 라이브러리의 "브리프 매치" 플라이아웃에서도 재사용하기 위해 추출했다.
 * (BriefTab 자체는 거대/민감 파일이라 건드리지 않고, 동일 동작의 함수만 공용화)
 */
import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// 여러 곳에서 set 되어도 무방(idempotent). BriefTab 도 동일하게 설정.
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

/** File → base64 (data URL prefix 제거한 순수 base64). */
export const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

/** base64 → data URL (미리보기용). */
export const toDataUrl = (base64: string, mediaType: string): string =>
  `data:${mediaType};base64,${base64}`;

/**
 * 브리프 캡쳐 이미지를 localStorage 보관용으로 다운스케일 + 재인코딩한다.
 *
 * 풀스크린 스크린샷은 base64 가 수 MB 라 그대로 보관하면 briefMatchStore →
 * pending → brief draft 로 이어지는 localStorage 체인에서 quota 초과로 *조용히*
 * 유실된다(브리프 이미지가 프로젝트로 carry 안 되고 분석도 레퍼런스 위주가 되는
 * 원인). 최대 변 `maxDim`px, JPEG `quality` 로 줄여 보통 수백 KB 로 만든다.
 * 실패 시 원본을 그대로 반환(graceful).
 */
export async function compressImageForStorage(
  base64: string,
  mediaType: string,
  maxDim = 1600,
  quality = 0.82,
): Promise<{ base64: string; mediaType: string }> {
  try {
    if (typeof document === "undefined") return { base64, mediaType };
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("image decode failed"));
      el.src = `data:${mediaType};base64,${base64}`;
    });
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return { base64, mediaType };
    const scale = Math.min(1, maxDim / Math.max(w, h));
    const outW = Math.max(1, Math.round(w * scale));
    const outH = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { base64, mediaType };
    ctx.drawImage(img, 0, 0, outW, outH);
    const url = canvas.toDataURL("image/jpeg", quality);
    const comma = url.indexOf(",");
    if (comma < 0) return { base64, mediaType };
    return { base64: url.slice(comma + 1), mediaType: "image/jpeg" };
  } catch {
    return { base64, mediaType };
  }
}

export interface ExtractedPdf {
  text: string;
  pages: number;
}

/** PDF → 페이지별 텍스트(최대 8000자). 텍스트가 거의 없으면(스캔본 등) throw. */
export async function extractTextFromPDF(file: File): Promise<ExtractedPdf> {
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    pages.push(`[${i}페이지]\n${(tc.items as any[]).map((it) => it.str).join(" ")}`);
  }
  const full = pages.join("\n\n");
  if (full.trim().length < 50) throw new Error("Not enough text extracted");
  return {
    text: full.length > 8000 ? full.slice(0, 8000) + "\n\n[truncated]" : full,
    pages: pdf.numPages,
  };
}

const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

/** 드롭된 파일들을 PDF / 이미지로 분류. */
export function classifyDroppedFiles(files: FileList | File[]): { pdfs: File[]; images: File[] } {
  const arr = Array.from(files);
  return {
    pdfs: arr.filter((f) => f.type === "application/pdf"),
    images: arr.filter((f) => IMAGE_MIME.has(f.type)),
  };
}
