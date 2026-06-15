import crypto from "crypto";
import { getDb } from "./db";

// ── Schema whitelist ──────────────────────────────────────────────
// The local server runs on 127.0.0.1 and is only consumed by the renderer,
// but the renderer hosts external content (markdown, AI output, user uploads).
// We treat the renderer as semi-trusted and require every (table, column)
// pair to be on an explicit allow-list before it ever reaches a SQL string.
// This blocks:
//   - SQL identifier injection via crafted table/column names
//   - Reading/writing tables that the UI was never supposed to touch (e.g.
//     someone trying to dump `settings` rows containing API keys)
const TABLE_COLUMNS: Record<string, ReadonlySet<string>> = {
  projects: new Set([
    "id", "user_id", "title", "client", "deadline", "status", "video_format",
    "active_version_id", "folder_id", "conti_style_id", "thumbnail_url",
    "thumbnail_crop", "is_favorite", "last_visited_at", "updated_at", "deleted_at",
    "direction_mode",
    "created_at",
  ]),
  briefs: new Set([
    "id", "project_id", "raw_text", "analysis", "analysis_en", "mood_image_urls",
    "mood_bookmarks", "lang", "source_type", "image_urls", "created_at",
  ]),
  // 브리프 composer / 레퍼런스 패널 첨부물의 1등 시민 저장소. 옛 구현에서
  // localStorage 만 사용해 quota/export/디바이스 이전 모두에서 데이터 손실이
  // 발생하던 부분의 새 백엔드.
  brief_attachments: new Set([
    "id", "project_id", "kind", "role", "file_url", "poster_url", "external_url",
    "filename", "mime_type", "size_bytes", "width", "height", "duration_sec",
    "page_count", "extracted_text", "annotation", "display_order",
    "origin_reference_id", "created_at", "updated_at",
  ]),
  scenes: new Set([
    "id", "project_id", "scene_number", "sequence", "title", "description", "camera_angle",
    "location", "mood", "duration_sec", "tagged_assets", "conti_image_url",
    "conti_image_history", "source", "conti_image_crop", "is_transition",
    "is_final", "is_highlight", "highlight_kind", "highlight_reason",
    "transition_type", "sketches", "camera_variation_grid",
    "motion_in", "motion_out", "transition_to_next", "created_at",
  ]),
  assets: new Set([
    "id", "project_id", "asset_type", "tag_name", "photo_url", "ai_description",
    "outfit_description", "role_description", "space_description",
    "signature_items", "photo_crop", "photo_variations", "source_type", "created_at",
    "character_sheet_url", "character_sheet_generated_at", "character_sheet_source_url",
    "use_character_sheet", "character_sheet_style",
    "character_board_url", "character_board_generated_at", "character_board_source_url",
    "character_ref_mode",
    // Promote-to-Asset 으로 라이브러리에서 만들어진 에셋의 출처 reference id.
    // ALTER 로 나중에 추가된 컬럼이라 화이트리스트에 빠져 있었음 — 프로젝트
    // 팩 import 가 이 필드를 그대로 보존해야 라이브러리 ↔ 에셋 연결이 유지된다.
    "source_reference_id",
  ]),
  scene_versions: new Set([
    "id", "project_id", "version_number", "version_name", "scenes",
    "display_order", "is_active", "created_at",
  ]),
  style_presets: new Set([
    "id", "user_id", "name", "description", "reference_image_urls",
    "style_prompt", "thumbnail_url", "is_default", "created_at",
  ]),
  chat_logs: new Set(["id", "project_id", "role", "content", "images", "created_at"]),
  folders: new Set(["id", "user_id", "name", "created_at"]),
  reference_items: new Set([
    "id", "kind", "title", "file_url", "thumbnail_url", "mime_type", "file_size",
    "content_hash", "duration_sec", "width", "height", "tags", "notes", "rating",
    "is_favorite", "source_url", "cover_at_sec", "timestamp_notes", "color_palette",
    "ai_suggestions", "classification_status", "classified_at", "origin_project_id",
    "source_app", "source_library", "source_id", "imported_at", "created_at",
    "pinned_at", "deleted_at", "updated_at", "last_used_at", "variation_of",
  ]),
  project_reference_links: new Set([
    "id", "project_id", "reference_id", "target", "annotation", "time_range",
    "created_at", "updated_at",
  ]),
  saved_filters: new Set([
    "id", "name", "query", "source_app", "source_id", "created_at", "updated_at",
  ]),
  // Sheet test gallery artifacts (storyboard sheets kept in the mood bucket).
  storyboard_sheets: new Set([
    "id", "project_id", "url", "size_used", "cut_count", "cols", "rows",
    "scene_ids", "video_format", "created_at",
  ]),
};

