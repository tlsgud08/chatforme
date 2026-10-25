import { supabase } from './supabase';
import { fetchMessagePage, type MessagePage } from './sessionData';
import type { KeywordBook, Persona, Profile, Session, StartConfig, StoryNote, Work } from '@/types/db';

export interface ChatContext {
  session: Session;
  profile: Profile;
  systemPrompt: string;
  themePrompt: string;
  keywordBooks: KeywordBook[];
  storyNotes: StoryNote[];
  persona: Persona | null;
  startConfig: StartConfig | null;
}

export async function loadChatContext(session: Session, userId: string, signal: AbortSignal): Promise<ChatContext> {
  signal.throwIfAborted();
  const [profile, config, books, notes, persona, start] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', userId).abortSignal(signal).single(),
    supabase.from('platform_config').select('system_prompt,theme_prompt').eq('id', 1).abortSignal(signal).single(),
    supabase.from('keyword_books').select('*').eq('work_id', session.work_id).order('sort_order').abortSignal(signal),
    supabase.from('story_notes').select('*').eq('session_id', session.id).order('created_at').abortSignal(signal),
    session.persona_id ? supabase.from('personas').select('*').eq('id', session.persona_id).abortSignal(signal).single() : Promise.resolve({ data: null, error: null }),
    session.start_config_id ? supabase.from('start_configs').select('*').eq('id', session.start_config_id).abortSignal(signal).single() : Promise.resolve({ data: null, error: null }),
  ]);
  signal.throwIfAborted();
  for (const result of [profile, config, books, notes, persona, start]) if (result.error) throw result.error;
  if (!profile.data || !config.data) throw new Error('계정 또는 공통 설정을 불러오지 못했습니다.');
  return {
    session, profile: profile.data as Profile, systemPrompt: config.data.system_prompt ?? '', themePrompt: config.data.theme_prompt ?? '',
    keywordBooks: (books.data ?? []) as KeywordBook[], storyNotes: (notes.data ?? []) as StoryNote[],
    persona: persona.data as Persona | null, startConfig: start.data as StartConfig | null,
  };
}

/** Display and prompt readiness are independent. Both start immediately after
 * the owned session is read; failures in background context never hide history. */
export async function loadChatRoom(sessionId: string, userId: string, signal: AbortSignal, callbacks: {
  display: (session: Session, work: Work, page: MessagePage) => void;
  context: (value: ChatContext) => void;
  displayError: (error: unknown) => void;
  contextError: (error: unknown) => void;
}): Promise<void> {
  try {
    signal.throwIfAborted();
    const { data, error } = await supabase.from('sessions').select('*')
      .eq('id', sessionId).eq('user_id', userId).abortSignal(signal).single();
    if (error || !data) throw error ?? new Error('채팅방에 접근할 수 없습니다.');
    signal.throwIfAborted();
    const session = data as Session;
    const display = async () => {
      const [work, page] = await Promise.all([
        supabase.from('works').select('*').eq('id', session.work_id).abortSignal(signal).single(),
        fetchMessagePage(session.id, undefined, signal),
      ]);
      if (work.error || !work.data) throw work.error ?? new Error('작품을 불러오지 못했습니다.');
      if (!signal.aborted) callbacks.display(session, work.data as Work, page);
    };
    await Promise.all([
      display().catch(error => { if (!signal.aborted) callbacks.displayError(error); }),
      loadChatContext(session, userId, signal).then(value => { if (!signal.aborted) callbacks.context(value); })
        .catch(error => { if (!signal.aborted) callbacks.contextError(error); }),
    ]);
  } catch (error) { if (!signal.aborted) callbacks.displayError(error); }
}
