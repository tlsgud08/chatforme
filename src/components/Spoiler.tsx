import { useState, type ReactNode } from 'react';
import './Spoiler.css';

/** Conceal visually and from assistive technology while preserving layout. */
export default function Spoiler({ children, block = false }: { children: ReactNode; block?: boolean }) {
  const [revealed, setRevealed] = useState(false);
  const Tag = block ? 'div' : 'span';
  return (
    <Tag
      className={`chat-spoiler${block ? ' chat-spoiler-block' : ''}`}
      data-revealed={revealed}
      role={revealed ? undefined : 'button'}
      tabIndex={revealed ? undefined : 0}
      aria-label={revealed ? undefined : '스포일러 보기'}
      onClick={revealed ? undefined : (event) => { event.preventDefault(); event.stopPropagation(); setRevealed(true); }}
      onKeyDown={revealed ? undefined : (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); event.stopPropagation(); setRevealed(true);
        }
      }}
    >
      <Tag className="chat-spoiler-content" aria-hidden={revealed ? undefined : true} {...(revealed ? {} : { inert: '' })}>
        {children}
      </Tag>
    </Tag>
  );
}
