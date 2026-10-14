import { Link } from 'react-router-dom';
import type { WorkCard } from '@/lib/works';

interface Props {
  work: WorkCard;
  className?: string;
  isFavorited?: boolean;
  onFavoriteToggle?: (workId: string, e: React.MouseEvent) => void;
}

export default function WorkPosterCard({ work, className = '', isFavorited, onFavoriteToggle }: Props) {
  return (
    <Link to={`/works/${work.id}`} className={`block ${className}`}>
      <div className="relative aspect-[2/3] w-full overflow-hidden rounded-xl bg-surface2">
        {work.thumbnail_url && (
          <img src={work.thumbnail_url} alt="" className="h-full w-full object-cover" />
        )}
        {work.visibility === 'unlisted' && (
          <span className="absolute right-1.5 top-1.5 rounded bg-black/60 px-1 text-[10px] text-slate-200">
            링크
          </span>
        )}
        {onFavoriteToggle && (
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onFavoriteToggle(work.id, e); }}
            className="absolute bottom-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-base leading-none"
            aria-label="하트"
          >
            {isFavorited ? '❤️' : '🤍'}
          </button>
        )}
      </div>
      <p className="mt-1.5 line-clamp-2 text-sm font-semibold leading-tight text-white">
        {work.title || '(제목 없음)'}
      </p>
      <p className="mt-0.5 truncate text-xs text-slate-400">
        {work.creator_name}
      </p>
    </Link>
  );
}
