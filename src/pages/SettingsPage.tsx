import { useEffect, useState } from 'react';
import InterfaceIcon from '@/components/InterfaceIcon';
import ModernPageHeading from '@/components/ModernPageHeading';
import type { InterfaceIconName } from '@/components/InterfaceIcon';
import { supabase, ADMIN_EMAIL } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { loadApiKeys, saveApiKeys, type ApiKeys } from '@/lib/apiKeys';
import type { ReasoningSelection } from '@/lib/llm/types';
import { discoverOpenRouterModels } from '@/lib/llm/modelDiscovery';
import { loadDefaultReasoning, modelsFor, normalizeReasoning, saveDefaultReasoning, toOpenRouterModel } from '@/lib/modelPreferences';
import ModelSelector from '@/components/ModelSelector';
import ThemePreferences from '@/components/ThemePreferences';
import InterfacePreferences from '@/components/InterfacePreferences';
import type { Profile, Provider } from '@/types/db';
import AdminSettings from '@/components/AdminSettings';
import OutputSettingsEditor, { type OutputSettingsValue } from '@/components/OutputSettingsEditor';
import { useUsdKrwRate } from '@/lib/exchangeRate';
import { loadTurnPriceWarning, saveTurnPriceWarning, type TurnPriceWarningCurrency } from '@/lib/turnPriceWarning';
import Toggle from '@/components/Toggle';

