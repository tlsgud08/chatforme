import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { showToast } from '@/lib/toast';
import { multichatGenerationSlot, multichatParticipantName } from '@/lib/multichat';
import type { MultichatMember, MultichatRoom } from '@/types/db';
import InterfaceIcon from './InterfaceIcon';

export default function MultichatApiSettings({ room, members, onUpdate }: { room: MultichatRoom; members: MultichatMember[]; onUpdate: (room: MultichatRoom) => void }) {
  const names = { 1: `${multichatParticipantName(1, members)}(방장)`, 2: `${multichatParticipantName(2, members)}(참여자)` };
  const [mode, setMode] = useState(room.billing_mode);
  const [pc1, setPc1] = useState(room.billing_pc1_turns);
  const [pc2, setPc2] = useState(room.billing_pc2_turns);
  const [first, setFirst] = useState<1 | 2>(room.billing_first_slot);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setMode(room.billing_mode); setPc1(room.billing_pc1_turns); setPc2(room.billing_pc2_turns); setFirst(room.billing_first_slot); }, [room.billing_mode, room.billing_pc1_turns, room.billing_pc2_turns, room.billing_first_slot]);
  async function save() {
    if (saving) return;
    if (![pc1, pc2].every(value => Number.isInteger(value) && value >= 1 && value <= 1000)) { showToast('턴 수는 1~1,000 사이의 정수로 입력해 주세요.'); return; }
    setSaving(true);
    try {
      const { data, error } = await supabase.rpc('set_multichat_billing', { target_room: room.id, mode, pc1_turns: pc1, pc2_turns: pc2, first_slot: first });
      if (error || !data) throw error ?? new Error('API 키 사용 규칙을 저장하지 못했습니다.');
      onUpdate(data as MultichatRoom); showToast('API 키 사용 규칙을 저장했습니다.');
    } catch (error) { showToast((error as Error).message); } finally { setSaving(false); }
  }
  return <section className="inu-section" aria-label="멀티챗 API 키 사용 규칙">
    <h3><InterfaceIcon name="users" />API 키 사용</h3>
    <p className="inu-help">두 참여자 모두 변경할 수 있어요. 호출 담당자의 기기에 저장된 키를 사용해요.</p>
    <label className="inu-field-label">사용 방식<select aria-label="API 키 사용 방식" value={mode} onChange={event => setMode(event.target.value as typeof mode)}>
      <option value="alternate">지정한 턴 수로 교대</option><option value="pc1">{names[1]} 키만 사용</option><option value="pc2">{names[2]} 키만 사용</option>
    </select></label>
    {mode === 'alternate' && <>
      <div className="inu-two-fields"><label className="inu-field-label">{names[1]} 연속 턴 수<input aria-label={`${names[1]} 연속 턴 수`} type="number" min={1} max={1000} value={pc1} onChange={event => setPc1(Number(event.target.value))} /></label><label className="inu-field-label">{names[2]} 연속 턴 수<input aria-label={`${names[2]} 연속 턴 수`} type="number" min={1} max={1000} value={pc2} onChange={event => setPc2(Number(event.target.value))} /></label></div>
      <label className="inu-field-label">먼저 사용할 키<select aria-label="먼저 사용할 키" value={first} onChange={event => setFirst(Number(event.target.value) as 1 | 2)}><option value={1}>{names[1]}</option><option value={2}>{names[2]}</option></select></label>
    </>}
    <p className="inu-help">{room.progress_mode === 'solo' && '혼자 진행 중에는 진행자의 키를 사용해요. 아래 규칙은 함께 진행할 때 적용돼요. '}현재 규칙의 {Math.max(1, room.current_round)}턴 담당: {names[multichatGenerationSlot(Math.max(1, room.current_round), room)]}. 생성 중인 응답은 기존 담당자가 마무리해요.</p>
    <button className="inu-button inu-primary inu-full" type="button" disabled={saving} onClick={() => void save()}>{saving ? '저장 중…' : 'API 키 사용 규칙 저장'}</button>
  </section>;
}
