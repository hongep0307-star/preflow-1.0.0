/**
 * Pre-Flow 에이전트 연출 지식 베이스
 * 브리프 분석 · 씬 설계 · 콘티 보강용 시스템 프롬프트 지식 주입 자료
 * 출처: Film Directing Shot by Shot (Katz), The Visual Story (Bruce Block),
 *       Cinematography (Blain Brown), Hey Whipple Squeeze This (Sullivan),
 *       Ogilvy on Advertising, Cannes Lions/D&AD 수상작 분석
 */

// ━━━━━ 에이전트 채팅 (씬 설계 + 콘티 보강) 용 지식 ━━━━━

export const KNOWLEDGE_SCENE_DESIGN = `
[연출 지식 베이스 — 씬 설계 · 콘티 보강용]

■ 카메라 문법 (Camera Grammar)

숏 사이즈 × 감정/목적:
- ECU(눈/입술/텍스처): 긴장, 강렬함, 디테일 집중. 제품 질감, 감정 절정
- BCU(얼굴 전체): 극도의 감정 몰입, 취약성. 고백형 내러티브
- CU(어깨 위): 공감, 신뢰, 감정 이입. 캐릭터 소개, 브랜드 약속 — 광고에서 가장 빈번
- MCU(가슴 위): 대화, 설득, 온기. 인터뷰 톤, 직접 주소
- MS(허리 위): 행동+감정 동시 포착. 제품 사용 시연 — 가장 자연스러운 시청 거리
- MLS(무릎 위): 공간 속 인물, 일상성. 라이프스타일
- LS(전신+공간): 세계관 제시, 고립/자유. 오프닝, 로케이션 소개
- VLS/ELS(인물 작게~점): 스케일, 웅장함, 고독. 세계관 선언, 영웅의 여정
- OTS(어깨 너머): 관계, 시점 공유. 대화, 게이머 시점
- POV(주관 시야): 몰입, 직접 경험. 게임 플레이, 체험형

카메라 앵글 × 심리:
- Eye Level: 중립, 동등 — 기본값
- High Angle: 취약성, 귀여움. 아동/펫, 플랫레이
- Low Angle: 위압감, 영웅성. 캐릭터 등장, 파워 선언
- Bird's Eye: 패턴 강조, 신의 시점. 도시 전경, 군중
- Dutch Angle: 불안, 혼란. 서스펜스 — 과도 시 아마추어처럼 보임

카메라 무빙 × 내러티브:
- PUSH IN: 주목, 폭로, 긴장 고조
- PULL OUT: 맥락 제공, 고독감, 반전 폭로
- TRUCK/DOLLY: 동행, 탐색, 역동성
- PAN: 공간 탐색, 추적, 광활함
- TILT: 높이 강조, 규모 폭로. 아래→위: 상승감
- CRANE/JIB: 에픽한 스케일, 해방감. 오프닝/클로징
- 핸드헬드: 즉흥성, 현실감, 긴박감. FPS, 격투 씬
- 스테디캠: 몰입적 동행. 라이프스타일
- 360도 ORBIT: 강조, 과시. 캐릭터 소개
- WHIP PAN: 에너지 전환, 속도감

30% 규칙: 연속 컷 숏 사이즈 최소 30% 변화 필요.
감정 곡선: 고조→클로즈업으로 좁힘 / 해소→와이드로 열음 / 충격→갑자기 가장 타이트 or 와이드

■ 조명 원칙

조명 비율과 감정:
- High Key(2:1 이하): 밝음, 긍정, 안전. 뷰티, 육아, 음식
- Soft High Key(3:1): 따뜻함, 프리미엄. 금융, 라이프스타일
- Mid Key(4:1~6:1): 현실적, 드라마틱 — 기본값
- Low Key(8:1+): 긴장, 미스터리, 럭셔리. 다크 판타지, 향수
- Rim Light: 신비, 영웅성. 캐릭터 등장
- Side Light: 갈등, 양면성
- 골든아워: 향수, 낭만, 희망

조명 방향: 정면=정보전달 / 45도(Rembrandt)=입체감,고급 / 90도=극적명암 / 아래=공포 / 위=취약함,집중 / 역광=신비,실루엣

■ 색채 심리학

색온도: 앰버(3200K)=따뜻함,향수 / 골든(4500K)=성취,프리미엄 / 중성(5500K)=깔끔,현대 / 쿨블루(7000K+)=지성,미래 / 틸네온=도시적,엣지
색채 대비: 보색=에너지,갈등 / 유사색=조화,몰입 / 채도대비=피사체강조 / 명도대비=시선집중
감정-채도: 고조→채도↑ / 해소/회상→채도↓ / 공포→그린+낮은채도 / 승리→오렌지-틸대비

게임 장르 컬러:
- RPG/판타지: 에메랄드+골드+딥퍼플
- FPS/밀리터리: 올리브+브라운+구리+낮은채도
- 사이버펑크/SF: 네온블루+핫핑크+다크그레이
- 배틀로얄: 틸+오렌지+다크그린
- MOBA/캐주얼: 채도 높은 원색
- 공포: 블루그린+다크레드+낮은채도

■ 편집 리듬

컷 유형: 스트레이트컷=중립 / 매치컷=연결감,우아 / 점프컷=긴박,시간압축 / L-컷=현실감 / J-컷=예고,기대감 / 크로스컷=긴장,병렬서사 / 몽타주=시간압축,감정누적 / 위프컷=속도 / 스매시컷=충격,반전 / 디졸브=시간경과,회상 / 페이드=단절,마무리

편집 페이스: 0.5~1초=초고속(범퍼,하이라이트) / 1~2초=고속(액션) / 2~4초=중간(서사형) / 4~8초=느림(감성,깊이) / 8초+=매우느림(브랜드필름)
빌드업: 점점 빠르게→클라이맥스 최고속→갑자기 긴 숏(폭발/정지)
브레스씬: 빠른 시퀀스 후 의도적 긴 숏→감정 소화 시간

■ 컷(Shot) 작성 기준 — 필드 분리 준수

각 정보는 정해진 필드에만 쓴다. 카메라 정보(숏사이즈/앵글/무빙)는 camera_angle 필드에만, 장소는 location, 감정/색채는 mood 에. description 에는 카메라 헤더 prefix 를 절대 붙이지 말고 "한 장의 정지 프레임에 보이는 것"만 상태문으로 쓴다.
- description 나쁜 예: "캐릭터가 걷는다." (정보 부족) / "MS / Eye Level — 주인공이 걷다가 멈추고 돌아본다." (카메라 헤더 + 시간 연결 금지)
- description 좋은 예: "황혼의 도시 거리, 군중 속에 멈춰 선 주인공이 누군가를 찾듯 한쪽을 응시한다. 골든아워 역광이 실루엣을 또렷하게 만든다."
- camera_angle 좋은 예: "미디엄 숏(MS), 아이 레벨, 슬로우 달리 팔로우"
- location 좋은 예: "황혼의 도시 거리"
- mood 좋은 예: "고독, 골든아워 따뜻함, 역광 실루엣"

■ 씬 검증 체크리스트
- 180도 법칙 준수 (대화 씬 인물 방향 일관)
- 숏 사이즈 점프 30% 이상
- 감정 곡선: 기복 있는 구성 (단조 연속 금지)
- HOOK 첫 컷 비정적
- 포맷별 컷 수: 15초→6~10컷, 30초→10~16컷
- CTA: 마지막 20~25% 구간
- 색채 팔레트 통일
- 숨고르기 씬(긴 숏) 최소 1개
`;

