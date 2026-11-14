import { useLocalProvider } from '@/hooks/useLocalProvider';

export default function LocalBadge() {
  const { provider } = useLocalProvider();
  return provider === 'local' ? <small className="ml-1 text-[10px] font-medium text-brand" aria-label="Local 제공자 사용 중">Local</small> : null;
}
