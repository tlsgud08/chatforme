import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import AvatarCircle from '@/components/AvatarCircle';
import type { Persona, Profile } from '@/types/db';

interface FollowEntry {
  following_id: string;
  display_name: string;
  avatar_url: string | null;
}

export default function MyPage() {
  const { user, isGuest, signOut } = useAuth();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);

  const [profile, setProfile] = useState<Profile | null>(null);
  const [savedMsg, setSavedMsg] = useState('');
  const [avatarUploading, setAvatarUploading] = useState(false);

  const [personas, setPersonas] = useState<Persona[]>([]);
  const [editingPersona, setEditingPersona] = useState<Persona | null>(null);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);

  const [following, setFollowing] = useState<FollowEntry[]>([]);

  useEffect(() => {
    if (isGuest || !user) return;
    supabase.from('profiles').select('*').eq('id', user.id).single()
      .then(({ data }) => setProfile(data as Profile));
    supabase.from('personas').select('*').eq('user_id', user.id).order('created_at')
      .then(({ data }) => setPersonas((data as Persona[]) ?? []));
    loadFollowing();
  }, [user, isGuest]);

  async function loadFollowing() {
    if (!user) return;
    const { data: followData } = await supabase
      .from('user_follows').select('following_id').eq('follower_id', user.id)
      .order('created_at', { ascending: false });
    const ids = (followData ?? []).map((f: { following_id: string }) => f.following_id);
    if (ids.length === 0) return;
    const { data: profilesData } = await supabase
      .from('profiles').select('id, display_name, avatar_url').in('id', ids);
    const profileMap: Record<string, { display_name: string; avatar_url: string | null }> = {};
    for (const p of profilesData ?? []) profileMap[p.id] = p;
    setFollowing(ids.map((id: string) => ({
      following_id: id,
      display_name: profileMap[id]?.display_name ?? '알 수 없음',
      avatar_url: profileMap[id]?.avatar_url ?? null,
    })));
  }

  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !user) return;
    if (file.size > 5 * 1024 * 1024) { flash('파일 크기가 5MB를 초과합니다.'); return; }
    setAvatarUploading(true);
    const ext = file.name.split('.').pop() ?? 'jpg';
    const path = `${user.id}/avatar.${ext}`;
    const { error: upErr } = await supabase.storage.from('avatars').upload(path, file, { upsert: true });
    if (upErr) { flash('업로드 실패: ' + upErr.message); setAvatarUploading(false); return; }
    const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(path);
    const cacheBusted = publicUrl + '?t=' + Date.now();
    await supabase.from('profiles').update({ avatar_url: cacheBusted }).eq('id', user.id);
    setProfile((p) => p ? { ...p, avatar_url: cacheBusted } : p);
    setAvatarUploading(false);
    flash('프로필 사진이 변경되었습니다.');
    if (e.target) e.target.value = '';
  }

  async function saveProfile() {
    if (!profile) return;
    await supabase.from('profiles').update({
      display_name: profile.display_name,
      bio: profile.bio,
    }).eq('id', profile.id);
    flash('저장했습니다.');
  }

  async function addPersona() {
    if (!newName.trim() || !user) return;
    const isFirst = personas.length === 0;
    const { data, error } = await supabase
      .from('personas')
      .insert({ user_id: user.id, name: newName.trim(), description: newDesc.trim(), is_default: isFirst })
      .select('*').single();
    if (error) { flash('저장 실패: ' + error.message); return; }
    setPersonas((p) => [...p, data as Persona]);
    setNewName(''); setNewDesc(''); setShowAddForm(false);
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

  async function unfollow(followingId: string) {
    if (!user) return;
    setFollowing((f) => f.filter((x) => x.following_id !== followingId));
    await supabase.from('user_follows').delete().eq('follower_id', user.id).eq('following_id', followingId);
  }

  function flash(msg: string) {
    setSavedMsg(msg);
    setTimeout(() => setSavedMsg(''), 2500);
  }

  if (isGuest) {
    return (
      <div className="flex flex-col items-center gap-4 p-8 text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-surface2 text-4xl">👤</div>
        <p className="font-semibold text-white">비회원 모드</p>
        <p className="text-sm text-slate-400">로그인하면 프로필·페르소나·팔로우·즐겨찾기를 사용할 수 있습니다.</p>
        <button
          onClick={() => navigate('/login')}
          className="mt-2 rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white"
        >
          로그인
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-4">
      {/* 프로필 카드 */}
      <section className="flex flex-col items-center gap-3 rounded-xl bg-surface p-5">
        <button
          onClick={() => fileRef.current?.click()}
          disabled={avatarUploading}
          className="relative"
          aria-label="프로필 사진 변경"
        >
          <AvatarCircle name={profile?.display_name ?? null} avatarUrl={profile?.avatar_url ?? null} size="lg" />
          <span className="absolute bottom-0 right-0 flex h-6 w-6 items-center justify-center rounded-full bg-surface2 text-xs">
            {avatarUploading ? '…' : '📷'}
          </span>
        </button>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleAvatarChange} />

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

        <div className="w-full">
          <textarea
            value={profile?.bio ?? ''}
            onChange={(e) => {
              if (e.target.value.length <= 500 && profile)
                setProfile({ ...profile, bio: e.target.value });
            }}
            onBlur={saveProfile}
            rows={3}
            placeholder="소개를 입력하세요 (최대 500자)"
            className="w-full resize-none rounded-lg bg-surface2 px-3 py-2 text-sm text-slate-300 outline-none placeholder:text-slate-600"
          />
          <p className="mt-0.5 text-right text-xs text-slate-600">{(profile?.bio ?? '').length}/500</p>
        </div>

        {user && (
          <button
            onClick={() => navigate(`/users/${user.id}`)}
            className="w-full rounded-lg bg-surface2 py-2 text-sm text-slate-300"
          >
            내 프로필 보기 →
          </button>
        )}
      </section>

      {/* 활동 */}
      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">활동</h2>
        <ul className="divide-y divide-surface2 overflow-hidden rounded-xl bg-surface">
          <li>
            <button
              onClick={() => navigate('/favorites')}
              className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
            >
              <span className="text-xl">❤️</span>
              <span className="flex-1 text-sm text-white">즐겨찾기</span>
              <span className="text-xs text-slate-400">▶</span>
            </button>
          </li>
        </ul>
      </section>

      {/* 팔로잉 */}
      <section>
        <h2 className="mb-3 font-semibold text-white">팔로잉</h2>
        {following.length === 0 ? (
          <p className="text-sm text-slate-500">팔로우한 유저가 없습니다.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {following.map((f) => (
              <li key={f.following_id} className="flex items-center gap-3 rounded-lg bg-surface p-3">
                <button
                  onClick={() => navigate(`/users/${f.following_id}`)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <AvatarCircle name={f.display_name} avatarUrl={f.avatar_url} size="sm" />
                  <p className="truncate font-semibold text-white">{f.display_name}</p>
                </button>
                <button
                  onClick={() => unfollow(f.following_id)}
                  className="shrink-0 rounded bg-surface2 px-2 py-1 text-xs text-slate-400"
                >
                  언팔로우
                </button>
              </li>
            ))}
          </ul>
        )}
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

      {/* 로그아웃 */}
      <button
        onClick={() => signOut()}
        className="w-full rounded-xl bg-surface py-3 text-sm font-semibold text-red-400"
      >
        로그아웃
      </button>
    </div>
  );
}
