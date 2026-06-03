import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import AvatarCircle from '@/components/AvatarCircle';
import type { Profile, Work } from '@/types/db';

export default function UserPage() {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const { user, isGuest } = useAuth();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [works, setWorks] = useState<Work[]>([]);
  const [followerCount, setFollowerCount] = useState(0);
  const [followingCount, setFollowingCount] = useState(0);
  const [isFollowing, setIsFollowing] = useState(false);
  const [loading, setLoading] = useState(true);

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

  if (loading) return <p className="p-6 text-slate-400">불러오는 중…</p>;
  if (!profile) return <p className="p-6 text-amber-400">유저를 찾을 수 없습니다.</p>;

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 px-4 py-3">
        <button onClick={() => navigate(-1)} className="text-sm text-slate-400">← 뒤로</button>
      </div>

      {/* 프로필 헤더 */}
      <div className="flex flex-col items-center gap-3 px-4 pb-6 pt-2">
        <AvatarCircle name={profile.display_name} avatarUrl={profile.avatar_url} size="lg" />

        <div className="text-center">
          <p className="text-lg font-bold text-white">{profile.display_name || '(이름 없음)'}</p>
          {profile.bio && (
            <p className="mt-1 max-w-xs whitespace-pre-wrap text-sm text-slate-400">{profile.bio}</p>
          )}
        </div>

        <div className="flex gap-8 text-center">
          <div>
            <p className="font-bold text-white">{followerCount}</p>
            <p className="text-xs text-slate-400">팔로워</p>
          </div>
          <div>
            <p className="font-bold text-white">{followingCount}</p>
            <p className="text-xs text-slate-400">팔로잉</p>
          </div>
        </div>

        {!isOwnProfile && !isGuest && user && (
          <button
            onClick={toggleFollow}
            className={`rounded-xl px-8 py-2 text-sm font-semibold ${
              isFollowing ? 'bg-surface2 text-slate-300' : 'bg-brand text-white'
            }`}
          >
            {isFollowing ? '팔로잉' : '팔로우'}
          </button>
        )}

        {isOwnProfile && (
          <button
            onClick={() => navigate('/my')}
            className="rounded-xl bg-surface2 px-6 py-2 text-sm text-slate-300"
          >
            프로필 편집
          </button>
        )}
      </div>

      {/* 작품 목록 */}
      <div className="border-t border-surface2">
        <div className="px-4 py-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">작품</h2>
        </div>
        {works.length === 0 ? (
          <p className="p-6 text-center text-sm text-slate-500">공개된 작품이 없습니다.</p>
        ) : (
          <ul className="divide-y divide-surface2">
            {works.map((w) => (
              <li key={w.id}>
                <Link to={`/works/${w.id}`} className="flex gap-3 p-4 active:bg-surface">
                  <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-surface2">
                    {w.thumbnail_url && <img src={w.thumbnail_url} alt="" className="h-full w-full object-cover" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold text-white">{w.title || '(제목 없음)'}</p>
                    <p className="mt-0.5 text-xs text-slate-500">플레이하기 →</p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
