import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { getApiKey } from '@/lib/apiKeys';
import { generate } from '@/lib/llm';
import { PROVIDER_LABELS, type ReasoningSelection } from '@/lib/llm/types';
import { defaultReasoningFor } from '@/lib/llm/modelCapabilities';
import { loadDefaultReasoning, modelsFor, normalizeReasoning, toOpenRouterModel } from '@/lib/modelPreferences';
import { assemblePrompt } from '@/lib/prompt/assemble';
import { DEFAULT_SUMMARY_PROMPT } from '@/lib/summaryPrompt';
import {
  guestGetSession, guestAddMessage, guestUpdateSession, guestUpdateMessage, guestDeleteMessage,
  type GuestSession, type GuestMessage,
} from '@/lib/guest';
import type { Command, KeywordBook, Message, Persona, Profile, Provider, Session, StartConfig, StoryNote, SummaryVersion, Work } from '@/types/db';
import SessionMenu from '@/components/SessionMenu';
import MarkdownCodeBlock from '@/components/MarkdownCodeBlock';
import { formatKrw, useUsdKrwRate } from '@/lib/exchangeRate';
import { showToast } from '@/lib/toast';
import CommandMenu from '@/components/CommandMenu';
import { showConfirmDialog } from '@/lib/dialog';

const GUEST_SETTINGS_KEY = 'inuchat.guest.settings';
const GENERATION_TIMEOUT_MS = 120_000;
const DRAFT_SAVE_INTERVAL_MS = 500;
interface GuestSettings { provider: Provider; model: string; outputTokens: number | null; reasoning?: ReasoningSelection; }
function loadGuestSettings(): GuestSettings {
  try { return JSON.parse(localStorage.getItem(GUEST_SETTINGS_KEY) ?? '{}') as GuestSettings; }
  catch { return { provider: 'openrouter', model: '', outputTokens: 1024 }; }
}

const sessionSettingsKey = (id: string) => `chatforme.session.${id}.settings`;
interface SessionSettings { provider: Provider; model: string; reasoning: ReasoningSelection; }
function loadSessionSettings(id: string, profile: Profile | null): SessionSettings {
  try {
    const raw = localStorage.getItem(sessionSettingsKey(id));
    if (raw) {
      const parsed = JSON.parse(raw) as SessionSettings;
      if (parsed.model) {
        const model = toOpenRouterModel(parsed.provider, parsed.model);
        return { provider: 'openrouter', model, reasoning: normalizeReasoning(parsed.reasoning, 'openrouter', model) };
      }
    }
  } catch {}
  const model = toOpenRouterModel(profile?.default_provider, profile?.default_model || modelsFor('openrouter')[0]);
  return { provider: 'openrouter', model, reasoning: loadDefaultReasoning('openrouter', model) };
}

function toMsg(m: GuestMessage): Message {
  return { ...m, is_hidden: m.is_hidden ?? false, is_summarized: false, input_tokens: m.input_tokens ?? 0, output_tokens: m.output_tokens ?? 0, cost: m.cost ?? 0, reroll_group_id: null, reroll_index: 1, is_active_variant: true, generation_status: 'complete', command_id: null, command_name: null };
}

interface ActiveGeneration {
  controller: AbortController;
  content: string;
  listeners: Set<(content: string | null) => void>;
}
const activeGenerations = new Map<string, ActiveGeneration>();

function publishGeneration(id: string, content: string | null) {
  const active = activeGenerations.get(id);
  if (!active) return;
  if (content !== null) active.content = content;
  active.listeners.forEach((listener) => listener(content));
  if (content === null) activeGenerations.delete(id);
}

export interface ErrorEntry {
  id: string;
  short: string;
  detail: string;
  at: string;
}

function classifyError(raw: string): string {
  if (raw.includes('API 키가 없습니다')) return raw;
  if (raw.includes('(401)') || raw.includes('(403)')) return 'API 키가 유효하지 않습니다';
  if (raw.includes('(404)')) return '모델을 찾을 수 없습니다. 세션 메뉴에서 모델을 재선택하세요';
  if (raw.includes('(429)')) return 'API 요청 한도를 초과했습니다. 잠시 후 재시도하세요';
  if (raw.includes('(500)') || raw.includes('(502)') || raw.includes('(503)')) return 'AI 서버 오류입니다. 잠시 후 재시도하세요';
  if (raw.includes('Failed to fetch') || raw.toLowerCase().includes('networkerror')) return '네트워크 오류입니다. 인터넷 연결을 확인하세요';
  const apiMatch = raw.match(/^(.+?API 오류 \(\d+\))/);
  if (apiMatch) return apiMatch[1];
  return raw.length <= 80 ? raw : raw.slice(0, 80) + '…';
}

function describeUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const value = error as { message?: string; details?: string; hint?: string; code?: string };
    return [value.message, value.details, value.hint, value.code].filter(Boolean).join(' · ') || JSON.stringify(error);
  }
  return String(error);
}

function isNearScrollBottom(element: HTMLDivElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 80;
}