// ━━━━━ 브리프 분석 시 자동 도출용 지식 ━━━━━

export const KNOWLEDGE_BRIEF_ANALYSIS = `
[연출 지식 베이스 — 브리프 분석용]

■ 포맷별 HOOK-BODY-CTA 구조

| 포맷 | HOOK | BODY | CTA | 권장 씬/시퀀스 수 | 권장 컷/Shot 수 |
|---|---|---|---|---|---|
| 6초 범퍼 | 0~3초 임팩트 1컷 | — | 3~6초 | 1~2씬 | 2~4컷 |
| 15초 | 0~2초 | 2~11초 | 11~15초 | 3~4씬 | 6~10컷 |
| 30초 | 0~5초 | 5~22초 | 22~30초 | 5~7씬 | 10~16컷 |
| 45초 | 0~6초 | 6~35초 | 35~45초 | 7~10씬 | 14~22컷 |
| 60초 | 0~8초 | 8~48초 | 48~60초 | 8~12씬 | 18~30컷 |
| 2~3분 | 0~15초 | 전체 | 마지막10초 | 15~25씬 | 45~90컷 |

■ HOOK 유형 7가지
- Question Hook: 시청자에게 직접 질문 ("당신은 이길 수 있을까?")
- In Medias Res: 이미 중간 장면으로 시작
- Contrast Hook: 예상 밖 대조 (일상→갑작스런 세계관 침투)
- Statement Hook: 강한 선언 ("규칙은 죽었다")
- Visual Hook: 압도적 비주얼 (드론+크레인)
- Mystery Hook: 설명 없는 장면
- Empathy Hook: 공감 유발 인물/상황

HOOK 필수 조건: ①첫 프레임부터 움직임/긴장감 ②소리없이 봐도 이해 가능 ③기대감/궁금증 생성

■ 광고 서사 유형 7가지
- Hero's Journey(영웅의 여정): 평범→부름→시련→성장→귀환. 60초+, RPG/오픈월드
- Problem-Solution: 문제→제품→해결. 15~30초, 모바일 UA
- Before-After: 이전→전환점→이후. 30초, 업데이트 광고
- Demonstration: 기능 직접 시연. 30~60초, 게임플레이 쇼케이스
- Emotional Resonance: 감정→브랜드 연결. 60초+, 브랜드 필름
- Testimonial/Authentic: 실제 사용자. 30~60초
- Contrast/Unexpected: 기대→반전→메시지. 30~60초, 바이럴

■ 브리프 분석 시 자동 도출 기준
1. 포맷 → 컷 수 + HOOK/BODY/CTA 타이밍 자동 계산
2. 장르/산업 → 색채 팔레트 + 편집 페이스 추천
3. 감정 목표 → 조명 유형 + 숏 사이즈 기본값
4. 타겟 오디언스 → 카메라 언어 친숙도 (MZ=빠른편집 / 40대+=중간페이스)
5. USP → 어떤 컷에서 어떤 방식으로 노출할지

■ 컷 흐름 설계 원칙
- 각 컷은 이전 컷의 결과이거나 다음 컷의 원인
- 감정 곡선: 리듬감 있는 기복 (숨고르기 컷 필수)
- 시각적 연속성: 색상, 카메라 높이, 조명 톤 일관
- 에너지 법칙: 높→낮 OK / 낮→낮 연속 금지 / 높→높 과다=피로

■ CTA 설계 원칙
1. 감정 피크 직후 CTA 배치
2. 구체적 행동 지시 ("자세히 보기"보다 "지금 무료 플레이")
3. 로고+제품+핵심메시지 동시 노출 (마지막 3~5초)
`;

