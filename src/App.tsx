import { useCallback, useEffect, useRef, useState } from 'react';
import { Shell, BriefForm, WorkspacePreview } from './components';
import { BrandSettings } from './views/BrandSettings';
import { Library } from './views/Library';
import { ConfirmDialog } from './views/ConfirmDialog';
import { AuthDialog } from './views/AuthDialog';
import { getSession, getWorkspace, putWorkspace, logout, subscribeWorkspace, type BrandProfile, type User } from './lib/auth';
import { EditorTutorial } from './components/EditorTutorial';
import { BusinessInfo } from './components/BusinessInfo';
import { UsagePanel } from './components/UsagePanel';
import { CheckoutDialog } from './CheckoutDialog';
import { PaymentResult } from './PaymentResult';
import { Landing } from './views/Landing';
import { freeEntitlements, generateContent, getEntitlements, getStatus, type ApiStatus, type Entitlements } from './api';
import { defaultBrand, defaultBrief, initialPack, samplePhotos } from './seed';
import { makeTemplatePack, syncTemplateCards } from '../shared/template.mjs';
import { preparePhotos } from './lib/images';
import { downloadCard, downloadPack } from './lib/export';
import { replaceWorkspacePhoto } from './lib/photo-edit';
import { loadBrand, loadBrandProfiles, loadProjects } from './lib/storage';
import { AUTOSAVE_DELAY_MS, autoSaveStatusText, createDraftProject, mergeWorkspaceForProject, mergeWorkspaceProjects, preserveVisiblePhotoUrls, readLastProjectId, writeLastProjectId, type AutosaveState, type WorkspaceProject } from './lib/autosave';
import type { Brand, Brief, ContentPack, Photo } from './types';

type Page = 'home' | 'editor' | 'library' | 'brand' | 'payment';
type WorkspaceState = { brand: Brand | null; projects: WorkspaceProject[]; brandProfiles?: BrandProfile[]; activeBrandId?: string | null };
type PendingAction = { kind: 'delete-brand'; id: string } | { kind: 'delete'; id: string } | { kind: 'new' } | { kind: 'regenerate' };

function currentPage(): Page {
  if (['success', 'fail'].includes(new URLSearchParams(location.search).get('payment') || '')) return 'payment';
  const path = location.hash.startsWith('#/studio') ? location.hash.slice(1) : location.pathname.replace(/\/$/, '');
  if (path === '/studio/library') return 'library';
  if (path === '/studio/brand') return 'brand';
  if (path === '/studio') return 'editor';
  return 'home';
}
function message(error: unknown) { return error instanceof Error ? error.message : '문제가 생겼어요. 다시 시도해 주세요.'; }
function initialState(): WorkspaceState & { error: string | null } {
  try { return { brand: loadBrand() ?? defaultBrand, projects: loadProjects() as WorkspaceProject[], ...loadBrandProfiles(), error: null }; }
  catch { return { brand: defaultBrand, projects: [], error: '저장된 데이터를 불러오지 못했어요. 로그인하면 새 콘텐츠를 만들고 저장할 수 있어요.' }; }
}

function createProfile(brand: Brand, id: string = crypto.randomUUID()): BrandProfile {
  return { ...brand, id };
}

