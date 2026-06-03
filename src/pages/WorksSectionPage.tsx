import { useQuery } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import WorkPosterCard from '@/components/WorkPosterCard';
import {
  fetchWorksWithStats,
  sortForSection,
  metricForSection,
  isRankingSection,
  SECTION_TITLES,
  type SectionId,
} from '@/lib/works';

const VALID: SectionId[] = ['daily', 'weekly', 'monthly', 'today-hot', 'latest'];

export default function WorksSectionPage() {
  const { sectionId } = useParams<{ sectionId: string }>();
  const navigate = useNavigate();
  const id = sectionId as SectionId;

  const { data, isLoading } = useQuery({ queryKey: ['works-stats'], queryFn: fetchWorksWithStats });

  if (!VALID.includes(id)) {
    return (
      <div className="p-6">
        <button onClick={() => navigate('/works')} className="text-sm text-slate-400">← 작품</button>
        <p className="mt-4 text-amber-400">존재하지 않는 섹션입니다.</p>
      </div>
    );
  }

  const ranked = isRankingSection(id);
  const sorted = data ? sortForSection(id, data) : [];

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-surface2 bg-bg px-4 py-3">
        <button onClick={() => navigate(-1)} className="text-slate-400">←</button>
        <h1 className="font-bold text-white">{SECTION_TITLES[id]}</h1>
      </div>

      {isLoading ? (
        <p className="p-6 text-slate-400">불러오는 중…</p>
      ) : sorted.length === 0 ? (
        <p className="p-6 text-slate-500">표시할 작품이 없습니다.</p>
      ) : (
        <div className="grid grid-cols-3 gap-x-3 gap-y-5 p-4">
          {sorted.map((w, i) => (
            <WorkPosterCard
              key={w.id}
              work={w}
              count={metricForSection(id, w)}
              rank={ranked ? i + 1 : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}
