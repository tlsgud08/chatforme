import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import type { Session } from '@/types/db';

type SessionRow = Session & { works: { title: string; thumbnail_url: string | null } | null };

export default function SessionsPage() {
  const { user } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ['sessions', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sessions')
        .select('*, works(title, thumbnail_url)')
        .order('updated_at', { ascending: false });
      if (error) throw error;
      return data as SessionRow[];
    },
  });

  if (isLoading) return <p className="p-6 text-slate-400">불러오는 중…</p>;
  if (!data || data.length === 0)
    return <p className="p-6 text-slate-400">아직 플레이한 채팅방이 없습니다.</p>;

  return (
    <ul className="divide-y divide-surface2">
      {data.map((s) => (
        <li key={s.id}>
          <Link to={`/chat/${s.id}`} className="flex items-center gap-3 p-4 active:bg-surface">
            <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-surface2">
              {s.works?.thumbnail_url && (
                <img src={s.works.thumbnail_url} alt="" className="h-full w-full object-cover" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-white">
                {s.works?.title || s.title || '채팅방'}
              </p>
              <p className="text-xs text-slate-500">
                토큰 누적: {(s.total_input_tokens + s.total_output_tokens).toLocaleString()}
              </p>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
