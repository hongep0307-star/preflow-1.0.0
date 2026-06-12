/**
 * Camera-variation grid generation in-flight store.
 *
 * Mirrors `sketchState.ts`: a module-level (not React) store so a grid
 * generation survives the modal — or the whole Conti tab — unmounting. The
 * user can kick off a 9-up grid, close the popup, and the generation keeps
 * running; the scene card shows a spinner on its Camera Variations icon, and
 * the finished grid is appended to the scene's persisted grid history.
 *
 * Keyed by `projectId:sceneId`. One generation per scene at a time (the modal
 * disables Generate while one is in flight for that scene).
 */

export type CamVarGenState = { startedAt: number };

const keyOf = (projectId: string, sceneId: string) => `${projectId}:${sceneId}`;

const _byKey = new Map<string, CamVarGenState>();
const _listeners = new Map<string, Set<() => void>>();

function notify(projectId: string, sceneId: string): void {
  _listeners.get(keyOf(projectId, sceneId))?.forEach((fn) => fn());
}

export function getCamVarGen(projectId: string, sceneId: string): CamVarGenState | undefined {
  return _byKey.get(keyOf(projectId, sceneId));
}

export function isCamVarGenerating(projectId: string, sceneId: string): boolean {
  return _byKey.has(keyOf(projectId, sceneId));
}

/** Set (or clear, when `next === null`) the in-flight state for a scene. */
export function setCamVarGen(
  projectId: string,
  sceneId: string,
  next: CamVarGenState | null,
): void {
  const k = keyOf(projectId, sceneId);
  if (next === null) _byKey.delete(k);
  else _byKey.set(k, next);
  notify(projectId, sceneId);
}

export function subscribeCamVarGen(
  projectId: string,
  sceneId: string,
  fn: () => void,
): () => void {
  const k = keyOf(projectId, sceneId);
  if (!_listeners.has(k)) _listeners.set(k, new Set());
  _listeners.get(k)!.add(fn);
  return () => {
    _listeners.get(k)?.delete(fn);
  };
}
