import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft as ArrowLeftIcon,
  ArrowRight as ArrowRightIcon,
  ExternalLink,
  Link2,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useUiLanguage } from "@/lib/uiLanguage";
import { openReferenceSourceUrl, type ReferenceItem } from "@/lib/referenceLibrary";

/* URL(`kind:"link"`) 또는 HTML(`kind:"doc"` + subtype:"html") 자료를 인앱에서
 * 실제로 임베드해 보는 컴포넌트.
 *
 * 일반 <iframe> 은 외부 사이트 대부분이 X-Frame-Options/CSP frame-ancestors
 * 로 차단하므로, Electron <webview> 게스트 webContents 로 임베드한다.
 * 메인의 `installWebviewGuards` + `will-attach-webview` 가 권한/팝업/네비
 * 게이션 정책을 강제하므로 여기서는 시각/상호작용만 책임진다.
 *
 * - 상단 미니 툴바: 뒤로/앞으로/새로고침/현재 URL/Open in browser
 * - did-fail-load 시 폴백 카드(임베드 차단 / 네트워크 실패) + Open in browser
 * - load 중에는 옅은 프로그레스 인디케이터(로딩 텍스트) */

/** Electron 게스트 webview 의 메서드 surface 만 좁게 — global.d.ts 와 같은
 *  shape. ref.current 호출 시 캐스팅용. */
type WebviewEl = HTMLElement & {
  src: string;
  reload(): void;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getURL(): string;
  loadURL(url: string): Promise<void>;
  stop(): void;
};

interface LinkWebViewProps {
  item: ReferenceItem;
  /** true 면 item.file_url(local-server 의 .html 파일) 을 src 로 쓴다.
   *  기본(false) 은 item.source_url 사용. */
  useFileUrl?: boolean;
}

