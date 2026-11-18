import { createElement as element } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function sceneTurnLabel(start, end) {
  return start === end ? start + '턴' : start + '–' + end + '턴';
}

const markdownComponents = {
  a: ({ href, children }) => element('a', { href, rel: 'noreferrer noopener ugc', target: '_blank' }, children),
  img: ({ src, alt }) => typeof src === 'string' && /^https:\/\//i.test(src)
    ? element('img', { src, alt: alt ?? '', loading: 'lazy', decoding: 'async', referrerPolicy: 'no-referrer' })
    : null,
};

export default function SharedSceneContent({ scene }) {
  return element('ol', { className: 'shared-scene-messages', 'aria-label': '공유 장면 본문' },
    scene.messages.map((message, index) => {
      const turn = message.turn !== scene.messages[index - 1]?.turn
        ? element('div', { className: 'shared-scene-turn' }, message.turn + '턴')
        : null;
      const role = element('div', { className: 'shared-scene-role' }, message.role === 'user' ? '유저' : 'AI');
      const text = message.role === 'user' && scene.hideUser
        ? element('span', { className: 'shared-scene-hidden' }, '유저 대사 가림')
        : element(ReactMarkdown, { skipHtml: true, remarkPlugins: [remarkGfm], components: markdownComponents }, message.text ?? '');
      const bubble = element('div', { className: 'shared-scene-message shared-scene-' + message.role }, role, text);
      return element('li', { key: index }, turn, bubble);
    }),
  );
}
