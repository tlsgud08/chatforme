import { Fragment, isValidElement, useId, useState, useSyncExternalStore, type ReactNode } from 'react';
import { BookOpen, ChevronUp, Sparkles, Terminal } from 'lucide-react';
import LegacyCodeBlock from './MarkdownCodeBlock';
import { appliedCodeBlockStyle, subscribeCodeBlockStyle, type CodeBlockStyle } from '@/lib/codeBlockStyles';
import './StatusCodeBlock.css';

function formatEmphasis(value: ReactNode, muted: string): ReactNode {
  if (typeof value !== 'string') return value;
  const result: ReactNode[] = [];
  let cursor = 0;
  for (const match of value.matchAll(/(\*\*([^*\n]+)\*\*|\*([^*\n]+)\*)/g)) {
    const index = match.index;
    if (index > cursor) result.push(value.slice(cursor, index));
    result.push(match[2] ? <strong key={index} className="font-bold">{match[2]}</strong>
      : <em key={index} className={muted}>{match[3]}</em>);
    cursor = index + match[0].length;
  }
  if (cursor < value.length) result.push(value.slice(cursor));
  return result.length ? result.map((part, index) => <Fragment key={index}>{part}</Fragment>) : value;
}

/** Keep the existing Legacy component's markup, typography and fixed colors intact. */
export default function StatusCodeBlock({ children, mutedTextClassName = 'chat-muted-text', style: previewStyle }: {
  children: ReactNode;
  mutedTextClassName?: string;
  style?: CodeBlockStyle;
}) {
  const appliedStyle = useSyncExternalStore(subscribeCodeBlockStyle, appliedCodeBlockStyle, () => 'basic' as const);
  const style = previewStyle ?? appliedStyle;
  const [collapsed, setCollapsed] = useState(false);
  const paneId = useId();
  if (style === 'legacy') return <LegacyCodeBlock mutedTextClassName={mutedTextClassName}>{children}</LegacyCodeBlock>;

  const code = isValidElement<{ className?: string; children?: ReactNode; node?: { data?: { meta?: unknown } } }>(children) ? children : null;
  const language = code?.props.className?.match(/(?:^|\s)language-([^\s]+)/)?.[1] ?? '';
  const meta = code?.props.node?.data?.meta;
  const title = [language, typeof meta === 'string' ? meta : ''].filter(Boolean).join(' ').trim();
  const content = code?.props.children ?? children;
  // A user bubble's on-accent color does not apply to a page-colored block.
  const blockMutedTextClassName = mutedTextClassName === 'chat-user-muted-text' ? 'cf-user-muted-text' : mutedTextClassName;
  const body = <pre className="cf-raw"><code>{formatEmphasis(content, blockMutedTextClassName)}</code></pre>;
  const foldable = style !== 'basic';
  const fold = foldable && title ? <button className="cf-fold" type="button" aria-expanded={!collapsed}
    aria-controls={paneId} onClick={() => setCollapsed(value => !value)}>
    <span>{collapsed ? '펼치기' : '접기'}</span><ChevronUp aria-hidden="true" />
  </button> : null;
  const tag = style === 'neon' ? '현황' : ['scroll', 'grimoire', 'noir'].includes(style) ? 'INFO' : null;

  return <div className={`status-code-frame cf-${style}`}>
    <div className="cf-block">
      {style === 'neon' && <div className="cf-terminal-cap" aria-hidden="true"><span>STATUS TERMINAL</span><span>LOCAL</span></div>}
      {style === 'corporate' && <div className="cf-file-tab" aria-hidden="true">INTERNAL RECORD</div>}
      {style === 'noir' && <div className="cf-dossier-tab" aria-hidden="true">CASE FILE</div>}
      {style === 'scroll' && <div className="cf-scroll-rod" aria-hidden="true" />}
      {style === 'grimoire' && <><span className="cf-book-corner cf-book-corner-tl" aria-hidden="true" /><span className="cf-book-corner cf-book-corner-tr" aria-hidden="true" /></>}
      {style === 'notebook' && <div className="cf-binding" aria-hidden="true">{Array.from({length:6}, (_, index) => <span key={index} />)}</div>}
      {title && <div className="cf-head">
        {style === 'hanji' && <span className="cf-seal" aria-hidden="true">記</span>}
        <div className="cf-title-wrap">
          {style === 'neon' && <Terminal aria-hidden="true" />}
          {style === 'corporate' && <span className="cf-company-mark" aria-hidden="true">//</span>}
          {style === 'grimoire' && <BookOpen aria-hidden="true" />}
          {style === 'notebook' && <span className="cf-note-label" aria-hidden="true">INFO</span>}
          <span className="cf-title">{title}</span>
          {tag && <span className="cf-head-tag" aria-hidden="true">{tag}</span>}
          {style === 'notebook' && <Sparkles aria-hidden="true" />}
        </div>
        {style === 'corporate' || style === 'noir' ? <div className="cf-head-right">
          <span className={style === 'corporate' ? 'cf-classification' : 'cf-confidential'} aria-hidden="true">{style === 'corporate' ? '機密' : 'TOP SECRET'}</span>{fold}
        </div> : fold}
      </div>}
      <div className="cf-pane" id={paneId} hidden={!!title && foldable && collapsed}>
        {style === 'scroll' ? <><div className="cf-scroll-content"><span className="cf-scroll-inscription" aria-hidden="true">現 況</span>{body}</div><div className="cf-scroll-sign" aria-hidden="true">記</div></> : body}
        {style === 'neon' && <div className="cf-foot" aria-hidden="true"><span>END OF RECORD</span><span>▰ ▰ ▱</span></div>}
        {style === 'corporate' && <div className="cf-foot" aria-hidden="true"><span>열람 제한</span><span>┃┃│┃│┃┃│┃</span></div>}
        {style === 'hanji' && <div className="cf-paper-end" aria-hidden="true">◇</div>}
        {style === 'grimoire' && <div className="cf-book-end" aria-hidden="true"><span />◇<span /></div>}
        {style === 'noir' && <div className="cf-foot" aria-hidden="true"><span>CONFIDENTIAL</span><span>— END —</span></div>}
        {style === 'notebook' && <div className="cf-note-end" aria-hidden="true">✦</div>}
      </div>
      {style === 'scroll' && <div className="cf-scroll-rod cf-scroll-rod-bottom" aria-hidden="true" />}
      {style === 'grimoire' && <span className="cf-bookmark" aria-hidden="true" />}
    </div>
  </div>;
}
