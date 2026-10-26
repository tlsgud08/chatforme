import { supabase } from './supabase';
import type { Message, Session } from '@/types/db';

export interface MessageMutation { message: Message | null; replacement: Message | null; session: Session; deleted: boolean; }
export type MessageEdit = Pick<Message, 'content' | 'command_id' | 'command_name'>;
const networkFailure = (error: unknown) => !!error && typeof error === 'object' && 'message' in error
  && /load failed|failed to fetch|networkerror|network request failed/i.test(String(error.message));
const same = (row: Message, value: MessageEdit) => row.content === value.content
  && (row.command_id ?? null) === (value.command_id ?? null) && (row.command_name ?? null) === (value.command_name ?? null);
// A version can change when this same tab selects a variant. Never equate a
// version mismatch with a changed body, or refresh past an actual source edit.
const sameSource = (row: Message, original: Message) => same(row, original)
  && (row.command_prompt ?? null) === (original.command_prompt ?? null)
  && (row.is_hidden ?? null) === (original.is_hidden ?? null)
  && (row.is_active_variant ?? null) === (original.is_active_variant ?? null)
  && (row.generation_status ?? null) === (original.generation_status ?? null)
  && (row.role ?? null) === (original.role ?? null)
  && (row.turn_index ?? null) === (original.turn_index ?? null)
  && (row.reroll_group_id ?? row.id) === (original.reroll_group_id ?? original.id);
const changedMessage = () => new Error('저장된 메시지가 변경되었습니다. 편집 내용은 유지되어 있으니 대화를 다시 확인해 주세요.');

async function readMessage(original: Message): Promise<Message | null> {
  const { data, error } = await supabase.from('messages').select('*')
    .eq('id', original.id).eq('session_id', original.session_id).maybeSingle();
  if (error) throw new Error('저장 여부를 확인하지 못했습니다. 편집 내용은 유지되어 있습니다.');
  return data as Message | null;
}

/** Only the server can commit a source edit/deletion and memory invalidation
 * together. Retry once; a fresh version is accepted only for identical source
 * content and state. The second write is still guarded by that server version. */
export async function mutateMessage(original: Message, edit: MessageEdit | null): Promise<MessageMutation> {
  let version = original.content_version;
  if (!Number.isSafeInteger(version)) {
    const fresh = await readMessage(original);
    if (!fresh || !sameSource(fresh, original)) throw changedMessage();
    version = fresh.content_version;
    if (!Number.isSafeInteger(version)) throw new Error('메시지 버전을 확인하지 못했습니다. 편집 내용은 유지되어 있습니다.');
  }
  const args = {
    target_session: original.session_id, target_message: original.id, operation: edit ? 'edit' : 'delete',
    expected_version: version!, expected_command_id: original.command_id ?? null,
    expected_command_name: original.command_name ?? null, message_text: edit?.content ?? null,
    command_uuid: edit?.command_id ?? null, command_label: edit?.command_name ?? null,
    message_group: original.reroll_group_id ?? original.id,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await supabase.rpc('mutate_session_message', args);
    if (!error && data?.session && (edit ? !!data.message : data.deleted === true)) return data as MessageMutation;
    if (error?.code === 'PGRST202') throw new Error('메시지 저장 DB 업데이트가 필요합니다. 현재 대화와 편집 내용은 보존했습니다.');
    const conflict = error?.code === '40001';
    if (conflict && /generating/i.test(error.message ?? '')) throw new Error('이 채팅방에 생성 중으로 남은 답변이 있습니다. 생성 상태를 확인한 뒤 다시 시도해 주세요. 편집 내용은 유지되어 있습니다.');
    if (!conflict && !networkFailure(error)) throw error ?? new Error('메시지 저장 결과를 확인하지 못했습니다.');
    if (attempt === 1) {
      if (conflict) throw changedMessage();
      throw new Error('저장 여부를 확인하지 못했습니다. 편집 내용은 유지되어 있으니 연결이 돌아온 뒤 다시 시도해 주세요.');
    }
    const row = await readMessage(original);
    if (edit && !row) throw new Error('메시지가 삭제되었거나 접근 권한이 없습니다.');
    if (row && !(edit && same(row, edit))) {
      if (!sameSource(row, original) || !Number.isSafeInteger(row.content_version)) throw changedMessage();
      args.expected_version = row.content_version!;
    }
  }
  throw new Error('메시지 저장 결과를 확인하지 못했습니다.');
}
