# Workspace + Project Pack — Round-trip Verification

워크스페이스 폴더 모델과 `.preflowproj` 팩이 의도한 대로 작동하는지 사람이 직접 한 번씩 거쳐 보는 체크리스트. 자동화 e2e 가 없는 단계이므로, 큰 변경 후 (특히 `electron/workspace.ts`, `electron/projPackImport.ts`, `electron/local-server.ts` 워크스페이스 라우트, `WorkspaceSwitcher.tsx`) 한 번씩 통째로 굴려 회귀를 잡는다.

## 0. 사전 준비

- 두 PC 시뮬: 한 PC 만 있어도 OneDrive 폴더(또는 임시로 다른 `userData` 디렉터리)를 같은 워크스페이스 폴더에 mount 하는 형태로 흉내 낼 수 있다.
- 깨끗한 default 워크스페이스에서 시작하는 것을 권장 — 기존 데이터가 남아 있으면 충돌/이름 변경 케이스가 가려진다.
- UI 언어를 EN ↔ KO 한 번씩 토글해 보며 새 카피가 모두 들어왔는지 같이 확인.

## 1. 워크스페이스 라이프사이클

### 1.1 새 프로젝트 워크스페이스 생성

1. 좌하단 워크스페이스 스위처 ▾ → "Add Workspace…"
2. Type = Projects, Name = "Round-trip A"
3. "Choose Folder & Create" → 빈 디렉터리 선택 (예: `D:\preflow-test\rtA`)
4. **확인:**
   - 다이얼로그가 닫히고 자동으로 새 워크스페이스로 활성 전환된다 (페이지 reload).
   - 사이드바 풋터의 워크스페이스 이름이 "Round-trip A".
   - 좌상단 라벨도 "Round-trip A" 로 변경.
   - 선택한 폴더에 `preflow.db`, `storage/`, `.preflow-workspace.json`, `.preflow-lock` 이 생성된다.
   - 스위처 popover 행 서브타이틀: `0 projects · D:\preflow-test\rtA`.

### 1.2 라이브러리 워크스페이스 생성 + 전환

1. 동일하게 Type = Library, Name = "Round-trip Lib" 로 생성.
2. **확인:** 자동으로 라이브러리 화면으로 전환되고, 좌상단/풋터/스위처 모두 "Round-trip Lib" 표기.

### 1.3 Show in Explorer

1. 스위처 popover 에서 "Round-trip A" 행의 ⋯ 메뉴 → "Show in Explorer".
2. **확인:** Windows 탐색기가 해당 폴더(또는 부모 폴더에서 폴더 선택 상태)로 열린다.

### 1.4 Rename

1. ⋯ → "Rename…" → "Round-trip A2" → Save.
2. **확인:** 트리거/풋터/스위처 행의 이름이 즉시 갱신.
3. 폴더 안 `.preflow-workspace.json` 도 다음 활성화 시점에 갱신되는지 확인 (현재는 active 폴더 layout 보장 시점에만 다시 쓰는 best-effort — 핵심 진실은 `workspaces.json` 레지스트리).

### 1.5 Disconnect (= 폴더 보존, 레지스트리에서만 제거)

1. 비활성 워크스페이스("Round-trip Lib")의 ⋯ → "Disconnect from this PC".
2. **확인:**
   - 다이얼로그 본문이 "폴더는 그대로 둠" 류 카피.
   - 확인 후 popover 에서 사라진다.
   - 디스크의 `D:\preflow-test\…` 폴더는 그대로 남아 있다.
3. 같은 폴더를 "Add Workspace…" → "Open existing folder…" 로 다시 등록 → 카운트가 보존돼 있는지 확인.

### 1.6 Delete (= 폴더까지 영구 삭제)