function assertTable(table: string): asserts table is keyof typeof TABLE_COLUMNS {
  if (!Object.prototype.hasOwnProperty.call(TABLE_COLUMNS, table)) {
    throw new Error(`Disallowed table: ${table}`);
  }
}

function assertColumns(table: string, cols: Iterable<string>) {
  const allowed = TABLE_COLUMNS[table];
  for (const c of cols) {
    if (!allowed.has(c)) {
      throw new Error(`Disallowed column "${c}" on table "${table}"`);
    }
  }
}

// 단일 진실원: JSON으로 직렬화/역직렬화해야 하는 컬럼 목록.
// (이전에는 db-handlers.ts와 local-server.ts에 각각 정의되어 thumbnail_crop이 한쪽에만 있었음.)
export const JSON_COLUMNS = new Set<string>([
  "analysis",
  "analysis_en",
  "mood_image_urls",
  "mood_bookmarks",
  "image_urls",
  "tagged_assets",
  "conti_image_history",
  "conti_image_crop",
  "camera_variation_grid",
  "photo_crop",
  "photo_variations",
  "scenes",
  "sketches",
  "images",
  "reference_image_urls",
  "thumbnail_crop",
  "tags",
  "timestamp_notes",
  "color_palette",
  "ai_suggestions",
  "time_range",
  "query",
  // brief_attachments.annotation 은 레퍼런스 패널 항목의 timestamp / range / note
  // 구조 (RefAnnotation) 를 JSON 으로 저장.
  "annotation",
]);

const BOOLEAN_COLUMNS = new Set<string>([
  "is_transition",
  "is_final",
  "is_highlight",
  "is_active",
  "is_default",
  "is_favorite",
]);

// projects.updated_at 자동 bump 시 "수정으로 간주하지 않는" 컬럼들. 즐겨찾기
// 토글이나 사이드바 RECENT 정렬용 last_visited_at 갱신 같은 트래킹성 변경은
// "유저가 프로젝트를 손봤다"는 의미가 아니므로 카드 호버에 노출되는 "최종
// 수정 시간"을 흔들면 안 된다. data 안에 이 컬럼들 외에 다른 키가 있을 때만
// updated_at 이 자동 갱신된다 (호출부가 명시적으로 updated_at 을 넣었다면
// 그대로 존중하고 자동 채움은 건너뛴다).
const PROJECTS_TRACKING_ONLY_COLUMNS = new Set<string>([
  "last_visited_at",
  "is_favorite",
  "updated_at",
  // 휴지통 이동/복원은 "유저가 콘텐츠를 손봤다"가 아니므로 updated_at(=마지막
  // 수정 시각) 을 흔들면 안 된다. 복원 후 카드 호버의 "X 분 전" 라벨이 삭제
  // 시점으로 튀는 것을 방지.
  "deleted_at",
]);

function maybeStampProjectsUpdatedAt(
  table: string,
  data: Record<string, any>,
): void {
  if (table !== "projects") return;
  if ("updated_at" in data) return;
  const keys = Object.keys(data);
  if (keys.length === 0) return;
  const hasContentChange = keys.some(
    (k) => !PROJECTS_TRACKING_ONLY_COLUMNS.has(k),
  );
  if (!hasContentChange) return;
  data.updated_at = new Date().toISOString();
}