function shouldSubmitOnEnter() {
  if (typeof window === 'undefined') return true;
  const mobileUserAgent = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const touchPhoneLayout = navigator.maxTouchPoints > 0 && window.matchMedia('(max-width: 768px)').matches;
  return !mobileUserAgent && !touchPhoneLayout;
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
  const [showCost, setShowCost] = useState(() => localStorage.getItem('chatforme.showCost') !== '0');
  const [showCostKrw, setShowCostKrw] = useState(() => localStorage.getItem('inuchat.showCostKrw') === '1');
  const [showCacheTokens, setShowCacheTokens] = useState(() => localStorage.getItem('inuchat.showCacheTokens') === '1');
  const [showImages, setShowImages] = useState(() => localStorage.getItem('inuchat.showImages') !== '0');
  const exchange = useUsdKrwRate();
  const [errorLog, setErrorLog] = useState<ErrorEntry[]>([]);
  const [toastError, setToastError] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [editingCommandName, setEditingCommandName] = useState<string | null>(null);
  const [sessionModel, setSessionModel] = useState('');
  const [sessionReasoning, setSessionReasoning] = useState<ReasoningSelection>(() => defaultReasoningFor('openrouter', modelsFor('openrouter')[0]));
  const [summaryGenerating, setSummaryGenerating] = useState(false);
  const [storyNotes, setStoryNotes] = useState<StoryNote[]>([]);
  const [messageActionBusy, setMessageActionBusy] = useState(false);
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const [selectedCommand, setSelectedCommand] = useState<Command | null>(null);

  const [streamingContent, setStreamingContent] = useState('');
  const abortControllerRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldAutoScrollRef = useRef(true);

  useEffect(() => {
    if (!sessionId) return;
    const active = activeGenerations.get(sessionId);
    if (!active) return;
    setSending(true);
    setStreamingContent(active.content);
    const listener = (content: string | null) => {
      if (content !== null) { setStreamingContent(content); return; }
      setSending(false);
      setStreamingContent('');
      void supabase.from('messages').select('*').eq('session_id', sessionId).order('created_at').then(({ data }) => setMessages((data as Message[]) ?? []));
    };
    active.listeners.add(listener);
    return () => { active.listeners.delete(listener); };
  }, [sessionId]);

  function addError(raw: string) {
    const short = classifyError(raw);
    const entry: ErrorEntry = { id: crypto.randomUUID(), short, detail: raw, at: new Date().toISOString() };
    setErrorLog((prev) => [...prev.slice(-19), entry]);
    setToastError(short);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastError(''), 4000);
  }

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

      const [{ data: w }, { data: p }, { data: cfg }, { data: msgs }, { data: kbs }, { data: notes }] = await Promise.all([
        supabase.from('works').select('*').eq('id', sess.work_id).single(),
        supabase.from('profiles').select('*').eq('id', user!.id).single(),
        supabase.from('platform_config').select('system_prompt').eq('id', 1).single(),
        supabase.from('messages').select('*').eq('session_id', sessionId).order('created_at', { ascending: true }),
        supabase.from('keyword_books').select('*').eq('work_id', sess.work_id).order('sort_order'),
        supabase.from('story_notes').select('*').eq('session_id', sess.id).order('created_at'),
      ]);
      setWork(w as Work);
      setProfile(p as Profile);
      setSystemPrompt((cfg as { system_prompt: string } | null)?.system_prompt ?? '');
      const loadedMessages = (msgs as Message[]) ?? [];
      // A missing in-memory controller does not prove that generation stopped:
      // another tab may still own it. P1 heartbeat handling will decide staleness.
      setMessages(loadedMessages);
      setKeywordBooks((kbs as KeywordBook[]) ?? []);
      setStoryNotes((notes as StoryNote[]) ?? []);

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
    if (!isGuest && profile && sessionId) {
      const s = loadSessionSettings(sessionId, profile);
      setSessionModel(s.model);
      setSessionReasoning(s.reasoning);
    }
  }, [profile, sessionId, isGuest]);

  useEffect(() => {
    if (isGuest || !sessionId || !sessionModel) return;
    localStorage.setItem(sessionSettingsKey(sessionId), JSON.stringify({
      provider: 'openrouter',
      model: sessionModel,
      reasoning: sessionReasoning,
    }));
  }, [isGuest, sessionId, sessionModel, sessionReasoning]);

  useEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }));
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

  function messagesAfterSummary(allMsgs: Message[], cutoff = session?.summary_last_turn ?? 0) {
    if (isGuest || cutoff <= 0) return allMsgs;
    let seenUserTurns = 0;
    return allMsgs.filter((message) => {
      if (message.role === 'user' && !message.is_hidden) seenUserTurns += 1;
      return seenUserTurns > cutoff;
    });
  }

  function messagesThroughTurn(allMsgs: Message[], throughTurn: number) {
    let seenUserTurns = 0;
    return allMsgs.filter((message) => {
      if (message.role === 'user' && !message.is_hidden) seenUserTurns += 1;
      return seenUserTurns <= throughTurn;
    });
  }

  function buildHistory(allMsgs: Message[], cutoff = session?.summary_last_turn ?? 0) {
    const userCount = allMsgs.filter((m) => m.role === 'user' && !m.is_hidden).length;
    return messagesAfterSummary(allMsgs, cutoff).filter((m) => {
      if (m.is_hidden && startConfig) return userCount < startConfig.keep_turns;
      if (m.is_hidden && !startConfig) return false;
      return true;
    });
  }

  async function generateSummary(sourceMessages = messages, archivesToMerge: string[] = [], requestedThroughTurn?: number) {
    if (!session || !profile || summaryGenerating) return;
    const apiKey = getApiKey('openrouter');
    if (!apiKey) { addError('OpenRouter API 키가 없어 요약을 생성할 수 없습니다.'); return; }
    // Include the hidden initial context in the first archive so important
    // scenario setup is not lost after its short keep_turns window expires.
    const sourceMode = session.summary_source_mode_override ?? profile.summary_source_mode ?? 'incremental';
    const allActiveMessages = sourceMessages.filter((message) => message.is_active_variant !== false);
    const latestTurn = allActiveMessages.filter((message) => message.role === 'user' && !message.is_hidden).length;
    const throughTurn = Math.max(0, Math.min(requestedThroughTurn ?? latestTurn, latestTurn));
    const activeSourceMessages = messagesThroughTurn(allActiveMessages, throughTurn);
    let previous = archivesToMerge.length > 0
      ? archivesToMerge.join('\n\n--- 통합 대상 요약 구분 ---\n\n')
      : '';
    let previousTurn = 0;
    if (archivesToMerge.length === 0 && sourceMode === 'incremental' && throughTurn > 0) {
      const { data: earlierVersions } = await supabase.from('summary_versions')
        .select('*').eq('session_id', session.id).lt('summarized_through_turn', throughTurn)
        .order('summarized_through_turn', { ascending: false }).limit(1);
      const earlier = ((earlierVersions as SummaryVersion[] | null) ?? [])[0];
      if (earlier) {
        previous = earlier.content.trim();
        previousTurn = earlier.summarized_through_turn;
      } else if (session.summary_last_turn < throughTurn) {
        previous = session.summary.trim();
        previousTurn = session.summary_last_turn;
      }
    }
    const candidates = archivesToMerge.length > 0
      ? []
      : sourceMode === 'full'
      ? activeSourceMessages
      : messagesAfterSummary(activeSourceMessages, previousTurn);
    if (candidates.length === 0 && archivesToMerge.length === 0) { addError('새로 요약할 대화가 없습니다.'); return; }
    setSummaryGenerating(true);
    try {
      const dialogue = candidates.map((message) => `[${message.is_hidden ? '숨김 시작 설정' : message.role === 'user' ? '사용자' : 'AI'}]\n${message.content}`).join('\n\n');
      const input = `${previous ? `=== 이전 요약 노트${archivesToMerge.length > 1 ? ' (선택한 복수 노트를 하나로 통합)' : ''} ===\n${previous}\n\n` : ''}${dialogue ? `=== 새로 요약할 대화 ===\n${dialogue}` : '=== 요청 ===\n선택한 요약 노트들을 누락과 단절 없이 하나의 최신 요약 노트로 통합하세요.'}`;
      const summaryLevel = session.summary_level_override ?? profile.summary_level ?? 5;
      const allowOmission = session.summary_allow_omission_override ?? profile.summary_allow_omission ?? true;
      const parametersEnabled = !profile.summary_prompt?.trim() || (session.summary_parameters_enabled_override ?? profile.summary_parameters_enabled ?? true);
      const parameterBlock = parametersEnabled ? `[SUMMARY CONFIGURATION]\nSUMMARY_LEVEL = ${summaryLevel}\nALLOW_OMISSION = ${allowOmission ? 'ON' : 'OFF'}` : '';
      const extraNote = profile.summary_extra_note?.trim() ? `[ADDITIONAL NOTE]\n${profile.summary_extra_note.trim()}` : '';
      const summaryCore = [profile.summary_prompt?.trim() || DEFAULT_SUMMARY_PROMPT, parameterBlock, extraNote].filter(Boolean).join('\n\n');
      const result = await generate('openrouter', {
        apiKey,
        sessionId: session.id,
        model: session.summary_model_override || profile.summary_model || profile.default_model || modelsFor('openrouter')[0],
        reasoning: normalizeReasoning(session.summary_reasoning_override ?? profile.summary_reasoning, 'openrouter', session.summary_model_override || profile.summary_model || profile.default_model || modelsFor('openrouter')[0]),
        systemParts: { core: summaryCore, persona: '', userNote: '', summary: '', keywords: '' },
        messages: [{ role: 'user', content: input }],
        maxOutputTokens: 4096,
      });
      if (!result.text.trim()) throw new Error('요약 모델이 빈 응답을 반환했습니다.');
      const ids = candidates.map((message) => message.id);
      const { error: deactivateError } = await supabase.from('summary_versions').update({ is_active: false }).eq('session_id', session.id).eq('is_active', true);
      const versionsUnavailableAtUpdate = deactivateError?.code === 'PGRST205' || deactivateError?.message?.includes('summary_versions');
      if (deactivateError && !versionsUnavailableAtUpdate) throw deactivateError;
      // Regeneration in the same turn replaces that turn's version instead of
      // leaving multiple, ambiguous checkpoints behind.
      if (!versionsUnavailableAtUpdate) {
        const { error: duplicateError } = await supabase.from('summary_versions').delete().eq('session_id', session.id).eq('summarized_through_turn', throughTurn);
        if (duplicateError) throw duplicateError;
      }
      const { error: versionError } = await supabase.from('summary_versions').insert({
        session_id: session.id, content: result.text, summarized_through_turn: throughTurn,
        input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens, cost: result.usage.cost,
      });
      const versionsUnavailable = versionsUnavailableAtUpdate || versionError?.code === 'PGRST205' || versionError?.message?.includes('summary_versions');
      if (versionError && !versionsUnavailable) throw versionError;
      const { error: markError } = await supabase.from('messages').update({ is_summarized: true }).in('id', ids);
      if (markError) throw markError;
      const { data: fresh } = await supabase.from('sessions').select('total_input_tokens,total_output_tokens,total_cost').eq('id', session.id).single();
      const totals = fresh as Pick<Session, 'total_input_tokens' | 'total_output_tokens' | 'total_cost'> | null;
      const patch = {
        summary: result.text,
        summary_last_turn: throughTurn,
        total_input_tokens: (totals?.total_input_tokens ?? session.total_input_tokens) + result.usage.inputTokens,
        total_output_tokens: (totals?.total_output_tokens ?? session.total_output_tokens) + result.usage.outputTokens,
        total_cost: (totals?.total_cost ?? session.total_cost) + result.usage.cost,
      };
      const { error: sessionError } = await supabase.from('sessions').update(patch).eq('id', session.id);
      if (sessionError) throw sessionError;
      setMessages((current) => current.map((message) => ids.includes(message.id) ? { ...message, is_summarized: true } : message));
      setSession((current) => current ? { ...current, ...patch } : current);
      if (versionsUnavailable) addError('요약은 생성되어 채팅에 반영됐지만 요약 기록 테이블이 아직 배포되지 않아 버전 기록은 저장하지 못했습니다. Supabase 마이그레이션 0013~0016을 적용해 주세요.');
    } catch (error) {
      addError(`요약 생성 실패: ${describeUnknownError(error)}`);
    } finally {
      setSummaryGenerating(false);
    }
  }

  async function send(options?: { reroll?: boolean }) {
    if (!work || sending || (sessionId && activeGenerations.has(sessionId))) return;

    const guestSettings = loadGuestSettings();
    const provider: Provider = 'openrouter';
    const model = isGuest ? toOpenRouterModel(guestSettings.provider, guestSettings.model || modelsFor(provider)[0]) : (sessionModel || modelsFor(provider)[0]);
    const reasoning = isGuest ? normalizeReasoning(guestSettings.reasoning, provider, model) : sessionReasoning;
    const apiKey = getApiKey(provider);
    if (!apiKey) { addError(`${PROVIDER_LABELS[provider]} API 키가 없습니다. 설정 탭에서 입력하세요.`); return; }

    const activeMessages = messages.filter((message) => message.is_active_variant !== false);
    const rerollTarget = options?.reroll ? [...activeMessages].reverse().find((message) => message.role === 'assistant' && !message.is_hidden) ?? null : null;
    const baseMessages = rerollTarget ? activeMessages.filter((message) => message.id !== rerollTarget.id) : activeMessages;
    let effectiveSummary = session?.summary ?? '';
    let effectiveSummaryTurn = session?.summary_last_turn ?? 0;
    let rerollVersionIds: string[] | null = null;
    let rerollIndex = 1;
    let rerollGroupId: string | null = null;
    if (rerollTarget && session) {
      const currentTurns = baseMessages.filter((message) => message.role === 'user' && !message.is_hidden).length;
      if (effectiveSummaryTurn >= currentTurns) {
        const { data } = await supabase.from('summary_versions').select('*').eq('session_id', session.id).lt('summarized_through_turn', currentTurns).order('created_at', { ascending: false });
        const prior = (data as SummaryVersion[] | null) ?? [];
        const selectedPrior = prior.filter((version) => version.is_active);
        const restored = selectedPrior.length ? selectedPrior : prior.slice(0, 1);
        effectiveSummary = restored.map((version) => version.content).join('\n\n--- 추가 요약 노트 ---\n\n');
        effectiveSummaryTurn = restored.reduce((latest, version) => Math.max(latest, version.summarized_through_turn), 0);
        rerollVersionIds = restored.map((version) => version.id);
      }
    }
    if (rerollTarget) {
      rerollGroupId = rerollTarget.reroll_group_id ?? rerollTarget.id;
      const variants = messages.filter((message) => message.role === 'assistant' && (message.reroll_group_id ?? message.id) === rerollGroupId);
      rerollIndex = Math.max(0, ...variants.map((message) => message.reroll_index ?? 1)) + 1;
    }
    const text = options?.reroll ? '' : input.trim();
    const commandPrompt = options?.reroll ? '' : selectedCommand?.prompt.trim() ?? '';
    const promptText = commandPrompt ? `${text}${text ? '\n\n' : ''}[선택한 명령어 /${selectedCommand!.name}]\n${commandPrompt}` : text;
    if (!options?.reroll) { setInput(''); setSelectedCommand(null); }
    setSending(true);
    setStreamingContent('');
    const controller = new AbortController();
    abortControllerRef.current = controller;
    let generationTimedOut = false;
    let generationTimeout: ReturnType<typeof setTimeout> | null = null;
    const startGenerationTimeout = () => {
      generationTimeout = setTimeout(() => {
        generationTimedOut = true;
        controller.abort('모델 응답이 2분 안에 완료되지 않아 생성을 중단했습니다.');
      }, GENERATION_TIMEOUT_MS);
    };
    if (sessionId) activeGenerations.set(sessionId, { controller, content: '', listeners: new Set() });
    const now = new Date().toISOString();
    const turnIndex = baseMessages.filter((m) => !m.is_hidden).length;
    let partialText = '';
    let lastPaint = 0;
    let draftMessageId: string | null = null;
    let lastDraftSave = 0;
    let draftSaveQueue = Promise.resolve();
    const onChunk = (t: string) => {
      partialText = t;
      if (sessionId) publishGeneration(sessionId, t);
      const nowMs = performance.now();
      if (nowMs - lastPaint >= 50) { lastPaint = nowMs; setStreamingContent(t); }
      if (!isGuest && draftMessageId && nowMs - lastDraftSave >= DRAFT_SAVE_INTERVAL_MS) {
        lastDraftSave = nowMs;
        const id = draftMessageId;
        draftSaveQueue = draftSaveQueue.catch(() => {}).then(async () => {
          const { error } = await supabase.from('messages').update({ content: t }).eq('id', id);
          if (error) throw error;
        });
      }
    };

    if (isGuest && guestSession) {
      const historyMsgs = buildHistory([...messages]);
      let updatedMessages = [...messages];
      if (text) {
        const userMsg: GuestMessage = {
          id: crypto.randomUUID(), session_id: guestSession.id, role: 'user',
          content: text, turn_index: turnIndex, input_tokens: 0, output_tokens: 0, cache_read_tokens: null, cache_write_tokens: null, cost: 0,
          is_hidden: false, created_at: now,
        };
        guestAddMessage(guestSession.id, userMsg);
        updatedMessages = [...messages, toMsg(userMsg)];
        setMessages(updatedMessages);
      }

      const assembled = assemblePrompt({
        systemPrompt, mainPrompt: work.main_prompt, userNote: guestSession.user_note,
        summary: '',
        keywordBookContents: getActiveKeywordContents(updatedMessages, promptText),
        history: historyMsgs.map((m) => ({ role: m.role, content: m.content })),
        latestUserMessage: promptText,
      });
      const maxOutputTokens = guestSession.output_tokens_override ?? guestSettings.outputTokens ?? 1024;
      try {
        startGenerationTimeout();
        const result = await generate(provider, { apiKey, model, sessionId: guestSession.id, reasoning, systemParts: assembled.systemParts, messages: assembled.messages, maxOutputTokens, onChunk, signal: controller.signal });
        const aiMsg: GuestMessage = {
          id: crypto.randomUUID(), session_id: guestSession.id, role: 'assistant',
          content: result.text, turn_index: turnIndex,
          input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens, cost: result.usage.cost,
          cache_read_tokens: result.usage.cacheReadTokens, cache_write_tokens: result.usage.cacheCreationTokens,
          is_hidden: false, created_at: new Date().toISOString(),
        };
        guestAddMessage(guestSession.id, aiMsg);
        setMessages((m) => [...m, toMsg(aiMsg)]);
        const newIn = guestSession.total_input_tokens + result.usage.inputTokens;
        const newOut = guestSession.total_output_tokens + result.usage.outputTokens;
        const newCost = guestSession.total_cost + result.usage.cost;
        guestUpdateSession(guestSession.id, { total_input_tokens: newIn, total_output_tokens: newOut, total_cost: newCost });
        setGuestSession((gs) => gs ? { ...gs, total_input_tokens: newIn, total_output_tokens: newOut, total_cost: newCost } : gs);
      } catch (err) {
        const isAbort = controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError');
        if (partialText) {
          const aiMsg: GuestMessage = {
            id: crypto.randomUUID(), session_id: guestSession.id, role: 'assistant',
            content: partialText, turn_index: turnIndex, input_tokens: 0, output_tokens: 0, cache_read_tokens: null, cache_write_tokens: null, cost: 0,
            is_hidden: false, created_at: new Date().toISOString(),
          };
          guestAddMessage(guestSession.id, aiMsg);
          setMessages((m) => [...m, toMsg(aiMsg)]);
          if (generationTimedOut) addError('모델 응답이 2분 안에 완료되지 않아 수신한 내용까지만 저장했습니다.');
          else if (!isAbort) addError(`응답 연결이 중단되어 수신한 내용까지만 저장했습니다: ${describeUnknownError(err)}`);
        } else {
          const interrupted: GuestMessage = {
            id: crypto.randomUUID(), session_id: guestSession.id, role: 'assistant',
            content: '응답이 중단되었습니다.', turn_index: turnIndex, input_tokens: 0,
            output_tokens: 0, cache_read_tokens: null, cache_write_tokens: null, cost: 0, is_hidden: false, created_at: new Date().toISOString(),
          };
          guestAddMessage(guestSession.id, interrupted);
          setMessages((current) => [...current, toMsg(interrupted)]);
          if (generationTimedOut) addError('모델 응답이 2분 안에 완료되지 않아 생성을 중단했습니다.');
          else if (!isAbort) addError(err instanceof Error ? err.message : 'AI 응답 생성에 실패했습니다.');
        }
      } finally {
        if (generationTimeout) clearTimeout(generationTimeout);
        setSending(false);
        setStreamingContent('');
        abortControllerRef.current = null;
        if (sessionId) publishGeneration(sessionId, null);
      }
      return;
    }

    if (!session || !profile) { setSending(false); setStreamingContent(''); if (sessionId) publishGeneration(sessionId, null); return; }

    const historyMsgs = buildHistory([...baseMessages], effectiveSummaryTurn);
    let currentMessages = [...baseMessages];
    if (text || commandPrompt) {
      const { data: userMsg, error: userMessageError } = await supabase
        .from('messages')
        .insert({
          session_id: session.id, role: 'user', content: text, turn_index: turnIndex,
          command_id: selectedCommand?.id ?? null, command_name: selectedCommand?.name ?? null,
        })
        .select('*').single();
      if (userMessageError) {
        addError(userMessageError.message);
        setSending(false);
        abortControllerRef.current = null;
        if (sessionId) publishGeneration(sessionId, null);
        return;
      }
      if (userMsg) {
        currentMessages = [...baseMessages, userMsg as Message];
        setMessages(currentMessages);
      }
    }

    const assembled = assemblePrompt({
      systemPrompt, mainPrompt: work.main_prompt, userNote: session.user_note,
      summary: effectiveSummary, storyNotes: storyNotes.map((note) => note.content), persona,
      keywordBookContents: getActiveKeywordContents(currentMessages, promptText),
      history: historyMsgs.map((m) => ({ role: m.role, content: m.content })),
      latestUserMessage: promptText,
    });
    const maxOutputTokens = session.output_tokens_override ?? profile.default_output_tokens;
    try {
      const { data: draft, error: draftError } = await supabase.from('messages').insert({
        session_id: session.id, role: 'assistant', content: '', turn_index: turnIndex,
        input_tokens: 0, output_tokens: 0, cost: 0, reroll_group_id: rerollGroupId,
        reroll_index: rerollIndex, is_active_variant: true, generation_status: 'streaming',
      }).select('id').single();
      if (draftError || !draft) throw draftError ?? new Error('응답 임시 저장 공간을 만들 수 없습니다.');
      draftMessageId = draft.id;
      startGenerationTimeout();
      const result = await generate(provider, { apiKey, model, sessionId: session.id, reasoning, systemParts: assembled.systemParts, messages: assembled.messages, maxOutputTokens, onChunk, signal: controller.signal });
      await draftSaveQueue;
      const { data: aiMsg, error: finalMessageError } = await supabase
        .from('messages')
        .update({
          content: result.text,
          input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens, cost: result.usage.cost,
          cache_read_tokens: result.usage.cacheReadTokens, cache_write_tokens: result.usage.cacheCreationTokens,
          generation_status: 'complete',
        })
        .eq('id', draftMessageId).select('*').single();
      if (finalMessageError || !aiMsg) throw finalMessageError ?? new Error('최종 응답을 저장하지 못했습니다.');
      const messagesAfterResponse = aiMsg ? [...currentMessages, aiMsg as Message] : currentMessages;
      if (aiMsg) {
        if (rerollTarget) await supabase.from('messages').update({ is_active_variant: false, reroll_group_id: rerollGroupId }).eq('id', rerollTarget.id);
        if (rerollVersionIds) {
          await supabase.from('summary_versions').update({ is_active: false }).eq('session_id', session.id);
          if (rerollVersionIds.length) await supabase.from('summary_versions').update({ is_active: true }).in('id', rerollVersionIds);
        }
        setMessages((current) => rerollTarget
          ? [...current.map((message) => message.id === rerollTarget.id ? { ...message, is_active_variant: false, reroll_group_id: rerollGroupId } : message), aiMsg as Message]
          : messagesAfterResponse);
      }

      const newIn = session.total_input_tokens + result.usage.inputTokens;
      const newOut = session.total_output_tokens + result.usage.outputTokens;
      const newCost = session.total_cost + result.usage.cost;
      const { error: totalsError } = await supabase.from('sessions')
        .update({ total_input_tokens: newIn, total_output_tokens: newOut, total_cost: newCost, summary: effectiveSummary, summary_last_turn: effectiveSummaryTurn, updated_at: new Date().toISOString() })
        .eq('id', session.id);
      if (totalsError) throw totalsError;
      setSession({ ...session, total_input_tokens: newIn, total_output_tokens: newOut, total_cost: newCost, summary: effectiveSummary, summary_last_turn: effectiveSummaryTurn });
      const unsummarizedTurns = messagesAfterSummary(messagesAfterResponse, effectiveSummaryTurn).filter((message) => message.role === 'user' && !message.is_hidden).length;
      const costGateEnabled = session.summary_cost_enabled_override ?? profile?.summary_cost_enabled ?? false;
      const costCurrency = session.summary_cost_currency_override ?? profile?.summary_cost_currency ?? 'USD';
      const costThreshold = session.summary_cost_threshold_override ?? profile?.summary_cost_threshold ?? 0;
      const recentAssistantCosts = messagesAfterResponse.filter((message) => message.role === 'assistant' && message.is_active_variant !== false).slice(-5).map((message) => costCurrency === 'KRW' ? message.cost * exchange.rate : message.cost);
      const costGatePassed = !costGateEnabled || recentAssistantCosts.filter((cost) => cost >= costThreshold).length >= 3;
      if (!rerollTarget && session.auto_summary_enabled && unsummarizedTurns >= (session.summary_interval_override ?? profile?.summary_interval ?? 30) && costGatePassed) {
        await generateSummary(messagesAfterResponse);
      }
    } catch (err) {
      const isAbort = controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError');
      if (partialText) {
        await draftSaveQueue.catch(() => {});
        const { data: aiMsg } = draftMessageId ? await supabase.from('messages').update({ content: partialText, generation_status: 'interrupted' }).eq('id', draftMessageId).select('*').single() : { data: null };
        if (aiMsg && rerollTarget) {
          await supabase.from('messages').update({ is_active_variant: false, reroll_group_id: rerollGroupId }).eq('id', rerollTarget.id);
        }
        if (aiMsg) setMessages((m) => [...m, aiMsg as Message]);
        if (generationTimedOut) addError('모델 응답이 2분 안에 완료되지 않아 수신한 내용까지만 저장했습니다.');
        else if (!isAbort) addError(`응답 연결이 중단되어 수신한 내용까지만 저장했습니다: ${describeUnknownError(err)}`);
      } else {
        const { data: interrupted } = draftMessageId
          ? await supabase.from('messages').update({ generation_status: 'interrupted' }).eq('id', draftMessageId).select('*').single()
          : { data: null };
        if (interrupted) setMessages((current) => [...current, interrupted as Message]);
        if (generationTimedOut) addError('모델 응답이 2분 안에 완료되지 않아 생성을 중단했습니다.');
        else if (!isAbort) addError(err instanceof Error ? err.message : 'AI 응답 생성에 실패했습니다.');
      }
    } finally {
      if (generationTimeout) clearTimeout(generationTimeout);
      setSending(false);
      setStreamingContent('');
      abortControllerRef.current = null;
      if (sessionId) publishGeneration(sessionId, null);
    }
  }

  async function deleteMsg(msgId: string) {
    if (!await showConfirmDialog('이 메시지를 삭제할까요?', '삭제한 메시지는 복구할 수 없습니다.', '삭제')) return;
    if (messageActionBusy) return;
    setMessageActionBusy(true);
    const target = messages.find((message) => message.id === msgId);
    if (isGuest && guestSession) {
      guestDeleteMessage(guestSession.id, msgId);
    } else {
      const { error } = await supabase.from('messages').delete().eq('id', msgId);
      if (error) { addError(error.message); setMessageActionBusy(false); return; }
      if (target?.role === 'user' && !target.is_hidden && session) {
        const activeBeforeDelete = messages.filter((message) => message.is_active_variant !== false);
        const deletedTurn = activeBeforeDelete
          .slice(0, activeBeforeDelete.findIndex((message) => message.id === msgId) + 1)
          .filter((message) => message.role === 'user' && !message.is_hidden).length;
        const { data: versionsData } = await supabase.from('summary_versions').select('*').eq('session_id', session.id);
        const versions = (versionsData as SummaryVersion[] | null) ?? [];
        const invalidVersions = versions.filter((version) => version.summarized_through_turn >= deletedTurn);
        if (invalidVersions.length) await supabase.from('summary_versions').delete().in('id', invalidVersions.map((version) => version.id));
        const remainingVersions = versions
          .filter((version) => version.summarized_through_turn < deletedTurn)
          .sort((a, b) => a.summarized_through_turn - b.summarized_through_turn);
        let remainingActive = remainingVersions.filter((version) => version.is_active);
        if (remainingActive.length === 0 && remainingVersions.length > 0) {
          const fallback = remainingVersions.at(-1)!;
          await supabase.from('summary_versions').update({ is_active: true }).eq('id', fallback.id);
          remainingActive = [fallback];
        }
        const nextSummary = remainingActive.map((version) => version.content).join('\n\n--- 추가 요약 노트 ---\n\n');
        const nextSummaryTurn = Math.max(0, ...remainingActive.map((version) => version.summarized_through_turn));
        await supabase.from('sessions').update({ summary: nextSummary, summary_last_turn: nextSummaryTurn }).eq('id', session.id);
        setSession((current) => current ? { ...current, summary: nextSummary, summary_last_turn: nextSummaryTurn } : current);
      }
    }
    let next = messages.filter((msg) => msg.id !== msgId);
    if (target?.role === 'assistant' && target.is_active_variant !== false) {
      const groupId = target.reroll_group_id ?? target.id;
      const replacement = [...next].reverse().find((message) => message.role === 'assistant' && (message.reroll_group_id ?? message.id) === groupId);
      if (replacement && !isGuest) await supabase.from('messages').update({ is_active_variant: true }).eq('id', replacement.id);
      if (replacement) next = next.map((message) => message.id === replacement.id ? { ...message, is_active_variant: true } : message);
    }
    setMessages(next);
    showToast('메시지를 삭제했습니다.');
    setMessageActionBusy(false);
  }

  async function saveEdit(msgId: string) {
    const content = editingContent.trim();
    if (!content) return;
    const original = messages.find((message) => message.id === msgId);
    const commandId = editingCommandName ? original?.command_id ?? null : null;
    if (isGuest && guestSession) {
      guestUpdateMessage(guestSession.id, msgId, content);
    } else {
      const { error } = await supabase.from('messages').update({ content, command_id: commandId, command_name: editingCommandName }).eq('id', msgId);
      if (error) { addError(`메시지 편집 실패: ${error.message}`); return; }
    }
    setMessages((m) => m.map((msg) => msg.id === msgId ? { ...msg, content, command_id: commandId, command_name: editingCommandName } : msg));
    setEditingId(null);
  }

  async function branchFrom(message: Message) {
    if (!session || !user) return;
    if (messageActionBusy || !await showConfirmDialog('새 채팅방으로 분기할까요?', '이 메시지 시점까지의 대화로 새 채팅방을 만듭니다.', '분기')) return;
    setMessageActionBusy(true);
    const branchSource = messages.filter((item) => item.is_active_variant !== false);
    const messageIndex = branchSource.findIndex((item) => item.id === message.id);
    if (messageIndex < 0) { setMessageActionBusy(false); return; }
    const branchMessages = branchSource.slice(0, messageIndex + 1);
    const branchTurns = branchMessages.filter((item) => item.role === 'user' && !item.is_hidden).length;
    const { data: versionsData, error: versionsError } = await supabase.from('summary_versions').select('*').eq('session_id', session.id).eq('is_active', true).lte('summarized_through_turn', branchTurns).order('created_at');
    if (versionsError && versionsError.code !== 'PGRST205') { addError(versionsError.message); setMessageActionBusy(false); return; }
    const versions = (versionsData as SummaryVersion[] | null) ?? [];
    const branchSummary = versions.map((version) => version.content).join('\n\n--- 추가 요약 노트 ---\n\n');
    const branchSummaryTurn = versions.length ? versions[versions.length - 1].summarized_through_turn : 0;
    const { data: newSession, error } = await supabase.from('sessions').insert({
      user_id: user.id, work_id: session.work_id, title: `${session.title} (분기)`, persona_id: session.persona_id,
      start_config_id: session.start_config_id, user_note: session.user_note, output_tokens_override: session.output_tokens_override,
      summary: branchSummary, auto_summary_enabled: session.auto_summary_enabled, summary_interval: session.summary_interval,
      summary_last_turn: branchSummaryTurn, summary_model_override: session.summary_model_override,
      summary_reasoning_override: session.summary_reasoning_override, summary_interval_override: session.summary_interval_override,
      summary_level_override: session.summary_level_override, summary_allow_omission_override: session.summary_allow_omission_override,
      summary_parameters_enabled_override: session.summary_parameters_enabled_override,
      summary_source_mode_override: session.summary_source_mode_override,
      summary_cost_enabled_override: session.summary_cost_enabled_override,
      summary_cost_currency_override: session.summary_cost_currency_override,
      summary_cost_threshold_override: session.summary_cost_threshold_override,
    }).select('id').single();
    if (error || !newSession) { addError(error?.message ?? '분기 채팅방 생성에 실패했습니다.'); setMessageActionBusy(false); return; }
    const copiedMessages = branchMessages.map(({ role, content, turn_index, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost, is_hidden, is_summarized, command_id, command_name }) => ({ session_id: newSession.id, role, content, turn_index, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost, is_hidden, is_summarized, command_id, command_name }));
    if (copiedMessages.length) await supabase.from('messages').insert(copiedMessages);
    if (versions.length) await supabase.from('summary_versions').insert(versions.map((version) => ({ session_id: newSession.id, content: version.content, summarized_through_turn: version.summarized_through_turn, is_active: true, input_tokens: version.input_tokens, output_tokens: version.output_tokens, cost: version.cost })));
    if (storyNotes.length) await supabase.from('story_notes').insert(storyNotes.map((note) => ({ session_id: newSession.id, content: note.content })));
    showToast('새 채팅방으로 분기했습니다.');
    navigate(`/chat/${newSession.id}`);
  }

  async function selectVariant(message: Message, id: string) {
    const groupId = message.reroll_group_id ?? message.id;
    const group = messages.filter((item) => item.role === 'assistant' && (item.reroll_group_id ?? item.id) === groupId);
    await supabase.from('messages').update({ is_active_variant: false }).in('id', group.map((item) => item.id));
    await supabase.from('messages').update({ is_active_variant: true }).eq('id', id);
    setMessages((current) => current.map((item) => group.some((variant) => variant.id === item.id) ? { ...item, is_active_variant: item.id === id } : item));
  }

  function variantsFor(message: Message) {
    const groupId = message.reroll_group_id ?? message.id;
    return messages
      .filter((item) => item.role === 'assistant' && (item.reroll_group_id ?? item.id) === groupId)
      .sort((a, b) => (a.reroll_index ?? 1) - (b.reroll_index ?? 1));
  }

  const currentSession = isGuest ? guestSession : session;

  const hasLocalGeneration = !!sessionId && activeGenerations.has(sessionId);
  const visibleMessages = messages.filter((m) => !(hasLocalGeneration && m.generation_status === 'streaming') && m.is_active_variant !== false && (!m.is_hidden || debugMode));
  const assistantTurnNumbers = new Map<string, number>();
  let countedUserTurns = 0;
  for (const message of messages.filter((item) => item.is_active_variant !== false)) {
    if (message.role === 'user' && !message.is_hidden) countedUserTurns += 1;
    if (message.role === 'assistant') assistantTurnNumbers.set(message.id, countedUserTurns);
  }
  const sessionTurnCount = messages.filter((message) => message.role === 'user' && !message.is_hidden && message.is_active_variant !== false).length;

  if (!currentSession || !work) {
    return <div className="flex h-full items-center justify-center text-slate-400">불러오는 중…</div>;
  }

  return (
    <div className="mx-auto flex h-full min-h-0 max-w-app flex-col bg-bg">
      <header className="flex items-center gap-2 border-b border-surface2 px-3 py-2.5">
        <button onClick={() => navigate('/sessions')} className="text-slate-400">←</button>
        <button onClick={() => navigate(`/works/${work.id}`)} className="min-w-0 flex-1 text-left">
          <p className="truncate text-sm font-semibold text-white">{work.title}</p>

        </button>
        {!isGuest && (
          <button onClick={() => setMenuOpen(true)} className="px-2 text-xl text-slate-300">☰</button>
        )}
      </header>

      {toastError && (
        <div className="toast-enter pointer-events-none fixed inset-x-0 top-6 z-50 flex justify-center px-4">
          <div className="max-w-[88vw] rounded-full bg-red-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg">
            {toastError}
          </div>
        </div>
      )}
      <div ref={scrollRef} onScroll={(event) => { shouldAutoScrollRef.current = isNearScrollBottom(event.currentTarget); }} className="w-full min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-4 [overflow-anchor:none]">
        {visibleMessages.length === 0 && (
          <p className="mt-8 text-center text-sm text-slate-500">메시지를 입력해 시작하세요.</p>
        )}
        <div className="flex w-full flex-col gap-3">
          {visibleMessages.map((m) => (
            <div key={m.id} className="flex w-full min-w-0 flex-col gap-1">
              {m.is_hidden && debugMode && (
                <p className="text-[10px] text-amber-400">🔍 숨김 메시지</p>
              )}
              {editingId === m.id ? (
                <div className="flex w-full flex-col gap-1.5">
                  <textarea
                    value={editingContent}
                    onChange={(e) => setEditingContent(e.target.value)}
                    rows={Math.max(3, editingContent.split('\n').reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / 36)), 0))}
                    autoFocus
                    className={`w-full resize-none overflow-hidden rounded-2xl px-4 py-3 text-sm text-slate-100 outline-none ${editingCommandName ? 'border-2 border-indigo-500 bg-indigo-500/10' : 'bg-surface'}`}
                  />
                  <div className="flex items-center justify-end gap-2">
                    {editingCommandName && <button onClick={() => setEditingCommandName(null)} className="mr-auto rounded-lg border border-indigo-400/60 bg-indigo-500/15 px-3 py-1.5 text-xs font-semibold text-indigo-300" aria-label={`/${editingCommandName} 명령어 제거`}>×　/{editingCommandName}</button>}
                    <button onClick={() => setEditingId(null)} className="rounded-lg bg-surface2 px-3 py-1.5 text-xs text-slate-300">취소</button>
                    <button onClick={() => saveEdit(m.id)} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white">저장</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className={`w-full min-w-0 overflow-hidden break-words [overflow-wrap:anywhere] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                    m.is_hidden
                      ? 'border border-amber-500/40 bg-surface text-amber-200'
                      : m.role === 'user' && m.command_name
                        ? 'border-l-4 border-indigo-500 bg-indigo-500/15 text-slate-100 ring-1 ring-inset ring-indigo-400/25'
                      : m.role === 'user'
                        ? 'bg-brand text-white'
                        : m.generation_status === 'interrupted' && !m.content
                          ? 'bg-surface text-slate-500'
                          : 'bg-surface text-slate-100'
                  }`}>
                    {m.role === 'user' && m.command_name && <p className="mb-2 font-bold text-indigo-400">/{m.command_name}</p>}
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                        strong: ({ children }) => <strong className="font-bold">{children}</strong>,
                        em: ({ children }) => <em className="not-italic opacity-50">{children}</em>,
                        ul: ({ children }) => <ul className="mb-2 list-outside list-disc pl-5">{children}</ul>,
                        ol: ({ children }) => <ol className="mb-2 list-outside list-decimal pl-5">{children}</ol>,
                        li: ({ children }) => <li className="mb-0.5">{children}</li>,
                        code: ({ children }) => <code className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded bg-surface2 px-1 py-0.5 text-xs font-mono">{children}</code>,
                        pre: ({ children }) => <MarkdownCodeBlock>{children}</MarkdownCodeBlock>,
                        blockquote: ({ children }) => <blockquote className="mb-2 border-l-2 border-slate-500 pl-3 text-slate-300">{children}</blockquote>,
                        h1: ({ children }) => <h1 className="mb-2 text-xl font-bold">{children}</h1>,
                        h2: ({ children }) => <h2 className="mb-2 text-lg font-bold">{children}</h2>,
                        h3: ({ children }) => <h3 className="mb-1 text-base font-semibold">{children}</h3>,
                        hr: () => <hr className="my-2 border-slate-600" />,
                        table: ({ children }) => <div className="mb-2 max-w-full overflow-x-hidden"><table className="w-full table-fixed border-collapse text-left text-xs">{children}</table></div>,
                        th: ({ children }) => <th className="break-words border border-slate-500/60 bg-surface2 px-2 py-1.5 font-semibold [overflow-wrap:anywhere]">{children}</th>,
                        td: ({ children }) => <td className="break-words border border-slate-500/60 px-2 py-1.5 align-top [overflow-wrap:anywhere]">{children}</td>,
                        del: ({ children }) => <del className="opacity-70">{children}</del>,
                        img: ({ src, alt }) => showImages ? (
                          <img src={src} alt={alt ?? ''} className="my-2 block h-auto max-w-full" loading="lazy" />
                        ) : (
                          <a
                            href={typeof src === 'string' ? src : undefined}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="my-2 block w-fit max-w-full break-all text-slate-500 opacity-60 hover:text-slate-400"
                          >
                            {typeof src === 'string' ? src : (alt || '이미지')}
                          </a>
                        ),
                        a: ({ href, children }) => (
                          <a href={href} target="_blank" rel="noopener noreferrer" className="underline text-blue-300 hover:text-blue-200">{children}</a>
                        ),
                      }}
                    >
                      {m.content || (m.generation_status === 'streaming' ? '다른 창에서 응답을 생성하고 있습니다…' : m.generation_status === 'interrupted' ? '응답이 중단되었습니다.' : '')}
                    </ReactMarkdown>
                  </div>
                  {m.role === 'assistant' && m.generation_status === 'interrupted' && m.content && (
                    <p className="text-xs text-amber-400">응답이 중간에 중단되어 수신한 내용까지만 저장되었습니다.</p>
                  )}
                  {m.role === 'assistant' && !m.is_hidden && (
                    <p className="text-right text-[10px] font-medium text-slate-500">{assistantTurnNumbers.get(m.id) ?? 0}턴</p>
                  )}
                  {!m.is_hidden && (
                    <div className={`flex items-center gap-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <button onClick={() => { setEditingId(m.id); setEditingContent(m.content); setEditingCommandName(m.command_name); }} className="text-xs text-slate-500">편집</button>
                      <button onClick={() => void branchFrom(m)} className="text-xs text-slate-500">분기</button>
                      <button disabled={messageActionBusy} onClick={() => void deleteMsg(m.id)} className="text-xs text-red-400/60 disabled:opacity-50">삭제</button>
                      {m.role === 'assistant' && <div className="ml-auto flex items-center gap-2">
                        {showCost && <span className="text-right text-[10px] text-slate-500">{showCostKrw ? formatKrw(m.cost, exchange.rate) : `$${m.cost.toFixed(6)}`} {showCostKrw && exchange.fallback ? '(폴백 환율)' : ''} · 출력 {m.output_tokens.toLocaleString()} tokens</span>}
                        {showCacheTokens && <span className="text-right text-[10px] text-slate-500">캐시 읽기 {m.cache_read_tokens == null ? '미보고' : m.cache_read_tokens.toLocaleString()} · 쓰기 {m.cache_write_tokens == null ? '미보고' : m.cache_write_tokens.toLocaleString()}</span>}
                        {variantsFor(m).length > 1 && <select aria-label="리롤 답변 선택" value={m.id} onChange={(event) => void selectVariant(m, event.target.value)} className="max-w-28 bg-transparent text-xs text-slate-400 outline-none">{variantsFor(m).map((variant, index, variants) => <option key={variant.id} value={variant.id}>답변 비교 {index + 1}/{variants.length}</option>)}</select>}
                        {!isGuest && m.id === [...visibleMessages].reverse().find((item) => item.role === 'assistant')?.id && <button onClick={() => void send({ reroll: true })} disabled={sending} className="text-lg text-brand disabled:opacity-50" aria-label="다시 생성">↻</button>}
                      </div>}
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
          {sending && (
            <div className="self-start max-w-full rounded-2xl bg-surface px-4 py-2.5 text-sm leading-relaxed text-slate-100">
              {streamingContent ? (
                <p className="whitespace-pre-wrap break-words">{streamingContent}</p>
              ) : (
                <span className="text-slate-400">생각 중…</span>
              )}
            </div>
          )}
        </div>
      </div>

      {selectedCommand && <div className="flex shrink-0 items-center gap-2 border-t border-surface2 bg-brand/10 px-3 py-2 text-sm">
        <span className="font-semibold text-brand">/{selectedCommand.name}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-slate-400">{selectedCommand.description}</span>
        <button onClick={() => setSelectedCommand(null)} aria-label="선택한 명령어 해제" className="text-slate-500">×</button>
      </div>}
      <div className="flex shrink-0 items-end gap-2 border-t border-surface2 p-2">
        {!isGuest && <button onClick={() => setCommandMenuOpen(true)} aria-label="명령어 메뉴 열기" className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg font-semibold ${selectedCommand ? 'bg-brand text-white' : 'bg-surface text-slate-400'}`}>/</button>}
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && shouldSubmitOnEnter()) { e.preventDefault(); void send(); } }}
          rows={1}
          placeholder="메시지 입력…"
          className="max-h-32 flex-1 resize-none rounded-2xl bg-surface px-4 py-2.5 text-sm outline-none"
        />
        {sending ? (
          <button
            onClick={() => (sessionId ? activeGenerations.get(sessionId)?.controller : abortControllerRef.current)?.abort('사용자가 응답 생성을 중단했습니다.')}
            className="rounded-full bg-red-500 px-4 py-2.5 text-sm font-semibold text-white"
          >
            중단
          </button>
        ) : (
          <button
          onClick={() => void send()}
            className="rounded-full bg-brand px-4 py-2.5 text-sm font-semibold text-white"
          >
            전송
          </button>
        )}
      </div>

      {commandMenuOpen && user && <CommandMenu userId={user.id} onClose={() => setCommandMenuOpen(false)} onSelect={setSelectedCommand} />}

      {menuOpen && !isGuest && session && (
        <SessionMenu
          session={session}
          profile={profile}
          onClose={() => setMenuOpen(false)}
          onUpdate={(patch) => setSession((s) => (s ? { ...s, ...patch } : s))}
          onPersonaChange={(p) => setPersona(p)}
          debugMode={debugMode}
          onDebugToggle={setDebugMode}
          showCost={showCost}
          onShowCostToggle={(v) => { setShowCost(v); localStorage.setItem('chatforme.showCost', v ? '1' : '0'); }}
          showCostKrw={showCostKrw}
          onShowCostKrwToggle={(v) => { setShowCostKrw(v); localStorage.setItem('inuchat.showCostKrw', v ? '1' : '0'); }}
          showCacheTokens={showCacheTokens}
          onShowCacheTokensToggle={(v) => { setShowCacheTokens(v); localStorage.setItem('inuchat.showCacheTokens', v ? '1' : '0'); }}
          showImages={showImages}
          onShowImagesToggle={(v) => { setShowImages(v); localStorage.setItem('inuchat.showImages', v ? '1' : '0'); }}
          exchange={exchange}
          sessionModel={sessionModel || modelsFor('openrouter')[0]}
          sessionReasoning={sessionReasoning}
          onModelChange={(m) => {
            setSessionModel(m);
          }}
          onReasoningChange={(reasoning) => {
            setSessionReasoning(reasoning);
          }}
          errorLog={errorLog}
          onClearErrors={() => setErrorLog([])}
          onGenerateSummary={(throughTurn) => generateSummary(messages, [], throughTurn)}
          onMergeSummaries={(contents) => generateSummary(messages, contents)}
          summaryGenerating={summaryGenerating}
          storyNotes={storyNotes}
          onStoryNotesChange={setStoryNotes}
          sessionTurnCount={sessionTurnCount}
        />
      )}
    </div>
  );
}
