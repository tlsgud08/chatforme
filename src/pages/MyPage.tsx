import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { getApiKey } from '@/lib/apiKeys';
import { getUsdToKrw, toKrw } from '@/lib/exchangeRate';
import type { Persona, Profile } from '@/types/db';

const KRW_KEY = 'chatforme.showKrw';

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
  const [bio, setBio] = useState('');
  const [avatarUploading, setAvatarUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [credit, setCredit] = useState<OpenRouterCredit | null>(null);
  const [showKrw, setShowKrw] = useState(() => localStorage.getItem(KRW_KEY) === 'true');
  const [krwRate, setKrwRate] = useState<number | null>(null);
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
      .then(({ data }) => {
        const p = data as Profile;
        setProfile(p);
        setBio(p?.bio ?? '');
      });
    supabase
      .from('personas')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at')
      .then(({ data }) => {
        const ps = (data as Persona[]) ?? [];
        setPersonas(ps.sort((a, b) => (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0)));
      });
  }, [user, isGuest]);

  useEffect(() => {
    if (!showKrw) return;
    getUsdToKrw().then(setKrwRate);
  }, [showKrw]);

  function toggleKrw(v: boolean) {
    setShowKrw(v);
    localStorage.setItem(KRW_KEY, String(v));
    if (v) getUsdToKrw().then(setKrwRate);
  }

  useEffect(() => {
    const apiKey = getApiKey('openrouter');
    if (!apiKey) return;
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
        setCredit({ remaining: total - used, usage: used, limit: total });
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
    setPersonas((ps) => {
      const updated = ps.map((p) => ({ ...p, is_default: p.id === id }));
      return [...updated].sort((a, b) => (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0));
    });
    flash('기본 페르소나로 설정했습니다.');
  }

  function flash(msg: string) {
    setSavedMsg(msg);
    setTimeout(() => setSavedMsg(''), 2000);
  }

  const { data: followerCountData } = useQuery({
    queryKey: ['follower-count', user?.id],
    queryFn: async () => {
      if (!user) return 0;
      const { count } = await supabase
        .from('user_follows')
        .select('*', { count: 'exact', head: true })
        .eq('following_id', user.id);
      return count ?? 0;
    },
    enabled: !!user && !isGuest,
  });

  const { data: followingCountData } = useQuery({
    queryKey: ['following-count', user?.id],
    queryFn: async () => {
      if (!user) return 0;
      const { count } = await supabase
        .from('user_follows')
        .select('*', { count: 'exact', head: true })
        .eq('follower_id', user.id);
      return count ?? 0;
    },
    enabled: !!user && !isGuest,
  });

  async function uploadAvatar(file: File) {
    if (!user || !profile) return;
    if (file.size > 5 * 1024 * 1024) {
      flash('5MB 이하 이미지만 업로드 가능합니다.');
      return;
    }
    setAvatarUploading(true);
    const { data, error } = await supabase.storage
      .from('avatars')
      .upload(`${user.id}/${Date.now()}`, file, { upsert: true, contentType: file.type });
    if (error) {
      flash('업로드 실패: ' + error.message);
      setAvatarUploading(false);
      return;
    }
    const publicUrl = supabase.storage.from('avatars').getPublicUrl(data.path).data.publicUrl;
    await supabase.from('profiles').update({ avatar_url: publicUrl }).eq('id', user.id);
    setProfile({ ...profile, avatar_url: publicUrl });
    setAvatarUploading(false);
    flash('프로필 사진을 업데이트했습니다.');
  }

  async function saveBio() {
    if (!profile) return;
    const trimmed = bio.slice(0, 500);
    await supabase.from('profiles').update({ bio: trimmed }).eq('id', profile.id);
    setProfile({ ...profile, bio: trimmed });
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
        {/* 아바타 */}
        <button
          type="button"
          className="relative h-20 w-20 shrink-0 rounded-full"
          onClick={() => fileInputRef.current?.click()}
          disabled={avatarUploading}
        >
          <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-full bg-brand/20">
            {profile?.avatar_url ? (
              <img src={profile.avatar_url} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="text-3xl font-bold text-brand">{initial}</span>
            )}
          </div>
          <div className="absolute bottom-0 right-0 flex h-6 w-6 items-center justify-center rounded-full bg-surface2 text-xs shadow">
            📷
          </div>
          {avatarUploading && (
            <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40">
              <span className="text-xs text-white">…</span>
            </div>
          )}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadAvatar(f); }}
        />

        <div className="w-full text-center">
          <button
            type="button"
            onClick={() => user && navigate(`/users/${user.id}`)}
            className="block w-full"
          >
            <input
              value={profile?.display_name ?? ''}
              onChange={(e) => profile && setProfile({ ...profile, display_name: e.target.value })}
              onBlur={saveProfile}
              onClick={(e) => e.stopPropagation()}
              className="w-full rounded-lg bg-surface2 px-3 py-2 text-center text-lg font-semibold text-white outline-none"
              placeholder="표시 이름"
            />
          </button>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            onBlur={saveBio}
            maxLength={500}
            rows={3}
            placeholder="자기소개 (500자 이내)"
            className="mt-2 w-full resize-none rounded-lg bg-surface2 px-3 py-2 text-sm text-slate-300 outline-none"
          />
          <p className="mt-1 text-xs text-slate-500">{user?.email}</p>
          <p className="mt-1 text-xs text-slate-400">
            <button onClick={() => navigate('/follows?tab=followers')} className="hover:underline">
              팔로워 {followerCountData ?? 0}
            </button>
            {' · '}
            <button onClick={() => navigate('/follows?tab=following')} className="hover:underline">
              팔로잉 {followingCountData ?? 0}
            </button>
          </p>
        </div>
      </section>

      {/* OpenRouter 크레딧 */}
      {credit && (
        <section className="rounded-xl bg-surface p-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold text-slate-400">OpenRouter 크레딧</p>
            <button
              onClick={() => toggleKrw(!showKrw)}
              className="flex items-center gap-1.5"
            >
              <span className="text-[10px] text-slate-500">₩ 원화 표시</span>
              <span className={`relative h-5 w-9 rounded-full transition-colors ${showKrw ? 'bg-emerald-500' : 'bg-surface2'}`}>
                <span className={`absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${showKrw ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
              </span>
            </button>
          </div>
          {credit.remaining !== null ? (
            <div>
              <p className="text-lg font-bold text-white">
                ${credit.remaining.toFixed(3)}
                {showKrw && krwRate && (
                  <span className="ml-1 text-sm font-normal text-emerald-400">{toKrw(credit.remaining, krwRate)}</span>
                )}
                <span className="ml-1 text-xs font-normal text-slate-400">잔여</span>
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500">
                총 ${credit.usage.toFixed(4)} 사용
                {showKrw && krwRate && ` (${toKrw(credit.usage, krwRate)})`}
              </p>
            </div>
          ) : (
            <div>
              <p className="text-lg font-bold text-white">
                무제한
                <span className="ml-1 text-xs font-normal text-slate-400">잔여</span>
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500">총 ${credit.usage.toFixed(4)} 사용</p>
            </div>
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
              onClick={() => navigate('/follows?tab=following')}
              className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
            >
              <span className="text-xl">👥</span>
              <span className="flex-1 text-sm text-white">팔로잉 목록</span>
              <span className="text-slate-500">›</span>
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
                <button
                  onClick={() => !p.is_default && setDefaultPersona(p.id)}
                  className={`min-w-0 flex-1 text-left ${!p.is_default ? 'cursor-pointer' : 'cursor-default'}`}
                >
                  <div className="flex items-center gap-1.5">
                    <p className="font-semibold text-white">{p.name}</p>
                    {p.is_default && <span className="rounded bg-brand/20 px-1.5 py-0.5 text-[10px] text-brand">기본</span>}
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-xs text-slate-400">{p.description}</p>
                </button>
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
