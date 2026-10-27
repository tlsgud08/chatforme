import InterfaceIcon from '@/components/InterfaceIcon';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { getApiKey } from '@/lib/apiKeys';
import { generate } from '@/lib/llm';
import { multichatGenerationSlot, multichatParticipantLabels, multichatSystemParts } from '@/lib/multichat';
import { loadDefaultReasoning } from '@/lib/modelPreferences';
import { showToast } from '@/lib/toast';
import type { MultichatMember, MultichatRoom, Persona, Work } from '@/types/db';

type GameMessage={id:string;round_number:number;role:'user'|'assistant';content:string;generation_status:string;reroll_index:number;is_active_variant:boolean};
type PartyMessage={id:string;sender_user_id:string;content:string;created_at:string};
type Submission={round_number:number;user_id:string;slot:1|2;content:string;is_skip:boolean};
type Completion={target_room:string;target_round:number;response_content:string;in_tokens:number;out_tokens:number;response_cost:number;failed:boolean};

export default function MultichatPage(){
 const {roomId}=useParams(); const {user}=useAuth(); const nav=useNavigate();
 const [room,setRoom]=useState<MultichatRoom|null>(null),[work,setWork]=useState<Work|null>(null),[members,setMembers]=useState<MultichatMember[]>([]),[personas,setPersonas]=useState<Persona[]>([]);
 const [messages,setMessages]=useState<GameMessage[]>([]),[party,setParty]=useState<PartyMessage[]>([]),[submissions,setSubmissions]=useState<Submission[]>([]);
 const [text,setText]=useState(''),[partyMode,setPartyMode]=useState(false),[busy,setBusy]=useState(false); const generating=useRef(false);
 const [lobbyPassword,setLobbyPassword]=useState('');
 const [generationRound,setGenerationRound]=useState<number|null>(null);
 const [pendingCompletion,setPendingCompletion]=useState<Completion|null>(null);
 const autoAttempt=useRef('');
 const me=members.find(m=>m.user_id===user?.id), isHost=room?.host_user_id===user?.id;
 const mySlot=me?.slot;
 const currentRound=room?.current_round??0;
 const currentMessage=messages.filter(m=>m.role==='assistant'&&m.round_number===currentRound).at(-1);
 const previousMessage=messages.filter(m=>m.role==='assistant'&&m.round_number===currentRound-1).at(-1);
 const hasStreaming=messages.some(m=>m.role==='assistant'&&m.generation_status==='streaming');
 const previousInterrupted=previousMessage?.generation_status==='interrupted';
 const canGenerate=currentRound>0&&mySlot===multichatGenerationSlot(currentRound);
 const canReroll=currentRound>1&&mySlot===multichatGenerationSlot(currentRound-1);

 const load=useCallback(async()=>{ if(!roomId)return; const {data:r,error}=await supabase.from('multichat_rooms').select('*').eq('id',roomId).single(); if(error){showToast('방에 접근할 수 없습니다.');nav('/sessions');return;} const rr=r as MultichatRoom; setRoom(rr);
  const [w,ms,gm,pm,ss,ps]=await Promise.all([supabase.from('works').select('*').eq('id',rr.work_id).single(),supabase.from('multichat_members').select('*,profiles:public_profiles!multichat_members_public_profile_fk(display_name,avatar_url),personas(name,description)').eq('room_id',roomId).order('slot'),supabase.from('multichat_messages').select('*').eq('room_id',roomId).order('round_number').order('reroll_index'),supabase.from('multichat_party_messages').select('*').eq('room_id',roomId).order('created_at'),supabase.from('multichat_submissions').select('*').eq('room_id',roomId),supabase.from('personas').select('*').eq('user_id',user!.id).order('is_default',{ascending:false})]);
  setWork(w.data as Work);setMembers((ms.data as MultichatMember[])??[]);setMessages((gm.data as GameMessage[])??[]);setParty((pm.data as PartyMessage[])??[]);setSubmissions((ss.data as Submission[])??[]);setPersonas((ps.data as Persona[])??[]);
 },[roomId,user,nav]);
 useEffect(()=>{void load(); const channel=supabase.channel(`multichat:${roomId}`).on('postgres_changes',{event:'*',schema:'public',table:'multichat_rooms',filter:`id=eq.${roomId}`},()=>void load()).on('postgres_changes',{event:'*',schema:'public',table:'multichat_members',filter:`room_id=eq.${roomId}`},()=>void load()).on('postgres_changes',{event:'*',schema:'public',table:'multichat_submissions',filter:`room_id=eq.${roomId}`},()=>void load()).on('postgres_changes',{event:'*',schema:'public',table:'multichat_messages',filter:`room_id=eq.${roomId}`},()=>void load()).on('postgres_changes',{event:'INSERT',schema:'public',table:'multichat_party_messages',filter:`room_id=eq.${roomId}`},()=>void load()).subscribe(); return()=>{void supabase.removeChannel(channel)};},[roomId,load]);

 const runGeneration=useCallback(async(reroll=false)=>{
  if(!room||!work||generating.current||pendingCompletion)return;
  const targetRound=room.current_round-(reroll?1:0);
  if(targetRound<1||mySlot!==multichatGenerationSlot(targetRound))return;
  generating.current=true;setGenerationRound(targetRound);
  let claimedRound=0;
  let completion:Completion|null=null;
  try{
   const key=getApiKey('openrouter');
   if(!key.trim())throw new Error(`설정에서 PC${mySlot}의 OpenRouter API 키를 저장하세요.`);
   const {data:round,error}=await supabase.rpc('claim_multichat_generation',{target_room:room.id,is_reroll:reroll});
   if(error)throw error;if(!round)return;claimedRound=round;
   // Do not issue a paid request if our view of the room was stale.
   if(round!==targetRound)throw new Error('턴이 변경되었습니다. 다시 시도해 주세요.');
   const [cfg,history,memberRows]=await Promise.all([
    supabase.from('platform_config').select('system_prompt,multichat_system_prompt').eq('id',1).single(),
    supabase.from('multichat_messages').select('*').eq('room_id',room.id).lte('round_number',round).order('round_number').order('reroll_index'),
    supabase.from('multichat_members').select('slot,profiles:public_profiles!multichat_members_public_profile_fk(display_name),personas(name,description)').eq('room_id',room.id).order('slot'),
   ]);
   if(cfg.error)throw cfg.error;if(history.error)throw history.error;if(memberRows.error)throw memberRows.error;
   if(!cfg.data||!history.data||memberRows.data?.length!==2)throw new Error('멀티챗 문맥을 불러오지 못했습니다.');
   const people=memberRows.data as unknown as MultichatMember[];
   // During a reroll the previous completed variant stays visible, but must not
   // be included in the context that generates its own replacement.
   const hist=(history.data as GameMessage[])
    .filter(m=>m.role==='user'||(m.round_number<round&&m.generation_status==='complete'&&m.is_active_variant))
    .map(m=>({role:m.role,content:multichatParticipantLabels(m.content)}));
   const result=await generate('openrouter',{
    apiKey:key,model:room.model,sessionId:room.id,
    systemParts:multichatSystemParts(cfg.data,work,people),messages:hist,
    maxOutputTokens:room.output_tokens,reasoning:loadDefaultReasoning('openrouter',room.model),
    onChunk:t=>setMessages(old=>old.map(m=>m.round_number===round&&m.role==='assistant'&&m.generation_status==='streaming'?{...m,content:t}:m)),
   });
   completion={target_room:room.id,target_round:round,response_content:result.text,in_tokens:result.usage.inputTokens,out_tokens:result.usage.outputTokens,response_cost:result.usage.cost,failed:false};
   const saved=await supabase.rpc('complete_multichat_generation',completion);
   if(saved.error)throw saved.error;
  }catch(e){
   if(completion){setPendingCompletion(completion);showToast('응답 저장에 실패했습니다. 응답 저장을 다시 시도해 주세요.');}
   else if(claimedRound){
    const failure:Completion={target_room:room.id,target_round:claimedRound,response_content:'',in_tokens:0,out_tokens:0,response_cost:0,failed:true};
    try{const saved=await supabase.rpc('complete_multichat_generation',failure);if(saved.error)setPendingCompletion(failure);}
    catch{setPendingCompletion(failure);}
   }
   if(!completion)showToast(e instanceof Error?e.message:(e as {message?:string})?.message||'생성 실패');
  }finally{generating.current=false;setGenerationRound(null);await load();}
 },[room,work,mySlot,pendingCompletion,load]);
 useEffect(()=>{
  if(room?.status!=='active'||!canGenerate||previousInterrupted||currentMessage||hasStreaming||pendingCompletion)return;
  if(submissions.filter(s=>s.round_number===room.current_round).length!==2)return;
  const attempt=`${room.id}:${room.current_round}`;
  if(autoAttempt.current===attempt)return;
  autoAttempt.current=attempt;
  void runGeneration();
 },[room,canGenerate,previousInterrupted,currentMessage,hasStreaming,pendingCompletion,submissions,runGeneration]);
 async function retryCompletion(){
  if(!pendingCompletion||pendingCompletion.target_room!==roomId||generating.current)return;
  generating.current=true;setGenerationRound(pendingCompletion.target_round);
  try{
   const {error}=await supabase.rpc('complete_multichat_generation',pendingCompletion);
   if(error)throw error;
   setPendingCompletion(null);await load();
  }catch{showToast('응답 저장에 실패했습니다. 다시 시도해 주세요.');}
  finally{generating.current=false;setGenerationRound(null);}
 }
 useEffect(()=>{if(room?.status==='lobby')setPartyMode(true)},[room?.status]);

 async function send(){if(!room||busy)return;setBusy(true);if(partyMode){if(text.trim())await supabase.from('multichat_party_messages').insert({room_id:room.id,sender_user_id:user!.id,content:text.trim()});}else{const {error}=await supabase.rpc('submit_multichat_turn',{target_room:room.id,submission_content:text});if(error)showToast(error.message);}setText('');setBusy(false);await load();}
 async function setPersona(id:string){const{error}=await supabase.rpc('set_multichat_persona',{target_room:roomId,target_persona:id});if(error)showToast(error.message);else await load();}
 if(!room)return <p className="p-6 text-slate-400">불러오는 중…</p>;
 if(room.status==='lobby')return <div className="multichat-page mx-auto flex h-full max-w-2xl flex-col p-4"><button onClick={()=>nav('/sessions')} className="self-start text-sm text-slate-400"><InterfaceIcon name="back" /> 채팅방</button><h1 className="mt-4 text-xl font-bold text-white">{room.title} 로비</h1><div className="mt-3 rounded-xl bg-surface p-4"><p className="text-xs text-slate-400">초대 코드</p><p className="mt-1 font-mono text-2xl tracking-widest text-brand">{room.invite_code}</p></div><h2 className="mt-5 font-semibold text-white">참여자 {members.length}/2</h2>{members.map(m=><div key={m.user_id} className="mt-2 flex items-center rounded-lg bg-surface p-3"><span className="flex-1 text-sm text-white">{m.slot===1?<InterfaceIcon name="host" />:null} PC{m.slot} · {m.profiles?.display_name}</span>{isHost&&m.user_id!==user?.id&&<button onClick={()=>void supabase.rpc('kick_multichat_member',{target_room:room.id,target_user:m.user_id}).then(()=>load())} className="text-xs text-red-400">추방</button>}</div>)}<label className="mt-5 text-sm text-slate-300">내 페르소나<select value={me?.persona_id??''} onChange={e=>void setPersona(e.target.value)} className="mt-2 w-full rounded-lg bg-surface p-3 text-white"><option value="">선택하세요</option>{personas.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>{isHost&&<><div className="mt-4 flex gap-2"><input type="password" value={lobbyPassword} onChange={e=>setLobbyPassword(e.target.value)} placeholder="새 비밀번호 (공란은 해제)" className="min-w-0 flex-1 rounded-lg bg-surface p-3 text-sm text-white"/><button onClick={()=>void supabase.rpc('set_multichat_password',{target_room:room.id,new_password:lobbyPassword}).then(({error})=>showToast(error?'변경 실패: '+error.message:'비밀번호를 변경했습니다.'))} className="rounded-lg bg-surface2 px-3 text-sm text-white">설정</button></div><button disabled={members.length!==2||members.some(m=>!m.persona_id)} onClick={()=>void supabase.rpc('start_multichat',{target_room:room.id}).then(({error})=>error?showToast(error.message):load())} className="mt-5 w-full rounded-lg bg-brand py-3 font-semibold text-white disabled:opacity-40">시작</button></>}<Party party={party} members={members}/><Composer text={text} setText={setText} send={send} busy={busy} partyMode={true}/></div>;
 const mine=submissions.some(s=>s.round_number===room.current_round&&s.user_id===user?.id);
 return <div className="multichat-page mx-auto flex h-full max-w-2xl flex-col"><header className="flex items-center border-b border-surface2 p-3"><button onClick={()=>nav('/sessions')} aria-label="채팅방 목록으로" className="mr-3 text-slate-400"><InterfaceIcon name="back" /></button><div><h1 className="font-semibold text-white">{room.title}</h1><p className="text-xs text-slate-500">{members.map(m=>`PC${m.slot}`).join(' · ')} · {room.current_round}턴</p></div>{canReroll&&previousMessage&&<button disabled={hasStreaming||generationRound!==null||!!pendingCompletion} onClick={()=>void runGeneration(true)} className="ml-auto rounded bg-surface2 px-3 py-1.5 text-xs text-slate-200">{previousInterrupted?'리롤 다시 시도':'리롤'}</button>}</header><main className="flex-1 overflow-y-auto p-4"><div className="chat-message-list w-full">{messages.filter(m=>m.role==='user'||m.is_active_variant).map(m=><div key={m.id} className={`mb-3 rounded-xl p-3 ${m.role==='assistant'?'bg-surface text-slate-100':'bg-brand/20 text-slate-200'}`}><p className="mb-1 text-xs font-semibold text-slate-500">{m.role==='assistant'?'AI':`참여자 입력 · ${m.round_number}턴`}</p><p className="whitespace-pre-wrap text-sm">{multichatParticipantLabels(m.content)||(m.generation_status==='interrupted'?'생성 중단 · 다시 시도해 주세요.':'생성 중…')}</p></div>)}<Party party={party} members={members}/></div></main><div className="border-t border-surface2 p-3"><div className="mb-2 flex gap-2"><button onClick={()=>setPartyMode(false)} className={`rounded px-3 py-1 text-xs ${!partyMode?'bg-brand text-white':'bg-surface text-slate-400'}`}>AI 턴</button><button onClick={()=>setPartyMode(true)} className={`rounded px-3 py-1 text-xs ${partyMode?'bg-brand text-white':'bg-surface text-slate-400'}`}><InterfaceIcon name="users" /> 파티 메시지</button></div>{!partyMode&&<p className="mb-2 text-xs text-slate-400">{room.current_round}턴 호출 · PC{multichatGenerationSlot(room.current_round)}의 API 키{canGenerate?' (내 차례)':''}</p>}{pendingCompletion&&<button disabled={generationRound!==null} onClick={()=>void retryCompletion()} className="mb-2 rounded bg-surface2 px-3 py-2 text-sm text-white">응답 저장 다시 시도</button>}{!partyMode&&canGenerate&&!previousInterrupted&&!pendingCompletion&&!hasStreaming&&generationRound===null&&submissions.filter(s=>s.round_number===room.current_round).length===2&&(!currentMessage||currentMessage.generation_status==='interrupted')&&<button onClick={()=>void runGeneration()} className="mb-2 rounded bg-surface2 px-3 py-2 text-sm text-white">AI 응답 다시 시도</button>}{mine&&!partyMode?<p className="py-3 text-center text-sm text-slate-400">✓ 제출 완료 · {submissions.filter(s=>s.round_number===room.current_round).length===2?(previousInterrupted?'이전 턴 리롤 복구 대기':`PC${multichatGenerationSlot(room.current_round)}의 AI 응답 대기`):`PC${me?.slot===1?2:1}의 제출 대기`}</p>:<Composer text={text} setText={setText} send={send} busy={busy} partyMode={partyMode}/>}</div></div>;
}
function Party({party,members}:{party:PartyMessage[];members:MultichatMember[]}){return <section className="mt-5 border-t border-surface2 pt-3"><p className="mb-2 text-xs font-semibold text-slate-500">파티 메시지 · AI에게 전달되지 않음</p>{party.slice(-20).map(p=><p key={p.id} className="mb-1 text-xs text-slate-400"><b className="text-slate-300">PC{members.find(m=>m.user_id===p.sender_user_id)?.slot}</b> {p.content}</p>)}</section>}
function Composer({text,setText,send,busy,partyMode}:{text:string;setText:(v:string)=>void;send:()=>Promise<void>;busy:boolean;partyMode:boolean}){return <div className="mt-3 flex gap-2"><textarea rows={2} value={text} onChange={e=>setText(e.target.value)} placeholder={partyMode?'파티원에게만 보낼 메시지':'행동을 입력하세요. 공란 전송은 스킵'} className="flex-1 resize-none rounded-lg bg-surface px-3 py-2 text-sm text-white"/><button disabled={busy||(partyMode&&!text.trim())} onClick={()=>void send()} className="rounded-lg bg-brand px-4 text-sm font-semibold text-white disabled:opacity-40">전송</button></div>}
