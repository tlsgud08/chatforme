import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import InterfaceIcon from './InterfaceIcon';
import './SessionMenu.css';

type Navigation = {
  host: HTMLDivElement | null;
  subtitle: string;
  activePage: string | undefined;
  close: () => void;
  register: (id: string) => () => void;
  isTop: (id: string) => boolean;
};
const NavigationContext = createContext<Navigation | null>(null);

export default function SessionMenuFrame({ subtitle, onClose, children }: {
  subtitle: string; onClose: () => void; children: ReactNode;
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [pages, setPages] = useState<string[]>([]);
  const pageStack = useRef<string[]>([]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const close = useCallback(() => closeRef.current(), []);
  const register = useCallback((id: string) => {
    pageStack.current = [...pageStack.current, id];
    setPages(pageStack.current);
    return () => {
      pageStack.current = pageStack.current.filter(page => page !== id);
      setPages(pageStack.current);
    };
  }, []);
  const isTop = useCallback((id: string) => pageStack.current.at(-1) === id, []);
  const navigation = useMemo(() => ({ host, subtitle, activePage: pages.at(-1), close, register, isTop }), [host, subtitle, pages, close, register, isTop]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    host?.querySelector<HTMLButtonElement>('[aria-label="세션 메뉴 닫기"]')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [host]);

  function keyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !pageStack.current.length && !document.querySelector('[role="dialog"]:not(.inu-sheet)')) { event.stopPropagation(); close(); }
    if (event.key !== 'Tab' || !host) return;
    const current = host.querySelector<HTMLElement>('.inu-subpage:last-child') ?? host.querySelector<HTMLElement>('.inu-home');
    const controls = Array.from(current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,a[href]') ?? [])
      .filter(element => element.getClientRects().length > 0);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }

  return <div className="session-menu" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="inu-sheet" ref={setHost} role="dialog" aria-modal="true" aria-label="세션 메뉴" onKeyDown={keyDown}>
      <NavigationContext.Provider value={navigation}>
        <div className="inu-home" hidden={pages.length > 0}>
          <header className="inu-header">
            <div className="inu-title"><h2>세션 메뉴</h2><p>{subtitle}</p></div>
            <button type="button" className="inu-icon" onClick={close} aria-label="세션 메뉴 닫기"><InterfaceIcon name="close" /></button>
          </header>
          {children}
        </div>
      </NavigationContext.Provider>
    </div>
  </div>;
}

// Portals keep each originating form mounted while the shared drawer shows a child page.
export function SessionMenuPage({ enabled = false, title, onBack, children }: {
  enabled?: boolean; title: string; onBack: () => void; children: ReactNode;
}) {
  const navigation = useContext(NavigationContext);
  const id = useId();
  const backRef = useRef(onBack);
  backRef.current = onBack;
  const pageRef = useRef<HTMLElement>(null);
  const host = navigation?.host;
  const register = navigation?.register;
  const isTop = navigation?.isTop;
  useEffect(() => {
    if (!enabled || !host || !register) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const unregister = register(id);
    requestAnimationFrame(() => { if (isTop?.(id)) pageRef.current?.querySelector<HTMLButtonElement>('[aria-label="이전 화면으로"]')?.focus(); });
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape' && isTop?.(id) && !document.querySelector('[role="dialog"]:not(.inu-sheet)')) { event.preventDefault(); event.stopImmediatePropagation(); backRef.current(); }
    }
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('keydown', escape, true);
      unregister();
      requestAnimationFrame(() => { if (previous?.isConnected) previous.focus(); });
    };
  }, [enabled, host, register, isTop, id]);
  if (!enabled || !navigation) return <>{children}</>;
  if (!host) return null;
  return createPortal(<section className="inu-subpage" ref={pageRef} aria-label={title} aria-hidden={navigation.activePage !== id}>
    <header className="inu-header">
      <button type="button" className="inu-icon" onClick={onBack} aria-label="이전 화면으로"><InterfaceIcon name="back" /></button>
      <div className="inu-title"><h2>{title}</h2><p>{navigation.subtitle}</p></div>
      <button type="button" className="inu-icon" onClick={navigation.close} aria-label="세션 메뉴 닫기"><InterfaceIcon name="close" /></button>
    </header>
    <div className="inu-page-scroll inu-content">{children}</div>
  </section>, host);
}
