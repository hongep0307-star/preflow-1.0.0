import { Headphones } from "lucide-react";
import { docExtensionTag } from "@/lib/docPresentation";
import type { ReferenceItem } from "@/lib/referenceLibrary";

/* 인앱 오디오 플레이어 — `kind:"doc"` + subtype:"audio" 자료.
 *
 * native <audio controls> 가 Chromium 의 표준 컨트롤(재생/시크/볼륨/배속)을
 * 그대로 그려준다. 영상의 LibraryPreviewPanel 자체 커스텀 컨트롤만큼 화려할
 * 필요는 없고(라이브러리는 오디오 자료가 부수 자산이라), 가운데 큰 카드 +
 * controls 가 사용자에게 충분히 익숙한 형태.
 *
 * 파일이 없거나 mime 이 audio/* 가 아닌 케이스는 부모 LibraryPreviewPanel 의
 * doc 분기에서 이미 걸러지므로 여기선 가드만 최소화. */
interface AudioViewProps {
  item: ReferenceItem;
}

export function AudioView({ item }: AudioViewProps) {
  const src = item.file_url ?? "";
  const ext = docExtensionTag(item);
  if (!src) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-black text-meta text-white/40">
        No audio file.
      </div>
    );
  }
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-b from-violet-500/10 via-background to-background p-6">
      <div className="flex w-full max-w-xl flex-col items-center gap-5 border border-border-subtle bg-background/60 p-8 text-center">
        <Headphones className="h-14 w-14 text-violet-500" />
        <div className="space-y-1">
          <div className="break-all text-label font-medium">{item.title}</div>
          <div className="font-mono text-2xs tracking-normal text-muted-foreground">
            {ext}
            {typeof item.duration_sec === "number" && Number.isFinite(item.duration_sec)
              ? ` · ${formatDuration(item.duration_sec)}`
              : ""}
          </div>
        </div>
        {/* preload="metadata" 만으로 메타 + duration 노출. 자동재생은 하지
            않는다(라이브러리 자료를 *조용히* 확인하는 흐름이 자연스러움). */}
        <audio src={src} controls preload="metadata" className="w-full" />
      </div>
    </div>
  );
}

function formatDuration(value: number): string {
  const total = Math.max(0, Math.floor(value));
  const minutes = Math.floor(total / 60).toString().padStart(2, "0");
  const seconds = (total % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}
