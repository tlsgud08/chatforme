import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { useChatScroll } from '@/hooks/useChatScroll';
import { getApiKey } from '@/lib/apiKeys';
import { generate, type CacheDiagnostic } from '@/lib/llm';
import { createDraftWriter } from '@/lib/draftWriter';
import { multichatGenerationSlot, multichatRoundReady, type MultichatTurnState, multichatNarrative, multichatParticipantName } from '@/lib/multichat';
import { useMultichatEditing, type MultichatItemKind } from '@/hooks/useMultichatEditing';
import { showConfirmDialog } from '@/lib/dialog';
import { multichatTranscript, prepareMultichatContext } from '@/lib/multichatContext';
import { registerAccountTask } from '@/lib/accountTasks';
import { DEFAULT_SUMMARY_PROMPT } from '@/lib/summaryPrompt';
import { normalizeReasoning } from '@/lib/modelPreferences';
import { finalThemeDirective, resolveThemeDirectiveChoice, stripThemeDirectives } from '@/lib/themeDirectives';
import { requestThemeRefresh, paletteFor } from '@/lib/theme';
import { conversationFilename, downloadConversationText, formatConversationText } from '@/lib/chatExport';
import { formatKrw, useUsdKrwRate } from '@/lib/exchangeRate';
import { showToast } from '@/lib/toast';
import SessionMenu from '@/components/SessionMenu';
import SessionMenuFrame from '@/components/SessionMenuFrame';
import MultichatApiSettings from '@/components/MultichatApiSettings';
import MessageContent from '@/components/MessageContent';
import Spoiler from '@/components/Spoiler';
import CommandMenu from '@/components/CommandMenu';
import InterfaceIcon from '@/components/InterfaceIcon';
import { SameWorkFriends } from '@/components/Friends';
import { usePlayingActivity } from '@/hooks/useFriends';
import type { ErrorEntry } from './ChatPage';
import type { Command, MultichatMember, MultichatRoom, Persona, Profile, Session, StartConfig, StoryNote, SummaryVersion } from '@/types/db';
import './ChatPage.css';

