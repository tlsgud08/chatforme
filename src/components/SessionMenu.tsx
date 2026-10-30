import InterfaceIcon from './InterfaceIcon';
import MultichatApiSettings from './MultichatApiSettings';
import MultichatProgressSettings from './MultichatProgressSettings';
import type { MultichatMember, MultichatRoom } from '@/types/db';
import { useCallback, useEffect, useRef, useState } from 'react';
import SessionMenuFrame, { SessionMenuPage } from './SessionMenuFrame';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { mutateSummary } from '@/lib/sessionData';
import { getApiKey } from '@/lib/apiKeys';
import type { ReasoningSelection } from '@/lib/llm/types';
import ModelSelector from './ModelSelector';
import type { Persona, Profile, Session, StoryNote, SummaryVersion } from '@/types/db';
import type { ErrorEntry } from '@/pages/ChatPage';
import { formatKrw, type ExchangeRate } from '@/lib/exchangeRate';
import { showConfirmDialog } from '@/lib/dialog';
import { normalizeOutputTokens } from './OutputTokenSelector';
import OutputSettingsEditor, { type OutputSettingsValue } from './OutputSettingsEditor';
import PromptCacheSettings from './PromptCacheSettings';
import SessionPluginSettings from './SessionPluginSettings';
import SessionWorkCombinationSettings from './SessionWorkCombinationSettings';
import SessionThemeSettings from './SessionThemeSettings';
import Toggle from './Toggle';
import SessionInformationSettings from './SessionInformationSettings';
import SemiSessionSettings from './SemiSessionSettings';

interface OpenRouterCredit {
  usage: number;
  limit: number | null;
  remaining: number | null;
}

export interface MultichatMenuContext { room: MultichatRoom; members: MultichatMember[]; slot: 1 | 2; otherPresent: boolean; presenceReady: boolean; onRoomUpdate: (room: MultichatRoom) => void; onRefresh: () => Promise<void>; }

interface Props {
  multichat?: MultichatMenuContext;
  session: Session;
  profile: Profile | null;
  onClose: () => void;
  onUpdate: (patch: Partial<Session>) => void;
  onPersonaChange: (persona: Persona | null) => void;
  debugMode: boolean;
  onDebugToggle: (v: boolean) => void;
  showCost: boolean;
  onShowCostToggle: (v: boolean) => void;
  showCostKrw: boolean;
  onShowCostKrwToggle: (v: boolean) => void;
  showCacheTokens: boolean;
  onShowCacheTokensToggle: (v: boolean) => void;
  showImages: boolean;
  onShowImagesToggle: (v: boolean) => void;
  showOffMode: boolean;
  onShowOffModeToggle: (v: boolean) => void;
  exchange: ExchangeRate;
  sessionModel: string;
  onModelChange: (m: string) => void;
  sessionReasoning: ReasoningSelection;
  onReasoningChange: (reasoning: ReasoningSelection) => void;
  errorLog: ErrorEntry[];
  onClearErrors: () => void;
  onExportConversation: () => Promise<void>;
  exportingConversation: boolean;
  onGenerateSummary: (throughTurn?: number) => Promise<void>;
  onMergeSummaries: (versions: SummaryVersion[]) => Promise<void>;
  summaryGenerating: boolean;
  storyNotes: StoryNote[];
  onStoryNotesChange: (notes: StoryNote[]) => void;
  sessionTurnCount: number;
  sending: boolean;
  onWorkCombinationSavingChange: (saving: boolean) => boolean;
  onPublishSemiSummary?: (linkId: string) => Promise<boolean>;
}

