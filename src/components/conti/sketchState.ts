/**
 * Sketch generation in-flight store.
 *
 * Mirrors the `_moodGeneratingByProject` pattern in agent/agentTypes.ts but
 * keys by `projectId:sceneId:model` so the user can fire multiple
 * generations against the same scene with different models concurrently
 * (e.g. NB2 still running while user kicks off a GPT Image 2 batch). Each
 * model has its own independent skeleton/arrived/promise lifecycle.
 *
 * Why model is part of the key:
 *   The three providers (NB2/Vertex, gpt-image-1.5, gpt-image-2) hit
 *   different upstreams, so there's no quota reason to serialize them on
 *   our side. Forcing the user to wait for the slow GPT-2 batch before
 *   re-trying with NB2 just because the previous job is "in-flight"
 *   feels broken — they're orthogonal pipes.
 *
 * Why module-level (not React state):
 *   ContiStudio (and the user's whole Conti tab) can unmount mid-
 *   generation — the user might close Studio, switch tabs, or navigate
 *   away. The in-flight promise and its arrivedUrls need to outlive the
 *   React tree so we can (a) show skeletons again when the component
 *   remounts and (b) persist the final result to `scenes.sketches`
 *   regardless of whether the originating component is still mounted.
 */

import type { SketchModel } from "@/lib/sketches";

export type SketchGenState = {
  count: number;
  /** Stable placeholder ids so skeleton cards survive store updates
   *  without being re-created (keeps React key identity stable). */
  skeletonIds: string[];
  /** URLs that have arrived from the generator, in arrival order. */
  arrivedUrls: string[];
  /** In-flight promise handle, set once the generate() kicks off. */
  promise: Promise<void> | null;
  model: SketchModel;
  startedAt: number;
};

function makeKey(projectId: string, sceneId: string, model: SketchModel): string {
  return `${projectId}:${sceneId}:${model}`;
}

function makeScenePrefix(projectId: string, sceneId: string): string {
  return `${projectId}:${sceneId}:`;
}

const _sketchGenByKey = new Map<string, SketchGenState>();
// Listeners are scene-scoped (not model-scoped): every model change for a
// scene wakes up that scene's UI so it can re-aggregate the state across
// models and redraw skeletons / arrived sketches consistently.
const _sketchGenListeners = new Map<string, Set<() => void>>();

function notifyScene(projectId: string, sceneId: string): void {
  const sceneKey = `${projectId}:${sceneId}`;
  _sketchGenListeners.get(sceneKey)?.forEach((fn) => fn());
}

export function getSketchGen(
  projectId: string,
  sceneId: string,
  model: SketchModel,
): SketchGenState | undefined {
  return _sketchGenByKey.get(makeKey(projectId, sceneId, model));
}

/** Snapshot of every active in-flight generation for a scene, regardless of
 *  model. Used by the UI to render aggregated skeletons + arrived urls. */
export function getAllSketchGensForScene(
  projectId: string,
  sceneId: string,
): SketchGenState[] {
  const prefix = makeScenePrefix(projectId, sceneId);
  const out: SketchGenState[] = [];
  for (const [key, state] of _sketchGenByKey) {
    if (key.startsWith(prefix)) out.push(state);
  }
  // Stable order by startedAt so the UI doesn't reshuffle skeletons when
  // a second model arrives.
  out.sort((a, b) => a.startedAt - b.startedAt);
  return out;
}

export function setSketchGen(
  projectId: string,
  sceneId: string,
  model: SketchModel,
  next: SketchGenState | null,
): void {
  const key = makeKey(projectId, sceneId, model);
  if (next === null) _sketchGenByKey.delete(key);
  else _sketchGenByKey.set(key, next);
  notifyScene(projectId, sceneId);
}

export function patchSketchGen(
  projectId: string,
  sceneId: string,
  model: SketchModel,
  patch: Partial<SketchGenState>,
): void {
  const key = makeKey(projectId, sceneId, model);
  const cur = _sketchGenByKey.get(key);
  if (!cur) return;
  _sketchGenByKey.set(key, { ...cur, ...patch });
  notifyScene(projectId, sceneId);
}

export function subscribeSketchGen(
  projectId: string,
  sceneId: string,
  fn: () => void,
): () => void {
  const sceneKey = `${projectId}:${sceneId}`;
  if (!_sketchGenListeners.has(sceneKey)) _sketchGenListeners.set(sceneKey, new Set());
  _sketchGenListeners.get(sceneKey)!.add(fn);
  return () => {
    _sketchGenListeners.get(sceneKey)?.delete(fn);
  };
}

export function genSketchId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
