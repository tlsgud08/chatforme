import { useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { showConfirmDialog } from '@/lib/dialog';
import { showToast } from '@/lib/toast';
import { multichatParticipantName } from '@/lib/multichat';
import type { MultichatMember, MultichatRoom } from '@/types/db';
import InterfaceIcon from './InterfaceIcon';

interface Props {
  room: MultichatRoom; members: MultichatMember[]; slot: 1 | 2;
  otherPresent: boolean; presenceReady: boolean;
  onUpdate: (room: MultichatRoom) => void; onRefresh: () => Promise<void>;
}
export default function MultichatProgressSettings({ room, members, slot, otherPresent, presenceReady, onUpdate, onRefresh }: Props) {
  const [saving, setSaving] = useState(false);
  const locked = useRef(false);
  async function change(mode: 'together' | 'solo') {
    if (locked.current) return;
    locked.current = true; setSaving(true);
    // Capture the revision before opening the dialog; a concurrent change must
    // be reviewed again, never silently overwritten after confirmation.
    const revision = room.progress_revision;
    try {
      if (mode === 'solo' && (otherPresent || !presenceReady)) {
        const text = otherPresent ? '상대방도 이 채팅방에 접속해 있어요. 혼자 진행하면 상대방의 입력·진행과 충돌할 수 있어요. 계속할까요?' : '상대방의 채팅방 접속 상태를 확인하지 못했어요. 상대방의 입력·진행과 충돌할 수 있어요. 그래도 혼자 진행할까요?';
        if (!await showConfirmDialog('혼자 진행할까요?', text, '혼자 진행')) return;
      }
      const { data, error } = await supabase.rpc('set_multichat_progress', { target_room: room.id, mode, expected_revision: revision });
      if (error || !data) throw error ?? new Error('진행 방식을 변경하지 못했습니다.');
      onUpdate(data as MultichatRoom);
      showToast('진행 방식을 변경했습니다. 생성 중인 응답이 있다면 다음 턴부터 적용돼요.');
    } catch (error) {
      showToast((error as Error).message);
      await onRefresh().catch(() => {});
    } finally { locked.current = false; setSaving(false); }
  }
  const ownSolo = room.progress_mode === 'solo' && room.solo_slot === slot;
  return <section className="inu-section" aria-label="멀티챗 진행 방식">
    <h3><InterfaceIcon name="users" />진행 방식</h3>
    <p className="inu-help" role="status">{room.progress_mode === 'solo' ? `${multichatParticipantName(room.solo_slot!, members)} 혼자 진행 중` : '함께 진행 중'}</p>
    <div className="inu-two-fields">
      <button type="button" className="inu-button" aria-pressed={room.progress_mode !== 'solo'} disabled={saving || room.progress_mode !== 'solo'} onClick={() => void change('together')}>함께 진행</button>
      <button type="button" className="inu-button" aria-pressed={ownSolo} disabled={saving || ownSolo} onClick={() => void change('solo')}>나 혼자 진행</button>
    </div>
    <p className="inu-help">두 참여자 모두 변경할 수 있어요. 혼자 진행해도 PC 배정은 유지돼요. 혼자 진행하는 동안에는 진행자의 API 키를 사용하고, 함께 진행으로 돌아오면 기존 키 사용 규칙을 적용해요.</p>
  </section>;
}