// `use_character_sheet` is intentionally NOT in BOOLEAN_COLUMNS.
// It is tri-state at the storage layer (NULL / 0 / 1) so the renderer
// can distinguish "user has never set it" (NULL → default enabled) from
// "user explicitly disabled" (0 → bypass sheet, fall back to photo_url).
// Forcing `!!result[key]` here would collapse NULL to false and make
// every legacy character behave as if the user opted out of the sheet.
// `serializeValue` still maps `boolean → 0/1` on writes, so the
// renderer can pass plain booleans inbound; on reads it must compare
// with `value === false` rather than relying on coercion.

export function serializeValue(key: string, value: unknown): unknown {
  if (
    JSON_COLUMNS.has(key) &&
    value !== null &&
    value !== undefined &&
    typeof value !== "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  // better-sqlite3는 undefined 바인딩을 거부하므로 null로 강제.
  if (typeof value === "undefined") return null;
  return value;
}

export function deserializeRow<T extends Record<string, any> = Record<string, any>>(
  row: T | null | undefined,
): T | null | undefined {
  if (!row) return row;
  const result: Record<string, any> = { ...row };
  for (const key of Object.keys(result)) {
    if (JSON_COLUMNS.has(key) && typeof result[key] === "string") {
      try {
        result[key] = JSON.parse(result[key]);
      } catch {
        /* keep as string */
      }
    }
    if (BOOLEAN_COLUMNS.has(key)) {
      result[key] = !!result[key];
    }
  }
  return result as T;
}

export function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export function runQuery(sql: string, params: any[] = []): Record<string, any>[] {
  return getDb().prepare(sql).all(...params) as Record<string, any>[];
}

export function runExec(
  sql: string,
  params: any[] = [],
): { changes: number; lastInsertRowid: number | bigint } {
  const info = getDb().prepare(sql).run(...params);
  return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
}

// ── 고수준 CRUD ──
export interface SelectOptions {
  orderBy?: string;
  ascending?: boolean;
  limit?: number;
}

export function dbSelect(
  table: string,
  where?: Record<string, any>,
  options?: SelectOptions,
): Record<string, any>[] {
  assertTable(table);
  if (where) assertColumns(table, Object.keys(where));
  if (options?.orderBy) assertColumns(table, [options.orderBy]);

  let sql = `SELECT * FROM "${table}"`;
  const params: any[] = [];

  if (where && Object.keys(where).length > 0) {
    const clauses = Object.entries(where).map(([k, v]) => {
      params.push(v);
      return `"${k}" = ?`;
    });
    sql += ` WHERE ${clauses.join(" AND ")}`;
  }

  if (options?.orderBy) {
    const dir = options.ascending === false ? "DESC" : "ASC";
    sql += ` ORDER BY "${options.orderBy}" ${dir}`;
  }
  if (options?.limit) {
    const lim = Math.min(Math.max(0, Math.floor(Number(options.limit))), 10_000);
    sql += ` LIMIT ${lim}`;
  }

  return runQuery(sql, params).map((r) => deserializeRow(r)!);
}

export function dbInsert(table: string, data: Record<string, any>): Record<string, any> {
  assertTable(table);
  const row = { ...data };
  if (!row.id) row.id = generateId();
  if (!row.created_at) row.created_at = new Date().toISOString();
  // 새 프로젝트의 updated_at 은 created_at 과 동일하게 시작. 이후 자식 INSERT
  // 트리거나 콘텐츠 컬럼 UPDATE 시 자동 갱신된다.
  if (table === "projects" && !row.updated_at) row.updated_at = row.created_at;
  const keys = Object.keys(row);
  assertColumns(table, keys);
  const values = keys.map((k) => serializeValue(k, row[k]));
  const placeholders = keys.map(() => "?").join(", ");
  // Phase 2.1: INSERT + 별도 SELECT 두 번을 한 번의 RETURNING 으로 묶는다.
  // SQLite 3.35 (2021) + better-sqlite3 v8+ 부터 지원. 결과 row shape 동일
  // (deserializeRow 까지 동일하게 통과). INSERT 가 실제로 row 를 만들지
  // 못하면 (예: trigger 가 abort) RETURNING 결과가 빈 배열이라 직접 만든
  // row 로 fallback — 기존 동작 보존.
  const insertRows = runQuery(
    `INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(", ")}) VALUES (${placeholders}) RETURNING *`,
    values,
  );
  return insertRows.length > 0 ? deserializeRow(insertRows[0])! : row;
}

export function dbUpdate(
  table: string,
  data: Record<string, any>,
  where: Record<string, any>,
): Record<string, any>[] {
  assertTable(table);
  // projects 테이블에 콘텐츠 변경(예: title, deadline, thumbnail_crop)이 들어
  // 오면 자동으로 updated_at 을 현재 시각으로 stamping. is_favorite /
  // last_visited_at 같은 tracking 컬럼만 갱신될 때는 건드리지 않는다.
  // 호출부가 mutate 한 객체로 들어와도 안전하도록 별도 사본을 만든다.
  const dataWithStamp = { ...data };
  maybeStampProjectsUpdatedAt(table, dataWithStamp);
  assertColumns(table, Object.keys(dataWithStamp));
  assertColumns(table, Object.keys(where));
  const setClauses = Object.keys(dataWithStamp).map((k) => `"${k}" = ?`);
  const setValues = Object.keys(dataWithStamp).map((k) => serializeValue(k, dataWithStamp[k]));
  const whereClauses = Object.keys(where).map((k) => `"${k}" = ?`);
  const whereValues = Object.values(where);

  runExec(
    `UPDATE "${table}" SET ${setClauses.join(", ")} WHERE ${whereClauses.join(" AND ")}`,
    [...setValues, ...whereValues],
  );

  return runQuery(
    `SELECT * FROM "${table}" WHERE ${whereClauses.join(" AND ")}`,
    whereValues,
  ).map((r) => deserializeRow(r)!);
}

export function dbDelete(table: string, where: Record<string, any>): { changes: number } {
  assertTable(table);
  assertColumns(table, Object.keys(where));
  if (Object.keys(where).length === 0) {
    // Refuse mass deletes: every UI delete should target at least one column.
    throw new Error(`Refusing DELETE on "${table}" without a WHERE clause`);
  }
  const clauses = Object.keys(where).map((k) => `"${k}" = ?`);
  const values = Object.values(where);
  const info = runExec(`DELETE FROM "${table}" WHERE ${clauses.join(" AND ")}`, values);
  return { changes: info.changes };
}

export function dbUpsert(
  table: string,
  data: Record<string, any>,
  conflictKeys: string[],
): Record<string, any> {
  assertTable(table);
  const row = { ...data };
  if (!row.id) row.id = generateId();
  if (!row.created_at) row.created_at = new Date().toISOString();
  // upsert 도 update 경로를 탈 수 있으므로 동일한 stamping 정책 적용. INSERT
  // 케이스에서는 row.updated_at 이 row.created_at 으로 초기화돼 의미 동일.
  if (table === "projects" && !row.updated_at) row.updated_at = row.created_at;
  maybeStampProjectsUpdatedAt(table, row);
  const keys = Object.keys(row);
  assertColumns(table, keys);
  assertColumns(table, conflictKeys);
  const values = keys.map((k) => serializeValue(k, row[k]));
  const placeholders = keys.map(() => "?").join(", ");
  const updateClauses = keys
    .filter((k) => !conflictKeys.includes(k))
    .map((k) => `"${k}" = excluded."${k}"`);

  runExec(
    `INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(", ")}) VALUES (${placeholders})
     ON CONFLICT (${conflictKeys.map((k) => `"${k}"`).join(", ")}) DO UPDATE SET ${updateClauses.join(", ")}`,
    values,
  );

  const rows = runQuery(`SELECT * FROM "${table}" WHERE id = ?`, [row.id]);
  return rows.length > 0 ? deserializeRow(rows[0])! : row;
}
