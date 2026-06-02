import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { getApiKey } from '@/lib/apiKeys';
import { generate } from '@/lib/llm';
import { DEFAULT_MODELS, PROVIDER_LABELS } from '@/lib/llm/types';
import { assemblePrompt } from '@/lib/prompt/assemble';
import {
  guestGetSession, guestAddMessage, guestUpdateSession, guestUpdateMessage, guestDeleteMessage,
  type GuestSession, type GuestMessage,
} from '@/lib/guest';
import type { KeywordBook, Message, Persona, Profile, Session, StartConfig, Work } from '@/types/db';
import SessionMenu from '@/components/SessionMenu';

const GUEST_SETTINGS_KEY = 'nekochat.guest.settings';
interface GuestSettings { provider: 'claude' | 'gemini' | 'openai'; model: string; outputTokens: number | null; }
function loadGuestSettings(): GuestSettings {
  try { return JSON.parse(localStorage.getItem(GUEST_SETTINGS_KEY) ?? '{}') as GuestSettings; }
  catch { return { provider: 'claude', model: '', outputTokens: 1024 }; }
}

function toMsg(m: GuestMessage): Message {
  return { ...m, is_hidden: m.is_hidden ?? false, is_summarized: false, input_tokens: m.input_tokens ?? 0, output_tokens: m.output_tokens ?? 0 };
}

