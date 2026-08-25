import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import type { KeywordBook, StartConfig, Work } from '@/types/db';
import { showToast } from '@/lib/toast';
import { showConfirmDialog } from '@/lib/dialog';

type Tab = 'basic' | 'prompt' | 'multichat' | 'start' | 'keywords' | 'permissions';
type EditorProfile = { user_id: string; display_name: string; avatar_url: string | null; created_at: string };
type UserCandidate = { id: string; display_name: string; avatar_url: string | null };
const MAX_THUMB_BYTES = 5 * 1024 * 1024;

function characterCount(value: string, max: number) {
  return `${value.length}/${max} · 공백 제외 ${value.replace(/\s/g, '').length}자`;
}

export default function WorkEditorPage() {
  const { workId } = useParams();
  const navigate = useNavigate();
  const { user, isAdmin } = useAuth();

  const [tab, setTab] = useState<Tab>('basic');
  const [work, setWork] = useState<Work | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [startConfigs, setStartConfigs] = useState<StartConfig[]>([]);
  const [keywordBooks, setKeywordBooks] = useState<KeywordBook[]>([]);
  const [kwInputs, setKwInputs] = useState<Record<string, string>>({});
  const [saveAttempted, setSaveAttempted] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [editors, setEditors] = useState<EditorProfile[]>([]);
  const [userQuery, setUserQuery] = useState('');
  const [candidates, setCandidates] = useState<UserCandidate[]>([]);
  const [searchingUsers, setSearchingUsers] = useState(false);

  useEffect(() => {
    supabase.from('works').select('*').eq('id', workId).single()
      .then(({ data, error }) => error ? setLoadError('작품을 수정할 권한이 없습니다.') : setWork(data as Work));
    supabase.from('keyword_books').select('*').eq('work_id', workId).order('sort_order')
      .then(({ data }) => setKeywordBooks((data as KeywordBook[]) ?? []));
    supabase.from('start_configs').select('*').eq('work_id', workId).order('sort_order')
      .then(({ data }) => {
        const configs = (data as StartConfig[]) ?? [];
        if (configs.length > 0 && !configs.some((c) => c.is_default)) {
          configs[0] = { ...configs[0], is_default: true };
        }
        setStartConfigs(configs);
      });
  }, [workId]);

  const isCreator = work?.creator_id === user?.id;

  useEffect(() => {
    if (!workId || !isCreator) return;
    void loadEditors();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workId, isCreator]);

  useEffect(() => {
    if (!workId || !isCreator || !userQuery.trim()) { setCandidates([]); return; }
    const timer = setTimeout(async () => {
      setSearchingUsers(true);
      const { data, error } = await supabase.rpc('search_work_editor_candidates', { target_work_id: workId, search_text: userQuery });
      setSearchingUsers(false);
      if (error) { showToast('유저 검색 실패: ' + error.message); return; }
      const existing = new Set(editors.map((editor) => editor.user_id));
      setCandidates(((data as UserCandidate[]) ?? []).filter((candidate) => !existing.has(candidate.id)));
    }, 300);
    return () => clearTimeout(timer);
  }, [workId, isCreator, userQuery, editors]);

  async function loadEditors() {
    const { data, error } = await supabase.rpc('get_work_editors', { target_work_id: workId });
    if (error) { showToast('편집자 목록을 불러오지 못했습니다: ' + error.message); return; }
    setEditors((data as EditorProfile[]) ?? []);
  }

  async function grantEditor(candidate: UserCandidate) {
    if (!work || !user || !isCreator) return;
    const { error } = await supabase.from('work_editors').insert({ work_id: work.id, user_id: candidate.id, granted_by: user.id });
    if (error) { showToast('권한 부여 실패: ' + error.message); return; }
    setUserQuery(''); setCandidates([]);
    await loadEditors();
    showToast(`${candidate.display_name || '유저'}님에게 수정 권한을 부여했습니다.`);
  }

  async function revokeEditor(editor: EditorProfile) {
    if (!work || !isCreator) return;
    if (!await showConfirmDialog('수정 권한을 회수할까요?', `${editor.display_name || '이 유저'}는 더 이상 작품을 수정할 수 없습니다.`, '권한 회수')) return;
    const { error } = await supabase.from('work_editors').delete().eq('work_id', work.id).eq('user_id', editor.user_id);
    if (error) { showToast('권한 회수 실패: ' + error.message); return; }
    setEditors((current) => current.filter((item) => item.user_id !== editor.user_id));
  }

  function patch(p: Partial<Work>) {
    setWork((w) => (w ? { ...w, ...p } : w));
  }

  function patchConfig(id: string, p: Partial<StartConfig>) {
    setStartConfigs((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)));
  }

  function setDefaultConfig(id: string) {
    setStartConfigs((cs) => cs.map((c) => ({ ...c, is_default: c.id === id })));
  }

  function patchKeyword(id: string, p: Partial<KeywordBook>) {
    setKeywordBooks((ks) => ks.map((k) => (k.id === id ? { ...k, ...p } : k)));
  }

  const titleOver = work ? work.title.length > 30 : false;
  const descOver = work ? work.description.length > 1000 : false;

  const configErrors = startConfigs.map((cfg) => ({
    id: cfg.id,
    nameError: !cfg.name.trim(),
    messageError: !cfg.initial_message.trim(),
  }));
  const hasConfigErrors = configErrors.some((e) => e.nameError || e.messageError);
  const noConfigs = startConfigs.length === 0;

  const canSave = !titleOver && !descOver;

  async function save() {
    if (!work) return;
    setSaveAttempted(true);
    if (!canSave || noConfigs || hasConfigErrors) {
      if (noConfigs || hasConfigErrors) setTab('start');
      return;
    }
    setSaving(true);
    const { error } = await supabase
      .from('works')
      .update({
        title: work.title,
        description: work.description,
        main_prompt: work.main_prompt,
        multichat_prompt: work.multichat_prompt,
        thumbnail_url: work.thumbnail_url,
        visibility: work.visibility,
        is_published: work.visibility === 'public',
        updated_at: new Date().toISOString(),
      })
      .eq('id', work.id);
    if (error) { setSaving(false); showToast('저장 실패: ' + error.message); return; }

    await Promise.all([
      ...startConfigs.map((cfg) =>
        supabase.from('start_configs').update({
          name: cfg.name,
          initial_message: cfg.initial_message,
          initial_context: cfg.initial_context,
          keep_turns: cfg.keep_turns,
          is_default: cfg.is_default,
        }).eq('id', cfg.id)
      ),
      ...keywordBooks.map((kb) =>
        supabase.from('keyword_books').update({
          name: kb.name,
          keywords: kb.keywords,
          content: kb.content,
          activation_turns: kb.activation_turns,
        }).eq('id', kb.id)
      ),
    ]);
    setSaving(false);
    showToast('저장되었습니다.');
  }

  async function uploadThumb(file: File) {
    if (!work || !user) return;
    if (file.size > MAX_THUMB_BYTES) {
      showToast('썸네일은 5MB 이하만 업로드할 수 있습니다.');
      return;
    }
    setUploading(true);
    const ext = file.name.split('.').pop() ?? 'jpg';
    const path = `${user.id}/${work.id}.${ext}`;
    const { error } = await supabase.storage.from('thumbnails').upload(path, file, { upsert: true });
    if (error) { setUploading(false); showToast('업로드 실패: ' + error.message); return; }
    const { data } = supabase.storage.from('thumbnails').getPublicUrl(path);
    patch({ thumbnail_url: `${data.publicUrl}?t=${Date.now()}` });
    setUploading(false);
  }

  async function remove() {
    if (!work) return;
    if (!await showConfirmDialog('이 작품을 삭제할까요?', '작품과 연결된 데이터가 삭제되며 되돌릴 수 없습니다.', '삭제')) return;
    const { data: deleted, error } = await supabase.from('works').delete().eq('id', work.id).select('id');
    if (error || !deleted?.length) {
      showToast('삭제 실패: ' + (error?.message ?? '작품이 삭제되지 않았습니다.'));
      return;
    }
    navigate('/create');
  }

  async function addStartConfig() {
    if (!work || startConfigs.length >= 3) return;
    const { data, error } = await supabase
      .from('start_configs')
      .insert({ work_id: work.id, name: '', initial_message: '', initial_context: '', keep_turns: 3, sort_order: startConfigs.length, is_default: startConfigs.length === 0 })
      .select('*').single();
    if (error) { showToast('추가 실패: ' + error.message); return; }
    setStartConfigs((cs) => [...cs, data as StartConfig]);
  }

  async function addKeywordBook() {
    if (!work) return;
    const { data, error } = await supabase
      .from('keyword_books')
      .insert({ work_id: work.id, name: '', keywords: [], content: '', activation_turns: 3, sort_order: keywordBooks.length })
      .select('*').single();
    if (error) { showToast('추가 실패: ' + error.message); return; }
    setKeywordBooks((ks) => [...ks, data as KeywordBook]);
  }

  async function deleteKeywordBook(id: string) {
    if (!await showConfirmDialog('이 키워드북을 삭제할까요?', '삭제한 키워드북은 복구할 수 없습니다.', '삭제')) return;
    const { data: deleted, error } = await supabase.from('keyword_books').delete().eq('id', id).select('id');
    if (error || !deleted?.length) {
      showToast('삭제 실패: ' + (error?.message ?? '키워드북이 삭제되지 않았습니다.'));
      return;
    }
    setKeywordBooks((ks) => ks.filter((k) => k.id !== id));
  }

  async function deleteStartConfig(id: string) {
    if (!await showConfirmDialog('이 시작 설정을 삭제할까요?', '삭제한 시작 설정은 복구할 수 없습니다.', '삭제')) return;
    const { data: deleted, error } = await supabase.from('start_configs').delete().eq('id', id).select('id');
    if (error || !deleted?.length) {
      showToast('삭제 실패: ' + (error?.message ?? '시작 설정이 삭제되지 않았습니다.'));
      return;
    }
    setStartConfigs((cs) => cs.filter((c) => c.id !== id));
  }

  if (loadError) return <div className="p-6 text-center"><p className="text-amber-400">{loadError}</p><button onClick={() => navigate('/create')} className="mt-4 text-sm text-slate-400 underline">목록으로</button></div>;
  if (!work) return <p className="p-6 text-slate-400">불러오는 중…</p>;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-4 py-3">
        <button onClick={() => navigate('/create')} className="text-sm text-slate-400">← 목록</button>
        {isAdmin && !isCreator && <span className="rounded-full bg-brand/20 px-2 py-1 text-[11px] text-brand">운영자 편집</span>}
        <button
          onClick={save}
          disabled={saving}
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
          ['multichat', '멀티챗'],
          ['start', '시작 설정'],
          ['keywords', '키워드북'],
          ...(isCreator ? [['permissions', '수정 권한'] as [Tab, string]] : []),
        ] as [Tab, string][]).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`flex-1 py-2.5 text-xs ${tab === k ? 'border-b-2 border-brand text-white' : 'text-slate-400'}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {/* 기본정보 탭 */}
        {tab === 'basic' && (
          <div className="flex flex-col gap-4">
            <div>
              <label className="mb-1 block text-xs text-slate-400">썸네일 (5MB 이하)</label>
              <div className="flex items-center gap-3">
                <div className="aspect-[2/3] w-20 shrink-0 overflow-hidden rounded-lg bg-surface2">
                  {work.thumbnail_url && <img src={work.thumbnail_url} alt="" className="h-full w-full object-cover" />}
                </div>
                <label className="cursor-pointer rounded-lg bg-surface px-3 py-2 text-sm text-slate-200">
                  {uploading ? '업로드 중…' : '이미지 선택'}
                  <input type="file" accept="image/*" className="hidden"
                    onChange={(e) => e.target.files?.[0] && uploadThumb(e.target.files[0])} />
                </label>
              </div>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="text-xs text-slate-400">제목</label>
                <span className={`text-[11px] ${titleOver ? 'text-red-400' : 'text-slate-500'}`}>{characterCount(work.title, 30)}</span>
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
                <span className={`text-[11px] ${descOver ? 'text-red-400' : 'text-slate-500'}`}>{characterCount(work.description, 1000)}</span>
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
                    <input type="radio" name="visibility" value={val}
                      checked={(work.visibility ?? 'public') === val}
                      onChange={() => patch({ visibility: val })} className="mt-0.5" />
                    <div>
                      <p className="text-sm text-white">{label}</p>
                      <p className="text-xs text-slate-400">{desc}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {(isCreator || isAdmin) && <button onClick={remove} className="mt-4 text-sm text-red-400">작품 삭제</button>}
          </div>
        )}

        {/* 메인 프롬프트 탭 */}
        {tab === 'prompt' && (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs text-slate-400">
                {work.main_prompt.length > 6000 ? '⚠️ 6000자 권장 초과' : '6000자 이내 권장 (제한 없음)'}
              </p>
              <span className={`text-[11px] ${work.main_prompt.length > 6000 ? 'text-amber-400' : 'text-slate-500'}`}>
                {characterCount(work.main_prompt, 6000)}
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

        {tab === 'multichat' && (
          <div>
            <h2 className="font-semibold text-white">멀티챗 추가 프롬프트</h2>
            <p className="mt-1 text-xs text-slate-400">멀티챗에서만 메인 프롬프트 뒤에 추가됩니다. 참여자는 user1, user2로 전달되므로 이 이름을 지시문에서 직접 사용할 수 있습니다.</p>
            <textarea value={work.multichat_prompt ?? ''} onChange={e=>patch({multichat_prompt:e.target.value})} rows={18} placeholder="예: user1과 user2의 행동을 동등하게 반영하세요." className="mt-3 w-full resize-none rounded-lg bg-surface px-4 py-3 text-sm leading-relaxed text-white outline-none" />
          </div>
        )}

        {/* 시작 설정 탭 */}
        {tab === 'start' && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <p className="text-xs text-slate-400">최대 3개까지 추가 가능합니다.</p>
              <button
                onClick={addStartConfig}
                disabled={startConfigs.length >= 3}
                className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
              >
                + 추가
              </button>
            </div>

            {startConfigs.length === 0 && (
              <div className={`rounded-lg border p-6 text-center text-sm ${saveAttempted ? 'border-red-500 text-red-400' : 'border-dashed border-surface2 text-slate-500'}`}>
                {saveAttempted ? '시작 설정을 1개 이상 추가해야 저장할 수 있습니다.' : '시작 설정이 없습니다.\n추가하면 채팅 시작 시 선택할 수 있습니다.'}
              </div>
            )}

            {startConfigs.map((cfg, idx) => {
              const errs = configErrors.find((e) => e.id === cfg.id);
              const nameInvalid = saveAttempted && errs?.nameError;
              const msgInvalid = saveAttempted && errs?.messageError;
              return (
                <div key={cfg.id} className="flex flex-col gap-3 rounded-xl bg-surface p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-white">설정 {idx + 1}</span>
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => setDefaultConfig(cfg.id)}
                        title={cfg.is_default ? '기본 설정' : '기본으로 설정'}
                        className={`text-base leading-none ${cfg.is_default ? 'text-brand' : 'text-slate-600'}`}
                      >
                        {cfg.is_default ? '★' : '☆'}
                      </button>
                      <button onClick={() => deleteStartConfig(cfg.id)} className="text-xs text-red-400">삭제</button>
                    </div>
                  </div>

                  <div>
                    <div className="mb-1 flex justify-between">
                      <label className="text-xs text-slate-400">이름 <span className="text-red-400">*</span></label>
                      <span className={`text-[11px] ${cfg.name.length > 30 ? 'text-red-400' : 'text-slate-500'}`}>{characterCount(cfg.name, 30)}</span>
                    </div>
                    <input
                      value={cfg.name}
                      onChange={(e) => patchConfig(cfg.id, { name: e.target.value })}
                      placeholder="예: 학교 복도에서 만남"
                      className={`w-full rounded-lg bg-surface2 px-3 py-2 text-sm outline-none ring-1 ${nameInvalid || cfg.name.length > 30 ? 'ring-red-500' : 'ring-transparent'}`}
                    />
                    {nameInvalid && <p className="mt-0.5 text-[11px] text-red-400">이름을 입력하세요.</p>}
                  </div>

                  <div>
                    <div className="mb-1 flex justify-between">
                      <label className="text-xs text-slate-400">시작 메시지 (AI 첫 출력, 유저에게 보임) <span className="text-red-400">*</span></label>
                      <span className={`text-[11px] ${cfg.initial_message.length > 1000 ? 'text-red-400' : 'text-slate-500'}`}>{characterCount(cfg.initial_message, 1000)}</span>
                    </div>
                    <textarea
                      value={cfg.initial_message}
                      onChange={(e) => patchConfig(cfg.id, { initial_message: e.target.value })}
                      rows={4}
                      placeholder="채팅이 시작될 때 AI가 먼저 건네는 첫 마디를 입력하세요."
                      className={`w-full resize-none rounded-lg bg-surface2 px-3 py-2 text-sm outline-none ring-1 ${msgInvalid || cfg.initial_message.length > 1000 ? 'ring-red-500' : 'ring-transparent'}`}
                    />
                    {msgInvalid && <p className="mt-0.5 text-[11px] text-red-400">시작 메시지를 입력하세요.</p>}
                  </div>

                  <div>
                    <div className="mb-1 flex justify-between">
                      <label className="text-xs text-slate-400">시작 기본 정보 (AI에게만 전달, 유저에게 숨김)</label>
                      <span className={`text-[11px] ${cfg.initial_context.length > 1000 ? 'text-red-400' : 'text-slate-500'}`}>{characterCount(cfg.initial_context, 1000)}</span>
                    </div>
                    <textarea
                      value={cfg.initial_context}
                      onChange={(e) => patchConfig(cfg.id, { initial_context: e.target.value })}
                      rows={4}
                      placeholder="현재 상황, 분위기, 등장인물의 내면 상태 등 AI만 알아야 할 초기 정보를 입력하세요."
                      className={`w-full resize-none rounded-lg bg-surface2 px-3 py-2 text-sm outline-none ring-1 ${cfg.initial_context.length > 1000 ? 'ring-red-500' : 'ring-transparent'}`}
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-xs text-slate-400">
                      기본 정보 유지 턴 수: {cfg.keep_turns}턴
                      <span className="ml-1 text-slate-500">(이후 휘발)</span>
                    </label>
                    <input
                      type="range" min={1} max={5} step={1}
                      value={cfg.keep_turns}
                      onChange={(e) => patchConfig(cfg.id, { keep_turns: Number(e.target.value) })}
                      className="w-full"
                    />
                    <div className="flex justify-between text-[11px] text-slate-600">
                      <span>1턴</span><span>3턴</span><span>5턴</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 키워드북 탭 */}
        {tab === 'keywords' && (
          <div className="flex flex-col gap-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-slate-400">메시지에 키워드가 감지되면 지정한 내용을 AI 프롬프트에 자동 주입합니다.</p>
                <p className="mt-0.5 text-xs text-slate-500">동시 최대 3개 활성 · 키워드 최대 5개 · 내용 500자 이하</p>
              </div>
              <button
                onClick={addKeywordBook}
                className="ml-3 shrink-0 rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white"
              >
                + 추가
              </button>
            </div>

            {keywordBooks.length === 0 && (
              <div className="rounded-lg border border-dashed border-surface2 p-6 text-center text-sm text-slate-500">
                키워드북이 없습니다.<br />추가하면 특정 키워드가 입력될 때 AI에게 추가 정보를 전달할 수 있습니다.
              </div>
            )}

            {keywordBooks.map((kb, idx) => {
              const kwCount = kb.keywords.filter((k) => k.trim()).length;
              return (
                <div key={kb.id} className="flex flex-col gap-3 rounded-xl bg-surface p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-white">키워드북 {idx + 1}</span>
                    <button onClick={() => deleteKeywordBook(kb.id)} className="text-xs text-red-400">삭제</button>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs text-slate-400">이름 (메모용, 선택)</label>
                    <input
                      value={kb.name}
                      onChange={(e) => patchKeyword(kb.id, { name: e.target.value })}
                      placeholder="예: 전투 시작"
                      className="w-full rounded-lg bg-surface2 px-3 py-2 text-sm outline-none"
                    />
                  </div>

                  <div>
                    <div className="mb-1 flex justify-between">
                      <label className="text-xs text-slate-400">트리거 키워드 (엔터로 추가, 최대 5개)</label>
                      <span className={`text-[11px] ${kwCount > 5 ? 'text-red-400' : 'text-slate-500'}`}>{kwCount}/5</span>
                    </div>
                    <div className={`flex flex-wrap gap-1.5 rounded-lg bg-surface2 px-3 py-2 ring-1 ${kwCount > 5 ? 'ring-red-500' : 'ring-transparent'}`}>
                      {kb.keywords.filter((k) => k.trim()).map((kw, ki) => (
                        <span key={ki} className="flex items-center gap-1 rounded bg-surface px-2 py-0.5 text-xs text-slate-200">
                          {kw}
                          <button
                            type="button"
                            onClick={() => patchKeyword(kb.id, { keywords: kb.keywords.filter((_, i) => i !== ki) })}
                            className="ml-0.5 text-slate-400 hover:text-white"
                          >✕</button>
                        </span>
                      ))}
                      {kwCount < 5 && (
                        <input
                          value={kwInputs[kb.id] ?? ''}
                          onChange={(e) => setKwInputs((prev) => ({ ...prev, [kb.id]: e.target.value }))}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              const val = (kwInputs[kb.id] ?? '').trim();
                              if (val && !kb.keywords.includes(val)) {
                                patchKeyword(kb.id, { keywords: [...kb.keywords, val] });
                              }
                              setKwInputs((prev) => ({ ...prev, [kb.id]: '' }));
                            }
                          }}
                          placeholder={kwCount === 0 ? '예: 전투' : '추가…'}
                          className="min-w-[80px] flex-1 bg-transparent text-sm outline-none"
                        />
                      )}
                    </div>
                  </div>

                  <div>
                    <div className="mb-1 flex justify-between">
                      <label className="text-xs text-slate-400">활성화 시 주입 내용</label>
                      <span className={`text-[11px] ${kb.content.length > 500 ? 'text-red-400' : 'text-slate-500'}`}>{characterCount(kb.content, 500)}</span>
                    </div>
                    <textarea
                      value={kb.content}
                      onChange={(e) => patchKeyword(kb.id, { content: e.target.value })}
                      rows={4}
                      placeholder="키워드가 감지됐을 때 AI에게 전달할 추가 지시문을 작성하세요."
                      className={`w-full resize-none rounded-lg bg-surface2 px-3 py-2 text-sm outline-none ring-1 ${kb.content.length > 500 ? 'ring-red-500' : 'ring-transparent'}`}
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-xs text-slate-400">
                      활성 유지 턴: {kb.activation_turns}턴
                      <span className="ml-1 text-slate-500">(감지 후 N턴 동안 유지)</span>
                    </label>
                    <input
                      type="range" min={1} max={5} step={1}
                      value={kb.activation_turns}
                      onChange={(e) => patchKeyword(kb.id, { activation_turns: Number(e.target.value) })}
                      className="w-full"
                    />
                    <div className="flex justify-between text-[11px] text-slate-600">
                      <span>1턴</span><span>3턴</span><span>5턴</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {tab === 'permissions' && isCreator && (
          <div className="flex flex-col gap-5">
            <div>
              <h2 className="text-sm font-semibold text-white">공동 편집자</h2>
              <p className="mt-1 text-xs leading-relaxed text-slate-400">선택한 유저는 기본 정보, 프롬프트, 시작 설정, 키워드북을 수정할 수 있습니다. 권한 관리와 작품 삭제는 제작자만 할 수 있습니다.</p>
            </div>
            <div className="relative">
              <label className="mb-1 block text-xs text-slate-400">유저 검색</label>
              <input value={userQuery} onChange={(event) => setUserQuery(event.target.value)} placeholder="표시 이름을 입력하세요"
                className="w-full rounded-lg bg-surface px-4 py-3 text-sm outline-none ring-1 ring-transparent focus:ring-brand" />
              {(searchingUsers || userQuery.trim()) && (
                <div className="mt-2 overflow-hidden rounded-lg border border-surface2 bg-surface">
                  {searchingUsers ? <p className="p-3 text-xs text-slate-400">검색 중…</p> : candidates.length === 0 ?
                    <p className="p-3 text-xs text-slate-500">추가할 수 있는 유저가 없습니다.</p> : candidates.map((candidate) => (
                      <button key={candidate.id} type="button" onClick={() => void grantEditor(candidate)} className="flex w-full items-center gap-3 border-b border-surface2 p-3 text-left last:border-0 hover:bg-surface2">
                        <span className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-surface2 text-xs text-slate-300">
                          {candidate.avatar_url ? <img src={candidate.avatar_url} alt="" className="h-full w-full object-cover" /> : (candidate.display_name || '?').slice(0, 1)}
                        </span>
                        <span className="text-sm text-white">{candidate.display_name || '이름 없는 유저'}</span>
                        <span className="ml-auto text-xs text-brand">추가</span>
                      </button>
                    ))}
                </div>
              )}
            </div>
            <div>
              <p className="mb-2 text-xs text-slate-400">권한을 가진 유저 {editors.length}명</p>
              {editors.length === 0 ? <div className="rounded-lg border border-dashed border-surface2 p-6 text-center text-sm text-slate-500">아직 공동 편집자가 없습니다.</div> :
                <ul className="divide-y divide-surface2 rounded-lg bg-surface px-3">
                  {editors.map((editor) => <li key={editor.user_id} className="flex items-center gap-3 py-3">
                    <span className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-surface2 text-xs text-slate-300">{editor.avatar_url ? <img src={editor.avatar_url} alt="" className="h-full w-full object-cover" /> : (editor.display_name || '?').slice(0, 1)}</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-white">{editor.display_name || '이름 없는 유저'}</span>
                    <button type="button" onClick={() => void revokeEditor(editor)} className="text-xs text-red-400">권한 회수</button>
                  </li>)}
                </ul>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
