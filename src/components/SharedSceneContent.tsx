import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkSpoiler from '../lib/remarkSpoiler.js';

export interface SharedScene {
  title: string;
  start: number;
  end: number;
  hideUser: boolean;
  messages: { turn: number; role: 'user' | 'assistant'; text: string | null }[];
}

export function sceneTurnLabel(start: number, end: number) {
  return start === end ? start + '턴' : start + '–' + end + '턴';
}

const markdownComponents: Components = {
  a: ({ href, children }) => <a href={href} rel="noreferrer noopener ugc" target="_blank">{children}</a>,
  img: ({ src, alt }) => (
    typeof src === 'string' && /^https:\/\//i.test(src)
      ? <img src={src} alt={alt ?? ''} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
      : null
  ),
  span: ({ node, children }) => (
    node?.properties && ('dataSpoiler' in node.properties || 'data-spoiler' in node.properties)
      ? <span className="shared-scene-spoiler" tabIndex={0} title="스포일러">{children}</span>
      : <span>{children}</span>
  ),
};

export default function SharedSceneContent({ scene }: { scene: SharedScene }) {
  return <ol className="shared-scene-messages" aria-label="공유 장면 본문">
    {scene.messages.map((message, index) => {
      const hidden = message.role === 'user' && scene.hideUser;
      return <li key={index}>
        {message.turn !== scene.messages[index - 1]?.turn &&
          <div className="shared-scene-turn">{message.turn}턴</div>}
        <div className={'shared-scene-message shared-scene-' + message.role}>
          <div className="shared-scene-role">{message.role === 'user' ? '유저' : 'AI'}</div>
          {hidden
            ? <span className="shared-scene-hidden">유저 대사 가림</span>
            : <ReactMarkdown skipHtml remarkPlugins={[remarkGfm, remarkSpoiler]} components={markdownComponents}>
              {message.text ?? ''}
            </ReactMarkdown>}
        </div>
      </li>;
    })}
  </ol>;
}
