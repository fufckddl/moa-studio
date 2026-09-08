import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import type { Photo, PhotoChatMessage } from '../types';
import type { PhotoEditReference, PhotoEditStatus, PhotoEditUsage } from '../api';
import { editPhoto, generatePerson, getPhotoEditStatus, getPhotoEditUsage } from '../api';
import { preparePhotoForEdit, preparePhotos } from '../lib/images';
import { loadChatHistory, readCachedChatHistory, saveChatHistory } from '../lib/chatHistory';
import { photoVersion } from '../lib/photo-edit';
import { chatWidthBounds, clampChatWidth } from '../lib/photoChatLayout';
import { deletePerson, listPeople, renamePerson, savePerson, type SavedPerson } from '../lib/personLibrary';
import './photo-chat.css';

type ReferencePurpose = 'style' | 'subject';
type ReferenceAttachment = PhotoEditReference;
type ChatMode = 'person' | 'ai';
type ChatMessage = { role: 'user' | 'assistant'; content: string; references?: ReferenceAttachment[] };
type PhotoIdentity = { cardId: string; version: string | null };
type GeneratedPersonSave = { id: string; name: string; prompt: string; state: 'saving' | 'saved' | 'error'; error?: string };
type Candidate =
  | { kind: 'ai'; before: Photo; after: Photo; identity: PhotoIdentity }
  | { kind: 'generated'; after: Photo; save: GeneratedPersonSave };

const personExamples = [
  { label: '따뜻한 바리스타', prompt: '베이지색 앞치마를 입은 30대 바리스타 한 명. 손은 비어 있고 자연스럽게 미소 짓는 모습. 밝은 단색 배경, 부드러운 스튜디오 조명, 얼굴과 손이 선명한 상반신 인물 사진.' },
  { label: '카페의 일상', prompt: '밝은 니트 차림의 20대 성인 한 명. 손은 비어 있고 편안한 표정으로 정면을 보는 모습. 밝은 단색 배경, 따뜻한 색감, 얼굴과 손이 선명한 라이프스타일 프로필 사진.' },
  { label: '깔끔한 프로필', prompt: '짙은 초록색 셔츠를 입은 30대 성인 한 명. 손은 비어 있고 정면을 바라보며 편안하게 미소 짓는 상반신 사진. 밝은 베이지색 단색 배경, 얼굴과 손이 선명한 스튜디오 조명.' },
];

interface Props {
  photo?: Photo;
  cardTitle: string;
  cardId: string;
  onReplace: (previous: Photo, next: Photo) => boolean;
  disabled: boolean;
  userId: string | null;
  onBusyChange: (busy: boolean) => void;
}

export function PhotoChat(props: Props) {
  const { userId } = props;
  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;
  const tutorialPreviousOpen = useRef<boolean | null>(null);
  useEffect(() => {
    const handleTutorial = (event: Event) => {
      if ((event as CustomEvent<string>).detail === 'open') {
        if (tutorialPreviousOpen.current === null) tutorialPreviousOpen.current = openRef.current;
        setOpen(true);
      } else if (tutorialPreviousOpen.current !== null) {
        setOpen(tutorialPreviousOpen.current);
        tutorialPreviousOpen.current = null;
      }
    };
    window.addEventListener('moa:tutorial:photo-chat', handleTutorial);
    return () => window.removeEventListener('moa:tutorial:photo-chat', handleTutorial);
  }, []);
  const [viewportWidth, setViewportWidth] = useState(() => document.documentElement.clientWidth);
  const [preferredWidth, setPreferredWidth] = useState(390);
  const width = clampChatWidth(preferredWidth, viewportWidth);
  useEffect(() => {
    const resize = () => setViewportWidth(document.documentElement.clientWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const surface = trigger.current?.closest<HTMLElement>('.main-surface');
    surface?.style.setProperty('--photo-chat-width', `${width}px`);
    return () => { surface?.style.removeProperty('--photo-chat-width'); };
  }, [width]);
  function close() { setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); }
  return <>
    <button data-tutorial="photo-chat" ref={trigger} className="photo-chat-tab" type="button" aria-label="AI와 수정하기" aria-expanded={open} aria-controls="photo-chat-panel" onClick={() => setOpen(value => !value)} hidden={open}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3Z"/><path d="M20 2v4M18 4h4M4 18v4M2 20h4"/></svg>
      <span className="photo-chat-tab-label" aria-label="AI와 수정하기"><span className="photo-chat-tab-ai" aria-hidden="true"><span>A</span><span>I</span></span><span aria-hidden="true">와 수정하기</span></span>
    </button>
    <PhotoChatPanel key={userId ?? 'guest'} {...props} open={open} onClose={close} width={width} viewportWidth={viewportWidth} onWidthChange={setPreferredWidth} />
  </>;
}

