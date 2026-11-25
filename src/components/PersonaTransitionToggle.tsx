import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import Toggle from './Toggle';

export default function PersonaTransitionToggle({ userId }: { userId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ['persona-transition-notice', userId];
  const preference = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const { data, error } = await supabase.from('profiles').select('persona_transition_notice_enabled')
        .eq('id', userId).abortSignal(signal).single();
      if (error || typeof data?.persona_transition_notice_enabled !== 'boolean') {
        throw error ?? new Error('계정 설정을 불러오지 못했습니다.');
      }
      return data.persona_transition_notice_enabled as boolean;
    },
  });
  const save = useMutation({
    mutationFn: async (enabled: boolean) => {
      const { data, error } = await supabase.from('profiles').update({ persona_transition_notice_enabled: enabled })
        .eq('id', userId).select('id').single();
      if (error || !data) throw error ?? new Error('계정 설정을 저장하지 못했습니다.');
      return enabled;
    },
    onSuccess: async enabled => {
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData(queryKey, enabled);
    },
  });
  return <div className="space-y-1">
    <div className="inu-row">
      <span>페르소나 전환 문구 자동 추가</span>
      <Toggle aria-label="페르소나 전환 문구 자동 추가" checked={save.isPending ? save.variables : preference.data ?? true}
        disabled={save.isPending || preference.data === undefined} onChange={enabled => save.mutate(enabled)} />
    </div>
    {preference.isError && <p role="alert" className="inu-help">계정 설정을 불러오지 못했습니다.{' '}
      <button type="button" className="inu-text-button" onClick={() => void preference.refetch()}>다시 불러오기</button>
    </p>}
    {save.isError && <p role="alert" className="inu-help">전환 문구 설정을 저장하지 못했습니다.</p>}
  </div>;
}
