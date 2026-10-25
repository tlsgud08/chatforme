import { supabase } from './supabase';
import type { Message, Session } from '@/types/db';

export interface MessageMutation { message: Message | null; replacement: Message | null; session: Session; deleted: boolean; }
export type MessageEdit = Pick<Message, 'content' | 'command_id' | 'command_name'>;
const networkFailure = (error: unknown) => !!error && typeof error === 'object' && 'message' in error
  && /load failed|failed to fetch|networkerror|network request failed/i.test(String(error.message));
const same = (row: Message, value: MessageEdit) => row.content === value.content
  && (row.command_id ?? null) === (value.command_id ?? null) && (row.command_name ?? null) === (value.command_name ?? null);

/** Only the server can commit a source edit/deletion and memory invalidation
 * together. Retry at most once, with the same version/command guards. */
export async function mutateMessage(original: Message, edit: MessageEdit | null): Promise<MessageMutation> {
  if (!Number.isSafeInteger(original.content_version)) throw new Error('메시지 버전을 확인하지 못했습니다. 편집 내용을 보관하고 방을 다시 열어 주세요.');
  const args = {
    target_session: original.session_id, target_message: original.id, operation: edit ? 'edit' : 'delete',
    expected_version: original.content_version!, expected_command_id: original.command_id ?? null,
    expected_command_name: original.command_name ?? null, message_text: edit?.content ?? null,
    command_uuid: edit?.command_id ?? null, command_label: edit?.command_name ?? null,
    message_group: original.reroll_group_id ?? original.id,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await supabase.rpc('mutate_session_message', args);
    if (!error && data?.session && (edit ? !!data.message : data.deleted === true)) return data as MessageMutation;
    if (error?.code === 'PGRST202') throw new Error('메시지 저장 DB 업데이트가 필요합니다. 현재 대화와 편집 내용은 보존했습니다.');
    if (error?.code === '40001') throw new Error('다른 화면에서 메시지가 변경되었거나 생성 중입니다. 편집 내용을 보관하고 대화를 다시 확인해 주세요.');
    if (!networkFailure(error)) throw error ?? new Error('메시지 저장 결과를 확인하지 못했습니다.');
    if (attempt === 1) throw new Error('저장 여부를 확인하지 못했습니다. 편집 내용은 유지되어 있으니 연결이 돌아온 뒤 다시 시도해 주세요.');
    const { data: fresh, error: readError } = await supabase.from('messages').select('*')
      .eq('id', original.id).eq('session_id', original.session_id).maybeSingle();
    if (readError) throw new Error('저장 여부를 확인하지 못했습니다. 편집 내용은 유지되어 있습니다.');
    const row = fresh as Message | null;
    if (edit && !row) throw new Error('메시지가 삭제되었거나 접근 권한이 없습니다.');
    if (row && !(edit && same(row, edit)) && (row.content_version !== original.content_version || !same(row, original))) {
      throw new Error('다른 화면에서 메시지가 변경되었습니다. 편집 내용을 보관하고 방을 다시 열어 주세요.');
    }
  }
  throw new Error('메시지 저장 결과를 확인하지 못했습니다.');
}
