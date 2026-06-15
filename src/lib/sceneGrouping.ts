/**
 * Scene grouping — shared helpers for the conti tab's scene-group (sequence)
 * model.
 *
 * The displayed scene number (S1/S2/S3) is NOT a stored label: it is a
 * positional run counter derived by walking the cuts in order and bumping the
 * counter whenever the grouping key changes. The stored signal is each cut's
 * `sequence`; the key priority is `sequence` -> `location` -> (blank continues
 * the running group). Transitions are skipped entirely.
 *
 * `computeSceneGroups` mirrors the original inline `sceneGroupMap` memo in
 * ContiTab so the rendered grouping is unchanged. `materializeSequences` turns
 * a manual boundary edit (start new scene / merge with previous / attach on
 * drag / insert as new scene) into an explicit `sequence` ordinal on every
 * grouped cut, so the user's intent is frozen and no longer drifts with later
 * location edits.
 */

export interface GroupableScene {
  id: string;
  sequence?: number | null;
  location?: string | null;
  is_transition?: boolean;
}

export interface SceneGroupInfo {
  /** 1-based group ordinal in cut order. */
  index: number;
  /** True when this cut begins its group (the scene's first cut). */
  isStart: boolean;
}

/**
 * Assign a 1-based group index + start flag to each non-transition cut.
 *
 * Mirrors the ContiTab `sceneGroupMap` logic exactly:
 *   - key = `seq:{sequence}` (when present and `useSequence`) else
 *     `loc:{normalized location}` else null.
 *   - a blank cut (null key) continues the running group; only leading blanks
 *     (before any group has started) stay ungrouped (absent from the map).
 */
export function computeSceneGroups(
  scenes: GroupableScene[],
  opts: { useSequence?: boolean } = {},
): Map<string, SceneGroupInfo> {
  const useSequence = opts.useSequence !== false; // default true
  const map = new Map<string, SceneGroupInfo>();
  let groupCounter = 0;
  let prevKey: string | null = null;
  for (const s of scenes) {
    if (s.is_transition) continue;
    let key: string | null = null;
    if (useSequence && s.sequence != null) key = `seq:${s.sequence}`;
    else if (s.location?.trim()) key = `loc:${s.location.trim().toLowerCase()}`;
    if (key == null) {
      // Blank cut: continue the current group if one is running.
      if (prevKey == null) continue; // leading blank -> ungrouped
      map.set(s.id, { index: groupCounter, isStart: false });
      continue;
    }
    const isStart = key !== prevKey;
    if (isStart) groupCounter += 1;
    map.set(s.id, { index: groupCounter, isStart });
    prevKey = key;
  }
  return map;
}

/**
 * A single manual boundary change. Exactly one field is meaningful per call;
 * extra fields are ignored.
 *   - `startAt` / `newSceneAt`: make this cut begin a NEW scene (split).
 *   - `mergeAt` / `attachToPrev`: drop this cut's boundary so it joins the
 *     previous scene (merge / drag-into-scene).
 */
export interface GroupingChange {
  startAt?: string;
  newSceneAt?: string;
  mergeAt?: string;
  attachToPrev?: string;
}

/**
 * Apply a boundary change to the current grouping and write the resulting
 * group ordinals back onto every grouped cut's `sequence`.
 *
 * Returns the SAME array reference when nothing changed, so callers can skip a
 * redundant persist. Transitions and leading-blank (ungrouped) cuts are left
 * untouched.
 */
export function materializeSequences<T extends GroupableScene>(
  scenes: T[],
  change: GroupingChange = {},
): T[] {
  const groups = computeSceneGroups(scenes, { useSequence: true });
  if (groups.size === 0) return scenes;

  const firstGroupedId = groups.keys().next().value as string;
  const boundaries = new Set<string>();
  for (const [id, g] of groups) if (g.isStart) boundaries.add(id);

  const addStart = change.startAt ?? change.newSceneAt;
  const removeStart = change.mergeAt ?? change.attachToPrev;
  if (addStart && groups.has(addStart)) boundaries.add(addStart);
  // Never remove the very first grouped cut's boundary (no previous scene).
  if (removeStart && removeStart !== firstGroupedId) boundaries.delete(removeStart);
  boundaries.add(firstGroupedId);

  let ordinal = 0;
  let changed = false;
  const next = scenes.map((s) => {
    if (s.is_transition || !groups.has(s.id)) return s;
    if (boundaries.has(s.id)) ordinal += 1;
    if (s.sequence === ordinal) return s;
    changed = true;
    return { ...s, sequence: ordinal } as T;
  });
  return changed ? next : scenes;
}
