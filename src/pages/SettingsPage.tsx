import { useEffect, useState } from 'react';
import { supabase, ADMIN_EMAIL } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { loadApiKeys, saveApiKeys, type ApiKeys } from '@/lib/apiKeys';
import { DEFAULT_MODELS, PROVIDER_LABELS } from '@/lib/llm/types';
import type { Persona, Profile, Provider } from '@/types/db';

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

  // 페르소나
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [editingPersona, setEditingPersona] = useState<Persona | null>(null);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);

  useEffect(() => {
    if (isGuest || !user) return;
    supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single()
      .then(({ data }) => setProfile(data as Profile));
    supabase
      .from('personas')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at')
      .then(({ data }) => setPersonas((data as Persona[]) ?? []));
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

  async function addPersona() {
    if (!newName.trim() || !user) return;
    const isFirst = personas.length === 0;
    const { data, error } = await supabase
      .from('personas')
      .insert({ user_id: user.id, name: newName.trim(), description: newDesc.trim(), is_default: isFirst })
      .select('*')
      .single();
    if (error) { flash('저장 실패: ' + error.message); return; }
    setPersonas((p) => [...p, data as Persona]);
    setNewName('');
    setNewDesc('');
    setShowAddForm(false);
  }

  async function updatePersona() {
    if (!editingPersona) return;
    const { error } = await supabase
      .from('personas')
      .update({ name: editingPersona.name, description: editingPersona.description })
      .eq('id', editingPersona.id);
    if (error) { flash('저장 실패: ' + error.message); return; }
    setPersonas((p) => p.map((x) => (x.id === editingPersona.id ? editingPersona : x)));
    setEditingPersona(null);
  }

  async function deletePersona(id: string) {
    await supabase.from('personas').delete().eq('id', id);
    const remaining = personas.filter((x) => x.id !== id);
    if (remaining.length > 0 && !remaining.some((x) => x.is_default)) {
      await supabase.from('personas').update({ is_default: true }).eq('id', remaining[0].id);
      remaining[0] = { ...remaining[0], is_default: true };
    }
    setPersonas(remaining);
  }

  async function setDefaultPersona(id: string) {
    await supabase.from('personas').update({ is_default: false }).eq('user_id', user!.id);
    await supabase.from('personas').update({ is_default: true }).eq('id', id);
    setPersonas((ps) => ps.map((p) => ({ ...p, is_default: p.id === id })));
    flash('기본 페르소나로 설정했습니다.');
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

      {/* 프로필 */}
      {!isGuest && profile && (
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

      {/* 페르소나 */}
      {!isGuest && (
        <section>
          <div className="mb-3 flex items-center">
            <h2 className="font-semibold text-white">페르소나</h2>
            <button
              onClick={() => { setShowAddForm((v) => !v); setEditingPersona(null); }}
              className="ml-auto text-sm text-brand"
            >
              {showAddForm ? '취소' : '+ 추가'}
            </button>
          </div>

          {showAddForm && (
            <div className="mb-3 flex flex-col gap-2 rounded-lg bg-surface p-3">
              <div>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="이름 (예: 기사 아르투스)"
                  className={`w-full rounded-lg bg-surface2 px-3 py-2 text-sm outline-none ring-1 ${newName.length > 20 ? 'ring-red-500 text-red-300' : 'ring-transparent'}`}
                />
                <p className={`mt-0.5 text-right text-[11px] ${newName.length > 20 ? 'text-red-400' : 'text-slate-500'}`}>{newName.length}/20</p>
              </div>
              <div>
                <textarea
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="설명 (예: 나는 중세 기사로 행동한다. 존댓말을 쓴다.)"
                  rows={3}
                  className={`w-full resize-none rounded-lg bg-surface2 px-3 py-2 text-sm outline-none ring-1 ${newDesc.length > 500 ? 'ring-red-500 text-red-300' : 'ring-transparent'}`}
                />
                <p className={`mt-0.5 text-right text-[11px] ${newDesc.length > 500 ? 'text-red-400' : 'text-slate-500'}`}>{newDesc.length}/500</p>
              </div>
              <button
                onClick={addPersona}
                disabled={!newName.trim() || newName.length > 20 || newDesc.length > 500}
                className="rounded-lg bg-brand py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                저장
              </button>
            </div>
          )}

          {personas.length === 0 && !showAddForm && (
            <p className="text-sm text-slate-500">아직 페르소나가 없습니다.</p>
          )}

          <ul className="flex flex-col gap-2">
            {personas.map((p) =>
              editingPersona?.id === p.id ? (
                <li key={p.id} className="flex flex-col gap-2 rounded-lg bg-surface p-3">
                  <div>
                    <input
                      value={editingPersona.name}
                      onChange={(e) => setEditingPersona({ ...editingPersona, name: e.target.value })}
                      className={`w-full rounded-lg bg-surface2 px-3 py-2 text-sm outline-none ring-1 ${editingPersona.name.length > 20 ? 'ring-red-500 text-red-300' : 'ring-transparent'}`}
                    />
                    <p className={`mt-0.5 text-right text-[11px] ${editingPersona.name.length > 20 ? 'text-red-400' : 'text-slate-500'}`}>{editingPersona.name.length}/20</p>
                  </div>
                  <div>
                    <textarea
                      value={editingPersona.description}
                      onChange={(e) => setEditingPersona({ ...editingPersona, description: e.target.value })}
                      rows={3}
                      className={`w-full resize-none rounded-lg bg-surface2 px-3 py-2 text-sm outline-none ring-1 ${editingPersona.description.length > 500 ? 'ring-red-500 text-red-300' : 'ring-transparent'}`}
                    />
                    <p className={`mt-0.5 text-right text-[11px] ${editingPersona.description.length > 500 ? 'text-red-400' : 'text-slate-500'}`}>{editingPersona.description.length}/500</p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={updatePersona}
                      disabled={editingPersona.name.length > 20 || editingPersona.description.length > 500}
                      className="flex-1 rounded-lg bg-brand py-2 text-sm font-semibold text-white disabled:opacity-50"
                    >
                      저장
                    </button>
                    <button onClick={() => setEditingPersona(null)} className="rounded-lg bg-surface2 px-4 py-2 text-sm text-slate-300">
                      취소
                    </button>
                  </div>
                </li>
              ) : (
                <li key={p.id} className="flex items-start gap-2 rounded-lg bg-surface p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="font-semibold text-white">{p.name}</p>
                      {p.is_default && <span className="rounded bg-brand/20 px-1.5 py-0.5 text-[10px] text-brand">기본</span>}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-xs text-slate-400">{p.description}</p>
                  </div>
                  {!p.is_default && (
                    <button onClick={() => setDefaultPersona(p.id)} title="기본으로 설정" className="shrink-0 px-1 text-slate-600 text-base leading-none">
                      ☆
                    </button>
                  )}
                  <button onClick={() => { setEditingPersona(p); setShowAddForm(false); }} className="shrink-0 px-1 text-slate-400">
                    ✏️
                  </button>
                  <button onClick={() => deletePersona(p.id)} className="shrink-0 px-1 text-red-400">
                    ✕
                  </button>
                </li>
              )
            )}
          </ul>
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
    </div>
  );
}
