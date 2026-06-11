# Mac build notes

## `hardenedRuntime: false` (현재 설정)

`package.json` 의 `build.mac.hardenedRuntime` 를 `false` 로 둔 이유:

- Apple Developer ID **codesign + notarization** 파이프라인이 아직 없다.
- 서명 없는 빌드에서 `hardenedRuntime: true` 면 macOS 가 매 reload (= workspace
  switch) 시점에 native modules (`better-sqlite3`, `drag-out.node`) 를 다시 검증
  → 사용자가 **multi-second hang** 으로 체감.
- entitlements (`build/entitlements.mac.plist`) 는 codesign 이 같이 있어야만
  의미가 있으므로, 서명 없는 빌드에선 효과 없음.
- 정식 배포 단계에서 Developer ID + notarization 도입 시 `hardenedRuntime: true`
  로 되돌리고 entitlements 가 그때부터 활성화.

## 빌드된 dmg 첫 실행 가이드 (미서명 배포)

서명 안 된 dmg 를 다른 Mac 에 옮길 경우 Gatekeeper 가 차단할 수 있음. 사용자
안내:

1. `.dmg` 더블클릭 → 앱을 `/Applications` 으로 드래그
2. 첫 실행 — Finder 에서 앱 우클릭 → "열기" → "열기" 확인 (그냥 더블클릭하면 거부)
3. 한 번 허용한 뒤로는 더블클릭으로 정상 실행

## 정식 배포 단계 체크리스트 (TODO)

- [ ] Apple Developer Program 가입
- [ ] Developer ID Application 인증서 발급 + Keychain 등록
- [ ] `electron-builder` 에 `CSC_LINK` / `CSC_KEY_PASSWORD` 환경 변수 전달 (또는
      `notarize` config 추가)
- [ ] `hardenedRuntime: true` 로 되돌림 + entitlements 의미 회복
- [ ] notarization 자동화 (`afterSign` hook 또는 `electron-notarize`)