function normalizeWorkspace(value: WorkspaceState): Required<Pick<WorkspaceState, 'brandProfiles'>> & { brand: Brand; projects: WorkspaceProject[]; activeBrandId: string } {
  const legacy = value.brand ?? defaultBrand;
  const profiles = Array.isArray(value.brandProfiles)
    ? value.brandProfiles
    : [createProfile(legacy, 'primary')];
  const active = profiles.find(profile => profile.id === value.activeBrandId) ?? profiles[0];
  return { brand: active ?? defaultBrand, projects: value.projects ?? [], brandProfiles: profiles, activeBrandId: active?.id ?? '' };
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function projectBrandId(project: WorkspaceProject, profiles: BrandProfile[]) {
  if (project.brandId) return project.brandId;
  return profiles.find(profile => sameJson({ ...profile, id: undefined }, { ...project.brand, id: undefined }))?.id ?? null;
}
export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checkout, setCheckout] = useState<{plan: 'light' | 'studio' | 'plus'; interval: 'month' | 'year'} | null>(() => { const query = new URLSearchParams(location.search); const plan = query.get('plan'); return plan === 'light' || plan === 'studio' || plan === 'plus' ? { plan, interval: query.get('interval') === 'year' ? 'year' : 'month' } : null; });
  const [authOpen, setAuthOpen] = useState(new URLSearchParams(location.search).get('account') === '1');
  const [authReady, setAuthReady] = useState(false);
  const [authFailure, setAuthFailure] = useState('');
  const [savingAccount, setSavingAccount] = useState(false);
  const writeChain = useRef<Promise<unknown>>(Promise.resolve());
  const activeWrites = useRef(0);
  const draftWrite = useRef<Promise<boolean> | null>(null);
  const editVersion = useRef(0);
  const draftProjectId = useRef<string | null>(null);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<{
    brand: Brand;
    brandProfiles: BrandProfile[];
    activeBrandId: string;
    brief: Brief;
    photos: Photo[];
    pack: ContentPack;
    projects: WorkspaceProject[];
    projectId: string | null;
    dirty: boolean;
    user: User | null;
    authReady: boolean;
  } | null>(null);
  const [initial] = useState(initialState);
  const [page, setPage] = useState<Page>(currentPage);
  const [brand, setBrand] = useState<Brand>(() => normalizeWorkspace(initial).brand);
  const [brandProfiles, setBrandProfiles] = useState<BrandProfile[]>(() => normalizeWorkspace(initial).brandProfiles);
  const [activeBrandId, setActiveBrandId] = useState(() => normalizeWorkspace(initial).activeBrandId);
  const [libraryBrandFilter, setLibraryBrandFilter] = useState<'all' | string>('all');
  const [brief, setBrief] = useState<Brief>(defaultBrief);
  const [chatSession, setChatSession] = useState(0);
  const [photoChatBusy, setPhotoChatBusy] = useState(false);
  const [photos, setPhotos] = useState<Photo[]>(samplePhotos);
  const [pack, setPack] = useState<ContentPack>(initialPack);
  const [selectedCardId, setSelectedCardId] = useState(initialPack.cards[0]?.id ?? '');
  const selectedCard = pack.cards.find(card => card.id === selectedCardId) ?? pack.cards[0];
  const [projects, setProjects] = useState<WorkspaceProject[]>(initial.projects);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [, setSaved] = useState(false);
  const [saveState, setSaveState] = useState<AutosaveState>('idle');
  const [saveError, setSaveError] = useState('');
  const [status, setStatus] = useState<ApiStatus | null>(null);
  const [entitlements, setEntitlements] = useState<Entitlements>(() => freeEntitlements(false));
  const [usageLoading, setUsageLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(initial.error);
  const [toast, setToast] = useState('');
  const [toastLeaving, setToastLeaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [packEdited, setPackEdited] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const isReadOnly = !user;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((text: string) => {
    setToast(text);
    setToastLeaving(false);
    if (timer.current) clearTimeout(timer.current);
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    timer.current = setTimeout(() => {
      setToastLeaving(true);
      dismissTimer.current = setTimeout(() => setToast(''), 250);
    }, 2000);
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); if (dismissTimer.current) clearTimeout(dismissTimer.current); }, []);
  useEffect(() => {
    latest.current = { brand, brandProfiles, activeBrandId, brief, photos, pack, projects, projectId, dirty, user, authReady };
  }, [brand, brandProfiles, activeBrandId, brief, photos, pack, projects, projectId, dirty, user, authReady]);
  useEffect(() => {
    const handleRoute = () => {
      setPage(currentPage());
      if (location.hash.startsWith('#/')) window.scrollTo({ top: 0, behavior: 'instant' });
    };
    window.addEventListener('hashchange', handleRoute);
    window.addEventListener('popstate', handleRoute);
    if (location.hash.startsWith('#/studio')) { history.replaceState(null, '', location.hash.slice(1)); handleRoute(); }
    return () => { window.removeEventListener('hashchange', handleRoute); window.removeEventListener('popstate', handleRoute); };
  }, []);
  useEffect(() => {
    const robots = document.querySelector('meta[name=robots]') ?? document.head.appendChild(document.createElement('meta'));
    robots.setAttribute('name', 'robots'); robots.setAttribute('content', page === 'home' ? 'index, follow' : 'noindex, follow');
    const canonical = document.querySelector('link[rel=canonical]');
    canonical?.setAttribute('href', `https://moa-studio.pages.dev${page === 'home' ? '/' : location.pathname}`);
    document.title = page === 'home' ? '모아 스튜디오 — 카페의 순간을 모아, 이야기로' : `모아 스튜디오 · ${page === 'payment' ? '결제 확인' : page === 'editor' ? '콘텐츠 만들기' : page === 'library' ? '보관함' : '브랜드 설정'}`;
  }, [page]);
  useEffect(() => {
    if (!dirty && !photoChatBusy) return;
    const protectDraft = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protectDraft);
    return () => window.removeEventListener('beforeunload', protectDraft);
  }, [dirty, photoChatBusy]);
  function navigate(next: Page) {
    if (photoChatBusy) { notify('AI 이미지 작업이 끝난 뒤 이동해 주세요.'); return; }
    if (new URLSearchParams(location.search).has('payment')) history.replaceState(null, '', location.pathname);
    setCheckout(null);
    setPage(next);
    history.pushState(null, '', next === 'home' ? '/' : next === 'editor' ? '/studio' : `/studio/${next}`);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  useEffect(() => {
    let active = true;
    getStatus().then(nextStatus => { if (active) { setStatus(nextStatus); setEntitlements(value => ({ ...value, configured: nextStatus.configured })); setOffline(false); } }).catch(() => { if (active) setOffline(true); });
    return () => { active = false; };
  }, []);
  const refreshEntitlements = useCallback(async (nextUser = user, options: { silent?: boolean } = {}) => {
    if (!options.silent) setUsageLoading(true);
    try {
      const next = nextUser ? await getEntitlements() : freeEntitlements(status?.configured ?? false);
      setEntitlements(next);
      setOffline(false);
      return next;
    } catch (failure) {
      if (nextUser && !options.silent) notify(message(failure));
      const fallback = freeEntitlements(status?.configured ?? false);
      if (!nextUser) setEntitlements(fallback);
      return fallback;
    } finally {
      if (!options.silent) setUsageLoading(false);
    }
  }, [notify, status?.configured, user]);
  function installWorkspace(value: WorkspaceState, options: { restoreUserId?: string } = {}) {
    const normalized = normalizeWorkspace(value);
    const lastProjectId = options.restoreUserId ? readLastProjectId(options.restoreUserId) : null;
    const restoredProject = lastProjectId
      ? normalized.projects.find(project => project.id === lastProjectId)
      : null;
    setBrand(restoredProject?.brand ?? normalized.brand);
    setBrandProfiles(normalized.brandProfiles);
    setActiveBrandId(restoredProject ? projectBrandId(restoredProject, normalized.brandProfiles) ?? normalized.activeBrandId : normalized.activeBrandId);
    setLibraryBrandFilter('all');
    setProjects(normalized.projects);
    setChatSession(value => value + 1);
    setBrief(restoredProject?.brief ?? defaultBrief);
    setPhotos(restoredProject?.photos ?? samplePhotos);
    setPack(restoredProject?.pack ?? initialPack);
    setSelectedCardId((restoredProject?.pack ?? initialPack).cards[0]?.id ?? '');
    setProjectId(restoredProject?.id ?? null);
    draftProjectId.current = restoredProject?.id ?? null;
    setSaved(Boolean(restoredProject));
    setDirty(false);
    setPackEdited(false);
    setSaveState(restoredProject ? 'saved' : 'idle');
    setSaveError('');
    setError(null);
    setPendingAction(null);
  }
  async function restoreSession() {
    setAuthFailure(''); setAuthReady(false);
    try { const session = await getSession(); const workspace = session.user ? await getWorkspace() : initialState(); setUser(session.user); installWorkspace(workspace, { restoreUserId: session.user?.id }); setAuthReady(true); void refreshEntitlements(session.user, { silent: true }); }
    catch { setAuthFailure('계정 연결을 확인하지 못했어요. 서버 연결 후 다시 시도해 주세요.'); }
  }
  useEffect(() => { void restoreSession(); }, []);
  async function authenticated(next: User) {
    setUser(next);
    try {
      const [workspace] = await Promise.all([getWorkspace(), refreshEntitlements(next)]);
      installWorkspace(workspace, { restoreUserId: next.id });
      setAuthReady(true); setAuthFailure(''); notify(`${next.name}님, 반가워요.`);
    }
    catch (failure) { setAuthReady(false); setAuthFailure('계정 보관함을 불러오지 못했어요. 연결을 확인하고 다시 시도해 주세요.'); throw failure; }
  }
  async function signOut() { if (!await flushAutosave()) return; await logout(); setUser(null); setEntitlements(freeEntitlements(status?.configured ?? false)); installWorkspace(initialState()); notify('로그아웃했어요.'); }
  async function showAccount() {
    if (generating || uploading || photoChatBusy || exporting || !authReady) { notify('진행 중인 작업이 끝난 뒤 다시 눌러 주세요.'); return; }
    if (dirty && user) {
      try { if (!await flushAutosave()) return; }
      catch { notify('자동 저장이 끝난 뒤 계정을 전환해 주세요.'); return; }
    }
    setAuthOpen(true);
  }
  function markDirty() {
    editVersion.current += 1;
    if (!draftProjectId.current && !projectId) {
      draftProjectId.current = crypto.randomUUID();
      setProjectId(draftProjectId.current);
    }
    setSaved(false);
    setDirty(true);
    setSaveError('');
    if (user) setSaveState('dirty');
  }
  function enqueueWorkspacePut(workspace: WorkspaceState, userId: string) {
    activeWrites.current += 1;
    setSavingAccount(true);
    const write = writeChain.current.then(() => putWorkspace(workspace, userId));
    writeChain.current = write.catch(() => undefined);
    return write.finally(() => {
      activeWrites.current -= 1;
      if (activeWrites.current === 0) setSavingAccount(false);
    }) as Promise<WorkspaceState>;
  }
  async function latestWorkspace() {
    return normalizeWorkspace(await getWorkspace() as WorkspaceState);
  }
  async function persist(nextBrand: Brand, nextProjects: WorkspaceProject[], nextProfiles = brandProfiles, nextActiveBrandId = activeBrandId) {
    if (!authReady) throw new Error('계정을 확인하고 있어요. 잠시 후 다시 시도해 주세요.');
    if (!user) throw new Error('로그인하면 저장할 수 있어요.');
    return enqueueWorkspacePut({ brand: nextBrand, projects: nextProjects, brandProfiles: nextProfiles, activeBrandId: nextActiveBrandId || null }, user.id);
  }
  async function saveCurrentDraft(): Promise<boolean> {
    if (draftWrite.current) return draftWrite.current;
    const pending = writeCurrentDraft();
    draftWrite.current = pending;
    try { return await pending; } finally { draftWrite.current = null; }
  }
  async function writeCurrentDraft(): Promise<boolean> {
    const snapshot = latest.current;
    if (!snapshot?.user || !snapshot.authReady || !snapshot.dirty) return true;
    if (generating || uploading || photoChatBusy || exporting) return false;
    const version = editVersion.current;
    const id = snapshot.projectId ?? draftProjectId.current ?? crypto.randomUUID();
    draftProjectId.current = id;
    setSaveState('saving');
    try {
      const remote = await latestWorkspace();
      const project = createDraftProject({ projectId: id, brand: snapshot.brand, activeBrandId: snapshot.activeBrandId, brief: snapshot.brief, photos: snapshot.photos, pack: snapshot.pack });
      const nextProjects = mergeWorkspaceForProject(remote, snapshot.projects, project);
      const stored = await enqueueWorkspacePut({ brand: snapshot.brand, projects: nextProjects, brandProfiles: snapshot.brandProfiles, activeBrandId: snapshot.activeBrandId || null }, snapshot.user.id);
      const normalized = normalizeWorkspace(stored);
      const storedProject = normalized.projects.find(item => item.id === id);
      writeLastProjectId(snapshot.user.id, id);
      setProjects(normalized.projects);
      setProjectId(id);
      if (editVersion.current === version) {
        if (latest.current) latest.current = { ...latest.current, dirty: false };
        if (storedProject) setPhotos(preserveVisiblePhotoUrls(storedProject.photos, snapshot.photos));
        setSaved(true);
        setDirty(false);
        setPackEdited(false);
        setSaveState('saved');
      } else {
        setSaveState('dirty');
      }
      setSaveError('');
      setError(null);
      return true;
    } catch (failure) {
      setSaveError(message(failure));
      setSaveState('error');
      setSaved(false);
      setDirty(true);
      return false;
    }
  }
  async function flushAutosave() {
    if (autosaveTimer.current) {
      clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    }
    if (draftWrite.current && !await draftWrite.current) return false;
    while (latest.current?.dirty) {
      if (!await saveCurrentDraft()) return false;
    }
    return true;
  }
  function requireLogin(action = '로그인하면 이용할 수 있어요.') {
    if (user) return false;
    notify(action);
    return true;
  }
  function changeBrief(change: Partial<Brief>) {
    if (generating || photoChatBusy || requireLogin('로그인하면 콘텐츠 정보를 수정할 수 있어요.')) return;
    const nextBrief = { ...brief, ...change };
    setBrief(nextBrief);
    setPack(value => syncTemplateCards({ pack: value, brand, previousBrief: brief, brief: nextBrief, images: photos }));
    markDirty();
    setError(null);
  }
  function changePack(value: ContentPack) { if (photoChatBusy || requireLogin('로그인하면 카드 문구를 편집할 수 있어요.')) return; setPack(value); markDirty(); setPackEdited(true); }
  function replacePhoto(previous: Photo, next: Photo): boolean {
    if (generating || uploading || exporting || !authReady || requireLogin('로그인하면 사진을 수정할 수 있어요.')) return false;
    const updated = replaceWorkspacePhoto(photos, pack, previous, next);
    if (!updated) return false;
    setPhotos(updated.photos); setPack(updated.pack);
    markDirty(); setPackEdited(true);
    return true;
  }
  function selectPhoto(id: string) {
    if (generating || uploading || savingAccount || exporting || photoChatBusy || !selectedCard || requireLogin('로그인하면 카드 사진을 선택할 수 있어요.')) return;
    if (!photos.some(photo => photo.id === id && photo.dataUrl) || selectedCard.imageId === id) return;
    changePack({ ...pack, cards: pack.cards.map(card => card.id === selectedCard.id ? { ...card, imageId: id } : card) });
  }
  async function addPhotos(files: File[]) {
    if (uploading || generating || photoChatBusy || !files.length) return;
    if (requireLogin('로그인하면 사진을 업로드할 수 있어요.')) return;
    setError(null);
    const retained = photos.filter(photo => photo.id !== 'sample-latte');
    if (retained.length + files.length > 3) { setError('사진은 최대 3장까지 사용할 수 있어요. 기존 사진을 지우고 다시 추가해 주세요.'); return; }
    setUploading(true);
    try {
      const added = await preparePhotos(files);
      if (!added.length) return;
      const next = [...retained, ...added];
      setPhotos(next);
      setPack(value => ({ ...value, cards: value.cards.map((card, index) => ({ ...card, imageId: next[index % next.length].id })) }));
      markDirty(); notify(`${added.length}장의 사진을 추가했어요.`);
    } catch (failure) { setError(message(failure)); } finally { setUploading(false); }
  }
  function removePhoto(id: string) {
    if (generating || uploading || photoChatBusy) return;
    if (requireLogin('로그인하면 사진을 삭제할 수 있어요.')) return;
    const next = photos.filter(photo => photo.id !== id);
    setPhotos(next);
    setPack(value => ({ ...value, cards: value.cards.map(card => card.imageId === id ? { ...card, imageId: next[0]?.id ?? '' } : card) }));
    markDirty();
  }
  async function generate() {
    if (photoChatBusy) return;
    if (requireLogin('로그인하면 콘텐츠를 만들 수 있어요.')) return;
    if (packEdited) { setPendingAction({ kind: 'regenerate' }); return; }
    await runGenerate();
  }
  async function runGenerate() {
    if (generating || uploading || photoChatBusy) return;
    if (requireLogin('로그인하면 콘텐츠를 만들 수 있어요.')) return;
    if (!brief.productName.trim()) { setError('메뉴 이름을 입력해 주세요.'); return; }
    if (!photos.length) { setError('카드뉴스에 사용할 사진을 한 장 이상 추가해 주세요.'); return; }
    setGenerating(true); setError(null);
    try {
      const useAI = Boolean(user && entitlements.plan !== 'free' && entitlements.configured && status?.mode === 'live' && entitlements.aiRemaining > 0);
      const result = await generateContent(brand, brief, photos, { useAI });
      setPack(result); markDirty(); setPackEdited(false); setOffline(false);
      if (user) await refreshEntitlements(user, { silent: true });
      notify(result.source === 'ai' ? '우리 카페의 콘텐츠가 완성됐어요.' : '입력한 정보로 템플릿 콘텐츠를 만들었어요.');
    }
    catch (failure) { setError(message(failure)); } finally { setGenerating(false); }
  }
  async function openProject(project: WorkspaceProject) {
    if (dirty && !await flushAutosave()) return;
    const nextBrandId = projectBrandId(project, brandProfiles);
    if (nextBrandId) setActiveBrandId(nextBrandId);
    draftProjectId.current = project.id;
    writeLastProjectId(user?.id ?? 'guest', project.id);
    setChatSession(value => value + 1); setBrand(project.brand); setBrief(project.brief); setPhotos(project.photos); setPack(project.pack); setSelectedCardId(project.pack.cards[0]?.id ?? ''); setProjectId(project.id); setSaved(true); setDirty(false); setSaveState(user ? 'saved' : 'idle'); setSaveError(''); setPackEdited(false); navigate('editor'); setError(null);
  }
  async function newProject() {
    if (photoChatBusy) return;
    if (requireLogin('로그인하면 새 콘텐츠를 만들 수 있어요.')) return;
    if (dirty && !await flushAutosave()) return;
    resetProject();
  }
  function resetProject() {
    if (photoChatBusy) return;
    setChatSession(value => value + 1);
    draftProjectId.current = null;
    setSelectedCardId('card-1');
    const emptyBrief = { ...defaultBrief, productName: '', description: '', price: '', includeSchedule: false, scheduleStartDate: '' };
    setBrief(emptyBrief); setPhotos([]); setPack({ ...makeTemplatePack({ brand, brief: emptyBrief, images: [] }), caption: '', hashtags: [], schedule: [] }); setProjectId(null); setSaved(false); setDirty(false); setSaveState('idle'); setSaveError(''); setPackEdited(false); setError(null); navigate('editor');
  }
  function removeProject(id: string) {
    if (requireLogin('로그인하면 콘텐츠를 삭제할 수 있어요.')) return;
    setPendingAction({ kind: 'delete', id });
  }
  async function confirmDelete(id: string) {
    if (requireLogin('로그인하면 콘텐츠를 삭제할 수 있어요.')) return;
    try {
      if (dirty && !await flushAutosave()) return;
      const remote = await latestWorkspace();
      const next = mergeWorkspaceProjects(remote, projects).filter(item => item.id !== id);
      const stored = await persist(brand, next);
      setProjects(normalizeWorkspace(stored).projects);
      if (projectId === id) { draftProjectId.current = null; setProjectId(null); setSaved(false); setDirty(false); setSaveState('idle'); }
      notify('콘텐츠를 삭제했어요.');
    } catch (failure) { notify(message(failure)); }
  }
  function updateBrand(value: Brand) {
    if (requireLogin('로그인하면 브랜드를 수정할 수 있어요.')) return;
    const normalized = { ...value };
    const nextProfiles = brandProfiles.map(profile => profile.id === activeBrandId ? { ...normalized, id: profile.id } : profile);
    setBrand(normalized);
    setBrandProfiles(nextProfiles);
    markDirty();
  }
  async function selectBrandProfile(id: string) {
    const selected = brandProfiles.find(profile => profile.id === id);
    if (!selected) return;
    try {
      if (dirty && !await flushAutosave()) return;
      if (!user) {
        setActiveBrandId(id);
        setBrand(selected);
        setSaved(false);
        return;
      }
      const remote = await latestWorkspace();
      const stored = await persist(selected, mergeWorkspaceProjects(remote, projects), brandProfiles, id);
      const workspace = normalizeWorkspace(stored);
      setBrandProfiles(workspace.brandProfiles);
      setActiveBrandId(id);
      setBrand(selected);
      setSaved(false);
      setSaveState('saved');
    } catch (failure) { notify(message(failure)); }
  }
  async function createBrandProfile() {
    if (requireLogin('로그인하면 브랜드를 추가할 수 있어요.')) return;
    if (brandProfiles.length >= entitlements.brandLimit) { notify(`${entitlements.plan === 'plus' ? '프로' : '현재'} 플랜은 브랜드를 ${entitlements.brandLimit}개까지 저장할 수 있어요.`); return; }
    const next = createProfile({ ...defaultBrand, name: `브랜드 ${brandProfiles.length + 1}`, instagram: '', tagline: '', location: '', color: '#354b64' });
    const nextProfiles = [...brandProfiles, next];
    try {
      if (dirty && !await flushAutosave()) return;
      const remote = await latestWorkspace();
      const stored = await persist(next, mergeWorkspaceProjects(remote, projects), nextProfiles, next.id);
      const workspace = normalizeWorkspace(stored);
      setBrandProfiles(workspace.brandProfiles);
      setActiveBrandId(next.id);
      setBrand(next);
      notify('새 브랜드 프로필을 추가했어요.');
    } catch (failure) { notify(message(failure)); }
  }
  async function deleteBrandProfile(id: string) {
    if (requireLogin('로그인하면 브랜드를 삭제할 수 있어요.')) return;
    if (!brandProfiles.some(profile => profile.id === id)) return;
    const nextProfiles = brandProfiles.filter(profile => profile.id !== id);
    const nextActive = (activeBrandId === id ? nextProfiles[0] : nextProfiles.find(profile => profile.id === activeBrandId)) ?? nextProfiles[0];
    const nextBrand = nextActive ?? defaultBrand;
    try {
      if (dirty && !await flushAutosave()) return;
      const remote = await latestWorkspace();
      const stored = await persist(nextBrand, mergeWorkspaceProjects(remote, projects), nextProfiles, nextActive?.id ?? '');
      const workspace = normalizeWorkspace(stored);
      setBrandProfiles(workspace.brandProfiles);
      setActiveBrandId(workspace.activeBrandId);
      setBrand(workspace.brand);
      setLibraryBrandFilter(value => value === id ? 'all' : value);
      notify('브랜드 프로필을 삭제했어요.');
    } catch (failure) { notify(message(failure)); }
  }
  async function exportContent(kind: 'png' | 'zip', index = 0) {
    if (exporting || generating || uploading) return;
    if (requireLogin('로그인하면 콘텐츠를 내보낼 수 있어요.')) return;
    if (!photos.length) { notify('내보낼 사진을 먼저 추가해 주세요.'); return; }
    setExporting(true);
    try {
      if (kind === 'zip') await downloadPack(pack, photos, brand);
      else { const card = pack.cards[index]; await downloadCard(card, photos.find(photo => photo.id === card.imageId) ?? photos[0], brand, index); }
      notify(kind === 'zip' ? '카드뉴스와 게시글을 ZIP으로 내보냈어요.' : '카드뉴스를 PNG로 내보냈어요.');
    } catch (failure) { notify(message(failure)); } finally { setExporting(false); }
  }
  useEffect(() => {
    if (!user) {
      setSaveState('readonly');
      return;
    }
    if (!dirty) return;
    if (!authReady || generating || uploading || photoChatBusy || exporting) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      autosaveTimer.current = null;
      void saveCurrentDraft();
    }, AUTOSAVE_DELAY_MS);
    return () => {
      if (autosaveTimer.current) {
        clearTimeout(autosaveTimer.current);
        autosaveTimer.current = null;
      }
    };
  }, [user, dirty, authReady, generating, uploading, photoChatBusy, exporting, brand, brandProfiles, activeBrandId, brief, photos, pack, projects, projectId]);
  useEffect(() => {
    const retry = () => {
      if (latest.current?.dirty && document.visibilityState === 'visible') void saveCurrentDraft();
    };
    window.addEventListener('focus', retry);
    window.addEventListener('online', retry);
    return () => {
      window.removeEventListener('focus', retry);
      window.removeEventListener('online', retry);
    };
  }, []);
  useEffect(() => {
    if (!user) return;
    return subscribeWorkspace(user.id, async () => {
      const snapshot = latest.current;
      const version = editVersion.current;
      if (!snapshot || snapshot.dirty || activeWrites.current > 0 || draftWrite.current) return;
      try {
        const workspace = normalizeWorkspace(await getWorkspace() as WorkspaceState);
        if (editVersion.current !== version || latest.current?.dirty || latest.current?.user?.id !== snapshot.user?.id || latest.current?.projectId !== snapshot.projectId || activeWrites.current > 0 || draftWrite.current) return;
        const currentProject = snapshot.projectId ? workspace.projects.find(project => project.id === snapshot.projectId) : null;
        setProjects(workspace.projects);
        setBrandProfiles(workspace.brandProfiles);
        setActiveBrandId(currentProject ? projectBrandId(currentProject, workspace.brandProfiles) ?? workspace.activeBrandId : workspace.activeBrandId);
        if (currentProject) {
          setBrand(currentProject.brand);
          setBrief(currentProject.brief);
          setPhotos(visible => currentProject.photos.map(stored => {
            const current = visible.find(photo => photo.id === stored.id);
            // Keep local generated bytes when the server confirms the same uploaded object.
            return current?.storagePath && current.storagePath === stored.storagePath && current.dataUrl.startsWith('data:')
              ? { ...stored, dataUrl: current.dataUrl }
              : stored;
          }));
          setPack(currentProject.pack);
        } else {
          setBrand(workspace.brand);
        }
        setSaveState(snapshot.projectId ? 'saved' : 'idle');
        setSaveError('');
      } catch {
        // Background refresh is best-effort; local state remains authoritative while editing.
      }
    });
  }, [user]);
  const mode: 'ai' | 'template' = user && entitlements.plan !== 'free' && entitlements.configured && status?.mode === 'live' && entitlements.aiRemaining > 0 ? 'ai' : 'template';
  const filteredProjects = libraryBrandFilter === 'all'
    ? projects
    : projects.filter(project => projectBrandId(project, brandProfiles) === libraryBrandFilter);
  const accountDialog = authOpen && <AuthDialog user={user} onClose={() => setAuthOpen(false)} onAuthenticated={authenticated} onLogout={signOut} onAccountDeleted={() => { if (autosaveTimer.current) clearTimeout(autosaveTimer.current); latest.current = null; location.replace('/studio?account=1'); }} onAccountDataErased={() => { if (autosaveTimer.current) clearTimeout(autosaveTimer.current); latest.current = null; location.replace('/studio'); }} />;
  const checkoutDialog = checkout && authReady && !authOpen && <CheckoutDialog {...checkout} user={user} onClose={() => setCheckout(null)} onLogin={showAccount} />;
  const notification = toast && <div className={`toast${toastLeaving ? ' toast-leaving' : ''}`} role="status">{toast}<button aria-label="알림 닫기" onClick={() => setToast('')}>×</button></div>;
  const connection = !authReady && <div className="auth-loading" role="status">{authFailure || '계정을 확인하고 있어요…'}{authFailure && <><button onClick={() => void restoreSession()}>다시 연결</button><button onClick={() => { setUser(null); installWorkspace(initialState()); setAuthReady(true); setAuthFailure(''); }}>비회원으로 계속</button></>}</div>;
  const saveStatus = autoSaveStatusText(user ? saveState : 'readonly', saveError);
  if (page === 'home') return <><Landing onCheckout={(plan, interval) => setCheckout({plan, interval})} onStart={() => navigate('editor')} onLogin={showAccount} userName={user?.name} onAccount={showAccount} />{checkoutDialog}{accountDialog}{notification}{connection}</>;
  if (!authReady) return <main className="auth-recovery"><h1>스튜디오를 준비하고 있어요.</h1>{connection}<button onClick={() => navigate('home')}>홈으로 돌아가기</button></main>;
  if (page === 'payment') return <><PaymentResult user={user} onLogin={showAccount} onHome={() => navigate('home')} /><footer className="payment-business-footer"><BusinessInfo /></footer>{accountDialog}{notification}</>;
  return <Shell page={page} brand={brand} onNavigate={navigate} onHome={() => navigate('home')} accountControl={<button className="studio-account-button" onClick={showAccount}>{user ? `${user.name}님` : '로그인 / 회원가입'}</button>}>
    {page === 'editor' && <><EditorTutorial key={user?.id ?? 'guest'} userId={user?.id ?? null} suspended={authOpen || !!checkout || !!pendingAction} /><div className="page-intro"><h1>우리 카페의 이야기를 만들어요.</h1><p>사진을 고르고 이야기를 더하면, 콘텐츠가 완성됩니다.</p></div>
      <UsagePanel user={user} status={status} entitlements={entitlements} loading={usageLoading} compact onRefresh={() => void refreshEntitlements(user, { silent: true })} />
      <div className="workbench"><BriefForm brand={brand} brief={brief} photos={photos} onBriefChange={changeBrief} onPhotosAdd={addPhotos} onPhotoRemove={removePhoto} selectedPhotoId={photos.find(photo => photo.id === selectedCard?.imageId)?.id ?? photos[0]?.id} onPhotoSelect={selectPhoto} onGenerate={generate} generating={generating || uploading || photoChatBusy} mode={mode} error={error ?? (offline ? '생성 서버에 연결할 수 없어요. 서버 실행 상태를 확인해 주세요.' : null)} readOnly={isReadOnly} onLogin={showAccount} />
        <WorkspacePreview key={chatSession} selectedCardId={selectedCard?.id ?? ''} onCardSelect={setSelectedCardId} chatUserId={user?.id ?? null} onChatBusyChange={setPhotoChatBusy} onPhotoReplace={replacePhoto} photoEditingDisabled={generating || uploading || savingAccount || photoChatBusy} readOnly={isReadOnly} onLogin={showAccount} brand={brand} photos={photos} pack={pack} onPackChange={changePack} exporting={exporting} onExport={exportContent} scheduleEnabled={brief.includeSchedule === true} />
      </div></>}
    {page === 'library' && <Library brandFilter={<div className="library-filter" aria-label="브랜드별 보관함 보기"><label>브랜드 보기<select value={libraryBrandFilter} onChange={event => setLibraryBrandFilter(event.target.value)}><option value="all">전체 브랜드</option>{brandProfiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label></div>} projects={filteredProjects} onOpen={project => void openProject(project)} onDelete={removeProject} onNew={() => void newProject()} readOnly={isReadOnly} onLogin={showAccount} />}
    {page === 'brand' && <div className="brand-settings-page"><UsagePanel user={user} status={status} entitlements={entitlements} loading={usageLoading} onRefresh={() => void refreshEntitlements(user, { silent: true })} /><BrandSettings key={activeBrandId} brand={brand} profiles={brandProfiles} activeBrandId={activeBrandId} brandLimit={entitlements.brandLimit} onSelect={id => void selectBrandProfile(id)} onCreate={createBrandProfile} onDelete={id => { if (requireLogin('로그인하면 브랜드를 삭제할 수 있어요.')) return; setPendingAction({ kind: 'delete-brand', id }); }} onChange={updateBrand} saveStatus={saveStatus} account={!!user} busy={savingAccount} readOnly={isReadOnly} onLogin={showAccount} /></div>}
    {checkoutDialog}
    {accountDialog}
    {pendingAction && <ConfirmDialog title={pendingAction.kind === 'delete-brand' ? '브랜드 프로필을 삭제할까요?' : pendingAction.kind === 'delete' ? '콘텐츠를 삭제할까요?' : pendingAction.kind === 'regenerate' ? '콘텐츠를 다시 만들까요?' : '새 콘텐츠를 만들까요?'} confirmLabel={pendingAction.kind === 'delete-brand' ? '프로필 삭제' : pendingAction.kind === 'delete' ? '삭제' : pendingAction.kind === 'regenerate' ? '다시 만들기' : '새로 만들기'} onCancel={() => setPendingAction(null)} onConfirm={() => { if (pendingAction.kind === 'delete-brand') void deleteBrandProfile(pendingAction.id); else if (pendingAction.kind === 'delete') confirmDelete(pendingAction.id); else if (pendingAction.kind === 'regenerate') void runGenerate(); else resetProject(); setPendingAction(null); }}>{pendingAction.kind === 'delete-brand' ? '선택한 브랜드 프로필을 삭제합니다. 이 브랜드로 만든 기존 콘텐츠와 사진은 보관함에 그대로 남아요.' : pendingAction.kind === 'delete' ? '보관함에서 삭제됩니다. 이미 다운로드한 파일은 그대로 유지돼요.' : pendingAction.kind === 'regenerate' ? '현재 미리보기에서 직접 수정한 문구가 새 생성 결과로 바뀝니다.' : '현재 저장하지 않은 수정 내용은 사라집니다.'}</ConfirmDialog>}
    {notification}
  </Shell>;
}
