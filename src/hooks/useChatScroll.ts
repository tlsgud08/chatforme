import { useCallback, useLayoutEffect, useRef } from 'react';

type Viewport = { top: number; anchor: string | null; offset: number };

function readViewport(element: HTMLDivElement): Viewport {
  const bounds = element.getBoundingClientRect();
  const anchor = Array.from(element.querySelectorAll<HTMLElement>('[data-scroll-anchor]'))
    .find(item => item.getBoundingClientRect().bottom > bounds.top);
  return {
    top: element.scrollTop,
    anchor: anchor?.dataset.scrollAnchor ?? null,
    offset: anchor ? anchor.getBoundingClientRect().top - bounds.top : 0,
  };
}

/** Open at the latest turn once; subsequent renders preserve the reader's place. */
export function useChatScroll(sessionId: string | undefined, ready: boolean) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const position = useRef<Viewport | null>(null);
  const openedSession = useRef<string>();
  const rememberScroll = useCallback(() => {
    if (scrollRef.current) position.current = readViewport(scrollRef.current);
  }, []);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !ready) return;
    if (openedSession.current !== sessionId) {
      openedSession.current = sessionId;
      element.scrollTop = element.scrollHeight;
    } else if (position.current) {
      const previous = position.current;
      const anchor = Array.from(element.querySelectorAll<HTMLElement>('[data-scroll-anchor]'))
        .find(item => item.dataset.scrollAnchor === previous.anchor);
      // Anchors also preserve the visible turn when older messages are prepended
      // or an edit above the viewport changes height. A removed anchor falls
      // back to the same scroll offset, rather than jumping to the latest user.
      element.scrollTop = anchor
        ? element.scrollTop + anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - previous.offset
        : previous.top;
    }
    position.current = readViewport(element);
  });

  return { scrollRef, rememberScroll };
}