export default function SessionMenu({
  session, profile, onClose, onUpdate, onPersonaChange, multichat,
  debugMode, onDebugToggle, showCost, onShowCostToggle, showCostKrw, onShowCostKrwToggle,
  showCacheTokens, onShowCacheTokensToggle, exchange,
  showImages, onShowImagesToggle,
  showOffMode, onShowOffModeToggle,
  sessionModel, onModelChange, sessionReasoning, onReasoningChange,
  errorLog, onClearErrors, onExportConversation, exportingConversation,
  onGenerateSummary, onMergeSummaries, summaryGenerating, storyNotes, onStoryNotesChange, sessionTurnCount, sending, onWorkCombinationSavingChange, onPublishSemiSummary,
}: Props) {
  const { user, isAdmin } = useAuth();
  const [note, setNote] = useState(session.user_note);
  const [credit, setCredit] = useState<OpenRouterCredit | null>(null);
  const [creditLoading, setCreditLoading] = useState(false);

  useEffect(() => {
    setCredit(null);
    const apiKey = getApiKey('openrouter');
    if (!apiKey) return;
    setCreditLoading(true);
    // /credits = 계정 실제 잔액 (total_credits - total_usage)
    fetch('https://openrouter.ai/api/v1/credits', {
      headers: { authorization: `Bearer ${apiKey}` },
    })
      .then((r) => r.json())
      .then((data) => {
        const d = data?.data;
        if (!d) return;
        const total = d.total_credits ?? 0;
        const used = d.total_usage ?? 0;
        setCredit({
          usage: used,
          limit: total,
          remaining: total - used,
        });
      })
      .catch(() => {})
      .finally(() => setCreditLoading(false));
  }, []);
  const inheritedTokens = normalizeOutputTokens(profile?.default_output_tokens ?? null);
  const [outputSettings, setOutputSettings] = useState<OutputSettingsValue>(() => ({
    outputTokens: normalizeOutputTokens(session.output_settings_override_enabled ? session.output_tokens_override : profile?.default_output_tokens ?? null),
    reasoning: (session.output_settings_override_enabled ? session.reasoning_override : null) ?? profile?.default_reasoning ?? { ...sessionReasoning, send: profile?.default_reasoning_enabled ?? true },
    temperature: (session.output_settings_override_enabled ? session.temperature_override : null) ?? profile?.default_temperature ?? 1,
    temperatureSend: (session.output_settings_override_enabled ? session.temperature_enabled_override : null) ?? profile?.default_temperature_enabled ?? false,
    frequencyPenalty: (session.output_settings_override_enabled ? session.frequency_penalty_override : null) ?? profile?.default_frequency_penalty ?? 0,
    frequencyPenaltySend: (session.output_settings_override_enabled ? session.frequency_penalty_enabled_override : null) ?? profile?.default_frequency_penalty_enabled ?? false,
  }));
  const [hasExplicitOverride, setHasExplicitOverride] = useState(session.output_settings_override_enabled ?? session.output_tokens_override !== null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [savedMsg, setSavedMsg] = useState('');
  const [logOpen, setLogOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summaryVersions, setSummaryVersions] = useState<SummaryVersion[]>([]);
  const [editingSummary, setEditingSummary] = useState<string | null>(null);
  const [summaryDraft, setSummaryDraft] = useState('');
  const [selectedSummaryIds, setSelectedSummaryIds] = useState<string[]>([]);
  const [storyNoteDraft, setStoryNoteDraft] = useState('');
  const [summaryThroughTurn, setSummaryThroughTurn] = useState<number | ''>('');
  const [activeTab, setActiveTab] = useState('chat');
  const [activeSemiSession, setActiveSemiSession] = useState<string | null>(null);
  const semiActive = activeSemiSession === session.id;
  const handleSemiActiveChange = useCallback((active: boolean) => {
    setActiveSemiSession(active ? session.id : null);
  }, [session.id]);
  const [noteSaving, setNoteSaving] = useState(false);
  const scrollRef = useRef<HTMLElement>(null);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = 0; }, [activeTab]);

  useEffect(() => {
    if (!user) return;
    supabase
      .from('personas')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at')
      .then(({ data }) => setPersonas((data as Persona[]) ?? []));
  }, [user]);

  async function saveNote() {
    if (noteSaving) return;
    setNoteSaving(true);
    const { error } = multichat ? await supabase.rpc('set_multichat_note', { target_room: session.id, note }) : await supabase.from('sessions').update({ user_note: note }).eq('id', session.id);
    setNoteSaving(false);
    if (error) { flash('유저 노트 저장 실패: ' + error.message); return; }
    if (multichat) await multichat.onRefresh(); else onUpdate({ user_note: note });
    flash('유저 노트를 저장했습니다.');
  }

  async function saveOverride() {
    const patch = {
      output_tokens_override: outputSettings.outputTokens,
      output_settings_override_enabled: true,
      reasoning_override: outputSettings.reasoning,
      temperature_override: outputSettings.temperature,
      temperature_enabled_override: outputSettings.temperatureSend,
      frequency_penalty_override: outputSettings.frequencyPenalty,
      frequency_penalty_enabled_override: outputSettings.frequencyPenaltySend,
    };
    const { error } = await supabase.from('sessions').update(patch).eq('id', session.id);
    if (error) { flash(`출력 설정 저장 실패: ${error.message}`); return; }
    setHasExplicitOverride(true);
    onReasoningChange(outputSettings.reasoning);
    onUpdate(patch);
    flash('출력 설정을 저장했습니다.');
  }

  async function resetOverride() {
    const patch = { output_settings_override_enabled: false, output_tokens_override: null, reasoning_override: null, temperature_override: null, temperature_enabled_override: null, frequency_penalty_override: null, frequency_penalty_enabled_override: null };
    const { error } = await supabase.from('sessions').update(patch).eq('id', session.id);
    if (error) { flash(`출력량 초기화 실패: ${error.message}`); return; }
    setOutputSettings({
      outputTokens: inheritedTokens,
      reasoning: profile?.default_reasoning ?? { ...sessionReasoning, send: profile?.default_reasoning_enabled ?? true },
      temperature: profile?.default_temperature ?? 1,
      temperatureSend: profile?.default_temperature_enabled ?? false,
      frequencyPenalty: profile?.default_frequency_penalty ?? 0,
      frequencyPenaltySend: profile?.default_frequency_penalty_enabled ?? false,
    });
    setHasExplicitOverride(false);
    onReasoningChange(profile?.default_reasoning ?? { ...sessionReasoning, send: profile?.default_reasoning_enabled ?? true });
    onUpdate(patch);
  }

  async function selectPersona(persona: Persona | null) {
    const pid = persona?.id ?? null;
    const { error } = multichat ? await supabase.rpc('set_multichat_persona', { target_room: session.id, target_persona: pid }) : await supabase.from('sessions').update({ persona_id: pid }).eq('id', session.id);
    if (error) { flash(`페르소나 변경 실패: ${error.message}`); return; }
    if (multichat) await multichat.onRefresh(); else onUpdate({ persona_id: pid });
    onPersonaChange(persona);
  }

  async function loadSummaries() {
    const { data } = await supabase.from('summary_versions').select('*').eq('session_id', session.id).order('created_at', { ascending: false });
    const versions = (data as SummaryVersion[]) ?? [];
    setSummaryVersions(versions);
    setSelectedSummaryIds(versions.filter((version) => version.is_active).map((version) => version.id));
  }

  async function openSummaries() {
    await loadSummaries();
    setSummaryOpen(true);
  }

  const summarySaveLock = useRef(false);
  async function commitSummary(operation: 'edit' | 'delete' | 'select', versionId: string | null = null, content: string | null = null) {
    if (summarySaveLock.current || sending || summaryGenerating) return false;
    summarySaveLock.current = true;
    try {
      let updated: Session;
      if (multichat) {
        const { data, error } = await supabase.rpc('mutate_multichat_summary', { target_room: session.id, operation, target_version: versionId, summary_text: content, selected_ids: selectedSummaryIds });
        if (error || !data) throw error ?? new Error('메모리 저장 실패');
        updated = data as Session;
      } else updated = await mutateSummary(session.id, operation, versionId, content, selectedSummaryIds);
      onUpdate(updated);
      await loadSummaries();
      return true;
    } catch (error) {
      flash('요약 저장 실패: ' + (error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)));
      return false;
    } finally { summarySaveLock.current = false; }
  }

  async function saveSummary(version: SummaryVersion) {
    const content = summaryDraft.trim();
    if (!content) return;
    if (await commitSummary('edit', version.id, content)) { setEditingSummary(null); flash('요약 노트를 수정했습니다.'); }
  }

  async function saveSummarySettings(patch: Partial<Session>) {
    const { error } = await supabase.from('sessions').update(patch).eq('id', session.id);
    if (error) { flash('요약 설정 저장 실패: ' + error.message); return; }
    onUpdate(patch);
  }

  async function applySelectedSummaries() {
    if (await commitSummary('select')) flash('선택한 요약 노트를 채팅에 반영했습니다.');
  }

  async function deleteSummary(version: SummaryVersion) {
    if (!await showConfirmDialog('이 요약 노트를 삭제할까요?', '삭제한 요약 노트는 복구할 수 없습니다.', '삭제')) return;
    if (await commitSummary('delete', version.id)) flash('요약 노트를 삭제했습니다.');
  }

  async function addStoryNote() {
    const content = storyNoteDraft.trim();
    if (!content) return;
    const { data, error } = await supabase.from('story_notes').insert({ session_id: session.id, content }).select('*').single();
    if (error) { flash(error.message); return; }
    onStoryNotesChange([...storyNotes, data as StoryNote]);
    setStoryNoteDraft('');
  }

  async function deleteStoryNote(id: string) {
    const { error } = await supabase.from('story_notes').delete().eq('id', id);
    if (error) { flash(error.message); return; }
    onStoryNotesChange(storyNotes.filter((note) => note.id !== id));
  }

  function flash(m: string) {
    setSavedMsg(m);
    setTimeout(() => setSavedMsg(''), 1500);
  }

  const outputLabel = outputSettings.outputTokens === null ? '무제한' : `${outputSettings.outputTokens.toLocaleString()} 토큰`;
  const reasoningLabel = outputSettings.reasoning.send === false ? '추론 미전송' : `추론 ${{ off: 'Off', low: '낮음', medium: '중간', high: '높음' }[outputSettings.reasoning.effort ?? 'medium'] ?? outputSettings.reasoning.effort}`;
  const tabs = [{ id: 'chat', label: '대화' }, { id: 'ai', label: 'AI 설정' }, { id: 'memory', label: '메모리' }, { id: 'display', label: '표시' }];
  // Keep the same keyed instance when moving so open previews and drafts survive.
  const semiSettings = !multichat && user && onPublishSemiSummary
    ? <SemiSessionSettings key={`semi:${session.id}`} sessionId={session.id} userId={user.id} busy={sending || summaryGenerating} onPublish={onPublishSemiSummary} onSavingChange={onWorkCombinationSavingChange} onActiveChange={handleSemiActiveChange} />
    : null;

  return <SessionMenuFrame subtitle={`${session.title || '채팅방'} · ${sessionTurnCount}턴`} onClose={onClose}>
    <details className="inu-credit">
      <summary><div><span className="inu-caption">OpenRouter 잔여 크레딧</span>
        {!getApiKey('openrouter') ? <p className="inu-help">API 키를 설정하면 잔여 크레딧을 확인할 수 있습니다.</p>
          : creditLoading ? <p className="inu-help">불러오는 중…</p>
          : credit ? <strong>{credit.remaining === null ? '무제한' : `$${credit.remaining.toFixed(3)}`}<small>{credit.remaining === null ? '잔여' : `약 ${formatKrw(credit.remaining, exchange.rate)}`}</small></strong>
          : <p className="inu-help">크레딧 정보를 불러올 수 없습니다.</p>}
      </div><InterfaceIcon name="down" /></summary>
      <div className="inu-credit-more">
        {credit?.remaining != null && credit.limit != null && <>
          <div className="inu-row"><span>총 충전 ${credit.limit.toFixed(3)}</span><span>{Math.round(credit.limit > 0 ? credit.remaining / credit.limit * 100 : 0)}% 남음</span></div>
          <div className="inu-meter"><span style={{ width: `${Math.max(0, Math.min(100, credit.limit > 0 ? credit.remaining / credit.limit * 100 : 0))}%` }} /></div>
        </>}
        <div className="inu-row"><span>이 채팅방 사용</span><strong>${session.total_cost.toFixed(6)}<small>약 {formatKrw(session.total_cost, exchange.rate)}</small></strong></div>
        <p className="inu-help">환율 1달러 = {exchange.rate.toLocaleString('ko-KR')}원{exchange.fallback ? ' · 폴백 환율' : ''}</p>
      </div>
    </details>
    <nav className="inu-tabs" role="tablist" aria-label="세션 설정 분류" onKeyDown={event => {
      const current = tabs.findIndex(tab => tab.id === activeTab);
      const next = event.key === 'ArrowRight' ? (current + 1) % tabs.length : event.key === 'ArrowLeft' ? (current + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
      if (next >= 0) { event.preventDefault(); setActiveTab(tabs[next].id); document.getElementById(`session-tab-${tabs[next].id}`)?.focus(); }
    }}>
      {tabs.map(tab => <button key={tab.id} type="button" id={`session-tab-${tab.id}`} role="tab" aria-selected={activeTab === tab.id} aria-controls={`session-panel-${tab.id}`} onClick={() => setActiveTab(tab.id)}>{tab.label}</button>)}
    </nav>
    <main className="inu-main-scroll" ref={scrollRef}>
      <div className="inu-content" id="session-panel-chat" role="tabpanel" aria-labelledby="session-tab-chat" hidden={activeTab !== 'chat'}>
        <section className="inu-section">
          <h3><InterfaceIcon name="my" />페르소나</h3>
          <select aria-label="페르소나 선택" value={session.persona_id ?? ''} disabled={sending} onChange={event => void selectPersona(personas.find(item => item.id === event.target.value) ?? null)}>
            <option value="">없음 · 페르소나 미사용</option>{personas.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          {personas.find(item => item.id === session.persona_id) && <p className="inu-help">{personas.find(item => item.id === session.persona_id)?.description}</p>}
          {personas.length === 0 && <p className="inu-help">My 탭에서 페르소나를 추가하세요.</p>}
        </section>
        {multichat && <MultichatProgressSettings room={multichat.room} members={multichat.members} slot={multichat.slot} otherPresent={multichat.otherPresent} presenceReady={multichat.presenceReady} onUpdate={multichat.onRoomUpdate} onRefresh={multichat.onRefresh} />}
        {semiActive && semiSettings}
        {user && <SessionThemeSettings compact session={session} userId={user.id} busy={sending || summaryGenerating} onUpdate={onUpdate} />}
        <section className="inu-section">
          <div className="inu-row"><h3><InterfaceIcon name="note" />{multichat ? '내 유저 노트' : '유저 노트'}</h3><span className="inu-help">{note.length.toLocaleString()}자 · 제한 없음</span></div>
          <textarea aria-label="유저 노트" value={note} onChange={event => setNote(event.target.value)} rows={4} placeholder="이 채팅방에서 AI에게 전달할 메모" />
          <div className="inu-note-footer"><span className="inu-help">{note !== session.user_note ? '저장하지 않은 변경사항' : '이 채팅방에만 전달됩니다.'}</span><button type="button" className="inu-button inu-primary" onClick={() => void saveNote()} disabled={noteSaving}>{noteSaving ? '저장 중…' : '노트 저장'}</button></div>
        </section>
        <SessionInformationSettings key={`information:${session.id}`} session={session} busy={sending || summaryGenerating} onUpdate={onUpdate} />
        {user && <SessionPluginSettings compact session={session} userId={user.id} busy={sending || summaryGenerating} onUpdate={onUpdate} />}
        {user && <SessionWorkCombinationSettings key={session.id} session={session} userId={user.id} includeUnlisted={isAdmin} busy={sending || summaryGenerating} onUpdate={onUpdate} onSavingChange={onWorkCombinationSavingChange} />}
        {!semiActive && semiSettings}
      </div>

      <div className="inu-content" id="session-panel-ai" role="tabpanel" aria-labelledby="session-tab-ai" hidden={activeTab !== 'ai'}>
        {multichat && <MultichatApiSettings room={multichat.room} members={multichat.members} onUpdate={multichat.onRoomUpdate} />}
        <section className="inu-section"><h3><InterfaceIcon name="model" />OpenRouter 모델</h3><ModelSelector drawer provider="openrouter" model={sessionModel} reasoning={sessionReasoning} onModelChange={onModelChange} onReasoningChange={onReasoningChange} favoritesOnly hideReasoning /></section>
        <details className="inu-section inu-accordion" id="session-output-settings">
          <summary><div><h3><InterfaceIcon name="output" />출력 설정</h3><p className="inu-summary">{outputLabel} · {reasoningLabel}<span className="inu-dot">·</span>{hasExplicitOverride ? '이 채팅방 설정' : '전역 기본값'}</p></div><InterfaceIcon name="down" /></summary>
          <div className="inu-detail-body"><OutputSettingsEditor compact value={outputSettings} onChange={setOutputSettings} tokenLabel="이 채팅방 출력량" /><button type="button" className="inu-button inu-primary inu-full" onClick={() => void saveOverride()}>출력 저장</button><button type="button" className="inu-text-button" onClick={() => void resetOverride()}>기본값으로 되돌리기</button></div>
        </details>
        <PromptCacheSettings compact key={session.id} session={session} model={sessionModel} turnCount={sessionTurnCount} busy={sending || summaryGenerating} onUpdate={onUpdate} />
      </div>

      <div className="inu-content" id="session-panel-memory" role="tabpanel" aria-labelledby="session-tab-memory" hidden={activeTab !== 'memory'}>
        <section className="inu-section">
          <h3><InterfaceIcon name="memory" />요약 메모리</h3><p className="inu-field-label">이 채팅방 요약 모델</p>
          <ModelSelector drawer displayLabel={!session.summary_model_override ? '내 기본 모델 사용' : undefined} provider="openrouter" model={session.summary_model_override || profile?.summary_model || profile?.default_model || sessionModel} reasoning={session.summary_reasoning_override ?? profile?.summary_reasoning ?? {}} onModelChange={summary_model_override => void saveSummarySettings({ summary_model_override })} onReasoningChange={summary_reasoning_override => void saveSummarySettings({ summary_reasoning_override })} favoritesOnly />
          <button type="button" className="inu-text-button" onClick={() => void saveSummarySettings({ summary_model_override: null })}>내 기본 모델 사용</button>
          <label htmlFor="session-summary-source" className="inu-field-label">요약 입력 범위</label>
          <select id="session-summary-source" value={session.summary_source_mode_override ?? profile?.summary_source_mode ?? 'incremental'} onChange={event => void saveSummarySettings({ summary_source_mode_override: event.target.value as 'incremental' | 'full' })}><option value="incremental">이전 요약 + 이후 메시지</option><option value="full">이전 요약 제외 + 세션 전체 메시지</option></select>
          <label className="inu-field-label">생성 기준 턴<input type="number" min={1} max={Math.max(1, sessionTurnCount)} value={summaryThroughTurn} onChange={event => setSummaryThroughTurn(event.target.value === '' ? '' : Math.max(1, Math.min(sessionTurnCount, Number(event.target.value) || 1)))} placeholder={`최신 · ${sessionTurnCount}턴`} /></label>
          <p className="inu-help">기준 턴을 비우면 최신까지 요약해요. 요약 지시문은 관리자 전역 프롬프트를 사용해요.</p>
          <button type="button" className="inu-button inu-primary inu-full" disabled={sending || summaryGenerating || sessionTurnCount === 0} onClick={async () => { await onGenerateSummary(summaryThroughTurn === '' ? undefined : summaryThroughTurn); await loadSummaries(); }}><InterfaceIcon name="generate" />{summaryGenerating ? '요약 생성 중…' : '지금 요약 노트 생성'}</button>
          <button type="button" className="inu-button inu-full" onClick={() => void openSummaries()}><InterfaceIcon name="history" />요약 노트 보기</button>
        </section>
      </div>

      <div className="inu-content" id="session-panel-display" role="tabpanel" aria-labelledby="session-tab-display" hidden={activeTab !== 'display'}>
        <section className="inu-section"><h3><InterfaceIcon name="visibility" />채팅 표시</h3>
          <label className="inu-switch-row inu-tall"><span>응답별 크레딧 사용량<small>실제 비용과 전체 출력 토큰</small></span><Toggle aria-label="응답별 크레딧 사용량 보기" checked={showCost} onChange={onShowCostToggle} /></label>
          <label className="inu-switch-row inu-tall"><span>소비 비용 원화로 표시<small>모든 채팅방에 적용 · 환율 {exchange.rate.toLocaleString('ko-KR')}원</small></span><Toggle aria-label="소비 비용 원화로 표시" checked={showCostKrw} onChange={onShowCostKrwToggle} /></label>
          <label className="inu-switch-row inu-tall"><span>캐시 토큰 보기<small>OpenRouter 캐시 읽기·쓰기 토큰</small></span><Toggle aria-label="캐시 토큰 보기" checked={showCacheTokens} onChange={onShowCacheTokensToggle} /></label>
          <label className="inu-switch-row inu-tall"><span>이미지 보기<small>끄면 이미지를 흐린 링크로 표시</small></span><Toggle aria-label="마크다운 이미지 보기" checked={showImages} onChange={onShowImagesToggle} /></label>
          <label className="inu-switch-row inu-tall"><span>자랑모드<small>유저 말풍선의 내용을 스포일러로 가립니다. 누르면 볼 수 있어요</small></span><Toggle aria-label="자랑모드" checked={showOffMode} onChange={onShowOffModeToggle} /></label>
          <label className="inu-switch-row inu-tall"><span>디버그 모드<small>숨겨진 메시지를 채팅창에 표시</small></span><Toggle aria-label="디버그 모드" checked={debugMode} onChange={onDebugToggle} /></label>
        </section>
        <section className="inu-section"><h3><InterfaceIcon name="download" />대화 내보내기</h3><button type="button" className="inu-button inu-full" onClick={() => void onExportConversation()} disabled={sending || exportingConversation} aria-busy={exportingConversation}><InterfaceIcon name="download" />{exportingConversation ? '대화 추출 중…' : '대화 전체 추출'}</button><p className="inu-help">전체 대화를 TXT로 다운로드 · 테마 태그 제외</p></section>
        <details className="inu-section inu-accordion" open={logOpen} onToggle={event => setLogOpen(event.currentTarget.open)}><summary><h3><InterfaceIcon name="alert" />에러 로그{errorLog.length > 0 && <span className="inu-tag">{errorLog.length}</span>}</h3><InterfaceIcon name="down" /></summary><div className="inu-detail-body">{errorLog.length > 0 && <button type="button" className="inu-text-button inu-danger" onClick={onClearErrors}>로그 지우기</button>}{errorLog.length === 0 ? <p className="inu-help">기록된 에러가 없습니다.</p> : [...errorLog].reverse().map(error => <article key={error.id} className="inu-log"><small>{new Date(error.at).toLocaleTimeString('ko-KR')}</small><strong>{error.short}</strong>{error.detail !== error.short && <p>{error.detail}</p>}</article>)}</div></details>
      </div>
    </main>

    {summaryOpen && <SessionMenuPage enabled title="요약 노트 기록" onBack={() => setSummaryOpen(false)}>
      <div className="inu-summary-list">
        <section className="inu-section"><h3>사용자 스토리 메모</h3><p className="inu-help">정식 요약 아래에 항상 전달돼요. 메시지 누적 범위는 바뀌지 않습니다.</p>{storyNotes.map(item => <article key={item.id} className="inu-active-item"><p>{item.content}</p><button type="button" className="inu-text-button inu-danger" onClick={() => void deleteStoryNote(item.id)}>삭제</button></article>)}<textarea rows={3} value={storyNoteDraft} onChange={event => setStoryNoteDraft(event.target.value)} aria-label="새 스토리 메모" placeholder="호칭, 디테일 등 계속 전달할 메모" /><button type="button" className="inu-button inu-full" onClick={() => void addStoryNote()}><InterfaceIcon name="plus" />스토리 메모 추가</button></section>
        <section className="inu-section"><div className="inu-row"><h3>요약 노트 기록</h3><span className="inu-help">{summaryVersions.length}개</span></div><p className="inu-help">여러 노트를 반영하면 내용 중복이나 지시 충돌이 생길 수 있어요.</p>
          {summaryVersions.length === 0 ? <p className="inu-help">생성된 요약이 없습니다.</p> : summaryVersions.map(version => <article key={version.id} className="inu-summary-item"><div className="inu-summary-meta"><label><input type="checkbox" checked={selectedSummaryIds.includes(version.id)} onChange={event => setSelectedSummaryIds(ids => event.target.checked ? [...ids, version.id] : ids.filter(id => id !== version.id))} aria-label={`${version.summarized_through_turn}턴 요약 선택`} /><time dateTime={version.created_at} title={new Date(version.created_at).toLocaleString('ko-KR')}>{new Date(version.created_at).toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' }).replace(/\s/g, '').replace(/\.$/, '')} {new Date(version.created_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}</time></label><span>AI 요약 · {version.summarized_through_turn}턴</span>{version.is_active && <span className="inu-tag">전송 중</span>}</div>
            {editingSummary === version.id ? <><textarea rows={6} value={summaryDraft} onChange={event => setSummaryDraft(event.target.value)} aria-label="요약 노트 내용" /><div className="inu-item-actions"><button type="button" onClick={() => void saveSummary(version)}>저장</button><button type="button" onClick={() => setEditingSummary(null)}>취소</button></div></> : <><pre>{version.content}</pre><div className="inu-item-actions"><button type="button" onClick={() => { setEditingSummary(version.id); setSummaryDraft(version.content); }}>편집</button><button type="button" className="inu-danger" onClick={() => void deleteSummary(version)}>삭제</button></div></>}
          </article>)}
          {summaryVersions.length > 0 && <div className="inu-two-buttons"><button type="button" className="inu-button" onClick={() => void applySelectedSummaries()}>선택 노트 반영</button><button type="button" className="inu-button inu-primary" disabled={sending || selectedSummaryIds.length < 2 || summaryGenerating} onClick={async () => { await onMergeSummaries(summaryVersions.filter(version => selectedSummaryIds.includes(version.id))); await loadSummaries(); }}><InterfaceIcon name="merge" />통합 생성</button></div>}
        </section>
      </div>
    </SessionMenuPage>}
    {savedMsg && <div className="inu-feedback" role="status" aria-live="polite">{savedMsg}</div>}
  </SessionMenuFrame>;
}
