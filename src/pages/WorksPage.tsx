import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import type { Work } from '@/types/db';

async function fetchWorks(): Promise<Work[]> {
  const { data, error } = await supabase
    .from('works')
    .select('*')
    .eq('is_published', true)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data as Work[];
}

export default function WorksPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ['works'], queryFn: fetchWorks });

  if (isLoading) return <p className="p-6 text-slate-400">불러오는 중…</p>;
  if (error) return <p className="p-6 text-amber-400">목록을 불러오지 못했습니다.</p>;
  if (!data || data.length === 0)
    return <p className="p-6 text-slate-400">아직 작품이 없습니다. 제작 탭에서 만들어보세요.</p>;

  return (
    <ul className="divide-y divide-surface2">
      {data.map((w) => (
        <li key={w.id}>
          <Link to={`/works/${w.id}`} className="flex gap-3 p-4 active:bg-surface">
            <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-surface2">
              {w.thumbnail_url && (
                <img src={w.thumbnail_url} alt="" className="h-full w-full object-cover" />
              )}
            </div>
            <div className="min-w-0">
              <p className="truncate font-semibold text-white">{w.title || '(제목 없음)'}</p>
              <p className="line-clamp-2 text-sm text-slate-400">{w.description}</p>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
