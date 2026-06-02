import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import type { Work } from '@/types/db';

type Tab = 'basic' | 'prompt' | 'keywords';
const MAX_THUMB_BYTES = 5 * 1024 * 1024; // 5MB

export default function WorkEditorPage() {
  const { workId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [tab, setTab] = useState<Tab>('basic');
  const [work, setWork] = useState<Work | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    supabase
      .from('works')
      .select('*')
      .eq('id', workId)
      .single()
      .then(({ data }) => setWork(data as Work));
  }, [workId]);

  function patch(p: Partial<Work>) {
    setWork((w) => (w ? { ...w, ...p } : w));
  }

  const titleOver = work ? work.title.length > 30 : false;
  const descOver = work ? work.description.length > 1000 : false;
  const canSave = !titleOver && !descOver;

  async function save() {
    if (!work || !canSave) return;
    setSaving(true);
    const { error } = await supabase
      .from('works')
      .update({
        title: work.title,
        description: work.description,
        main_prompt: work.main_prompt,
        thumbnail_url: work.thumbnail_url,
        visibility: work.visibility,
        is_published: work.visibility === 'public',
        updated_at: new Date().toISOString(),
      })
      .eq('id', work.id);
    setSaving(false);
    if (error) alert('저장 실패: ' + error.message);
    else alert('저장되었습니다.');
  }

  async function uploadThumb(file: File) {
    if (!work || !user) return;
    if (file.size > MAX_THUMB_BYTES) {
      alert('썸네일은 5MB 이하만 업로드할 수 있습니다.');
      return;
    }
    setUploading(true);
    const ext = file.name.split('.').pop() ?? 'jpg';
    const path = `${user.id}/${work.id}.${ext}`;
    const { error } = await supabase.storage
      .from('thumbnails')
      .upload(path, file, { upsert: true });
    if (error) {
      setUploading(false);
      alert('업로드 실패: ' + error.message);
      return;
    }
    const { data } = supabase.storage.from('thumbnails').getPublicUrl(path);
    patch({ thumbnail_url: `${data.publicUrl}?t=${Date.now()}` });
    setUploading(false);
  }

  async function remove() {
    if (!work) return;
    if (!confirm('이 작품을 삭제할까요? 되돌릴 수 없습니다.')) return;
    await supabase.from('works').delete().eq('id', work.id);
    navigate('/create');
  }

  if (!work) return <p className="p-6 text-slate-400">불러오는 중…</p>;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-4 py-3">
        <button onClick={() => navigate('/create')} className="text-sm text-slate-400">
          ← 목록
        </button>
        <button
          onClick={save}
          disabled={saving || !canSave}
          className="ml-auto rounded-lg bg-brand px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {saving ? '저장 중…' : '저장'}
        </button>
      </div>

      {/* 탭 */}
      <div className="flex border-b border-surface2 text-sm">
        {([
          ['basic', '기본정보'],
          ['prompt', '메인 프롬프트'],
          ['keywords', '키워드북'],
        ] as [Tab, string][]).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`flex-1 py-2.5 ${tab === k ? 'border-b-2 border-brand text-white' : 'text-slate-400'}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {tab === 'basic' && (
          <div className="flex flex-col gap-4">
            <div>
              <label className="mb-1 block text-xs text-slate-400">썸네일 (5MB 이하)</label>
              <div className="flex items-center gap-3">
                <div className="h-20 w-20 overflow-hidden rounded-lg bg-surface2">
                  {work.thumbnail_url && (
                    <img src={work.thumbnail_url} alt="" className="h-full w-full object-cover" />
                  )}
                </div>
                <label className="cursor-pointer rounded-lg bg-surface px-3 py-2 text-sm text-slate-200">
                  {uploading ? '업로드 중…' : '이미지 선택'}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => e.target.files?.[0] && uploadThumb(e.target.files[0])}
                  />
                </label>
              </div>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="text-xs text-slate-400">제목</label>
                <span className={`text-[11px] ${titleOver ? 'text-red-400' : 'text-slate-500'}`}>{work.title.length}/30</span>
              </div>
              <input
                value={work.title}
                onChange={(e) => patch({ title: e.target.value })}
                className={`w-full rounded-lg bg-surface px-4 py-3 text-sm outline-none ring-1 ${titleOver ? 'ring-red-500 text-red-300' : 'ring-transparent'}`}
              />
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="text-xs text-slate-400">설명</label>
                <span className={`text-[11px] ${descOver ? 'text-red-400' : 'text-slate-500'}`}>{work.description.length}/1000</span>
              </div>
              <textarea
                value={work.description}
                onChange={(e) => patch({ description: e.target.value })}
                rows={5}
                className={`w-full resize-none rounded-lg bg-surface px-4 py-3 text-sm outline-none ring-1 ${descOver ? 'ring-red-500 text-red-300' : 'ring-transparent'}`}
              />
            </div>

            <div>
              <label className="mb-2 block text-xs text-slate-400">공개 범위</label>
              <div className="flex flex-col gap-2">
                {([
                  ['public', '전체 공개', '작품 목록에 노출, 누구나 플레이'],
                  ['unlisted', '링크 공개', '목록에 미노출, 링크 아는 사람만 플레이'],
                  ['private', '비공개', '본인만 플레이 가능'],
                ] as ['public' | 'unlisted' | 'private', string, string][]).map(([val, label, desc]) => (
                  <label key={val} className="flex cursor-pointer items-start gap-3 rounded-lg bg-surface p-3">
                    <input
                      type="radio"
                      name="visibility"
                      value={val}
                      checked={(work.visibility ?? 'public') === val}
                      onChange={() => patch({ visibility: val })}
                      className="mt-0.5"
                    />
                    <div>
                      <p className="text-sm text-white">{label}</p>
                      <p className="text-xs text-slate-400">{desc}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <button onClick={remove} className="mt-4 text-sm text-red-400">
              작품 삭제
            </button>
          </div>
        )}

        {tab === 'prompt' && (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs text-slate-400">
                {work.main_prompt.length > 6000 ? '⚠️ 6000자 권장 초과' : '6000자 이내 권장 (제한 없음)'}
              </p>
              <span className={`text-[11px] ${work.main_prompt.length > 6000 ? 'text-amber-400' : 'text-slate-500'}`}>
                {work.main_prompt.length}/6000
              </span>
            </div>
            <textarea
              value={work.main_prompt}
              onChange={(e) => patch({ main_prompt: e.target.value })}
              rows={18}
              placeholder="롤플레잉 설정, 세계관, 캐릭터 등을 작성하세요."
              className={`w-full resize-none rounded-lg bg-surface px-4 py-3 text-sm leading-relaxed outline-none ring-1 ${work.main_prompt.length > 6000 ? 'ring-amber-500' : 'ring-transparent'}`}
            />
          </div>
        )}

        {tab === 'keywords' && (
          <div className="rounded-lg border border-dashed border-surface2 p-6 text-center text-sm text-slate-400">
            키워드북 편집은 Phase 2에서 추가됩니다.
            <br />
            (동시 3개 활성 · 키워드 5개 · 500자 · 1~5턴 유지)
          </div>
        )}
      </div>
    </div>
  );
}
