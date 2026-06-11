// 라이브러리 그리드 썸네일의 애니메이션 재생 정책. GIF / WebP(animated) /
// APNG 파일을 "항상 자동 루프 재생"할지, 아니면 기본 동작(정적 포스터 +
// 호버시 재생)으로 둘지 결정한다.
//
// dashboardPreferences.ts 와 동일한 dual-channel 패턴을 따른다:
//   1. CustomEvent — 같은 BrowserWindow 안의 다른 컴포넌트 즉시 동기화
//   2. 'storage' 이벤트 — 다른 BrowserWindow/탭 (Electron 멀티 윈도우 대비)
//
// default 는 false. 기존에 설치돼 있던 사용자가 업데이트 후에도 호버 기반
// 동작을 그대로 받도록 한다.

import { useEffect, useState } from "react";

export const LIBRARY_ANIMATED_THUMBNAILS_AUTOPLAY_STORAGE_KEY =
  "preflow.library.animatedThumbnailsAutoplay";
export const LIBRARY_ANIMATED_THUMBNAILS_AUTOPLAY_CHANGED_EVENT =
  "preflow:library-animated-thumbnails-autoplay-changed";
export const DEFAULT_LIBRARY_ANIMATED_THUMBNAILS_AUTOPLAY = false;

export const readAnimatedThumbnailsAutoplay = (): boolean => {
  if (typeof window === "undefined") {
    return DEFAULT_LIBRARY_ANIMATED_THUMBNAILS_AUTOPLAY;
  }
  try {
    const raw = window.localStorage.getItem(
      LIBRARY_ANIMATED_THUMBNAILS_AUTOPLAY_STORAGE_KEY,
    );
    if (raw === null) return DEFAULT_LIBRARY_ANIMATED_THUMBNAILS_AUTOPLAY;
    return raw === "true";
  } catch {
    return DEFAULT_LIBRARY_ANIMATED_THUMBNAILS_AUTOPLAY;
  }
};

export const saveAnimatedThumbnailsAutoplay = (value: boolean): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      LIBRARY_ANIMATED_THUMBNAILS_AUTOPLAY_STORAGE_KEY,
      value ? "true" : "false",
    );
    window.dispatchEvent(
      new CustomEvent(LIBRARY_ANIMATED_THUMBNAILS_AUTOPLAY_CHANGED_EVENT, {
        detail: value,
      }),
    );
  } catch {
    /* in-memory state 가 살아있으면 사용엔 지장 없음 */
  }
};

/** LibraryMediaThumbnail 처럼 그리드 카드마다 호출되는 훅. 같은 윈도우의
 *  Settings 변경(CustomEvent)과 다른 윈도우의 변경(storage event) 모두
 *  즉시 반영된다. */
export const useAnimatedThumbnailsAutoplay = (): boolean => {
  const [value, setValue] = useState<boolean>(readAnimatedThumbnailsAutoplay);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const sync = () => setValue(readAnimatedThumbnailsAutoplay());
    const onStorage = (event: StorageEvent) => {
      if (event.key === LIBRARY_ANIMATED_THUMBNAILS_AUTOPLAY_STORAGE_KEY) {
        sync();
      }
    };
    window.addEventListener(
      LIBRARY_ANIMATED_THUMBNAILS_AUTOPLAY_CHANGED_EVENT,
      sync,
    );
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(
        LIBRARY_ANIMATED_THUMBNAILS_AUTOPLAY_CHANGED_EVENT,
        sync,
      );
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return value;
};
