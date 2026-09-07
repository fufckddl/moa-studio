import { useRef, useState } from 'react';
import type { Photo } from '../types';
import type { ProtectedRegion } from '../lib/photoProtection';

interface Props {
  photo: Photo;
  region: ProtectedRegion | null;
  onChange: (region: ProtectedRegion | null) => void;
  disabled: boolean;
}

export function PhotoProtection({ photo, region, onChange, disabled }: Props) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<ProtectedRegion | null>(null);
  const selection = draft ?? region;
  function point(event: React.PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) };
  }
  function finish(event: React.PointerEvent<HTMLDivElement>) {
    if (!start.current) return;
    const end = point(event);
    const next = { x: Math.min(start.current.x, end.x), y: Math.min(start.current.y, end.y), width: Math.abs(start.current.x - end.x), height: Math.abs(start.current.y - end.y) };
    if (next.width >= .02 && next.height >= .02) onChange(next);
    start.current = null; setDraft(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  return <div className="photo-protection-selector">
    <p id="photo-protection-help">사진에서 얼굴과 머리카락을 넉넉히 감싸도록 드래그하세요. 선택한 영역은 원본으로 유지됩니다.</p>
    <div ref={surface} className={`photo-protection-image${disabled ? ' is-disabled' : ''}`} role="group" aria-label="원본을 유지할 얼굴 영역" aria-describedby="photo-protection-help photo-protection-keyboard" tabIndex={disabled ? -1 : 0}
      onPointerDown={event => {
        if (disabled || event.button !== 0) return;
        event.preventDefault(); event.currentTarget.focus();
        start.current = point(event); setDraft({ ...start.current, width: 0, height: 0 });
        event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerMove={event => {
        if (!start.current) return;
        const end = point(event);
        setDraft({ x: Math.min(start.current.x, end.x), y: Math.min(start.current.y, end.y), width: Math.abs(start.current.x - end.x), height: Math.abs(start.current.y - end.y) });
      }} onPointerUp={finish} onPointerCancel={() => { start.current = null; setDraft(null); }} onLostPointerCapture={() => { start.current = null; setDraft(null); }}
      onKeyDown={event => {
        if (disabled || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const current = region ?? { x: .3, y: .15, width: .4, height: .4 };
        const dx = event.key === 'ArrowLeft' ? -.01 : event.key === 'ArrowRight' ? .01 : 0;
        const dy = event.key === 'ArrowUp' ? -.01 : event.key === 'ArrowDown' ? .01 : 0;
        onChange(event.shiftKey ? { ...current, width: Math.max(.02, Math.min(1 - current.x, current.width + dx)), height: Math.max(.02, Math.min(1 - current.y, current.height + dy)) }
          : { ...current, x: Math.max(0, Math.min(1 - current.width, current.x + dx)), y: Math.max(0, Math.min(1 - current.height, current.y + dy)) });
      }}>
      <img src={photo.dataUrl} alt={`${photo.name} · 얼굴 보호 영역 선택`} draggable={false} onLoad={() => surface.current?.scrollIntoView({ block: 'center' })} />
      {selection && <div className="photo-protection-region" style={{ left: `${selection.x * 100}%`, top: `${selection.y * 100}%`, width: `${selection.width * 100}%`, height: `${selection.height * 100}%` }}><span>원본 유지</span></div>}
    </div>
    <div className="photo-protection-actions"><button type="button" className="ghost-button" disabled={disabled} onClick={() => { onChange({ x: .3, y: .15, width: .4, height: .4 }); surface.current?.focus({ preventScroll: true }); surface.current?.scrollIntoView({ block: 'center' }); }}>중앙 영역 선택</button><button type="button" className="ghost-button" disabled={disabled || !region} onClick={() => onChange(null)}>선택 해제</button></div>
    <p id="photo-protection-keyboard">방향키로 이동 · Shift+방향키로 크기 조절</p>
    <p role="status">{region ? '얼굴 보호 영역이 지정됐어요. 원하는 수정을 요청하세요.' : '먼저 보호할 영역을 지정해 주세요.'}</p>
  </div>;
}
