import MessageContent from '@/components/MessageContent';
import { applyCodeBlockStyle, normalizeCodeBlockStyle } from '@/lib/codeBlockStyles';
import { applyCustomTheme, applyTheme, validPalette } from '@/lib/theme';
import { sceneTurnLabel, type SharedScene } from '@/lib/sceneShareView.js';
import '@/components/InterfaceFrame.css';
import './ChatPage.css';
import '@/components/Spoiler.css';

function applyShareDisplay(scene: SharedScene) {
  const variant = scene.viewTheme?.variant === 'light' ? 'light' : 'dark';
  const palette = scene.viewTheme?.palette;
  if (validPalette(palette)) applyCustomTheme(palette, variant);
  else applyTheme(variant);

  const display = scene.display;
  applyCodeBlockStyle(normalizeCodeBlockStyle(display?.codeBlockStyle));
  const root = document.documentElement;
  if (typeof display?.fontSize === 'number' && display.fontSize >= 1 && display.fontSize <= 1000) {
    root.dataset.chatFontSize = 'custom';
    root.style.setProperty('--chat-font-size', display.fontSize + 'px');
  }
  for (const [property, weight] of [['--chat-font-weight', display?.fontWeight], ['--chat-bold-weight', display?.boldWeight]] as const) {
    if (typeof weight === 'number' && weight >= 1 && weight <= 1000) root.style.setProperty(property, String(weight));
  }
}

export function readSharedScene(): SharedScene | null {
  const payload = document.getElementById('shared-scene-data');
  if (!payload?.textContent) return null;
  try {
    return JSON.parse(payload.textContent) as SharedScene;
  } catch {
    return null;
  }
}

export { applyShareDisplay };

export default function SharedScenePage({ scene }: { scene: SharedScene }) {
  const design = scene.display?.interfaceDesign === 'legacy' ? 'legacy' : 'modern';

  return <div className="interface-viewport" data-interface={design}>
    <div className="interface-frame" data-interface={design} data-login data-chat-width-limited={scene.display?.chatWidthLimited || undefined}>
      <div className="interface-content">
        <main className="chat-page mx-auto flex h-full min-h-0 max-w-app flex-col bg-bg">
          <header className="chat-header flex items-center gap-2 border-b border-surface2 px-3 py-2.5">
            <a href="/works" className="interface-brand shrink-0 !basis-auto" aria-label="Inuchat 홈으로 이동">
              <img src="/logo-128.png" alt="" />
            </a>
            <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-white" title={scene.title}>{scene.title}</h1>
            <span className="shrink-0 text-xs text-slate-400">{sceneTurnLabel(scene.start, scene.end)}</span>
          </header>
          <div className="chat-scroll-container relative min-h-0 flex-1">
            <div className="chat-scroll h-full w-full min-h-0 overflow-y-auto overflow-x-hidden px-3 py-4">
              <div className="chat-message-list flex w-full flex-col gap-3">
                {scene.messages.map((message, index) => <article key={index} data-role={message.role} className="chat-message flex w-full min-w-0 flex-col gap-1">
                  {index > 0 && <hr className="chat-turn-divider" aria-label="메시지 구분" />}
                  <div className={'chat-message-body w-full min-w-0 overflow-hidden break-words [overflow-wrap:anywhere] px-4 py-2.5 text-sm leading-relaxed ' +
                    (message.role === 'user' ? 'rounded-2xl bg-brand text-white' : 'text-slate-100')}>
                    {message.role === 'user' && scene.hideUser
                      ? <div className="chat-spoiler chat-spoiler-block min-h-[1.5em] !cursor-default" data-revealed="false" role="img" aria-label="가려진 유저 대사" />
                      : <MessageContent content={message.text ?? ''} role={message.role} status="complete" showImages={scene.display?.showImages !== false} />}
                  </div>
                  {message.role === 'assistant' && <div className="chat-message-actions flex justify-end">
                    <span className="text-[10px] font-medium text-slate-500">{message.turn}턴</span>
                  </div>}
                </article>)}
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  </div>;
}
