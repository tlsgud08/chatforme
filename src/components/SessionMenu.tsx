import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { getApiKey } from '@/lib/apiKeys';
import { DEFAULT_MODELS, PROVIDER_LABELS } from '@/lib/llm/types';
import type { Persona, Profile, Provider, Session } from '@/types/db';
import type { ErrorEntry } from '@/pages/ChatPage';

interface OpenRouterCredit {
  usage: number;
  limit: number | null;
  remaining: number | null;
}

const PROVIDERS: Provider[] = ['openrouter', 'claude', 'gemini', 'openai'];
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
  sessionProvider: Provider;
  sessionModel: string;
  onProviderChange: (p: Provider) => void;
  onModelChange: (m: string) => void;
  errorLog: ErrorEntry[];
  onClearErrors: () => void;
}

export default function SessionMenu({
  session, profile, onClose, onUpdate, onPersonaChange,
  debugMode, onDebugToggle,
  sessionProvider, sessionModel, onProviderChange, onModelChange,
  errorLog, onClearErrors,
}: Props) {
  const { user } = useAuth();
  const [note, setNote] = useState(session.user_note);
  const [credit, setCredit] = useState<OpenRouterCredit | null>(null);
  const [creditLoading, setCreditLoading] = useState(false);
  const [modelPricing, setModelPricing] = useState<{ prompt: number; completion: number } | null>(null);

  useEffect(() => {
    setCredit(null);
    setModelPricing(null);
    if (sessionProvider !== 'openrouter') return;
    const apiKey = getApiKey('openrouter');
    if (!apiKey) return;
    setCreditLoading(true);
    fetch('https://openrouter.ai/api/v1/auth/key', {
      headers: { authorization: `Bearer ${apiKey}` },
    })
      .then((r) => r.json())
      .then((data) => {
        const d = data?.data;
        if (!d) return;
        setCredit({
          usage: d.usage ?? 0,
          limit: d.limit ?? null,
          remaining: d.limit_remaining ?? null,
        });
      })
      .catch(() => {})
      .finally(() => setCreditLoading(false));
    fetch('https://openrouter.ai/api/v1/models', {
      headers: { authorization: `Bearer ${apiKey}` },
    })
      .then(r => r.json())
      .then(data => {
        const models: Array<{ id: string; pricing?: { prompt: string; completion: string } }> = data?.data ?? [];
        const found = models.find(m => m.id === sessionModel);
        if (found?.pricing) {
          setModelPricing({
            prompt: parseFloat(found.pricing.prompt) || 0,
            completion: parseFloat(found.pricing.completion) || 0,
          });
        }
      })
      .catch(() => {});
  }, [sessionProvider, sessionModel]);
  const [sliderVal, setSliderVal] = useState(() => tokensToSlider(session.output_tokens_override));
  const [hasExplicitOverride, setHasExplicitOverride] = useState(session.output_tokens_override !== null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [savedMsg, setSavedMsg] = useState('');
  const [logOpen, setLogOpen] = useState(false);

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
            {PROVIDER_LABELS[sessionProvider]} 크레딧
          </p>
          {sessionProvider === 'openrouter' ? (
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
              {(() => {
                const sessionCost = modelPricing
                  ? session.total_input_tokens * modelPricing.prompt + session.total_output_tokens * modelPricing.completion
                  : null;
                return (
                  <p className="mt-2 text-[11px] text-slate-500">
                    {sessionCost !== null
                      ? `이 채팅방: 약 $${sessionCost.toFixed(6)}`
                      : '이 채팅방: 크레딧 계산 중…'}
                  </p>
                );
              })()}
            </>
          ) : (
            <p className="text-xs text-slate-500">타 API 크레딧 조회는 추후 지원 예정입니다.</p>
          )}
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
          <h3 className="mb-2 text-sm font-semibold text-slate-300">AI 공급사 / 모델</h3>
          <div className="flex flex-col gap-2">
            <select
              value={sessionProvider}
              onChange={(e) => onProviderChange(e.target.value as Provider)}
              className="w-full rounded-lg bg-surface px-3 py-2.5 text-sm text-white outline-none"
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
              ))}
            </select>
            <select
              value={sessionModel || DEFAULT_MODELS[sessionProvider][0]}
              onChange={(e) => onModelChange(e.target.value)}
              className="w-full rounded-lg bg-surface px-3 py-2.5 text-sm text-white outline-none"
            >
              {DEFAULT_MODELS[sessionProvider].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
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
