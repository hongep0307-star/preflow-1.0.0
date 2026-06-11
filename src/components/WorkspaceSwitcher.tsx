/**
 * WorkspaceSwitcher — multi-workspace switcher.
 *
 * Phase 2 rewrite: 더 이상 Project / Library 두 개의 모드 토글이 아니다.
 * 사용자가 등록한 N 개의 워크스페이스(default 2 개 + 사용자 정의) 를
 * popover 안에서 그룹별로 보여 주고, 각 행을 클릭하면 backend 의
 * `/workspace/activate` 가 호출되어 실제 SQLite DB 가 닫혔다 새로 열린다.
 * 활성 전환 후엔 `window.location.href` 로 해당 kind 의 entry 페이지
 * (Project → /dashboard, Library → /library) 로 이동하며 페이지가 통째로
 * reload 된다 — React state / 캐시는 새 DB 와 sync 되지 않으므로 안전한
 * 길은 reload 뿐이다.
 *
 * Variants
 * --------
 *   "full"    — Sidebar bottom box. 활성 워크스페이스의 kind 아이콘 + 이름
 *               + 카운트 서브타이틀. 클릭하면 popover 가 위로 펼쳐진다.
 *   "compact" — 100 px Project rail. 아이콘 + PROJ/LIB 단축 라벨.
 *   "icon"    — 모바일 bottom-bar. 36 px 단일 hit target.
 *
 * Conflict 처리
 * -------------
 * 다른 PC 가 이미 워크스페이스 폴더를 점유 중이면 backend 가
 * `{ ok:false, locked:true, lock:{...} }` 로 응답한다. 이 경우 사용자에게
 * 락 정보를 보여 주고 [Force open] 옵션을 제공한다.
 */

import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ChevronUp, MoreHorizontal, Plus } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LibraryMark, ProjectMark } from "@/components/common/BrandLogo";
import { useT } from "@/lib/uiLanguage";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  activateWorkspace,
  createWorkspace,
  deleteWorkspace,
  disconnectWorkspace,
  ensureWorkspacesLoaded,
  getCachedActive,
  getCachedConflictCopies,
  getCachedCountsFor,
  getCachedLastActiveByKind,
  getCachedWorkspaces,
  loadExistingWorkspace,
  refreshWorkspaces,
  renameWorkspace,
  showWorkspaceInExplorer,
  subscribeWorkspaces,
} from "@/lib/workspaceClient";
import { useHideDefaultWorkspaces } from "@/lib/workspacePreferences";
import type {
  WorkspaceKind,
  WorkspaceLockInfo,
  WorkspaceMeta,
} from "@shared/workspace";

type Variant = "full" | "compact" | "icon";

interface Props {
  variant?: Variant;
}

const shouldShow = (pathname: string) => pathname !== "/settings";

// 충돌 사본 경고는 세션당 한 번만 — WorkspaceSwitcher 가 여러 variant 로
// 동시에 마운트돼도(full/compact/icon) 토스트가 중복되지 않도록 모듈 레벨
// 가드. 페이지 hard reload(활성 전환 시) 후엔 모듈이 새로 평가되므로
// 자연스럽게 다시 1회 평가된다.
let conflictWarningShown = false;

function useWorkspacesCache() {
  const [, force] = useState(0);
  useEffect(() => {
    void ensureWorkspacesLoaded();
    return subscribeWorkspaces(() => force((n) => n + 1));
  }, []);
  return {
    workspaces: getCachedWorkspaces(),
    active: getCachedActive(),
  };
}

function workspaceSubtitle(t: ReturnType<typeof useT>, ws: WorkspaceMeta): string {
  const counts = getCachedCountsFor(ws.id);
  const n = ws.kind === "project" ? counts?.projectCount : counts?.itemCount;
  if (n === null || n === undefined) return "—";
  return ws.kind === "project"
    ? t("workspace.projects.subtitle", { n })
    : t("workspace.library.subtitle", { n });
}

