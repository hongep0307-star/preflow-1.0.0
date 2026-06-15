import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Folder, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import { vt, type ViewerLang } from "./i18n";
import type { ViewerFolderNode } from "./types";

/* 좌측 폴더 트리. 입력은 평탄한 ViewerFolderNode[] (전체 경로 + 직접 count).
 * 여기서 경로를 중첩 트리로 재구성해 펼침/접힘과 함께 렌더한다.
 * data.folders 가 있으면 그걸, 없으면 App 이 foldersFromTags 폴백을 넘긴다. */

/* 브리프 매치 폴더는 메인 앱에서 빨간색으로 구분된다. briefMatch.ts 는
 *  supabase 의존이라 viewer 번들에 import 못 하므로 루트 상수만 인라인해
 *  (BRIEF_MATCH_ROOT) 동일 판정을 한다. */
const BRIEF_MATCH_ROOT = "브리프 매치";
function isBriefMatchPath(path: string): boolean {
  return path === BRIEF_MATCH_ROOT || path.startsWith(`${BRIEF_MATCH_ROOT}/`);
}

interface FolderTreeProps {
  folders: ViewerFolderNode[];
  selectedPath: string | null;
  /** null = 전체 선택. */
  onSelect: (path: string | null) => void;
  language: ViewerLang;
}

interface TreeNode {
  path: string;
  name: string;
  count: number;
  children: TreeNode[];
}

function buildTree(folders: ViewerFolderNode[]): TreeNode[] {
  const map = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  const sorted = [...folders].sort((a, b) => a.path.localeCompare(b.path));
  for (const folder of sorted) {
    const node: TreeNode = { path: folder.path, name: folder.name, count: folder.count, children: [] };
    map.set(folder.path, node);
    const idx = folder.path.lastIndexOf("/");
    if (idx === -1) {
      roots.push(node);
      continue;
    }
    const parent = map.get(folder.path.slice(0, idx));
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** 하위 포함 총 아이템 수 — 폴더 선택이 하위를 포함하므로 배지도 총합으로 표시. */
function subtreeTotal(node: TreeNode): number {
  return node.children.reduce((acc, child) => acc + subtreeTotal(child), node.count);
}

export function FolderTree({ folders, selectedPath, onSelect, language }: FolderTreeProps) {
  const roots = useMemo(() => {
    const built = buildTree(folders);
    /* "브리프 매치" 루트는 상위 폴더로 쓰지 않는다 — 그 자식들(실제 매치
     *  폴더)을 최상위로 승격하고 루트 노드 자체는 트리에서 제거한다. 승격된
     *  폴더는 경로가 그대로라(브리프 매치/...) 필터링은 정상 동작하고,
     *  isBriefMatchPath 로 빨간 아이콘만 표시된다. */
    const out: TreeNode[] = [];
    for (const node of built) {
      if (node.path === BRIEF_MATCH_ROOT) out.push(...node.children);
      else out.push(node);
    }
    return out;
  }, [folders]);
  if (folders.length === 0) return null;

  return (
    <div className="flex flex-col py-1">
      <FolderRowButton
        depth={0}
        active={selectedPath === null}
        onClick={() => onSelect(null)}
        icon={<Layers className="h-3.5 w-3.5 shrink-0" />}
        label={vt(language, "allFolders")}
        hasChildren={false}
        expanded={false}
        onToggleExpand={undefined}
      />
      {roots.map((node) => (
        <TreeRow
          key={node.path}
          node={node}
          depth={0}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function TreeRow({
  node,
  depth,
  selectedPath,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;
  const briefMatch = isBriefMatchPath(node.path);
  return (
    <>
      <FolderRowButton
        depth={depth}
        active={selectedPath === node.path}
        onClick={() => onSelect(node.path)}
        icon={<Folder className={cn("h-3.5 w-3.5 shrink-0", briefMatch && "text-red-500")} />}
        label={node.name}
        count={subtreeTotal(node)}
        hasChildren={hasChildren}
        expanded={expanded}
        onToggleExpand={hasChildren ? () => setExpanded((v) => !v) : undefined}
      />
      {hasChildren && expanded
        ? node.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))
        : null}
    </>
  );
}

function FolderRowButton({
  depth,
  active,
  onClick,
  icon,
  label,
  count,
  hasChildren,
  expanded,
  onToggleExpand,
}: {
  depth: number;
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count?: number;
  hasChildren: boolean;
  expanded: boolean;
  onToggleExpand?: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex h-7 items-center gap-1 pr-2 text-caption transition-colors",
        active ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:bg-muted/40",
      )}
      style={{ paddingLeft: 4 + depth * 12 }}
    >
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onToggleExpand?.();
        }}
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center",
          hasChildren ? "text-muted-foreground hover:text-foreground" : "invisible",
        )}
        tabIndex={hasChildren ? 0 : -1}
        aria-label={expanded ? "Collapse" : "Expand"}
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        title={label}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {typeof count === "number" ? (
          <span className="font-mono text-2xs opacity-60">{count}</span>
        ) : null}
      </button>
    </div>
  );
}
