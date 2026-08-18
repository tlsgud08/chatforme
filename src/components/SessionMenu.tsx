import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { getApiKey } from '@/lib/apiKeys';
import type { ReasoningSelection } from '@/lib/llm/types';
import ModelSelector from './ModelSelector';
import type { Persona, Profile, Session, SummaryVersion } from '@/types/db';
import type { ErrorEntry } from '@/pages/ChatPage';

interface OpenRouterCredit {
  usage: number;
  limit: number | null;
  remaining: number | null;
}

const MAX_NOTE = 2000;
const SLIDER_MAX = 4224;

function tokenLabel(v: number | null) {
  return v === null || v >= SLIDER_MAX ? '무제한' : String(v);
}
function sliderToTokens(v: number): number | null {
  return v >= SLIDER_MAX ? null : v;
}
function tokensToSlider(v: number | null): number {
  return v === null ? SLIDER_MAX : v;
}

interface Props {
  session: Session;
  profile: Profile | null;
  onClose: () => void;
  onUpdate: (patch: Partial<Session>) => void;
  onPersonaChange: (persona: Persona | null) => void;
  debugMode: boolean;
  onDebugToggle: (v: boolean) => void;
  showCost: boolean;
  onShowCostToggle: (v: boolean) => void;
  sessionModel: string;
  onModelChange: (m: string) => void;
  sessionReasoning: ReasoningSelection;
  onReasoningChange: (reasoning: ReasoningSelection) => void;
  errorLog: ErrorEntry[];
  onClearErrors: () => void;
  onGenerateSummary: () => Promise<void>;
  onMergeSummaries: (contents: string[]) => Promise<void>;
  summaryGenerating: boolean;
}

