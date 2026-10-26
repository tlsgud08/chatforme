import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import MessageContent from '@/components/MessageContent';
import Spoiler from '@/components/Spoiler';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { useChatScroll } from '@/hooks/useChatScroll';
import { getApiKey } from '@/lib/apiKeys';
import { generate } from '@/lib/llm';
import { createDraftWriter } from '@/lib/draftWriter';
import { beginResponse, commitResponse, retainResponse, pendingResponse, forgetResponse, recoverExpiredResponses, type ResponseCommit, type CommittedResponse } from '@/lib/responseRecovery';
import { loadChatRoom, loadChatContext, type ChatContext } from '@/lib/chatRoomData';
import { mutateMessage } from '@/lib/messageMutations';
import { registerAccountTask } from '@/lib/accountTasks';
import { branchSession, fetchMessagePage, generationContext, mergeLatestPage, selectResponse } from '@/lib/sessionData';
import { cacheSessionCount } from '@/lib/sessionCounts';
import { startOperation, measureOperation } from '@/lib/operationTiming';
import { PROVIDER_LABELS, type CacheDiagnostic, type ReasoningSelection } from '@/lib/llm/types';
import { defaultReasoningFor } from '@/lib/llm/modelCapabilities';
import { loadDefaultReasoning, modelsFor, normalizeReasoning, toOpenRouterModel } from '@/lib/modelPreferences';
import { assemblePrompt } from '@/lib/prompt/assemble';
import { loadWorkCombination } from '@/lib/workCombinationData';
import { workThemeScopeKey } from '@/lib/workCombination';
import { loadWorkThemeCatalog } from '@/lib/workThemeData';
import { resolvePromptCache } from '@/lib/llm/promptCache';
import { DEFAULT_SUMMARY_PROMPT } from '@/lib/summaryPrompt';
import type { Command, KeywordBook, Message, Persona, Profile, Provider, Session, StartConfig, StoryNote, SummaryVersion, Work } from '@/types/db';
import SessionMenu from '@/components/SessionMenu';
import { formatKrw, useUsdKrwRate } from '@/lib/exchangeRate';
import { isTurnPriceWarning, loadTurnPriceWarning } from '@/lib/turnPriceWarning';
import { showToast } from '@/lib/toast';
import { conversationFilename, downloadConversationText, formatConversationText } from '@/lib/chatExport';
import CommandMenu from '@/components/CommandMenu';
import { showConfirmDialog } from '@/lib/dialog';
import { automaticThemeEnabled, availableWorkThemes, dayNightCatalogNames, dayNightModeEnabled, finalThemeDirective, normalizeThemePeriods, observeThemeDirective, resolveThemeDirectiveChoice, stripThemeDirectives, themeCatalogPrompt } from '@/lib/themeDirectives';
import { paletteFor, preferredThemeVariant, requestThemeRefresh, type SavedTheme } from '@/lib/theme';
import InterfaceIcon from '@/components/InterfaceIcon';
import './ChatPage.css';

function SpoilerBoundary({ concealed, children }: { concealed: boolean; children: ReactNode }) {
  return concealed ? <Spoiler block>{children}</Spoiler> : <>{children}</>;
}

const GENERATION_TIMEOUT_MS = 8 * 60_000;
const DRAFT_SAVE_INTERVAL_MS = 1000;
const MESSAGE_FETCH_BATCH_SIZE = 500;
async function fetchAllSessionMessages(sessionId: string): Promise<Message[]> {
  const messages: Message[] = [];
  for (let from = 0; ; from += MESSAGE_FETCH_BATCH_SIZE) {
    const { data, error } = await supabase.from('messages')
      .select('*')
      .eq('session_id', sessionId)
      .order('turn_index', { ascending: true })
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + MESSAGE_FETCH_BATCH_SIZE - 1);
    if (error) throw error;
    const batch = (data as Message[] | null) ?? [];
    messages.push(...batch);
    if (batch.length < MESSAGE_FETCH_BATCH_SIZE) return orderMessagesByTurn(messages);
  }
}

function orderMessagesByTurn(messages: Message[]): Message[] {
  return [...messages].sort((left, right) => {
    if (left.turn_index !== right.turn_index) return left.turn_index - right.turn_index;
    if (left.role !== right.role) return left.role === 'user' ? -1 : 1;
    const createdAtOrder = left.created_at.localeCompare(right.created_at);
    return createdAtOrder || left.id.localeCompare(right.id);
  });
}

const sessionSettingsKey = (id: string) => `chatforme.session.${id}.settings`;
interface SessionSettings { provider: Provider; model: string; reasoning: ReasoningSelection; }
function loadSessionSettings(session: Session, profile: Profile | null): SessionSettings {
  if (session.model_override) {
    const model = toOpenRouterModel('openrouter', session.model_override);
    return {
      provider: 'openrouter',
      model,
      reasoning: normalizeReasoning((session.output_settings_override_enabled ? session.reasoning_override : null) ?? profile?.default_reasoning ?? { ...loadDefaultReasoning('openrouter', model), send: profile?.default_reasoning_enabled ?? true }, 'openrouter', model),
    };
  }
  try {
    const raw = localStorage.getItem(sessionSettingsKey(session.id));
    if (raw) {
      const parsed = JSON.parse(raw) as SessionSettings;
      if (parsed.model) {
        const model = toOpenRouterModel(parsed.provider, parsed.model);
        return { provider: 'openrouter', model, reasoning: normalizeReasoning(parsed.reasoning, 'openrouter', model) };
      }
    }
  } catch {}
  const model = toOpenRouterModel(profile?.default_provider, profile?.default_model || modelsFor('openrouter')[0]);
  return { provider: 'openrouter', model, reasoning: normalizeReasoning(profile?.default_reasoning ?? { ...loadDefaultReasoning('openrouter', model), send: profile?.default_reasoning_enabled ?? true }, 'openrouter', model) };
}

interface ActiveGeneration {
  controller: AbortController;
  content: string;
  listeners: Set<(content: string | null) => void>;
}
const activeGenerations = new Map<string, ActiveGeneration>();

interface ActiveSummaryGeneration {
  controller: AbortController;
  listeners: Set<() => void>;
}
const activeSummaryGenerations = new Map<string, ActiveSummaryGeneration>();

function publishGeneration(id: string, content: string | null) {
  const active = activeGenerations.get(id);
  if (!active) return;
  if (content !== null) active.content = content;
  active.listeners.forEach((listener) => listener(content));
  if (content === null) activeGenerations.delete(id);
}

function finishSummaryGeneration(id: string) {
  const active = activeSummaryGenerations.get(id);
  if (!active) return;
  activeSummaryGenerations.delete(id);
  active.listeners.forEach((listener) => listener());
}

export interface ErrorEntry {
  id: string;
  short: string;
  detail: string;
  at: string;
}