1. 새 임시 워크스페이스를 만들어 비활성으로 둔다.
2. ⋯ → "Delete permanently" → "Delete Permanently".
3. **확인:**
   - 다이얼로그 본문이 "되돌릴 수 없음" 카피.
   - 디스크에서 폴더가 사라진다 (열려 있는 핸들 때문에 실패하면 Folder couldn't be removed: … 토스트 등장).

### 1.7 Active workspace 보호

- 현재 활성 워크스페이스 행에서 Disconnect / Delete 항목이 disabled 인지 확인.
- HTTP 레벨에서 강제 호출해도 `cannot ... the currently active workspace` 400 으로 막힘 (`local-server.ts` `handleWorkspaceDisconnect/Delete`).

### 1.8 락 충돌 (다른 PC 시뮬)

1. 같은 폴더를 **두 번째 인스턴스** 가 점유하도록 흉내낸다 — 가장 단순한 방법: dev 인스턴스 두 개를 띄우고 둘 다 같은 OneDrive 폴더를 활성화.
2. 두 번째 인스턴스에서 해당 워크스페이스로 전환 시도.
3. **확인:**
   - "Workspace is in use" 다이얼로그가 뜬다.
   - PID / hostname / acquiredAt 표시.
   - "Force open anyway" 누르면 takeover 가 일어나거나, 여전히 점유 중이면 "Still locked…" 안내가 뜬다.
4. 두 인스턴스 동시 쓰기는 SQLite WAL 손상 위험이 있으니 Force 는 정말 필요할 때만.

## 2. 프로젝트 팩(.preflowproj) round-trip

### 2.1 단일 프로젝트 export

1. "Round-trip A2" 활성 상태에서 새 프로젝트 1~2 개 생성, 콘티/에셋/레퍼런스 링크 한두 개씩 붙여 둔다.
2. 프로젝트 카드 ⋯ → "Export project…".
3. 다이얼로그에서 Pack name 그대로, Include media + Include linked references 둘 다 ON.
4. Save → 임시 폴더로 저장.
5. **확인:**
   - 토스트 "Project pack exported" + 프로젝트/레퍼런스 개수.
   - `.preflowproj` 파일 생성. ZIP 으로 열어 `manifest.json`, `projects.json`, `assets.json`, `files/...` 가 들어 있는지 확인.

### 2.2 워크스페이스 전체 export

1. 메인바 "Workspace ▾" → "Export workspace…".
2. **확인:** 같은 흐름이지만 `manifest.scope = "workspace"`, `project_count = N`.

### 2.3 metadata-only export

1. Include media files 체크 해제 후 Save.
2. **확인:**
   - 다이얼로그 안에 노란 경고 박스("미디어 파일 없음") 등장.
   - ZIP 안에 `files/` 가 비어 있어도 `*.json` 만으로 정상 임포트 가능.

### 2.4 import 미리보기

1. 다른 (혹은 같은) 워크스페이스에서 "Workspace ▾" → "Import project…" → "Choose Pack…" → 위에서 만든 `.preflowproj` 선택.
2. **확인:**
   - Scope/Projects/Size 통계.
   - References 행에 "N reference snapshot(s) embedded" 또는 "No reference snapshots".
   - Project titles 그리드 — 같은 이름이 이미 있으면 노란 칩 + `→ (n)` 표시.
   - missing files 가 있으면 노란 박스 안내.

### 2.5 import 적용

1. "Import" 클릭.
2. **확인:**
   - 토스트: "Project pack imported" + 프로젝트/레퍼런스/파일 개수, 이름 충돌이 있었다면 "({n} renamed to avoid title collision)" 접미사.
   - Dashboard 에 새 프로젝트가 추가됨 — ID 는 모두 새로 발급, 같은 제목은 `(2)` 등 suffix.
   - 콘티 이미지/에셋 썸네일이 정상 노출 (URL 재작성이 제대로 됐다는 신호).
   - 라이브러리 → All Items 에 import 된 reference 가 추가됐는지 (Include references 가 ON 이었다면).

### 2.6 cross-PC simulation

1. PC A 의 `.preflowproj` 를 OneDrive/USB 로 PC B 에 옮긴다.
2. PC B 에서 새 워크스페이스를 만들어 활성화한 뒤 import.
3. **확인:** 모든 미디어가 새 워크스페이스의 `storage/` 아래로 복사되고 보임. 원본 워크스페이스의 데이터는 손대지 않는다.

### 2.7 드래그 드롭 import

1. Dashboard 위에 `.preflowproj` 파일을 직접 드래그.
2. **확인:**
   - 페이지 둘레에 primary 색 ring 이 잠시 등장.
   - import 다이얼로그가 자동으로 미리보기 채워진 채 열린다.

## 3. UI 언어 토글

- Settings → UI Language 를 EN ↔ KO 로 토글하며 위 1, 2 시나리오의 다이얼로그/메뉴/토스트 카피가 모두 즉시 따라 바뀌는지 확인.
- 특히 새로 추가된 키들 (`workspace.add.*`, `workspace.remove.*`, `workspace.lock.*`, `projPack.export.*`, `projPack.import.*`, `dashboard.exportProject` / `dashboard.workspaceMenu` 등) 이 누락 없이 매핑되는지.

## 4. 해 봐야 할 회귀 케이스 (자주 깨지는 곳)

- 활성 워크스페이스 전환 직후 라이브러리 → 프로젝트 → 라이브러리 등 라우트 전환 시 좌하단 빨간 점이 항상 현재 화면 짝의 워크스페이스에 붙는지.
- import 후 콘티 이미지가 "URL not found" 로 깨지지 않는지 (ID 리맵이 본문 JSON 안의 storage URL 까지 도달했는지).
- export 시 `assets.source_reference_id` 가 살아 있는 채로 직렬화되는지 — Promote-to-Asset 으로 만들어진 에셋이 import 후에도 출처 reference 와 묶여 있는지.
- 같은 폴더에 두 워크스페이스를 등록하려 시도하면 `registerWorkspace` 가 거부하는지 (스위처 다이얼로그에 에러 메시지로 뜸).
