import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import AvatarCircle from '@/components/AvatarCircle';
import type { Profile } from '@/types/db';

export default function FollowListPage() {
  const { user, isGuest } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = (searchParams.get('tab') ?? 'followers') as 'followers' | 'following';

  const [followers, setFollowers] = useState<Profile[]>([]);
  const [following, setFollowing] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user || isGuest) return;
    setLoading(true);

    Promise.all([
      supabase.from('user_follows').select('follower_id').eq('following_id', user.id),
      supabase.from('user_follows').select('following_id').eq('follower_id', user.id),
    ]).then(async ([followerRes, followingRes]) => {
      const followerIds = (followerRes.data ?? []).map((r) => r.follower_id);
      const followingIds = (followingRes.data ?? []).map((r) => r.following_id);

      const [followerProfiles, followingProfiles] = await Promise.all([
        followerIds.length > 0
          ? supabase.from('profiles').select('*').in('id', followerIds)
          : Promise.resolve({ data: [] }),
        followingIds.length > 0
          ? supabase.from('profiles').select('*').in('id', followingIds)
          : Promise.resolve({ data: [] }),
      ]);

      setFollowers((followerProfiles.data as Profile[]) ?? []);
      setFollowing((followingProfiles.data as Profile[]) ?? []);
      setLoading(false);
    });
  }, [user, isGuest]);

  if (!user || isGuest) {
    return (
      <div className="flex flex-col items-center gap-3 p-8 text-center">
        <p className="text-slate-400">로그인이 필요합니다.</p>
        <button onClick={() => navigate('/login')} className="rounded-lg bg-brand px-5 py-2 text-sm font-semibold text-white">
          로그인
        </button>
      </div>
    );
  }

  const list = tab === 'followers' ? followers : following;

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 px-4 py-3">
        <button onClick={() => navigate('/my')} className="text-sm text-slate-400">← 뒤로</button>
      </div>

      {/* 탭 */}
      <div className="flex border-b border-surface2">
        <button
          onClick={() => setSearchParams({ tab: 'followers' })}
          className={`flex-1 py-2.5 text-sm font-semibold transition-colors ${
            tab === 'followers' ? 'border-b-2 border-brand text-white' : 'text-slate-500'
          }`}
        >
          팔로워 {followers.length > 0 && <span className="ml-1 text-xs font-normal opacity-70">{followers.length}</span>}
        </button>
        <button
          onClick={() => setSearchParams({ tab: 'following' })}
          className={`flex-1 py-2.5 text-sm font-semibold transition-colors ${
            tab === 'following' ? 'border-b-2 border-brand text-white' : 'text-slate-500'
          }`}
        >
          팔로잉 {following.length > 0 && <span className="ml-1 text-xs font-normal opacity-70">{following.length}</span>}
        </button>
      </div>

      {/* 목록 */}
      {loading ? (
        <p className="p-6 text-center text-sm text-slate-400">불러오는 중…</p>
      ) : list.length === 0 ? (
        <p className="p-6 text-center text-sm text-slate-500">
          {tab === 'followers' ? '아직 팔로워가 없습니다.' : '팔로우한 사용자가 없습니다.'}
        </p>
      ) : (
        <ul className="divide-y divide-surface2">
          {list.map((p) => (
            <li key={p.id}>
              <button
                onClick={() => navigate(`/users/${p.id}`)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-surface"
              >
                <AvatarCircle name={p.display_name} avatarUrl={p.avatar_url} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-white">{p.display_name || '(이름 없음)'}</p>
                  {p.bio && <p className="mt-0.5 truncate text-xs text-slate-400">{p.bio}</p>}
                </div>
                <span className="text-slate-500">›</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
