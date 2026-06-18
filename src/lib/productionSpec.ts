/**
 * productionSpec — a version-scoped, agent-authored "production bible".
 *
 * Where `shotPlan.globalSpec` is synthesized fresh on every sheet render (and so
 * drifts between renders), a ProductionSpec is authored ONCE by the agent, parsed
 * from a ```spec fence, persisted on the scene_version row (`production_spec` JSON
 * column), and replayed identically into every storyboard-sheet prompt. It is the
 * single shared anchor for:
 *   - SET DESIGN  — one space every panel takes place in (text-only SET LOCK that
 *     works even with no background reference photo),
 *   - COLOR PALETTE — named colors applied to every panel,
 *   - CHARACTERS  — per-character differentiation rules (silhouette / wardrobe /
 *     accent color) that reinforce CAST LOCK,
 *   - CINEMATOGRAPHY — shared lens/movement/composition language.
 *
 * Everything is optional and best-effort: a malformed or partial fence still yields
 * whatever fields parsed, and a version with no spec falls back to the deterministic
 * shotPlan synthesis. `parseProductionSpec` NEVER throws.
 */

export interface SpecColor {
  /** Human/named color, e.g. "Matte Black", "Burnished Gold". */
  name: string;
  /** Optional usage hint, e.g. "key light", "accent on props". */
  hint?: string;
}

export interface SpecCharacter {
  name: string;
  /** Short tag matching the asset roster (e.g. "@hero"), when known. */
  tag?: string;
  silhouette?: string;
  wardrobe?: string;
  accentColor?: string;
  props?: string[];
}

export interface SpecSetDesign {
  location?: string;
  architecture?: string;
  materials?: string;
  lighting?: string;
  atmosphere?: string;
}

export interface SpecCinematography {
  lensLanguage?: string;
  movementStyle?: string;
  compositionNotes?: string;
}

export interface ProductionSpec {
  title?: string;
  genre?: string;
  /** One-paragraph situation summary (logline expansion). */
  generalContext?: string;
  /** The single shared space every cut takes place in. */
  setDesign?: SpecSetDesign;
  /** Named palette applied identically to every panel. */
  colorPalette?: SpecColor[];
  /** Per-character differentiation rules. */
  characters?: SpecCharacter[];
  cinematography?: SpecCinematography;
  moodKeywords?: string[];
  /** One-paragraph look anchor. */
  finalStyleDirection?: string;
}

const asString = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

const asStringArray = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const arr = v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean);
  return arr.length ? arr : undefined;
};

function parseColors(v: unknown): SpecColor[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: SpecColor[] = [];
  for (const item of v) {
    if (typeof item === "string") {
      const name = item.trim();
      if (name) out.push({ name });
    } else if (item && typeof item === "object") {
      const o = item as { name?: unknown; hint?: unknown };
      const name = asString(o.name);
      if (name) out.push({ name, hint: asString(o.hint) });
    }
  }
  return out.length ? out : undefined;
}

function parseCharacters(v: unknown): SpecCharacter[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: SpecCharacter[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const name = asString(o.name);
    if (!name) continue;
    out.push({
      name,
      tag: asString(o.tag),
      silhouette: asString(o.silhouette),
      wardrobe: asString(o.wardrobe),
      accentColor: asString(o.accent_color) ?? asString(o.accentColor),
      props: asStringArray(o.props),
    });
  }
  return out.length ? out : undefined;
}

function parseSetDesign(v: unknown): SpecSetDesign | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const sd: SpecSetDesign = {
    location: asString(o.location),
    architecture: asString(o.architecture),
    materials: asString(o.materials),
    lighting: asString(o.lighting),
    atmosphere: asString(o.atmosphere),
  };
  return Object.values(sd).some(Boolean) ? sd : undefined;
}

function parseCinematography(v: unknown): SpecCinematography | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const c: SpecCinematography = {
    lensLanguage: asString(o.lens_language) ?? asString(o.lensLanguage),
    movementStyle: asString(o.movement_style) ?? asString(o.movementStyle),
    compositionNotes: asString(o.composition_notes) ?? asString(o.compositionNotes),
  };
  return Object.values(c).some(Boolean) ? c : undefined;
}

/**
 * Validate/normalize an unknown value (parsed JSON or a JS object) into a
 * ProductionSpec. Returns null when nothing usable parses. Never throws.
 */
export function parseProductionSpec(input: unknown): ProductionSpec | null {
  let raw: unknown = input;
  if (typeof input === "string") {
    const clean = input.replace(/```json|```spec|```/g, "").trim();
    if (!clean) return null;
    try {
      raw = JSON.parse(clean);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const spec: ProductionSpec = {
    title: asString(o.title),
    genre: asString(o.genre),
    generalContext: asString(o.general_context) ?? asString(o.generalContext),
    setDesign: parseSetDesign(o.set_design ?? o.setDesign),
    colorPalette: parseColors(o.color_palette ?? o.colorPalette),
    characters: parseCharacters(o.characters),
    cinematography: parseCinematography(o.cinematography),
    moodKeywords: asStringArray(o.mood_keywords ?? o.moodKeywords),
    finalStyleDirection: asString(o.final_style_direction) ?? asString(o.finalStyleDirection),
  };

  // Worth persisting only if at least one substantive look/space/cast field parsed.
  const hasContent =
    spec.setDesign ||
    spec.colorPalette ||
    spec.characters ||
    spec.cinematography ||
    spec.finalStyleDirection ||
    spec.generalContext;
  if (!hasContent) return null;
  return spec;
}

// ── Pending spec persistence (mirrors ff_pending_scenes_{pid}) ──

export const LS_PENDING_SPEC = (pid: string) => `ff_pending_spec_${pid}`;

export const loadPendingSpecFromLS = (pid: string): ProductionSpec | null => {
  try {
    const r = localStorage.getItem(LS_PENDING_SPEC(pid));
    return r ? parseProductionSpec(JSON.parse(r)) : null;
  } catch {
    return null;
  }
};

export const savePendingSpecToLS = (pid: string, spec: ProductionSpec | null) => {
  try {
    if (!spec) localStorage.removeItem(LS_PENDING_SPEC(pid));
    else localStorage.setItem(LS_PENDING_SPEC(pid), JSON.stringify(spec));
  } catch {}
};