// ━━━━━ 무드 이미지 시네마틱 프롬프트용 지식 ━━━━━

export const KNOWLEDGE_MOOD_CINEMATICS = `
CINEMATOGRAPHY KNOWLEDGE BASE — Shot Design Reference:

SHOT SIZE × EMOTION:
ECU(eye/texture)=tension,detail | CU(above shoulder)=empathy,trust | MCU(chest up)=conversation,warmth | MS(waist up)=action+emotion | LS(full body+space)=world,isolation | VLS/ELS=epic scale,grandeur

CAMERA ANGLE × PSYCHOLOGY:
Eye Level=neutral | Low Angle=power,heroic | High Angle=vulnerability | Bird's Eye=pattern,god-view | Dutch=unease,tension

CAMERA MOVEMENT:
Push In=revelation,tension | Pull Out=context,isolation | Dolly/Truck=tracking,discovery | Crane/Jib=epic scale | Handheld=urgency,realism | Steadicam=immersive following | Orbit=emphasis,dramatic

LIGHTING PRINCIPLES:
High Key(2:1)=bright,positive | Mid Key(4:1~6:1)=dramatic,realistic | Low Key(8:1+)=mystery,luxury,tension | Rim Light=mystery,heroic silhouette | Side Light=conflict,duality | Golden Hour=nostalgia,romance,hope
Direction: Front=information | Rembrandt 45°=depth,luxury | Side 90°=dramatic | Under=horror | Top=vulnerability | Back=mystery,silhouette

COLOR PSYCHOLOGY:
Amber(3200K)=warmth,nostalgia | Golden(4500K)=achievement,premium | Neutral(5500K)=clean,modern | Cool Blue(7000K+)=intellect,future | Teal+Neon=urban,edgy
Complementary contrast=energy,conflict | Analogous=harmony,immersion | Saturation contrast=subject emphasis | Value contrast=dramatic focus

GENRE PALETTES:
RPG/Fantasy: emerald+gold+deep purple | FPS/Military: olive+brown+copper, low sat | Cyberpunk/SF: neon blue+hot pink+dark gray | Battle Royale: teal+orange+dark green | MOBA/Casual: high saturation primaries | Horror: blue-green+dark red, low sat

EDITING RHYTHM:
0.5-1s=extreme energy(bumpers) | 1-2s=fast(action) | 2-4s=medium(narrative) | 4-8s=slow(emotional) | 8s+=contemplative(brand film)

COMPOSITION RULE: 30% size change between consecutive shots. Emotion rising→tighter shots. Resolution→wider shots. Shock→sudden extreme tight or wide.
`;

