import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import type { Work } from '@/types/db';

export default function WorkDetailPage() {
  const { workId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [starting, setStarting] = useState(false);

  const { data: work, isLoading } = useQuery({
    queryKey: ['work', workId],
    queryFn: async () => {
      const { data, error } = await supabase.from('works').select('*').eq('id', workId).single();
      if (error) throw error;
      return data as Work;
    },
  });

  async function startChat() {
    if (!work || !user) return;
    setStarting(true);
    const { data, error } = await supabase
      .from('sessions')
      .insert({ user_id: user.id, work_id: work.id, title: work.title })
      .select('id')
      .single();
    setStarting(false);
    if (error) {
      alert('채팅 시작에 실패했습니다: ' + error.message);
      return;
    }
    navigate(`/chat/${data.id}`);
  }

  if (isLoading) return <p className="p-6 text-slate-400">불러오는 중…</p>;
  if (!work) return <p className="p-6 text-amber-400">작품을 찾을 수 없습니다.</p>;

  return (
    <div className="p-4">
      <button onClick={() => navigate(-1)} className="mb-3 text-sm text-slate-400">
        ← 뒤로
      </button>
      <div className="aspect-video w-full overflow-hidden rounded-xl bg-surface2">
        {work.thumbnail_url && (
          <img src={work.thumbnail_url} alt="" className="h-full w-full object-cover" />
        )}
      </div>
      <h1 className="mt-4 text-xl font-bold text-white">{work.title || '(제목 없음)'}</h1>
      <p className="mt-2 whitespace-pre-wrap text-sm text-slate-300">{work.description}</p>

      <button
        onClick={startChat}
        disabled={starting}
        className="mt-6 w-full rounded-lg bg-brand py-3 font-semibold text-white disabled:opacity-50"
      >
        {starting ? '시작 중…' : '새 채팅 시작'}
      </button>
    </div>
  );
}
