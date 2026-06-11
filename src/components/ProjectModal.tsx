import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/lib/supabase";
import { Loader2, CalendarIcon } from "lucide-react";
import { format, parse } from "date-fns";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import type { Project, Folder as FolderType } from "@/pages/DashboardPage";
import { useT } from "@/lib/uiLanguage";

type VideoFormat = "vertical" | "horizontal" | "square";

interface StylePreset {
  id: string;
  name: string;
  description: string | null;
  thumbnail_url: string | null;
  is_default: boolean;
}

/* 포맷 카드의 *언어 무관* 메타. label/badge 는 컴포넌트 안에서 t() 로
   채워 KO 빌드(가로형/세로형/정사각) 와 EN 빌드(Horizontal/Vertical/Square)
   가 동일한 모양으로 갈라지도록 한다. ratio/badge 의 사회망 라벨(YouTube,
   TikTok, Instagram) 은 고유명사라 양쪽 다 영문 그대로 유지. */
const FORMAT_OPTIONS_META: { value: VideoFormat; ratio: string; w: number; h: number }[] = [
  { value: "horizontal", ratio: "16 : 9", w: 32, h: 20 },
  { value: "vertical", ratio: "9 : 16", w: 20, h: 32 },
  { value: "square", ratio: "1 : 1", w: 24, h: 24 },
];

import { KR, KR_BG } from "@/lib/brand";
const KR_BG2 = "rgba(249,66,58,0.06)";
const KR_BORDER = "rgba(249,66,58,0.28)";

interface ProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (projectId?: string) => void;
  editProject?: Project | null;
  /** 사이드바 폴더 목록 — 생성 시 폴더 선택 UI 표시 */
  folders?: FolderType[];
  /** 생성 시 기본 선택 폴더 ID */
  initialFolderId?: string | null;
}

