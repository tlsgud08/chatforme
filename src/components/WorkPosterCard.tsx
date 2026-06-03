import { Link } from 'react-router-dom';
import { formatCount, type WorkStat } from '@/lib/works';

interface Props {
  work: WorkStat;
  count: number;
  rank?: number;
  className?: string;
}

export default function WorkPosterCard({ work, count, rank, className = '' }: Props) {
  return (
    <Link to={`/works/${work.id}`} className={`block ${className}`}>
      <div className="relative aspect-[3/4] w-full overflow-hidden rounded-xl bg-surface2">
        {work.thumbnail_url && (
          <img src={work.thumbnail_url} alt="" className="h-full w-full object-cover" />
        )}
        {rank != null && (
          <span className="absolute left-1.5 top-1.5 flex h-6 min-w-6 items-center justify-center rounded-md bg-black/70 px-1.5 text-sm font-bold text-white">
            {rank}
          </span>
        )}
        {work.visibility === 'unlisted' && (
          <span className="absolute right-1.5 top-1.5 rounded bg-black/60 px-1 text-[10px] text-slate-200">
            링크
          </span>
        )}
      </div>
      <p className="mt-1.5 line-clamp-2 text-sm font-semibold leading-tight text-white">
        {work.title || '(제목 없음)'}
      </p>
      <p className="mt-0.5 truncate text-xs text-slate-400">
        {formatCount(count)} · {work.creator_name}
      </p>
    </Link>
  );
}
