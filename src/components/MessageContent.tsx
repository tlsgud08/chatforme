import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import MarkdownImage from './MarkdownImage';
import MarkdownCodeBlock from './MarkdownCodeBlock';
import { stripThemeDirectives } from '@/lib/themeDirectives';
import type { Message } from '@/types/db';

const remarkPlugins = [remarkGfm];

/** Memoize only the body; actions, variants and costs remain live in ChatPage. */
const MessageContent = memo(function MessageContent({ content, role, status, showImages }: {
  content: string; role: Message['role']; status: Message['generation_status']; showImages: boolean;
}) {
  const mutedTextClassName = role === 'user' ? 'chat-user-muted-text' : 'chat-muted-text';
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      components={{
        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        strong: ({ children }) => <strong className="font-bold">{children}</strong>,
        em: ({ children }) => <em className={mutedTextClassName}>{children}</em>,
        ul: ({ children }) => <ul className="mb-2 list-outside list-disc pl-5">{children}</ul>,
        ol: ({ children }) => <ol className="mb-2 list-outside list-decimal pl-5">{children}</ol>,
        li: ({ children }) => <li className="mb-0.5">{children}</li>,
        code: ({ children }) => <code className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded bg-surface2 px-1 py-0.5 text-xs font-mono">{children}</code>,
        pre: ({ children }) => <MarkdownCodeBlock mutedTextClassName={mutedTextClassName}>{children}</MarkdownCodeBlock>,
        blockquote: ({ children }) => <blockquote className="mb-2 border-l-2 border-slate-500 pl-3 text-slate-300">{children}</blockquote>,
        h1: ({ children }) => <h1 className="mb-2 text-xl font-bold">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-2 text-lg font-bold">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-1 text-base font-semibold">{children}</h3>,
        hr: () => <hr className="my-2 border-slate-600" />,
        table: ({ children }) => <div className="mb-2 max-w-full overflow-x-hidden"><table className="w-full table-fixed border-collapse text-left text-xs">{children}</table></div>,
        th: ({ children }) => <th className="break-words border border-slate-500/60 bg-surface2 px-2 py-1.5 font-semibold [overflow-wrap:anywhere]">{children}</th>,
        td: ({ children }) => <td className="break-words border border-slate-500/60 px-2 py-1.5 align-top [overflow-wrap:anywhere]">{children}</td>,
        del: ({ children }) => <>~~{children}~~</>,
        img: ({ src, alt }) => showImages ? (
          <MarkdownImage src={src} alt={alt ?? ''} />
        ) : (
          <a
            href={typeof src === 'string' ? src : undefined}
            target="_blank"
            rel="noopener noreferrer"
            className="my-2 block w-fit max-w-full break-all text-slate-500 opacity-60 chat-image-link hover:text-slate-400"
          >
            {typeof src === 'string' ? src : (alt || '이미지')}
          </a>
        ),
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noopener noreferrer" className="underline text-blue-300 hover:text-blue-200">{children}</a>
        ),
      }}
    >
      {(role==='assistant'?stripThemeDirectives(content,status==='streaming'):content) || (status === 'streaming' ? '다른 창에서 응답을 생성하고 있습니다…' : status === 'interrupted' ? '응답이 중단되었습니다.' : '')}
    </ReactMarkdown>
  );
});

export default MessageContent;
