/* Electron <webview> 게스트 임베드 JSX intrinsic.
 *
 * React 의 기본 JSX 타입에는 webview 가 없어 LinkWebView 같은 컴포넌트에서
 * <webview src=... /> 가 컴파일 에러를 낸다. Electron 게스트 webContents 가
 * 노출하는 attributes/methods/events 중 우리가 실제로 쓰는 surface 만 좁게
 * 선언한다. preflow 의 webview 사용은 read-only 프리뷰 용도라 IPC/플러그인
 * 관련 attribute 는 의도적으로 제외(필요 시 추가). */

import type { DetailedHTMLProps, HTMLAttributes } from "react";

interface WebviewDidFailLoadEvent extends Event {
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
  isMainFrame: boolean;
}

interface WebviewDidNavigateEvent extends Event {
  url: string;
  httpResponseCode?: number;
}

interface WebviewElement extends HTMLElement {
  src: string;
  reload(): void;
  reloadIgnoringCache(): void;
  stop(): void;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getURL(): string;
  getTitle(): string;
  isLoading(): boolean;
  loadURL(url: string, options?: unknown): Promise<void>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<
        HTMLAttributes<WebviewElement> & {
          src?: string;
          partition?: string;
          useragent?: string;
          httpreferrer?: string;
          disablewebsecurity?: string;
          /* attribute 는 string-typed (HTML serialization). 값 자체는 빈
             문자열로도 활성화되므로 boolean 으로 받지 않는다. 호출부는
             allowpopups 를 *전달하지 않는다* (메인의 will-attach-webview
             가드가 강제로 제거). */
          allowpopups?: string;
        },
        WebviewElement
      >;
    }
  }
}

export {};