/** Default 워크스페이스의 path 는 사용자에게 의미 없는 cryptic userData
 *  경로(`C:\Users\…\Roaming\preflow`) 라 "App data folder" placeholder 로
 *  치환한다 — custom 워크스페이스(OneDrive 등) 와 시각적으로 즉시 구분되고,
 *  popover 너비 안에서 잘 안 잘림. 풀 path 는 행의 title 툴팁으로 별도
 *  노출되므로 정보 손실 없음. */
function formatWorkspacePath(t: ReturnType<typeof useT>, ws: WorkspaceMeta): string {
  return ws.isDefault ? t("workspace.appDataFolder") : ws.path;
}

function targetRouteForKind(kind: WorkspaceKind, _currentLocation: { pathname: string; search: string; hash: string }): string {
  // 단순화: 라이브러리 스위치는 항상 "전체" 라이브러리 첫 페이지로, 프로젝트
  // 스위치는 항상 대시보드로. (이전의 returnTo 왕복 복귀는 제거 — 즉시 이동은
  // 토스트의 '이동' 액션으로만.)
  if (kind === "library") return "/library";
  return "/dashboard";
}

interface WorkspaceBadgeProps {
  kind: WorkspaceKind;
  size?: "sm" | "md";
}

function WorkspaceBadge({ kind, size = "md" }: WorkspaceBadgeProps) {
  // box 크기는 유지하되 안의 SVG 마크는 박스 대비 비율을 ~0.87 까지 키운다
  // (옛 0.71/0.75 → 박스 대비 너무 작아 보여 라인이 끊겨 보이던 문제).
  // 박스 자체는 grid 정렬상의 hit-target 이므로 그대로 두고, 시각 무게만
  // 마크 쪽으로 옮긴다.
  const dim = size === "sm" ? "h-7 w-7" : "h-8 w-8";
  const inner = size === "sm" ? "h-6 w-6" : "h-7 w-7";
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center",
        dim,
        kind === "library" ? "bg-neutral-800" : "bg-primary",
      )}
      style={{ borderRadius: 0 }}
    >
      {kind === "library" ? (
        <LibraryMark withoutFrame className={cn(inner, "text-white")} />
      ) : (
        <ProjectMark withoutFrame className={cn(inner, "text-white")} />
      )}
    </span>
  );
}

interface AddWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultKind?: WorkspaceKind;
}

