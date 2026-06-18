/**
 * contactSheet — client-side splitter for the 3x3 contact sheet produced
 * by NB2 in Camera Variations → Contact Sheet tab.
 *
 * Why client-side:
 *   Electron's main process has no DOM canvas and we didn't want to take
 *   a 50MB `sharp` dep just to slice a PNG. Doing it in the renderer
 *   keeps the electron bundle lean and gets us a free, fast split using
 *   the browser's built-in Canvas API.
 *
 * splitContactSheetDataUrl(url)
 *   Fetches a contact-sheet image, draws it into a canvas, then crops
 *   each of 9 (3x3) tiles with a small inner bleed to avoid picking up
 *   NB2's white gutter pixels. Returns 9 PNG data-URLs in
 *   left-to-right / top-to-bottom order matching CONTACT_SHEET_IDS.
 *
 *   The optional `bleedPx` argument lets callers tune the inset per
 *   output image — NB2 varies the gutter thickness run-to-run, so
 *   the default (~1% of tile width) is a safe general-purpose value.
 *
 * dataUrlToBlob(dataUrl)
 *   Converts a data URL back to a Blob so it can be uploaded via the
 *   local-server storage:save-image endpoint.
 */

const DEFAULT_ROWS = 3;
const DEFAULT_COLS = 3;

export interface SplitOptions {
  rows?: number;
  cols?: number;
  /** Inset each tile by this many pixels on every side before cropping.
   *  Default = 1% of the tile width, clamped to [2, 16] px. */
  bleedPx?: number;
}

