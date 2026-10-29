import { useEffect, useRef, useState } from 'react';

interface Props {
  disabled: boolean;
  onCancel: () => void;
  onSubmit: (direction: string) => void;
}

export default function RerollDialog({ disabled, onCancel, onSubmit }: Props) {
  const panelRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const submittedRef = useRef(false);
  const [length, setLength] = useState(0);

  useEffect(() => {
    const previous = document.activeElement;
    const input = inputRef.current;
    input?.focus({ preventScroll: true });
    return () => {
      if (input) input.value = '';
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  return <div className="reroll-dialog-backdrop" onMouseDown={event => {
    if (event.target === event.currentTarget) onCancel();
  }}>
    <form ref={panelRef} className="reroll-dialog" role="dialog" aria-modal="true" aria-labelledby="reroll-dialog-title" aria-describedby="reroll-dialog-help"
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); }
        if (event.key !== 'Tab') return;
        const controls = panelRef.current?.querySelectorAll<HTMLElement>('textarea,button:not(:disabled)');
        const first = controls?.[0], last = controls?.[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}
      onSubmit={event => {
        event.preventDefault();
        if (disabled || submittedRef.current) return;
        submittedRef.current = true;
        // Keep the text only in this mounted input and the one send invocation.
        const direction = inputRef.current?.value.trim() ?? '';
        if (inputRef.current) inputRef.current.value = '';
        setLength(0);
        onSubmit(direction);
      }}>
      <h2 id="reroll-dialog-title">재생성 지침</h2>
      <div className="reroll-dialog-field">
        <textarea ref={inputRef} aria-label="원하는 전개 방향" placeholder="원하는 전개 방향을 입력하세요" rows={4} autoComplete="off"
          onChange={event => setLength(Array.from(event.target.value).length)} />
        <div className="reroll-dialog-count">선택 입력 · {length}자</div>
      </div>
      <p id="reroll-dialog-help">이번 재생성에만 적용돼요. 비워두면 기존 방식으로 재생성해요.</p>
      <div className="reroll-dialog-actions">
        <button type="button" onClick={onCancel}>취소</button>
        <button type="submit" disabled={disabled}>답변 재생성</button>
      </div>
    </form>
  </div>;
}
