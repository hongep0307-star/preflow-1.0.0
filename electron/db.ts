import Database from "better-sqlite3";

let db: Database.Database | null = null;
let dbPath = "";

export function getDb(): Database.Database {
  if (!db) throw new Error("Database not initialized");
  return db;
}

// Kept as a no-op for backwards compatibility with call sites that used to
// flush the in-memory sql.js database. better-sqlite3 persists every write
// synchronously, so there is nothing to do here.
export function saveDb(): void {
  // intentionally empty
}

export function closeDb(): void {
  if (!db) return;
  // 닫기 직전 WAL 을 본 DB 파일로 합치고 -wal 을 비운다(TRUNCATE). OneDrive
  // 같은 파일 동기화 서비스는 preflow.db / -wal / -shm 을 각각 따로, 지연을
  // 두고 올린다 — 인계 시점에 -wal 만 먼저(혹은 나중에) 동기화되면 다른 PC 가
  // 일관성이 깨진 상태를 읽어 손상된다. 체크포인트로 단일 파일만 동기화 대상에
  // 남겨 이 위험을 제거한다. 로컬 워크스페이스에도 무해(no-op 에 가까움).
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch (err) {
    console.warn("[DB] wal_checkpoint(TRUNCATE) before close failed:", err);
  }
  try {
    db.close();
  } catch (err) {
    console.error("[DB] close failed:", err);
  }
  db = null;
  dbPath = "";
}

export function getDbFilePath(): string {
  return dbPath;
}

export interface OpenDatabaseOptions {
  /** true 면 schema 만 생성하고 즉시 close. 활성 DB 핸들(`db`) 을 건드리지
   *  않는다 — 새 워크스페이스 생성 시 비어 있는 폴더에 schema 를 미리
   *  찍어두는 용도. */
  createOnly?: boolean;
}

/** 주어진 경로에서 SQLite 를 연다.
 *  - createOnly = false: 현재 활성 DB 를 닫고 그 자리에 새 DB 를 연다.
 *    (워크스페이스 활성 전환 / 부팅 시 활성 워크스페이스 진입)
 *  - createOnly = true: 임시 핸들로 schema 만 찍고 닫는다. 활성 DB 핸들은
 *    그대로 유지. 새 워크스페이스를 만들 때 부트스트랩 용. */
export async function openDatabaseAt(
  filePath: string,
  opts: OpenDatabaseOptions = {},
): Promise<void> {
  if (opts.createOnly) {
    const tmpDb = new Database(filePath);
    tmpDb.pragma("journal_mode = WAL");
    tmpDb.pragma("synchronous = NORMAL");
    tmpDb.pragma("foreign_keys = ON");
    tmpDb.pragma("busy_timeout = 5000");
    try {
      createTables(tmpDb);
    } finally {
      try {
        tmpDb.close();
      } catch (err) {
        console.warn("[DB] createOnly close failed:", err);
      }
    }
    return;
  }

  if (db) {
    try {
      db.close();
    } catch (err) {
      console.error("[DB] close-before-reopen failed:", err);
    }
    db = null;
  }
  console.log("[DB] Path:", filePath);
  db = new Database(filePath);
  // WAL gives us crash-safe durability while keeping writes fast.
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  // Phase 2.1: WAL 체크포인트 / 외부 SQLite 도구 (CLI dump 등) 와의 잠깐
  // 충돌에서 SQLITE_BUSY 가 즉시 throw 되던 것을, 5 초까지 자동 재시도하도록.
  // 단일 connection + 동기 API 라 일반 경로에선 발사되지 않지만, 안전망으로.
  db.pragma("busy_timeout = 5000");
  dbPath = filePath;
  createTables(db);
  console.log("[DB] Initialized successfully (better-sqlite3)");
}