/** Load an <img> and wait for it to fully decode. */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Contact-sheet URLs live on our own electron local-file adapter so
    // crossOrigin is irrelevant, but set anyway for belt-and-braces if a
    // future build shifts to http Supabase storage.
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load contact-sheet image: ${url}`));
    img.src = url;
  });
}

/** Near-white threshold (0-255, every channel) for gutter detection. */
const GUTTER_WHITE = 238;
/** A row/column counts as "gutter" when at least this fraction is near-white. */
const GUTTER_MIN_FRAC = 0.55;

/** Even (fixed-fraction) boundaries: [0, total/n, 2*total/n, ..., total]. */
function evenBoundaries(n: number, total: number): number[] {
  const tile = Math.floor(total / n);
  const bounds: number[] = [];
  for (let i = 0; i < n; i++) bounds.push(i * tile);
  bounds.push(total);
  return bounds;
}

/**
 * Per-column / per-row near-white fraction over the whole sheet, in ONE pass.
 * A gutter line is near-white across (almost) the full opposite axis, so these
 * profiles let us locate the model's ACTUAL panel separators.
 */
function computeWhiteProfiles(
  data: Uint8ClampedArray,
  W: number,
  H: number,
): { colFrac: Float32Array; rowFrac: Float32Array } {
  const colCount = new Float32Array(W);
  const rowFrac = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    const rowBase = y * W * 4;
    let rc = 0;
    for (let x = 0; x < W; x++) {
      const i = rowBase + x * 4;
      if (data[i] >= GUTTER_WHITE && data[i + 1] >= GUTTER_WHITE && data[i + 2] >= GUTTER_WHITE) {
        colCount[x] += 1;
        rc += 1;
      }
    }
    rowFrac[y] = rc / W;
  }
  const colFrac = new Float32Array(W);
  for (let x = 0; x < W; x++) colFrac[x] = colCount[x] / H;
  return { colFrac, rowFrac };
}

/**
 * Snap each of the (n-1) internal cut boundaries to the model's real gutter.
 * For every expected boundary (i*total/n) we search a window around it for the
 * LONGEST run of near-white lines and cut at its center. When no gutter-like
 * run is found in the window (e.g. the boundary touches a dark empty cell, or
 * the model drew no clean gutter) we keep the even position — so this never
 * does worse than the fixed-fraction split. Windows are narrow enough
 * (±18% of a tile) that boundaries stay ordered and cells stay positive.
 */
function snapBoundaries(frac: Float32Array, n: number, total: number): number[] {
  const bounds: number[] = [0];
  const tile = total / n;
  const tol = Math.max(4, Math.round(tile * 0.18));
  for (let i = 1; i < n; i++) {
    const expected = Math.round(i * tile);
    const lo = Math.max(1, expected - tol);
    const hi = Math.min(total - 2, expected + tol);
    let bestCenter = -1;
    let bestLen = 0;
    let runStart = -1;
    for (let x = lo; x <= hi; x++) {
      if (frac[x] >= GUTTER_MIN_FRAC) {
        if (runStart < 0) runStart = x;
        const len = x - runStart + 1;
        if (len > bestLen) {
          bestLen = len;
          bestCenter = Math.round((runStart + x) / 2);
        }
      } else {
        runStart = -1;
      }
    }
    bounds.push(bestCenter >= 0 ? bestCenter : expected);
  }
  bounds.push(total);
  return bounds;
}

/**
 * Split a contact-sheet image URL into rows*cols data URLs.
 *
 * Gutter-aware: generative models (NB2 / gpt-image) do NOT draw mathematically
 * equal cells, so a fixed `W/cols` × `H/rows` slice cuts THROUGH panels and
 * bleeds a sliver of the neighbouring cut into each tile ("tiling"/seam
 * artifacts). We instead detect the real white gutters and cut along them,
 * falling back to even fractions per-axis when no gutter is found.
 *
 * Throws on decode / canvas failure; callers should surface the error
 * to the user via their existing toast/error UI.
 */
export async function splitContactSheetDataUrl(
  url: string,
  opts: SplitOptions = {},
): Promise<string[]> {
  const rows = opts.rows ?? DEFAULT_ROWS;
  const cols = opts.cols ?? DEFAULT_COLS;

  const img = await loadImage(url);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  if (!W || !H) throw new Error("Contact-sheet image has zero dimensions");

  const tileW = Math.floor(W / cols);
  const tileH = Math.floor(H / rows);
  if (tileW < 16 || tileH < 16) {
    throw new Error(`Contact-sheet too small to split (${W}x${H}).`);
  }

  // Draw the full sheet once so we can both read pixels (gutter detection) and
  // crop cells from the same canvas.
  const sheet = document.createElement("canvas");
  sheet.width = W;
  sheet.height = H;
  const sctx = sheet.getContext("2d");
  if (!sctx) throw new Error("Failed to allocate 2D canvas context for contact-sheet split");
  sctx.drawImage(img, 0, 0);

  // Gutter-aware boundaries; fall back to even fractions if pixels can't be
  // read (e.g. a tainted canvas) or detection is unavailable.
  let xs: number[];
  let ys: number[];
  try {
    const { data } = sctx.getImageData(0, 0, W, H);
    const { colFrac, rowFrac } = computeWhiteProfiles(data, W, H);
    xs = snapBoundaries(colFrac, cols, W);
    ys = snapBoundaries(rowFrac, rows, H);
  } catch {
    xs = evenBoundaries(cols, W);
    ys = evenBoundaries(rows, H);
  }

  // Small inset to drop the half-gutter each cell keeps at a snapped boundary;
  // the per-tile white-border trim downstream removes any residual edge.
  const autoBleed = Math.max(2, Math.min(16, Math.round(tileW * 0.01)));
  const bleed = Math.max(0, Math.min(Math.floor(tileW / 4), opts.bleedPx ?? autoBleed));

  const tiles: string[] = [];
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to allocate 2D canvas context for contact-sheet split");

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cellX = xs[c];
      const cellY = ys[r];
      const cellW = xs[c + 1] - xs[c];
      const cellH = ys[r + 1] - ys[r];
      // Per-cell bleed, never more than a quarter of the (possibly small) cell.
      const b = Math.max(0, Math.min(bleed, Math.floor(cellW / 4), Math.floor(cellH / 4)));
      const sw = Math.max(1, cellW - b * 2);
      const sh = Math.max(1, cellH - b * 2);
      canvas.width = sw;
      canvas.height = sh;
      ctx.clearRect(0, 0, sw, sh);
      ctx.drawImage(sheet, cellX + b, cellY + b, sw, sh, 0, 0, sw, sh);
      tiles.push(canvas.toDataURL("image/png"));
    }
  }

  return tiles;
}

/**
 * Trim near-white borders/gutters from a tile by detecting the content
 * bounding box. Unlike a fixed `bleed`, this adapts to the variable white
 * gutter the sheet model renders run-to-run, so storyboard tiles come out
 * without residual white edges before the NB2 refine pass.
 *
 * Scans inward from each edge; a row/col counts as "border" when at least
 * `borderFrac` of its pixels are near-white (every channel >= `whiteThreshold`).
 * Never trims more than `maxTrimFrac` of a side (safety against blowing out a
 * legitimately bright frame). Returns the original URL unchanged if canvas is
 * unavailable or nothing needs trimming.
 */
export async function trimWhiteBorderDataUrl(
  srcDataUrl: string,
  opts: { whiteThreshold?: number; borderFrac?: number; maxTrimFrac?: number } = {},
): Promise<string> {
  if (typeof document === "undefined") return srcDataUrl;
  const whiteThreshold = opts.whiteThreshold ?? 238;
  const borderFrac = opts.borderFrac ?? 0.85;
  const maxTrimFrac = opts.maxTrimFrac ?? 0.25;

  const img = await loadImage(srcDataUrl);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  if (!W || !H) return srcDataUrl;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return srcDataUrl;
  ctx.drawImage(img, 0, 0);

  let pixels: Uint8ClampedArray;
  try {
    pixels = ctx.getImageData(0, 0, W, H).data;
  } catch {
    return srcDataUrl; // tainted canvas etc.
  }

  const isWhite = (x: number, y: number) => {
    const i = (y * W + x) * 4;
    return pixels[i] >= whiteThreshold && pixels[i + 1] >= whiteThreshold && pixels[i + 2] >= whiteThreshold;
  };
  const rowWhiteFrac = (y: number) => {
    let c = 0;
    for (let x = 0; x < W; x++) if (isWhite(x, y)) c++;
    return c / W;
  };
  const colWhiteFrac = (x: number) => {
    let c = 0;
    for (let y = 0; y < H; y++) if (isWhite(x, y)) c++;
    return c / H;
  };

  let top = 0;
  let bottom = H - 1;
  let left = 0;
  let right = W - 1;
  const maxTrimY = Math.floor(H * maxTrimFrac);
  const maxTrimX = Math.floor(W * maxTrimFrac);
  while (top < bottom && top < maxTrimY && rowWhiteFrac(top) >= borderFrac) top++;
  while (bottom > top && H - 1 - bottom < maxTrimY && rowWhiteFrac(bottom) >= borderFrac) bottom--;
  while (left < right && left < maxTrimX && colWhiteFrac(left) >= borderFrac) left++;
  while (right > left && W - 1 - right < maxTrimX && colWhiteFrac(right) >= borderFrac) right--;

  const cw = right - left + 1;
  const ch = bottom - top + 1;
  if (cw <= 0 || ch <= 0 || (cw === W && ch === H)) return srcDataUrl;

  const out = document.createElement("canvas");
  out.width = cw;
  out.height = ch;
  const octx = out.getContext("2d");
  if (!octx) return srcDataUrl;
  octx.drawImage(canvas, left, top, cw, ch, 0, 0, cw, ch);
  return out.toDataURL("image/png");
}

/** Convert a data URL to a Blob (for uploading the chosen tile to storage). */
export function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body] = dataUrl.split(",");
  const m = /data:([^;]+)(;base64)?/.exec(head);
  if (!m) throw new Error("Invalid data URL");
  const mime = m[1];
  const isB64 = head.includes(";base64");
  if (isB64) {
    const bin = atob(body);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }
  return new Blob([decodeURIComponent(body)], { type: mime });
}

/** Extract just the base64 body of a `data:...;base64,...` URL. */
export function dataUrlToBase64(dataUrl: string): string {
  const idx = dataUrl.indexOf(",");
  if (idx < 0) throw new Error("Invalid data URL");
  return dataUrl.slice(idx + 1);
}
