import { Fragment, isValidElement, type ReactNode } from 'react';

interface MarkdownCodeBlockProps {
  children: ReactNode;
}

const CODE_EMPHASIS_PATTERN = /(\*\*([^*\n]+)\*\*|\*([^*\n]+)\*)/g;

/** Apply the chat's bold/faded emphasis without treating the rest of a code block as Markdown. */
function formatCodeEmphasis(value: ReactNode): ReactNode {
  if (typeof value !== 'string') return value;

  const parts: ReactNode[] = [];
  let cursor = 0;

  for (const match of value.matchAll(CODE_EMPHASIS_PATTERN)) {
    const index = match.index;
    if (index > cursor) parts.push(value.slice(cursor, index));

    parts.push(match[2]
      ? <strong key={index} className="font-bold">{match[2]}</strong>
      : <em key={index} className="not-italic opacity-50">{match[3]}</em>);
    cursor = index + match[0].length;
  }

  if (cursor < value.length) parts.push(value.slice(cursor));
  return parts.length ? parts.map((part, index) => <Fragment key={index}>{part}</Fragment>) : value;
}

/** Render fenced Markdown code independently of the application's color theme. */
export default function MarkdownCodeBlock({ children }: MarkdownCodeBlockProps) {
  const codeElement = isValidElement<{ className?: string; children?: ReactNode }>(children)
    ? children
    : null;
  const language = codeElement?.props.className?.match(/(?:^|\s)language-([^\s]+)/)?.[1];
  const title = language?.trim() || 'INFO';
  const content = codeElement?.props.children ?? children;

  return (
    <div className="mb-3 max-w-full min-w-0 overflow-hidden rounded-2xl bg-[#232220] text-[#dedde7]">
      <div className="bg-[#45443f] px-5 py-[18px] text-[15px] font-semibold leading-5 text-[#858583]">
        {title}
      </div>
      <pre className="m-0 max-w-full min-w-0 overflow-x-hidden whitespace-pre-wrap break-words bg-[#232220] px-5 py-5 font-sans text-[15px] font-normal leading-[1.7] text-[#dedde7] [overflow-wrap:anywhere] [word-break:break-word]">
        <code className="block max-w-full whitespace-pre-wrap break-words [font-family:inherit] [overflow-wrap:anywhere] [word-break:break-word]">
          {formatCodeEmphasis(content)}
        </code>
      </pre>
    </div>
  );
}