function classifyError(raw: string): string {
  raw = raw.split('\n처리 시간(ms):', 1)[0];
  if (raw.includes('API 키가 없습니다')) return raw;
  if (raw.includes('(401)') || raw.includes('(403)')) return 'API 키가 유효하지 않습니다';
  if (raw.includes('(404)')) return '모델을 찾을 수 없습니다. 세션 메뉴에서 모델을 재선택하세요';
  if (raw.includes('(429)')) return 'API 요청 한도를 초과했습니다. 잠시 후 재시도하세요';
  if (raw.includes('(500)') || raw.includes('(502)') || raw.includes('(503)')) return 'AI 서버 오류입니다. 잠시 후 재시도하세요';
  if (/failed to fetch|load failed|networkerror/i.test(raw)) return '연결 오류로 요청을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요';
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

function focusEditor(element: HTMLTextAreaElement | null) {
  element?.focus({ preventScroll: true });
}

function shouldSubmitOnEnter() {
  if (typeof window === 'undefined') return true;
  const mobileUserAgent = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const touchPhoneLayout = navigator.maxTouchPoints > 0 && window.matchMedia('(max-width: 768px)').matches;
  return !mobileUserAgent && !touchPhoneLayout;
}

function CacheDiagnosticPanel({ diagnostic }: { diagnostic: CacheDiagnostic }) {
  const ratio = diagnostic.cacheReadRatio == null ? '미보고' : `${(diagnostic.cacheReadRatio * 100).toFixed(1)}%`;
  return (
    <details className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 text-[10px] text-slate-400">
      <summary className="cursor-pointer font-semibold text-amber-300">캐시 진단 (Estimated) · read ratio {ratio}</summary>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
        <span>prompt_tokens</span><span>{diagnostic.promptTokens.toLocaleString()}</span>
        <span>cached_tokens</span><span>{diagnostic.cachedTokens?.toLocaleString() ?? '미보고'}</span>
        <span>cache_write_tokens</span><span>{diagnostic.cacheWriteTokens?.toLocaleString() ?? '미보고'}</span>
        <span>model / upstream</span><span className="break-all">{diagnostic.model} / {diagnostic.upstreamProvider ?? '미보고'}</span>
        <span>history</span><span>{diagnostic.historyChange}</span>
        <span>session</span><span className="break-all">{diagnostic.sessionId}</span>
        <span>request / generation</span><span className="break-all">{diagnostic.requestId} / {diagnostic.generationId ?? '미보고'}</span>
      </div>
      <div className="mt-2 border-t border-amber-500/20 pt-2 font-mono">
        {diagnostic.components.map((component) => (
          <div key={component.key} className="grid grid-cols-[1fr_auto_auto] gap-2">
            <span className="truncate" title={`${component.label} · ${component.fingerprint}`}>{component.label}</span>
            <span>{component.change}</span><span>{component.cacheStatus}</span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-slate-500">system 내부 구성 요소, role/separator 및 provider tokenizer 오버헤드를 근사한 경계이며 실제 provider breakpoint가 아닙니다.</p>
    </details>
  );
}

export default function ChatPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [session, setSession] = useState<Session | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [contextReady, setContextReady] = useState(false);
  const [contextError, setContextError] = useState('');
  const contextRetryRef = useRef<AbortController | null>(null);
  const settingsSnapshotRef = useRef('');
  const [work, setWork] = useState<Work | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [persona, setPersona] = useState<Persona | null>(null);
  const [startConfig, setStartConfig] = useState<StartConfig | null>(null);
  const [keywordBooks, setKeywordBooks] = useState<KeywordBook[]>([]);
  const [themePrompt,setThemePrompt]=useState('');
  const [workThemes,setWorkThemes]=useState<SavedTheme[]>([]);
  const themeSelectionKey=JSON.stringify([session?.work_id,session?.work_combination_enabled,session?.combined_work_ids??[]]);
  const themeMessageRef=useRef<{sessionId:string;fingerprint:string}|null>(null);
  const themeRequestScopeRef=useRef<{messageId:string;scope:string}|null>(null);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [workCombinationSaving, setWorkCombinationSaving] = useState(false);
  const workCombinationSavingRef = useRef(false);
  const onWorkCombinationSavingChange = useCallback((saving: boolean) => {
    if (saving && (sendInFlightRef.current || branchInFlightRef.current || workCombinationSavingRef.current)) return false;
    workCombinationSavingRef.current = saving;
    setWorkCombinationSaving(saving);
    return true;
  }, []);
  const [exportingConversation, setExportingConversation] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [debugMode, setDebugMode] = useState(false);
  const [cacheDiagnostics, setCacheDiagnostics] = useState<Record<string, CacheDiagnostic>>({});
  const [showCost, setShowCost] = useState(() => localStorage.getItem('chatforme.showCost') !== '0');
  const [showCostKrw, setShowCostKrw] = useState(() => localStorage.getItem('inuchat.showCostKrw') === '1');
  const [showCacheTokens, setShowCacheTokens] = useState(() => localStorage.getItem('inuchat.showCacheTokens') === '1');
  const [showImages, setShowImages] = useState(() => localStorage.getItem('inuchat.showImages') !== '0');
  const [showOffMode, setShowOffMode] = useState(() => {
    try { return localStorage.getItem('inuchat.showOffMode') === '1'; }
    catch { return false; }
  });
  const exchange = useUsdKrwRate();
  const turnPriceWarning = loadTurnPriceWarning();
  const [errorLog, setErrorLog] = useState<ErrorEntry[]>([]);
  const [toastError, setToastError] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [editingCommandName, setEditingCommandName] = useState<string | null>(null);
  const [editingSavingId, setEditingSavingId] = useState<string | null>(null);
  const [sessionModel, setSessionModel] = useState('');
  const [sessionReasoning, setSessionReasoning] = useState<ReasoningSelection>(() => defaultReasoningFor('openrouter', modelsFor('openrouter')[0]));
  const [summaryGenerating, setSummaryGenerating] = useState(false);
  const [storyNotes, setStoryNotes] = useState<StoryNote[]>([]);
  const [deletingMessageId, setDeletingMessageId] = useState<string | null>(null);
  const [selectingVariantId, setSelectingVariantId] = useState<string | null>(null);
  const [hasOlderServerMessages, setHasOlderServerMessages] = useState(false);
  const [oldestLoadedAt, setOldestLoadedAt] = useState<number | null>(null);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [totalUserTurnCount, setTotalUserTurnCount] = useState(0);
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const [selectedCommand, setSelectedCommand] = useState<Command | null>(null);
  const [pendingSave, setPendingSave] = useState<ResponseCommit | null>(() => user && sessionId ? pendingResponse(user.id, sessionId) : null);
  const [recoveringSave, setRecoveringSave] = useState(false);
  const pendingSaveLockRef = useRef(false);

  const [streamingContent, setStreamingContent] = useState('');
  const abortControllerRef = useRef<AbortController | null>(null);
  const { scrollRef, rememberScroll } = useChatScroll(sessionId, !!session && !!work);
  const olderMessagesSentinelRef = useRef<HTMLDivElement>(null);
  const olderMessagesInFlightRef = useRef(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendInFlightRef = useRef(false);
  const editInFlightRef = useRef(false);
  const deleteInFlightRef = useRef(false);
  const branchInFlightRef = useRef(false);
  const exportInFlightRef = useRef(false);
  const settingsSessionIdRef = useRef<string | null>(null);
  const messageBoundaryRef = useRef({ hasOlder: false, oldestTurn: null as number | null });
  const messageReadControllerRef = useRef(new AbortController());
  const latestReadSequenceRef = useRef(0);
  const appliedReadSequenceRef = useRef(0);

  useEffect(() => {
    messageReadControllerRef.current = new AbortController();
    return () => { messageReadControllerRef.current.abort(); latestReadSequenceRef.current++; };
  }, [sessionId]);

  useEffect(() => {
    setHasOlderServerMessages(false);
    setOldestLoadedAt(null);
    setTotalUserTurnCount(0);
  }, [sessionId]);

  const loadLatestMessages = useCallback(async () => {
    if (!sessionId) return;
    const sequence = ++latestReadSequenceRef.current;
    const signal = messageReadControllerRef.current.signal;
    const page = await measureOperation('message-page', () => fetchMessagePage(sessionId, undefined, signal));
    if (signal.aborted || sequence !== latestReadSequenceRef.current) return;
    appliedReadSequenceRef.current = sequence;
    // A background completion must not discard older turns the reader opened.
    setMessages(current => {
      const merged = mergeLatestPage(current, page, messageBoundaryRef.current);
      messageBoundaryRef.current = { hasOlder: merged.hasOlder, oldestTurn: merged.oldestTurn };
      setHasOlderServerMessages(merged.hasOlder);
      setOldestLoadedAt(merged.oldestTurn);
      return merged.messages;
    });
    setTotalUserTurnCount(page.totalUserTurns);
  }, [sessionId]);

  const loadOlderMessages = useCallback(async () => {
    if (!sessionId || oldestLoadedAt === null || !hasOlderServerMessages || olderMessagesInFlightRef.current) return;
    olderMessagesInFlightRef.current = true;
    setLoadingOlderMessages(true);
    try {
      const signal = messageReadControllerRef.current.signal;
      const page = await fetchMessagePage(sessionId, oldestLoadedAt, signal);
      if (signal.aborted) return;
      setMessages((current) => {
        const loadedIds = new Set(current.map((message) => message.id));
        return orderMessagesByTurn([...page.messages.filter((message) => !loadedIds.has(message.id)), ...current]);
      });
      setHasOlderServerMessages(page.hasOlder);
      setOldestLoadedAt(page.oldestTurn);
      messageBoundaryRef.current = { hasOlder: page.hasOlder, oldestTurn: page.oldestTurn };
    } catch (error) {
      if (!messageReadControllerRef.current.signal.aborted) addError(`이전 대화 불러오기 실패: ${describeUnknownError(error)}`);
    } finally {
      olderMessagesInFlightRef.current = false;
      setLoadingOlderMessages(false);
    }
  }, [hasOlderServerMessages, oldestLoadedAt, sessionId]);

  const hasOlderMessagesToReveal = hasOlderServerMessages;

  const revealOlderMessages = useCallback(() => {
    const element = scrollRef.current;
    if (!element || !hasOlderMessagesToReveal || olderMessagesInFlightRef.current || editInFlightRef.current || deleteInFlightRef.current) return;

    void loadOlderMessages();
  }, [hasOlderMessagesToReveal, loadOlderMessages]);

  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = olderMessagesSentinelRef.current;
    if (!root || !sentinel || !hasOlderMessagesToReveal) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) revealOlderMessages();
    }, { root, rootMargin: '80px 0px 0px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasOlderMessagesToReveal, revealOlderMessages]);

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
      void loadLatestMessages().catch((error) => addError(`메시지 새로고침 실패: ${describeUnknownError(error)}`));
    };
    active.listeners.add(listener);
    return () => { active.listeners.delete(listener); };
  }, [loadLatestMessages, sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    const active = activeSummaryGenerations.get(sessionId);
    setSummaryGenerating(!!active);
    if (!active) return;
    const listener = () => {
      setSummaryGenerating(false);
      void supabase.from('sessions').select('*').eq('id', sessionId).single().then(({ data }) => {
        if (data) setSession(data as Session);
      });
      void loadLatestMessages().catch((error) => addError(`메시지 새로고침 실패: ${describeUnknownError(error)}`));
    };
    active.listeners.add(listener);
    return () => { active.listeners.delete(listener); };
  }, [loadLatestMessages, sessionId]);

  useEffect(() => {
    if (user && sessionId && !sending) setPendingSave(pendingResponse(user.id, sessionId));
  }, [user?.id, sessionId, sending]);

  useEffect(() => {
    if (!sessionId || !session || activeGenerations.has(sessionId)) return;
    let live = true;
    void recoverExpiredResponses(sessionId).then(changed => {
      if (live && changed) void loadLatestMessages().catch(error => addError('중단된 대화 다시 불러오기 실패: ' + describeUnknownError(error)));
    }).catch(error => { if (live) addError('중단된 생성 확인 실패: ' + describeUnknownError(error)); });
    return () => { live = false; };
  }, [session?.id, sessionId, loadLatestMessages]);

  function applyCommittedResponse(result: CommittedResponse) {
    const message = result.message;
    const sequence = ++latestReadSequenceRef.current;
    appliedReadSequenceRef.current = sequence;
    setMessages(current => orderMessagesByTurn([
      ...current.filter(row => row.id !== message.id).map(row => message.is_active_variant && message.reroll_group_id
        && row.role === 'assistant' && (row.reroll_group_id ?? row.id) === message.reroll_group_id ? { ...row, is_active_variant: false } : row),
      message,
    ]));
    setSession(current => current?.id === message.session_id ? { ...current, ...result.session } : current);
  }

  async function retryPendingSave() {
    if (!pendingSave || !user || sending || pendingSaveLockRef.current) return;
    pendingSaveLockRef.current = true;
    setRecoveringSave(true);
    try {
      const result = await commitResponse(pendingSave);
      applyCommittedResponse(result);
      if (result.contextConflict) { addError('생성 도중 대화가 바뀌어 답변을 중단본으로 보관했습니다. 내용을 확인하고 복사할 수 있어요.'); return; }
      forgetResponse(user.id, pendingSave);
      setPendingSave(null);
      showToast('답변 저장을 확인했습니다.');
    } catch (error) { addError('답변 저장 확인 실패: ' + describeUnknownError(error)); }
    finally { pendingSaveLockRef.current = false; setRecoveringSave(false); }
  }

  async function discardPendingSave() {
    if (!pendingSave || !user || sending || pendingSaveLockRef.current) return;
    if (!await showConfirmDialog('보관한 답변을 지울까요?', '필요한 내용은 먼저 TXT로 보관해 주세요. 서버 저장을 확인하지 못한 답변은 이 기기 사본을 지우면 복구할 수 없을 수 있어요.', '사본 지우기')) return;
    if (pendingSaveLockRef.current) return;
    pendingSaveLockRef.current = true;
    try {
      const { error } = await supabase.from('messages').update({ generation_status: 'interrupted' })
        .eq('id', pendingSave.target_message).eq('session_id', pendingSave.target_session).eq('generation_status', 'streaming');
      if (error) throw error;
      forgetResponse(user.id, pendingSave);
      setPendingSave(null);
      await loadLatestMessages();
    } catch (error) { addError('보관한 답변 정리 실패: ' + describeUnknownError(error)); }
    finally { pendingSaveLockRef.current = false; }
  }

  function addError(raw: string) {
    const short = classifyError(raw);
    const entry: ErrorEntry = { id: crypto.randomUUID(), short, detail: raw, at: new Date().toISOString() };
    setErrorLog((prev) => [...prev.slice(-19), entry]);
    setToastError(short);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastError(''), 4000);
  }

  const applyChatContext = useCallback((value: ChatContext) => {
    setProfile(value.profile);
    setPersona(value.persona);
    setStartConfig(value.startConfig);
    setKeywordBooks(value.keywordBooks);
    setStoryNotes(value.storyNotes);
    setSystemPrompt(value.systemPrompt);
    setThemePrompt(value.themePrompt);
    const settings = loadSessionSettings(value.session, value.profile);
    settingsSnapshotRef.current = JSON.stringify(settings);
    settingsSessionIdRef.current = value.session.id;
    setSessionModel(settings.model);
    setSessionReasoning(settings.reasoning);
    setContextError('');
    setContextReady(true);
  }, []);

  useEffect(() => {
    if (!sessionId || !user?.id) return;
    const controller = new AbortController();
    const initialSequence = ++latestReadSequenceRef.current;
    contextRetryRef.current?.abort();
    setContextReady(false);
    setContextError('');
    setLoadError('');
    void loadChatRoom(sessionId, user.id, controller.signal, {
      display: (sess, loadedWork, page) => {
        setSession(current => current?.id === sess.id ? { ...sess, ...current } : sess);
        setWork(loadedWork);
        if (initialSequence >= appliedReadSequenceRef.current) {
          appliedReadSequenceRef.current = initialSequence;
          setMessages(page.messages);
          setHasOlderServerMessages(page.hasOlder);
          setOldestLoadedAt(page.oldestTurn);
          messageBoundaryRef.current = { hasOlder: page.hasOlder, oldestTurn: page.oldestTurn };
          setTotalUserTurnCount(page.totalUserTurns);
        }
      },
      context: applyChatContext,
      displayError: error => { controller.abort(); setLoadError(describeUnknownError(error)); },
      contextError: error => { setContextError(describeUnknownError(error)); setContextReady(false); },
    });
    return () => { controller.abort(); contextRetryRef.current?.abort(); };
  }, [sessionId, user?.id, loadAttempt, applyChatContext]);

  async function retryChatContext() {
    if (!session || !user || contextRetryRef.current) return;
    const controller = new AbortController();
    contextRetryRef.current = controller;
    setContextError('');
    try {
      const { data: fresh, error } = await supabase.from('sessions').select('*').eq('id', session.id).eq('user_id', user.id).abortSignal(controller.signal).single();
      if (error || !fresh) throw error ?? new Error('채팅방에 접근할 수 없습니다.');
      controller.signal.throwIfAborted();
      if (fresh.work_id !== session.work_id) { setLoadAttempt(attempt => attempt + 1); return; }
      const context = await loadChatContext(fresh as Session, user.id, controller.signal);
      setSession(current => current?.id === fresh.id ? { ...current, ...fresh } : current);
      applyChatContext(context);
    }
    catch (error) { if (!controller.signal.aborted) setContextError(describeUnknownError(error)); }
    finally { if (contextRetryRef.current === controller) contextRetryRef.current = null; }
  }

  useEffect(() => {
    if (!sessionId || !sessionModel || settingsSessionIdRef.current !== sessionId) return;
    const settings = JSON.stringify({ provider: 'openrouter', model: sessionModel, reasoning: sessionReasoning });
    localStorage.setItem(sessionSettingsKey(sessionId), settings);
    if (settingsSnapshotRef.current === settings) return;
    const timer = window.setTimeout(() => {
      void supabase.from('sessions').update({
        model_override: sessionModel,
        reasoning_override: sessionReasoning,
      }).eq('id', sessionId).then(({ error }) => {
        if (error) addError(`모델 설정 저장 실패: ${describeUnknownError(error)}`);
        else settingsSnapshotRef.current = settings;
      });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [sessionId, sessionModel, sessionReasoning]);

  // Stable ordering keeps the theme catalog cacheable in the system core.
  useEffect(()=>{
    if(!session?.work_id||!user?.id){setWorkThemes([]);return;}
    let controller:AbortController|undefined;
    const refresh=async()=>{
      controller?.abort();
      const pending=new AbortController();
      controller=pending;
      try{
        const catalog=await loadWorkThemeCatalog(session,user.id,pending.signal);
        if(!pending.signal.aborted)setWorkThemes(catalog.themes);
      }catch(error){
        if(!pending.signal.aborted)addError('작품 테마 목록 불러오기 실패: '+describeUnknownError(error));
      }
    };
    void refresh();
    window.addEventListener('inuchat:theme-changed',refresh);
    return ()=>{controller?.abort();window.removeEventListener('inuchat:theme-changed',refresh);};
  },[session?.id,themeSelectionKey,user?.id]);

  async function readLiveThemeContext(withCatalog=true, signal?: AbortSignal){
    if(!session||!profile)throw new Error('테마 설정을 불러오지 못했습니다.');
    const roomColumns = session.work_combination_enabled !== undefined
      ? 'theme_override,theme_id,theme_variant,theme_day_night_enabled,theme_period,work_combination_enabled,combined_work_ids'
      : 'theme_override,theme_id,theme_variant,theme_day_night_enabled,theme_period';
    const [account,room]=await Promise.all([
      supabase.from('profiles').select('preferred_theme_mode,preferred_theme_variant,prefer_work_theme,preferred_theme_id').eq('id',session.user_id).abortSignal(signal ?? messageReadControllerRef.current.signal).single(),
      supabase.from('sessions').select(roomColumns).eq('id',session.id).eq('user_id',session.user_id).abortSignal(signal ?? messageReadControllerRef.current.signal).returns<Partial<Session>[]>().single(),
    ]);
    if(account.error)throw account.error;
    if(room.error)throw room.error;
    const liveSession={...session,...room.data} as Session;
    const preference=account.data;
    const variant=preferredThemeVariant(preference,'light');
    const dayNight=dayNightModeEnabled(liveSession,variant);
    // Combined catalogs are read against the live room and work permissions,
    // rather than a previous render (including changes on another device).
    const catalog=withCatalog&&liveSession.theme_override==null
      ? await loadWorkThemeCatalog(liveSession,session.user_id,signal ?? messageReadControllerRef.current.signal)
      : {themes:availableWorkThemes(workThemes,session.work_id,session.user_id),scope:undefined};
    return {session:liveSession,preference,variant,dayNight,...catalog,
      names:dayNight?dayNightCatalogNames(catalog.themes,!!catalog.scope):[]};
  }

  useEffect(()=>{
    if(!session)return;
    const latest=[...messages].reverse().find(m=>m.role==='assistant'&&!m.is_hidden&&m.is_active_variant!==false&&m.generation_status!=='streaming');
    const {observation,changed}=observeThemeDirective(themeMessageRef.current,session.id,latest??null);
    themeMessageRef.current=observation;
    const fingerprint=observation.fingerprint;
    // Mode/option changes and initial load never replay old tags.
    if(!changed||!latest||latest.generation_status==='interrupted'||session.theme_override!=null)return;
    const targetSessionId=session.id;
    void (async()=>{
      try{
        const live=await readLiveThemeContext();
        if(!automaticThemeEnabled(live.session,live.themes,live.dayNight,!!live.scope)||themeMessageRef.current?.sessionId!==targetSessionId||themeMessageRef.current?.fingerprint!==fingerprint)return;
        const requestScope=themeRequestScopeRef.current;
        if(requestScope?.messageId===latest.id&&requestScope.scope!==workThemeScopeKey(live.session))return;
        const choice=resolveThemeDirectiveChoice(finalThemeDirective(latest.content),live.themes,live.dayNight,!!live.scope);
        if(!choice)return;
        const {theme:selected,period}=choice;
        if(!paletteFor(selected,period==='night'?'dark':live.variant))return;
        const patch={theme_id:selected.id,theme_variant:live.variant,theme_period:period};
        if(live.session.theme_id===selected.id&&live.session.theme_variant===live.variant&&(live.session.theme_period??null)===period)return;
        let update=supabase.from('sessions').update(patch).eq('id',targetSessionId)
          .eq('user_id',session.user_id).is('theme_override',null)
          .eq('theme_day_night_enabled',live.session.theme_day_night_enabled??false);
        // Reject an in-flight write after a concurrent preference change.
        update=live.session.theme_variant==null?update.is('theme_variant',null):update.eq('theme_variant',live.session.theme_variant);
        if(live.session.work_combination_enabled!==undefined){
          update=update.eq('work_combination_enabled',live.session.work_combination_enabled)
            .eq('combined_work_ids',`{${(live.session.combined_work_ids??[]).join(',')}}`);
        }
        const {data,error}=await update.select('id').maybeSingle();
        if(error)throw error;
        if(!data||themeMessageRef.current?.sessionId!==targetSessionId||themeMessageRef.current?.fingerprint!==fingerprint)return;
        setSession(current=>current?.id===targetSessionId&&current.theme_override==null&&workThemeScopeKey(current)===workThemeScopeKey(live.session)&&(current.theme_day_night_enabled??false)===(live.session.theme_day_night_enabled??false)?{...current,...patch}:current);
        requestThemeRefresh();
      }catch(error){addError('자동 테마 변경 실패: '+describeUnknownError(error));}
    })();
  },[messages,session?.id,session?.theme_override,session?.theme_day_night_enabled,themeSelectionKey,workThemes]);

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
    if (cutoff <= 0) return allMsgs;
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

  async function generateSummary(archivesToMerge: SummaryVersion[] = [], requestedThroughTurn?: number) {
    if (!contextReady || !session || !profile || editInFlightRef.current || deleteInFlightRef.current || branchInFlightRef.current || sendInFlightRef.current || activeGenerations.has(session.id) || summaryGenerating || activeSummaryGenerations.has(session.id)) return;
    const apiKey = getApiKey('openrouter');
    if (!apiKey) { addError('OpenRouter API 키가 없어 요약을 생성할 수 없습니다.'); return; }
    const summarySessionId = session.id;
    const summaryController = new AbortController();
    const unregisterTask = registerAccountTask(summaryController);
    activeSummaryGenerations.set(summarySessionId, { controller: summaryController, listeners: new Set() });
    setSummaryGenerating(true);
    try {
      const liveTheme=await readLiveThemeContext(true,summaryController.signal);
      // Include the hidden initial context in the first archive so important
      // scenario setup is not lost after its short keep_turns window expires.
      const sourceMode = session.summary_source_mode_override ?? profile.summary_source_mode ?? 'incremental';
      await recoverExpiredResponses(session.id);
      const completeSourceMessages = await fetchAllSessionMessages(session.id);
      const allActiveMessages = completeSourceMessages.filter((message) => message.is_active_variant !== false);
      if (allActiveMessages.some(message => message.generation_status === 'streaming')) throw new Error('응답 생성이 끝난 뒤 요약해 주세요.');
      const latestTurn = allActiveMessages.filter((message) => message.role === 'user' && !message.is_hidden).length;
      const throughTurn = Math.max(0, Math.min(requestedThroughTurn ?? latestTurn, latestTurn));
      const activeSourceMessages = messagesThroughTurn(allActiveMessages, throughTurn);
      let previous = archivesToMerge.length > 0
        ? archivesToMerge.map(version => version.content).join('\n\n--- Summary to Merge ---\n\n')
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
      if (candidates.length === 0 && archivesToMerge.length === 0) throw new Error('새로 요약할 대화가 없습니다.');
      const autoThemeEnabled=automaticThemeEnabled(liveTheme.session,liveTheme.themes,liveTheme.dayNight,!!liveTheme.scope);
      const dialogue = candidates.map((message) => `[${message.is_hidden ? 'Hidden Start Settings' : message.role === 'user' ? 'User' : 'AI'}]\n${autoThemeEnabled?normalizeThemePeriods(message.content,liveTheme.names):stripThemeDirectives(message.content)}`).join('\n\n');
      const summaryInput = `${previous ? `=== Previous Summary Notes${archivesToMerge.length > 1 ? ' (merge the selected notes into one)' : ''} ===\n${previous}\n\n` : ''}${dialogue ? `=== Dialogue to Summarize ===\n${dialogue}` : '=== Request ===\nMerge the selected summary notes into one up-to-date summary without omissions or discontinuities.'}`;
      const input=autoThemeEnabled?normalizeThemePeriods(summaryInput,liveTheme.names):stripThemeDirectives(summaryInput);
      const summaryLevel = session.summary_level_override ?? profile.summary_level ?? 5;
      const allowOmission = session.summary_allow_omission_override ?? profile.summary_allow_omission ?? true;
      const parametersEnabled = !profile.summary_prompt?.trim() || (session.summary_parameters_enabled_override ?? profile.summary_parameters_enabled ?? true);
      const parameterBlock = parametersEnabled ? `[SUMMARY CONFIGURATION]\nSUMMARY_LEVEL = ${summaryLevel}\nALLOW_OMISSION = ${allowOmission ? 'ON' : 'OFF'}` : '';
      const extraNote = profile.summary_extra_note?.trim() ? `[ADDITIONAL NOTE]\n${profile.summary_extra_note.trim()}` : '';
      const summaryCore = [profile.summary_prompt?.trim() || DEFAULT_SUMMARY_PROMPT, parameterBlock, extraNote].filter(Boolean).join('\n\n');
      if (summaryController.signal.aborted) throw new Error('요약 생성을 중단했습니다.');
      const result = await generate('openrouter', {
        apiKey,
        sessionId: `${session.id}:summary`,
        signal: summaryController.signal,
        model: session.summary_model_override || profile.summary_model || profile.default_model || modelsFor('openrouter')[0],
        reasoning: normalizeReasoning(session.summary_reasoning_override ?? profile.summary_reasoning, 'openrouter', session.summary_model_override || profile.summary_model || profile.default_model || modelsFor('openrouter')[0]),
        systemParts: { core: summaryCore, persona: '', userNote: '', summary: '', keywords: '' },
        messages: [{ role: 'user', content: input }],
        maxOutputTokens: 4096,
      });
      if (summaryController.signal.aborted) throw new Error('요약 생성을 중단했습니다.');
      if (!result.text.trim()) throw new Error('요약 모델이 빈 응답을 반환했습니다.');
      const ids = candidates.map((message) => message.id);
      const { data: updated, error } = await supabase.rpc('save_generated_summary', {
        target_session: session.id, summary_text: result.text, through_turn: throughTurn,
        source_versions: [
          ...candidates.map(message => ({ id: message.id, version: message.content_version ?? 0 })),
          ...archivesToMerge.map(version => ({ kind: 'summary', id: version.id, content: version.content,
            summarized_through_turn: version.summarized_through_turn })),
        ],
        previous_summary: session.summary, previous_summary_turn: session.summary_last_turn,
        in_tokens: result.usage.inputTokens, out_tokens: result.usage.outputTokens, response_cost: result.usage.cost,
      });
      if (error || !updated) throw error ?? new Error('요약을 저장하지 못했습니다.');
      setMessages(current => current.map(message => ids.includes(message.id) ? { ...message, is_summarized: true } : message));
      setSession(current => current?.id === session.id ? { ...current, ...updated } : current);
    } catch (error) {
      addError(`요약 생성 실패: ${describeUnknownError(error)}`);
    } finally {
      unregisterTask();
      setSummaryGenerating(false);
      finishSummaryGeneration(summarySessionId);
    }
  }

  async function send(options?: { reroll?: boolean }) {
    if (pendingSave || (user && sessionId && pendingResponse(user.id, sessionId))) { showToast('보관한 답변의 저장 상태를 먼저 확인해 주세요.'); return; }
    if (!contextReady) { showToast('대화 설정을 모두 불러온 뒤 전송해 주세요.'); return; }
    if (editInFlightRef.current || deleteInFlightRef.current || branchInFlightRef.current) { showToast('대화 변경을 마친 뒤 전송해 주세요.'); return; }
    if (workCombinationSavingRef.current) { showToast('작품 결합 설정을 저장한 뒤 전송해 주세요.'); return; }
    if (!work || !session || sendInFlightRef.current || (sessionId && (activeGenerations.has(sessionId) || activeSummaryGenerations.has(sessionId)))) return;

    const provider: Provider = 'openrouter';
    const model = (sessionModel || modelsFor(provider)[0]);
    const reasoning = sessionReasoning;
    const sampling = {
      temperature: (session?.output_settings_override_enabled ? session.temperature_override : null) ?? profile?.default_temperature ?? 1,
      temperatureSend: (session?.output_settings_override_enabled ? session.temperature_enabled_override : null) ?? profile?.default_temperature_enabled ?? false,
      frequencyPenalty: (session?.output_settings_override_enabled ? session.frequency_penalty_override : null) ?? profile?.default_frequency_penalty ?? 0,
      frequencyPenaltySend: (session?.output_settings_override_enabled ? session.frequency_penalty_enabled_override : null) ?? profile?.default_frequency_penalty_enabled ?? false,
    };
    const apiKey = getApiKey(provider);
    if (!apiKey) { addError(`${PROVIDER_LABELS[provider]} API 키가 없습니다. 설정 탭에서 입력하세요.`); return; }

    // React state is not a synchronous lock: two clicks in the same render can
    // both observe `sending === false`. Lock before the first await and snapshot
    // the composer so a delayed context fetch cannot send a newer draft.
    sendInFlightRef.current = true;
    const timing = startOperation('send');
    let sendCompleted = false;
    const reportSendError = (message: string) => addError(message + '\n처리 시간(ms): ' + timing.describe());
    const submittedInput = input.trim();
    const submittedCommand = selectedCommand;
    const restoreSubmitted = () => {
      if (options?.reroll) return;
      setInput(current => current ? `${submittedInput}${submittedInput ? '\n\n' : ''}${current}` : submittedInput);
      setSelectedCommand(current => current ?? submittedCommand);
    };
    if (!options?.reroll) { setInput(''); setSelectedCommand(null); }
    setSending(true);
    setStreamingContent('');
    const controller = new AbortController();
    const unregisterTask = registerAccountTask(controller);
    abortControllerRef.current = controller;
    if (sessionId) activeGenerations.set(sessionId, { controller, content: '', listeners: new Set() });
    const releaseSend = () => {
      timing.finish(sendCompleted ? 'complete' : controller.signal.aborted ? 'cancelled' : 'failed');
      unregisterTask();
      sendInFlightRef.current = false;
      setSending(false);
      setStreamingContent('');
      abortControllerRef.current = null;
      if (sessionId) publishGeneration(sessionId, null);
    };

    // Independent reads start together. This promise always resolves, so an
    // early context failure cannot leave an unhandled metadata rejection.
    const liveThemeRead = readLiveThemeContext(false, controller.signal).then(
      value => { timing.mark('settings'); return { value, error: null }; }, error => ({ value: null, error }),
    );
    // This branch depends on current room settings, not on the dialogue read.
    // Catch immediately so an early context failure cannot leak a rejection.
    const themePreparation = liveThemeRead.then(async result => {
      if (result.error || !result.value) return { value: null, error: result.error, label: '테마 설정 조회 실패' };
      try {
        let liveTheme = result.value;
        const workCombination = await loadWorkCombination(liveTheme.session, work, controller.signal);
        if (liveTheme.session.theme_override == null) {
          const knownWorks = workCombination ? [{ id: work.id, title: work.title }, ...workCombination.works] : undefined;
          const catalog = await loadWorkThemeCatalog(liveTheme.session, session.user_id, controller.signal, knownWorks);
          liveTheme = { ...liveTheme, ...catalog, names: liveTheme.dayNight ? dayNightCatalogNames(catalog.themes, !!catalog.scope) : [] };
        }
        controller.signal.throwIfAborted();
        timing.mark('themes');
        return { value: { liveTheme, workCombination }, error: null, label: '' };
      } catch (error) { return { value: null, error, label: '작품 결합 확인 실패' }; }
    });
    let completeMessages = messages;
    let contextSummary = session.summary;
    let contextSummaryTurn = session.summary_last_turn;
    let contextHash: string | undefined;
    if (sessionId) {
      try {
        const context = await generationContext(session, Math.max(0, ...keywordBooks.map(book => book.activation_turns)), options?.reroll === true, controller.signal);
        if (controller.signal.aborted) throw new Error('응답 생성을 중단했습니다.');
        completeMessages = context.messages;
        contextSummary = context.summary;
        contextSummaryTurn = context.summaryLastTurn;
        contextHash = context.contextHash;
        timing.mark('context');
      } catch (error) {
        if (!controller.signal.aborted) reportSendError(`대화 문맥 불러오기 실패: ${describeUnknownError(error)}`);
        controller.abort();
        restoreSubmitted();
        releaseSend();
        return;
      }
    }
    const activeMessages = completeMessages.filter((message) => message.is_active_variant !== false);
    const rerollTarget = options?.reroll ? [...activeMessages].reverse().find((message) => message.role === 'assistant' && !message.is_hidden) ?? null : null;
    const baseMessages = rerollTarget ? activeMessages.filter((message) => message.id !== rerollTarget.id) : activeMessages;
    let effectiveSummary = contextSummary;
    let effectiveSummaryTurn = contextSummaryTurn;
    let rerollVersionIds: string[] | null = null;
    let rerollIndex = 1;
    let rerollGroupId: string | null = null;
    try {
      if (rerollTarget && session) {
        const currentTurns = baseMessages.filter((message) => message.role === 'user' && !message.is_hidden).length;
        if (effectiveSummaryTurn >= currentTurns) {
          const { data, error } = await supabase.from('summary_versions').select('*').eq('session_id', session.id).lt('summarized_through_turn', currentTurns).order('created_at', { ascending: false }).abortSignal(controller.signal);
          if (error) throw error;
          const prior = (data as SummaryVersion[] | null) ?? [];
          const selectedPrior = prior.filter((version) => version.is_active);
          const restored = selectedPrior.length ? selectedPrior : prior.slice(0, 1);
          effectiveSummary = restored.map((version) => version.content).join('\n\n--- Additional Summary Note ---\n\n');
          effectiveSummaryTurn = restored.reduce((latest, version) => Math.max(latest, version.summarized_through_turn), 0);
          rerollVersionIds = restored.map((version) => version.id);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) reportSendError('재생성 요약 조회 실패: ' + describeUnknownError(error));
      controller.abort();
      releaseSend();
      return;
    }
    if (rerollTarget) {
      rerollGroupId = rerollTarget.reroll_group_id ?? rerollTarget.id;
      const variants = completeMessages.filter((message) => message.role === 'assistant' && (message.reroll_group_id ?? message.id) === rerollGroupId);
      rerollIndex = Math.max(0, ...variants.map((message) => message.reroll_index ?? 1)) + 1;
    }
    const rerollUserMessage = rerollTarget ? [...baseMessages].reverse().find((message) => message.role === 'user' && !message.is_hidden) ?? null : null;
    let rerollCommandPrompt = rerollUserMessage?.command_prompt?.trim() ?? '';
    if (!rerollCommandPrompt && rerollUserMessage?.command_id) {
      const { data: command, error } = await supabase.from('commands').select('prompt').eq('id', rerollUserMessage.command_id).abortSignal(controller.signal).maybeSingle();
      if (error) {
        if (!controller.signal.aborted) reportSendError('재생성 명령어 조회 실패: ' + describeUnknownError(error));
        controller.abort();
        releaseSend();
        return;
      }
      rerollCommandPrompt = command?.prompt?.trim() ?? '';
    }
    const text = options?.reroll ? rerollUserMessage?.content ?? '' : submittedInput;
    const commandName = options?.reroll ? rerollUserMessage?.command_name : submittedCommand?.name;
    const commandPrompt = options?.reroll ? rerollCommandPrompt : submittedCommand?.prompt.trim() ?? '';
    const promptText = commandPrompt ? `${text}${text ? '\n\n' : ''}[Selected Command /${commandName}]\n${commandPrompt}` : text;
    let generationTimedOut = false;
    let generationTimeout: ReturnType<typeof setTimeout> | null = null;
    const startGenerationTimeout = () => {
      generationTimeout = setTimeout(() => {
        generationTimedOut = true;
        controller.abort('모델 응답이 8분 안에 완료되지 않아 생성을 중단했습니다.');
      }, GENERATION_TIMEOUT_MS);
    };
    // A turn is one user/assistant exchange. Counting every message made the
    // persisted index advance by two and made a branch continue at a seemingly
    // unrelated number. Rerolls must retain the turn they replace; a new user
    // message advances from the greatest persisted logical turn.
    const turnIndex = rerollTarget
      ? rerollTarget.turn_index
      : Math.max(0, ...baseMessages.filter((message) => !message.is_hidden).map((message) => message.turn_index)) + 1;
    let partialText = '';
    let lastPaint = 0;
    let draftMessageId: string | null = null;
    let startAttempted = false;
    let completionForRecovery: ResponseCommit | null = null;
    let retainedOnDisk = false;
    const draftWriter = createDraftWriter(async text => {
      if (!draftMessageId) return;
      const { error } = await supabase.from('messages').update({ content: text }).eq('id', draftMessageId);
      if (error) throw error;
    }, DRAFT_SAVE_INTERVAL_MS);
    const onChunk = (t: string) => {
      partialText = t;
      if (sessionId) publishGeneration(sessionId, t);
      const nowMs = performance.now();
      if (nowMs - lastPaint >= 50) { lastPaint = nowMs; setStreamingContent(t); }
      if (draftMessageId) draftWriter.push(t);
    };

    if (!session || !profile) { releaseSend(); return; }
    const prepared = await themePreparation;
    if (prepared.error || !prepared.value) {
      if (!controller.signal.aborted) reportSendError(prepared.label + ': ' + describeUnknownError(prepared.error));
      controller.abort();
      restoreSubmitted();
      releaseSend();
      return;
    }
    const { liveTheme, workCombination } = prepared.value;

    // A reroll re-sends the original user turn as the latest message, so remove
    // that same row from history to avoid sending it twice.
    const historySource = rerollUserMessage
      ? baseMessages.filter((message) => message.id !== rerollUserMessage.id)
      : baseMessages;
    const historyMsgs = buildHistory(historySource, effectiveSummaryTurn);
    const promptCache = resolvePromptCache(session.prompt_cache_enabled ?? false, model,
      session.prompt_cache_message_id ?? null, historyMsgs, session.prompt_cache_auto_latest ?? false);
    if (promptCache.unavailable) showToast('선택한 캐시 기준 답변이 이번 문맥에 없어 명시적 캐시 없이 전송합니다.');
    try {
    const assembled = assemblePrompt({
      autoThemeEnabled:automaticThemeEnabled(liveTheme.session,liveTheme.themes,liveTheme.dayNight,!!liveTheme.scope),dayNightThemeNames:liveTheme.names,themePrompt,themeCatalog:themeCatalogPrompt(liveTheme.themes,liveTheme.dayNight,liveTheme.scope),
      systemPrompt, mainPrompt: work.main_prompt, workCombination, userNote: session.user_note,
      summary: effectiveSummary, storyNotes: storyNotes.map((note) => note.content), persona,
      plugins: session.active_plugins,
      keywordBookContents: getActiveKeywordContents(baseMessages.filter(message => message.id !== rerollUserMessage?.id), promptText),
      history: historyMsgs.map((m) => ({ role: m.role, content: m.content,
        ...(m.id === promptCache.messageId && { cacheBreakpoint: true }) })),
      latestUserMessage: promptText,
    });
    const maxOutputTokens = session.output_settings_override_enabled ? session.output_tokens_override : profile.default_output_tokens;
      timing.mark('prompt');
      startAttempted = true;
      const claimed = await beginResponse({
        target_session: session.id, response_id: crypto.randomUUID(),
        user_message_id: !options?.reroll && (text || commandPrompt) ? crypto.randomUUID() : null,
        user_text: text, user_command_id: submittedCommand?.id ?? null, user_command_name: submittedCommand?.name ?? null,
        user_command_prompt: submittedCommand?.prompt.trim() ?? null,
        expected_context_hash: contextHash,
        source_versions: contextHash ? [] : completeMessages.map(message => ({ id: message.id, version: message.content_version ?? 0, active: message.is_active_variant !== false })),
        expected_summary: contextSummary, expected_summary_turn: contextSummaryTurn,
        reroll_message: rerollTarget?.id ?? null, requested_turn: turnIndex, requested_variant: rerollIndex,
      });
      const draft = claimed.draft;
      timing.mark('start-save');
      draftMessageId = draft.id;
      if (claimed.userMessage) {
        setMessages(current => [...current.filter(message => message.id !== claimed.userMessage!.id), claimed.userMessage!]);
        const count = completeMessages.filter(message => message.role === 'user' && !message.is_hidden && message.is_active_variant !== false).length + 1;
        setTotalUserTurnCount(count);
        cacheSessionCount(queryClient, session.user_id, session.id, count);
      }
      if (draft.generation_status !== 'streaming') { await loadLatestMessages(); sendCompleted = draft.generation_status === 'complete'; return; }
      if (controller.signal.aborted) throw new DOMException('생성을 중단했습니다.', 'AbortError');
      themeRequestScopeRef.current={messageId:draft.id,scope:workThemeScopeKey(liveTheme.session)};
      startGenerationTimeout();
      const result = await generate(provider, { apiKey, model, sessionId: session.id, reasoning, sampling, systemParts: assembled.systemParts, messages: assembled.messages, cacheSystemOnly: promptCache.systemOnly, maxOutputTokens, onChunk, onPhase: phase => timing.mark(phase), signal: controller.signal });
      await draftWriter.stop();
      completionForRecovery = {
        target_session: session.id, target_message: draftMessageId, response_text: result.text,
        in_tokens: result.usage.inputTokens, out_tokens: result.usage.outputTokens, response_cost: result.usage.cost,
        read_tokens: result.usage.cacheReadTokens, write_tokens: result.usage.cacheCreationTokens,
        target_group: rerollGroupId, previous_message: rerollTarget?.id ?? null,
        previous_summary: contextSummary, previous_summary_turn: contextSummaryTurn,
        restored_summary: rerollVersionIds ? effectiveSummary : null,
        restored_summary_turn: rerollVersionIds ? effectiveSummaryTurn : null,
        restored_versions: rerollVersionIds,
      };
      retainedOnDisk = retainResponse(session.user_id, completionForRecovery);
      const committed = await commitResponse(completionForRecovery);
      applyCommittedResponse(committed);
      if (committed.contextConflict) {
        setPendingSave(completionForRecovery);
        reportSendError('생성 도중 대화가 바뀌어 답변을 중단본으로 보관했습니다. 보관한 답변을 확인해 주세요.');
        return;
      }
      forgetResponse(session.user_id, completionForRecovery);
      setPendingSave(null);
      timing.mark('save');
      sendCompleted = true;
      const aiMsg = committed.message as Message;
      setCacheDiagnostics(current => ({ ...current, [aiMsg.id]: result.cacheDiagnostic }));
      setSession(current => current?.id === session.id ? { ...current, ...committed.session } : current);
    } catch (err) {
      if (completionForRecovery) {
        setPendingSave(completionForRecovery);
        reportSendError(`답변 저장을 확인하지 못했습니다. ${retainedOnDisk ? '답변은 이 기기에 보관했습니다.' : '브라우저 보관 공간을 사용할 수 없어 현재 화면에만 남아 있어요. TXT로 보관해 주세요.'} ${describeUnknownError(err)}`);
        return;
      }
      if (!draftMessageId) restoreSubmitted();
      const isAbort = controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError');
      if (draftMessageId) {
        await draftWriter.stop();
        const interrupted: ResponseCommit = {
          interrupted: true, target_session: session.id, target_message: draftMessageId, response_text: partialText,
          in_tokens: 0, out_tokens: 0, response_cost: 0, read_tokens: null, write_tokens: null,
          target_group: rerollGroupId, previous_message: rerollTarget?.id ?? null,
          previous_summary: contextSummary, previous_summary_turn: contextSummaryTurn,
          restored_summary: null, restored_summary_turn: null, restored_versions: null,
        };
        // Retain even partial output before the last network write.
        const durable = retainResponse(session.user_id, interrupted);
        setPendingSave(interrupted);
        try {
          const saved = await commitResponse(interrupted);
          applyCommittedResponse(saved);
          if (saved.contextConflict) reportSendError('생성 중 대화가 바뀌어 중단본으로 보관했습니다. 보관한 답변을 확인해 주세요.');
          else { forgetResponse(session.user_id, interrupted); setPendingSave(null); }
          if (generationTimedOut) reportSendError('모델 응답이 8분 안에 완료되지 않아 수신한 내용까지만 저장했습니다.');
          else if (!isAbort) reportSendError(partialText ? '연결이 중단되어 수신한 내용까지만 저장했습니다: ' + describeUnknownError(err) : 'AI 응답 생성에 실패했습니다: ' + describeUnknownError(err));
        } catch (saveError) {
          reportSendError(`수신한 답변의 저장을 확인하지 못했습니다. ${durable ? '이 기기 사본을 보관했습니다.' : '화면을 닫기 전에 TXT로 보관해 주세요.'} ${describeUnknownError(saveError)}`);
        }
      } else if (!isAbort) reportSendError(describeUnknownError(err));
    } finally {
      await draftWriter.stop();
      if (generationTimeout) clearTimeout(generationTimeout);
      // The user turn exists even when the model or final save failed.
      if (startAttempted) {
        void queryClient.invalidateQueries({ queryKey: ['session-counts', session.user_id] });
        void queryClient.invalidateQueries({ queryKey: ['sessions', session.user_id] });
      }
      releaseSend();
    }
  }

  async function deleteMsg(msgId: string) {
    const target = messages.find(message => message.id === msgId);
    if (!contextReady || !target || deleteInFlightRef.current || sendInFlightRef.current || editInFlightRef.current || branchInFlightRef.current || summaryGenerating || workCombinationSavingRef.current) return;
    deleteInFlightRef.current = true;
    try {
      if (!await showConfirmDialog('이 메시지를 삭제할까요?', '삭제한 메시지는 복구할 수 없습니다.', '삭제')) return;
      setDeletingMessageId(msgId);
      messageReadControllerRef.current.abort();
      messageReadControllerRef.current = new AbortController();
      appliedReadSequenceRef.current = ++latestReadSequenceRef.current;
      const result = await mutateMessage(target, null);
      setSession(current => current?.id === result.session.id ? { ...current, ...result.session } : current);
      setMessages(current => orderMessagesByTurn([...current.filter(message => message.id !== msgId && message.id !== result.replacement?.id), ...(result.replacement ? [result.replacement] : [])]));
      if (target.role === 'user' && !target.is_hidden && target.is_active_variant) {
        const count = Math.max(0, totalUserTurnCount - 1);
        setTotalUserTurnCount(count);
        cacheSessionCount(queryClient, session!.user_id, target.session_id, count);
      }
      void queryClient.invalidateQueries({ queryKey: ['session-counts', user?.id] });
      showToast('메시지를 삭제했습니다.');
    } catch (error) { addError(`메시지 삭제 실패: ${describeUnknownError(error)}`); }
    finally { setDeletingMessageId(null); deleteInFlightRef.current = false; }
  }

  async function saveEdit(msgId: string) {
    const content = editingContent.trim();
    if (!contextReady || !content || sendInFlightRef.current || editInFlightRef.current || deleteInFlightRef.current || branchInFlightRef.current || summaryGenerating || workCombinationSavingRef.current) return;
    const original = messages.find((message) => message.id === msgId);
    if (!original) { addError('메시지 편집 실패: 편집할 메시지를 찾지 못했습니다.'); return; }
    const commandId = editingCommandName ? original.command_id ?? null : null;
    editInFlightRef.current = true;
    setEditingSavingId(msgId);
    try {
      messageReadControllerRef.current.abort();
      messageReadControllerRef.current = new AbortController();
      appliedReadSequenceRef.current = ++latestReadSequenceRef.current;
      const result = await mutateMessage(original, { content, command_id: commandId, command_name: editingCommandName });
      setMessages(current => current.map(message => message.id === msgId ? { ...message, ...result.message! } : message));
      setSession(current => current?.id === result.session.id ? { ...current, ...result.session } : current);
      setEditingId(null);
    } catch (error) {
      addError(`메시지 편집 실패: ${describeUnknownError(error)}`);
    } finally {
      editInFlightRef.current = false;
      setEditingSavingId(null);
    }
  }

  async function branchFrom(message: Message) {
    if (workCombinationSavingRef.current) { showToast('작품 결합 설정을 저장한 뒤 분기해 주세요.'); return; }
    if (!contextReady || !session || !user || sendInFlightRef.current || editInFlightRef.current || deleteInFlightRef.current || branchInFlightRef.current || summaryGenerating) return;
    branchInFlightRef.current = true;
    const routeSignal = messageReadControllerRef.current.signal;
    try {
      if (!await showConfirmDialog('새 채팅방으로 분기할까요?', '이 메시지 시점까지의 대화로 새 채팅방을 만듭니다.', '분기')) return;
      if (routeSignal.aborted) return;
      const id = await branchSession(message);
      showToast('새 채팅방으로 분기했습니다.');
      void queryClient.invalidateQueries({ queryKey: ['sessions', user.id] });
      if (!routeSignal.aborted) navigate(`/chat/${id}`);
    } catch (error) { if (!routeSignal.aborted) addError('분기 채팅방 생성 실패: ' + describeUnknownError(error)); }
    finally { branchInFlightRef.current = false; }
  }

  async function selectVariant(message: Message, id: string) {
    if (!contextReady || !session || sendInFlightRef.current || editInFlightRef.current || deleteInFlightRef.current || branchInFlightRef.current || summaryGenerating || workCombinationSavingRef.current) return;
    editInFlightRef.current = true;
    setSelectingVariantId(id);
    try {
      const groupId = message.reroll_group_id ?? message.id;
      const group = variantsFor(message);
      const groupIds = group.map(item => item.id);
      if (!groupIds.includes(id)) throw new Error('선택할 응답 버전을 찾을 수 없습니다.');
      messageReadControllerRef.current.abort();
      messageReadControllerRef.current = new AbortController();
      appliedReadSequenceRef.current = ++latestReadSequenceRef.current;
      const updated = await selectResponse(session.id, groupId, id, group.find(item => item.is_active_variant)?.id);
      setSession(current => current?.id === updated.session.id ? { ...current, ...updated.session } : current);
      setMessages(current => orderMessagesByTurn([
        ...current.filter(item => item.role !== 'assistant' || (item.reroll_group_id ?? item.id) !== groupId),
        ...updated.messages,
      ]));
    } catch (error) { addError('응답 버전 변경 실패: ' + describeUnknownError(error)); }
    finally { editInFlightRef.current = false; setSelectingVariantId(null); }
  }

  function variantsFor(message: Message) {
    const groupId = message.reroll_group_id ?? message.id;
    return messages
      .filter((item) => item.role === 'assistant' && (item.reroll_group_id ?? item.id) === groupId)
      .sort((a, b) => (a.reroll_index ?? 1) - (b.reroll_index ?? 1));
  }

  async function exportConversation() {
    if (!session || sending || exportInFlightRef.current) return;
    exportInFlightRef.current = true;
    setExportingConversation(true);
    try {
      await recoverExpiredResponses(session.id);
      const allMessages = await fetchAllSessionMessages(session.id);
      if (allMessages.some((message) => !message.is_hidden && message.is_active_variant !== false && message.generation_status === 'streaming')) {
        showToast('응답 생성이 끝난 뒤 추출해 주세요.');
        return;
      }
      const content = formatConversationText(orderMessagesByTurn(allMessages));
      if (!content) {
        showToast('추출할 대화가 없습니다.');
        return;
      }
      downloadConversationText(content, conversationFilename(session.title || work?.title || '대화'));
    } catch (error) {
      addError(`대화 추출 실패: ${describeUnknownError(error)}`);
    } finally {
      exportInFlightRef.current = false;
      setExportingConversation(false);
    }
  }

  const currentSession = session;

  const hasLocalGeneration = !!sessionId && activeGenerations.has(sessionId);
  const displayableMessages = messages.filter((m) => !(hasLocalGeneration && m.generation_status === 'streaming') && m.is_active_variant !== false && (!m.is_hidden || debugMode));
  const hasOlderDisplayMessages = hasOlderServerMessages;
  const visibleMessages = displayableMessages;
  const assistantTurnNumbers = new Map<string, number>();
  const loadedActiveUserTurns = messages.filter((message) => message.role === 'user' && !message.is_hidden && message.is_active_variant !== false).length;
  let countedUserTurns = Math.max(0, totalUserTurnCount - loadedActiveUserTurns);
  for (const message of messages.filter((item) => item.is_active_variant !== false)) {
    if (message.role === 'user' && !message.is_hidden) countedUserTurns += 1;
    if (message.role === 'assistant') assistantTurnNumbers.set(message.id, countedUserTurns);
  }
  const sessionTurnCount = totalUserTurnCount;

  if (loadError) return <div role="alert" className="p-6 text-amber-400">채팅방을 불러오지 못했습니다: {loadError}<button type="button" className="ml-3 underline" onClick={() => setLoadAttempt(attempt => attempt + 1)}>다시 불러오기</button><button type="button" className="ml-3 underline" onClick={() => navigate('/sessions')}>채팅방 목록</button></div>;

  if (!currentSession || !work) {
    return <div className="flex h-full items-center justify-center text-slate-400">불러오는 중…</div>;
  }

  return (
    <div className="chat-page mx-auto flex h-full min-h-0 max-w-app flex-col bg-bg">
      <header className="chat-header flex items-center gap-2 border-b border-surface2 px-3 py-2.5">
        <button onClick={() => navigate('/sessions')} aria-label="채팅방 목록으로" className="text-slate-400"><InterfaceIcon name="back" /></button>
        <button onClick={() => navigate(`/works/${work.id}`)} className="min-w-0 flex-1 text-left">
          <p className="truncate text-sm font-semibold text-white">{currentSession.title || work.title}</p>
        </button>
        <button disabled={!contextReady} onClick={() => setMenuOpen(true)} aria-label="세션 메뉴 열기" className="px-2 text-xl text-slate-300"><InterfaceIcon name="menu" /></button>
      </header>

      {!contextReady && <div role="status" aria-label="대화 설정 상태" className="shrink-0 border-b border-surface2 px-3 py-2 text-xs text-slate-400">
        {contextError ? <><p>대화는 읽을 수 있어요. 전송에 필요한 설정을 불러오지 못했습니다: {contextError}</p><button type="button" onClick={() => void retryChatContext()} className="mt-1 underline">설정 다시 불러오기</button><button type="button" disabled={exportingConversation || sending} onClick={() => void exportConversation()} className="ml-3 underline disabled:opacity-50">대화 TXT 추출</button></> : '대화 설정을 불러오는 중이에요. 완료되면 전송할 수 있어요.'}
      </div>}
      {pendingSave && <section role="alert" aria-label="보관한 답변" className="shrink-0 border-b border-surface2 bg-surface px-3 py-2 text-xs text-amber-300">
        <p>저장을 확인할 답변이 있어요. 같은 답변의 저장만 다시 시도하며 AI를 다시 호출하지 않아요.</p>
        <details className="mt-1"><summary>보관한 답변 보기</summary><textarea readOnly value={pendingSave.response_text} aria-label="보관한 답변 내용" rows={4} className="mt-1 w-full bg-bg p-2 text-slate-200" /></details>
        <div className="mt-2 flex flex-wrap gap-3">
          <button type="button" disabled={recoveringSave || sending} onClick={() => void retryPendingSave()} className="underline disabled:opacity-50">{recoveringSave ? '저장 확인 중…' : '저장 다시 확인'}</button>
          <button type="button" onClick={() => downloadConversationText(pendingSave.response_text, conversationFilename((currentSession.title || work.title) + '_보관한_답변'))} className="underline">답변 TXT 보관</button>
          <button type="button" disabled={recoveringSave || sending} onClick={() => void discardPendingSave()} className="underline disabled:opacity-50">이 기기 사본 지우기</button>
        </div>
      </section>}
      {toastError && (
        <div className="toast-enter pointer-events-none fixed inset-x-0 top-6 z-50 flex justify-center px-4">
          <div className="max-w-[88vw] rounded-full bg-red-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg">
            {toastError}
          </div>
        </div>
      )}
      <div ref={scrollRef} onScroll={(event) => {
        const element = event.currentTarget;
        rememberScroll();
        if (element.scrollTop <= 80) revealOlderMessages();
      }} className="chat-scroll w-full min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-4 [overflow-anchor:none]">
        {visibleMessages.length === 0 && (
          <p className="mt-8 text-center text-sm text-slate-500">메시지를 입력해 시작하세요.</p>
        )}
        <div className="chat-message-list flex w-full flex-col gap-3">
          {hasOlderDisplayMessages && (
            <div ref={olderMessagesSentinelRef} className="py-1 text-center text-xs text-slate-500" aria-live="polite">
              <button type="button" onClick={revealOlderMessages} disabled={loadingOlderMessages} className="disabled:opacity-60">
                {loadingOlderMessages ? '이전 대화를 불러오는 중…' : '위로 스크롤하거나 눌러서 이전 대화를 불러오세요'}
              </button>
            </div>
          )}
          {visibleMessages.map((m, index) => (
            <div key={m.id} data-role={m.role} data-scroll-anchor={m.id} className="chat-message flex w-full min-w-0 flex-col gap-1">
              {index > 0 && (
                <hr className="chat-turn-divider" aria-label="메시지 구분" />
              )}
              {m.is_hidden && debugMode && (
                <p className="text-[10px] text-amber-400"><InterfaceIcon name="search" /> 숨김 메시지</p>
              )}
              {editingId === m.id ? (
                <div className="flex w-full flex-col gap-1.5">
                  <textarea
                    value={editingContent}
                    onChange={(e) => setEditingContent(e.target.value)}
                    rows={Math.max(3, editingContent.split('\n').reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / 36)), 0))}
                    ref={focusEditor}
                    className={`w-full resize-none overflow-hidden rounded-2xl px-4 py-3 text-sm text-slate-100 outline-none ${editingCommandName ? 'border-2 border-indigo-500 bg-indigo-500/10' : 'bg-surface'}`}
                  />
                  <div className="flex items-center justify-end gap-2">
                    {editingCommandName && <button onClick={() => setEditingCommandName(null)} className="mr-auto rounded-lg border border-indigo-400/60 bg-indigo-500/15 px-3 py-1.5 text-xs font-semibold text-indigo-300" aria-label={`/${editingCommandName} 명령어 제거`}>×　/{editingCommandName}</button>}
                    <button disabled={editingSavingId === m.id} onClick={() => setEditingId(null)} className="rounded-lg bg-surface2 px-3 py-1.5 text-xs text-slate-300 disabled:opacity-50">취소</button>
                    <button disabled={sending || editingSavingId === m.id} onClick={() => saveEdit(m.id)} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">{editingSavingId === m.id ? '저장 중…' : '저장'}</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className={`chat-message-body w-full min-w-0 overflow-hidden break-words [overflow-wrap:anywhere] px-4 py-2.5 text-sm leading-relaxed ${m.role === 'user' || m.is_hidden ? 'rounded-2xl' : ''} ${
                    m.is_hidden
                      ? 'border border-amber-500/40 bg-surface text-amber-200'
                      : m.role === 'user' && m.command_name
                        ? 'border-l-4 border-indigo-500 bg-indigo-500/15 text-slate-100 ring-1 ring-inset ring-indigo-400/25'
                      : m.role === 'user'
                        ? 'bg-brand text-white'
                        : m.generation_status === 'interrupted' && !m.content
                          ? 'text-slate-500'
                          : 'text-slate-100'
                  }`}>
                    <SpoilerBoundary key={`${m.id}:${showOffMode}`} concealed={showOffMode && m.role === 'user'}>
                      {m.role === 'user' && m.command_name && <p className="mb-2 font-bold text-indigo-400">/{m.command_name}</p>}
                      <MessageContent content={m.content} role={m.role} status={m.generation_status} showImages={showImages} />
                    </SpoilerBoundary>
                  </div>
                  {m.role === 'assistant' && m.generation_status === 'interrupted' && m.content && (
                    <p className="text-xs text-amber-400">응답이 중간에 중단되어 수신한 내용까지만 저장되었습니다.</p>
                  )}
                  {debugMode && m.role === 'assistant' && cacheDiagnostics[m.id] && <CacheDiagnosticPanel diagnostic={cacheDiagnostics[m.id]} />}
                  {!m.is_hidden && (
                    <div className={`chat-message-actions flex min-w-0 items-center gap-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <button disabled={sending || !contextReady || summaryGenerating || !!deletingMessageId} onClick={() => { setEditingId(m.id); setEditingContent(m.content); setEditingCommandName(m.command_name); }} aria-label="메시지 편집" title="편집" className="chat-message-action text-slate-500 disabled:opacity-50"><InterfaceIcon name="edit" /></button>
                      <button onClick={() => void branchFrom(m)} aria-label="여기서 분기" title="분기" className="chat-message-action text-slate-500"><InterfaceIcon name="branch" /></button>
                      <button disabled={sending || !contextReady || summaryGenerating || !!editingSavingId || deletingMessageId === m.id} onClick={() => void deleteMsg(m.id)} aria-label="메시지 삭제" title="삭제" className="chat-message-action text-[#DA7F88] disabled:opacity-50"><InterfaceIcon name="delete" /></button>
                      {m.role === 'assistant' && <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-0.5">
                        {showCost && <span className="text-right text-[10px] text-slate-500"><span className={isTurnPriceWarning(m.cost, turnPriceWarning, exchange.rate) ? 'text-yellow-400' : undefined}>{showCostKrw ? formatKrw(m.cost, exchange.rate) : `$${m.cost.toFixed(6)}`}</span> {showCostKrw && exchange.fallback ? '(폴백 환율)' : ''} · 출력 {m.output_tokens.toLocaleString()} tokens</span>}
                        {showCacheTokens && <span className="text-right text-[10px] text-slate-500">캐시 읽기 {m.cache_read_tokens == null ? '미보고' : m.cache_read_tokens.toLocaleString()} · 쓰기 {m.cache_write_tokens == null ? '미보고' : m.cache_write_tokens.toLocaleString()}</span>}
                        {variantsFor(m).length > 1 && <select disabled={sending || !contextReady || summaryGenerating || !!editingSavingId || !!deletingMessageId || !!selectingVariantId} aria-label="리롤 답변 선택" value={m.id} onChange={(event) => void selectVariant(m, event.target.value)} className="max-w-28 bg-transparent text-xs text-slate-400 outline-none">{variantsFor(m).map((variant, index, variants) => <option key={variant.id} value={variant.id}>답변 비교 {index + 1}/{variants.length}</option>)}</select>}
                        <span className="text-[10px] font-medium text-slate-500">{assistantTurnNumbers.get(m.id) ?? 0}턴</span>
                        {m.id === [...visibleMessages].reverse().find((item) => item.role === 'assistant')?.id && <button onClick={() => void send({ reroll: true })} disabled={sending || !contextReady || summaryGenerating || !!editingSavingId || !!deletingMessageId} className="text-lg text-brand disabled:opacity-50" aria-label="다시 생성"><InterfaceIcon name="reroll" /></button>}
                      </div>}
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
          {sending && (
            <>
            {visibleMessages.length > 0 && <hr className="chat-turn-divider" aria-label="메시지 구분" />}
            <div data-scroll-anchor="streaming-response" className="chat-stream w-full min-w-0 max-w-full px-4 py-2.5 text-sm leading-relaxed text-slate-100">
              {streamingContent ? (
                <MessageContent content={streamingContent} role="assistant" status="streaming" showImages={showImages} />
              ) : (
                <span className="text-slate-400">생각 중…</span>
              )}
            </div>
            </>
          )}
        </div>
      </div>

      {selectedCommand && <div className="chat-command-banner flex shrink-0 items-center gap-2 border-t border-surface2 bg-brand/10 px-3 py-2 text-sm">
        <span className="font-semibold text-brand">/{selectedCommand.name}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-slate-400">{selectedCommand.description}</span>
        <button onClick={() => setSelectedCommand(null)} aria-label="선택한 명령어 해제" className="text-slate-500">×</button>
      </div>}
      <div className="chat-composer flex shrink-0 items-end gap-2 border-t border-surface2 p-2">
        <button onClick={() => setCommandMenuOpen(true)} aria-label="명령어 메뉴 열기" className={`chat-command-button flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg font-semibold ${selectedCommand ? 'bg-brand text-white' : 'bg-surface text-slate-400'}`}>/</button>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && shouldSubmitOnEnter()) { e.preventDefault(); void send(); } }}
          rows={1}
          aria-label="메시지 입력"
          placeholder="메시지 입력…"
          className="max-h-32 flex-1 resize-none rounded-2xl bg-surface px-4 py-2.5 text-sm outline-none"
        />
        {sending ? (
          <button
            aria-label="응답 생성 중단"
            onClick={() => (sessionId ? activeGenerations.get(sessionId)?.controller : abortControllerRef.current)?.abort('사용자가 응답 생성을 중단했습니다.')}
            className="chat-send-button rounded-full bg-red-500 px-4 py-2.5 text-sm font-semibold text-white"
          >
            중단
          </button>
        ) : (
          <button
          onClick={() => void send()}
            disabled={workCombinationSaving || !contextReady || !!editingSavingId || !!deletingMessageId || !!selectingVariantId || summaryGenerating}
            aria-label="메시지 전송"
            className="chat-send-button rounded-full bg-brand px-4 py-2.5 text-sm font-semibold text-white"
          >
            전송
          </button>
        )}
      </div>

      {commandMenuOpen && user && <CommandMenu userId={user.id} workId={work?.id} onClose={() => setCommandMenuOpen(false)} onSelect={setSelectedCommand} />}

      {menuOpen && session && contextReady && (
        <SessionMenu
          key={session.id}
          sending={sending || !!editingSavingId || !!deletingMessageId || !!selectingVariantId}
          session={session}
          profile={profile}
          onClose={() => setMenuOpen(false)}
          onUpdate={(patch) => setSession((s) => (s?.id === session.id ? { ...s, ...patch } : s))}
          onWorkCombinationSavingChange={onWorkCombinationSavingChange}
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
          showOffMode={showOffMode}
          onShowOffModeToggle={(v) => {
            setShowOffMode(v);
            try { localStorage.setItem('inuchat.showOffMode', v ? '1' : '0'); } catch { /* Keep the toggle usable when storage is unavailable. */ }
          }}
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
          onExportConversation={exportConversation}
          exportingConversation={exportingConversation}
          onGenerateSummary={(throughTurn) => generateSummary([], throughTurn)}
          onMergeSummaries={(versions) => generateSummary(versions, Math.max(0, ...versions.map(version => version.summarized_through_turn)))}
          summaryGenerating={summaryGenerating}
          storyNotes={storyNotes}
          onStoryNotesChange={setStoryNotes}
          sessionTurnCount={sessionTurnCount}
        />
      )}
    </div>
  );
}
