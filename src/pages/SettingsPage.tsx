import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { loadApiKeys, saveApiKeys, type ApiKeys } from '@/lib/apiKeys';
import { DEFAULT_MODELS, PROVIDER_LABELS } from '@/lib/llm/types';
import type { Profile, Provider } from '@/types/db';

const PROVIDERS: Provider[] = ['claude', 'gemini', 'openai'];

export default function SettingsPage() {
  const { user, signOut } = useAuth();
  const [keys, setKeys] = useState<ApiKeys>(loadApiKeys());
  const [profile, setProfile] = useState<Profile | null>(null);
  const [savedMsg, setSavedMsg] = useState('');

  useEffect(() => {
    supabase
      .from('profiles')
      .select('*')
      .eq('id', user!.id)
      .single()
      .then(({ data }) => setProfile(data as Profile));
  }, [user]);

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

      {/* 기본 출력량 & 모델 */}
      {profile && (
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
                  <option key={p} value={p}>
                    {PROVIDER_LABELS[p]}
                  </option>
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
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-400">
                기본 출력량 (최대 출력 토큰): {profile.default_output_tokens}
              </label>
              <input
                type="range"
                min={256}
                max={4096}
                step={128}
                value={profile.default_output_tokens}
                onChange={(e) =>
                  setProfile({ ...profile, default_output_tokens: Number(e.target.value) })
                }
                className="w-full"
              />
            </div>
            <button
              onClick={saveProfile}
              className="rounded-lg bg-brand py-2.5 text-sm font-semibold text-white"
            >
              저장
            </button>
          </div>
        </section>
      )}

      {/* 프로필 / 계정 */}
      {profile && (
        <section>
          <h2 className="mb-3 font-semibold text-white">프로필</h2>
          <label className="mb-1 block text-xs text-slate-400">표시 이름</label>
          <input
            value={profile.display_name}
            onChange={(e) => setProfile({ ...profile, display_name: e.target.value })}
            onBlur={saveProfile}
            className="w-full rounded-lg bg-surface px-4 py-3 text-sm outline-none"
          />
          <p className="mt-2 text-xs text-slate-500">{user?.email}</p>
        </section>
      )}

      <section>
        <h2 className="mb-2 font-semibold text-white">페르소나</h2>
        <p className="text-sm text-slate-500">페르소나 설정은 Phase 2에서 추가됩니다.</p>
      </section>

      {savedMsg && (
        <p className="rounded-lg bg-surface px-4 py-2 text-center text-sm text-brand">{savedMsg}</p>
      )}

      <button onClick={() => signOut()} className="mt-2 text-sm text-red-400">
        로그아웃
      </button>
    </div>
  );
}
