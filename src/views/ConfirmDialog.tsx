import { useEffect, useRef } from 'react';
interface Props { title: string; children: string; confirmLabel: string; onCancel: () => void; onConfirm: () => void; }
export function ConfirmDialog({ title, children, confirmLabel, onCancel, onConfirm }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="confirm-dialog" aria-labelledby="confirm-title" onCancel={event => { event.preventDefault(); onCancel(); }}>
    <h2 id="confirm-title">{title}</h2><p>{children}</p><div><button autoFocus className="ghost-button" onClick={onCancel}>취소</button><button className="primary-button" onClick={onConfirm}>{confirmLabel}</button></div>
  </dialog>;
}