function PhotoChatPanel({ photo, cardTitle, onReplace, disabled, open, onClose, cardId, userId, onBusyChange, width, viewportWidth, onWidthChange }: Props & { open: boolean; onClose: () => void; width: number; viewportWidth: number; onWidthChange: (width: number) => void }) {
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  const widthBounds = chatWidthBounds(viewportWidth);
  const resizeWidth = (value: number) => onWidthChange(clampChatWidth(value, viewportWidth));
  const [mode, setMode] = useState<ChatMode>('person');
  const [prompt, setPrompt] = useState('');
  const [messages, updateMessages] = useState<ChatMessage[]>([]);
  const [historyReady, setHistoryReady] = useState(false);
  const [historyState, setHistoryState] = useState<'loading' | 'saving' | 'saved' | 'error'>('loading');
  const pendingHistory = useRef<PhotoChatMessage[] | null>(null);
  const mounted = useRef(true);
  const saveVersion = useRef(0);
  async function persistHistory(next: PhotoChatMessage[]) {
    const version = ++saveVersion.current;
    pendingHistory.current = next;
    setHistoryState('saving');
    try {
      await saveChatHistory(userId, 'photo-edit', next);
      if (mounted.current && version === saveVersion.current) { pendingHistory.current = null; setHistoryState('saved'); }
    } catch { if (mounted.current && version === saveVersion.current) setHistoryState('error'); }
  }
  function setMessages(next: ChatMessage[]) {
    updateMessages(next);
    void persistHistory(next.map(({ role, content }) => ({ role, content })));
  }
  useEffect(() => {
    mounted.current = true;
    let active = true;
    let restoring = false;
    let needsRestore = true;
    async function restoreHistory() {
      if (restoring || !needsRestore) return;
      restoring = true;
      const version = saveVersion.current;
      try {
        const stored = await loadChatHistory(userId, 'photo-edit');
        if (!active) return;
        if (version === saveVersion.current) updateMessages(stored);
        needsRestore = false;
        setHistoryReady(true);
        if (!pendingHistory.current) setHistoryState('saved');
      } catch (failure) {
        if (!active) return;
        if (!(failure instanceof Error && 'status' in failure && failure.status === 401)) {
          const cached = readCachedChatHistory(userId, 'photo-edit');
          if (cached && version === saveVersion.current) { updateMessages(cached); setHistoryReady(true); }
        }
        setHistoryState('error');
      } finally { restoring = false; }
    }
    void restoreHistory();
    const retry = window.setInterval(() => {
      if (!active) return;
      if (needsRestore) void restoreHistory();
      else if (pendingHistory.current) void persistHistory(pendingHistory.current);
    }, 10000);
    return () => { active = false; mounted.current = false; window.clearInterval(retry); };
  }, [userId]);
  const [status, setStatus] = useState<PhotoEditStatus | null>(null);
  const [usage, setUsage] = useState<PhotoEditUsage | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [addingReferences, setAddingReferences] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [references, setReferences] = useState<ReferenceAttachment[]>([]);
  const [people, setPeople] = useState<SavedPerson[]>([]);
  const [peopleState, setPeopleState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [peopleError, setPeopleError] = useState('');
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [generatedDraft, setGeneratedDraft] = useState<Extract<Candidate, { kind: 'generated' }> | null>(null);
  const [undo, setUndo] = useState<{ before: Photo; after: Photo } | null>(null);
  const [notice, setNotice] = useState('');
  const [showOriginal, setShowOriginal] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const reviewStart = useRef<HTMLElement>(null);
  const composing = useRef(false);
  const request = useRef<AbortController | null>(null);
  const generationRequestRef = useRef(false);
  const savingPersonIds = useRef<Set<string>>(new Set());
  const onBusyChangeRef = useRef(onBusyChange);
  const currentPhoto = useRef(photo);
  const visiblePhotoVersion = photoVersion(photo);
  const currentCardId = useRef(cardId);
  const candidateRef = useRef(candidate);
  onBusyChangeRef.current = onBusyChange;
  currentPhoto.current = photo;
  currentCardId.current = cardId;
  const visibleCandidate = candidate?.kind === 'generated' && mode !== 'person' ? null : candidate;
  candidateRef.current = visibleCandidate;

  useEffect(() => {
    setCandidate(current => current?.kind === 'generated' ? current : null);
    setUndo(null);
    setShowOriginal(false);
  }, [cardId]);
  useEffect(() => {
    setCandidate(current => current?.kind === 'generated' ? current : null);
    setShowOriginal(false);
    setUndo(current => current && photo && photoVersion(current.after) === photoVersion(photo) ? current : null);
  }, [visiblePhotoVersion]);
  useEffect(() => { if (open) input.current?.focus(); }, [mode, open]);

  function scrollToLatest() {
    const area = scrollArea.current;
    if (open && area && !candidateRef.current) area.scrollTop = area.scrollHeight;
  }
  function scrollToReview() {
    const area = scrollArea.current;
    const figure = reviewStart.current;
    if (!open || !area || !figure || !candidateRef.current) return;
    area.scrollTop += figure.getBoundingClientRect().top - area.getBoundingClientRect().top;
  }
  useEffect(() => {
    if (!open || !visibleCandidate) return;
    const frame = requestAnimationFrame(scrollToReview);
    return () => cancelAnimationFrame(frame);
  }, [open, Boolean(visibleCandidate)]);
  useEffect(() => {
    if (!open || visibleCandidate) return;
    const frame = requestAnimationFrame(scrollToLatest);
    return () => cancelAnimationFrame(frame);
  }, [open, messages, busy, error, notice, historyReady, progress, visibleCandidate]);
  useEffect(() => {
    const area = scrollArea.current;
    if (!open || !area) return;
    const observer = new ResizeObserver(() => {
      if (!candidateRef.current) scrollToLatest();
    });
    observer.observe(area);
    return () => observer.disconnect();
  }, [open]);

  async function refresh() {
    setLoadingStatus(true);
    const [statusResult, usageResult] = await Promise.allSettled([getPhotoEditStatus(), getPhotoEditUsage()]);
    if (statusResult.status === 'fulfilled') setStatus(statusResult.value);
    else setStatus({ configured: false, reason: '사진 편집 서버에 연결하지 못했어요. 잠시 후 다시 확인해 주세요.' });
    if (usageResult.status === 'fulfilled') setUsage(usageResult.value);
    else setUsage({ configured: false, reason: '사진 편집 사용량을 불러오지 못했어요. 연결 다시 확인을 눌러 주세요.' });
    setLoadingStatus(false);
  }

  async function loadPersonLibrary() {
    if (!userId) {
      setPeople([]);
      setPeopleState('idle');
      setPeopleError('');
      return;
    }
    setPeople([]);
    setPeopleState('loading');
    setPeopleError('');
    try {
      const items = await listPeople(userId);
      if (!mounted.current) return;
      setPeople(current => mergeLoadedPeople(items, current));
      setPeopleState('ready');
    } catch (failure) {
      if (!mounted.current) return;
      setPeople([]);
      setPeopleState('error');
      setPeopleError(failure instanceof Error ? failure.message : '인물 보관함을 불러오지 못했어요.');
    }
  }

  async function saveGeneratedPerson(next: Extract<Candidate, { kind: 'generated' }>) {
    if (!userId) return;
    const person = generatedCandidateToPerson(next);
    if (savingPersonIds.current.has(person.id)) return;
    savingPersonIds.current.add(person.id);
    setGeneratedDraft(current => current?.save.id === next.save.id
      ? { ...current, save: { ...current.save, state: 'saving', error: undefined } }
      : next);
    setCandidate(current => current?.kind === 'generated' && current.save.id === next.save.id
      ? { ...current, save: { ...current.save, state: 'saving', error: undefined } }
      : current);
    try {
      await savePerson(userId, { id: person.id, name: person.name, prompt: person.prompt, dataUrl: person.dataUrl });
      if (!mounted.current) return;
      setCandidate(current => current?.kind === 'generated' && current.save.id === person.id
        ? { ...current, save: { ...current.save, state: 'saved', error: undefined } }
        : current);
      setGeneratedDraft(current => current?.save.id === person.id ? null : current);
      setPeople(current => upsertPerson(current, person));
    } catch (failure) {
      if (!mounted.current) return;
      const message = failure instanceof Error ? failure.message : '인물을 보관함에 저장하지 못했어요.';
      setCandidate(current => current?.kind === 'generated' && current.save.id === person.id
        ? { ...current, save: { ...current.save, state: 'error', error: message } }
        : current);
      setGeneratedDraft(current => current?.save.id === person.id
        ? { ...current, save: { ...current.save, state: 'error', error: message } }
        : { ...next, save: { ...next.save, state: 'error', error: message } });
    } finally {
      savingPersonIds.current.delete(person.id);
    }
  }

  async function renameLibraryPerson(person: SavedPerson) {
    if (!userId || busy || disabled) return;
    const name = window.prompt('인물 이름', person.name)?.trim();
    if (!name || name === person.name) return;
    setError('');
    try {
      await renamePerson(userId, person.id, name);
      setPeople(current => current.map(item => item.id === person.id ? { ...item, name } : item));
      setReferences(current => current.map(reference => reference.id === personReferenceId(person.id) ? { ...reference, name } : reference));
      setCandidate(current => current?.kind === 'generated' && current.save.id === person.id ? { ...current, save: { ...current.save, name } } : current);
      setGeneratedDraft(current => current?.save.id === person.id ? { ...current, save: { ...current.save, name } } : current);
      setNotice('인물 이름을 바꿨어요.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '인물 이름을 바꾸지 못했어요.');
    }
  }

  async function deleteLibraryPerson(person: SavedPerson) {
    if (!userId || busy || disabled) return;
    if (!window.confirm(`${person.name}을 인물 보관함에서 삭제할까요?`)) return;
    setError('');
    try {
      await deletePerson(userId, person.id);
      setPeople(current => current.filter(item => item.id !== person.id));
      setReferences(current => current.filter(reference => reference.id !== personReferenceId(person.id)));
      setNotice('인물을 삭제했어요.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '인물을 삭제하지 못했어요.');
    }
  }

  useEffect(() => {
    return () => {
      request.current?.abort();
      generationRequestRef.current = false;
      onBusyChangeRef.current(false);
    };
  }, []);
  useEffect(() => {
    setPeople([]);
    setGeneratedDraft(null);
    setReferences(current => current.filter(reference => !reference.id.startsWith('person:')));
    setCandidate(current => current?.kind === 'generated' ? null : current);
    void loadPersonLibrary();
  }, [userId]);
  useEffect(() => { if (open) void loadPersonLibrary(); }, [open, userId]);
  useEffect(() => { if (open) void refresh(); }, [open]);
  useEffect(() => {
    if (!open) return;
    function escape(event: KeyboardEvent) { if (event.key === 'Escape') { event.preventDefault(); onClose(); } }
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [onClose, open]);

  async function addReferences(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!files.length) return;
    setError('');
    if (references.length + files.length > 3) {
      setError('참고 이미지는 최대 3장까지 추가할 수 있어요.');
      return;
    }
    const invalid = files.find(file => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024);
    if (invalid) {
      setError(`${invalid.name}은 10MB 이하의 JPG, PNG, WEBP 이미지만 사용할 수 있어요.`);
      return;
    }

    setAddingReferences(true);
    try {
      const photos = await preparePhotos(files);
      const nextReferences = photos.map((prepared, index) => ({
        ...prepared,
        purpose: references.length === 0 && index === 0 ? 'subject' as const : 'style' as const,
      }));
      setReferences(current => [...current, ...nextReferences]);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '참고 이미지를 추가하지 못했어요.');
    } finally {
      setAddingReferences(false);
    }
  }

  function updateReferencePurpose(id: string, purpose: ReferencePurpose) {
    setReferences(current => current.map(reference => reference.id === id ? { ...reference, purpose } : reference));
  }

  function removeReference(id: string) {
    setReferences(current => current.filter(reference => reference.id !== id));
  }

  function usePersonReference(person: SavedPerson) {
    const id = personReferenceId(person.id);
    setMode('ai');
    setError('');
    setNotice('');
    if (references.some(reference => reference.id === id)) {
      setNotice(`${person.name}은 이미 인물 참고로 추가되어 있어요.`);
      requestAnimationFrame(() => input.current?.focus());
      return;
    }
    if (references.length >= 3) {
      setError('참고 이미지는 최대 3장까지 추가할 수 있어요. 기존 참고 이미지를 지운 뒤 다시 선택해 주세요.');
      requestAnimationFrame(() => input.current?.focus());
      return;
    }
    setReferences(current => [...current, personToReference(person)]);
    setNotice(`${person.name}을 인물 참고로 추가했어요. 현재 카드 사진은 그대로예요.`);
    requestAnimationFrame(() => input.current?.focus());
  }

  function useGeneratedPerson(next: Extract<Candidate, { kind: 'generated' }>) {
    usePersonReference(generatedCandidateToPerson(next));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (mode === 'person') {
      await submitPersonGeneration();
      return;
    }
    await submitAiEdit();
  }

  async function submitAiEdit() {
    const exhausted = isUsageExhausted(usage);
    const canUseEdit = historyReady && status?.configured === true && usage?.configured === true && !exhausted;
    if (!photo || !prompt.trim() || busy || loadingStatus || disabled || !canUseEdit) return;
    if (messages.length >= 198) { setError('대화 기록 한도에 도달했어요. 기존 대화는 자동 저장되어 계속 확인할 수 있어요.'); return; }
    const source = photo;
    const text = prompt.trim();
    const referenceSnapshot = references.map(reference => ({ ...reference }));
    const nextMessages: ChatMessage[] = [...messages, { role: 'user', content: text, references: referenceSnapshot }];
    setMessages(nextMessages);
    setPrompt('');
    setError('');
    setNotice('');
    setProgress('');
    setCandidate(null);
    setShowOriginal(false);
    setBusy(true);
    onBusyChangeRef.current(true);
    const controller = new AbortController();
    request.current = controller;
    try {
      const editInput = await preparePhotoForEdit(source);
      const editReferences = await Promise.all(referenceSnapshot.map(async reference => {
        const prepared = await preparePhotoForEdit(reference);
        return { ...reference, dataUrl: prepared.dataUrl };
      }));
      const response = await editPhoto({ photo: editInput, prompt: text, messages, references: editReferences, requestId: crypto.randomUUID() }, controller.signal);
      const image = await fetch(response.imageDataUrl, { signal: controller.signal }).then(value => value.blob());
      const [prepared] = await preparePhotos([new File([image], 'AI-수정-사진.jpg', { type: image.type })]);
      if (controller.signal.aborted) return;
      const identity = photoIdentity(cardId, source);
      if (!isCurrentIdentity(identity)) throw new Error('작업 중 원본 사진이 변경됐어요. 현재 사진으로 다시 요청해 주세요.');
      setCandidate({ kind: 'ai', before: source, after: { ...prepared, name: `${source.name.replace(/ · AI 수정$/, '')} · AI 수정` }, identity });
      setMessages([...nextMessages, { role: 'assistant', content: response.message }]);
      if (response.usage) setUsage(response.usage);
    } catch (failure) {
      if (!controller.signal.aborted) { setError(failure instanceof Error ? failure.message : '사진을 수정하지 못했어요. 다시 시도해 주세요.'); setPrompt(text); }
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
        onBusyChangeRef.current(false);
        request.current = null;
        void refresh();
      }
    }
  }

  async function submitPersonGeneration() {
    const exhausted = isUsageExhausted(usage);
    const canUseGenerate = historyReady && userId && status?.configured === true && usage?.configured === true && !exhausted;
    if (!prompt.trim() || busy || loadingStatus || disabled || !canUseGenerate || generationRequestRef.current) return;
    if (messages.length >= 198) { setError('대화 기록 한도에 도달했어요. 기존 대화는 자동 저장되어 계속 확인할 수 있어요.'); return; }
    const text = prompt.trim();
    const nextMessages: ChatMessage[] = [...messages, { role: 'user', content: text }];
    setError('');
    setNotice('');
    setProgress('AI 인물을 생성하고 있어요…');
    setCandidate(null);
    setShowOriginal(false);
    setMessages(nextMessages);
    setPrompt('');
    setBusy(true);
    generationRequestRef.current = true;
    onBusyChangeRef.current(true);
    const controller = new AbortController();
    request.current = controller;
    try {
      const response = await generatePerson(text, crypto.randomUUID(), controller.signal);
      if (response.usage) setUsage(response.usage);
      const image = await fetch(response.imageDataUrl, { signal: controller.signal }).then(value => value.blob());
      const [prepared] = await preparePhotos([new File([image], 'AI-인물.jpg', { type: image.type })]);
      if (!prepared) throw new Error('생성한 인물을 이미지로 준비하지 못했어요.');
      if (controller.signal.aborted) return;
      const personId = crypto.randomUUID();
      const personName = generatedPersonName(text);
      const generated: Extract<Candidate, { kind: 'generated' }> = {
        kind: 'generated',
        after: { ...prepared, id: personId, name: `${personName}.jpg` },
        save: { id: personId, name: personName, prompt: text, state: 'saving' },
      };
      setCandidate(generated);
      void saveGeneratedPerson(generated);
      setMessages([...nextMessages, { role: 'assistant', content: response.message }]);
      setProgress('');
    } catch (failure) {
      if (!controller.signal.aborted) { setError(failure instanceof Error ? failure.message : '인물을 생성하지 못했어요. 다시 시도해 주세요.'); setPrompt(text); setProgress(''); }
    } finally {
      if (!controller.signal.aborted) {
        generationRequestRef.current = false;
        setBusy(false);
        onBusyChangeRef.current(false);
        request.current = null;
        void refresh();
      }
    }
  }

  function isCurrentIdentity(identity: PhotoIdentity) {
    if (currentCardId.current !== identity.cardId) return false;
    return photoVersion(currentPhoto.current) === identity.version;
  }

  function apply() {
    if (!candidate || disabled || busy || candidate.kind === 'generated' || !isCurrentIdentity(candidate.identity)) {
      setError(candidate?.kind === 'generated' ? '인물 생성 결과는 카드에 바로 적용하지 않고 AI 사진 수정의 인물 참고로 사용해요.' : '원본 사진이 변경되어 적용하지 않았어요. 다시 요청해 주세요.');
      return;
    }
    if (!onReplace(candidate.before, candidate.after)) { setError('원본 사진이 변경되어 적용하지 않았어요. 다시 요청해 주세요.'); return; }
    setUndo(candidate);
    setCandidate(null);
    setNotice('사진을 적용했어요. 보관함에 저장하면 수정본이 보관됩니다.');
  }
  function discardCandidate(message: string) {
    if (candidate?.kind === 'generated') {
      setGeneratedDraft(current => current?.save.id === candidate.save.id ? null : current);
    }
    setProgress('');
    setCandidate(null);
    setNotice(message);
  }
  function restore() {
    if (!undo || disabled) return;
    if (!onReplace(undo.after, undo.before)) { setError('사진이 다시 변경되어 되돌리지 않았어요.'); return; }
    setUndo(null);
    setCandidate(null);
    setNotice('적용 전 사진으로 되돌렸어요.');
  }

  const exhausted = isUsageExhausted(usage);
  const canUseEdit = historyReady && status?.configured === true && usage?.configured === true && !exhausted;
  const canGeneratePerson = Boolean(historyReady && userId && status?.configured === true && usage?.configured === true && !exhausted && !loadingStatus && prompt.trim() && !busy && !disabled);
  const usageLabel = usage?.configured && usage.unlimited ? '개인 횟수 제한 없음' : usage?.configured && typeof usage.remaining === 'number' && typeof usage.limit === 'number'
    ? `${planLabel(usage.plan)} ${usage.remaining} / ${usage.limit}회 남음`
    : status?.configured ? usage?.reason ?? 'AI 사진 편집 사용량 확인 중' : status?.reason;
  const resetLabel = usage?.configured ? usageResetText(usage) : status?.resetDescription;
  const availabilityDetail = exhausted
    ? resetLabel
    : usage?.configured && usage.unlimited
    ? '서비스 전체 이용 한도 내 제공'
    : status?.configured && usage?.configured
    ? `${resetLabel ? `${resetLabel} ` : ''}성공한 요청 1건이 1회로 계산돼요.`
    : status?.configured
    ? usage?.reason
    : status?.reason;
  const imageAlt = visibleCandidate && !showOriginal
    ? visibleCandidate.kind === 'generated' ? 'AI가 생성한 인물 사진' : 'AI가 제안한 수정 사진'
    : '현재 카드에 사용하는 사진';
  const previewPhoto = visibleCandidate && !showOriginal ? visibleCandidate.after : photo;
  const promptLabel = mode === 'person' ? '어떤 인물을 만들까요?' : '원하는 사진 수정';
  const promptPlaceholder = mode === 'person' ? '예: 베이지색 앞치마를 입은 30대 바리스타. 손은 비어 있고 미소 짓는 모습, 밝은 단색 배경.' : '예: 컵 모양은 유지하고 배경을 밝게 바꿔 줘';
  const submitLabel = mode === 'person' ? busy ? '생성 중…' : '인물 생성' : busy ? '수정 중…' : '수정 요청';
  const submitDisabled = mode === 'person' ? !canGeneratePerson : !canUseEdit || loadingStatus || !photo || !prompt.trim() || busy || disabled;

  return <aside hidden={!open} id="photo-chat-panel" className={`photo-chat-panel${resizing ? ' is-resizing' : ''}`} style={{ width }} aria-labelledby="photo-chat-title">
    <div className="photo-chat-resize" role="separator" aria-label="AI 채팅창 너비 조절" aria-orientation="vertical" aria-valuemin={widthBounds.min} aria-valuemax={widthBounds.max} aria-valuenow={width} aria-valuetext={`${Math.round(width)}픽셀, 화면의 ${Math.round(width / viewportWidth * 100)}%`} tabIndex={0} title="왼쪽으로 드래그해 넓히기 · 최대 화면의 절반" onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus();
      resizeStart.current = { x: event.clientX, width };
      event.currentTarget.setPointerCapture(event.pointerId);
      setResizing(true);
    }} onPointerMove={event => {
      if (resizeStart.current) resizeWidth(resizeStart.current.width + resizeStart.current.x - event.clientX);
    }} onPointerUp={event => {
      resizeStart.current = null; setResizing(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }} onPointerCancel={() => { resizeStart.current = null; setResizing(false); }} onLostPointerCapture={() => { resizeStart.current = null; setResizing(false); }} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      resizeWidth(event.key === 'Home' ? widthBounds.min : event.key === 'End' ? widthBounds.max : width + (event.key === 'ArrowLeft' ? 24 : -24));
    }}><span aria-hidden="true" /></div>
    <header data-tutorial="photo-chat" className="photo-chat-header"><div><h2 id="photo-chat-title">사진 생성·수정</h2></div><button className="photo-chat-close" type="button" aria-label="AI 수정 패널 닫기" onClick={onClose}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
    <div className="photo-chat-scroll" ref={scrollArea}>
      <div className="photo-chat-autosave" role="status"><span className={`photo-chat-save-dot ${historyState}`} aria-hidden="true" /><span>{historyState === 'loading' ? '이전 대화를 불러오는 중…' : historyState === 'saving' ? '대화 자동 저장 중…' : historyState === 'error' ? '연결되면 대화를 자동으로 다시 동기화해요.' : userId ? '대화가 계정에 자동 저장돼요.' : '대화가 이 브라우저에 자동 저장돼요.'}</span></div>
      <div className="photo-chat-target"><span>선택한 카드</span><strong>{cardTitle || '카드를 선택해 주세요'}</strong></div>
      {previewPhoto ? <figure ref={reviewStart} className={visibleCandidate ? 'photo-chat-image is-review' : 'photo-chat-image'}><img src={previewPhoto.dataUrl} onLoad={visibleCandidate ? undefined : scrollToLatest} alt={imageAlt} /><figcaption>{visibleCandidate && !showOriginal ? visibleCandidate.kind === 'generated' ? '생성한 인물 · 카드에는 아직 반영되지 않았어요' : '변경안 · 아직 적용되지 않았어요' : previewPhoto.name}</figcaption></figure> : <p className="photo-chat-empty">{mode === 'person' ? '인물 생성은 원본 사진 없이 만들 수 있어요. 만든 인물은 AI 사진 수정의 참고로 사용됩니다.' : '먼저 카드에 사용할 사진을 추가해 주세요.'}</p>}
      {visibleCandidate && <div data-tutorial="chat-review" className="photo-chat-review">{visibleCandidate.kind === 'ai' ? <><button className="ghost-button" type="button" onClick={() => setShowOriginal(value => !value)}>{showOriginal ? '변경안 보기' : '원본 보기'}</button><button className="primary-button" type="button" disabled={disabled || busy} onClick={apply}>이 사진 적용</button></> : <><button className="primary-button" type="button" disabled={disabled || busy} onClick={() => useGeneratedPerson(visibleCandidate)}>이 인물 사용</button>{visibleCandidate.save.state === 'error' && <button className="ghost-button" type="button" disabled={busy} onClick={() => void saveGeneratedPerson(visibleCandidate)}>저장 재시도</button>}</>}<button className="ghost-button" type="button" disabled={busy} onClick={() => discardCandidate(visibleCandidate.kind === 'generated' ? '생성한 인물을 닫았어요. 현재 카드 사진은 그대로예요.' : '변경안을 버렸어요. 현재 사진은 그대로예요.')}>{visibleCandidate.kind === 'generated' ? '닫기' : '변경안 버리기'}</button><p>{visibleCandidate.kind === 'generated' ? generatedSaveText(visibleCandidate.save) : '이 사진을 사용하는 다른 카드에도 함께 반영돼요.'}</p></div>}
      {undo && <button className="ghost-button photo-chat-undo" type="button" disabled={disabled} onClick={restore}>적용 전 사진으로 되돌리기</button>}
      <PersonLibrary people={people} draft={generatedDraft} state={peopleState} error={peopleError} disabled={disabled || busy} onRetry={() => void loadPersonLibrary()} onRetryDraft={(draft) => void saveGeneratedPerson(draft)} onUse={usePersonReference} onRename={(person) => void renameLibraryPerson(person)} onDelete={(person) => void deleteLibraryPerson(person)} />
      <div className="photo-chat-messages" role="log" aria-label="사진 수정 대화" aria-live="polite">
        {historyReady && !messages.length && <div className="photo-chat-message assistant"><strong>{mode === 'person' ? '원하는 인물을 바로 생성할 수 있어요.' : '어떤 분위기로 바꿔 볼까요?'}</strong><p>{mode === 'person' ? '원본 사진을 올리지 않아도 현재 카드에 사용할 AI 인물을 만들 수 있어요.' : '원하는 변화를 적어 주세요. 변경안을 먼저 확인하고 마음에 들면 카드에 적용할 수 있어요.'}</p></div>}
        {messages.map((item, index) => <div key={index} className={`photo-chat-message ${item.role}`}><span>{item.role === 'user' ? '나' : 'AI'}</span><p>{item.content}</p>{Boolean(item.references?.length) && <div className="photo-chat-message-refs" aria-label="함께 보낸 참고 이미지">{item.references?.map(reference => <img key={reference.id} src={reference.dataUrl} alt={`${reference.name} 참고 이미지`} />)}</div>}</div>)}
        {busy && <p className="photo-chat-progress" role="status">{progress || (mode === 'person' ? '인물을 생성하고 있어요…' : '사진을 수정하고 있어요…')}</p>}
      </div>
      {historyReady && !messages.length && <div className="photo-chat-suggestions" aria-label={mode === 'person' ? '인물 설명 예시' : '수정 요청 예시'}>{(mode === 'person' ? personExamples.map(example => example.prompt) : ['배경을 따뜻한 카페 분위기로 바꿔 줘', '컵은 그대로 두고 주변 소품을 정리해 줘', '사진을 더 밝고 자연스럽게 만들어 줘']).map(text => <button key={text} type="button" disabled={disabled || busy} onClick={() => { setPrompt(text); input.current?.focus(); }}>{mode === 'person' ? personExamples.find(example => example.prompt === text)?.label ?? text : text}</button>)}</div>}
      {notice && <p className="photo-chat-notice" role="status">{notice}</p>}
      {error && <p className="photo-chat-error" role="alert">{error}</p>}
    </div>
    <form className="photo-chat-composer" onSubmit={submit}>
      <div data-tutorial="chat-modes" className="photo-chat-mode" role="tablist" aria-label="사진 수정 방식">
        <button type="button" role="tab" aria-selected={mode === 'person'} className={mode === 'person' ? 'active' : ''} disabled={busy} onClick={() => setMode('person')}>인물 생성</button>
        <button type="button" role="tab" aria-selected={mode === 'ai'} className={mode === 'ai' ? 'active' : ''} disabled={busy} onClick={() => setMode('ai')}>AI 사진 수정</button>
      </div>
      {mode === 'ai' ? <div data-tutorial="chat-references" className="photo-chat-references" aria-label="참고 이미지">
        <div className="photo-chat-reference-top"><span>참고 사진<small>{references.length} / 3</small></span><label className="photo-chat-attach" title="사진 추가"><input aria-label="사진 추가" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={addReferences} disabled={busy || disabled || addingReferences || references.length >= 3} /><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m3 17 5-5 4 4 3-3 6 6"/></svg></label></div>
        {references.length > 0 && <div className="photo-chat-reference-list">{references.map(reference => <div key={reference.id} className="photo-chat-reference"><img src={reference.dataUrl} alt={`${reference.name} 참고 이미지`} /><div><strong>{reference.name}</strong><select value={reference.purpose} onChange={event => updateReferencePurpose(reference.id, event.target.value as ReferencePurpose)} disabled={busy || disabled}><option value="style">분위기 참고</option><option value="subject">인물·제품 참고</option></select></div><button type="button" onClick={() => removeReference(reference.id)} disabled={busy || disabled} aria-label={`${reference.name} 참고 이미지 제거`}>×</button></div>)}</div>}
        {addingReferences && <p role="status">참고 이미지를 준비하고 있어요…</p>}
      </div> : <p className="photo-chat-person-note">인물 생성은 원본 사진 없이 밝은 단색 배경의 다시 사용할 인물을 만들어요. 현재 카드는 AI 사진 수정 탭에서만 바뀝니다.</p>}
      <label htmlFor="photo-chat-prompt">{promptLabel}</label>
      <textarea data-tutorial="chat-prompt" id="photo-chat-prompt" ref={input} value={prompt} onChange={event => setPrompt(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => {
        if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || composing.current || event.nativeEvent.keyCode === 229) return;
        event.preventDefault();
        if (!event.repeat) event.currentTarget.form?.requestSubmit();
      }} maxLength={2000} rows={2} placeholder={promptPlaceholder} disabled={busy || disabled} />
      <div data-tutorial="chat-submit" className="photo-chat-send-row"><span>{prompt.length} / 2,000</span><button type="submit" className="primary-button" disabled={submitDisabled}>{submitLabel}</button></div>
      {loadingStatus ? <p role="status">AI 이미지 연결 확인 중…</p> : <div className="photo-chat-availability"><strong>{exhausted ? 'AI 이미지 사용량을 모두 썼어요' : status?.configured ? usageLabel : status?.reason?.includes('로그인') ? '로그인 후 AI 이미지 사용 가능' : status?.reason?.includes('서버') ? 'AI 이미지 서버 연결 확인 필요' : 'AI 이미지 연결 준비 중'}</strong><span>{availabilityDetail}</span>{(!status?.configured || usage?.configured === false) && <button type="button" onClick={() => void refresh()}>연결 다시 확인</button>}</div>}
      <p className="photo-chat-hint">Enter로 전송 · Shift+Enter로 줄바꿈</p>
    </form>
  </aside>;
}

