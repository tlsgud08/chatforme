import { supabase } from './supabase';
import type { Message } from '@/types/db';

type EditPatch = Pick<Message, 'content' | 'command_id' | 'command_name'>;
const conflict = () => new Error('다른 화면에서 메시지가 변경되었습니다. 편집 내용을 복사한 뒤 대화를 다시 열어 확인해 주세요.');
const matches = (row: Message, patch: EditPatch) => row.content === patch.content
  && (row.command_id ?? null) === patch.command_id && (row.command_name ?? null) === patch.command_name;
const networkFailure = (error: unknown) => !!error && typeof error === 'object'
  && 'message' in error && /load failed|failed to fetch|networkerror|network request failed/i.test(String(error.message));

/** Verify an ambiguous write before retrying. A version/command guard makes
 * the single recovery attempt safe even if the first PATCH committed late. */
export async function saveMessageEdit(original: Message, patch: EditPatch): Promise<Message> {
  const read = async () => {
    const { data, error } = await supabase.from('messages').select('*')
      .eq('id', original.id).eq('session_id', original.session_id).maybeSingle();
    if (error) throw new Error('저장 여부를 확인하지 못했습니다. 편집 내용은 유지되어 있으니 연결이 돌아온 뒤 다시 저장해 주세요.');
    if (!data) throw new Error('메시지가 삭제되었거나 접근 권한이 없습니다.');
    return data as Message;
  };
  let expected = original;
  if (!Number.isSafeInteger(expected.content_version)) {
    expected = await read();
    if (!matches(expected, { content: original.content, command_id: original.command_id ?? null, command_name: original.command_name ?? null })) throw conflict();
  }
  if (!Number.isSafeInteger(expected.content_version)) throw new Error('메시지 버전을 확인하지 못했습니다. 페이지를 다시 열어 주세요.');
  for (let attempt = 0; attempt < 2; attempt++) {
    let request = supabase.from('messages').update(patch)
      .eq('id', original.id).eq('session_id', original.session_id).eq('content_version', expected.content_version!);
    request = expected.command_id == null ? request.is('command_id', null) : request.eq('command_id', expected.command_id);
    request = expected.command_name == null ? request.is('command_name', null) : request.eq('command_name', expected.command_name);
    const { data, error } = await request.select('*').maybeSingle();
    if (error && !networkFailure(error)) throw error;
    if (data) return data as Message;
    const fresh = await read();
    if (matches(fresh, patch)) return fresh;
    if (fresh.content_version !== expected.content_version || !matches(fresh, {
      content: expected.content, command_id: expected.command_id ?? null, command_name: expected.command_name ?? null,
    })) throw conflict();
    if (attempt === 1 || !error) throw error ?? conflict();
  }
  throw conflict();
}