export default function SettingsPage() {
  const { user, signOut } = useAuth();
  const [keys, setKeys] = useState<ApiKeys>(loadApiKeys());
  const [profile, setProfile] = useState<Profile | null>(null);
  const [savedMsg, setSavedMsg] = useState('');
  const [activeSection, setActiveSection] = useState('appearance');
  const initialProvider: Provider = 'openrouter';
  const initialModel = modelsFor(initialProvider)[0];
  const [defaultReasoning, setDefaultReasoning] = useState<ReasoningSelection>(() => loadDefaultReasoning(initialProvider, initialModel));
  const [summaryReasoning, setSummaryReasoning] = useState<ReasoningSelection>({});
  const [checkingModels, setCheckingModels] = useState(false);
  const [defaultOutputSettings, setDefaultOutputSettings] = useState<OutputSettingsValue | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [turnPriceWarning, setTurnPriceWarning] = useState(loadTurnPriceWarning);
  const exchange = useUsdKrwRate();

  const [settingsLoadError, setSettingsLoadError] = useState('');
  const [settingsLoadAttempt, setSettingsLoadAttempt] = useState(0);

  const isAdmin = Boolean(ADMIN_EMAIL && user?.email === ADMIN_EMAIL);

  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    setSettingsLoadError('');
    supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .abortSignal(controller.signal)
      .single()
      .then(({ data, error }) => {
        if (controller.signal.aborted) return;
        if (error || !data) { setSettingsLoadError('계정 설정을 불러오지 못했습니다. 다시 불러와 주세요.'); return; }
        const loaded = data as Profile;
        setProfile({ ...loaded, default_provider: 'openrouter', default_model: toOpenRouterModel(loaded.default_provider, loaded.default_model) });
        setDefaultOutputSettings({
          outputTokens: loaded.default_output_tokens,
          reasoning: { ...(loaded.default_reasoning ?? loadDefaultReasoning('openrouter', loaded.default_model)), send: loaded.default_reasoning_enabled ?? true },
          temperature: loaded.default_temperature ?? 1,
          temperatureSend: loaded.default_temperature_enabled ?? false,
          frequencyPenalty: loaded.default_frequency_penalty ?? 0,
          frequencyPenaltySend: loaded.default_frequency_penalty_enabled ?? false,
        });
      });
    return () => controller.abort();
  }, [user?.id, settingsLoadAttempt]);

  useEffect(() => {
    if (!profile) return;
    const model = profile.default_model || modelsFor(profile.default_provider)[0];
    setDefaultReasoning(loadDefaultReasoning(profile.default_provider, model));
    setSummaryReasoning(normalizeReasoning(profile.summary_reasoning, 'openrouter', profile.summary_model || model));
  }, [profile?.id]);

  function saveKeys() {
    saveApiKeys(keys);
    flash('API 키를 저장했습니다.');
  }

  async function checkAccessibleModels() {
    if (!keys.openrouter.trim()) {
      flash('먼저 OpenRouter API 키를 입력하세요.');
      return;
    }
    setCheckingModels(true);
    try {
      const models = await discoverOpenRouterModels(keys.openrouter);
      flash(`OpenRouter에서 접근 가능한 모델 ${models.length}개를 확인했습니다.`);
    } catch (error) {
      flash(error instanceof Error ? error.message : 'OpenRouter 모델 목록 조회에 실패했습니다.');
    } finally {
      setCheckingModels(false);
    }
  }

  async function saveProfile() {
    if (!profile) return;
    const output = defaultOutputSettings;
    const { error } = await supabase
      .from('profiles')
      .update({
        display_name: profile.display_name,
        default_provider: 'openrouter',
        default_model: profile.default_model,
        default_output_tokens: output?.outputTokens ?? profile.default_output_tokens,
        default_temperature: output?.temperature ?? 1,
        default_temperature_enabled: output?.temperatureSend ?? false,
        default_frequency_penalty: output?.frequencyPenalty ?? 0,
        default_frequency_penalty_enabled: output?.frequencyPenaltySend ?? false,
        default_reasoning_enabled: output?.reasoning.send !== false,
        default_reasoning: output?.reasoning ?? defaultReasoning,
        summary_model: profile.summary_model,
        summary_reasoning: summaryReasoning,
        summary_level: profile.summary_level,
        summary_allow_omission: profile.summary_allow_omission,
        summary_parameters_enabled: profile.summary_parameters_enabled,
        summary_extra_note: profile.summary_extra_note,
        summary_source_mode: profile.summary_source_mode,
      })
      .eq('id', profile.id);
    if (error) { flash('프로필 저장 실패: ' + error.message); return; }
    saveDefaultReasoning(output?.reasoning ?? defaultReasoning);
    flash('프로필을 저장했습니다.');
  }

  async function changePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user?.email) {
      flash('이메일 계정 정보를 확인할 수 없습니다.');
      return;
    }
    if (!currentPassword || !newPassword) {
      flash('현재 비밀번호와 새 비밀번호를 모두 입력하세요.');
      return;
    }
    if (currentPassword === newPassword) {
      flash('새 비밀번호는 현재 비밀번호와 달라야 합니다.');
      return;
    }

    setChangingPassword(true);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: user.email,
      password: currentPassword,
    });
    if (signInError) {
      setChangingPassword(false);
      flash('현재 비밀번호가 올바르지 않습니다.');
      return;
    }

    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
    setChangingPassword(false);
    if (updateError) {
      flash(`비밀번호 변경 실패: ${updateError.message}`);
      return;
    }

    setCurrentPassword('');
    setNewPassword('');
    flash('비밀번호를 변경했습니다.');
  }

  function flash(msg: string) {
    setSavedMsg(msg);
    setTimeout(() => setSavedMsg(''), 2000);
  }

  function updateTurnPriceWarning(next: typeof turnPriceWarning) {
    setTurnPriceWarning(next);
    saveTurnPriceWarning(next);
  }

  function changeTurnPriceWarningCurrency(currency: TurnPriceWarningCurrency) {
    if (currency === turnPriceWarning.currency) return;
    const convertedThreshold = currency === 'KRW'
      ? Math.round(turnPriceWarning.threshold * exchange.rate)
      : Number((turnPriceWarning.threshold / exchange.rate).toFixed(6));
    updateTurnPriceWarning({ ...turnPriceWarning, currency, threshold: convertedThreshold });
  }

  return (
    <div className="settings-page flex flex-col gap-6 p-4" data-active-settings={activeSection}>
      <ModernPageHeading title="설정" description="화면, 모델과 대화 기본값을 관리합니다." />
      {settingsLoadError && <div role="alert" className="rounded-lg bg-surface p-3 text-sm text-amber-400"><p>{settingsLoadError}</p><button type="button" onClick={() => setSettingsLoadAttempt(value => value + 1)} className="mt-2 underline">설정 다시 불러오기</button></div>}
      <nav className="settings-navigation modern-only" aria-label="설정 분류">
        {([['appearance', '화면 · 테마', 'palette'], ['api', 'API · 모델', 'key'], ['output', '출력 설정', 'output'], ['summary', '요약 설정', 'summary'], ['cost', '가격 경고', 'cost'], ['account', '계정', 'my'], ...(isAdmin ? [['admin', '운영자', 'admin']] : [])] as [string, string, InterfaceIconName][]).map(([id, label, icon]) => <button type="button" key={id} aria-current={activeSection === id ? 'page' : undefined} onClick={() => setActiveSection(id)}><InterfaceIcon name={icon} />{label}</button>)}
      </nav>
      <div data-settings-section="appearance">
        <InterfacePreferences />
        {/* 계정 동기화 테마 */}
        <ThemePreferences userId={user!.id}/>
      </div>

      {/* 턴 가격 경고 */}
      <section data-settings-section="cost">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-white">턴 가격 경고</h2>
            <p className="mt-1 text-xs text-slate-500">설정한 금액 이상의 응답 가격을 노란색으로 표시합니다.</p>
          </div>
          <Toggle aria-label="턴 가격 경고" checked={turnPriceWarning.enabled}
            onChange={(enabled) => updateTurnPriceWarning({ ...turnPriceWarning, enabled })} />
        </div>
        <div className={`mt-3 rounded-xl bg-surface p-3 ${turnPriceWarning.enabled ? '' : 'opacity-50'}`}>
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-bg p-1" role="group" aria-label="턴 가격 경고 기준 통화">
            {(['USD', 'KRW'] as const).map((currency) => (
              <button
                key={currency}
                type="button"
                disabled={!turnPriceWarning.enabled}
                aria-pressed={turnPriceWarning.currency === currency}
                onClick={() => changeTurnPriceWarningCurrency(currency)}
                className={`rounded-md py-2 text-xs font-semibold ${turnPriceWarning.currency === currency ? 'bg-brand text-white' : 'text-slate-400'}`}
              >
                {currency === 'USD' ? '달러 ($)' : '원화 (₩)'}
              </button>
            ))}
          </div>
          <label className="mt-3 block text-xs text-slate-400">
            경고 기준 금액
            <div className="mt-1 flex items-center rounded-lg bg-surface2 px-3">
              <span className="text-sm text-slate-400">{turnPriceWarning.currency === 'USD' ? '$' : '₩'}</span>
              <input
                type="number"
                min="0"
                step={turnPriceWarning.currency === 'USD' ? '0.000001' : '1'}
                disabled={!turnPriceWarning.enabled}
                value={turnPriceWarning.threshold}
                onChange={(event) => updateTurnPriceWarning({ ...turnPriceWarning, threshold: Math.max(0, Number(event.target.value) || 0) })}
                className="w-full bg-transparent px-2 py-2.5 text-sm text-white outline-none disabled:cursor-not-allowed"
              />
            </div>
          </label>
        </div>
      </section>

      {/* API 키 */}
      <section data-settings-section="api">
        <h2 className="mb-1 font-semibold text-white">OpenRouter API 키</h2>
        <p className="mb-3 text-xs text-slate-500">
          키는 이 기기 브라우저에만 저장되며 서버로 전송되지 않습니다.
        </p>
        <div className="flex flex-col gap-3">
              <div className="rounded-lg border border-brand/40 bg-brand/5 p-3">
                <div className="mb-1 flex items-center gap-2">
                  <label className="text-sm font-semibold text-white">OpenRouter</label>
                  <span className="rounded-full bg-brand px-2 py-0.5 text-[10px] font-bold text-white">전용</span>
                </div>
                <p className="mb-2 text-[11px] text-slate-400">
                  키 하나로 Claude·Gemini·GPT 등 모든 모델 사용 가능.{' '}
                  <a
                    href="https://openrouter.ai/keys"
                    target="_blank"
                    rel="noreferrer"
                    className="text-brand underline"
                  >
                    키 발급받기 →
                  </a>
                </p>
                <input
                  type="password"
                  value={keys.openrouter}
                  onChange={(e) => setKeys({ openrouter: e.target.value })}
                  placeholder="OpenRouter API 키 입력"
                  className="w-full rounded-lg bg-surface px-4 py-3 text-sm outline-none"
                />
              </div>
          <button onClick={saveKeys} className="rounded-lg bg-brand py-2.5 text-sm font-semibold text-white">
            API 키 저장
          </button>
          <button type="button" disabled={checkingModels} onClick={() => void checkAccessibleModels()} className="rounded-lg bg-surface2 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
            {checkingModels ? '접근 가능한 모델 확인 중…' : 'API 계정의 모델 접근 확인'}
          </button>
          <p className="text-[11px] text-slate-500">키는 로그에 출력하지 않으며 OpenRouter API 요청에만 사용합니다.</p>
        </div>
      </section>

      {/* 기본 출력 설정 */}
      {profile && (
        <section data-settings-section="output">
          <h2 className="mb-3 font-semibold text-white">기본 출력 설정</h2>
          <div className="flex flex-col gap-3">
            <div className="rounded-lg bg-surface px-4 py-3 text-sm">
              <p className="text-xs text-slate-400">AI 공급사</p>
              <p className="mt-1 font-semibold text-white">OpenRouter 전용</p>
            </div>
            <ModelSelector
              provider="openrouter"
              model={profile.default_model || modelsFor('openrouter')[0]}
              reasoning={defaultReasoning}
              onModelChange={(model) => setProfile({ ...profile, default_model: model })}
              onReasoningChange={setDefaultReasoning}
              hideReasoning
            />
            {defaultOutputSettings && <OutputSettingsEditor value={defaultOutputSettings} onChange={(value) => { setDefaultOutputSettings(value); setDefaultReasoning(value.reasoning); }} tokenLabel="기본 출력량" />}
            <button onClick={saveProfile} className="rounded-lg bg-brand py-2.5 text-sm font-semibold text-white">
              저장
            </button>
          </div>
        </section>
      )}

      {profile && (
        <section data-settings-section="summary">
          <h2 className="mb-1 font-semibold text-white">요약 설정</h2>
          <p className="mb-3 text-xs text-slate-500">요약 지시문은 관리자 설정의 전역 요약 프롬프트를 공통으로 사용합니다.</p>
          <div className="mt-4 flex flex-col gap-3 rounded-xl bg-surface p-3">
            <p className="text-sm font-semibold text-slate-200">요약 모델 · 입력 범위</p>
            <ModelSelector
              provider="openrouter"
              model={profile.summary_model || profile.default_model || modelsFor('openrouter')[0]}
              reasoning={summaryReasoning}
              onModelChange={(summary_model) => setProfile({ ...profile, summary_model })}
              onReasoningChange={setSummaryReasoning}
            />
            <label className="text-xs text-slate-400">요약 입력 범위
              <select value={profile.summary_source_mode ?? 'incremental'} onChange={(e) => setProfile({ ...profile, summary_source_mode: e.target.value as 'incremental' | 'full' })} className="mt-1 w-full rounded-lg bg-surface2 px-3 py-2 text-sm text-white outline-none">
                <option value="incremental">이전 요약 + 이후 메시지</option>
                <option value="full">이전 요약 제외 + 세션 전체 메시지</option>
              </select>
            </label>
            <label className="text-xs text-slate-400">Summary level (0~10)
              <input type="number" min={0} max={10} value={profile.summary_level ?? 5} onChange={(e) => setProfile({ ...profile, summary_level: Math.max(0, Math.min(10, Number(e.target.value) || 0)) })} className="mt-1 w-full rounded-lg bg-surface2 px-3 py-2 text-sm text-white outline-none" />
            </label>
            <label className="flex items-center justify-between text-xs text-slate-300"><span>Allow omission</span><input type="checkbox" checked={profile.summary_allow_omission ?? true} onChange={(e) => setProfile({ ...profile, summary_allow_omission: e.target.checked })} /></label>
            <label className="flex items-center justify-between text-xs text-slate-300"><span>요약 파라미터 함께 전송</span><input type="checkbox" checked={profile.summary_parameters_enabled ?? true} onChange={(e) => setProfile({ ...profile, summary_parameters_enabled: e.target.checked })} /></label>
            <label className="text-xs text-slate-400">요약 생성 시 함께 전송할 추가 메모
              <textarea rows={4} value={profile.summary_extra_note ?? ''} onChange={(e) => setProfile({ ...profile, summary_extra_note: e.target.value })} className="mt-1 w-full rounded-lg bg-surface2 p-3 text-sm text-white outline-none" placeholder="요약 모델에 추가로 전달할 지침" />
            </label>
          </div>
          <button type="button" onClick={() => void saveProfile()} className="mt-2 w-full rounded-lg bg-brand py-2.5 text-sm font-semibold text-white">요약 설정 저장</button>
        </section>
      )}

      {isAdmin && <AdminSettings />}

      {user && (
        <section data-settings-section="account" className="border-t border-slate-700 pt-6">
          <h2 className="mb-1 font-semibold text-white">비밀번호 변경</h2>
          <p className="mb-3 text-xs text-slate-500">
            현재 비밀번호를 확인한 뒤 새 비밀번호로 변경합니다.
          </p>
          <form onSubmit={(event) => void changePassword(event)} className="flex flex-col gap-2">
            <label className="text-xs text-slate-400">
              현재 비밀번호
              <input
                type="password"
                required
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                placeholder="현재 비밀번호"
                disabled={changingPassword}
                className="mt-1 w-full rounded-lg bg-surface px-3 py-2.5 text-sm text-white outline-none disabled:opacity-50"
              />
            </label>
            <label className="text-xs text-slate-400">
              새 비밀번호
              <input
                type="password"
                required
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                placeholder="새 비밀번호"
                disabled={changingPassword}
                className="mt-1 w-full rounded-lg bg-surface px-3 py-2.5 text-sm text-white outline-none disabled:opacity-50"
              />
            </label>
            <button
              type="submit"
              disabled={changingPassword}
              className="mt-1 rounded-lg bg-brand py-2.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              {changingPassword ? '변경 중…' : '비밀번호 변경'}
            </button>
          </form>
        </section>
      )}

      {savedMsg && (
        <div className="toast-enter pointer-events-none fixed inset-x-0 top-6 z-50 flex justify-center px-4">
          <div className="rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-white shadow-lg">
            {savedMsg}
          </div>
        </div>
      )}

      <button data-settings-section="account" onClick={() => signOut()} className="mt-2 text-sm text-red-400">
        로그아웃
      </button>

      <p data-settings-section="account" className="pb-2 text-center text-[11px] text-slate-600">v0.2.0</p>
    </div>
  );
}