export const ProjectModal = ({
  isOpen,
  onClose,
  onSuccess,
  editProject,
  folders = [],
  initialFolderId = null,
}: ProjectModalProps) => {
  const [loading, setLoading] = useState(false);
  const [stylePresets, setStylePresets] = useState<StylePreset[]>([]);
  // 마감일 달력 팝오버 — 날짜 선택 시 자동으로 닫기 위해 controlled 로 운영.
  const [deadlineOpen, setDeadlineOpen] = useState(false);
  const { toast } = useToast();
  const t = useT();

  /* 포맷 카드의 표시용 라벨/뱃지를 활성 언어로 채워서 메타와 합친다.
     useT() 의 결과는 함수 자체가 매 렌더 새로 만들어지지만 t() 의 출력은
     같은 키에서 안정적이라 inline 으로 매핑해도 무방. 카드 3장이라 cost
     자체도 무시 가능. */
  const formatOptions = FORMAT_OPTIONS_META.map((opt) => ({
    ...opt,
    label: t(`projectModal.format.${opt.value}`),
    badge: t(`projectModal.format.${opt.value}Badge`),
  }));

  const [formData, setFormData] = useState({
    title: "",
    client: "",
    deadline: "",
    status: "active",
    video_format: "horizontal" as VideoFormat,
    conti_style_id: "" as string,
    folder_id: null as string | null,
  });

  /* ── 스타일 프리셋 로드 ── */
  useEffect(() => {
    const fetchPresets = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const styleFilter = user ? `is_default.eq.true,user_id.eq.${user.id}` : "is_default.eq.true";
      const { data } = await supabase
        .from("style_presets")
        .select("id, name, description, thumbnail_url, is_default")
        .or(styleFilter)
        .order("is_default", { ascending: false })
        .order("created_at", { ascending: true });
      if (data) {
        setStylePresets(data as StylePreset[]);
        // 신규 프로젝트 기본 스타일 자동 선택 제거 — None으로 시작
      }
    };
    if (isOpen) fetchPresets();
  }, [isOpen]);

  /* ── 폼 초기화 ── */
  useEffect(() => {
    if (editProject) {
      setFormData({
        title: editProject.title,
        client: editProject.client || "",
        deadline: editProject.deadline || "",
        status: editProject.status,
        video_format: ((editProject as any).video_format as VideoFormat) || "horizontal",
        conti_style_id: (editProject as any).conti_style_id || "",
        folder_id: editProject.folder_id ?? null,
      });
    } else {
      setFormData({
        title: "",
        client: "",
        deadline: "",
        status: "active",
        video_format: "horizontal",
        conti_style_id: "", // 신규 프로젝트는 스타일 None
        folder_id: initialFolderId ?? null,
      });
    }
  }, [editProject, isOpen, initialFolderId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    const payload = {
      title: formData.title,
      client: formData.client || null,
      deadline: formData.deadline || null,
      status: formData.status,
      video_format: formData.video_format,
      conti_style_id: formData.conti_style_id || null,
      folder_id: formData.folder_id || null,
    };

    if (editProject) {
      const { error } = await supabase
        .from("projects")
        .update(payload as any)
        .eq("id", editProject.id);
      if (error) toast({ variant: "destructive", title: t("projectModal.toast.updateFailed"), description: error.message });
      else {
        onSuccess();
        onClose();
      }
    } else {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const { data, error } = await supabase
        .from("projects")
        .insert([{ ...payload, user_id: user?.id } as any])
        .select()
        .single();
      if (error) toast({ variant: "destructive", title: t("projectModal.toast.createFailed"), description: error.message });
      else {
        onClose();
        onSuccess(data?.id);
      }
    }
    setLoading(false);
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="md" className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editProject ? t("projectModal.editTitle") : t("projectModal.createTitle")}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5 mt-4">
          {/* 프로젝트명 */}
          <div className="space-y-2">
            <Label className="text-muted-foreground text-body">{t("projectModal.projectName")}</Label>
            <Input
              required
              placeholder={t("projectModal.projectNamePlaceholder")}
              className="bg-background border-border placeholder:text-muted-foreground/30 text-body"
              value={formData.title}
              onChange={(e) => setFormData({ ...formData, title: e.target.value })}
            />
          </div>

          {/* 요청 부서 */}
          <div className="space-y-2">
            <Label className="text-muted-foreground text-body">{t("projectModal.department")}</Label>
            <Input
              placeholder={t("projectModal.departmentPlaceholder")}
              className="bg-background border-border placeholder:text-muted-foreground/30 text-body"
              value={formData.client}
              onChange={(e) => setFormData({ ...formData, client: e.target.value })}
            />
          </div>

          {/* 마감일 + 상태 */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground text-body">{t("projectModal.deadline")}</Label>
              <Popover open={deadlineOpen} onOpenChange={setDeadlineOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "w-[200px] justify-start text-left font-normal bg-background border-border text-body",
                      !formData.deadline && "text-muted-foreground",
                    )}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {formData.deadline
                      ? format(parse(formData.deadline, "yyyy-MM-dd", new Date()), "MMM d, yyyy")
                      : t("projectModal.pickDate")}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={formData.deadline ? parse(formData.deadline, "yyyy-MM-dd", new Date()) : undefined}
                    onSelect={(d) => {
                      setFormData({ ...formData, deadline: d ? format(d, "yyyy-MM-dd") : "" });
                      // 날짜 클릭 시 팝오버 자동 종료. `d` 가 undefined(= 같은 날짜 재클릭으로 deselect)
                      // 인 경우엔 사용자가 의도적으로 비우는 동작이므로 이 경우에도 닫아도 UX 상 무리 없음.
                      setDeadlineOpen(false);
                    }}
                    initialFocus
                    className={cn("p-3 pointer-events-auto")}
                  />
                </PopoverContent>
              </Popover>
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground text-body">{t("projectModal.status")}</Label>
              <Select value={formData.status} onValueChange={(v) => setFormData({ ...formData, status: v })}>
                <SelectTrigger className="bg-background border-border text-body">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-card border-border">
                  <SelectItem value="active" className="text-body">
                    {t("projectModal.inProgress")}
                  </SelectItem>
                  <SelectItem value="completed" className="text-body">
                    {t("projectModal.completed")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* 폴더 선택 — 폴더가 1개 이상일 때만 표시 */}
          {folders.length > 0 && (
            <div className="space-y-2">
              <Label className="text-muted-foreground text-body">{t("projectModal.folder")}</Label>
              <Select
                value={formData.folder_id ?? "ungrouped"}
                onValueChange={(v) => setFormData({ ...formData, folder_id: v === "ungrouped" ? null : v })}
              >
                <SelectTrigger className="w-full bg-background border-border text-body">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-card border-border">
                  <SelectItem value="ungrouped" className="text-body">
                    {t("common.ungrouped")}
                  </SelectItem>
                  {folders.map((folder) => (
                    <SelectItem key={folder.id} value={folder.id} className="text-body">
                      {folder.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* 영상 포맷 */}
          <div className="space-y-2">
            <Label className="text-muted-foreground text-body">{t("projectModal.format")}</Label>
            <div className="grid grid-cols-3 gap-3">
              {formatOptions.map((opt) => {
                const selected = formData.video_format === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setFormData({ ...formData, video_format: opt.value })}
                    // `transition-all` 을 빼고 `focus:outline-none` 을 명시하는 이유:
                    //   1) transition-all 은 `outline` 까지 전환 대상에 넣어서
                    //      outline-style 이 none → solid 로 바뀌는 순간
                    //      브라우저 UA 기본 outline-color(Windows Chromium 에서는
                    //      흰색/라이트 블루) 가 1프레임 깜빡인다.
                    //   2) 클릭 직후 `:focus` 로 승격되며 UA 기본 포커스 링이
                    //      섞이는 것도 흰색 플래시로 보이므로 억제.
                    // 대신 outline 을 항상 `2px solid` 로 유지하고 색만
                    // transparent ↔ KR_BORDER 로 바꿔 즉시 빨강으로 전환되게 한다.
                    className="flex flex-col items-center justify-center p-3 rounded-none border cursor-pointer min-h-[110px] focus:outline-none focus-visible:outline-none"
                    style={{
                      borderColor: selected ? KR : "hsl(var(--border))",
                      background: selected ? KR_BG : "transparent",
                      outline: `2px solid ${selected ? KR_BORDER : "transparent"}`,
                      WebkitTapHighlightColor: "transparent",
                    }}
                  >
                    <div className="flex items-center justify-center h-10 mb-1.5">
                      <svg width={opt.w} height={opt.h} viewBox={`0 0 ${opt.w} ${opt.h}`}>
                        <rect
                          width={opt.w}
                          height={opt.h}
                          rx={0}
                          fill={selected ? KR : "hsl(var(--muted-foreground))"}
                        />
                      </svg>
                    </div>
                    <div className="flex flex-col items-center gap-0.5 mt-auto">
                      <span
                        className="text-body font-semibold"
                        style={{ color: selected ? KR : "hsl(var(--foreground))" }}
                      >
                        {opt.label}
                      </span>
                      <span className="text-meta" style={{ color: selected ? KR : "hsl(var(--muted-foreground))" }}>
                        {opt.ratio}
                      </span>
                      <span
                        className="text-caption"
                        style={{ color: selected ? "rgba(249,66,58,0.6)" : "hsl(var(--muted-foreground)/0.6)" }}
                      >
                        {opt.badge}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 액션 버튼 */}
          <div className="flex justify-end gap-3 mt-8">
            <Button type="button" variant="ghost" onClick={onClose} className="hover:bg-secondary text-body h-9">
              {t("common.cancel")}
            </Button>
            <Button disabled={loading} className="bg-primary hover:bg-primary/85 min-w-[120px] text-body h-9">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : editProject ? t("common.save") : t("common.create")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};
