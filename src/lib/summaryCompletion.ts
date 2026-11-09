import type { GenerateResult } from './llm/types';

/** Null on historical notes means no completion metadata was recorded. */
export function summaryCompletionWarning(reason?: string | null): string | null {
  if (!reason || reason === 'stop') return null;
  if (reason === 'user_stop') return '사용자가 요약 생성을 중지했어요. 수신한 내용까지만 저장했어요.';
  if (reason === 'length') return '제공자 출력 제한으로 요약이 중단됐어요. 받은 내용까지 저장했어요.';
  if (reason === 'content_filter') return '제공자 필터로 요약이 중단됐어요. 받은 내용까지 저장했어요.';
  if (reason === 'error') return '제공자 오류로 요약이 중단됐어요. 받은 내용까지 저장했어요.';
  return '요약의 정상 완료를 확인하지 못했어요. 받은 내용까지 저장했어요.';
}

export function summaryResultMetadata(result: Pick<GenerateResult, 'finishReason' | 'nativeFinishReason'>) {
  return {
    generation_finish_reason: result.finishReason || 'unknown',
    generation_native_finish_reason: result.nativeFinishReason || null,
  };
}