function createTables(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      user_id TEXT DEFAULT 'local',
      title TEXT NOT NULL DEFAULT '',
      client TEXT,
      deadline TEXT,
      status TEXT DEFAULT 'active',
      video_format TEXT DEFAULT 'vertical',
      active_version_id TEXT,
      folder_id TEXT,
      conti_style_id TEXT,
      thumbnail_url TEXT,
      thumbnail_crop TEXT,
      is_favorite INTEGER DEFAULT 0,
      last_visited_at TEXT,
      updated_at TEXT,
      deleted_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  try {
    d.exec(`ALTER TABLE projects ADD COLUMN thumbnail_crop TEXT`);
  } catch (_) { /* column already exists */ }

  // deleted_at: 프로젝트 휴지통(soft delete) 의 데이터 소스. NULL = 정상,
  // ISO 8601 문자열 = 휴지통에 들어간 시각. 대시보드 목록/카운트/최근항목/
  // 워크스페이스 카운트는 모두 deleted_at IS NULL 만 집계하고, 휴지통 뷰만
  // deleted_at 이 있는 행을 보여준다. 사용자가 휴지통에서 "영구 삭제" 하면
  // 그때 비로소 실제 DELETE 가 일어난다. 옛 DB 호환용 idempotent ALTER.
  try {
    d.exec(`ALTER TABLE projects ADD COLUMN deleted_at TEXT`);
  } catch (_) { /* column already exists */ }

  // 대시보드 사이드바 FAVORITES 섹션의 데이터 소스. 0/1 정수로 저장해
  // SQLite WHERE 조건에서 인덱스 친화적으로 필터할 수 있게 한다. 기본 0.
  try {
    d.exec(`ALTER TABLE projects ADD COLUMN is_favorite INTEGER DEFAULT 0`);
  } catch (_) { /* column already exists */ }

  // 대시보드 사이드바 RECENT 섹션의 정렬 키. ProjectPage 진입 시 1 분
  // throttle 로 갱신하므로, datetime('now') 같은 SQL 기본값은 두지 않고
  // 클라이언트가 명시적으로 ISO 8601 문자열을 채우는 정책.
  try {
    d.exec(`ALTER TABLE projects ADD COLUMN last_visited_at TEXT`);
  } catch (_) { /* column already exists */ }

  // updated_at: "마지막으로 의미 있는 수정이 일어난 시각". 그리드/리스트 카드
  // 썸네일 호버 시 표시되는 "X 분 전" 라벨의 데이터 소스. 의도적으로
  // last_visited_at 과 분리 — 그냥 둘러보러 들어온 것은 "수정"이 아니다.
  // 갱신 경로는 두 가지:
  //   1) 자식 테이블(scenes / briefs / scene_versions / assets)에 INSERT/UPDATE/
  //      DELETE 가 일어나면 트리거가 부모 projects.updated_at 을 자동 bump
  //   2) projects 자체의 콘텐츠 컬럼(title/deadline/thumbnail_crop 등)을
  //      dbUpdate 로 직접 바꾸면 db-utils 가 자동 bump (tracking 컬럼 제외)
  try {
    d.exec(`ALTER TABLE projects ADD COLUMN updated_at TEXT`);
  } catch (_) { /* column already exists */ }

  // 기존 행은 updated_at 이 NULL 이라 "수정 정보 없음" 으로 보이는 게 맞지만,
  // 그러면 호버 라벨이 비어 있어 어색하다. 한 번만 합리적 기본값으로 채워
  // 사용자가 첫 화면을 봤을 때 시간이 표시되도록 한다 (idempotent — 이후
  // 새 NULL 이 생기지 않으므로 매번 같은 결과).
  d.exec(`
    UPDATE projects
       SET updated_at = COALESCE(last_visited_at, created_at)
     WHERE updated_at IS NULL
  `);

  // 자식 테이블 → projects.updated_at 자동 갱신 트리거는 함수 끝(모든 CREATE
  // TABLE 이 끝난 다음) 에서 한꺼번에 만든다. 트리거가 참조하는 자식 테이블
  // (scenes / briefs / scene_versions / assets) 이 아직 만들어지기 전이라면
  // SQLite 가 `no such table: main.<자식>` 으로 throw 해 함수 전체를 멈춰
  // 버리고, 그 뒤에 정의된 후순위 테이블(`folders` 등) 이 영원히 만들어지지
  // 않는 버그가 났다. 워크스페이스 기능 도입 후 fresh DB 가 생기는 경로가
  // 늘어나면서 이 순서 의존성이 노출됐다.

  d.exec(`
    CREATE TABLE IF NOT EXISTS briefs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      raw_text TEXT,
      analysis TEXT,
      analysis_en TEXT,
      mood_image_urls TEXT,
      mood_bookmarks TEXT,
      lang TEXT DEFAULT 'ko',
      source_type TEXT,
      image_urls TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);

  try {
    d.exec(`ALTER TABLE briefs ADD COLUMN raw_text TEXT`);
  } catch (_) { /* column already exists */ }

  // ── brief_attachments ────────────────────────────────────────────
  // 브리프 composer / 레퍼런스 패널에 사용자가 직접 올린 자료(이미지·PDF·
  // 비디오·YouTube 링크·메모 등)의 영구 저장 대상.
  //
  // 왜 별도 테이블인가:
  //   - 기존에는 이 자료들이 모두 localStorage(`ff_brief_draft_*`) 에만
  //     base64 로 떠있어서 ① quota 초과 시 묵시적 폐기 ② 프로젝트 export
  //     누락 ③ 새 디바이스/profile 에서 영구 손실 — 세 경로의 데이터 손실이
  //     발생했다.
  //   - 분석 결과를 담는 `briefs` 테이블에 컬럼을 더 붙이는 대안도 있지만,
  //     첨부물은 1:N 이고 라이프사이클(개별 추가/삭제/정렬)이 분석 결과와
  //     달라서 별도 행으로 1등 시민화하는 게 정합성에 유리.
  //
  // 필드 의미:
  //   - kind: 'image' | 'pdf' | 'video' | 'youtube' | 'note'
  //   - role: 'brief' = composer 자료 / 'reference' = 레퍼런스 패널 자료
  //   - file_url: 디스크 영속화된 storage URL (image/pdf/video 본체). NULL =
  //     binary 가 없는 종류 (youtube/note).
  //   - poster_url: video 의 포스터 썸네일 (별도 파일).
  //   - external_url: YouTube 등 외부 호스팅 URL.
  //   - extracted_text: PDF 텍스트 추출 결과(이미 raw_text 로도 흡수되지만
  //     첨부 단위 보존을 위해 함께 보관).
  //   - annotation: JSON. 레퍼런스 패널 항목의 timestamp/note 등.
  //   - origin_reference_id: 라이브러리에서 attach 된 항목인 경우의 원본
  //     reference_items.id (라이브러리 항목 삭제는 별개의 라이프사이클).
  //
  // CASCADE: 프로젝트 삭제 시 자동 정리. storage 디스크 파일은 orphan sweep
  // 가 file_url/poster_url 미참조 시점에 청소.
  d.exec(`
    CREATE TABLE IF NOT EXISTS brief_attachments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'brief',
      file_url TEXT,
      poster_url TEXT,
      external_url TEXT,
      filename TEXT,
      mime_type TEXT,
      size_bytes INTEGER,
      width INTEGER,
      height INTEGER,
      duration_sec REAL,
      page_count INTEGER,
      extracted_text TEXT,
      annotation TEXT,
      display_order INTEGER DEFAULT 0,
      origin_reference_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS scenes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      scene_number INTEGER NOT NULL,
      sequence INTEGER,
      title TEXT,
      description TEXT,
      camera_angle TEXT,
      location TEXT,
      mood TEXT,
      duration_sec REAL,
      tagged_assets TEXT DEFAULT '[]',
      conti_image_url TEXT,
      conti_image_history TEXT DEFAULT '[]',
      source TEXT DEFAULT 'agent',
      conti_image_crop TEXT,
      is_transition INTEGER DEFAULT 0,
      is_final INTEGER DEFAULT 0,
      is_highlight INTEGER DEFAULT 0,
      highlight_kind TEXT,
      highlight_reason TEXT,
      transition_type TEXT,
      sketches TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);

  // sketches: per-scene composition candidates generated in ContiStudio's Sketches tab.
  // JSON array of { id, url, model, createdAt, liked? }. Tied to the scene row's
  // lifecycle via FK cascade — delete the scene, the sketches go with it.
  // Idempotent ALTER for legacy DBs created before this column existed.
  try {
    d.exec(`ALTER TABLE scenes ADD COLUMN sketches TEXT DEFAULT '[]'`);
  } catch (_) { /* column already exists */ }

  // is_final: user-confirmed completion marker for dashboard progress and
  // automatic project status sync. Legacy local DBs need this migration.
  try {
    d.exec(`ALTER TABLE scenes ADD COLUMN is_final INTEGER DEFAULT 0`);
  } catch (_) { /* column already exists */ }

  // Highlight: soft key-visual marker used by prompt generation. Optional
  // fields so legacy scenes keep rendering even before the user marks any.
  try {
    d.exec(`ALTER TABLE scenes ADD COLUMN is_highlight INTEGER DEFAULT 0`);
  } catch (_) { /* column already exists */ }
  try {
    d.exec(`ALTER TABLE scenes ADD COLUMN highlight_kind TEXT`);
  } catch (_) { /* column already exists */ }
  try {
    d.exec(`ALTER TABLE scenes ADD COLUMN highlight_reason TEXT`);
  } catch (_) { /* column already exists */ }

  // sequence: 씬(scene group) 번호. 같은 장소·시간·비트의 컷들을 묶는 1-based 정수.
  // scene_number(=컷 번호)와 별개. 레거시 DB 를 위한 idempotent ALTER.
  try {
    d.exec(`ALTER TABLE scenes ADD COLUMN sequence INTEGER`);
  } catch (_) { /* column already exists */ }

  // camera_variation_grid: 카메라 베리에이션 9분할 그리드의 영구 저장.
  // JSON { rawUrl, generatedAt } — rawUrl 은 스토리지에 저장된 3×3 그리드 이미지.
  // 새로고침 후에도 모달이 rawUrl 을 다시 9분할해 타일을 복원한다(타일 자체는
  // 저장하지 않아 DB 비대화를 피함). 씬 행 lifecycle 에 묶임(FK cascade).
  try {
    d.exec(`ALTER TABLE scenes ADD COLUMN camera_variation_grid TEXT`);
  } catch (_) { /* column already exists */ }

  d.exec(`
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      asset_type TEXT DEFAULT 'character',
      tag_name TEXT NOT NULL,
      photo_url TEXT,
      ai_description TEXT,
      outfit_description TEXT,
      role_description TEXT,
      space_description TEXT,
      signature_items TEXT,
      photo_crop TEXT,
      source_type TEXT DEFAULT 'upload',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);

  try {
    d.exec(`ALTER TABLE assets ADD COLUMN source_type TEXT DEFAULT 'upload'`);
  } catch (_) { /* column already exists */ }

  // photo_crop was added later for the FocalEditor (profile-image drag + zoom).
  // Existing DBs created before that addition don't have the column, so UPDATEs
  // silently fail and any saved focal point vanishes on reload. Idempotent
  // ALTER for those legacy DBs; no-op otherwise.
  try {
    d.exec(`ALTER TABLE assets ADD COLUMN photo_crop TEXT`);
  } catch (_) { /* column already exists */ }

  // photo_variations: stores per-framing alternate views for `background` assets
  // (wide / medium / close / detail / alt). Generated on-demand from the
  // primary photo_url via the background_variations IPC, then used at scene
  // gen time to select the framing-matched reference image instead of always
  // forcing the same wide composition into close-up scenes. JSON-encoded
  // array of { url, framing, caption?, generated_at }. Optional column —
  // backgrounds without variations fall back to photo_url as before.
  try {
    d.exec(`ALTER TABLE assets ADD COLUMN photo_variations TEXT`);
  } catch (_) { /* column already exists */ }

  // character_sheet_url: 16:9 turnaround / face-grid reference sheet generated
  // by NB2 from the character's photo_url. Conti generation prefers this over
  // photo_url so the model has a multi-angle identity anchor.
  // character_sheet_generated_at: ISO timestamp of last successful generation.
  // character_sheet_source_url: snapshot of the photo_url that was used at
  // generation time. When the user replaces photo_url later, the diff signals
  // the sheet is "stale" and the UI offers a Regenerate prompt. All three are
  // optional — characters without a sheet fall back to photo_url as before.
  try {
    d.exec(`ALTER TABLE assets ADD COLUMN character_sheet_url TEXT`);
  } catch (_) { /* column already exists */ }
  try {
    d.exec(`ALTER TABLE assets ADD COLUMN character_sheet_generated_at TEXT`);
  } catch (_) { /* column already exists */ }
  try {
    d.exec(`ALTER TABLE assets ADD COLUMN character_sheet_source_url TEXT`);
  } catch (_) { /* column already exists */ }

  // use_character_sheet: temporary off-switch that suppresses sheet usage in
  // conti / inpaint without deleting the file. NULL or 1 = enabled (default
  // for legacy rows), 0 = disabled. Lets the user A/B test the sheet against
  // photo_url for one character without losing 30-90s of regeneration if
  // they want it back. Conti pipeline reads `use_character_sheet !== false`
  // so the NULL default keeps existing assets behaving as before.
  try {
    d.exec(`ALTER TABLE assets ADD COLUMN use_character_sheet INTEGER`);
  } catch (_) { /* column already exists */ }

  // character_sheet_style: legacy single-slot marker ('sheet' | 'board').
  // Superseded by the separate sheet/board columns below + character_ref_mode,
  // but kept so old rows / project packs still import cleanly.
  try {
    d.exec(`ALTER TABLE assets ADD COLUMN character_sheet_style TEXT`);
  } catch (_) { /* column already exists */ }

  // character_board_*: the AAA design-bible board, persisted INDEPENDENTLY of
  // the turnaround sheet so a character can keep BOTH the last sheet and the
  // last board at once (the portrait `photo_url` is always preserved too).
  // Mirrors the character_sheet_* trio: url + generated_at + source snapshot.
  try {
    d.exec(`ALTER TABLE assets ADD COLUMN character_board_url TEXT`);
  } catch (_) { /* column already exists */ }
  try {
    d.exec(`ALTER TABLE assets ADD COLUMN character_board_generated_at TEXT`);
  } catch (_) { /* column already exists */ }
  try {
    d.exec(`ALTER TABLE assets ADD COLUMN character_board_source_url TEXT`);
  } catch (_) { /* column already exists */ }

  // character_ref_mode: which reference the conti pipeline feeds for this
  // character — 'original' (photo_url), 'sheet' (character_sheet_url), or
  // 'board' (character_board_url). NULL = legacy rows: derived at runtime from
  // use_character_sheet (sheet if present & enabled, else original).
  try {
    d.exec(`ALTER TABLE assets ADD COLUMN character_ref_mode TEXT`);
  } catch (_) { /* column already exists */ }

  // Promote-to-Asset: 라이브러리 자료를 자산(assets) 으로 승격하면 asset 측에는
  // 어떤 reference 에서 비롯됐는지를 단일 id 로 남긴다. reference 측의 대응
  // 컬럼(`promoted_asset_ids`) 은 CREATE TABLE reference_items 의 컬럼 정의에
  // 처음부터 포함되어 있고, 옛 DB 의 ALTER 는 그 CREATE 뒤에서 처리한다 —
  // ALTER 를 CREATE 보다 앞에 두면 fresh DB 에서 throw 가 try/catch 로
  // swallow 되어 컬럼이 영구 누락되는 사고가 났다. 그 학습 비용 때문에
  // ALTER 들은 항상 자기 테이블의 CREATE 뒤로만 둔다.
  try {
    d.exec(`ALTER TABLE assets ADD COLUMN source_reference_id TEXT`);
  } catch (_) { /* column already exists */ }

  d.exec(`
    CREATE TABLE IF NOT EXISTS scene_versions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      version_name TEXT,
      scenes TEXT DEFAULT '[]',
      display_order INTEGER,
      is_active INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS style_presets (
      id TEXT PRIMARY KEY,
      user_id TEXT DEFAULT 'local',
      name TEXT NOT NULL,
      description TEXT,
      reference_image_urls TEXT,
      style_prompt TEXT,
      thumbnail_url TEXT,
      is_default INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS chat_logs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      images TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);

  // chat_logs.images: 채팅 첨부 이미지의 영속 URL 배열(JSON). 전송 시 'chat'
  // 버킷에 업로드된 스토리지 URL 을 저장해 새로고침/재마운트 후에도 미리보기를
  // 복원한다. 레거시 DB 마이그레이션.
  try {
    d.exec(`ALTER TABLE chat_logs ADD COLUMN images TEXT DEFAULT '[]'`);
  } catch (_) { /* column already exists */ }

  d.exec(`
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      user_id TEXT DEFAULT 'local',
      name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // ── canvas_layouts ───────────────────────────────────────────────
  // Library Canvas 뷰의 폴더별 자유 배치 레이아웃. 과거에는 렌더러
  // localStorage 에만 있어 *PC 마다 따로* 였다 — OneDrive 로 워크스페이스
  // 폴더를 공유해도 캔버스 배치/노트/연결선은 건너가지 않는 누락이 있었다.
  // 워크스페이스 DB(=워크스페이스 폴더 안의 preflow.db) 로 승격해 같은 폴더를
  // 연결한 모든 PC 가 동일한 "공유 레이아웃" 을 보게 한다.
  //   - context_key: `tag:folder:<path>` 형태(canvasLayout.folderContextKey).
  //   - layout: CanvasLayout 전체를 JSON 직렬화한 문자열.
  //   - updated_at: 마지막 저장 시각(ISO 8601). 충돌 진단/디버그용.
  d.exec(`
    CREATE TABLE IF NOT EXISTS canvas_layouts (
      context_key TEXT PRIMARY KEY,
      layout TEXT NOT NULL,
      updated_at TEXT
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS reference_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      file_url TEXT,
      thumbnail_url TEXT,
      mime_type TEXT,
      file_size INTEGER,
      content_hash TEXT,
      duration_sec REAL,
      width INTEGER,
      height INTEGER,
      tags TEXT DEFAULT '[]',
      notes TEXT,
      rating INTEGER,
      is_favorite INTEGER DEFAULT 0,
      source_url TEXT,
      cover_at_sec REAL,
      timestamp_notes TEXT DEFAULT '[]',
      color_palette TEXT DEFAULT '[]',
      ai_suggestions TEXT,
      classification_status TEXT DEFAULT 'unclassified',
      classified_at TEXT,
      origin_project_id TEXT,
      source_app TEXT,
      source_library TEXT,
      source_id TEXT,
      imported_at TEXT,
      pinned_at TEXT,
      deleted_at TEXT,
      promoted_asset_ids TEXT,
      variation_of TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT,
      last_used_at TEXT,
      FOREIGN KEY (origin_project_id) REFERENCES projects(id) ON DELETE SET NULL
    )
  `);

  // 옛 DB 호환 — CREATE 가 IF NOT EXISTS 라 컬럼 추가는 별도 ALTER 로.
  try {
    d.exec(`ALTER TABLE reference_items ADD COLUMN pinned_at TEXT`);
  } catch (_) { /* column already exists */ }
  try {
    d.exec(`ALTER TABLE reference_items ADD COLUMN deleted_at TEXT`);
  } catch (_) { /* column already exists */ }
  // promoted_asset_ids 는 본래 라인 309 의 ALTER 위치(reference_items 가
  // 아직 CREATE 안 됨)에 있다가 fresh DB 에서 silently fail 하던 컬럼.
  // CREATE 뒤로 옮겨 옛 DB 의 마이그레이션 보장.
  try {
    d.exec(`ALTER TABLE reference_items ADD COLUMN promoted_asset_ids TEXT`);
  } catch (_) { /* column already exists */ }
  // AI 베리에이션으로 생성된 항목이 가리키는 원본 reference id. 빠른 필터/
  // 뱃지/"원본 보기" 의 단일 근거. 옛 DB 호환을 위해 ALTER 로 추가.
  try {
    d.exec(`ALTER TABLE reference_items ADD COLUMN variation_of TEXT`);
  } catch (_) { /* column already exists */ }

  d.exec(`
    CREATE TABLE IF NOT EXISTS project_reference_links (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      reference_id TEXT NOT NULL,
      target TEXT NOT NULL,
      annotation TEXT,
      time_range TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (reference_id) REFERENCES reference_items(id) ON DELETE CASCADE
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS saved_filters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      query TEXT DEFAULT '{}',
      source_app TEXT,
      source_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT
    )
  `);

  // Storyboard sheet test artifacts (Sheet test gallery). Each row is one
  // generated multi-panel sheet kept in the `mood` bucket; scene_ids is the
  // ordered panel→scene mapping used by "apply to conti". Referenced by
  // orphanSweep so the files survive cleanup.
  d.exec(`
    CREATE TABLE IF NOT EXISTS storyboard_sheets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      url TEXT NOT NULL,
      size_used TEXT,
      cut_count INTEGER,
      cols INTEGER,
      rows INTEGER,
      scene_ids TEXT,
      video_format TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);

  // video_format: 시트가 생성될 당시의 프로젝트 포맷(horizontal/vertical/square).
  // 셀이 그 포맷 비율로 배치돼 있으므로, 나중에 프로젝트 포맷이 바뀐 채로 시트를
  // "콘티에 적용"하면 NB2 reframe 이 컷 콘텐츠를 잘라낸다. 적용부에서 이 값과
  // 현재 포맷을 비교해 불일치 시 재생성을 유도한다. 옛 DB 호환용 idempotent ALTER.
  try {
    d.exec(`ALTER TABLE storyboard_sheets ADD COLUMN video_format TEXT`);
  } catch (_) { /* column already exists */ }

  // Indexes — every read path filters by project_id; chat history orders by
  // created_at; scenes are sorted by scene_number per project. Keeping the
  // indexes here is idempotent (CREATE INDEX IF NOT EXISTS).
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_briefs_project_id        ON briefs(project_id);
    CREATE INDEX IF NOT EXISTS idx_scenes_project_number    ON scenes(project_id, scene_number);
    CREATE INDEX IF NOT EXISTS idx_assets_project_id        ON assets(project_id);
    CREATE INDEX IF NOT EXISTS idx_scene_versions_project   ON scene_versions(project_id);
    CREATE INDEX IF NOT EXISTS idx_chat_logs_project_time   ON chat_logs(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_projects_folder_id       ON projects(folder_id);
    CREATE INDEX IF NOT EXISTS idx_projects_deleted_at       ON projects(deleted_at);
    CREATE INDEX IF NOT EXISTS idx_reference_items_kind     ON reference_items(kind);
    CREATE INDEX IF NOT EXISTS idx_reference_items_hash     ON reference_items(content_hash);
    CREATE INDEX IF NOT EXISTS idx_reference_items_created  ON reference_items(created_at);
    CREATE INDEX IF NOT EXISTS idx_reference_items_used     ON reference_items(last_used_at);
    CREATE INDEX IF NOT EXISTS idx_reference_items_pinned   ON reference_items(pinned_at);
    CREATE INDEX IF NOT EXISTS idx_reference_items_deleted  ON reference_items(deleted_at);
    CREATE INDEX IF NOT EXISTS idx_reference_items_source   ON reference_items(source_app, source_library, source_id);
    CREATE INDEX IF NOT EXISTS idx_project_refs_project     ON project_reference_links(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_refs_reference   ON project_reference_links(reference_id);
    CREATE INDEX IF NOT EXISTS idx_assets_source_reference  ON assets(source_reference_id);
    CREATE INDEX IF NOT EXISTS idx_brief_atts_project       ON brief_attachments(project_id);
    CREATE INDEX IF NOT EXISTS idx_brief_atts_role          ON brief_attachments(project_id, role);
    CREATE INDEX IF NOT EXISTS idx_brief_atts_origin_ref    ON brief_attachments(origin_reference_id);
    CREATE INDEX IF NOT EXISTS idx_storyboard_sheets_project ON storyboard_sheets(project_id, created_at);
  `);

  // ── projects.updated_at bump triggers ──
  // 모든 CREATE TABLE 이 끝난 뒤에만 실행한다. CASCADE DELETE 시점에는 부모
  // 행이 아직 살아 있어 UPDATE 가 1 행 매칭되긴 하나 곧 같이 삭제되므로
  // 사실상 no-op (성능 영향 미미). chat_logs 는 채팅 한 마디가 "수정"으로
  // 잡히는 게 너무 시끄러워 의도적으로 트리거 없음. 모두 IF NOT EXISTS
  // 로 idempotent.
  const childTablesForUpdatedAt = ["scenes", "briefs", "scene_versions", "assets", "brief_attachments"] as const;
  for (const tbl of childTablesForUpdatedAt) {
    d.exec(`
      CREATE TRIGGER IF NOT EXISTS ${tbl}_bump_project_updated_at_ai
      AFTER INSERT ON ${tbl}
      BEGIN
        UPDATE projects
           SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = NEW.project_id;
      END;
    `);
    d.exec(`
      CREATE TRIGGER IF NOT EXISTS ${tbl}_bump_project_updated_at_au
      AFTER UPDATE ON ${tbl}
      BEGIN
        UPDATE projects
           SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = NEW.project_id;
      END;
    `);
    d.exec(`
      CREATE TRIGGER IF NOT EXISTS ${tbl}_bump_project_updated_at_ad
      AFTER DELETE ON ${tbl}
      BEGIN
        UPDATE projects
           SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = OLD.project_id;
      END;
    `);
  }
}
