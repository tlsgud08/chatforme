import { supabase } from './supabase';
import { assemblePrompt } from './prompt/assemble';
import { loadWorkCombination } from './workCombinationData';
import { activeThemeWorkIds } from './workCombination';
import { loadWorkThemeCatalog } from './workThemeData';
import { automaticThemeEnabled, dayNightCatalogNames, dayNightModeEnabled, themeCatalogPrompt } from './themeDirectives';
import { preferredThemeVariant } from './theme';
import { resolvePromptCache } from './llm/promptCache';
import { loadDefaultReasoning } from './modelPreferences';
import { applyMultichatTurnState, type MultichatTurnState, multichatNarrative, multichatParticipantLabels, multichatParticipantName, resolveMultichatReferences, resolveMultichatVariables } from './multichat';
import type { KeywordBook, Message, MultichatMember, Profile, Session, StartConfig, StoryNote, Work } from '@/types/db';

export async function multichatTranscript(id: string): Promise<Message[]> {
  const all: Message[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await supabase.from('messages').select('*').eq('session_id', id).order('turn_index').order('created_at').order('id').range(offset, offset + 499);
    if (error) throw error;
    const rows = (data ?? []) as Message[]; all.push(...rows);
    if (rows.length < 500) return all;
  }
}

export async function prepareMultichatContext(id: string, round: number, profile: Profile, turnState: MultichatTurnState = { progressMode: 'together', activeSlot: null }) {
  const [sessionResult, configResult, membersResult, transcript] = await Promise.all([
    supabase.from('sessions').select('*').eq('id', id).single(),
    supabase.from('platform_config').select('system_prompt,multichat_system_prompt,theme_prompt').eq('id', 1).single(),
    supabase.from('multichat_members').select('*,profiles:public_profiles!multichat_members_public_profile_fk(display_name,avatar_url),personas(name,description)').eq('room_id', id).order('slot'),
    multichatTranscript(id),
  ]);
  for (const result of [sessionResult, configResult, membersResult]) if (result.error) throw result.error;
  const session = sessionResult.data as Session, config = configResult.data!;
  const members = membersResult.data as MultichatMember[];
  if (members.length !== 2) throw new Error('두 참여자의 설정을 불러오지 못했습니다.');
  const [workResult, notesResult, startResult, catalog, booksResult] = await Promise.all([
    supabase.from('works').select('*').eq('id', session.work_id).single(),
    supabase.from('story_notes').select('*').eq('session_id', id).order('created_at'),
    session.start_config_id ? supabase.from('start_configs').select('*').eq('id', session.start_config_id).single() : Promise.resolve({ data: null, error: null }),
    loadWorkThemeCatalog(session, session.user_id),
    supabase.from('keyword_books').select('*').in('work_id', activeThemeWorkIds(session)).order('sort_order'),
  ]);
  for (const result of [workResult, notesResult, startResult, booksResult]) if (result.error) throw result.error;
  const work = workResult.data as Work, start = startResult.data as StartConfig | null;
  const combination = await loadWorkCombination(session, work);
  let summary = session.summary, cutoff = session.summary_last_turn;
  if (cutoff >= round) {
    const { data, error } = await supabase.from('summary_versions').select('*').eq('session_id', id).lt('summarized_through_turn', round).order('summarized_through_turn', { ascending: false }).limit(1);
    if (error) throw error;
    summary = data?.[0]?.content ?? ''; cutoff = data?.[0]?.summarized_through_turn ?? 0;
  }
  const active = transcript.filter(m => m.is_active_variant !== false && m.generation_status === 'complete');
  const latest = transcript.find(m => m.role === 'user' && !m.is_hidden && m.turn_index === round);
  if (!latest) throw new Error('이번 턴의 입력을 불러오지 못했습니다.');
  const history = active.filter(m => m.turn_index < round && (m.is_hidden ? round <= (start?.keep_turns ?? 3) : (m.turn_index > cutoff || m.turn_index === 0 && cutoff === 0)));
  const books = (booksResult.data ?? []) as KeywordBook[];
  const keywords = books.filter(book => {
    const recent = [latest, ...active.filter(m => m.turn_index < round && m.turn_index > round - book.activation_turns)].map(m => m.content).join('\n').toLocaleLowerCase();
    return book.keywords.some(keyword => keyword.trim() && recent.includes(keyword.toLocaleLowerCase()));
  }).map(book => book.content);
  const dayNight = dayNightModeEnabled(session, preferredThemeVariant(profile, 'light'));
  const auto = automaticThemeEnabled(session, catalog.themes, dayNight, !!catalog.scope);
  const cache = resolvePromptCache(session.prompt_cache_enabled ?? false, session.model_override ?? profile.default_model, session.prompt_cache_message_id ?? null, history, session.prompt_cache_auto_latest ?? false);
  const assembled = assemblePrompt({
    systemPrompt: [config.system_prompt, config.multichat_system_prompt].filter(Boolean).join('\n\n'),
    mainPrompt: multichatParticipantLabels([work.main_prompt, work.multichat_prompt].filter(Boolean).join('\n\n')), workCombination: combination,
    userNote: members.map(m => `PC${m.slot} User Notes\n${m.user_note ?? ''}`).join('\n\n'),
    summary, storyNotes: ((notesResult.data ?? []) as StoryNote[]).map(n => n.content), plugins: session.active_plugins,
    keywordBookContents: keywords, autoThemeEnabled: auto, dayNightThemeNames: dayNight ? dayNightCatalogNames(catalog.themes, !!catalog.scope) : [],
    themePrompt: config.theme_prompt, themeCatalog: themeCatalogPrompt(catalog.themes, dayNight, catalog.scope),
    history: history.map(m => ({ role: m.role, content: m.role === 'assistant' ? multichatNarrative(m.content, members) : resolveMultichatVariables(multichatParticipantLabels(m.content), members), ...(m.id === cache.messageId && { cacheBreakpoint: true }) })), latestUserMessage: resolveMultichatVariables(multichatParticipantLabels(latest.content), members),
  });
  for (const key of Object.keys(assembled.systemParts) as (keyof typeof assembled.systemParts)[]) {
    const value = assembled.systemParts[key];
    if (typeof value === 'string') assembled.systemParts[key] = resolveMultichatReferences(value, members);
  }
  assembled.systemParts.core += '\n\nPC1 and PC2 (and user1/user2) are internal participant references, not in-world names. Input labels such as Name(PC1) are metadata. In narration, dialogue and headings, use the mapped character names only; never print PC1, PC2, user1 or user2.';
  assembled.systemParts.persona = members.map(m => `# Internal PC${m.slot} mapping\nCharacter name: ${multichatParticipantName(m.slot, members)}\nDescription: ${resolveMultichatReferences(m.personas?.description ?? '', members)}`).join('\n\n');
  applyMultichatTurnState(assembled.systemParts, turnState);
  return { session, assembled, catalog, dayNight, auto,
    knowledgePCs: members.map(member => ({ name: multichatParticipantName(member.slot, members), aliases: [`PC${member.slot}`], pc: true })),
    knowledgeSetup: JSON.stringify({ main: [work.main_prompt, work.multichat_prompt].join('\n\n'), combination, personas: members.map(m => ({ name: multichatParticipantName(m.slot, members), description: m.personas?.description ?? '' })), start: start?.initial_context ?? '' }), cacheSystemOnly: cache.systemOnly,
    model: session.model_override || profile.default_model,
    reasoning: (session.output_settings_override_enabled ? session.reasoning_override : null) ?? profile.default_reasoning ?? loadDefaultReasoning('openrouter', session.model_override || profile.default_model),
    maxOutputTokens: session.output_settings_override_enabled ? session.output_tokens_override : profile.default_output_tokens,
    sampling: { temperature: session.temperature_override ?? profile.default_temperature ?? 1, temperatureSend: session.temperature_enabled_override ?? profile.default_temperature_enabled ?? false, frequencyPenalty: session.frequency_penalty_override ?? profile.default_frequency_penalty ?? 0, frequencyPenaltySend: session.frequency_penalty_enabled_override ?? profile.default_frequency_penalty_enabled ?? false },
  };
}
