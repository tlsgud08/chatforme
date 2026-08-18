import { useEffect, useState } from 'react';
import { supabase, ADMIN_EMAIL } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { loadApiKeys, saveApiKeys, type ApiKeys } from '@/lib/apiKeys';
import type { ReasoningSelection } from '@/lib/llm/types';
import { discoverOpenRouterModels } from '@/lib/llm/modelDiscovery';
import { loadDefaultReasoning, modelsFor, saveDefaultReasoning, toOpenRouterModel } from '@/lib/modelPreferences';
import ModelSelector from '@/components/ModelSelector';
import { loadTheme, saveTheme, type Theme } from '@/lib/theme';
import type { Profile, Provider } from '@/types/db';

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

export default function SettingsPage() {
  const { user, isGuest, signOut } = useAuth();
  const [keys, setKeys] = useState<ApiKeys>(loadApiKeys());
  const [profile, setProfile] = useState<Profile | null>(null);
  const [savedMsg, setSavedMsg] = useState('');
  const initialProvider: Provider = 'openrouter';
  const initialModel = modelsFor(initialProvider)[0];
  const [defaultReasoning, setDefaultReasoning] = useState<ReasoningSelection>(() => loadDefaultReasoning(initialProvider, initialModel));
  const [masterPassword, setMasterPassword] = useState('');
  const [masterPasswordConfirm, setMasterPasswordConfirm] = useState('');
  const [theme, setTheme] = useState<Theme>(loadTheme());
  const [checkingModels, setCheckingModels] = useState(false);

  const isAdmin = Boolean(ADMIN_EMAIL && user?.email === ADMIN_EMAIL);

  const [systemPrompt, setSystemPrompt] = useState('');
  const [systemPromptLoaded, setSystemPromptLoaded] = useState(false);

  useEffect(() => {
    if (isGuest || !user) return;
    supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single()
      .then(({ data }) => {
        const loaded = data as Profile;
        setProfile({ ...loaded, default_provider: 'openrouter', default_model: toOpenRouterModel(loaded.default_provider, loaded.default_model) });
      });
    if (user.email === ADMIN_EMAIL && ADMIN_EMAIL) {
      supabase
        .from('platform_config')
        .select('system_prompt')
        .eq('id', 1)
        .single()
        .then(({ data }) => {
          setSystemPrompt(data?.system_prompt ?? '');
          setSystemPromptLoaded(true);
        });
    }
  }, [user, isGuest]);

  useEffect(() => {
    if (!profile) return;
    const model = profile.default_model || modelsFor(profile.default_provider)[0];
    setDefaultReasoning(loadDefaultReasoning(profile.default_provider, model));
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
    await supabase
      .from('profiles')
      .update({
        display_name: profile.display_name,
        default_provider: 'openrouter',
        default_model: profile.default_model,
        default_output_tokens: profile.default_output_tokens,
      })
      .eq('id', profile.id);
    saveDefaultReasoning(defaultReasoning);
    flash('프로필을 저장했습니다.');
  }

  async function saveSystemPrompt() {
    const { error } = await supabase
      .from('platform_config')
      .update({ system_prompt: systemPrompt, updated_at: new Date().toISOString() })
      .eq('id', 1);
    if (error) { flash('저장 실패: ' + error.message); return; }
    flash('전역 시스템 프롬프트를 저장했습니다.');
  }

  async function saveMasterPassword() {
    if (masterPassword.length < 8) {
      flash('마스터 비밀번호는 8자 이상이어야 합니다.');
      return;
    }
    if (masterPassword !== masterPasswordConfirm) {
      flash('마스터 비밀번호 확인이 일치하지 않습니다.');
      return;
    }
    const { error } = await supabase.rpc('set_signup_master_password', {
      new_password: masterPassword,
    });
    if (error) { flash('저장 실패: ' + error.message); return; }
    setMasterPassword('');
    setMasterPasswordConfirm('');
    flash('회원가입 마스터 비밀번호를 변경했습니다.');
  }

  function flash(msg: string) {
    setSavedMsg(msg);
    setTimeout(() => setSavedMsg(''), 2000);
  }

  function changeTheme(nextTheme: Theme) {
    setTheme(nextTheme);
    saveTheme(nextTheme);
  }

  return (
    <div className="flex flex-col gap-6 p-4">
      {/* 화면 테마 */}
      <section>
        <h2 className="mb-1 font-semibold text-white">화면 테마</h2>
        <p className="mb-3 text-xs text-slate-500">
          선택한 테마는 이 기기에 저장됩니다.
        </p>
        <div className="grid grid-cols-2 gap-2 rounded-xl bg-surface p-1.5" role="group" aria-label="화면 테마 선택">
          {(['dark', 'light'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={theme === option}
              onClick={() => changeTheme(option)}
              className={`rounded-lg px-3 py-2.5 text-sm font-semibold ${
                theme === option ? 'bg-brand text-white shadow-sm' : 'text-slate-400'
              }`}
            >
              {option === 'dark' ? '🌙 다크' : '☀️ 라이트'}
            </button>
          ))}
        </div>
      </section>

      {/* API 키 */}
      <section>
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
      {!isGuest && profile && (
        <section>
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
            />
            <div>
              <label className="mb-1 block text-xs text-slate-400">
                기본 출력량: {tokenLabel(profile.default_output_tokens)}
              </label>
              <input
                type="range"
                min={256}
                max={SLIDER_MAX}
                step={128}
                value={tokensToSlider(profile.default_output_tokens)}
                onChange={(e) =>
                  setProfile({ ...profile, default_output_tokens: sliderToTokens(Number(e.target.value)) })
                }
                className="w-full"
              />
            </div>
            <button onClick={saveProfile} className="rounded-lg bg-brand py-2.5 text-sm font-semibold text-white">
              저장
            </button>
          </div>
        </section>
      )}

      {isAdmin && (
        <section className="rounded-lg border border-brand/30 bg-brand/5 p-4">
          <h2 className="mb-1 font-semibold text-brand">관리자 — 회원가입 마스터 비밀번호</h2>
          <p className="mb-3 text-xs text-slate-400">
            새로운 회원은 회원가입할 때 이 비밀번호를 입력해야 합니다. 기존 회원의 로그인에는 영향을 주지 않습니다.
          </p>
          <div className="flex flex-col gap-2">
            <input
              type="password"
              autoComplete="new-password"
              value={masterPassword}
              onChange={(e) => setMasterPassword(e.target.value)}
              placeholder="새 마스터 비밀번호 (8자 이상)"
              className="rounded-lg bg-surface px-3 py-2.5 text-sm text-white outline-none"
            />
            <input
              type="password"
              autoComplete="new-password"
              value={masterPasswordConfirm}
              onChange={(e) => setMasterPasswordConfirm(e.target.value)}
              placeholder="새 마스터 비밀번호 확인"
              className="rounded-lg bg-surface px-3 py-2.5 text-sm text-white outline-none"
            />
            <button
              onClick={() => void saveMasterPassword()}
              className="rounded-lg bg-brand py-2.5 text-sm font-semibold text-white"
            >
              마스터 비밀번호 저장
            </button>
          </div>
        </section>
      )}

      {/* 관리자 전용: 전역 시스템 프롬프트 */}
      {isAdmin && systemPromptLoaded && (
        <section className="rounded-lg border border-yellow-600/30 bg-yellow-950/20 p-4">
          <h2 className="mb-1 font-semibold text-yellow-400">관리자 — 전역 시스템 프롬프트</h2>
          <p className="mb-3 text-xs text-yellow-600/70">
            모든 채팅에 공통 적용되는 최상단 지시문입니다. 신중하게 편집하세요.
          </p>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={8}
            placeholder="예: 당신은 성인 롤플레이 서비스의 AI 캐릭터입니다. 항상 캐릭터 설정을 유지하세요."
            className="w-full resize-y rounded-lg bg-surface px-3 py-2.5 text-sm text-white outline-none"
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-slate-500">{systemPrompt.length}자</span>
            <button
              onClick={saveSystemPrompt}
              className="rounded-lg bg-yellow-600 px-4 py-2 text-sm font-semibold text-white"
            >
              저장
            </button>
          </div>
        </section>
      )}

      {savedMsg && (
        <div className="toast-enter pointer-events-none fixed inset-x-0 top-6 z-50 flex justify-center px-4">
          <div className="rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-white shadow-lg">
            {savedMsg}
          </div>
        </div>
      )}

      <button onClick={() => signOut()} className="mt-2 text-sm text-red-400">
        {isGuest ? '비회원 모드 종료' : '로그아웃'}
      </button>

      <p className="pb-2 text-center text-[11px] text-slate-600">v0.2.0</p>
    </div>
  );
}
