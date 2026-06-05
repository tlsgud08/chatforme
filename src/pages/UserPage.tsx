import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import type { Profile, Work } from '@/types/db';

export default function UserPage() {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const { user, isGuest } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [profile, setProfile] = useState<Profile | null>(null);
  const [works, setWorks] = useState<Work[]>([]);
  const [followerCount, setFollowerCount] = useState(0);
  const [followingCount, setFollowingCount] = useState(0);
  const [isFollowing, setIsFollowing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editBio, setEditBio] = useState('');
  const [avatarUploading, setAvatarUploading] = useState(false);

  const isOwnProfile = user?.id === userId;

  useEffect(() => {
    if (!userId) return;
    Promise.all([
      supabase.from('profiles').select('*').eq('id', userId).single(),
      supabase.from('works').select('*').eq('creator_id', userId).eq('visibility', 'public').order('created_at', { ascending: false }),
      supabase.from('user_follows').select('*', { count: 'exact', head: true }).eq('following_id', userId),
      supabase.from('user_follows').select('*', { count: 'exact', head: true }).eq('follower_id', userId),
    ]).then(([profileRes, worksRes, followerRes, followingRes]) => {
      setProfile((profileRes.data as Profile) ?? null);
      setWorks((worksRes.data as Work[]) ?? []);
      setFollowerCount(followerRes.count ?? 0);
      setFollowingCount(followingRes.count ?? 0);
      setLoading(false);
    });

    if (user && !isGuest && userId !== user.id) {
      supabase.from('user_follows')
        .select('follower_id')
        .eq('follower_id', user.id)
        .eq('following_id', userId)
        .maybeSingle()
        .then(({ data }) => setIsFollowing(!!data));
    }
  }, [userId, user, isGuest]);

  async function toggleFollow() {
    if (!user || isGuest || !userId || isOwnProfile) return;
    if (isFollowing) {
      setIsFollowing(false);
      setFollowerCount((c) => c - 1);
      const { error } = await supabase.from('user_follows')
        .delete().eq('follower_id', user.id).eq('following_id', userId);
      if (error) { setIsFollowing(true); setFollowerCount((c) => c + 1); }
    } else {
      setIsFollowing(true);
      setFollowerCount((c) => c + 1);
      const { error } = await supabase.from('user_follows')
        .insert({ follower_id: user.id, following_id: userId });
      if (error) { setIsFollowing(false); setFollowerCount((c) => c - 1); }
    }
  }

  async function saveEdit() {
    if (!profile || !user) return;
    const name = editName.trim();
    const bio = editBio.trim();
    await supabase.from('profiles').update({ display_name: name, bio }).eq('id', user.id);
    setProfile({ ...profile, display_name: name, bio });
    setIsEditing(false);
  }

  async function uploadAvatar(file: File) {
    if (!user || !profile) return;
    if (file.size > 5 * 1024 * 1024) return;
    setAvatarUploading(true);
    const { data, error } = await supabase.storage
      .from('avatars')
      .upload(`${user.id}/${Date.now()}`, file, { upsert: true, contentType: file.type });
    if (!error) {
      const publicUrl = supabase.storage.from('avatars').getPublicUrl(data.path).data.publicUrl;
      await supabase.from('profiles').update({ avatar_url: publicUrl }).eq('id', user.id);
      setProfile({ ...profile, avatar_url: publicUrl });
    }
    setAvatarUploading(false);
  }

  function openEdit() {
    setEditName(profile?.display_name ?? '');
    setEditBio(profile?.bio ?? '');
    setIsEditing(true);
  }

  if (loading) return <p className="p-6 text-slate-400">불러오는 중…</p>;
  if (!profile) return <p className="p-6 text-amber-400">유저를 찾을 수 없습니다.</p>;

  const initial = profile.display_name?.[0]?.toUpperCase() ?? '?';

  return (
    <div className="flex flex-col">
      {/* 헤더 */}
      <div className="relative flex items-center px-4 py-3">
        <button onClick={() => navigate(-1)} className="text-slate-400">←</button>
        {isOwnProfile && (
          <p className="absolute left-0 right-0 text-center text-base font-semibold text-white pointer-events-none">
            내 프로필
          </p>
        )}
      </div>

      {/* 프로필 영역 */}
      <div className="px-4 pt-2 pb-5">
        {/* 아바타 + 이름 */}
        <div className="flex items-center gap-4">
          {isEditing ? (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={avatarUploading}
              className="relative h-20 w-20 shrink-0 rounded-full"
            >
              <div className="h-20 w-20 overflow-hidden rounded-full bg-brand/20">
                {profile.avatar_url ? (
                  <img src={profile.avatar_url} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-3xl font-bold text-brand">
                    {initial}
                  </div>
                )}
              </div>
              <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50">
                <span className="text-lg">📷</span>
              </div>
              {avatarUploading && (
                <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/60">
                  <span className="text-xs text-white">…</span>
                </div>
              )}
            </button>
          ) : (
            <div className="h-20 w-20 shrink-0 overflow-hidden rounded-full bg-brand/20">
              {profile.avatar_url ? (
                <img src={profile.avatar_url} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-3xl font-bold text-brand">
                  {initial}
                </div>
              )}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadAvatar(f); }}
          />

          <div className="min-w-0 flex-1">
            <p className="text-xl font-bold text-white truncate">
              {profile.display_name || '(이름 없음)'}
            </p>
            {profile.bio && !isEditing && (
              <p className="mt-0.5 text-sm text-slate-400 line-clamp-2">{profile.bio}</p>
            )}
          </div>
        </div>

        {/* 팔로워 / 팔로잉 */}
        <div className="mt-4 flex gap-5">
          <button
            onClick={() => isOwnProfile && navigate('/follows?tab=followers')}
            className={isOwnProfile ? '' : 'cursor-default'}
          >
            <span className="font-bold text-white">{followerCount}</span>
            <span className="ml-1.5 text-sm text-slate-400">팔로워</span>
          </button>
          <button
            onClick={() => isOwnProfile && navigate('/follows?tab=following')}
            className={isOwnProfile ? '' : 'cursor-default'}
          >
            <span className="font-bold text-white">{followingCount}</span>
            <span className="ml-1.5 text-sm text-slate-400">팔로잉</span>
          </button>
        </div>

        {/* 편집 폼 */}
        {isEditing && (
          <div className="mt-4 flex flex-col gap-2">
            <input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder="표시 이름"
              className="w-full rounded-xl bg-surface2 px-4 py-2.5 text-sm text-white outline-none"
            />
            <textarea
              value={editBio}
              onChange={(e) => setEditBio(e.target.value)}
              placeholder="자기소개 (500자 이내)"
              rows={3}
              maxLength={500}
              className="w-full resize-none rounded-xl bg-surface2 px-4 py-2.5 text-sm text-slate-300 outline-none"
            />
            <div className="flex gap-2">
              <button
                onClick={saveEdit}
                className="flex-1 rounded-xl bg-brand py-2.5 text-sm font-semibold text-white"
              >
                저장
              </button>
              <button
                onClick={() => setIsEditing(false)}
                className="rounded-xl bg-surface2 px-5 py-2.5 text-sm text-slate-300"
              >
                취소
              </button>
            </div>
          </div>
        )}

        {/* 프로필 수정 / 팔로우 버튼 */}
        {!isEditing && isOwnProfile && (
          <button
            onClick={openEdit}
            className="mt-4 w-full rounded-xl bg-surface2 py-2.5 text-sm font-semibold text-white"
          >
            프로필 수정
          </button>
        )}
        {!isEditing && !isOwnProfile && !isGuest && user && (
          <button
            onClick={toggleFollow}
            className={`mt-4 w-full rounded-xl py-2.5 text-sm font-semibold ${
              isFollowing ? 'bg-surface2 text-slate-300' : 'bg-brand text-white'
            }`}
          >
            {isFollowing ? '팔로잉' : '팔로우'}
          </button>
        )}
      </div>

      {/* 작품 목록 */}
      <div className="border-t border-surface2">
        <div className="px-4 py-3">
          <h2 className="text-sm font-semibold text-white">작품</h2>
        </div>
        {works.length === 0 ? (
          <p className="p-6 text-center text-sm text-slate-500">공개된 작품이 없습니다.</p>
        ) : (
          <div className="grid grid-cols-3 gap-2.5 px-3 pb-4">
            {works.map((w) => (
              <Link key={w.id} to={`/works/${w.id}`} className="flex flex-col active:opacity-70">
                <div className="aspect-[2/3] overflow-hidden rounded-lg bg-surface2">
                  {w.thumbnail_url
                    ? <img src={w.thumbnail_url} alt="" className="h-full w-full object-cover" />
                    : <div className="flex h-full w-full items-center justify-center text-2xl text-slate-600">📖</div>
                  }
                </div>
                <p className="mt-1.5 text-xs text-white line-clamp-2 leading-snug">{w.title || '(제목 없음)'}</p>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
