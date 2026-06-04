import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { getApiKey } from '@/lib/apiKeys';
import type { Persona, Profile } from '@/types/db';

interface OpenRouterCredit {
  remaining: number | null;
  usage: number;
  limit: number | null;
}

export default function MyPage() {
  const { user, isGuest } = useAuth();
  const navigate = useNavigate();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [savedMsg, setSavedMsg] = useState('');

  const [credit, setCredit] = useState<OpenRouterCredit | null>(null);
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
  }, [user, isGuest]);

  useEffect(() => {
    const apiKey = getApiKey('openrouter');
    if (!apiKey) return;
    fetch('https://openrouter.ai/api/v1/auth/key', {
      headers: { authorization: `Bearer ${apiKey}` },
    })
      .then((r) => r.json())
      .then((data) => {
        const d = data?.data;
        if (!d) return;
        setCredit({ remaining: d.limit_remaining ?? null, usage: d.usage ?? 0, limit: d.limit ?? null });
      })
      .catch(() => {});
  }, []);

  async function saveProfile() {
    if (!profile) return;
    await supabase.from('profiles').update({ display_name: profile.display_name }).eq('id', profile.id);
    flash('저장했습니다.');
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

  function flash(msg: string) {
    setSavedMsg(msg);
    setTimeout(() => setSavedMsg(''), 2000);
  }

  if (isGuest) {
    return (
      <div className="flex flex-col items-center gap-4 p-8 text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-surface2 text-4xl">👤</div>
        <p className="font-semibold text-white">비회원 모드</p>
        <p className="text-sm text-slate-400">로그인하면 프로필·페르소나·팔로우·하트를 사용할 수 있습니다.</p>
        <button
          onClick={() => navigate('/login')}
          className="mt-2 rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white"
        >
          로그인
        </button>
      </div>
    );
  }

  const initial = profile?.display_name?.[0]?.toUpperCase() ?? user?.email?.[0]?.toUpperCase() ?? '?';

  return (
    <div className="flex flex-col gap-6 p-4">
      {/* 프로필 카드 */}
      <section className="flex flex-col items-center gap-3 rounded-xl bg-surface p-5">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-brand/20 text-3xl font-bold text-brand">
          {initial}
        </div>
        <div className="w-full text-center">
          <input
            value={profile?.display_name ?? ''}
            onChange={(e) => profile && setProfile({ ...profile, display_name: e.target.value })}
            onBlur={saveProfile}
            className="w-full rounded-lg bg-surface2 px-3 py-2 text-center text-lg font-semibold text-white outline-none"
            placeholder="표시 이름"
          />
          <p className="mt-1 text-xs text-slate-500">{user?.email}</p>
        </div>
      </section>

      {/* OpenRouter 크레딧 */}
      {credit && (
        <section className="rounded-xl bg-surface p-4">
          <p className="mb-1 text-xs font-semibold text-slate-400">OpenRouter 크레딧</p>
          {credit.remaining !== null ? (
            <div className="flex items-center justify-between">
              <p className="text-lg font-bold text-white">
                ${credit.remaining.toFixed(3)}
                <span className="ml-1 text-xs font-normal text-slate-400">잔여</span>
              </p>
              {credit.limit !== null && (
                <p className="text-xs text-slate-500">
                  총 ${credit.limit.toFixed(2)} 중 ${credit.usage.toFixed(3)} 사용
                </p>
              )}
            </div>
          ) : (
            <p className="text-lg font-bold text-white">
              ${credit.usage.toFixed(3)}
              <span className="ml-1 text-xs font-normal text-slate-400">사용됨 (무제한)</span>
            </p>
          )}
        </section>
      )}

      {/* 메뉴 */}
      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">활동</h2>
        <ul className="overflow-hidden rounded-xl bg-surface divide-y divide-surface2">
          <li>
            <button
              onClick={() => navigate('/favorites')}
              className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
            >
              <span className="text-xl">❤️</span>
              <span className="flex-1 text-sm text-white">하트 목록</span>
              <span className="text-slate-500">›</span>
            </button>
          </li>
          <li>
            <button
              disabled
              className="flex w-full items-center gap-3 px-4 py-3.5 text-left opacity-40"
            >
              <span className="text-xl">👥</span>
              <span className="flex-1 text-sm text-white">팔로우</span>
              <span className="text-[10px] text-slate-500">추후 지원 예정</span>
            </button>
          </li>
        </ul>
      </section>

      {/* 페르소나 */}
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

      {savedMsg && (
        <p className="rounded-lg bg-surface px-4 py-2 text-center text-sm text-brand">{savedMsg}</p>
      )}
    </div>
  );
}