export default function SessionMenu({
  session, profile, onClose, onUpdate, onPersonaChange,
  debugMode, onDebugToggle, showCost, onShowCostToggle,
  sessionModel, onModelChange, sessionReasoning, onReasoningChange,
  errorLog, onClearErrors,
  onGenerateSummary, onMergeSummaries, summaryGenerating,
}: Props) {
  const { user } = useAuth();
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
  const [sliderVal, setSliderVal] = useState(() => tokensToSlider(session.output_tokens_override));
  const [hasExplicitOverride, setHasExplicitOverride] = useState(session.output_tokens_override !== null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [savedMsg, setSavedMsg] = useState('');
  const [logOpen, setLogOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summaryVersions, setSummaryVersions] = useState<SummaryVersion[]>([]);
  const [editingSummary, setEditingSummary] = useState<string | null>(null);
  const [summaryDraft, setSummaryDraft] = useState('');
  const [selectedSummaryIds, setSelectedSummaryIds] = useState<string[]>([]);

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
    const trimmed = note.slice(0, MAX_NOTE);
    await supabase.from('sessions').update({ user_note: trimmed }).eq('id', session.id);
    onUpdate({ user_note: trimmed });
    flash('유저 노트를 저장했습니다.');
  }

  async function saveOverride(sv: number) {
    const value = sliderToTokens(sv);
    setSliderVal(sv);
    setHasExplicitOverride(true);
    await supabase.from('sessions').update({ output_tokens_override: value }).eq('id', session.id);
    onUpdate({ output_tokens_override: value });
  }

  async function resetOverride() {
    const defaultSv = tokensToSlider(profile?.default_output_tokens ?? null);
    setSliderVal(defaultSv);
    setHasExplicitOverride(false);
    await supabase.from('sessions').update({ output_tokens_override: null }).eq('id', session.id);
    onUpdate({ output_tokens_override: null });
  }

  async function selectPersona(persona: Persona | null) {
    const pid = persona?.id ?? null;
    await supabase.from('sessions').update({ persona_id: pid }).eq('id', session.id);
    onUpdate({ persona_id: pid });
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

  async function saveSummary(version: SummaryVersion) {
    const content = summaryDraft.trim();
    if (!content) return;
    await supabase.from('summary_versions').update({ content }).eq('id', version.id);
    if (version.is_active) {
      const combined = summaryVersions
        .filter((item) => item.is_active)
        .map((item) => item.id === version.id ? content : item.content)
        .join('\n\n--- 추가 요약 노트 ---\n\n');
      await supabase.from('sessions').update({ summary: combined }).eq('id', session.id);
      onUpdate({ summary: combined });
    }
    setEditingSummary(null);
    await loadSummaries();
    flash('요약 노트를 수정했습니다.');
  }

  async function saveSummarySettings(patch: Partial<Session>) {
    await supabase.from('sessions').update(patch).eq('id', session.id);
    onUpdate(patch);
  }

  async function applySelectedSummaries() {
    const selected = summaryVersions.filter((version) => selectedSummaryIds.includes(version.id));
    const summary = selected.map((version) => version.content).join('\n\n--- 추가 요약 노트 ---\n\n');
    const { error } = await supabase.from('summary_versions').update({ is_active: false }).eq('session_id', session.id);
    if (error) { flash(error.message); return; }
    if (selectedSummaryIds.length > 0) {
      const { error: selectError } = await supabase.from('summary_versions').update({ is_active: true }).in('id', selectedSummaryIds);
      if (selectError) { flash(selectError.message); return; }
    }
    await supabase.from('sessions').update({ summary }).eq('id', session.id);
    onUpdate({ summary });
    await loadSummaries();
    flash('선택한 요약 노트를 채팅에 반영했습니다.');
  }

  function flash(m: string) {
    setSavedMsg(m);
    setTimeout(() => setSavedMsg(''), 1500);
  }

  const overrideLabel = hasExplicitOverride
    ? tokenLabel(sliderToTokens(sliderVal))
    : `${tokenLabel(profile?.default_output_tokens ?? null)} (기본값)`;

  return (
    <div className="fixed inset-0 z-20 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        className="relative flex h-full w-[85%] max-w-[360px] flex-col gap-5 overflow-y-auto bg-bg p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center">
          <h2 className="font-semibold text-white">세션 메뉴</h2>
          <button onClick={onClose} className="ml-auto text-slate-400">✕</button>
        </div>

        {/* 크레딧 */}
        <section className="rounded-xl bg-surface p-3">
          <p className="mb-1 text-xs font-semibold text-slate-400">
            OpenRouter 크레딧
          </p>
            <>
              {!getApiKey('openrouter') ? (
                <p className="text-xs text-slate-500">API 키를 설정하면 잔여 크레딧을 확인할 수 있습니다.</p>
              ) : creditLoading ? (
                <p className="text-xs text-slate-500">불러오는 중…</p>
              ) : credit ? (
                <div className="flex items-center justify-between">
                  <div>
                    {credit.remaining !== null ? (
                      <p className="text-xl font-bold text-white">
                        ${credit.remaining.toFixed(3)}
                        <span className="ml-1 text-xs font-normal text-slate-400">잔여</span>
                      </p>
                    ) : (
                      <p className="text-xl font-bold text-white">
                        무제한
                        <span className="ml-1 text-xs font-normal text-slate-400">잔여</span>
                      </p>
                    )}
                  </div>
                  {credit.remaining !== null && credit.limit !== null && (
                    <div className="w-20">
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface2">
                        <div
                          className="h-full rounded-full bg-emerald-500"
                          style={{ width: `${Math.max(0, Math.min(100, (credit.remaining / credit.limit) * 100))}%` }}
                        />
                      </div>
                      <p className="mt-0.5 text-right text-[10px] text-slate-500">
                        {Math.round((credit.remaining / credit.limit) * 100)}% 남음
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-slate-500">크레딧 정보를 불러올 수 없습니다.</p>
              )}
              <p className="mt-2 text-[11px] text-slate-500">
                이 채팅방 사용: ${session.total_cost.toFixed(6)}
              </p>
            </>
        </section>

        {/* 페르소나 */}
        <section>
          <h3 className="mb-2 text-sm font-semibold text-slate-300">페르소나</h3>
          {personas.length === 0 ? (
            <p className="text-xs text-slate-500">My 탭에서 페르소나를 추가하세요.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              <button
                onClick={() => selectPersona(null)}
                className={`rounded-lg px-3 py-2 text-left text-sm ${
                  !session.persona_id ? 'bg-brand text-white' : 'bg-surface text-slate-300'
                }`}
              >
                없음 (페르소나 미사용)
              </button>
              {personas.map((p) => (
                <button
                  key={p.id}
                  onClick={() => selectPersona(p)}
                  className={`rounded-lg px-3 py-2 text-left text-sm ${
                    session.persona_id === p.id ? 'bg-brand text-white' : 'bg-surface text-slate-300'
                  }`}
                >
                  <p className="font-semibold">{p.name}</p>
                  <p className="mt-0.5 line-clamp-1 text-xs opacity-70">{p.description}</p>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* AI 공급사 / 모델 */}
        <section>
          <h3 className="mb-2 text-sm font-semibold text-slate-300">OpenRouter 모델</h3>
          <div className="flex flex-col gap-2">
            <ModelSelector
              provider="openrouter"
              model={sessionModel}
              reasoning={sessionReasoning}
              onModelChange={onModelChange}
              onReasoningChange={onReasoningChange}
              favoritesOnly
            />
          </div>
        </section>

        {/* 출력량 */}
        <section>
          <label className="mb-1 block text-xs text-slate-400">
            이 세션 출력량: {overrideLabel}
          </label>
          <input
            type="range"
            min={256}
            max={SLIDER_MAX}
            step={128}
            value={sliderVal}
            onChange={(e) => saveOverride(Number(e.target.value))}
            className="w-full"
          />
          {hasExplicitOverride && (
            <button onClick={resetOverride} className="mt-1 text-xs text-slate-400 underline">
              기본값으로 되돌리기
            </button>
          )}
        </section>

        {/* 유저 노트 */}
        <section>
          <label className="mb-1 block text-xs text-slate-400">
            유저 노트 ({note.length}/{MAX_NOTE})
          </label>
          <p className="mb-2 text-[11px] text-slate-500">
            이 세션에서만 AI에게 전달되는 메모입니다.
          </p>
          <textarea
            value={note}
            maxLength={MAX_NOTE}
            onChange={(e) => setNote(e.target.value)}
            rows={8}
            placeholder="예: 내 캐릭터는 항상 존댓말을 쓴다."
            className="w-full resize-none rounded-lg bg-surface px-3 py-2.5 text-sm outline-none"
          />
          <button
            onClick={saveNote}
            className="mt-2 w-full rounded-lg bg-brand py-2 text-sm font-semibold text-white"
          >
            유저 노트 저장
          </button>
        </section>

        {/* 요약 메모리 */}
        <section className="rounded-xl border border-surface2 p-3">
          <h3 className="text-sm font-semibold text-slate-300">요약 메모리 설정</h3>
          <div className="mt-3">
            <p className="mb-1 text-xs text-slate-400">이 채팅방 요약 모델</p>
            <ModelSelector provider="openrouter" model={session.summary_model_override || profile?.summary_model || profile?.default_model || sessionModel} reasoning={session.summary_reasoning_override ?? profile?.summary_reasoning ?? {}} onModelChange={(summary_model_override) => void saveSummarySettings({ summary_model_override })} onReasoningChange={(summary_reasoning_override) => void saveSummarySettings({ summary_reasoning_override })} favoritesOnly />
            {session.summary_model_override && <button type="button" onClick={() => void saveSummarySettings({ summary_model_override: null })} className="mt-1 text-xs text-slate-400 underline">전역 모델 사용</button>}
          </div>
          <div className="mt-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-slate-300">자동 요약</p>
              <p className="text-[11px] text-slate-500">마지막 요약 이후 대화 턴 기준</p>
            </div>
            <button type="button" aria-pressed={session.auto_summary_enabled} onClick={() => void saveSummarySettings({ auto_summary_enabled: !session.auto_summary_enabled })} className={`relative h-6 w-11 rounded-full ${session.auto_summary_enabled ? 'bg-emerald-500' : 'bg-surface2'}`}>
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${session.auto_summary_enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
          </div>
          <label className="mt-3 block text-xs text-slate-400">자동 생성 간격 (턴)</label>
          <input type="number" min={5} max={200} value={session.summary_interval_override ?? profile?.summary_interval ?? 30} onChange={(event) => void saveSummarySettings({ summary_interval_override: Math.max(5, Math.min(200, Number(event.target.value) || 30)) })} className="mt-1 w-full rounded-lg bg-surface px-3 py-2 text-sm outline-none" />
          <p className="mt-1 text-[11px] text-slate-500">전역 기본 {profile?.summary_interval ?? 30}턴 · 현재 마지막 요약: {session.summary_last_turn || 0}턴</p>
          <button type="button" onClick={() => void saveSummarySettings({ summary_interval_override: null })} className="mt-1 text-xs text-slate-400 underline">전역 간격 사용</button>
          <label className="mt-3 block text-xs text-slate-400">Summary level (0~10)</label>
          <input type="number" min={0} max={10} value={session.summary_level_override ?? profile?.summary_level ?? 5} onChange={(e) => void saveSummarySettings({ summary_level_override: Math.max(0, Math.min(10, Number(e.target.value) || 0)) })} className="mt-1 w-full rounded-lg bg-surface px-3 py-2 text-sm outline-none" />
          <label className="mt-3 flex items-center justify-between text-xs text-slate-300"><span>Allow omission</span><input type="checkbox" checked={session.summary_allow_omission_override ?? profile?.summary_allow_omission ?? true} onChange={(e) => void saveSummarySettings({ summary_allow_omission_override: e.target.checked })} /></label>
          <label className="mt-3 flex items-center justify-between text-xs text-slate-300"><span>요약 파라미터 함께 전송</span><input type="checkbox" disabled={!profile?.summary_prompt?.trim()} checked={session.summary_parameters_enabled_override ?? profile?.summary_parameters_enabled ?? true} onChange={(e) => void saveSummarySettings({ summary_parameters_enabled_override: e.target.checked })} /></label>
          <button type="button" disabled={summaryGenerating} onClick={async () => { await onGenerateSummary(); await loadSummaries(); }} className="mt-3 w-full rounded-lg bg-brand py-2 text-sm font-semibold text-white disabled:opacity-50">
            {summaryGenerating ? '요약 생성 중…' : '지금 요약 노트 생성'}
          </button>
          <button type="button" onClick={() => void openSummaries()} className="mt-2 w-full rounded-lg bg-surface2 py-2 text-sm text-slate-200">요약 노트 보기</button>
        </section>

        {summaryOpen && (
          <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4" onClick={() => setSummaryOpen(false)}>
            <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-bg p-4" onClick={(event) => event.stopPropagation()}>
              <div className="flex items-center"><h3 className="font-semibold text-white">요약 노트 기록</h3><button type="button" onClick={() => setSummaryOpen(false)} className="ml-auto text-slate-400">✕</button></div>
              <div className="mt-3 flex flex-col gap-3">
                {summaryVersions.length > 0 && <div className="rounded-xl bg-surface p-3"><p className="text-xs text-amber-400">복수 노트 반영은 내용 중복이나 지시 충돌이 생길 수 있어 권장하지 않습니다.</p><div className="mt-2 flex gap-2"><button type="button" onClick={() => void applySelectedSummaries()} className="flex-1 rounded-lg bg-surface2 py-2 text-xs text-white">선택 노트 반영</button><button type="button" disabled={selectedSummaryIds.length < 2 || summaryGenerating} onClick={async () => { await onMergeSummaries(summaryVersions.filter((v) => selectedSummaryIds.includes(v.id)).map((v) => v.content)); await loadSummaries(); }} className="flex-1 rounded-lg bg-brand py-2 text-xs text-white disabled:opacity-50">선택 노트 통합 생성</button></div></div>}
                {summaryVersions.length === 0 ? <p className="py-6 text-center text-sm text-slate-500">생성된 요약이 없습니다.</p> : summaryVersions.map((version) => (
                  <article key={version.id} className={`rounded-xl border p-3 ${version.is_active ? 'border-emerald-500/50' : 'border-surface2 opacity-70'}`}>
                    <div className="mb-2 flex items-center gap-2 text-[11px] text-slate-500"><input type="checkbox" checked={selectedSummaryIds.includes(version.id)} onChange={(e) => setSelectedSummaryIds((ids) => e.target.checked ? [...ids, version.id] : ids.filter((id) => id !== version.id))} /><span>{new Date(version.created_at).toLocaleString('ko-KR')}</span><span>{version.summarized_through_turn}턴까지</span>{version.is_active && <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-emerald-400">전송 중</span>}</div>
                    {editingSummary === version.id ? <><textarea rows={14} value={summaryDraft} onChange={(event) => setSummaryDraft(event.target.value)} className="w-full rounded-lg bg-surface p-3 text-xs outline-none"/><div className="mt-2 flex justify-end gap-2"><button type="button" onClick={() => setEditingSummary(null)} className="text-xs text-slate-400">취소</button><button type="button" onClick={() => void saveSummary(version)} className="rounded bg-brand px-3 py-1.5 text-xs text-white">저장</button></div></> : <><pre className="whitespace-pre-wrap break-words text-xs text-slate-300">{version.content}</pre><button type="button" onClick={() => { setEditingSummary(version.id); setSummaryDraft(version.content); }} className="mt-2 text-xs text-brand">편집</button></>}
                  </article>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* 응답별 크레딧 사용량 */}
        <section>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-slate-300">응답별 크레딧 사용량 보기</p>
              <p className="text-xs text-slate-500">AI 응답 아래에 실제 비용과 전체 출력 토큰 표시</p>
            </div>
            <button
              onClick={() => onShowCostToggle(!showCost)}
              className={`relative h-6 w-11 rounded-full transition-colors ${showCost ? 'bg-emerald-500' : 'bg-surface2'}`}
            >
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${showCost ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
          </div>
        </section>

        {/* 디버그 모드 */}
        <section>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-slate-300">디버그 모드</p>
              <p className="text-xs text-slate-500">숨겨진 메시지를 채팅창에 표시</p>
            </div>
            <button
              onClick={() => onDebugToggle(!debugMode)}
              className={`relative h-6 w-11 rounded-full transition-colors ${debugMode ? 'bg-amber-500' : 'bg-surface2'}`}
            >
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${debugMode ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
          </div>
        </section>

        {/* 에러 로그 */}
        <section>
          <div className="flex items-center justify-between">
            <button
              onClick={() => setLogOpen((v) => !v)}
              className="flex items-center gap-1.5 text-sm font-semibold text-slate-300"
            >
              <span>에러 로그</span>
              {errorLog.length > 0 && (
                <span className="rounded-full bg-red-500/80 px-1.5 py-0.5 text-[10px] font-bold text-white">
                  {errorLog.length}
                </span>
              )}
              <span className="text-xs text-slate-500">{logOpen ? '▲' : '▼'}</span>
            </button>
            {errorLog.length > 0 && (
              <button onClick={onClearErrors} className="text-xs text-slate-500 underline">
                지우기
              </button>
            )}
          </div>
          {logOpen && (
            <div className="mt-2 flex flex-col gap-2">
              {errorLog.length === 0 ? (
                <p className="text-xs text-slate-500">기록된 에러가 없습니다.</p>
              ) : (
                [...errorLog].reverse().map((e) => (
                  <div key={e.id} className="rounded-lg border border-red-500/20 bg-surface p-2.5">
                    <p className="text-[10px] text-slate-500">
                      {new Date(e.at).toLocaleTimeString('ko-KR')}
                    </p>
                    <p className="mt-0.5 text-xs font-semibold text-red-400">{e.short}</p>
                    {e.detail !== e.short && (
                      <p className="mt-1 break-all text-[10px] text-slate-500">{e.detail}</p>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </section>

        {savedMsg && (
          <div className="toast-enter pointer-events-none fixed inset-x-0 top-6 z-50 flex justify-center px-4">
            <div className="rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-white shadow-lg">
              {savedMsg}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