interface GameMessage { id: string; room_id: string; round_number: number; role: 'user' | 'assistant'; content: string; generation_status: 'streaming' | 'complete' | 'interrupted'; reroll_index: number; is_active_variant: boolean; generation_slot: 1 | 2 | null; generation_user_id: string | null; claimed_at: string | null; input_tokens: number; output_tokens: number; cost: number; cache_read_tokens: number | null; cache_write_tokens: number | null; created_at: string; }
interface Submission { optimistic?: boolean; id: string; round_number: number; user_id: string; slot: 1 | 2; content: string; persona_name: string; is_skip: boolean; command_name: string | null; created_at: string; }
interface PartyMessage { id: string; sender_user_id: string; content: string; created_at: string; }
interface RoomData { room: MultichatRoom; members: MultichatMember[]; session: Session | null; profile: Profile | null; game: GameMessage[]; submissions: Submission[]; party: PartyMessage[]; notes: StoryNote[]; }
interface Ticket extends MultichatTurnState { messageId: string; round: number; slot: 1 | 2; token: string; }
interface SummaryTicket { id: string; token: string; through: number; mergeIds: string[]; }
interface Completion { target_message: string; token: string; response_text: string; in_tokens: number; out_tokens: number; response_cost: number; read_tokens: number | null; write_tokens: number | null; failed: boolean; }
const errorText = (error: unknown) => (error as { message?: string })?.message || String(error);
const storedKey = (user: string, room: string) => `inuchat.multichat.pending.v2:${user}:${room}`;
const viewKey = 'inuchat.multichat.display';
type Display = { debug: boolean; cost: boolean; krw: boolean; cache: boolean; images: boolean; spoiler: boolean };
function initialDisplay(): Display { try { return { debug: false, cost: true, krw: false, cache: false, images: true, spoiler: false, ...JSON.parse(localStorage.getItem(viewKey) ?? '{}') }; } catch { return { debug: false, cost: true, krw: false, cache: false, images: true, spoiler: false }; } }
async function rows<T>(table: string, column: string, id: string, order = 'created_at'): Promise<T[]> {
  const result: T[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await supabase.from(table).select('*').eq(column, id).order(order).order('id').range(offset, offset + 499);
    if (error) throw error;
    result.push(...(data ?? []) as T[]);
    if ((data?.length ?? 0) < 500) return result;
  }
}
export default function MultichatPage() {
  const { roomId } = useParams(); const { user } = useAuth(); const navigate = useNavigate();
  const [data, setData] = useState<RoomData | null>(null), [loadError, setLoadError] = useState('');
  const [input, setInput] = useState(''), [menuOpen, setMenuOpen] = useState(false), [billingOpen, setBillingOpen] = useState(false);
  const [busy, setBusy] = useState(false), [generating, setGenerating] = useState(false), [summaryGenerating, setSummaryGenerating] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Record<string, CacheDiagnostic>>({});
  const [display, setDisplay] = useState(initialDisplay), [errors, setErrors] = useState<ErrorEntry[]>([]);
  const [commandOpen, setCommandOpen] = useState(false), [command, setCommand] = useState<Command | null>(null);
  const [editing, setEditing] = useState<{ kind: MultichatItemKind; id: string; content: string; original: string } | null>(null);
  const [pending, setPending] = useState<Completion | null>(null), [exporting, setExporting] = useState(false);
  const [personas, setPersonas] = useState<Persona[]>([]), [starts, setStarts] = useState<StartConfig[]>([]);
  const [summaryPending, setSummaryPending] = useState<Record<string, unknown> | null>(null);
  const summaryAttempt = useRef('');
  const [, setClock] = useState(0);
  const optimistic = useRef(new Map<string, { party: boolean; value: Submission | PartyMessage }>());
  const lock = useRef(false), submitLock = useRef(false), summaryLock = useRef(false), combinationLock = useRef(false), mutationLock = useRef(false);
  const controller = useRef<AbortController | null>(null), autoAttempt = useRef(''), readSequence = useRef(0), mounted = useRef(true);
  const exchange = useUsdKrwRate();
  const { scrollRef, rememberScroll } = useChatScroll(roomId, !!data);
  const me = data?.members.find(member => member.user_id === user?.id), isHost = data?.room.host_user_id === user?.id;
  const { others: otherEditors, connectedUserIds, presenceReady } = useMultichatEditing(me ? roomId : undefined, me ? user?.id : undefined, editing);
  const room = data?.room, session = data?.session;
  usePlayingActivity(me && room?.status === 'active' ? room.id : null);
  const streaming = data?.game.find(message => message.role === 'assistant' && message.generation_status === 'streaming');
  const expired = !!streaming?.generation_user_id && Date.now() - Date.parse(streaming.claimed_at ?? '') > 8 * 60_000;
  const summaryQueued = !!data?.room.summary_request_id;
  const writing = !!streaming || generating || summaryGenerating || summaryQueued;
  const participantName = (slot: number) => multichatParticipantName(slot, data?.members ?? []);
  const patchRoom = useCallback((value: MultichatRoom) => { readSequence.current++; setData(old => old && value.id === old.room.id && value.progress_revision >= old.room.progress_revision ? { ...old, room: value } : old); }, []);
  const patchSession = useCallback((patch: Partial<Session>) => { setData(old => old?.session ? { ...old, session: { ...old.session, ...patch } } : old); requestThemeRefresh(); }, []);
  const report = useCallback((error: unknown) => { const text = errorText(error); showToast(text); setErrors(old => [{ id: crypto.randomUUID(), short: text, detail: text, at: new Date().toISOString() }, ...old].slice(0, 30)); }, []);
  const refresh = useCallback(async () => {
    if (!roomId || !user) return;
    const revision = ++readSequence.current;
    const [r, ms] = await Promise.all([
      supabase.from('multichat_rooms').select('*').eq('id', roomId).single(),
      supabase.from('multichat_members').select('*,profiles:public_profiles!multichat_members_public_profile_fk(display_name,avatar_url),personas(name,description)').eq('room_id', roomId).order('slot'),
    ]);
    if (r.error || ms.error || !r.data) throw r.error ?? ms.error ?? new Error('방을 불러오지 못했습니다.');
    const members = (ms.data ?? []) as MultichatMember[], joined = members.some(member => member.user_id === user.id);
    let rest = { session: null, profile: null, game: [], submissions: [], party: [], notes: [] } as Pick<RoomData, 'session' | 'profile' | 'game' | 'submissions' | 'party' | 'notes'>;
    if (joined) {
      const [s, p, game, submissions, party, notes] = await Promise.all([
        supabase.from('sessions').select('*').eq('id', roomId).single(), supabase.from('profiles').select('*').eq('id', user.id).single(),
        rows<GameMessage>('multichat_messages', 'room_id', roomId, 'round_number'), rows<Submission>('multichat_submissions', 'room_id', roomId),
        rows<PartyMessage>('multichat_party_messages', 'room_id', roomId), rows<StoryNote>('story_notes', 'session_id', roomId),
      ]);
      if (s.error || p.error) throw s.error ?? p.error;
      for (const [id, local] of optimistic.current) {
        const present = (local.party ? party : submissions).some(row => row.id === id);
        if (present) optimistic.current.delete(id);
        else if (local.party) party.push(local.value as PartyMessage);
        else submissions.push(local.value as Submission);
      }
      rest = { session: s.data as Session, profile: p.data as Profile, game, submissions, party, notes };
    }
    if (mounted.current && revision === readSequence.current) { setData(old => ({ room: old && old.room.id === r.data.id && old.room.progress_revision > r.data.progress_revision ? old.room : r.data as MultichatRoom, members, ...rest })); setLoadError(''); }
  }, [roomId, user?.id]);
  useEffect(() => {
    mounted.current = true; void refresh().catch(error => setLoadError(errorText(error)));
    const timer = window.setInterval(() => setClock(value => value + 1), 15_000);
    if (roomId && user) { try { const saved = JSON.parse(localStorage.getItem(storedKey(user.id, roomId)) ?? 'null'); if (saved?.target_message && saved?.token) setPending(saved);
      const summary = JSON.parse(localStorage.getItem(storedKey(user.id, roomId) + ':summary') ?? 'null');
      if (summary?.target_room === roomId && summary?.request_id && typeof summary?.summary_text === 'string') setSummaryPending(summary); } catch { /* unavailable storage */ } }
    return () => { mounted.current = false; readSequence.current++; window.clearInterval(timer); controller.current?.abort(); };
  }, [refresh, roomId, user?.id]);
  useEffect(() => {
    if (!roomId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { void refresh().catch(report); }, 100); };
    const channel = supabase.channel(`multichat-v2:${roomId}:${crypto.randomUUID()}`);
    channel.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'multichat_rooms', filter: `id=eq.${roomId}` }, payload => { patchRoom(payload.new as MultichatRoom); schedule(); });
    channel.on('postgres_changes', { event: '*', schema: 'public', table: 'multichat_members', filter: `room_id=eq.${roomId}` }, schedule);
    channel.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `id=eq.${roomId}` }, payload => patchSession(payload.new as Session));
    for (const [table, key] of [['multichat_messages', 'game'], ['multichat_submissions', 'submissions'], ['multichat_party_messages', 'party'], ['story_notes', 'notes']] as const) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table, filter: `${key === 'notes' ? 'session_id' : 'room_id'}=eq.${roomId}` }, payload => {
        const row = (payload.eventType === 'DELETE' ? payload.old : payload.new) as { id: string };
        if (!row.id) { schedule(); return; }
        optimistic.current.delete(row.id);
        setData(old => {
          if (!old) return old;
          const values = old[key].filter(item => item.id !== row.id);
          return { ...old, [key]: payload.eventType === 'DELETE' ? values : [...values, payload.new] } as RoomData;
        });
      });
    }
    channel.subscribe(status => { if (status === 'SUBSCRIBED') schedule(); });
    const focus = () => { void refresh().catch(report); };
    window.addEventListener('focus', focus);
    return () => { clearTimeout(timer); window.removeEventListener('focus', focus); void supabase.removeChannel(channel); };
  }, [roomId, refresh, report, patchRoom, patchSession]);
  useEffect(() => { try { localStorage.setItem(viewKey, JSON.stringify(display)); } catch { /* display remains usable */ } }, [display]);
  useEffect(() => { setEditing(null); }, [roomId, user?.id]);
  useEffect(() => {
    if (!data) return;
    setEditing(old => {
      if (!old) return old;
      const items = old.kind === 'submission' ? data.submissions : old.kind === 'assistant' ? data.game : data.party;
      return items.some(item => item.id === old.id) ? old : null;
    });
  }, [data]);
  useEffect(() => {
    if (!user || !data) return;
    void supabase.from('personas').select('*').eq('user_id', user.id).order('is_default', { ascending: false }).then(({ data: rows }) => setPersonas((rows ?? []) as Persona[]));
    if (data.room.status === 'lobby') void supabase.from('start_configs').select('*').eq('work_id', data.room.work_id).order('sort_order').then(({ data: rows }) => setStarts((rows ?? []) as StartConfig[]));
  }, [user?.id, data?.room.work_id, data?.room.status]);
  async function commit(completion: Completion) {
    const { error } = await supabase.rpc('finish_multichat_response', completion); if (error) throw error;
    setPending(null); if (user && roomId) { try { localStorage.removeItem(storedKey(user.id, roomId)); } catch { /* memory cleared */ } }
  }
  async function summarize(through?: number, merging: SummaryVersion[] = []) {
    if (!room || !me) return;
    const { error } = await supabase.rpc('request_multichat_summary', { target_room: room.id, through_round: through ?? null, merge_ids: merging.map(version => version.id) });
    if (error) report(error); else { showToast('API 키 담당자에게 요약을 요청했습니다.'); await refresh(); }
  }
  async function processSummary(ticket: SummaryTicket) {
    if (!data?.session || !data.profile || !me || summaryLock.current || lock.current) return;
    const key = getApiKey('openrouter');
    summaryLock.current = true; setSummaryGenerating(true);
    const abort = new AbortController(), unregister = registerAccountTask(abort);
    controller.current = abort;
    const timeout = setTimeout(() => abort.abort(), 8 * 60_000);
    try {
      if (!key.trim()) throw new Error('요약 담당 PC의 API 키를 설정하거나 키 사용 규칙을 변경해 주세요.');
      const merged = ticket.mergeIds.length ? await supabase.from('summary_versions').select('*').eq('session_id', data.room.id).in('id', ticket.mergeIds) : { data: [], error: null };
      if (merged.error) throw merged.error;
      const merging = (merged.data ?? []) as SummaryVersion[];
      const [transcript, live] = await Promise.all([multichatTranscript(data.room.id), supabase.from('sessions').select('*').eq('id', data.room.id).single()]);
      if (live.error) throw live.error;
      const s = live.data as Session, profile = data.profile;
      const latestComplete = Math.max(0, ...transcript.filter(m => m.role === 'assistant' && m.is_active_variant !== false && m.generation_status === 'complete').map(m => m.turn_index));
      const end = Math.min(ticket.through, latestComplete);
      const source = transcript.filter(m => m.is_active_variant !== false && m.generation_status === 'complete' && m.turn_index <= end);
      if (transcript.some(m => m.generation_status === 'streaming') || !source.length) throw new Error('완료된 대화가 없습니다.');
      const previous = merging.length ? merging.map(version => version.content).join('\n\n') : (s.summary_source_mode_override ?? profile.summary_source_mode) === 'full' ? '' : s.summary;
      const body = merging.length ? '' : source.filter(m => !previous || m.turn_index > s.summary_last_turn || m.is_hidden).map(m => `[${m.role === 'user' ? 'PC' : 'AI'}]\n${stripThemeDirectives(m.content)}`).join('\n\n');
      const model = s.summary_model_override || profile.summary_model || profile.default_model;
      const result = await generate('openrouter', { apiKey: key, model, sessionId: `${s.id}:summary`, signal: abort.signal, reasoning: normalizeReasoning(s.summary_reasoning_override ?? profile.summary_reasoning, 'openrouter', model), maxOutputTokens: 4096,
        systemParts: { core: [profile.summary_prompt || DEFAULT_SUMMARY_PROMPT, `SUMMARY_LEVEL=${s.summary_level_override ?? profile.summary_level ?? 5}\nALLOW_OMISSION=${(s.summary_allow_omission_override ?? profile.summary_allow_omission) ? 'ON' : 'OFF'}`, profile.summary_extra_note].filter(Boolean).join('\n\n'), persona: '', userNote: '', summary: '', keywords: '' },
        messages: [{ role: 'user', content: [previous && `Previous Summary:\n${previous}`, body && `Dialogue:\n${body}`].filter(Boolean).join('\n\n') }],
      });
      if (!result.text.trim()) throw new Error('요약 모델이 빈 응답을 반환했습니다.');
      const completion = { target_room: s.id, request_id: ticket.id, token: ticket.token, summary_text: result.text, through_turn: end, previous_summary: s.summary, in_tokens: result.usage.inputTokens, out_tokens: result.usage.outputTokens, response_cost: result.usage.cost, source_versions: source.map(m => ({ id: m.id, version: m.content_version ?? 0 })) };
      setSummaryPending(completion);
      if (user && roomId) { try { localStorage.setItem(storedKey(user.id, roomId) + ':summary', JSON.stringify(completion)); } catch { /* retained in memory */ } }
      const { data: saved, error } = await supabase.rpc('finish_multichat_summary', completion);
      if (error) throw error; setSummaryPending(null); if (user && roomId) { try { localStorage.removeItem(storedKey(user.id, roomId) + ':summary'); } catch { /* acknowledged */ } } patchSession(saved as Session);
    } catch (error) { await supabase.rpc('fail_multichat_summary', { target_room: data.room.id, request_id: ticket.id, token: ticket.token, error_text: errorText(error) }); report(error); } finally { clearTimeout(timeout); unregister(); controller.current = null; summaryLock.current = false; setSummaryGenerating(false); await refresh().catch(report); }
  }
  async function runGeneration(retry = false) {
    if (!data?.profile || !me || lock.current || pending || summaryLock.current) return;
    const key = getApiKey('openrouter'); if (!key.trim()) { report(`PC${me.slot}의 API 키를 설정하거나 키 사용 규칙을 변경해 주세요.`); return; }
    lock.current = true; setGenerating(true);
    const abort = new AbortController(); controller.current = abort; const unregister = registerAccountTask(abort);
    const timeout = setTimeout(() => abort.abort('생성 시간이 초과되었습니다.'), 8 * 60_000);
    let ticket: Ticket | null = null, partial = '', completion: Completion | null = null;
    let writer: ReturnType<typeof createDraftWriter> | undefined;
    let completedRound = 0;
    try {
      const claim = await supabase.rpc('claim_multichat_response', { target_room: data.room.id, retry });
      if (claim.error) throw claim.error; if (!claim.data) return; ticket = claim.data as Ticket;
      const prepared = await prepareMultichatContext(data.room.id, ticket.round, data.profile, ticket);
      abort.signal.throwIfAborted();
      writer = createDraftWriter(async text => { const { error } = await supabase.rpc('stream_multichat_response', { target_message: ticket!.messageId, token: ticket!.token, partial_text: text }); if (error) throw error; });
      await refresh();
      const result = await generate('openrouter', { apiKey: key, sessionId: data.room.id, signal: abort.signal, model: prepared.model, reasoning: prepared.reasoning, maxOutputTokens: prepared.maxOutputTokens, sampling: prepared.sampling, ...prepared.assembled, cacheSystemOnly: prepared.cacheSystemOnly,
        onChunk: text => { partial = multichatNarrative(text, data.members); writer?.push(partial); setData(old => old ? { ...old, game: old.game.map(message => message.id === ticket!.messageId ? { ...message, content: partial } : message) } : old); },
      });
      if (!result.text.trim()) throw new Error('AI가 빈 응답을 반환했습니다.');
      setDiagnostics(old => ({ ...old, [ticket!.messageId]: result.cacheDiagnostic }));
      await writer.stop();
      completion = { target_message: ticket.messageId, token: ticket.token, response_text: multichatNarrative(result.text, data.members), in_tokens: result.usage.inputTokens, out_tokens: result.usage.outputTokens, response_cost: result.usage.cost, read_tokens: result.usage.cacheReadTokens, write_tokens: result.usage.cacheCreationTokens, failed: false };
      setPending(completion); if (user && roomId) { try { localStorage.setItem(storedKey(user.id, roomId), JSON.stringify(completion)); } catch { /* retain in memory */ } }
      await commit(completion); completedRound = ticket.round;
      const choice = prepared.auto ? resolveThemeDirectiveChoice(finalThemeDirective(result.text), prepared.catalog.themes, prepared.dayNight, !!prepared.catalog.scope) : null;
      if (choice) {
        const palette = paletteFor(choice.theme, prepared.session.theme_variant ?? 'light');
        const { error } = await supabase.from('sessions').update({ theme_id: choice.theme.id, theme_variant: palette?.variant ?? 'light', theme_period: choice.period }).eq('id', data.room.id).is('theme_override', null);
        if (error) report('테마 저장 실패: ' + error.message); else requestThemeRefresh();
      }
    } catch (error) {
      await writer?.stop();
      if (ticket && !completion) { try { await commit({ target_message: ticket.messageId, token: ticket.token, response_text: partial, in_tokens: 0, out_tokens: 0, response_cost: 0, read_tokens: null, write_tokens: null, failed: true }); } catch (saveError) { report(saveError); } }
      report(completion ? '받은 응답의 저장을 확인하지 못했습니다. 보관한 응답을 다시 저장해 주세요.' : error);
    } finally {
      clearTimeout(timeout); unregister(); controller.current = null; lock.current = false; setGenerating(false); await refresh().catch(report);
    }
    if (completedRound && data.session?.auto_summary_enabled && completedRound - data.session.summary_last_turn >= (data.session.summary_interval_override ?? data.profile.summary_interval ?? 10)) await summarize(completedRound);
  }
  useEffect(() => {
    if (!data || !me || data.room.status !== 'active' || generating || pending || editing || busy || data.room.summary_request_id) return;
    const queued = data.game.find(message => message.role === 'assistant' && message.generation_status === 'streaming' && !message.generation_user_id);
    const currentResponse = data.game.some(message => message.role === 'assistant' && message.round_number === data.room.current_round);
    const ready = multichatRoundReady(data.room, data.submissions);
    if (!queued && (currentResponse || !ready)) return;
    const payer = queued?.generation_slot ?? multichatGenerationSlot(data.room.current_round, data.room);
    if (payer !== me.slot) return;
    const attempt = `${queued?.id ?? data.room.current_round}:${data.room.updated_at}`;
    if (autoAttempt.current === attempt) return; autoAttempt.current = attempt;
    void runGeneration();
  }, [data, me?.slot, generating, pending, editing?.id, busy]);
  useEffect(() => {
    if (!data?.room.summary_request_id || !me || data.room.summary_error || summaryLock.current || lock.current || summaryPending) return;
    if (multichatGenerationSlot(data.room.current_round, data.room) !== me.slot) return;
    if (data.room.summary_claimed_by && Date.now() - Date.parse(data.room.summary_claimed_at ?? '') < 8 * 60_000) return;
    const attempt = `${data.room.summary_request_id}:${data.room.billing_mode}:${data.room.billing_start_round}:${data.room.progress_revision}`;
    if (summaryAttempt.current === attempt) return; summaryAttempt.current = attempt;
    void (async () => {
      const { data: ticket, error } = await supabase.rpc('claim_multichat_summary', { target_room: data.room.id });
      if (error) report(error); else if (ticket) await processSummary(ticket as SummaryTicket);
    })();
  }, [data, me?.slot, summaryPending]);
  async function send(party = false) {
    if (!data || !me || submitLock.current || combinationLock.current) return;
    if (!party && (data.room.progress_mode === 'solo' && data.room.solo_slot !== me.slot || writing)) return;
    const submitted = input.trim(); if (party && !submitted) return;
    const submissionId = crypto.randomUUID();
    const originalCommand = command;
    setInput('');
    const local = party ? { id: submissionId, sender_user_id: user!.id, content: submitted, created_at: new Date().toISOString() } : { id: submissionId, round_number: data.room.current_round, user_id: user!.id, slot: me.slot, content: submitted, persona_name: me.personas?.name || `PC${me.slot}`, is_skip: !submitted, command_name: command?.name ?? null, created_at: new Date().toISOString(), optimistic: true };
    optimistic.current.set(submissionId, { party, value: local });
    if (party) setData(old => old ? { ...old, party: [...old.party, local as PartyMessage] } : old);
    else setData(old => old ? { ...old, submissions: [...old.submissions, local as Submission] } : old);
    submitLock.current = true; setBusy(true);
    try {
      const result = party ? await supabase.from('multichat_party_messages').insert({ id: submissionId, room_id: data.room.id, sender_user_id: user!.id, content: submitted }).select('*').single()
        : await supabase.rpc('submit_multichat_action_checked', { target_room: data.room.id, expected_round: data.room.current_round, expected_progress_revision: data.room.progress_revision, submission_content: submitted, command_label: command?.name ?? null, command_body: command?.prompt ?? null, submission_id: submissionId });
      if (result.error) {
        const confirmation = await supabase.from(party ? 'multichat_party_messages' : 'multichat_submissions').select('id').eq('id', submissionId).maybeSingle();
        if (confirmation.error || !confirmation.data) throw result.error;
      }
      optimistic.current.delete(submissionId);
      if (!party) setCommand(old => old?.id === originalCommand?.id ? null : old); await refresh();
    } catch (error) {
      optimistic.current.delete(submissionId);
      setData(old => old ? { ...old, submissions: old.submissions.filter(s => s.id !== submissionId), party: old.party.filter(p => p.id !== submissionId) } : old);
      setInput(old => old ? `${submitted}\n${old}` : submitted); report(error); await refresh().catch(report);
    } finally { submitLock.current = false; setBusy(false); }
  }
  async function requestReroll() {
    if (!isHost || !room || writing) return;
    const { error } = await supabase.rpc('request_multichat_reroll', { target_room: room.id }); if (error) report(error); else await refresh();
  }
  async function saveEdit() {
    if (!editing || !room || !me || busy || mutationLock.current) return;
    mutationLock.current = true; setBusy(true);
    try { const { error } = await supabase.rpc('edit_multichat_item_checked', { target_room: room.id, item_kind: editing.kind, item_id: editing.id, new_content: editing.content, expected_content: editing.original }); if (error) throw error; setEditing(null); await refresh(); } catch (error) { report(error); } finally { mutationLock.current = false; setBusy(false); }
  }
  async function deleteItem(kind: MultichatItemKind, id: string, original: string) {
    if (!room || !me || busy || mutationLock.current) return;
    mutationLock.current = true; setBusy(true);
    try {
      if (!await showConfirmDialog('이 메시지를 삭제할까요?', '삭제한 메시지는 두 참여자의 대화에서 함께 사라집니다.', '삭제')) return;
      const { error } = await supabase.rpc('delete_multichat_item', { target_room: room.id, item_kind: kind, item_id: id, expected_content: original });
      if (error) throw error;
      setEditing(old => old?.id === id ? null : old); await refresh();
    } catch (error) { report(error); } finally { mutationLock.current = false; setBusy(false); }
  }
  async function exportConversation() { if (!room || exporting) return; setExporting(true); try { downloadConversationText(formatConversationText(await multichatTranscript(room.id)), conversationFilename(room.title)); } catch (error) { report(error); } finally { setExporting(false); } }
  async function join() { if (!room || busy) return; setBusy(true); const { error } = await supabase.rpc('join_multichat_room', { target_room: room.id }); if (error) report(error); else await refresh(); setBusy(false); }
  if (!data || !room) return <div className="p-6 text-sm text-slate-400" role="status">{loadError || '불러오는 중…'}{loadError && <button className="ml-3 underline" onClick={() => void refresh().catch(report)}>다시 시도</button>}</div>;
  const nextPayer = streaming?.generation_slot ?? multichatGenerationSlot(Math.max(1, room.current_round), room);
  const soloBlocked = room.progress_mode === 'solo' && room.solo_slot !== me?.slot;
  const mine = data.submissions.some(s => s.round_number === room.current_round && s.user_id === user?.id);
  const changeDisplay = (name: keyof Display) => (value: boolean) => setDisplay(old => ({ ...old, [name]: value }));
  const menuSession = session && me ? { ...session, persona_id: me.persona_id, user_note: me.user_note ?? '' } : null;
  const timeline = [
    ...data.game.filter(m => m.role === 'assistant' && (m.is_active_variant || m.generation_status === 'streaming')).map(m => ({ kind: 'assistant' as const, id: m.id, content: multichatNarrative(m.content, data.members), sourceContent: m.content, commandName: null, pc: null, time: m.created_at, round: m.round_number, message: m })),
    ...data.submissions.map(s => ({ kind: 'submission' as const, id: s.id, content: s.is_skip ? '[skip]' : s.content, sourceContent: s.content, commandName: s.command_name, pc: s.slot, time: s.created_at, round: s.round_number, message: null })),
    ...data.party.map(p => ({ kind: 'party' as const, id: p.id, content: p.content, sourceContent: p.content, commandName: null, pc: data.members.find(m => m.user_id === p.sender_user_id)?.slot ?? null, time: p.created_at, round: null, message: null })),
  ].sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
  const lastAI = [...data.game].filter(m => m.role === 'assistant' && m.round_number === room.current_round - 1 && m.is_active_variant).sort((a, b) => b.reroll_index - a.reroll_index)[0];
  return <div className="chat-page mx-auto flex h-full min-h-0 max-w-app flex-col bg-bg">
    <header className="chat-header flex items-center gap-2 border-b border-surface2 px-3 py-2.5"><button aria-label="채팅방 목록으로" onClick={() => navigate('/sessions?tab=multichat')} className="text-slate-400"><InterfaceIcon name="back" /></button><div className="min-w-0 flex-1"><div className="flex min-w-0 items-center gap-2"><p className="min-w-0 truncate text-sm font-semibold text-white">{room.title}</p><SameWorkFriends workId={room.work_id} /></div><p className="text-xs text-slate-500">{data.members.map(m => `${participantName(m.slot)}`).join(' · ')}{room.status === 'active' ? ` · ${room.current_round}턴${room.progress_mode === 'solo' ? ` · ${participantName(room.solo_slot!)} 혼자 진행 중` : ''}` : ' · 시작 전'}</p></div>{me && <button aria-label="세션 메뉴 열기" onClick={() => session && room.status !== 'lobby' ? setMenuOpen(true) : setBillingOpen(true)} className="px-2 text-slate-300"><InterfaceIcon name="menu" /></button>}</header>
    {room.status === 'lobby' ? <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <p className="mb-5 text-sm text-slate-400">목록에 공개된 방이에요. 빈자리에 바로 참가할 수 있어요.</p>
      {data.members.map(m => <div key={m.user_id} className="mb-3 flex items-center gap-3 rounded-xl bg-surface p-4"><span className="flex-1 text-sm text-white">{participantName(m.slot)}{m.slot === 1 ? ' · 방장' : ' · 참여자'}</span>{isHost && m.slot === 2 && <button className="text-xs text-red-400" onClick={() => void supabase.rpc('kick_multichat_member', { target_room: room.id, target_user: m.user_id }).then(({ error }) => error ? report(error) : refresh())}>추방</button>}</div>)}
      {me ? <><label className="mt-5 block text-sm text-slate-300">내 페르소나<select aria-label="내 페르소나" value={me.persona_id ?? ''} onChange={event => void supabase.rpc('set_multichat_persona', { target_room: room.id, target_persona: event.target.value || null }).then(({ error }) => error ? report(error) : refresh())} className="mt-2 w-full rounded-lg bg-surface p-3"><option value="">페르소나 미사용</option>{personas.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        {isHost && session && <label className="mt-4 block text-sm text-slate-300">시작 설정<select value={session.start_config_id ?? ''} onChange={event => void supabase.from('sessions').update({ start_config_id: event.target.value || null }).eq('id', room.id).then(({ error }) => error ? report(error) : refresh())} className="mt-2 w-full rounded-lg bg-surface p-3"><option value="">시작 메시지 없음</option>{starts.map(start => <option key={start.id} value={start.id}>{start.name}</option>)}</select></label>}
        <button className="mt-4 w-full rounded-lg bg-surface px-4 py-3 text-sm text-white" onClick={() => setBillingOpen(true)}>API 키 사용 규칙 · 현재 {participantName(nextPayer)} 담당</button>
        {isHost ? <button disabled={data.members.length !== 2 || busy} onClick={() => void supabase.rpc('start_multichat', { target_room: room.id }).then(({ error }) => error ? report(error) : refresh())} className="mt-4 w-full rounded-lg bg-brand py-3 font-semibold text-white disabled:opacity-40">함께 시작하기</button> : <p className="mt-5 text-center text-sm text-slate-400">방장이 시작하기를 기다리고 있어요.</p>}
      </> : <button disabled={data.members.length >= 2 || busy} className="w-full rounded-lg bg-brand py-3 text-white disabled:opacity-40" onClick={() => void join()}>{data.members.length < 2 ? '바로 참가하기' : '방이 가득 찼어요'}</button>}
    </div> : !me ? <p className="p-6 text-sm text-slate-400">진행 중인 방이에요. 두 참여자만 대화를 열 수 있어요.</p> : <>
      {summaryPending && <div role="alert" className="border-b border-surface2 p-3 text-xs text-amber-300">요약 응답을 보관 중입니다. <button className="underline" onClick={async () => { const saved = await supabase.rpc('finish_multichat_summary', summaryPending); if (saved.error) report(saved.error); else { setSummaryPending(null); if (user && roomId) { try { localStorage.removeItem(storedKey(user.id, roomId) + ':summary'); } catch { /* acknowledged */ } } patchSession(saved.data as Session); await refresh(); } }}>요약 저장 재시도</button><button className="ml-3 underline" onClick={() => downloadConversationText(String(summaryPending.summary_text), conversationFilename(room.title + '_보관요약'))}>TXT 보관</button><button className="ml-3 underline" onClick={() => { setSummaryPending(null); if (user && roomId) { try { localStorage.removeItem(storedKey(user.id, roomId) + ':summary'); } catch { /* local copy only */ } } }}>기기 사본 닫기</button></div>}
      {room.summary_request_id && <div className="border-b border-surface2 p-3 text-xs text-slate-400">{room.summary_error || (room.summary_claimed_by ? '공용 메모리 요약 생성 중…' : `${participantName(nextPayer)}의 API 키로 요약 대기 중…`)}{(room.summary_error || room.summary_claimed_at && Date.now() - Date.parse(room.summary_claimed_at) > 8 * 60_000) && !summaryPending && <button className="ml-3 underline" onClick={() => void summarize()}>요약 다시 시도</button>}</div>}
      {pending && <section className="border-b border-surface2 bg-surface p-3 text-xs text-amber-300" role="alert"><p>보관한 응답이 있어요. AI를 다시 호출하지 않고 저장만 재시도해요.</p><button disabled={busy} className="mt-2 underline" onClick={async () => { setBusy(true); try { await commit(pending); await refresh(); } catch (error) { report(error); } finally { setBusy(false); } }}>응답 저장 다시 시도</button><button className="ml-4 underline" onClick={() => downloadConversationText(pending.response_text, conversationFilename(room.title + '_보관응답'))}>TXT 보관</button></section>}
      <div ref={scrollRef} onScroll={rememberScroll} className="chat-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-4 [overflow-anchor:none]">
        <div className="chat-message-list flex w-full flex-col gap-3">{timeline.map(item => <article key={item.id} data-scroll-anchor={item.id} data-role={item.kind === 'assistant' ? 'assistant' : 'user'} className="chat-message flex min-w-0 flex-col gap-1">
          {item.pc && <div className="flex items-center justify-end gap-2 px-2 text-xs text-slate-500">{participantName(item.pc)}{item.kind === 'party' && <span>· 유저 간 대화 · AI 제외</span>}</div>}
          {editing?.id === item.id ? <div><textarea aria-label="메시지 수정" value={editing.content} onChange={event => setEditing(old => old ? { ...old, content: event.target.value } : old)} rows={4} className="w-full rounded-xl bg-surface p-3 text-sm text-white" /><div className="mt-2 flex justify-end gap-3"><button onClick={() => setEditing(null)} className="text-xs text-slate-400">취소</button><button disabled={busy} onClick={() => void saveEdit()} className="rounded-lg bg-brand px-3 py-2 text-xs text-white">저장</button></div></div> : <div className={`chat-message-body min-w-0 break-words px-4 py-2.5 text-sm leading-relaxed [overflow-wrap:anywhere] ${item.kind === 'party' ? 'ml-auto w-[90%] rounded-2xl border border-dashed border-slate-500 bg-surface text-slate-200' : item.kind === 'submission' ? 'rounded-2xl bg-brand text-white' : 'text-slate-100'}`}>
            {item.commandName && <p className="mb-2 font-semibold">/{item.commandName}</p>}{display.spoiler && item.kind === 'submission' ? <Spoiler block><MessageContent content={item.content} role="user" status="complete" showImages={display.images} /></Spoiler> : <MessageContent content={item.content || (item.message?.generation_status === 'interrupted' ? '생성 중단 · 다시 시도해 주세요.' : '생각 중…')} role={item.kind === 'assistant' ? 'assistant' : 'user'} status={item.message?.generation_status ?? 'complete'} showImages={display.images} />}
          </div>}
          {otherEditors.some(editor => editor.target?.id === item.id && editor.target.kind === item.kind && data.members.some(member => member.user_id === editor.user_id)) && <p role="status" className="px-2 text-xs text-brand">상대방이 수정 중…</p>}
          {display.debug && item.message && <details className="rounded-lg bg-surface p-2 text-xs text-slate-400"><summary>생성·캐시 진단</summary><pre className="mt-2 whitespace-pre-wrap break-all">{JSON.stringify(diagnostics[item.id] ?? { round: item.round, cacheReadTokens: item.message.cache_read_tokens, cacheWriteTokens: item.message.cache_write_tokens, generationStatus: item.message.generation_status }, null, 2)}</pre></details>}<div className="chat-message-actions flex min-w-0 items-center gap-2 text-slate-500"><button disabled={busy || (item.kind !== 'party' && writing) || optimistic.current.has(item.id)} aria-label="메시지 편집" onClick={() => setEditing({ kind: item.kind, id: item.id, content: item.kind === 'submission' ? item.sourceContent : item.content, original: item.sourceContent })} className="chat-message-action disabled:opacity-40"><InterfaceIcon name="edit" /></button><button disabled={busy || (item.kind !== 'party' && writing) || optimistic.current.has(item.id)} aria-label="메시지 삭제" onClick={() => void deleteItem(item.kind, item.id, item.sourceContent)} className="chat-message-action text-red-400 disabled:opacity-40"><InterfaceIcon name="delete" /></button>{item.message && <div className="ml-auto flex flex-wrap items-center justify-end gap-2 text-[10px]">{display.cost && <span>{display.krw ? formatKrw(item.message.cost, exchange.rate) : `$${item.message.cost.toFixed(6)}`} · 출력 {item.message.output_tokens} tokens</span>}{display.cache && <span>캐시 읽기 {item.message.cache_read_tokens ?? '미보고'} · 쓰기 {item.message.cache_write_tokens ?? '미보고'}</span>}<span>{item.round}턴</span>{isHost && data.game.filter(m => m.role === 'assistant' && m.round_number === item.round && m.generation_status === 'complete').length > 1 && <select aria-label="리롤 답변 선택" disabled={writing} value={item.id} onChange={event => void supabase.rpc('select_multichat_variant', { target_room: room.id, target_message: event.target.value }).then(({ error }) => error ? report(error) : refresh())} className="max-w-28 bg-transparent text-xs text-slate-400">{data.game.filter(m => m.role === 'assistant' && m.round_number === item.round && m.generation_status === 'complete').sort((a, b) => a.reroll_index - b.reroll_index).map((m, index) => <option value={m.id} key={m.id}>답변 {index + 1}</option>)}</select>}{isHost && item.id === lastAI?.id && <button disabled={writing || busy} aria-label="다시 생성" onClick={() => void requestReroll()} className="text-brand disabled:opacity-40"><InterfaceIcon name="reroll" /></button>}</div>}</div>
        </article>)}</div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-surface2 px-3 py-2 text-xs text-slate-400"><span>{(room.progress_mode === 'solo' ? [room.solo_slot!] : [1, 2]).map(slot => `${participantName(slot)} ${data.submissions.some(s => s.slot === slot && s.round_number === room.current_round) ? '제출 완료' : '입력 중'}`).join(' · ')}</span><button onClick={() => setBillingOpen(true)}>호출 · {participantName(nextPayer)} 키</button>{((!streaming || expired) && data.game.some(m => m.role === 'assistant' && m.generation_status === 'interrupted' && m.round_number >= room.current_round - 1) || expired) && <button disabled={generating || !!pending} onClick={() => void runGeneration(true)} className="text-brand">생성 다시 시도</button>}{streaming?.generation_user_id === user?.id && generating && <button onClick={() => controller.current?.abort()} className="text-red-400">중단</button>}</div>
      {command && <div className="flex items-center justify-between bg-surface px-3 py-2 text-xs text-brand"><span>/{command.name}</span><button onClick={() => setCommand(null)}>해제</button></div>}
      <div className="chat-composer flex shrink-0 items-end gap-2 border-t border-surface2 p-2"><button aria-label="명령어 메뉴 열기" onClick={() => setCommandOpen(true)} className="chat-command-button flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface text-brand">/</button><textarea aria-label="메시지 입력" value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !navigator.maxTouchPoints) { event.preventDefault(); if (!mine && !soloBlocked) void send(); } }} rows={1} placeholder={soloBlocked ? '유저 간 대화 · 함께 진행하려면 메뉴에서 변경해 주세요' : `${participantName(me.slot)}의 메시지…`} className="max-h-32 min-w-0 flex-1 resize-none rounded-2xl bg-surface px-4 py-2.5 text-sm text-white outline-none" /><button aria-label="유저 간 대화로 전송" disabled={busy || !input.trim()} onClick={() => void send(true)} title="AI에 전달하지 않는 유저 간 대화" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dashed border-slate-500 text-slate-400 disabled:opacity-40"><InterfaceIcon name="users" /></button><button aria-label="행동 전송" disabled={busy || mine || soloBlocked || !!streaming || summaryQueued || summaryGenerating || !!pending} onClick={() => void send()} className="chat-send-button rounded-full bg-brand px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40">전송</button></div>
    </>}
    {commandOpen && user && <CommandMenu userId={user.id} workId={room.work_id} onClose={() => setCommandOpen(false)} onSelect={value => { setCommand(value); setCommandOpen(false); }} />}
    {billingOpen && me && <SessionMenuFrame subtitle="멀티챗 · 두 참여자 모두 변경 가능" onClose={() => setBillingOpen(false)}><div className="inu-content"><MultichatApiSettings room={room} members={data.members} onUpdate={patchRoom} /></div></SessionMenuFrame>}
    {menuOpen && menuSession && me && <SessionMenu key={`${room.id}:${me.slot}`} session={menuSession} profile={data.profile} onClose={() => setMenuOpen(false)} onUpdate={patchSession} onPersonaChange={() => { void refresh().catch(report); }} multichat={{ room, members: data.members, slot: me.slot, otherPresent: data.members.some(member => member.user_id !== user?.id && connectedUserIds.includes(member.user_id)), presenceReady, onRoomUpdate: patchRoom, onRefresh: refresh }}
      debugMode={display.debug} onDebugToggle={changeDisplay('debug')} showCost={display.cost} onShowCostToggle={changeDisplay('cost')} showCostKrw={display.krw} onShowCostKrwToggle={changeDisplay('krw')} showCacheTokens={display.cache} onShowCacheTokensToggle={changeDisplay('cache')} showImages={display.images} onShowImagesToggle={changeDisplay('images')} showOffMode={display.spoiler} onShowOffModeToggle={changeDisplay('spoiler')} exchange={exchange}
      sessionModel={session?.model_override || data.profile?.default_model || room.model} onModelChange={model => { void supabase.from('sessions').update({ model_override: model }).eq('id', room.id).then(({ error }) => error ? report(error) : patchSession({ model_override: model })); }} sessionReasoning={session?.reasoning_override ?? data.profile?.default_reasoning ?? {}} onReasoningChange={reasoning => { void supabase.from('sessions').update({ reasoning_override: reasoning }).eq('id', room.id).then(({ error }) => error ? report(error) : patchSession({ reasoning_override: reasoning })); }}
      errorLog={errors} onClearErrors={() => setErrors([])} onExportConversation={exportConversation} exportingConversation={exporting} onGenerateSummary={summarize} onMergeSummaries={versions => summarize(undefined, versions)} summaryGenerating={summaryGenerating} storyNotes={data.notes} onStoryNotesChange={notes => setData(old => old ? { ...old, notes } : old)} sessionTurnCount={Math.max(0, room.current_round - 1)} sending={writing} onWorkCombinationSavingChange={saving => { if (saving && (lock.current || submitLock.current || combinationLock.current)) return false; combinationLock.current = saving; return true; }} />}
  </div>;
}
