/**
 * BriefMatchFlyout — 사이드바 '스마트 브리프 매치' + 옆에 열리는 컴팩트 패널.
 *
 * 브리프(텍스트 + 로컬 PDF/이미지 드롭 + 라이브러리 카드 드래그 앵커)를 가볍게
 * 분석해, "분석 & 매칭" 한 번으로 (1) 무드 신호로 우측 그리드를 점수순 정렬하고
 * (2) 브리프 내용을 보관한 스마트 브리프 매치 폴더를 생성한다. 이후 폴더 관리
 * (드래그로 레퍼런스 추가, 프로젝트 생성)는 사이드바 폴더 행에서 한다.
 *
 * - 모달이 아니다(바깥 클릭으로 닫히지 않음).
 * - 라이브러리 카드 앵커 드롭은 libraryDragChannel 글로벌 트래커
 *   (data-drop-brief-anchor)를 통해 부모가 onAnchorIdsChange 로 받는다. 드래그
 *   hover 시각(빨간 네모)은 subscribeDragHover 로 직접 반영한다.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { FileText, Loader2, Wand2, X } from "lucide-react";
import { useT } from "@/lib/uiLanguage";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import type { ReferenceItem } from "@/lib/referenceLibrary";
import type { MoodFilterSpec } from "@/lib/moodSearch";
import { getActiveLibraryDrag, subscribeDragHover } from "@/lib/libraryDragChannel";
import { classifyDroppedFiles, compressImageForStorage, extractTextFromPDF, fileToBase64, toDataUrl } from "@/lib/briefIntake";
import { briefToMoodSpec, saveMatchesToLibraryFolder } from "@/lib/briefMatch";
import { rerankReferencesForBrief } from "@/lib/briefReferenceRerank";
import { scoreReferences } from "@/lib/referenceRecommender";
import { urlToVisionBase64 } from "@/lib/referenceLibrary";

interface LocalImage {
  file: File;
  base64: string;
  mediaType: string;
  preview: string;
}
interface LocalPdf {
  file: File;
  text: string;
  pages: number;
}

export interface BriefMatchFlyoutProps {
  open: boolean;
  /** 사이드바 폭 — 패널을 사이드바 바로 오른쪽에 도킹. */
  leftOffset: number;
  items: ReferenceItem[];
  selectedItems: ReferenceItem[];
  anchorIds: string[];
  onAnchorIdsChange: (ids: string[]) => void;
  /** 라이브러리 카드를 브리프 이미지 드롭존에 떨군 id 들(브리프 분석 입력). */
  briefImageIds: string[];
  onBriefImageIdsChange: (ids: string[]) => void;
  onApplyMoodFilter: (spec: MoodFilterSpec) => void;
  /** 토큰 기반 1차 정렬 직후, 부모가 LLM 의미 기반 재정렬을 백그라운드 실행. */
  onRequestBriefRerank?: (input: { briefText?: string; signals: MoodFilterSpec["signals"] }) => void;
  onClose: () => void;
  /** 폴더 생성 직후 — 부모가 라이브러리 목록을 reload 해 새 폴더를 반영. */
  onSaved?: () => void;
  /** 폴더 생성 + 매칭 저장 완료 후 — 부모가 해당 폴더로 이동(매칭 결과를 폴더
   *  내용으로 바로 보여줌). 휘발성 AI 필터 대신 영구 폴더 중심 UX. */
  onCreated?: (folderPath: string) => void;
  /** attach 모드 — 일반 폴더를 스마트 브리프 매치로 옮길 때 기존 폴더에 브리프를
   *  첨부하는 흐름. 값이 있으면 폴더 생성/LLM 분석 대신 "저장하고 이동"으로 동작.
   *  (라이브러리 드래그&드롭이 되는 + 패널 UI를 그대로 재사용) */
  attachFolderName?: string | null;
  /** attach 확인 — 입력한 브리프 내용을 부모가 받아 폴더에 저장 + 이동(LLM 스킵). */
  onAttachConfirm?: (content: {
    briefText: string;
    images: { base64: string; mediaType: string }[];
    pdfText?: string;
  }) => void | Promise<void>;
}

