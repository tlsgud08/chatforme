import type { ButtonHTMLAttributes } from 'react';
import './Toggle.css';

type Props = Pick<ButtonHTMLAttributes<HTMLButtonElement>, 'id' | 'disabled' | 'aria-describedby'> & {
  'aria-label': string;
  checked: boolean;
  onChange: (checked: boolean) => void;
};

export default function Toggle({ checked, onChange, disabled = false, ...attributes }: Props) {
  return <button {...attributes} type="button" role="switch" aria-checked={checked}
    disabled={disabled} className="app-toggle" onClick={() => { if (!disabled) onChange(!checked); }}>
    <span className="app-toggle-thumb" aria-hidden="true" />
  </button>;
}
