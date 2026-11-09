import { memo, useMemo } from 'react';
import type { SummaryVersion } from '@/types/db';
import { countNarrativeCharacters, extractCoreNarrative, parseSummaryTarget } from '@/lib/summaryNarrative';
import { formatKrw, type ExchangeRate } from '@/lib/exchangeRate';

interface Props { version: SummaryVersion; showCostKrw: boolean; exchange: ExchangeRate }

function SummaryNoteStats({ version, showCostKrw, exchange }: Props) {
  const characters = useMemo(() => {
    const narrative = extractCoreNarrative(version.content);
    return narrative === null ? null : countNarrativeCharacters(narrative);
  }, [version.content]);
  const target = version.narrative_target_chars ? parseSummaryTarget(version.narrative_target_chars) : null;
  const enabled = version.narrative_target_enabled;
  const percent = enabled === true && target && characters !== null
    ? Math.round(characters / target.minimum * 100) : null;
  const targetLabel = enabled === false ? '목표 미적용' : enabled !== true || !version.narrative_target_chars
    ? '목표 기록 없음' : target ? `목표 ${target.minimum.toLocaleString('ko-KR')}${target.maximum !== target.minimum ? `~${target.maximum.toLocaleString('ko-KR')}` : ''}자`
    : `목표 ${version.narrative_target_chars}자`;
  const usageUnreported = version.finish_reason === 'user_stop' && version.native_finish_reason === 'client_abort_usage_unreported';
  const cost = !usageUnreported && typeof version.cost === 'number' && Number.isFinite(version.cost) && version.cost >= 0
    ? showCostKrw ? formatKrw(version.cost, exchange.rate) : `$${version.cost.toFixed(6)}` : '확인 불가';
  const totalTokens = !usageUnreported && Number.isSafeInteger(version.output_tokens) && version.output_tokens >= 0
    ? version.output_tokens.toLocaleString('ko-KR') : null;
  return <span className="flex min-w-0 flex-wrap self-center items-center gap-x-3 gap-y-1 text-[11px] text-slate-400" aria-label="요약 노트 사용량과 분량">
    <span title={showCostKrw && exchange.fallback ? '임시 환율로 환산한 사용 크레딧' : '이 노트 생성에 사용한 크레딧'}>사용 {cost}</span>
    <span title="생성 당시 API가 보고한 전체 출력 토큰입니다. 모든 섹션과 추론 토큰을 포함할 수 있으며, 편집 후 본문의 토큰 수는 아닙니다.">{totalTokens === null ? '출력 토큰 확인 불가' : `총 출력 ${totalTokens}토큰`}</span>
    <span className="break-all" title="생성 당시 설정한 핵심 서사 본문의 목표 글자 수">{targetLabel}</span>
    <span title="핵심 서사 본문만 · 공백 포함 · 줄바꿈 제외">{characters === null ? '분량 확인 불가' : `핵심 서사 ${characters.toLocaleString('ko-KR')}자`}</span>
    {percent !== null && <span>{percent.toLocaleString('ko-KR')}% 달성{target!.minimum !== target!.maximum ? ' (하한 대비)' : ''}</span>}
  </span>;
}

export default memo(SummaryNoteStats);