const MAX_IMAGES = 4;

export function BriefMatchFlyout({
  open,
  leftOffset,
  items,
  selectedItems,
  anchorIds,
  onAnchorIdsChange,
  briefImageIds,
  onBriefImageIdsChange,
  onClose,
  onSaved,
  onCreated,
  attachFolderName,
  onAttachConfirm,
}: BriefMatchFlyoutProps) {
  const t = useT();
  const { toast } = useToast();
  const isAttach = !!attachFolderName;

  const [briefText, setBriefText] = useState("");
  const [localImages, setLocalImages] = useState<LocalImage[]>([]);
  // 로컬에서 레퍼런스 영역에 떨군 이미지(분석 시 매칭 시드로 사용).
  const [localRefImages, setLocalRefImages] = useState<LocalImage[]>([]);
  const [pdf, setPdf] = useState<LocalPdf | null>(null);
  const [folderName, setFolderName] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [dragOver, setDragOver] = useState<null | "brief" | "anchor">(null);
  const [anchorHover, setAnchorHover] = useState(false);
  const [briefImageHover, setBriefImageHover] = useState(false);
  // 사이드바의 '스마트 브리프 매치' 섹션 라인에 패널 상단을 맞춘다(동적 측정).
  const containerRef = useRef<HTMLDivElement>(null);
  const [topOffset, setTopOffset] = useState(48);

  // useLayoutEffect — 페인트 전에 측정/반영해 "천장에 붙었다가 내려오는" 플리커 제거.
  useLayoutEffect(() => {
    if (!open) return;
    const recompute = () => {
      const el = containerRef.current;
      const section = document.querySelector<HTMLElement>("[data-brief-match-section]");
      if (!el || !section) return;
      const parent = el.offsetParent as HTMLElement | null;
      const parentTop = parent ? parent.getBoundingClientRect().top : 0;
      // 섹션 헤더 라인에 맞추되, 최소 8px 는 위에서 띄운다.
      setTopOffset(Math.max(8, Math.round(section.getBoundingClientRect().top - parentTop)));
    };
    recompute();
    const raf = requestAnimationFrame(recompute); // 레이아웃 안정 후 1회 재측정
    window.addEventListener("resize", recompute);
    document.addEventListener("scroll", recompute, true); // 사이드바 스크롤 포함
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", recompute);
      document.removeEventListener("scroll", recompute, true);
    };
  }, [open]);

  // 라이브러리 카드를 브리프/레퍼런스 드롭존 위로 드래그할 때(내부 드래그) 강조.
  useEffect(() => {
    if (!open) return;
    const unsub = subscribeDragHover((target) => {
      setAnchorHover(target?.kind === "briefAnchor");
      setBriefImageHover(target?.kind === "briefImage");
    });
    return () => {
      unsub();
      setAnchorHover(false);
      setBriefImageHover(false);
    };
  }, [open]);

  const anchorItems = useMemo(() => {
    const byId = new Map(items.map((it) => [it.id, it]));
    return anchorIds.map((id) => byId.get(id)).filter((x): x is ReferenceItem => Boolean(x));
  }, [items, anchorIds]);

  // 라이브러리에서 브리프 이미지로 떨군 카드들(썸네일 표시 + 분석 입력).
  const briefImageItems = useMemo(() => {
    const byId = new Map(items.map((it) => [it.id, it]));
    return briefImageIds.map((id) => byId.get(id)).filter((x): x is ReferenceItem => Boolean(x));
  }, [items, briefImageIds]);

  const finalRefs = useMemo(() => {
    const map = new Map<string, ReferenceItem>();
    for (const it of anchorItems) map.set(it.id, it);
    for (const it of selectedItems) map.set(it.id, it);
    return Array.from(map.values());
  }, [anchorItems, selectedItems]);

  // 브리프 영역 로컬 드롭 — PDF + 이미지를 브리프 입력으로.
  const handleLocalBriefFiles = useCallback(
    async (files: FileList | File[]) => {
      const { pdfs, images } = classifyDroppedFiles(files);
      if (pdfs[0]) {
        try {
          const { text, pages } = await extractTextFromPDF(pdfs[0]);
          setPdf({ file: pdfs[0], text, pages });
        } catch {
          toast({ variant: "destructive", title: t("briefMatch.analyzeFailed"), description: "PDF" });
        }
      }
      for (const f of images) {
        if (f.size > 10 * 1024 * 1024) continue;
        const base64 = await fileToBase64(f);
        setLocalImages((prev) =>
          prev.length >= MAX_IMAGES
            ? prev
            : [...prev, { file: f, base64, mediaType: f.type, preview: toDataUrl(base64, f.type) }],
        );
      }
    },
    [t, toast],
  );

  // 레퍼런스 영역 로컬 드롭 — 이미지를 매칭 시드(레퍼런스)로.
  const handleLocalRefFiles = useCallback(async (files: FileList | File[]) => {
    const { images } = classifyDroppedFiles(files);
    for (const f of images) {
      if (f.size > 10 * 1024 * 1024) continue;
      const base64 = await fileToBase64(f);
      setLocalRefImages((prev) =>
        prev.length >= MAX_IMAGES
          ? prev
          : [...prev, { file: f, base64, mediaType: f.type, preview: toDataUrl(base64, f.type) }],
      );
    }
  }, []);

  const onBriefFileDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDragOver(null);
      if (getActiveLibraryDrag()) return; // 라이브러리 카드 드래그는 글로벌 트래커가 처리
      if (e.dataTransfer.files?.length) void handleLocalBriefFiles(e.dataTransfer.files);
    },
    [handleLocalBriefFiles],
  );

  const onRefFileDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDragOver(null);
      if (getActiveLibraryDrag()) return; // 라이브러리 카드 드래그는 글로벌 트래커가 처리
      if (e.dataTransfer.files?.length) void handleLocalRefFiles(e.dataTransfer.files);
    },
    [handleLocalRefFiles],
  );

  const allowFileDrop = (e: DragEvent, zone: "brief" | "anchor") => {
    if (getActiveLibraryDrag()) return; // 내부 드래그는 글로벌 트래커가 처리
    e.preventDefault();
    setDragOver(zone);
  };

  const resetForm = () => {
    setBriefText("");
    setLocalImages([]);
    setLocalRefImages([]);
    setPdf(null);
    setFolderName("");
    onAnchorIdsChange([]);
    onBriefImageIdsChange([]);
  };

  // "분석 & 매칭" — 브리프를 분석해 어울리는 레퍼런스를 *폴더에 담아* 생성하고,
  // 그 폴더로 이동해 결과를 보여준다(휘발성 AI 필터 대신 영구 폴더 중심 UX).
  const handleAnalyze = async () => {
    const text = [briefText, pdf?.text].filter(Boolean).join("\n\n").trim();
    const hasAnyInput =
      !!text ||
      localImages.length > 0 ||
      localRefImages.length > 0 ||
      briefImageItems.length > 0 ||
      anchorItems.length > 0;
    if (!hasAnyInput) {
      toast({ variant: "destructive", title: t("briefMatch.needBrief") });
      return;
    }
    setAnalyzing(true);
    try {
      // 라이브러리에서 브리프 이미지로 떨군 카드들을 분석 직전 base64 로 해석.
      const libBriefImages: { mediaType: string; dataBase64: string }[] = [];
      for (const it of briefImageItems) {
        const src = it.file_url || it.thumbnail_url;
        if (!src) continue;
        try {
          const { base64, mediaType } = await urlToVisionBase64(src);
          libBriefImages.push({ mediaType, dataBase64: base64 });
        } catch {
          /* skip — 해석 실패한 항목은 분석 입력에서 제외 */
        }
      }
      // 브리프 로컬 + 레퍼런스 로컬 + 라이브러리 브리프 이미지를 모두 시각 입력으로.
      const analysisImages = [
        ...localImages.map((i) => ({ mediaType: i.mediaType, dataBase64: i.base64 })),
        ...localRefImages.map((i) => ({ mediaType: i.mediaType, dataBase64: i.base64 })),
        ...libBriefImages,
      ].slice(0, 8);
      const { spec, folderName: aiName } = await briefToMoodSpec({
        text,
        images: analysisImages,
      });

      // 매칭: 의미 기반 재정렬(LLM)로 폴더 멤버를 고른다. 실패/0건이면 토큰
      // 기반 scoreReferences 로 폴백 — 어느 경우든 폴더가 비지 않게 한다.
      let matchedIds: string[] = [];
      try {
        const ranked = await rerankReferencesForBrief(
          { briefText: text, signals: spec.signals },
          items,
          { maxCandidates: 60 },
        );
        matchedIds = ranked.map((r) => r.id);
      } catch {
        /* 폴백으로 진행 */
      }
      if (matchedIds.length === 0) {
        matchedIds = scoreReferences(spec.signals, items, {
          minScore: spec.minScore,
          limit: items.length || 1,
          strict: false,
        }).map((r) => r.item.id);
      }
      // 사용자가 명시적으로 고른 앵커/선택 + 매칭 결과. 상한으로 과도한 멤버 방지.
      const memberIds = [
        ...new Set([...finalRefs.map((r) => r.id), ...matchedIds]),
      ].slice(0, 60);

      const name = folderName.trim() || aiName;
      // 보관용으로 다운스케일 — 풀스크린 캡쳐 base64 를 그대로 LS 에 넣으면 quota
      // 초과로 유실되어 브리프 이미지가 프로젝트로 carry 되지 않는다.
      const storedImages = await Promise.all(
        localImages.map((i) => compressImageForStorage(i.base64, i.mediaType)),
      );
      const path = await saveMatchesToLibraryFolder(memberIds, name, {
        briefText,
        images: storedImages,
        pdfText: pdf?.text,
      });
      onSaved?.();
      onCreated?.(path); // 생성된 폴더로 이동 → 매칭 결과를 폴더 내용으로 표시
      toast({
        title: t("briefMatch.createdToast"),
        description: t("briefMatch.matchedCount", { n: memberIds.length }),
      });
      resetForm();
      onClose();
    } catch (e) {
      toast({ variant: "destructive", title: t("briefMatch.analyzeFailed"), description: (e as Error).message });
    } finally {
      setAnalyzing(false);
    }
  };

  // attach 모드 — 기존 폴더에 브리프를 첨부하고 스마트 브리프 매치로 이동(LLM 스킵).
  // 라이브러리에서 드래그한 레퍼런스(anchorIds/briefImageIds)는 부모가 폴더 멤버로
  // 추가한다. 여기서는 로컬 입력(텍스트/이미지/PDF)만 모아 전달.
  const handleAttach = async () => {
    const text = briefText.trim();
    const hasBrief =
      !!text ||
      localImages.length > 0 ||
      localRefImages.length > 0 ||
      briefImageItems.length > 0 ||
      !!pdf?.text;
    if (!hasBrief) {
      toast({ variant: "destructive", title: t("briefMatch.needBrief") });
      return;
    }
    setAnalyzing(true);
    try {
      const storedImages = await Promise.all(
        [...localImages, ...localRefImages].map((i) => compressImageForStorage(i.base64, i.mediaType)),
      );
      await onAttachConfirm?.({ briefText: text, images: storedImages, pdfText: pdf?.text });
      resetForm();
      onClose();
    } catch (e) {
      toast({ variant: "destructive", title: t("briefMatch.analyzeFailed"), description: (e as Error).message });
    } finally {
      setAnalyzing(false);
    }
  };

  if (!open) return null;

  const thumbOf = (it: ReferenceItem) => it.thumbnail_url || it.file_url || "";

  return (
    <div
      ref={containerRef}
      className="absolute z-40 flex w-[320px] flex-col overflow-hidden border border-border bg-surface-sidebar shadow-2xl"
      // 사이드바 '스마트 브리프 매치' 섹션 라인에서 시작 + 콘텐츠 높이(최대치
      // 제한)로 컴팩트하게 — 툴바/라이브러리를 불필요하게 가리지 않는다.
      style={{
        left: leftOffset,
        top: topOffset,
        maxHeight: `calc(100% - ${topOffset + 16}px)`,
        borderRadius: 0,
      }}
    >
      {/* Header — 사이드바 톤(사각 모서리)에 맞춤 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Wand2 className="h-3.5 w-3.5 text-primary" />
        <span className="flex-1 truncate text-meta font-semibold">
          {isAttach ? t("briefMatch.attachTitle", { name: attachFolderName ?? "" }) : t("briefMatch.title")}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-6 w-6 items-center justify-center text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          style={{ borderRadius: 0 }}
          aria-label={t("common.close")}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Body — 실제 브리프 탭과 톤 통일(사각 모서리, bg-input, primary 강조) */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5 space-y-3.5">
        {/* Folder name — 가장 상위 (attach 모드에서는 폴더가 고정이라 숨김) */}
        <div className={isAttach ? "hidden" : undefined}>
          <p className="label-meta text-foreground mb-1">{t("briefMatch.folderName")}</p>
          <input
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            placeholder={t("briefMatch.folderNamePlaceholder")}
            className="w-full border bg-input px-2.5 py-1.5 text-meta text-foreground outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-primary/50"
            style={{ borderRadius: 0, borderColor: "rgba(255,255,255,0.07)" }}
          />
        </div>

        {/* Brief text + local drop */}
        <div>
          <p className="label-meta text-foreground mb-1">{t("briefMatch.briefText")}</p>
          <div
            data-drop-brief-image=""
            onDrop={onBriefFileDrop}
            onDragOver={(e) => allowFileDrop(e, "brief")}
            onDragLeave={() => setDragOver(null)}
            className={cn(
              "overflow-hidden border bg-input transition-colors",
              dragOver === "brief" || briefImageHover ? "border-primary/50" : "border-input focus-within:border-primary/50",
            )}
            style={{
              borderRadius: 0,
              ...(dragOver === "brief" || briefImageHover ? { background: "rgba(249,66,58,0.04)" } : {}),
            }}
          >
            <textarea
              value={briefText}
              onChange={(e) => setBriefText(e.target.value)}
              placeholder={t("briefMatch.briefPlaceholder")}
              className="w-full min-h-[88px] resize-none border-none bg-transparent px-3 pt-3 pb-2 text-meta leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/40"
            />
            <div className="flex items-center gap-1.5 border-t border-border bg-input px-3 py-1.5">
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="1.5">
                <path d="M3 10l3-3 3 3M9 7l3-3 3 3" />
                <path d="M1 13h14" />
              </svg>
              <span className="font-mono text-2xs text-muted-foreground/40">{t("brief.attachHint")}</span>
            </div>
          </div>

          {/* 브리프 첨부(PDF/이미지/라이브러리) — 실제 브리프 탭의 '브리프 이미지' 박스 톤 */}
          {(pdf || localImages.length > 0 || briefImageItems.length > 0) && (
            <div className="mt-2 border border-border p-2" style={{ borderRadius: 0 }}>
              <p className="label-meta text-muted-foreground mb-1.5">{t("brief.briefImages")}</p>
              <div className="flex flex-wrap gap-2">
                {pdf ? (
                  <span className="group inline-flex items-center gap-1 border border-border bg-input px-1.5 py-0.5 text-caption" style={{ borderRadius: 0 }}>
                    <FileText className="h-3 w-3" /> {pdf.file.name}
                    <button type="button" onClick={() => setPdf(null)} className="ml-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ) : null}
                {localImages.map((img, i) => (
                  <div key={i} className="group relative h-[56px] w-[56px] border border-border" style={{ borderRadius: 0 }}>
                    <img src={img.preview} alt="" className="h-full w-full object-cover" />
                    <button
                      type="button"
                      onClick={() => setLocalImages((prev) => prev.filter((_, j) => j !== i))}
                      className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center bg-primary text-white opacity-0 transition-opacity group-hover:opacity-100"
                      style={{ borderRadius: 0 }}
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </div>
                ))}
                {briefImageItems.map((it) => (
                  <div key={it.id} className="group relative h-[56px] w-[56px] border border-border" style={{ borderRadius: 0 }}>
                    {thumbOf(it) ? <img src={thumbOf(it)} alt="" className="h-full w-full object-cover" /> : null}
                    <button
                      type="button"
                      onClick={() => onBriefImageIdsChange(briefImageIds.filter((id) => id !== it.id))}
                      className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center bg-primary text-white opacity-0 transition-opacity group-hover:opacity-100"
                      style={{ borderRadius: 0 }}
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* References (library card drop) — 드래그 시 primary 강조 */}
        <div>
          <p className="label-meta text-foreground mb-1">{t("briefMatch.references")}</p>
          <div
            data-drop-brief-anchor=""
            onDragOver={(e) => allowFileDrop(e, "anchor")}
            onDragLeave={() => setDragOver(null)}
            onDrop={onRefFileDrop}
            className={cn(
              "min-h-[56px] border bg-input p-2 transition-colors",
              anchorHover || dragOver === "anchor" ? "border-primary/60" : "border-input",
            )}
            style={{
              borderRadius: 0,
              ...(anchorHover || dragOver === "anchor" ? { background: "rgba(249,66,58,0.06)" } : {}),
            }}
          >
            {anchorItems.length === 0 && localRefImages.length === 0 ? (
              <div className="flex h-10 items-center justify-center text-2xs text-muted-foreground/40">
                {t("briefMatch.anchorHint")}
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {anchorItems.map((it) => (
                  <div key={it.id} className="group relative h-[56px] w-[56px] border border-border" style={{ borderRadius: 0 }}>
                    {thumbOf(it) ? <img src={thumbOf(it)} alt="" className="h-full w-full object-cover" /> : null}
                    <button
                      type="button"
                      onClick={() => onAnchorIdsChange(anchorIds.filter((id) => id !== it.id))}
                      className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center bg-primary text-white opacity-0 transition-opacity group-hover:opacity-100"
                      style={{ borderRadius: 0 }}
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </div>
                ))}
                {localRefImages.map((img, i) => (
                  <div key={i} className="group relative h-[56px] w-[56px] border border-border" style={{ borderRadius: 0 }}>
                    <img src={img.preview} alt="" className="h-full w-full object-cover" />
                    <button
                      type="button"
                      onClick={() => setLocalRefImages((prev) => prev.filter((_, j) => j !== i))}
                      className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center bg-primary text-white opacity-0 transition-opacity group-hover:opacity-100"
                      style={{ borderRadius: 0 }}
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

      </div>

      {/* Footer — 단일 액션 (attach 모드에서는 LLM 분석 없이 저장하고 이동) */}
      <div className="shrink-0 border-t border-border px-3 py-2.5">
        <button
          type="button"
          onClick={isAttach ? handleAttach : handleAnalyze}
          disabled={analyzing}
          className="flex h-9 w-full items-center justify-center gap-2 bg-primary text-meta font-semibold text-primary-foreground disabled:opacity-50"
          style={{ borderRadius: 0 }}
        >
          {analyzing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
          {analyzing
            ? t("briefMatch.analyzing")
            : isAttach
            ? t("briefMatch.gate.confirm")
            : t("briefMatch.analyze")}
        </button>
      </div>
    </div>
  );
}