function AddWorkspaceDialog({ open, onOpenChange, defaultKind = "project" }: AddWorkspaceDialogProps) {
  const t = useT();
  const location = useLocation();
  const [kind, setKind] = useState<WorkspaceKind>(defaultKind);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setKind(defaultKind);
      setName("");
      setError(null);
    }
  }, [open, defaultKind]);

  /** 생성/로드 성공 직후 새 워크스페이스로 자동 전환. activateWorkspace 가
   *  내부에서 `window.location.href = nextUrl` 로 hard navigation 을 수행해
   *  페이지가 통째로 리마운트되므로, 사용자 시점에선 "워크스페이스 만들기"
   *  버튼 클릭 한 번으로 새 빈 워크스페이스 화면까지 자연스럽게 도달.
   *  락 충돌은 새로 만든 워크스페이스에선 실질적으로 발생하지 않으나,
   *  방어 차원으로 error 상태로 표시한다. */
  const activateNewlyCreated = async (ws: WorkspaceMeta): Promise<void> => {
    const target = targetRouteForKind(ws.kind, location);
    const result = await activateWorkspace(ws.id, false, target);
    if (result.locked) {
      setError(t("workspace.lock.stillLocked"));
    }
  };

  const handleCreate = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await createWorkspace({ kind, name: name.trim() || (kind === "project" ? "New Projects" : "New Library") });
      if (result.canceled) return;
      onOpenChange(false);
      if (result.workspace) {
        await activateNewlyCreated(result.workspace);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleLoadExisting = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await loadExistingWorkspace({ hint: { kind, name: name.trim() || undefined } });
      if (result.canceled) return;
      onOpenChange(false);
      if (result.workspace) {
        await activateNewlyCreated(result.workspace);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" className="gap-5">
        <DialogHeader className="space-y-1.5">
          <DialogTitle>{t("workspace.add.title")}</DialogTitle>
          <DialogDescription className="leading-relaxed">
            {t("workspace.add.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <div className="text-caption font-semibold text-muted-foreground">
              {t("workspace.add.typeLabel")}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(["project", "library"] as const).map((k) => {
                const selected = kind === k;
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKind(k)}
                    className={cn(
                      "flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring",
                      selected
                        ? "bg-surface-panel"
                        : "bg-transparent hover:bg-surface-panel/60",
                    )}
                    style={{
                      // Square tile (matches dialog's sm:rounded-none) with a
                      // single 1px border that switches to primary on select.
                      // 의도: focus 링 / 선택 마커는 굵기 그대로 유지하되, 색만
                      // 강조. bg-primary/10 같은 fill 은 빼서 input 의 focus ring
                      // 과 시각적 무게를 충돌시키지 않는다.
                      borderRadius: 0,
                      border: "1px solid",
                      borderColor: selected ? "hsl(var(--primary))" : "hsl(var(--border-subtle))",
                    }}
                  >
                    <WorkspaceBadge kind={k} size="sm" />
                    <span className="text-body font-medium text-foreground">
                      {k === "project" ? t("workspace.projects.label") : t("workspace.library.label")}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-caption font-semibold text-muted-foreground">
              {t("workspace.add.nameLabel")}
            </div>
            <Input
              placeholder={
                kind === "project"
                  ? t("workspace.add.namePlaceholder.project")
                  : t("workspace.add.namePlaceholder.library")
              }
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              className="h-9 text-body focus-visible:ring-1 focus-visible:ring-offset-0"
            />
          </div>

          {error && (
            <div className="text-meta text-destructive">{error}</div>
          )}
        </div>

        <DialogFooter className="flex flex-row items-center justify-between gap-2 sm:justify-between">
          <button
            type="button"
            onClick={handleLoadExisting}
            disabled={busy}
            className="text-meta text-muted-foreground hover:text-foreground underline-offset-4 hover:underline disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {t("workspace.add.openExisting")}
          </button>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" onClick={handleCreate} disabled={busy}>
              {t("workspace.add.create")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface RenameDialogProps {
  workspace: WorkspaceMeta | null;
  onClose: () => void;
}

function RenameDialog({ workspace, onClose }: RenameDialogProps) {
  const t = useT();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (workspace) {
      setName(workspace.name);
      setError(null);
    }
  }, [workspace]);

  const submit = async () => {
    if (!workspace) return;
    setBusy(true);
    try {
      await renameWorkspace(workspace.id, name.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!workspace} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md" className="gap-5">
        <DialogHeader className="space-y-1.5">
          <DialogTitle>{t("workspace.rename.title")}</DialogTitle>
        </DialogHeader>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          autoFocus
          className="h-9 text-body focus-visible:ring-1 focus-visible:ring-offset-0"
        />
        {error && <div className="text-meta text-destructive">{error}</div>}
        <DialogFooter className="flex flex-row items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" onClick={submit} disabled={busy || !name.trim()}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface RemoveDialogProps {
  workspace: WorkspaceMeta | null;
  mode: "disconnect" | "delete" | null;
  onClose: () => void;
}

function RemoveDialog({ workspace, mode, onClose }: RemoveDialogProps) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (workspace) setError(null);
  }, [workspace, mode]);

  const submit = async () => {
    if (!workspace || !mode) return;
    setBusy(true);
    try {
      if (mode === "delete") {
        const result = await deleteWorkspace(workspace.id);
        if (result.error) {
          setError(t("workspace.remove.folderDeleteFailed", { reason: result.error }));
        }
      } else {
        await disconnectWorkspace(workspace.id);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!workspace && !!mode} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md" className="gap-5">
        <DialogHeader className="space-y-1.5">
          <DialogTitle>
            {mode === "delete"
              ? t("workspace.remove.deleteTitle")
              : t("workspace.remove.disconnectTitle")}
          </DialogTitle>
          <DialogDescription className="leading-relaxed">
            {mode === "delete"
              ? t("workspace.remove.deleteDescription")
              : t("workspace.remove.disconnectDescription")}
          </DialogDescription>
        </DialogHeader>
        {workspace && (
          <div
            className="border border-border-subtle bg-surface-panel p-3 space-y-1"
            style={{ borderRadius: 0 }}
          >
            <div className="text-body font-semibold">{workspace.name}</div>
            <div className="text-caption text-muted-foreground break-all">{workspace.path}</div>
          </div>
        )}
        {error && <div className="text-meta text-destructive">{error}</div>}
        <DialogFooter className="flex flex-row items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button
            variant={mode === "delete" ? "destructive" : "default"}
            size="sm"
            onClick={submit}
            disabled={busy}
          >
            {mode === "delete"
              ? t("workspace.remove.deleteAction")
              : t("workspace.remove.disconnectAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface LockConflictDialogProps {
  state: { lock: WorkspaceLockInfo; targetId: string } | null;
  onResolved: () => void;
}

function LockConflictDialog({ state, onResolved }: LockConflictDialogProps) {
  const t = useT();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const force = async () => {
    if (!state) return;
    setBusy(true);
    setError(null);
    try {
      // force activate 도 일반 activate 와 동일한 라우트 정합 규칙 적용 —
      // 대상 ws 의 kind 에 맞는 entry route 로 이동시켜, 락 해제 직후의
      // 화면이 새 DB 의 kind 와 어긋나지 않게 한다.
      const targetWs = getCachedWorkspaces().find((w) => w.id === state.targetId);
      const nextUrl = targetWs ? targetRouteForKind(targetWs.kind, location) : undefined;
      const result = await activateWorkspace(state.targetId, true, nextUrl);
      if (result.locked) setError(t("workspace.lock.stillLocked"));
      else onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && onResolved()}>
      <DialogContent size="md" className="gap-5">
        <DialogHeader className="space-y-1.5">
          <DialogTitle>{t("workspace.lock.title")}</DialogTitle>
          <DialogDescription className="leading-relaxed">
            {t("workspace.lock.description")}
          </DialogDescription>
        </DialogHeader>
        {state && (
          <div
            className="border border-border-subtle bg-surface-panel p-3 space-y-1"
            style={{ borderRadius: 0 }}
          >
            <div className="text-body font-semibold">{state.lock.prettyLabel}</div>
            <div className="text-caption text-muted-foreground">
              {t("workspace.lock.since", { when: state.lock.acquiredAt })}
            </div>
            {state.lock.renewedAt && state.lock.renewedAt !== state.lock.acquiredAt && (
              <div className="text-caption text-muted-foreground">
                {t("workspace.lock.lastActive", { when: state.lock.renewedAt })}
              </div>
            )}
            <div className="text-caption text-muted-foreground">
              {t("workspace.lock.pidHost", { pid: state.lock.pid, host: state.lock.hostname })}
            </div>
          </div>
        )}
        {error && <div className="text-meta text-destructive">{error}</div>}
        <DialogFooter className="flex flex-row items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onResolved} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="destructive" size="sm" onClick={force} disabled={busy}>
            {t("workspace.lock.forceOpen")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export const WorkspaceSwitcher = ({ variant = "full" }: Props) => {
  const location = useLocation();
  const navigate = useNavigate();
  const t = useT();
  const { toast } = useToast();
  const { workspaces, active } = useWorkspacesCache();
  const [open, setOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addDefaultKind, setAddDefaultKind] = useState<WorkspaceKind>("project");
  const [renameTarget, setRenameTarget] = useState<WorkspaceMeta | null>(null);
  const [removeTarget, setRemoveTarget] = useState<{ ws: WorkspaceMeta; mode: "disconnect" | "delete" } | null>(null);
  const [lockConflict, setLockConflict] = useState<{ lock: WorkspaceLockInfo; targetId: string } | null>(null);
  // Settings 의 "Hide default workspaces" 토글. 모든 훅 호출은 early return
  // (`if (!shouldShow(...))`) 보다 *위* 에 와야 React 의 훅 호출 순서 invariant
  // 가 깨지지 않는다 — 과거에는 이 호출이 early return 뒤 line ~611 에 있어
  // /settings ↔ 그 외 라우트를 오갈 때 호출 횟수가 달라져 즉시 throw 가 가능
  // 했다. 사용은 아래 popover 렌더 분기에서 그대로 한다.
  const hideDefault = useHideDefaultWorkspaces();

  // OneDrive 충돌 사본이 활성 워크스페이스에 있으면 세션당 1회 경고. 워크
  // 스페이스 캐시가 비동기로 채워지므로 구독으로 들어온 후 한 번 검사한다.
  useEffect(() => {
    const check = () => {
      if (conflictWarningShown) return;
      const files = getCachedConflictCopies();
      if (files.length === 0) return;
      conflictWarningShown = true;
      const shown = files.slice(0, 3).join(", ") + (files.length > 3 ? "…" : "");
      toast({
        variant: "destructive",
        duration: 10_000,
        title: t("workspace.conflict.title"),
        description: t("workspace.conflict.description", { files: shown }),
      });
    };
    check();
    return subscribeWorkspaces(check);
  }, [toast, t]);

  // 활성 컨텍스트와 현재 라우트 정합성 — /library 라우트면 library 컨텍스트로,
  // 그 외엔 project 컨텍스트로 본다. 이 값은 trigger 의 표시 kind 를 결정.
  const onLibraryRoute = location.pathname === "/library";
  const triggerKind: WorkspaceKind = onLibraryRoute ? "library" : "project";
  // trigger 표시는 활성 워크스페이스 중 현재 라우트 kind 와 같은 것을 우선
  // 노출 — default 워크스페이스의 양면성을 자연스럽게 처리.
  const triggerWs =
    workspaces.find((w) => w.kind === triggerKind && active && w.path === active.path) ??
    active ??
    workspaces[0] ??
    null;

  if (!shouldShow(location.pathname)) return null;

  const handleActivate = async (ws: WorkspaceMeta) => {
    setOpen(false);
    // 같은 kind & 같은 path 면 단순 라우트 이동(reload 없음).
    const samePath = active && ws.path === active.path;
    const sameKindAsRoute = ws.kind === triggerKind;
    if (samePath && sameKindAsRoute) {
      // 동일 워크스페이스 클릭 — no-op
      return;
    }
    if (samePath && !sameKindAsRoute) {
      // default ↔ default 형제 전환: DB 동작 없이 라우트만.
      const target = targetRouteForKind(ws.kind, location);
      navigate(target);
      return;
    }
    // 다른 path — 실제 활성 전환. target 라우트를 미리 계산해 client 에
    // 넘긴다. 활성된 워크스페이스가 Library 면 /library 로, Project 면
    // /dashboard(혹은 returnTo) 로 이동해 hard reload — 라우트 kind 와 DB
    // kind 가 어긋난 상태(예: rrr 활성 + /dashboard 표시)로 화면이 남는
    // 것을 차단.
    try {
      const target = targetRouteForKind(ws.kind, location);
      const result = await activateWorkspace(ws.id, false, target);
      if (result.locked && result.lock) {
        setLockConflict({ lock: result.lock, targetId: ws.id });
      }
      // result.ok 이면 activateWorkspace 안에서 이미 location.href 로 이동.
      // 도달하지 못한다.
    } catch (err) {
      console.error("[workspace-switcher] activate failed:", err);
    }
  };

  const handleLockResolved = () => {
    setLockConflict(null);
    void refreshWorkspaces();
  };

  // hideDefault 는 위쪽 훅 블록에서 이미 호출했다. 켜져 있어도 *현재 default
  // 폴더 안에서 작업 중*이면 활성/형제 default 두 개 모두 보여 사용자가 그
  // 시야에서 빠져나갈 길을 잃지 않게 한다 — registry 의 active 가 한 형제만
  // 가리키므로 path 비교로 "사용자가 default 폴더 안에 있다"는 사실을 판정.
  const activeIsInDefaultPath = !!active?.isDefault;
  const showDefaults = !hideDefault || activeIsInDefaultPath;
  const projectsList = workspaces
    .filter((w) => w.kind === "project")
    .filter((w) => showDefaults || !w.isDefault);
  const libraryList = workspaces
    .filter((w) => w.kind === "library")
    .filter((w) => showDefaults || !w.isDefault);

  const renderRow = (ws: WorkspaceMeta) => {
    // 활성 표시는 "현재 사용자가 보고 있는 화면" 기준 — 라우트 kind + 같은
    // 폴더 path 인 워크스페이스에 빨간 점이 붙는다. registry 의 `active.id`
    // 는 마지막으로 activate 된 ID 한 개뿐이라, default-projects 와
    // default-library 처럼 같은 path 를 공유하는 형제가 있으면 그 중 한쪽만
    // 활성으로 잡혀 라우트 전환 시 점이 안 따라오는 버그가 났음. 라우트
    // kind 와 path 를 묶어 판단하면 default 짝과 custom 짝 모두 자연스럽게
    // 풀린다.
    const isActive =
      !!active && ws.path === active.path && ws.kind === triggerKind;
    return (
      <div
        key={ws.id}
        className={cn(
          "group flex items-center gap-2.5 px-2 py-2 transition-colors",
          isActive ? "bg-surface-panel" : "hover:bg-surface-panel",
        )}
        style={{ borderRadius: 4 }}
        title={ws.path}
      >
        <button
          type="button"
          onClick={() => void handleActivate(ws)}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          <WorkspaceBadge kind={ws.kind} size="md" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-body font-semibold text-foreground">
              {ws.name}
            </span>
            {/* count · path 한 줄. path 는 muted-foreground/60 으로 한 톤 더
                약하게 — 카운트가 메인 정보, path 는 보조 식별자. 길면 우측
                truncate, 행 전체 hover 의 title 로 풀 path 확인. */}
            <span className="truncate text-meta text-text-secondary">
              {workspaceSubtitle(t, ws)}
              <span className="text-muted-foreground"> · {formatWorkspacePath(t, ws)}</span>
            </span>
          </div>
          {isActive && (
            <span className="h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden />
          )}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              onClick={(e) => e.stopPropagation()}
              aria-label={t("workspace.actions")}
              className="flex h-7 w-7 shrink-0 items-center justify-center text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-background hover:text-foreground transition-opacity"
              style={{ borderRadius: 4 }}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          {/* popover 가 위로 펼쳐진 상태(side="top")라 dropdown 이 기본
              side="bottom" 으로 열리면 popover 본문과 거의 완전히 포개져
              "두 패널이 중첩된" 인상을 줬다. side="right" + align="start" 로
              popover 의 오른쪽 옆으로 빠지게 해, 워크스페이스 행 → 메뉴의
              계층이 시각적으로 분리되게 한다. collisionPadding 으로 화면
              우측 끝과 살짝 여유를 둬 우측 모니터 가장자리에 잘리지 않게
              하고, 공간이 정말 부족하면 Radix 가 자동으로 좌측으로 flip 해
              fallback. */}
          <DropdownMenuContent
            side="right"
            align="start"
            sideOffset={8}
            collisionPadding={8}
            className="min-w-56"
          >
            {/* Default 워크스페이스도 이름 변경은 허용 — registry 의 name 필드만
                바꾸고 path/kind/isDefault 는 손대지 않으므로 "마지막 보루"
                책임에는 영향 없음. 사용자가 "Default Projects" 같은 비인격적
                라벨을 자기 워크플로 용어로 바꿀 수 있게 한다. disconnect /
                delete 는 여전히 default 에서 막혀 안전망 역할 보존. */}
            <DropdownMenuItem
              onClick={() => {
                setOpen(false);
                setRenameTarget(ws);
              }}
            >
              {t("workspace.menu.rename")}
            </DropdownMenuItem>
            {/* Show in Explorer 는 default 포함 모든 워크스페이스에서 활성.
                App data folder 도 OS 탐색기로 열 수 있어야 정합. */}
            <DropdownMenuItem
              onClick={() => {
                setOpen(false);
                void showWorkspaceInExplorer(ws.id);
              }}
            >
              {t("workspace.menu.showInExplorer")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                setOpen(false);
                setRemoveTarget({ ws, mode: "disconnect" });
              }}
              disabled={ws.isDefault || isActive}
            >
              {t("workspace.menu.disconnect")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                setOpen(false);
                setRemoveTarget({ ws, mode: "delete" });
              }}
              disabled={ws.isDefault || isActive}
              className="text-destructive focus:text-destructive"
            >
              {t("workspace.menu.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  };

  const triggerName =
    triggerWs?.name ??
    (triggerKind === "project"
      ? t("workspace.defaultProjects")
      : t("workspace.defaultLibrary"));
  const triggerSubtitle = triggerWs ? workspaceSubtitle(t, triggerWs) : "—";
  // 배지 색/아이콘은 "지금 라벨로 보여주는 워크스페이스" 의 실제 kind 를
  // 따라가야 한다. triggerKind 는 URL 기반이라, 라우트와 활성 워크스페이스
  // kind 가 어긋나는 일시적 상태(예: /dashboard 에 머문 채 Library
  // 워크스페이스를 활성화한 직후) 에서는 이름과 배지의 출처가 갈려 한쪽이
  // 거짓말을 한다. triggerWs.kind 를 1순위로 두어 두 표시가 항상 같은
  // 워크스페이스를 가리키게 한다 — 라우트 정합은 redirect 가 별도 보장.
  const badgeKind: WorkspaceKind = triggerWs?.kind ?? triggerKind;

  // 직접 전환(아이콘 클릭) — 반대 kind 의 *최근 사용 워크스페이스* 로 점프.
  //
  // 결정 순서:
  //   1) registry 의 lastActive[other] — 직전 세션이든 이번 세션이든 사용자가
  //      마지막으로 활성화했던 그 워크스페이스. setActiveId 안에서 kind 슬롯
  //      이 함께 갱신되므로 자연스럽게 "직전에 보던 곳" 으로 돌아간다.
  //   2) 1) 의 ID 가 캐시에서 사라졌거나 비어 있으면 (= 첫 부팅 + activate
  //      이력 없음 + 시드도 누락) 반대 kind 의 isDefault 워크스페이스.
  //      bootstrap 시 lastActive 가 default 두 개로 시드되므로 정상 흐름에선
  //      이 폴백까지 안 떨어지지만, 손상/구버전 registry 호환용 안전망.
  //   3) 그것도 없으면 반대 kind 의 아무 워크스페이스(첫 번째). 최후의 보루.
  const switchWorkspaceQuick = () => {
    const other: WorkspaceKind = triggerKind === "project" ? "library" : "project";
    const lastActive = getCachedLastActiveByKind(other);
    const target =
      lastActive ??
      workspaces.find((w) => w.kind === other && w.isDefault) ??
      workspaces.find((w) => w.kind === other) ??
      null;
    if (target) void handleActivate(target);
  };

  // Compact rail (100 px Project rail 의 좌하단) — 이전엔 아래쪽에 "PROJ" /
  // "LIB" 단축 텍스트로 popover 를 열었는데 사용자 인지가 약해 "스위치 버튼"
  // 으로 안 보였다. badgeKind 정보는 위쪽 아이콘에 이미 동일하게 들어가 있어
  // 사실상 중복이었고, full variant 와 마찬가지로 ChevronUp 한 글리프로
  // "여기 펴진다" 를 명시적으로 알려 주는 편이 affordance 가 훨씬 강하다.
  // 아이콘의 quick-switch(반대 kind 로 점프) 동작은 그대로 유지 — 두 버튼이
  // 시각적으로 한 묶음으로 보이지만 역할은 분리되어 있다.
  const renderCompactTrigger = () => (
    <div className="flex w-full flex-col items-stretch border-t border-border-subtle">
      <button
        type="button"
        onClick={switchWorkspaceQuick}
        aria-label={t("workspace.switchAria")}
        title={t("workspace.switchAria")}
        className="flex w-full items-center justify-center pt-2 pb-1 hover:bg-surface-panel transition-colors"
      >
        <WorkspaceBadge kind={badgeKind} size="sm" />
      </button>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("workspace.switchTitle")}
          title={t("workspace.switchTitle")}
          className="group/exp flex w-full items-center justify-center pb-1.5 pt-0.5 hover:bg-surface-panel transition-colors"
        >
          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground transition-colors group-hover/exp:text-foreground" />
        </button>
      </PopoverTrigger>
    </div>
  );

  const renderFullTrigger = () => (
    <div className="flex w-full items-stretch" style={{ borderRadius: 4 }}>
      <button
        type="button"
        onClick={switchWorkspaceQuick}
        aria-label={t("workspace.switchAria")}
        title={t("workspace.switchAria")}
        className="flex shrink-0 items-center justify-center pl-2.5 pr-1.5 py-2 hover:bg-surface-panel transition-colors"
        style={{ borderTopLeftRadius: 4, borderBottomLeftRadius: 4 }}
      >
        <WorkspaceBadge kind={badgeKind} size="sm" />
      </button>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("workspace.switchTitle")}
          title={t("workspace.switchTitle")}
          className="flex min-w-0 flex-1 items-center gap-2.5 pr-2.5 py-2 hover:bg-surface-panel transition-colors"
          style={{ borderTopRightRadius: 4, borderBottomRightRadius: 4 }}
        >
          <div className="flex min-w-0 flex-1 flex-col items-start">
            <span className="w-full truncate text-left text-body font-semibold text-foreground">
              {triggerName}
            </span>
            <span className="w-full truncate text-left text-caption text-muted-foreground">
              {triggerSubtitle}
            </span>
          </div>
          <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
    </div>
  );

  // Icon variant: 한 번 탭으로 default 형제 전환. (모바일 bottom-bar 만)
  if (variant === "icon") {
    return (
      <button
        type="button"
        onClick={switchWorkspaceQuick}
        aria-label={t("workspace.switchAria")}
        title={t("workspace.switchAria")}
        className="flex h-9 w-9 items-center justify-center hover:bg-surface-panel transition-colors"
      >
        <WorkspaceBadge kind={badgeKind} size="sm" />
      </button>
    );
  }

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // popover 가 *열릴 때* 카운트를 silent 하게 한 번 새로고침. import /
          // 외부 mutation 으로 cache 의 counts 가 stale 한 경우의 안전망이며,
          // fire-and-forget 이라 popover open 애니메이션을 막지 않는다. 평소엔
          // <200ms 안에 응답이 와서 사용자가 멈춤을 느끼기 전에 숫자가 swap.
          if (next) {
            void refreshWorkspaces().catch(() => {
              /* 새로고침 실패해도 이전 cache 값이 그대로 보여 흐름은 정상. */
            });
          }
        }}
      >
        {variant === "compact" ? renderCompactTrigger() : renderFullTrigger()}
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-80 border-border-subtle bg-popover p-1.5"
        >
          <div className="px-2 pb-1.5 pt-1 text-meta font-semibold text-muted-foreground">
            {t("workspace.switchTitle")}
          </div>

          {projectsList.length > 0 && (
            <>
              <div className="px-2 pt-2 pb-1 text-caption font-semibold text-muted-foreground/70">
                {t("workspace.projects.label")}
              </div>
              {projectsList.map(renderRow)}
            </>
          )}

          {libraryList.length > 0 && (
            <>
              <div className="px-2 pt-2 pb-1 text-caption font-semibold text-muted-foreground/70">
                {t("workspace.library.label")}
              </div>
              {libraryList.map(renderRow)}
            </>
          )}

          <div className="my-1.5 h-px bg-border-subtle" />

          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setAddDefaultKind(triggerKind);
              setAddOpen(true);
            }}
            className="flex w-full items-center gap-2.5 px-2 py-2 text-left transition-colors hover:bg-surface-panel"
            style={{ borderRadius: 4 }}
          >
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center border border-dashed border-border-subtle text-muted-foreground"
              style={{ borderRadius: 0 }}
            >
              <Plus className="h-4 w-4" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-body font-semibold text-foreground">
                {t("workspace.add")}
              </span>
              <span className="truncate text-meta text-text-secondary">
                {t("workspace.addSubtitle")}
              </span>
            </div>
          </button>
        </PopoverContent>
      </Popover>

      <AddWorkspaceDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        defaultKind={addDefaultKind}
      />
      <RenameDialog workspace={renameTarget} onClose={() => setRenameTarget(null)} />
      <RemoveDialog
        workspace={removeTarget?.ws ?? null}
        mode={removeTarget?.mode ?? null}
        onClose={() => setRemoveTarget(null)}
      />
      <LockConflictDialog state={lockConflict} onResolved={handleLockResolved} />
    </>
  );
};
