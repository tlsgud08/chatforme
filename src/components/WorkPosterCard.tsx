import { Link } from 'react-router-dom';
import type { WorkCard } from '@/lib/works';
import InterfaceIcon from './InterfaceIcon';

interface Props {
  work: WorkCard;
  className?: string;
  isFavorited?: boolean;
  onFavoriteToggle?: (workId: string, e: React.MouseEvent) => void;
}

export default function WorkPosterCard({ work, className = '', isFavorited, onFavoriteToggle }: Props) {
  return (
    <article className={`work-poster-card ${className}`}>
      <div className="relative">
        <Link to={`/works/${work.id}`} aria-label={work.title || '(제목 없음)'} className="work-poster-cover relative block aspect-[2/3] w-full overflow-hidden rounded-xl bg-surface2">
          {work.thumbnail_url ? <img src={work.thumbnail_url} alt="" className="h-full w-full object-cover" /> :
            <div className="poster-fallback modern-only" aria-hidden="true"><small>작품</small><strong>{work.title || '(제목 없음)'}</strong></div>}
          {work.visibility === 'unlisted' && <span className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1 text-[10px] text-slate-200">링크</span>}
        </Link>
        {onFavoriteToggle && <button type="button"
          onClick={event => onFavoriteToggle(work.id, event)}
          className="work-poster-favorite absolute bottom-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-base leading-none"
          aria-label={`${work.title || '작품'} 하트 ${isFavorited ? '취소' : '추가'}`} aria-pressed={!!isFavorited}>
          <InterfaceIcon name="heart" filled={isFavorited} legacy={isFavorited ? '❤️' : '🤍'} />
        </button>}
      </div>
      <Link to={`/works/${work.id}`} className="work-poster-title mt-1.5 line-clamp-2 text-sm font-semibold leading-tight text-white">{work.title || '(제목 없음)'}</Link>
      <p className="work-poster-creator mt-0.5 truncate text-xs text-slate-400">{work.creator_name}</p>
    </article>
  );
}
