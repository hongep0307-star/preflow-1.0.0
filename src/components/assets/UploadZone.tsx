import { useRef, useState } from "react";
import { Plus } from "lucide-react";
import { type AssetType, KR } from "./types";
import { useT } from "@/lib/uiLanguage";

interface Props {
  assetType: AssetType;
  onFile: (file: File) => void;
}

export const UploadZone = ({ assetType, onFile }: Props) => {
  const t = useT();
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith("image/")) onFile(file);
  };
  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
      <button
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className="w-full border border-dashed flex flex-col items-center justify-center gap-2 transition-all"
        style={{
          height: 100,
          borderRadius: 0,
          borderColor: dragOver ? KR : "rgba(255,255,255,0.1)",
          background: dragOver ? "rgba(249,66,58,0.04)" : "transparent",
        }}
      >
        <Plus className="w-5 h-5" style={{ color: dragOver ? KR : "rgba(255,255,255,0.2)" }} />
        <span className="font-mono text-2xs tracking-wider text-muted-foreground/40">
          {dragOver ? t("assets.dropHere") : t("assets.dragOrClick")}
        </span>
      </button>
    </>
  );
};
