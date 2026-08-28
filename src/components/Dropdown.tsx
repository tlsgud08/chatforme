import { useEffect, useId, useRef, useState } from 'react';

export interface DropdownOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface DropdownProps {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
}

/** App-styled, keyboard-accessible replacement for the browser's native select popup. */
export default function Dropdown({ value, options, onChange, ariaLabel, className = '', disabled = false, placeholder = '선택하세요' }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = options[selectedIndex];

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  function moveActive(direction: 1 | -1) {
    if (!options.length) return;
    let next = activeIndex >= 0 ? activeIndex : selectedIndex;
    for (let count = 0; count < options.length; count += 1) {
      next = (next + direction + options.length) % options.length;
      if (!options[next].disabled) { setActiveIndex(next); return; }
    }
  }

  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
  }

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-controls={listId}
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled}
        onClick={() => { setOpen((current) => !current); setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0); }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) setOpen(true);
            moveActive(event.key === 'ArrowDown' ? 1 : -1);
          } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (open && activeIndex >= 0) choose(activeIndex);
            else setOpen(true);
          } else if (event.key === 'Escape') {
            setOpen(false);
          }
        }}
        className="flex w-full items-center justify-between gap-3 rounded-lg bg-surface px-3 py-2.5 text-left text-sm text-white shadow-sm ring-1 ring-inset ring-surface2 disabled:opacity-50"
      >
        <span className={`min-w-0 flex-1 truncate ${selected ? '' : 'text-slate-500'}`}>{selected?.label ?? placeholder}</span>
        <span aria-hidden="true" className={`text-[10px] text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}>▼</span>
      </button>
      {open && (
        <div id={listId} role="listbox" aria-label={ariaLabel} className="absolute left-0 right-0 top-full z-50 mt-1 max-h-60 overflow-y-auto rounded-lg border border-surface2 bg-surface py-1 shadow-2xl">
          {options.length ? options.map((option, index) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              disabled={option.disabled}
              onPointerMove={() => setActiveIndex(index)}
              onClick={() => choose(index)}
              className={`flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm disabled:opacity-40 ${index === activeIndex ? 'bg-surface2' : ''} ${option.value === value ? 'font-semibold text-brand' : 'text-white'}`}
            >
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.value === value && <span aria-hidden="true">✓</span>}
            </button>
          )) : <p className="px-3 py-2.5 text-sm text-slate-500">선택 가능한 항목이 없습니다.</p>}
        </div>
      )}
    </div>
  );
}