export function LinkWebView({ item, useFileUrl = false }: LinkWebViewProps) {
  const { t } = useUiLanguage();
  const initialUrl = (useFileUrl ? item.file_url : item.source_url) ?? "";
  const sourceUrl = item.source_url ?? "";

  const webviewRef = useRef<WebviewEl | null>(null);
  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const [loading, setLoading] = useState(true);
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  const [failure, setFailure] = useState<null | { code: number; description: string }>(null);

  /* item 이 바뀌면 새 URL 로 다시 로드. webview 의 src 를 직접 갱신해도
     되지만, 의도 명시 차 setSrc + state 초기화를 같이 한다. */
  useEffect(() => {
    setCurrentUrl(initialUrl);
    setLoading(true);
    setFailure(null);
    setCanBack(false);
    setCanForward(false);
  }, [initialUrl, item.id]);

  /* webview 이벤트 구독 — React 가 일반 DOM 이벤트로 보내주지 않는 커스텀
     이벤트(`did-start-loading`, `did-stop-loading`, `did-fail-load`, `did-
     navigate` …) 라서 ref 기반 addEventListener 가 필요하다. */
  useEffect(() => {
    const el = webviewRef.current;
    if (!el) return;

    const updateNav = () => {
      try {
        setCanBack(el.canGoBack());
        setCanForward(el.canGoForward());
        setCurrentUrl(el.getURL() || initialUrl);
      } catch {
        /* webview 가 destroy 됐거나 아직 attach 전이면 무시 */
      }
    };
    const onStartLoad = () => {
      setLoading(true);
      setFailure(null);
    };
    const onStopLoad = () => {
      setLoading(false);
      updateNav();
    };
    const onFail = (event: Event) => {
      const e = event as Event & {
        errorCode?: number;
        errorDescription?: string;
        isMainFrame?: boolean;
      };
      /* 서브 프레임 실패는 무시 — 사이드바 트래커 / 광고 도메인 실패가
         흔해 메인 페이지가 멀쩡한데 실패 카드가 뜨면 오인 사고. */
      if (e.isMainFrame === false) return;
      /* errorCode -3 = ERR_ABORTED (사용자가 다른 곳으로 네비게이트해 이전
         로드 취소). 의미 있는 오류 아님 — 무시. */
      if (e.errorCode === -3) return;
      setLoading(false);
      setFailure({
        code: e.errorCode ?? -1,
        description: e.errorDescription ?? "Unknown error",
      });
    };
    const onNavigate = () => updateNav();

    el.addEventListener("did-start-loading", onStartLoad);
    el.addEventListener("did-stop-loading", onStopLoad);
    el.addEventListener("did-fail-load", onFail);
    el.addEventListener("did-navigate", onNavigate);
    el.addEventListener("did-navigate-in-page", onNavigate);
    return () => {
      el.removeEventListener("did-start-loading", onStartLoad);
      el.removeEventListener("did-stop-loading", onStopLoad);
      el.removeEventListener("did-fail-load", onFail);
      el.removeEventListener("did-navigate", onNavigate);
      el.removeEventListener("did-navigate-in-page", onNavigate);
    };
  }, [initialUrl, item.id]);

  const handleBack = useCallback(() => {
    try { webviewRef.current?.goBack(); } catch { /* noop */ }
  }, []);
  const handleForward = useCallback(() => {
    try { webviewRef.current?.goForward(); } catch { /* noop */ }
  }, []);
  const handleReload = useCallback(() => {
    try {
      webviewRef.current?.stop();
      webviewRef.current?.reload();
    } catch { /* noop */ }
    setFailure(null);
  }, []);
  const handleOpenExternal = useCallback(async () => {
    /* OS 기본 브라우저로 위임. 우클릭 메뉴의 "Open in browser" 와 동일 흐름. */
    try {
      const fallback = sourceUrl || currentUrl;
      if (!fallback) return;
      await openReferenceSourceUrl({ ...item, source_url: fallback });
    } catch (err) {
      console.warn("[LinkWebView] openExternal failed", err);
    }
  }, [currentUrl, item, sourceUrl]);

  if (!initialUrl) {
    return (
      <EmptyCard
        message={t("library.preview.linkNoUrl")}
        onOpenExternal={undefined}
      />
    );
  }

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      {/* 미니 브라우저 툴바 — 뒤로/앞으로/새로고침/URL/Open in browser. */}
      <div className="flex h-9 flex-shrink-0 items-center gap-1 border-b border-border-subtle bg-surface-panel px-2">
        <Button
          variant="ghost"
          className="h-7 w-7 p-0"
          style={{ borderRadius: 0 }}
          onClick={handleBack}
          disabled={!canBack}
          title={t("library.preview.webBack")}
          aria-label={t("library.preview.webBack")}
        >
          <ArrowLeftIcon className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          className="h-7 w-7 p-0"
          style={{ borderRadius: 0 }}
          onClick={handleForward}
          disabled={!canForward}
          title={t("library.preview.webForward")}
          aria-label={t("library.preview.webForward")}
        >
          <ArrowRightIcon className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          className="h-7 w-7 p-0"
          style={{ borderRadius: 0 }}
          onClick={handleReload}
          title={t("library.preview.webReload")}
          aria-label={t("library.preview.webReload")}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
        <div className="ml-1 flex min-w-0 flex-1 items-center gap-2 border border-border-subtle bg-background px-2 py-0.5">
          <Link2 className="h-3 w-3 text-muted-foreground" />
          <span className="truncate font-mono text-caption text-muted-foreground" title={currentUrl}>
            {currentUrl}
          </span>
          {loading ? (
            <span className="ml-auto shrink-0 font-mono text-2xs text-muted-foreground/70">
              {t("library.preview.webLoading")}
            </span>
          ) : null}
        </div>
        <Button
          variant="outline"
          className="h-7 gap-1.5 px-2 text-caption"
          style={{ borderRadius: 0 }}
          onClick={handleOpenExternal}
          disabled={!sourceUrl && !currentUrl}
          title={t("library.preview.openInBrowser")}
        >
          <ExternalLink className="h-3 w-3" />
          {t("library.preview.openInBrowser")}
        </Button>
      </div>

      {/* webview 본체 — 절대 위치로 부모를 꽉 채운다. 실패 카드가 떠 있어도
          webview 는 마운트 유지(reload 시 같은 인스턴스 재사용). */}
      <div className="relative flex-1">
        <webview
          ref={(el) => {
            webviewRef.current = (el as unknown as WebviewEl) ?? null;
          }}
          src={initialUrl}
          partition="persist:webview-preview"
          /* useragent 는 메인의 configureWebviewSession 이 세션 레벨로
             이미 REAL_UA 를 박았지만, attribute 로도 명시해 두 곳에서
             일관성 유지. */
          useragent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
          className={cn(
            "absolute inset-0 h-full w-full",
            failure && "opacity-0",
          )}
          style={{ display: "inline-flex" }}
        />
        {failure ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background">
            <FailureCard
              code={failure.code}
              description={failure.description}
              url={currentUrl}
              onReload={handleReload}
              onOpenExternal={sourceUrl || currentUrl ? handleOpenExternal : undefined}
              labelEmbedBlocked={t("library.preview.embedBlocked")}
              labelReload={t("library.preview.webReload")}
              labelOpenExternal={t("library.preview.openInBrowser")}
              labelErrorCode={t("library.preview.webErrorCode")}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface FailureCardProps {
  code: number;
  description: string;
  url: string;
  onReload: () => void;
  onOpenExternal?: () => void;
  labelEmbedBlocked: string;
  labelReload: string;
  labelOpenExternal: string;
  labelErrorCode: string;
}

function FailureCard({
  code,
  description,
  url,
  onReload,
  onOpenExternal,
  labelEmbedBlocked,
  labelReload,
  labelOpenExternal,
  labelErrorCode,
}: FailureCardProps) {
  /* errorCode = -3 은 위에서 걸러내지만, -10(X-Frame-Options 류 차단)·-501(연결
     중단) 같은 코드별 메시지를 사용자에게 보여줘도 의미가 모호하므로 한 줄로
     통합 + 원본 코드는 보조 텍스트로만 표시. */
  return (
    <div className="flex max-w-md flex-col items-center gap-4 px-8 text-center">
      <Link2 className="h-10 w-10 text-muted-foreground" />
      <div className="space-y-1">
        <div className="text-label font-medium">{labelEmbedBlocked}</div>
        <div className="break-all font-mono text-caption text-muted-foreground/80">{url}</div>
        <div className="font-mono text-2xs text-muted-foreground/60">
          {labelErrorCode}: {code} {description}
        </div>
      </div>
      <div className="flex gap-2">
        <Button
          variant="outline"
          className="h-8 gap-1.5 px-3 text-meta"
          style={{ borderRadius: 0 }}
          onClick={onReload}
        >
          <RotateCcw className="h-3 w-3" />
          {labelReload}
        </Button>
        {onOpenExternal ? (
          <Button
            className="h-8 gap-1.5 px-3 text-meta"
            style={{ borderRadius: 0 }}
            onClick={onOpenExternal}
          >
            <ExternalLink className="h-3 w-3" />
            {labelOpenExternal}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function EmptyCard({
  message,
  onOpenExternal,
}: {
  message: string;
  onOpenExternal?: () => void;
}) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background">
      <div className="flex max-w-md flex-col items-center gap-3 px-8 text-center text-muted-foreground">
        <Link2 className="h-10 w-10" />
        <div className="text-body">{message}</div>
        {onOpenExternal ? (
          <Button
            variant="outline"
            className="h-8 gap-1.5 px-3 text-meta"
            style={{ borderRadius: 0 }}
            onClick={onOpenExternal}
          >
            <ExternalLink className="h-3 w-3" />
            Open in browser
          </Button>
        ) : null}
      </div>
    </div>
  );
}
