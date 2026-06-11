/**
 * pendingBriefMatchProject — "스마트 브리프 매치 폴더 → 프로젝트 내보내기" 핸드오프 큐.
 *
 * 프로젝트는 *대상 프로젝트 워크스페이스 DB* 에 생성돼야 하는데, 내보내기를 시작하는
 * 시점에는 보통 라이브러리 워크스페이스가 활성이다(활성 DB 에만 쓰기 가능). 그래서
 *   (1) 라이브러리에서 내보내기 다이얼로그 확인 → 선택 레퍼런스 사전 분석(reload 전),
 *   (2) 생성에 필요한 메타 + 분석 결과를 이 LS 큐에 적재,
 *   (3) 대상 워크스페이스로 전환(reload),
 *   (4) DashboardPage 가 mount 시 큐를 drain 해 그 DB 에 프로젝트/브리프를 생성한다.
 * (referenceLibrary 의 promote 핸드오프 큐와 동일 패턴.)
 *
 * 주의: 워크스페이스 전환(reload) 을 가로질러 읽혀야 하므로 *workspace-scoped 가
 * 아닌 전역 키* 를 쓴다. localStorage 는 같은 origin 에서 워크스페이스와 무관하게
 * 공유된다. base64 이미지 바이트는 싣지 않고 refIds + libraryWsId 만 보관해(전환 후
 * 크로스-워크스페이스로 해석) quota 를 회피한다. 분석 결과 JSON 은 텍스트라 안전.
 */
import type { Lang } from "@/components/BriefTab";

const KEY = "preflow.pendingBriefMatchProject";

export interface PendingBriefMatchProject {
  /** 프로젝트를 생성할 대상(프로젝트 kind) 워크스페이스 id. */
  targetWsId: string;
  /** 레퍼런스를 해석할 소스(라이브러리) 워크스페이스 id. */
  libraryWsId: string;
  /** 프로젝트 제목(비면 createProjectFromPending 이 폴더명/Untitled 로 보정). */
  title: string;
  /** 대상 워크스페이스의 대시보드 폴더 id(미지정=Ungrouped). */
  folderId: string | null;
  /** 화면 비율 → projects.video_format. */
  videoFormat: "horizontal" | "vertical" | "square";
  /** 마감 일정 → projects.deadline (선택). */
  deadline?: string | null;
  /** 요청 부서 → projects.client 재사용 (선택). */
  client?: string | null;
  /** true 면 생성 후 프로젝트 브리프 탭으로 이동, false 면 라이브러리로 복귀. */
  openInBrief: boolean;
  /** 프로젝트로 넘길 라이브러리 레퍼런스 id 목록(전환 후 크로스-워크스페이스로 해석). */
  refIds: string[];
  /** 보관된 브리프 본문(분석 raw_text 시드용). */
  briefText: string;
  /** 보관된 아이디어 메모. */
  ideaNote?: string;
  /** 브리프 캡쳐 이미지 — 프로젝트 브리프 첨부(role:"brief")로 carry. */
  briefImages?: { base64: string; mediaType: string }[];
  /** 브리프 PDF 추출 텍스트 — raw_text/분석에 합류. */
  pdfText?: string;
  /** true 면 프로젝트 생성 후 BriefTab 진입 시 분석을 자동 실행(브리프 탭 로딩바로
   *  진행). 다이얼로그에서 블로킹 분석하지 않는다. */
  autoAnalyze: boolean;
  /** 분석 언어 → briefs.lang. */
  lang: Lang;
}

export function setPendingBriefMatchProject(payload: PendingBriefMatchProject): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    /* quota / private mode — 호출부가 same-WS 인라인 경로로 폴백 가능 */
  }
}

/** 읽기만 한다(삭제 안 함). drain 진입 가드/조건 확인용. */
export function peekPendingBriefMatchProject(): PendingBriefMatchProject | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingBriefMatchProject;
    return parsed && typeof parsed === "object" && parsed.targetWsId ? parsed : null;
  } catch {
    return null;
  }
}

/** 읽고 즉시 삭제(원자적 소비). drain 이중 실행을 막는다. */
export function takePendingBriefMatchProject(): PendingBriefMatchProject | null {
  const payload = peekPendingBriefMatchProject();
  clearPendingBriefMatchProject();
  return payload;
}

export function clearPendingBriefMatchProject(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