function photoIdentity(cardId: string, photo: Photo): PhotoIdentity {
  return { cardId, version: photoVersion(photo) };
}

function PersonLibrary({ people, draft, state, error, disabled, onRetry, onRetryDraft, onUse, onRename, onDelete }: {
  people: SavedPerson[];
  draft: Extract<Candidate, { kind: 'generated' }> | null;
  state: 'idle' | 'loading' | 'ready' | 'error';
  error: string;
  disabled: boolean;
  onRetry: () => void;
  onRetryDraft: (draft: Extract<Candidate, { kind: 'generated' }>) => void;
  onUse: (person: SavedPerson) => void;
  onRename: (person: SavedPerson) => void;
  onDelete: (person: SavedPerson) => void;
}) {
  const draftPerson = draft ? generatedCandidateToPerson(draft) : null;
  const peopleWithoutDraft = draftPerson ? people.filter(person => person.id !== draftPerson.id) : people;
  const draftRow = draft && draftPerson ? <article className="photo-chat-person is-draft">
    <img src={draftPerson.dataUrl} alt={`${draftPerson.name} 인물`} />
    <div>
      <strong>{draftPerson.name}</strong>
      <span>{draft.save.state === 'saving' ? '저장 중' : draft.save.state === 'error' ? '저장 실패' : '저장됨'}</span>
    </div>
    <div className="photo-chat-person-actions">
      <button type="button" className="primary-button" disabled={disabled} onClick={() => onUse(draftPerson)}>이 인물 사용</button>
      {draft.save.state === 'error' && <button type="button" className="ghost-button" disabled={disabled} onClick={() => onRetryDraft(draft)}>저장 재시도</button>}
    </div>
    {draft.save.state === 'error' && <p>{draft.save.error ?? '보관함에 저장하지 못했어요.'}</p>}
  </article> : null;
  return <section className="photo-chat-library" aria-label="인물 보관함">
    <div className="photo-chat-library-top">
      <h3>인물 보관함</h3>
      {state === 'error' && <button type="button" onClick={onRetry} disabled={disabled}>다시 불러오기</button>}
    </div>
    {state === 'idle' && <p>로그인하면 생성한 인물을 저장해 다시 사용할 수 있어요.</p>}
    {state === 'loading' && <p role="status">인물 보관함을 불러오고 있어요…</p>}
    {state === 'error' && <p role="alert">{error}</p>}
    {state === 'ready' && !people.length && !draftPerson && <p>아직 저장한 인물이 없어요.</p>}
    {(draftPerson || peopleWithoutDraft.length > 0) && <div className="photo-chat-library-list">
      {draftRow}
      {peopleWithoutDraft.map(person => <article key={person.id} className="photo-chat-person">
        <img src={person.dataUrl} alt={`${person.name} 인물`} />
        <div>
          <strong>{person.name}</strong>
          <span>{person.createdAt ? new Date(person.createdAt).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' }) : '저장됨'}</span>
        </div>
        <div className="photo-chat-person-actions">
          <button type="button" className="primary-button" disabled={disabled} onClick={() => onUse(person)}>이 인물 사용</button>
          <button type="button" className="ghost-button" disabled={disabled} onClick={() => onRename(person)}>이름</button>
          <button type="button" className="ghost-button" disabled={disabled} onClick={() => onDelete(person)}>삭제</button>
        </div>
      </article>)}
    </div>}
  </section>;
}

function personReferenceId(id: string) {
  return `person:${id}`;
}

function personToReference(person: SavedPerson): ReferenceAttachment {
  return { id: personReferenceId(person.id), name: person.name, dataUrl: person.dataUrl, purpose: 'subject' };
}

function generatedCandidateToPerson(candidate: Extract<Candidate, { kind: 'generated' }>): SavedPerson {
  return {
    id: candidate.save.id,
    name: candidate.save.name,
    prompt: candidate.save.prompt,
    dataUrl: candidate.after.dataUrl,
    createdAt: new Date().toISOString(),
  };
}

function upsertPerson(people: SavedPerson[], person: SavedPerson): SavedPerson[] {
  return [person, ...people.filter(item => item.id !== person.id)]
    .sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? ''));
}

