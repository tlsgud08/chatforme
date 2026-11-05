import { useEffect, useRef, useState } from 'react';
import type { WorkSort } from '@/lib/workRanking';
import InterfaceIcon from './InterfaceIcon';

const choices: { value: WorkSort; label: string }[] = [
  { value: 'latest', label: '최신순' }, { value: 'messages', label: '메시지' }, { value: 'sessions', label: '세션' },
];
export default function WorkSortDropdown({ value, onChange }: { value: WorkSort; onChange: (value: WorkSort) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const options = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    if (!open) return;
    options.current[choices.findIndex(choice => choice.value === value)]?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, value]);
  function close() { setOpen(false); trigger.current?.focus(); }
  return <div ref={root} className="relative ml-auto" onBlur={event => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
  }}>
    <button ref={trigger} type="button" aria-label="작품 정렬" aria-haspopup="menu" aria-expanded={open}
      onClick={() => setOpen(current => !current)} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); }
        if (event.key === 'Escape') close();
      }} className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-slate-400">
      {choices.find(choice => choice.value === value)?.label}<InterfaceIcon name="down" />
    </button>
    {open && <div role="menu" aria-label="작품 정렬 기준" className="absolute right-0 top-full z-30 mt-1 w-28 overflow-hidden rounded-lg border border-surface2 bg-surface shadow-xl"
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        const index = options.current.findIndex(option => option === document.activeElement);
        const next = event.key === 'ArrowDown' ? (index + 1) % choices.length : event.key === 'ArrowUp' ? (index + choices.length - 1) % choices.length : event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : null;
        if (next !== null) { event.preventDefault(); options.current[next]?.focus(); }
      }}>
      {choices.map((choice, index) => <button key={choice.value} ref={element => { options.current[index] = element; }}
        type="button" role="menuitemradio" aria-checked={value === choice.value}
        onClick={() => { onChange(choice.value); close(); }}
        className={`flex w-full items-center justify-between px-3 py-2.5 text-left text-xs focus:bg-surface2 focus:outline-none ${value === choice.value ? 'text-brand' : 'text-slate-400'}`}>
        {choice.label}{value === choice.value && <InterfaceIcon name="check" />}
      </button>)}
    </div>}
  </div>;
}