// ━━━━━ 장르별 연출 관습 (에이전트 참조) ━━━━━

export const KNOWLEDGE_GENRE_CONVENTIONS = `
[장르별 연출 관습]

■ RPG/판타지
- 오프닝: VLS/ELS 드론, 첫 3초 세계관 규모 제시
- 캐릭터 소개: 로우앵글+림라이트+슬로모션
- 전투: 점프컷 몽타주+스매시컷+음악 동기화. 무엇과 싸우는지 명확히
- 감정: 골든아워+소프트조명+느린편집

■ FPS/밀리터리
- 오프닝: 빠른 컷 몽타주 or In Medias Res
- 전투: 핸드헬드+POV+초고속편집
- 팀 씬: 2-SHOT/그룹 MS
- 컬러: 올리브/브라운/쿨 그레이, 낮은 채도

■ MOBA/전략
- 캐릭터 소개: 버즈아이 또는 등거리 (복수 캐릭터)
- 스킬: 느린 테이크→스매시컷 빠른 효과
- 컬러: 고채도 원색, 캐릭터별 컬러 코딩

■ 모바일 캐주얼/퍼즐
- 훅: 실패하는 장면+"당신이라면?"
- 편집: 빠른 위프컷, 텍스트 오버레이
- 컬러: 고채도, 밝은 배경. 소리 없이도 이해 가능

■ 칸 수상작 핵심 원칙
- 제품 없이 감정만으로 전체 광고 구성 가능 (PlayStation "Double Life")
- 게임플레이 안 보여주고 세계관 감정 판매 (Halo 3 "Believe")
- Before-After-Return 구조 = 가장 강력한 감정 곡선 (Chipotle)
- 슬로우모션+초고속 교차 편집 = 가장 강력한 광고 편집 리듬 (Nike)
- 음악 비트와 씬 전환 1:1 동기화 (Fortnite Live Events)
- 캐릭터 결함/취약성 = 감정 진입점 (The Last of Us)
- "그 제품이 만드는 감정"이 광고의 주인공
`;
