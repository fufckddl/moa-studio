import type { ChangeEvent, FormEvent, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { Brand, Brief, ContentCard, ContentPack, ContentCardStyle, Goal, Photo, ScheduleItem, Tone } from '../types';
import { renderCard } from '../lib/export';
import { CARD_LIMITS, CONTENT_LIMITS, cardLayouts, createCardTemplate, normalizeHashtags } from '../lib/templates';
import { BusinessInfo } from './BusinessInfo';
import { PhotoChat } from './PhotoChat';
import './content-editor.css';

type NavKey = 'editor' | 'library' | 'brand';
type ExportKind = 'png' | 'zip';
type PreviewView = 'cards' | 'caption' | 'schedule';

export interface ShellProps {
  page: NavKey;
  brand: Brand;
  children: ReactNode;
  accountControl?: ReactNode;
  onNavigate: (nav: NavKey) => void;
  onHome?: () => void;
}

export interface BriefFormProps {
  brand: Brand;
  brief: Brief;
  photos: Photo[];
  mode: 'ai' | 'template';
  generating: boolean;
  readOnly?: boolean;
  error: string | null;
  onBriefChange: (patch: Partial<Brief>) => void;
  onPhotosAdd: (files: File[]) => void;
  onPhotoRemove: (id: string) => void;
  selectedPhotoId?: string;
  onPhotoSelect: (id: string) => void;
  onGenerate: () => void;
  onLogin?: () => void;
}

export interface WorkspacePreviewProps {
  selectedCardId: string;
  onCardSelect: (id: string) => void;
  brand: Brand;
  photos: Photo[];
  pack: ContentPack;
  exporting: boolean;
  readOnly?: boolean;
  scheduleEnabled?: boolean;
  photoEditingDisabled?: boolean;
  chatUserId: string | null;
  onChatBusyChange: (busy: boolean) => void;
  onPhotoReplace: (previous: Photo, next: Photo) => boolean;
  onPackChange: (pack: ContentPack) => void;
  onExport: (kind: ExportKind, index?: number) => void;
  onLogin?: () => void;
}

const navItems: Array<{ key: NavKey; label: string; icon: IconName }> = [
  { key: 'editor', label: '콘텐츠 만들기', icon: 'pen' },
  { key: 'library', label: '보관함', icon: 'folder' },
  { key: 'brand', label: '브랜드 설정', icon: 'gear' },
];

const toneOptions: Array<{ value: Tone; label: string }> = [
  { value: 'warm', label: '따뜻한' },
  { value: 'simple', label: '담백한' },
  { value: 'playful', label: '경쾌한' },
];

const goalOptions: Array<{ value: Goal; label: string }> = [
  { value: 'new', label: '신메뉴' },
  { value: 'daily', label: '일상 홍보' },
  { value: 'event', label: '이벤트' },
];

type IconName = 'pen' | 'folder' | 'gear' | 'save' | 'upload' | 'download' | 'copy' | 'trash' | 'image' | 'spark' | 'calendar' | 'post' | 'card' | 'plus' | 'close';

function Icon({ name }: { name: IconName }) {
  const common = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  const paths: Record<IconName, ReactNode> = {
    pen: <><path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z" /><path d="m13.5 6.5 3 3" /></>,
    folder: <path d="M3.5 7.5a2 2 0 0 1 2-2h5l2 2h6a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-9Z" />,
    gear: <><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" /><path d="M19 12a7.4 7.4 0 0 0-.1-1l2-1.5-2-3.4-2.4 1a8.7 8.7 0 0 0-1.8-1L14.4 3h-4l-.3 3.1a8.7 8.7 0 0 0-1.8 1l-2.4-1-2 3.4 2 1.5a7.4 7.4 0 0 0 0 2l-2 1.5 2 3.4 2.4-1a8.7 8.7 0 0 0 1.8 1l.3 3.1h4l.3-3.1a8.7 8.7 0 0 0 1.8-1l2.4 1 2-3.4-2-1.5c.1-.3.1-.7.1-1Z" /></>,
    save: <><path d="M5 4h12l2 2v14H5V4Z" /><path d="M8 4v5h8V4" /><path d="M8 20v-6h8v6" /></>,
    upload: <><path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M5 20h14" /></>,
    download: <><path d="M12 4v12" /><path d="m7 11 5 5 5-5" /><path d="M5 20h14" /></>,
    copy: <><path d="M8 8h11v11H8z" /><path d="M5 16H4V5h11v1" /></>,
    trash: <><path d="M5 7h14" /><path d="M9 7V5h6v2" /><path d="M8 10v9" /><path d="M16 10v9" /><path d="M7 7l1 14h8l1-14" /></>,
    image: <><path d="M4 5h16v14H4z" /><path d="m4 15 4-4 4 4 3-3 5 5" /><circle cx="15.5" cy="9" r="1.5" /></>,
    spark: <><path d="M12 3 9.8 9.8 3 12l6.8 2.2L12 21l2.2-6.8L21 12l-6.8-2.2L12 3Z" /></>,
    calendar: <><path d="M5 5h14v15H5z" /><path d="M8 3v4" /><path d="M16 3v4" /><path d="M5 10h14" /></>,
    post: <><path d="M6 5h12v14H6z" /><path d="M9 9h6" /><path d="M9 13h6" /><path d="M9 17h3" /></>,
    card: <><path d="M4 6h16v12H4z" /><path d="M7 10h5" /><path d="M7 14h10" /></>,
    plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
    close: <><path d="m6 6 12 12" /><path d="m18 6-12 12" /></>,
  };
  return <svg aria-hidden="true" {...common}>{paths[name]}</svg>;
}

export function Shell({ page, brand, children, onNavigate, onHome, accountControl }: ShellProps) {
  return (
    <div className="app-shell">
      <header className="sidebar studio-header" aria-label="주 메뉴">
        <button className="brand-mark home-button" type="button" onClick={onHome} aria-label="mo:a studio 홈으로 이동">
          <strong>mo:a</strong>
          <span>studio</span>
        </button>
        <nav className="side-nav" data-tutorial="navigation">
          {navItems.map((item) => (
            <button key={item.key} className={page === item.key ? 'nav-button active' : 'nav-button'} onClick={() => onNavigate(item.key)} aria-current={page === item.key ? 'page' : undefined}>
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="studio-header-account">
          <div className="account-card studio-cafe-card">
            <div className="account-avatar" style={{ backgroundImage: `linear-gradient(135deg, ${brand.color}, #d7c4a8)` }} />
            <div>
              <strong>{brand.name}</strong>
              <span>{brand.instagram}</span>
            </div>
          </div>
          {accountControl}
        </div>
      </header>
      <main className="main-surface">
        <header className="topbar" aria-label="현재 작업">
          <div className="breadcrumb">workspace <span>/</span> {navItems.find((item) => item.key === page)?.label}</div>
        </header>
        {children}
        <footer className="studio-business-footer"><BusinessInfo /></footer>
      </main>
    </div>
  );
}

export function BriefForm({ brand, brief, photos, mode, generating, readOnly = false, error, onBriefChange, onPhotosAdd, onPhotoRemove, selectedPhotoId, onPhotoSelect, onGenerate, onLogin }: BriefFormProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const descriptionLength = brief.description.length;

  function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    onPhotosAdd(Array.from(files));
    if (inputRef.current) inputRef.current.value = '';
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onGenerate();
  }

  return (
    <form className="brief-panel" onSubmit={submit}>
      <PanelStep tutorial="photos" number="01" title="사진 선택">
        <div className="photo-strip" aria-label="선택된 사진">
          {photos.map((photo) => (
            <figure className={selectedPhotoId === photo.id ? 'photo-thumb selected' : 'photo-thumb'} key={photo.id}>
              <button className="photo-select" type="button" aria-label={`${photo.name} 카드에 적용`} aria-pressed={selectedPhotoId === photo.id} disabled={readOnly || generating || !photo.dataUrl} onClick={() => onPhotoSelect(photo.id)}>
                {photo.dataUrl ? <img src={photo.dataUrl} alt={photo.name} /> : <span role="img" aria-label={`${photo.name} 사진을 불러오지 못했어요`}><Icon name="image" /></span>}
              </button>
              <button type="button" aria-label={`${photo.name} 삭제`} onClick={() => onPhotoRemove(photo.id)} disabled={readOnly || generating}>
                <Icon name="close" />
              </button>
            </figure>
          ))}
        </div>
        {photos.some(photo => !photo.dataUrl) && <p role="status">일부 사진을 불러오지 못했어요. 새로고침해도 같다면 해당 사진을 삭제하고 다시 추가해 주세요. 다른 콘텐츠는 계속 이용할 수 있어요.</p>}
        <button
          className={dragging ? 'drop-zone dragging' : 'drop-zone'}
          type="button"
          onClick={() => { if (readOnly) onLogin?.(); else inputRef.current?.click(); }}
          onDragOver={(event) => { event.preventDefault(); if (!readOnly) setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => { event.preventDefault(); setDragging(false); if (!readOnly) handleFiles(event.dataTransfer.files); }}
        >
          <Icon name="upload" />
          <strong>{readOnly ? '로그인하고 사진 추가' : '사진 추가'}</strong>
          <span>{readOnly ? '비회원은 저장된 콘텐츠를 보기만 할 수 있어요.' : 'JPG, PNG, WEBP 최대 3장 · 10MB'}</span>
        </button>
        <input ref={inputRef} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={readOnly} onChange={(event) => handleFiles(event.target.files)} />
      </PanelStep>
      <PanelStep number="02" title="콘텐츠 정보">
        {readOnly ? <ReadOnlyNotice onLogin={onLogin}>둘러보기 모드입니다. 편집·저장하려면 로그인해 주세요.</ReadOnlyNotice> : null}
        <div data-tutorial="information">
        <Field label="메뉴 이름" hint={`${brief.productName.length} / 30`}>
          <input value={brief.productName} maxLength={30} disabled={readOnly} onChange={(event) => onBriefChange({ productName: event.target.value })} />
        </Field>
        <Field label="설명" hint={`${descriptionLength} / 160`}>
          <textarea value={brief.description} maxLength={160} rows={3} disabled={readOnly} onChange={(event) => onBriefChange({ description: event.target.value })} />
        </Field>
        </div>
        <div className="form-row">
          <Field label="가격">
            <input value={brief.price} inputMode="numeric" disabled={readOnly} onChange={(event) => onBriefChange({ price: event.target.value })} />
          </Field>
          <Field label="목적">
            <select value={brief.goal} disabled={readOnly} onChange={(event: ChangeEvent<HTMLSelectElement>) => onBriefChange({ goal: event.target.value as Goal })}>
              {goalOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </Field>
        </div>
        <SegmentedControl label="톤앤매너" value={brief.tone} options={toneOptions} disabled={readOnly} onChange={(tone) => onBriefChange({ tone })} />
        <label className="schedule-toggle">
          <input
            type="checkbox"
            checked={brief.includeSchedule ?? false}
            disabled={readOnly}
            onChange={(event) => onBriefChange({ includeSchedule: event.target.checked })}
          />
          <span>
            <strong>홍보 일정 만들기</strong>
            <span>자동게시가 아닌 게시계획 제안입니다. 선택하면 일정 탭에서 날짜와 내용을 직접 편집할 수 있어요.</span>
          </span>
        </label>
        <Field label="홍보 시작일">
          <input
            type="date"
            value={brief.scheduleStartDate ?? ''}
            disabled={readOnly || !(brief.includeSchedule ?? false)}
            onChange={(event) => onBriefChange({ scheduleStartDate: event.target.value })}
          />
        </Field>
        <div className="mode-note" role="status">
          <Icon name={mode === 'ai' ? 'spark' : 'card'} />
          <span>{mode === 'ai' ? 'AI 생성 모드로 문구를 만듭니다.' : `${brand.name} 입력값만 반영하는 템플릿 모드입니다.`}</span>
        </div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <button data-tutorial="generate" className="primary-button" type="submit" disabled={generating || photos.length === 0 || readOnly}>
          <Icon name="spark" />
          <span>{readOnly ? '로그인하고 만들기' : generating ? '만드는 중' : '콘텐츠 만들기'}</span>
        </button>
      </PanelStep>
    </form>
  );
}

function PanelStep({ number, title, children, tutorial }: { number: string; title: string; children: ReactNode; tutorial?: string }) {
  return (
    <section className="panel-step" data-tutorial={tutorial}>
      <h2><span>{number}</span>{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, hint, children, tutorial }: { label: string; hint?: string; children: ReactNode; tutorial?: string }) {
  return (
    <label className="field" data-tutorial={tutorial}>
      <span><b>{label}</b>{hint ? <em>{hint}</em> : null}</span>
      {children}
    </label>
  );
}

function SegmentedControl<T extends string>({ label, value, options, disabled = false, onChange }: { label: string; value: T; options: Array<{ value: T; label: string }>; disabled?: boolean; onChange: (value: T) => void }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" className={value === option.value ? 'selected' : ''} disabled={disabled} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function WorkspacePreview({ selectedCardId, onCardSelect: setSelectedCardId, brand, photos, pack, exporting, readOnly = false, scheduleEnabled = false, photoEditingDisabled = false, onPhotoReplace, onPackChange, onExport, onLogin, chatUserId, onChatBusyChange }: WorkspacePreviewProps) {
  const [view, setView] = useState<PreviewView>('cards');
  const [editing, setEditing] = useState(true);
  useEffect(() => {
    const showEditor = () => { setView('cards'); setEditing(true); };
    window.addEventListener('moa:tutorial:open-editor', showEditor);
    return () => window.removeEventListener('moa:tutorial:open-editor', showEditor);
  }, []);
  const [feedback, setFeedback] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [chatCardPreview, setChatCardPreview] = useState<{ card: ContentCard; photo: Photo | undefined; brand: Brand; dataUrl: string } | null>(null);
  const selectedIndex = Math.max(0, pack.cards.findIndex((card) => card.id === selectedCardId));
  const selectedCard = pack.cards[selectedIndex] ?? pack.cards[0];
  const selectedPhoto = photos.find((photo) => photo.id === selectedCard?.imageId) ?? photos[0];
  const scheduleAvailable = scheduleEnabled || pack.schedule.length > 0;

  useEffect(() => {
    let mounted = true;
    const target = canvasRef.current;
    if (!selectedCard) return;

    const offscreen = document.createElement('canvas');
    renderCard(offscreen, selectedCard, selectedPhoto, brand)
      .then(() => {
        if (!mounted) return;
        setChatCardPreview({ card: selectedCard, photo: selectedPhoto, brand, dataUrl: offscreen.toDataURL('image/png') });
        if (target && view === 'cards') {
          target.width = offscreen.width;
          target.height = offscreen.height;
          const context = target.getContext('2d');
          if (!context) throw new Error('미리보기 canvas를 사용할 수 없어요.');
          context.clearRect(0, 0, target.width, target.height);
          context.drawImage(offscreen, 0, 0);
        }
        setFeedback('');
      })
      .catch(() => {
        if (!mounted) return;
        setChatCardPreview(null);
        target?.getContext('2d')?.clearRect(0, 0, target.width, target.height);
        setFeedback('선택한 사진을 미리보기에 불러오지 못했어요. 다른 사진을 선택해 주세요.');
      });

    return () => {
      mounted = false;
    };
  }, [brand, selectedCard, selectedPhoto, view]);

  useEffect(() => {
    if (!pack.cards.length) {
      if (selectedCardId) setSelectedCardId('');
      return;
    }
    if (pack.cards.some((card) => card.id === selectedCardId)) return;
    setSelectedCardId(pack.cards[Math.min(selectedIndex, pack.cards.length - 1)]?.id ?? pack.cards[0].id);
  }, [pack.cards, selectedCardId, selectedIndex]);

  useEffect(() => {
    if (view === 'schedule' && !scheduleAvailable) setView('cards');
  }, [scheduleAvailable, view]);

  function chooseView(nextView: PreviewView) {
    setView(nextView);
    setFeedback('');
  }

  function moveSlide(direction: -1 | 1) {
    if (!pack.cards.length) return;
    if (photoEditingDisabled) return;
    const nextIndex = (selectedIndex + pack.cards.length + direction) % pack.cards.length;
    setSelectedCardId(pack.cards[nextIndex].id);
  }

  function patchCard(patch: Partial<Omit<ContentCard, 'id'>>) {
    if (!selectedCard || photoEditingDisabled || readOnly) return;
    const cards = pack.cards.map((card) => card.id === selectedCard.id ? { ...card, ...patch, id: card.id } : card);
    onPackChange({ ...pack, cards });
  }

  function patchCardStyle(patch: Partial<ContentCardStyle>) {
    if (!selectedCard || photoEditingDisabled) return;
    patchCard({ style: { ...(selectedCard.style ?? {}), ...patch } });
  }

  function addCard() {
    if (readOnly) { onLogin?.(); return; }
    if (pack.cards.length >= CARD_LIMITS.max) {
      setFeedback(`카드는 최대 ${CARD_LIMITS.max}장까지 만들 수 있어요.`);
      return;
    }

    const card = createCardTemplate(pack.cards.length, photos, brand);
    onPackChange({ ...pack, cards: [...pack.cards, card] });
    setSelectedCardId(card.id);
    setEditing(true);
    setFeedback('');
  }

  function deleteCard() {
    if (readOnly) { onLogin?.(); return; }
    if (pack.cards.length <= CARD_LIMITS.min) {
      setFeedback('카드는 최소 1장이 필요해요.');
      return;
    }

    const cards = pack.cards.filter((_, index) => index !== selectedIndex);
    onPackChange({ ...pack, cards });
    setSelectedCardId(cards[Math.max(0, selectedIndex - 1)]?.id ?? '');
    setFeedback('');
  }

  async function copyCaption() {
    if (readOnly) { onLogin?.(); return; }
    const text = `${pack.caption}\n\n${pack.hashtags.join(' ')}`.trim();
    try {
      await navigator.clipboard.writeText(text);
      setFeedback('게시글 문구를 복사했어요.');
    } catch {
      setFeedback('브라우저가 복사를 허용하지 않았어요. 문구를 선택해서 직접 복사해 주세요.');
    }
    window.setTimeout(() => setFeedback(''), 1800);
  }

  function updateCaption(value: string) {
    if (readOnly) return;
    onPackChange({ ...pack, caption: value });
  }

  function updateHashtags(value: string) {
    if (readOnly) return;
    onPackChange({ ...pack, hashtags: normalizeHashtags(value) });
  }

  function updateSchedule(index: number, patch: Partial<ScheduleItem>) {
    if (readOnly) return;
    const schedule = pack.schedule.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item);
    onPackChange({ ...pack, schedule });
  }

  function addScheduleItem() {
    if (readOnly) { onLogin?.(); return; }
    if (pack.schedule.length >= CONTENT_LIMITS.schedule) {
      setFeedback(`홍보 일정은 최대 ${CONTENT_LIMITS.schedule}개까지 만들 수 있어요.`);
      return;
    }

    onPackChange({
      ...pack,
      schedule: [
        ...pack.schedule,
        { day: '', date: '', title: '새 홍보 일정', format: '게시글', description: '' },
      ],
    });
  }

  function deleteScheduleItem(index: number) {
    if (readOnly) { onLogin?.(); return; }
    onPackChange({ ...pack, schedule: pack.schedule.filter((_, itemIndex) => itemIndex !== index) });
  }

  async function copySchedule() {
    if (readOnly) { onLogin?.(); return; }
    const text = pack.schedule
      .map((item) => [item.date, item.day, item.title, item.format, item.description].filter(Boolean).join('\n'))
      .join('\n\n')
      .trim();
    try {
      await navigator.clipboard.writeText(text);
      setFeedback('홍보 일정을 복사했어요.');
    } catch {
      setFeedback('브라우저가 복사를 허용하지 않았어요. 일정을 선택해서 직접 복사해 주세요.');
    }
    window.setTimeout(() => setFeedback(''), 1800);
  }

  return (
    <section className="preview-panel" aria-label="콘텐츠 미리보기">
      <PhotoChat userId={chatUserId} onBusyChange={onChatBusyChange} cardId={selectedCard?.id ?? 'empty'} photo={selectedPhoto} cardTitle={selectedCard?.title ?? ''} cardPreview={chatCardPreview?.card === selectedCard && chatCardPreview?.photo === selectedPhoto && chatCardPreview?.brand === brand ? chatCardPreview.dataUrl : undefined} onReplace={onPhotoReplace} disabled={photoEditingDisabled || exporting || readOnly} />
      <div className="preview-toolbar">
        <div className="tabs" data-tutorial="preview" role="tablist" aria-label="미리보기 유형">
          <TabButton active={view === 'cards'} icon="card" label="카드뉴스" onClick={() => chooseView('cards')} />
          <TabButton active={view === 'caption'} icon="post" label="게시글" onClick={() => chooseView('caption')} />
          {scheduleAvailable ? <TabButton active={view === 'schedule'} icon="calendar" label="홍보 일정" onClick={() => chooseView('schedule')} /> : null}
        </div>
        <div className="export-group" data-tutorial="export">
          <button className="ghost-button" onClick={() => onExport('png', selectedIndex)} disabled={exporting || readOnly || view !== 'cards' || !selectedCard}>
            <Icon name="download" />
            <span>PNG</span>
          </button>
          <button className="ghost-button" onClick={() => onExport('zip')} disabled={exporting || readOnly || !pack.cards.length}>
            <Icon name="download" />
            <span>ZIP</span>
          </button>
        </div>
      </div>

      {feedback ? <p className="preview-feedback" role="status">{feedback}</p> : null}
      {readOnly ? <ReadOnlyNotice onLogin={onLogin}>둘러보기 모드입니다. 편집·저장하려면 로그인해 주세요.</ReadOnlyNotice> : null}

      {view === 'cards' ? (
        <div className="card-workspace">
          <div className="canvas-frame">
            <canvas ref={canvasRef} width={1080} height={1350} aria-label={`${selectedCard?.title ?? '카드'} 미리보기`} />
          </div>
          <div className="card-actions" data-tutorial="card-manage" aria-label="카드 관리">
            <button className="ghost-button" type="button" onClick={addCard} disabled={photoEditingDisabled || readOnly || pack.cards.length >= CARD_LIMITS.max}>
              <Icon name="plus" />
              <span>카드 추가</span>
            </button>
            <button className="ghost-button" type="button" onClick={deleteCard} disabled={photoEditingDisabled || readOnly || pack.cards.length <= CARD_LIMITS.min}>
              <Icon name="trash" />
              <span>삭제</span>
            </button>
          </div>
          <div className="slide-controls">
            <button type="button" aria-label="이전 카드" disabled={photoEditingDisabled} onClick={() => moveSlide(-1)}>‹</button>
            <div className="slide-strip card-slide-strip">
              {pack.cards.map((card, index) => {
                const photo = photos.find((item) => item.id === card.imageId) ?? photos[0];
                return (
                  <button key={card.id} className={card.id === selectedCard?.id ? 'slide-thumb active' : 'slide-thumb'} disabled={photoEditingDisabled} onClick={() => setSelectedCardId(card.id)} aria-label={`${index + 1}번 카드 선택`}>
                    <CardThumbnail brand={brand} card={card} photo={photo} />
                    <span>{String(index + 1).padStart(2, '0')}</span>
                  </button>
                );
              })}
            </div>
            <button type="button" aria-label="다음 카드" disabled={photoEditingDisabled} onClick={() => moveSlide(1)}>›</button>
            <strong>{String(selectedIndex + 1).padStart(2, '0')} <span>/ {String(pack.cards.length).padStart(2, '0')}</span></strong>
          </div>
          <button className="edit-toggle" data-tutorial="card-edit" type="button" disabled={readOnly} aria-expanded={editing} onClick={() => setEditing(!editing)}><Icon name={editing ? 'close' : 'pen'} /><span>{readOnly ? '로그인하고 편집' : editing ? '편집 닫기' : '문구 편집'}</span></button>
          {editing && selectedCard ? (
            <fieldset className="edit-panel" disabled={photoEditingDisabled || readOnly} style={{ border: 0, margin: 0, minWidth: 0 }}>
              <div className="form-row">
                <Field tutorial="edit-layout" label="레이아웃">
                  <select value={selectedCard.layout} onChange={(event) => patchCard({ layout: event.target.value as ContentCard['layout'] })}>
                    {cardLayouts.map((layout) => <option key={layout.value} value={layout.value}>{layout.label}</option>)}
                  </select>
                </Field>
                <Field tutorial="edit-photo" label="사진">
                  <select value={selectedCard.imageId} onChange={(event) => patchCard({ imageId: event.target.value })} disabled={photos.length < 2}>
                    {photos.map((photo) => <option key={photo.id} value={photo.id}>{photo.name}</option>)}
                  </select>
                </Field>
              </div>
              <p className="layout-description">{cardLayouts.find((layout) => layout.value === selectedCard.layout)?.description}</p>
              <Field tutorial="edit-eyebrow" label="작은 제목">
                <input value={selectedCard.eyebrow} maxLength={80} onChange={(event) => patchCard({ eyebrow: event.target.value })} />
              </Field>
              <Field tutorial="edit-title" label="큰 제목">
                <textarea rows={3} maxLength={200} value={selectedCard.title} onChange={(event) => patchCard({ title: event.target.value })} />
              </Field>
              <Field tutorial="edit-subtitle" label="부제목">
                <textarea rows={2} maxLength={200} value={selectedCard.subtitle} onChange={(event) => patchCard({ subtitle: event.target.value })} />
              </Field>
              <Field tutorial="edit-body" label="본문">
                <textarea rows={3} maxLength={1000} value={selectedCard.body} onChange={(event) => patchCard({ body: event.target.value })} />
              </Field>
              <div className="style-controls" aria-label="카드 스타일">
                <Field tutorial="edit-text-color" label="텍스트 색">
                  <input type="color" value={selectedCard.style?.textColor ?? '#253229'} onChange={(event) => patchCardStyle({ textColor: event.target.value })} />
                </Field>
                <Field tutorial="edit-background" label="배경 색">
                  <input type="color" value={selectedCard.style?.backgroundColor ?? brand.color} onChange={(event) => patchCardStyle({ backgroundColor: event.target.value })} />
                </Field>
                <Field tutorial="edit-font-size" label="글자 크기" hint={`${Math.round((selectedCard.style?.fontScale ?? 1) * 100)}%`}>
                  <input type="range" min="85" max="120" step="5" value={Math.round((selectedCard.style?.fontScale ?? 1) * 100)} onChange={(event) => patchCardStyle({ fontScale: Number(event.target.value) / 100 })} />
                </Field>
                <Field tutorial="edit-alignment" label="정렬">
                  <select value={selectedCard.style?.align ?? 'left'} onChange={(event) => patchCardStyle({ align: event.target.value as ContentCardStyle['align'] })}>
                    <option value="left">왼쪽</option>
                    <option value="center">가운데</option>
                    <option value="right">오른쪽</option>
                  </select>
                </Field>
              </div>
            </fieldset>
          ) : null}
        </div>
      ) : null}

      {view === 'caption' ? (
        <div className="caption-workspace">
          <Field label="게시글 문구" hint={`${pack.caption.length} / ${CONTENT_LIMITS.captionLength}`}>
            <textarea value={pack.caption} maxLength={CONTENT_LIMITS.captionLength} readOnly={readOnly} onChange={(event) => updateCaption(event.target.value)} rows={12} aria-label="게시글 문구" />
          </Field>
          <Field label="해시태그" hint={`쉼표, 공백, 줄바꿈으로 구분 · ${pack.hashtags.length} / ${CONTENT_LIMITS.hashtags}`}>
            <textarea value={pack.hashtags.join('\n')} readOnly={readOnly} onChange={(event) => updateHashtags(event.target.value)} rows={4} aria-label="해시태그" />
          </Field>
          <div className="hashtag-list">
            {pack.hashtags.map((tag) => <span key={tag}>{tag}</span>)}
          </div>
          <button className="primary-button compact" type="button" onClick={copyCaption} disabled={readOnly}>
            <Icon name="copy" />
            <span>{readOnly ? '로그인하고 복사' : '게시글 복사'}</span>
          </button>
        </div>
      ) : null}

      {view === 'schedule' ? (
        <div className="schedule-list">
          <p className="schedule-intro">자동게시가 아닌 게시계획 제안입니다. 실제 게시 전 날짜와 내용을 확인해 주세요.</p>
          <div className="schedule-actions">
            <button className="ghost-button" type="button" onClick={addScheduleItem} disabled={readOnly || pack.schedule.length >= CONTENT_LIMITS.schedule}>
              <Icon name="plus" />
              <span>일정 추가</span>
            </button>
            <button className="ghost-button" type="button" onClick={copySchedule} disabled={readOnly || !pack.schedule.length}>
              <Icon name="copy" />
              <span>일정 복사</span>
            </button>
          </div>
          {pack.schedule.length ? pack.schedule.map((item, index) => (
            <article key={`${index}-${item.day}-${item.title}`} className="schedule-item editable">
              <div className="schedule-item-header">
                <strong>{String(index + 1).padStart(2, '0')}</strong>
                <button className="ghost-button" type="button" onClick={() => deleteScheduleItem(index)} disabled={readOnly}>
                  <Icon name="trash" />
                  <span>삭제</span>
                </button>
              </div>
              <div className="schedule-fields">
                <div className="form-row">
                  <Field label="날짜">
                    <input type="date" value={item.date ?? ''} readOnly={readOnly} onChange={(event) => updateSchedule(index, { date: event.target.value })} />
                  </Field>
                  <Field label="요일">
                    <input value={item.day} maxLength={20} readOnly={readOnly} onChange={(event) => updateSchedule(index, { day: event.target.value })} />
                  </Field>
                </div>
                <div className="form-row">
                  <Field label="제목">
                    <input value={item.title} maxLength={120} readOnly={readOnly} onChange={(event) => updateSchedule(index, { title: event.target.value })} />
                  </Field>
                  <Field label="형식">
                    <input value={item.format} maxLength={80} readOnly={readOnly} onChange={(event) => updateSchedule(index, { format: event.target.value })} />
                  </Field>
                </div>
                <Field label="설명">
                  <textarea rows={3} maxLength={500} value={item.description} readOnly={readOnly} onChange={(event) => updateSchedule(index, { description: event.target.value })} />
                </Field>
              </div>
            </article>
          )) : <p className="empty-state">홍보 일정이 비어 있어요. 일정 추가를 눌러 직접 작성할 수 있습니다.</p>}
        </div>
      ) : null}
    </section>
  );
}

function ReadOnlyNotice({ children, onLogin }: { children: ReactNode; onLogin?: () => void }) {
  return (
    <div className="read-only-notice" role="status">
      <span>{children}</span>
      {onLogin ? <button className="ghost-button" type="button" onClick={onLogin}>로그인</button> : null}
    </div>
  );
}

function CardThumbnail({ brand, card, photo }: { brand: Brand; card: ContentCard; photo: Photo | undefined }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let mounted = true;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const offscreen = document.createElement('canvas');
    renderCard(offscreen, card, photo, brand)
      .then(() => {
        if (!mounted) return;
        canvas.width = offscreen.width;
        canvas.height = offscreen.height;
        canvas.getContext('2d')?.drawImage(offscreen, 0, 0);
      })
      .catch(() => {
        if (!mounted) return;
        canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      });

    return () => {
      mounted = false;
    };
  }, [brand, card, photo]);

  return <canvas ref={canvasRef} width={1080} height={1350} aria-hidden="true" />;
}

function TabButton({ active, icon, label, onClick }: { active: boolean; icon: IconName; label: string; onClick: () => void }) {
  return (
    <button role="tab" aria-selected={active} className={active ? 'tab-button active' : 'tab-button'} type="button" onClick={onClick}>
      <Icon name={icon} />
      <span>{label}</span>
    </button>
  );
}
