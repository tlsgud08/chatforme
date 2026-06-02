import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { getApiKey } from '@/lib/apiKeys';
import { generate } from '@/lib/llm';
import { DEFAULT_MODELS, PROVIDER_LABELS } from '@/lib/llm/types';
import { assemblePrompt } from '@/lib/prompt/assemble';
import type { Message, Profile, Session, Work } from '@/types/db';
import SessionMenu from '@/components/SessionMenu';

export default function ChatPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [session, setSession] = useState<Session | null>(null);
  const [work, setWork] = useState<Work | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // 초기 로드
  useEffect(() => {
    (async () => {
      const { data: s } = await supabase.from('sessions').select('*').eq('id', sessionId).single();
      if (!s) return;
      setSession(s as Session);

      const [{ data: w }, { data: p }, { data: cfg }, { data: msgs }] = await Promise.all([
        supabase.from('works').select('*').eq('id', (s as Session).work_id).single(),
        supabase.from('profiles').select('*').eq('id', user!.id).single(),
        supabase.from('platform_config').select('system_prompt').eq('id', 1).single(),
        supabase
          .from('messages')
          .select('*')
          .eq('session_id', sessionId)
          .order('created_at', { ascending: true }),
      ]);
      setWork(w as Work);
      setProfile(p as Profile);
      setSystemPrompt((cfg as { system_prompt: string } | null)?.system_prompt ?? '');
      setMessages((msgs as Message[]) ?? []);
    })();
  }, [sessionId, user]);

  // 자동 스크롤
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, sending]);

  async function send() {
    if (!input.trim() || !session || !work || !profile || sending) return;
    setError('');

    const provider = profile.default_provider;
    const model = profile.default_model || DEFAULT_MODELS[provider][0];
    const apiKey = getApiKey(provider);
    if (!apiKey) {
      setError(`${PROVIDER_LABELS[provider]} API 키가 없습니다. 설정 탭에서 입력하세요.`);
      return;
    }

    const text = input.trim();
    setInput('');
    setSending(true);

    const turnIndex = messages.length;
    // 사용자 메시지 저장 + 화면 반영
    const { data: userMsg } = await supabase
      .from('messages')
      .insert({ session_id: session.id, role: 'user', content: text, turn_index: turnIndex })
      .select('*')
      .single();
    const history = [...messages];
    if (userMsg) setMessages((m) => [...m, userMsg as Message]);

    // 프롬프트 조립
    const assembled = assemblePrompt({
      systemPrompt,
      mainPrompt: work.main_prompt,
      userNote: session.user_note,
      summary: session.summary,
      history: history.map((m) => ({ role: m.role, content: m.content })),
      latestUserMessage: text,
    });

    const maxOutputTokens = session.output_tokens_override ?? profile.default_output_tokens;

    try {
      const result = await generate(provider, {
        apiKey,
        model,
        system: assembled.system,
        messages: assembled.messages,
        maxOutputTokens,
      });

      const { data: aiMsg } = await supabase
        .from('messages')
        .insert({
          session_id: session.id,
          role: 'assistant',
          content: result.text,
          turn_index: turnIndex,
          input_tokens: result.usage.inputTokens,
          output_tokens: result.usage.outputTokens,
        })
        .select('*')
        .single();
      if (aiMsg) setMessages((m) => [...m, aiMsg as Message]);

      // 세션 누적 토큰 갱신
      const newIn = session.total_input_tokens + result.usage.inputTokens;
      const newOut = session.total_output_tokens + result.usage.outputTokens;
      await supabase
        .from('sessions')
        .update({ total_input_tokens: newIn, total_output_tokens: newOut, updated_at: new Date().toISOString() })
        .eq('id', session.id);
      setSession({ ...session, total_input_tokens: newIn, total_output_tokens: newOut });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI 응답 생성에 실패했습니다.');
    } finally {
      setSending(false);
    }
  }

  if (!session || !work) {
    return <div className="flex h-full items-center justify-center text-slate-400">불러오는 중…</div>;
  }

  const totalTokens = session.total_input_tokens + session.total_output_tokens;

  return (
    <div className="mx-auto flex h-full max-w-app flex-col bg-bg">
      {/* 상단바: 작품명 + 세션 누적 토큰 */}
      <header className="flex items-center gap-2 border-b border-surface2 px-3 py-2.5">
        <button onClick={() => navigate('/sessions')} className="text-slate-400">
          ←
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-white">{work.title}</p>
          <p className="text-[11px] text-slate-500">누적 토큰 {totalTokens.toLocaleString()}</p>
        </div>
        <button onClick={() => setMenuOpen(true)} className="px-2 text-xl text-slate-300">
          ☰
        </button>
      </header>

      {/* 메시지 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-4">
        {messages.length === 0 && (
          <p className="mt-8 text-center text-sm text-slate-500">메시지를 입력해 시작하세요.</p>
        )}
        <div className="flex flex-col gap-3">
          {messages.map((m) => (
            <div
              key={m.id}
              className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                m.role === 'user'
                  ? 'self-end bg-brand text-white'
                  : 'self-start bg-surface text-slate-100'
              }`}
            >
              {m.content}
            </div>
          ))}
          {sending && (
            <div className="self-start rounded-2xl bg-surface px-4 py-2.5 text-sm text-slate-400">
              생각 중…
            </div>
          )}
        </div>
      </div>

      {error && <p className="px-3 py-1 text-xs text-amber-400">{error}</p>}

      {/* 입력 */}
      <div className="flex items-end gap-2 border-t border-surface2 p-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
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

      {menuOpen && (
        <SessionMenu
          session={session}
          profile={profile}
          onClose={() => setMenuOpen(false)}
          onUpdate={(patch) => setSession((s) => (s ? { ...s, ...patch } : s))}
        />
      )}
    </div>
  );
}