function mergeLoadedPeople(loaded: SavedPerson[], current: SavedPerson[]) {
  const byId = new Map<string, SavedPerson>();
  for (const person of current) byId.set(person.id, person);
  for (const person of loaded) byId.set(person.id, { ...byId.get(person.id), ...person });
  return Array.from(byId.values())
    .sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? ''));
}

function generatedPersonName(prompt: string) {
  const firstLine = prompt.replace(/\s+/g, ' ').trim().slice(0, 18);
  return firstLine ? `AI 인물 · ${firstLine}` : 'AI 인물';
}

function generatedSaveText(save: GeneratedPersonSave) {
  if (save.state === 'saving') return '보관함에 저장 중이에요. 저장 전에도 AI 사진 수정의 인물 참고로 사용할 수 있어요.';
  if (save.state === 'error') return `${save.error ?? '보관함에 저장하지 못했어요.'} 생성 비용 없이 저장만 다시 시도할 수 있어요.`;
  return '보관함에 저장됐어요. 이 인물을 AI 사진 수정의 인물 참고로 사용할 수 있어요.';
}

function planLabel(plan: PhotoEditUsage['plan']) {
  if (plan === 'light') return '라이트';
  if (plan === 'studio') return '스탠다드';
  if (plan === 'plus') return '프로';
  return '무료';
}

function usageResetText(usage: PhotoEditUsage) {
  if (usage.period === 'lifetime') return '무료 체험은 가입 후 총 3회이며 자동 충전되지 않아요.';
  if (usage.period === 'day') return 'UTC 기준 자정, 한국 시간 오전 9시에 다시 사용할 수 있어요.';
  if (!usage.periodEnd) return '';
  const date = new Date(usage.periodEnd);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })}까지 사용할 수 있어요.`;
}

function isUsageExhausted(usage: PhotoEditUsage | null) {
  if (!usage?.configured) return false;
  if (typeof usage.globalRemaining === 'number' && usage.globalRemaining <= 0) return true;
  if (usage.unlimited) return false;
  return typeof usage.remaining === 'number' && usage.remaining <= 0;
}