export default function ChatPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const { user, isGuest } = useAuth();

  const [session, setSession] = useState<Session | null>(null);
  const [guestSession, setGuestSession] = useState<GuestSession | null>(null);
  const [work, setWork] = useState<Work | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [persona, setPersona] = useState<Persona | null>(null);
  const [startConfig, setStartConfig] = useState<StartConfig | null>(null);
  const [keywordBooks, setKeywordBooks] = useState<KeywordBook[]>([]);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [debugMode, setDebugMode] = useState(false);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isGuest) {
      const gs = guestGetSession(sessionId!);
      if (!gs) return;
      setGuestSession(gs);
      setMessages(gs.messages.map(toMsg));
      supabase.from('works').select('*').eq('id', gs.work_id).single()
        .then(({ data }) => setWork(data as Work));
      supabase.from('platform_config').select('system_prompt').eq('id', 1).single()
        .then(({ data }) => setSystemPrompt((data as { system_prompt: string } | null)?.system_prompt ?? ''));
      supabase.from('keyword_books').select('*').eq('work_id', gs.work_id).order('sort_order')
        .then(({ data }) => setKeywordBooks((data as KeywordBook[]) ?? []));
      return;
    }

    (async () => {
      const { data: s } = await supabase.from('sessions').select('*').eq('id', sessionId).single();
      if (!s) return;
      const sess = s as Session;
      setSession(sess);

      const [{ data: w }, { data: p }, { data: cfg }, { data: msgs }, { data: kbs }] = await Promise.all([
        supabase.from('works').select('*').eq('id', sess.work_id).single(),
        supabase.from('profiles').select('*').eq('id', user!.id).single(),
        supabase.from('platform_config').select('system_prompt').eq('id', 1).single(),
        supabase.from('messages').select('*').eq('session_id', sessionId).order('created_at', { ascending: true }),
        supabase.from('keyword_books').select('*').eq('work_id', sess.work_id).order('sort_order'),
      ]);
      setWork(w as Work);
      setProfile(p as Profile);
      setSystemPrompt((cfg as { system_prompt: string } | null)?.system_prompt ?? '');
      setMessages((msgs as Message[]) ?? []);
      setKeywordBooks((kbs as KeywordBook[]) ?? []);

      if (sess.persona_id) {
        const { data: pn } = await supabase.from('personas').select('*').eq('id', sess.persona_id).single();
        if (pn) setPersona(pn as Persona);
      }
      if (sess.start_config_id) {
        const { data: sc } = await supabase.from('start_configs').select('*').eq('id', sess.start_config_id).single();
        if (sc) setStartConfig(sc as StartConfig);
      }
    })();
  }, [sessionId, user, isGuest]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, sending]);

  function getActiveKeywordContents(history: Message[], currentInput: string): string[] {
    const userMsgs = [...history.filter((m) => m.role === 'user').map((m) => m.content), currentInput];
    const activated: { content: string; recency: number }[] = [];
    for (const kb of keywordBooks) {
      const kws = kb.keywords.filter((k) => k.trim());
      if (!kws.length || !kb.content.trim()) continue;
      for (let i = userMsgs.length - 1; i >= 0; i--) {
        const turnsAgo = userMsgs.length - 1 - i;
        if (turnsAgo >= kb.activation_turns) break;
        if (kws.some((kw) => userMsgs[i].toLowerCase().includes(kw.toLowerCase()))) {
          activated.push({ content: kb.content, recency: turnsAgo });
          break;
        }
      }
    }
    return activated.sort((a, b) => a.recency - b.recency).slice(0, 3).map((a) => a.content);
  }

  // 히스토리에서 keep_turns 초과한 숨김 메시지 제거
  function buildHistory(allMsgs: Message[]) {
    const userCount = allMsgs.filter((m) => m.role === 'user' && !m.is_hidden).length;
    return allMsgs.filter((m) => {
      if (m.is_hidden && startConfig) return userCount < startConfig.keep_turns;
      if (m.is_hidden && !startConfig) return false;
      return true;
    });
  }

  async function send() {
    if (!input.trim() || !work || sending) return;
    setError('');

    const guestSettings = loadGuestSettings();
    const provider = isGuest ? (guestSettings.provider ?? 'claude') : (profile?.default_provider ?? 'claude');
    const model = isGuest ? (guestSettings.model || DEFAULT_MODELS[provider][0]) : (profile?.default_model || DEFAULT_MODELS[provider][0]);
    const apiKey = getApiKey(provider);
    if (!apiKey) { setError(`${PROVIDER_LABELS[provider]} API 키가 없습니다. 설정 탭에서 입력하세요.`); return; }

    const text = input.trim();
    setInput('');
    setSending(true);
    const now = new Date().toISOString();
    const turnIndex = messages.filter((m) => !m.is_hidden).length;

    if (isGuest && guestSession) {
      const userMsg: GuestMessage = {
        id: crypto.randomUUID(), session_id: guestSession.id, role: 'user',
        content: text, turn_index: turnIndex, input_tokens: 0, output_tokens: 0,
        is_hidden: false, created_at: now,
      };
      guestAddMessage(guestSession.id, userMsg);
      const historyMsgs = buildHistory([...messages]);
      setMessages((m) => [...m, toMsg(userMsg)]);

      const assembled = assemblePrompt({
        systemPrompt, mainPrompt: work.main_prompt, userNote: guestSession.user_note,
        summary: '',
        keywordBookContents: getActiveKeywordContents([...messages], text),
        history: historyMsgs.map((m) => ({ role: m.role, content: m.content })),
        latestUserMessage: text,
      });
      const maxOutputTokens = guestSession.output_tokens_override ?? guestSettings.outputTokens ?? 1024;
      try {
        const result = await generate(provider, { apiKey, model, system: assembled.system, messages: assembled.messages, maxOutputTokens });
        const aiMsg: GuestMessage = {
          id: crypto.randomUUID(), session_id: guestSession.id, role: 'assistant',
          content: result.text, turn_index: turnIndex,
          input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens,
          is_hidden: false, created_at: new Date().toISOString(),
        };
        guestAddMessage(guestSession.id, aiMsg);
        setMessages((m) => [...m, toMsg(aiMsg)]);
        const newIn = guestSession.total_input_tokens + result.usage.inputTokens;
        const newOut = guestSession.total_output_tokens + result.usage.outputTokens;
        guestUpdateSession(guestSession.id, { total_input_tokens: newIn, total_output_tokens: newOut });
        setGuestSession((gs) => gs ? { ...gs, total_input_tokens: newIn, total_output_tokens: newOut } : gs);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'AI 응답 생성에 실패했습니다.');
      } finally { setSending(false); }
      return;
    }

    if (!session || !profile) { setSending(false); return; }

    const { data: userMsg } = await supabase
      .from('messages')
      .insert({ session_id: session.id, role: 'user', content: text, turn_index: turnIndex })
      .select('*').single();
    const historyMsgs = buildHistory([...messages]);
    if (userMsg) setMessages((m) => [...m, userMsg as Message]);

    const assembled = assemblePrompt({
      systemPrompt, mainPrompt: work.main_prompt, userNote: session.user_note,
      summary: session.summary, persona,
      keywordBookContents: getActiveKeywordContents([...messages], text),
      history: historyMsgs.map((m) => ({ role: m.role, content: m.content })),
      latestUserMessage: text,
    });
    const maxOutputTokens = session.output_tokens_override ?? profile.default_output_tokens;
    try {
      const result = await generate(provider, { apiKey, model, system: assembled.system, messages: assembled.messages, maxOutputTokens });
      const { data: aiMsg } = await supabase
        .from('messages')
        .insert({
          session_id: session.id, role: 'assistant', content: result.text, turn_index: turnIndex,
          input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens,
        })
        .select('*').single();
      if (aiMsg) setMessages((m) => [...m, aiMsg as Message]);

      const newIn = session.total_input_tokens + result.usage.inputTokens;
      const newOut = session.total_output_tokens + result.usage.outputTokens;
      await supabase.from('sessions')
        .update({ total_input_tokens: newIn, total_output_tokens: newOut, updated_at: new Date().toISOString() })
        .eq('id', session.id);
      setSession({ ...session, total_input_tokens: newIn, total_output_tokens: newOut });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI 응답 생성에 실패했습니다.');
    } finally { setSending(false); }
  }

  async function deleteMsg(msgId: string) {
    if (isGuest && guestSession) {
      guestDeleteMessage(guestSession.id, msgId);
    } else {
      await supabase.from('messages').delete().eq('id', msgId);
    }
    setMessages((m) => m.filter((msg) => msg.id !== msgId));
  }

  async function saveEdit(msgId: string) {
    const content = editingContent.trim();
    if (!content) return;
    if (isGuest && guestSession) {
      guestUpdateMessage(guestSession.id, msgId, content);
    } else {
      await supabase.from('messages').update({ content }).eq('id', msgId);
    }
    setMessages((m) => m.map((msg) => msg.id === msgId ? { ...msg, content } : msg));
    setEditingId(null);
  }

  const currentSession = isGuest ? guestSession : session;
  const totalTokens = currentSession ? currentSession.total_input_tokens + currentSession.total_output_tokens : 0;
  const visibleMessages = messages.filter((m) => !m.is_hidden || debugMode);

  if (!currentSession || !work) {
    return <div className="flex h-full items-center justify-center text-slate-400">불러오는 중…</div>;
  }

  return (
    <div className="mx-auto flex h-full max-w-app flex-col bg-bg">
      <header className="flex items-center gap-2 border-b border-surface2 px-3 py-2.5">
        <button onClick={() => navigate('/sessions')} className="text-slate-400">←</button>
        <button onClick={() => navigate(`/works/${work.id}`)} className="min-w-0 flex-1 text-left">
          <p className="truncate text-sm font-semibold text-white">{work.title}</p>
          <p className="text-[11px] text-slate-500">누적 토큰 {totalTokens.toLocaleString()}</p>
        </button>
        {!isGuest && (
          <button onClick={() => setMenuOpen(true)} className="px-2 text-xl text-slate-300">☰</button>
        )}
      </header>

      <div ref={scrollRef} className="w-full flex-1 overflow-y-auto overflow-x-hidden px-3 py-4">
        {visibleMessages.length === 0 && (
          <p className="mt-8 text-center text-sm text-slate-500">메시지를 입력해 시작하세요.</p>
        )}
        <div className="flex w-full flex-col gap-3">
          {visibleMessages.map((m) => (
            <div
              key={m.id}
              className={`flex min-w-0 max-w-[85%] flex-col gap-1 ${m.role === 'user' ? 'self-end items-end' : 'self-start items-start'}`}
            >
              {m.is_hidden && debugMode && (
                <p className="text-[10px] text-amber-400">🔍 숨김 메시지</p>
              )}
              {editingId === m.id ? (
                <div className="flex w-full flex-col gap-1.5">
                  <textarea
                    value={editingContent}
                    onChange={(e) => setEditingContent(e.target.value)}
                    rows={3}
                    autoFocus
                    className="w-full resize-none rounded-2xl bg-surface px-4 py-2.5 text-sm text-slate-100 outline-none"
                  />
                  <div className="flex justify-end gap-2">
                    <button onClick={() => setEditingId(null)} className="rounded-lg bg-surface2 px-3 py-1.5 text-xs text-slate-300">취소</button>
                    <button onClick={() => saveEdit(m.id)} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white">저장</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className={`min-w-0 overflow-hidden rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                    m.is_hidden
                      ? 'border border-amber-500/40 bg-surface text-amber-200'
                      : m.role === 'user'
                        ? 'bg-brand text-white'
                        : 'bg-surface text-slate-100'
                  }`}>
                    <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                          strong: ({ children }) => <strong className="font-bold">{children}</strong>,
                          em: ({ children }) => <em className="not-italic opacity-50">{children}</em>,
                          ul: ({ children }) => <ul className="mb-2 list-disc pl-4">{children}</ul>,
                          ol: ({ children }) => <ol className="mb-2 list-decimal pl-4">{children}</ol>,
                          li: ({ children }) => <li className="mb-0.5">{children}</li>,
                          code: ({ children, className }) =>
                            className ? (
                              <code className="block overflow-x-auto rounded-lg bg-surface2 p-3 text-xs font-mono">{children}</code>
                            ) : (
                              <code className="rounded bg-surface2 px-1 py-0.5 text-xs font-mono">{children}</code>
                            ),
                          pre: ({ children }) => <pre className="mb-2">{children}</pre>,
                          blockquote: ({ children }) => <blockquote className="mb-2 border-l-2 border-slate-500 pl-3 text-slate-300">{children}</blockquote>,
                          h1: ({ children }) => <h1 className="mb-2 text-xl font-bold">{children}</h1>,
                          h2: ({ children }) => <h2 className="mb-2 text-lg font-bold">{children}</h2>,
                          h3: ({ children }) => <h3 className="mb-1 text-base font-semibold">{children}</h3>,
                          hr: () => <hr className="my-2 border-slate-600" />,
                          img: ({ src, alt }) => (
                            <img
                              src={src}
                              alt={alt ?? ''}
                              className="my-2 block h-auto w-full max-w-full"
                              loading="lazy"
                            />
                          ),
                          a: ({ href, children }) => (
                            <a href={href} target="_blank" rel="noopener noreferrer" className="underline text-blue-300 hover:text-blue-200">
                              {children}
                            </a>
                          ),
                        }}
                      >
                        {m.content}
                      </ReactMarkdown>
                  </div>
                  {!m.is_hidden && (
                    <div className={`flex gap-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <button
                        onClick={() => { setEditingId(m.id); setEditingContent(m.content); }}
                        className="text-xs text-slate-500"
                      >
                        편집
                      </button>
                      <button
                        onClick={() => deleteMsg(m.id)}
                        className="text-xs text-red-400/60"
                      >
                        삭제
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
          {sending && (
            <div className="self-start rounded-2xl bg-surface px-4 py-2.5 text-sm text-slate-400">생각 중…</div>
          )}
        </div>
      </div>

      {error && <p className="px-3 py-1 text-xs text-amber-400">{error}</p>}

      <div className="flex items-end gap-2 border-t border-surface2 p-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          rows={1}
          placeholder="메시지 입력…"
          className="max-h-32 flex-1 resize-none rounded-2xl bg-surface px-4 py-2.5 text-sm outline-none"
        />
        <button
          onClick={send}
          disabled={sending || !input.trim()}
          className="rounded-full bg-brand px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
        >
          전송
        </button>
      </div>

      {menuOpen && !isGuest && session && (
        <SessionMenu
          session={session}
          profile={profile}
          onClose={() => setMenuOpen(false)}
          onUpdate={(patch) => setSession((s) => (s ? { ...s, ...patch } : s))}
          onPersonaChange={(p) => setPersona(p)}
          debugMode={debugMode}
          onDebugToggle={setDebugMode}
        />
      )}
    </div>
  );
}
