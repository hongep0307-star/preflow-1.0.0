import { detectMediaType } from "@/lib/detectMediaType";

export const dataUrlToResizedBase64 = (dataUrl: string, maxSize = 512): Promise<string> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale),
        h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", 0.8).split(",")[1]);
    };
    img.onerror = reject;
    img.src = dataUrl;
  });

export const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        resolve(await dataUrlToResizedBase64(reader.result as string));
      } catch (e) {
        reject(e);
      }
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

export const urlToBase64 = async (url: string): Promise<{ base64: string; mediaType: string }> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`이미지 fetch 실패 (${res.status})`);
  const blob = await res.blob();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
  const resized = await dataUrlToResizedBase64(dataUrl);
  return { base64: resized, mediaType: detectMediaType(resized) };
};
