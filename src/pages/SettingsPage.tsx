import { useEffect, useState } from 'react';
import { supabase, ADMIN_EMAIL } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { loadApiKeys, saveApiKeys, type ApiKeys } from '@/lib/apiKeys';
import { DEFAULT_MODELS, PROVIDER_LABELS } from '@/lib/llm/types';
import type { Profile, Provider } from '@/types/db';

const PROVIDERS: Provider[] = ['claude', 'gemini', 'openai'];
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

  const isAdmin = Boolean(ADMIN_EMAIL && user?.email === ADMIN_EMAIL);

  // 관리자 전역 시스템 프롬프트
  const [systemPrompt, setSystemPrompt] = useState('');
  const [systemPromptLoaded, setSystemPromptLoaded] = useState(false);

  useEffect(() => {
    if (isGuest || !user) return;
    supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single()
      .then(({ data }) => setProfile(data as Profile));
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

  function saveKeys() {
    saveApiKeys(keys);
    flash('API 키를 이 기기에 저장했습니다.');
  }

  async function saveProfile() {
    if (!profile) return;
    await supabase
      .from('profiles')
      .update({
        display_name: profile.display_name,
        default_provider: profile.default_provider,
        default_model: profile.default_model,
        default_output_tokens: profile.default_output_tokens,
      })
      .eq('id', profile.id);
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

  function flash(msg: string) {
    setSavedMsg(msg);
    setTimeout(() => setSavedMsg(''), 2000);
  }

  return (
    <div className="flex flex-col gap-6 p-4">
      {/* API 키 */}
      <section>
        <h2 className="mb-1 font-semibold text-white">API 키</h2>
        <p className="mb-3 text-xs text-slate-500">
          키는 이 기기 브라우저에만 저장되며 서버로 전송되지 않습니다.
        </p>
        <div className="flex flex-col gap-3">
          {PROVIDERS.map((p) => (
            <div key={p}>
              <label className="mb-1 block text-xs text-slate-400">{PROVIDER_LABELS[p]}</label>
              <input
                type="password"
                value={keys[p]}
                onChange={(e) => setKeys((k) => ({ ...k, [p]: e.target.value }))}
                placeholder="API 키 입력"
                className="w-full rounded-lg bg-surface px-4 py-3 text-sm outline-none"
              />
            </div>
          ))}
          <button onClick={saveKeys} className="rounded-lg bg-brand py-2.5 text-sm font-semibold text-white">
            API 키 저장
          </button>
        </div>
      </section>

      {/* 기본 출력 설정 */}
      {!isGuest && profile && (
        <section>
          <h2 className="mb-3 font-semibold text-white">기본 출력 설정</h2>
          <div className="flex flex-col gap-3">
            <div>
              <label className="mb-1 block text-xs text-slate-400">기본 공급사</label>
              <select
                value={profile.default_provider}
                onChange={(e) =>
                  setProfile({ ...profile, default_provider: e.target.value as Provider, default_model: '' })
                }
                className="w-full rounded-lg bg-surface px-4 py-3 text-sm outline-none"
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-400">기본 모델</label>
              <select
                value={profile.default_model || DEFAULT_MODELS[profile.default_provider][0]}
                onChange={(e) => setProfile({ ...profile, default_model: e.target.value })}
                className="w-full rounded-lg bg-surface px-4 py-3 text-sm outline-none"
              >
                {DEFAULT_MODELS[profile.default_provider].map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
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
        <p className="rounded-lg bg-surface px-4 py-2 text-center text-sm text-brand">{savedMsg}</p>
      )}

      <button onClick={() => signOut()} className="mt-2 text-sm text-red-400">
        {isGuest ? '비회원 모드 종료' : '로그아웃'}
      </button>

      <p className="pb-2 text-center text-[11px] text-slate-600">v0.1.0</p>
    </div>
  );
}
