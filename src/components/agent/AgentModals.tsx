import React, { useState } from "react";
import { supabase } from "@/lib/supabase";
import { useToast } from "@/hooks/use-toast";
import { Clock, Send, Loader2, RotateCcw, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { type Scene } from "./agentTypes";
import { type ProductionSpec } from "@/lib/productionSpec";
import { ModalTitle } from "@/components/common/ui-primitives";
import { useT } from "@/lib/uiLanguage";

/* ━━━━━ ConfirmScenesModal ━━━━━ */
export const ConfirmScenesModal = ({ pendingCount, existingCount, onClose, onConfirm }: {
  pendingCount: number; existingCount: number; onClose: () => void; onConfirm: (mode: "replace" | "append") => void;
}) => {
  const t = useT();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle asChild>
            <ModalTitle help={t("agent.createSceneHelp")}>
              {t("agent.createSceneCards")}
            </ModalTitle>
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t("agent.sceneCounts", { existing: existingCount, pending: pendingCount })}</p>
        <div className="space-y-2 mt-1">
          {[
            { mode: "replace" as const, Icon: RotateCcw, title: t("agent.replaceExisting", { count: pendingCount }), desc: t("agent.replaceDesc") },
            { mode: "append" as const, Icon: Plus, title: t("agent.append", { count: existingCount + pendingCount }), desc: t("agent.appendDesc") },
          ].map((opt) => (
            <button key={opt.mode} onClick={() => { onConfirm(opt.mode); onClose(); }} className="w-full flex items-start gap-3 p-3 rounded-none border border-border text-left transition-colors hover:border-primary/40 hover:bg-primary/5">
              <opt.Icon className="w-4 h-4 shrink-0 mt-0.5 text-muted-foreground" strokeWidth={1.75} />
              <div><div className="text-sm font-semibold text-foreground">{opt.title}</div><div className="text-caption text-muted-foreground mt-0.5">{opt.desc}</div></div>
            </button>
          ))}
        </div>
        <DialogFooter><Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/* ━━━━━ SendToContiModal ━━━━━ */
export const SendToContiModal = ({ scenes, productionSpec, projectId, onClose, onSent }: {
  scenes: Scene[]; productionSpec?: ProductionSpec | null; projectId: string; onClose: () => void; onSent: (id: string, name: string) => void | Promise<void>;
}) => {
  const { toast } = useToast();
  const t = useT();
  const [versionName, setVersionName] = useState("");
  const [isSending, setIsSending] = useState(false);
  const handleSend = async () => {
    if (!scenes.length) { toast({ title: t("agent.noScenesToSend"), variant: "destructive" }); return; }
    setIsSending(true);
    try {
      const { data: existing } = await supabase
        .from("scene_versions")
        .select("version_number,display_order")
        .eq("project_id", projectId);
      const rows = (existing ?? []) as Array<{ version_number?: number | null; display_order?: number | null }>;
      const num = rows.reduce((max, row) => Math.max(max, row.version_number ?? 0), 0) + 1;
      const displayOrder = rows.reduce((max, row) => Math.max(max, row.display_order ?? 0), 0) + 1;
      const name = versionName.trim() || `ver.${num}`;
      const { data: newVer, error } = await supabase.from("scene_versions").insert({ project_id: projectId, version_number: num, version_name: name, display_order: displayOrder, scenes: scenes as any, production_spec: (productionSpec ?? null) as any, is_active: true }).select().single();
      if (error || !newVer) throw new Error(error?.message ?? "Version creation failed");
      await supabase.from("projects").update({ active_version_id: newVer.id }).eq("id", projectId);
      toast({ title: t("agent.sentToConti", { name }) });
      await onSent(newVer.id, name);
      onClose();
    } catch (err: any) {
      toast({ title: t("agent.sendFailed"), description: err.message, variant: "destructive" });
    } finally { setIsSending(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle asChild>
            <ModalTitle icon={<Send className="w-4 h-4 text-primary" />}>{t("agent.sendToConti")}</ModalTitle>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-none border border-border bg-background p-3 space-y-1">
            <div className="text-xs text-muted-foreground mb-1.5">{t("agent.scenesToSend", { count: scenes.length })}</div>
            {scenes.map((s) => (
              <div key={s.id} className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground/50 w-5 shrink-0 text-right">#{s.scene_number}</span>
                <span className="text-foreground truncate">{s.title || `Shot ${s.scene_number}`}</span>
                {s.duration_sec && <span className="ml-auto text-caption text-muted-foreground/60 shrink-0 flex items-center gap-1"><Clock className="w-3 h-3" />{s.duration_sec}s</span>}
              </div>
            ))}
            {scenes.some((s) => s.duration_sec) && <div className="pt-1.5 mt-1.5 border-t border-border/50 text-caption text-muted-foreground/60 flex items-center gap-1"><Clock className="w-3 h-3" />{t("agent.total", { seconds: scenes.reduce((acc, s) => acc + (s.duration_sec ?? 0), 0) })}</div>}
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1.5 block">{t("agent.versionName")}</label>
            <Input value={versionName} onChange={(e) => setVersionName(e.target.value)} placeholder={t("agent.versionPlaceholder")} autoFocus onKeyDown={(e) => { if (e.key === "Enter") handleSend(); }} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
          <Button onClick={handleSend} disabled={isSending} className="gap-1.5">
            {isSending ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />{t("agent.sending")}</> : <><Send className="w-3.5 h-3.5" />{t("agent.sendToConti")}</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/* ━━━━━ LoadVersionModal ━━━━━ */
export const LoadVersionModal = ({ versions, onClose, onLoad }: {
  versions: { id: string; version_name: string | null; version_number: number; scenes: any[] }[];
  onClose: () => void; onLoad: (scenes: any[]) => Promise<void>;
}) => {
  const t = useT();
  const [loading, setLoading] = useState(false);
  if (!versions.length) return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle asChild>
            <ModalTitle>{t("agent.loadContiVersion")}</ModalTitle>
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground whitespace-pre-line">{t("agent.noContiVersions")}</p>
        <DialogFooter><Button variant="ghost" className="text-sm h-9" onClick={onClose}>{t("common.close")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle asChild>
            <ModalTitle
              icon={<RotateCcw className="w-4 h-4 text-primary" />}
              help={t("agent.loadVersionHelp")}
            >
              {t("agent.loadContiVersion")}
            </ModalTitle>
          </DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground -mt-1">{t("agent.selectVersion")}</p>
        <div className="space-y-2 max-h-[50vh] overflow-y-auto">
          {versions.map((v, idx) => (
            <button key={v.id} disabled={loading} onClick={async () => { setLoading(true); await onLoad(v.scenes.filter((s: any) => s.is_transition !== true && !s.transition_type)); setLoading(false); onClose(); }} className="w-full flex items-center gap-3 p-3 rounded-none border border-border text-left transition-colors hover:border-primary/40 hover:bg-primary/5 disabled:opacity-50">
              <span className="text-caption font-bold px-2 py-0.5 rounded-none bg-primary text-primary-foreground shrink-0">{`ver.${idx + 1}`}</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-foreground truncate">{v.version_name || `v${v.version_number}`}</div>
                <div className="text-caption text-muted-foreground mt-0.5">{v.scenes.length} scenes{v.scenes.some((s: any) => s.duration_sec) && <> · {t("agent.total", { seconds: v.scenes.reduce((a: number, s: any) => a + (s.duration_sec ?? 0), 0) })}</>}</div>
              </div>
              <div className="flex flex-col gap-0.5 shrink-0 max-w-[120px]">
                {v.scenes.slice(0, 3).map((s: any, i: number) => <span key={i} className="text-2xs text-muted-foreground/60 truncate">#{String(i + 1).padStart(2, "0")} {s.title || `Shot ${i + 1}`}</span>)}
                {v.scenes.length > 3 && <span className="text-2xs text-muted-foreground/40">{t("agent.more", { count: v.scenes.length - 3 })}</span>}
              </div>
              {loading ? <Loader2 className="w-4 h-4 animate-spin shrink-0 ml-1 text-primary" /> : <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="hsl(var(--muted-foreground))" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="shrink-0 ml-1"><path d="M9 18l6-6-6-6" /></svg>}
            </button>
          ))}
        </div>
        <DialogFooter><Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
