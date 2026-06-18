import React, { useEffect, useRef, useState } from "react";

/**
 * 스트리밍 평문 프리뷰를 "써내려가는" 질감으로 보여주는 컴포넌트.
 *
 * 누적 텍스트(text)가 매 토큰 늘어날 때, 일정 간격(FLUSH_MS)으로 새로 추가된
 * 구간만 잘라 chunk 로 커밋한다. 각 chunk 는 마운트 시 1회 `token-fade`(opacity)
 * 애니메이션으로 등장하므로, 선두에서 텍스트가 부드럽게 차오르는 느낌이 난다.
 *
 * - 인라인 <span> 들로 렌더하므로 부모의 whitespace-pre-wrap 레이아웃을 해치지 않는다.
 * - 긴 답변에서 span 이 무한정 쌓이지 않도록, 오래된 chunk 들은 애니메이션 없는
 *   단일 "settled" chunk 로 합친다(키 고정이라 재애니메이션/리마운트 없음).
 * - 새 턴 등으로 text 가 짧아지면(=리셋) 처음부터 다시 구성한다.
 */

type Chunk = { id: number; text: string; settled?: boolean };

const FLUSH_MS = 50;
/** 이 개수를 넘으면 오래된 chunk 를 settled 하나로 합친다. */
const MAX_LIVE_CHUNKS = 40;
/** 합칠 때 애니메이션 대상으로 남겨둘 최근 chunk 수. */
const KEEP_TAIL = 12;

export const StreamingText = React.memo(function StreamingText({ text }: { text: string }) {
  const [chunks, setChunks] = useState<Chunk[]>(() => (text ? [{ id: 0, text }] : []));
  const latestRef = useRef(text);
  const committedLenRef = useRef(text.length);
  const idRef = useRef(text ? 1 : 0);

  latestRef.current = text;

  useEffect(() => {
    const flush = () => {
      const t = latestRef.current;
      // 리셋/교체: 커밋된 길이보다 짧아지면 처음부터 다시 구성.
      if (t.length < committedLenRef.current) {
        idRef.current = 0;
        committedLenRef.current = t.length;
        setChunks(t ? [{ id: idRef.current++, text: t }] : []);
        return;
      }
      if (t.length > committedLenRef.current) {
        const delta = t.slice(committedLenRef.current);
        committedLenRef.current = t.length;
        const id = idRef.current++;
        setChunks((prev) => {
          const next = [...prev, { id, text: delta }];
          if (next.length > MAX_LIVE_CHUNKS) {
            const mergeCount = next.length - KEEP_TAIL;
            const mergedText = next.slice(0, mergeCount).map((c) => c.text).join("");
            return [{ id: -1, text: mergedText, settled: true }, ...next.slice(mergeCount)];
          }
          return next;
        });
      }
    };
    const timer = setInterval(flush, FLUSH_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <>
      {chunks.map((c) =>
        c.settled ? (
          <span key={c.id}>{c.text}</span>
        ) : (
          <span key={c.id} className="token-fade">
            {c.text}
          </span>
        ),
      )}
    </>
  );
});

StreamingText.displayName = "StreamingText";
