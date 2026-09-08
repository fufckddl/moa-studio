import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './editor-tutorial.css';

type TutorialStep = {
  id: string;
  selector: string;
  title: string;
  body: string;
};

type TargetRect = {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
};

type ViewportRect = {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
};

export interface EditorTutorialProps {
  userId: string | null;
  suspended?: boolean;
}

const TARGET_PADDING = 8;
const VIEWPORT_GAP = 16;
const POPOVER_WIDTH = 360;
const MOBILE_BREAKPOINT = 800;
const DOCK_GAP = 16;
const DOCK_HEIGHT = 270;
const HIGHLIGHT_RADIUS = 20;

const steps: TutorialStep[] = [
  {
    id: 'photos',
    selector: '[data-tutorial="photos"]',
    title: '사진 선택',
    body: '콘텐츠에 쓸 사진을 추가하고 카드에 적용할 대표 이미지를 고르는 곳입니다. 사진은 최대 3장까지 올릴 수 있어요.',
  },
  {
    id: 'information',
    selector: '[data-tutorial="information"]',
    title: '콘텐츠 정보',
    body: '메뉴 이름, 설명, 가격, 목적, 톤앤매너를 입력하면 아래 만들기 버튼이 이 정보를 바탕으로 문구와 카드 구성을 준비합니다.',
  },
  {
    id: 'generate',
    selector: '[data-tutorial="generate"]',
    title: '콘텐츠 만들기',
    body: '사진과 정보를 확인한 뒤 누르면 카드뉴스, 게시글 문구, 필요한 경우 홍보 일정까지 한 번에 생성합니다.',
  },
  {
    id: 'preview',
    selector: '[data-tutorial="preview"]',
    title: '미리보기 전환',
    body: '카드뉴스, 게시글, 홍보 일정 탭을 오가며 결과를 확인하고 직접 수정할 수 있습니다.',
  },
  {
    id: 'card-manage',
    selector: '[data-tutorial="card-manage"]',
    title: '카드 관리',
    body: '카드를 추가하거나 삭제하고, 아래 썸네일과 이전·다음 버튼으로 편집할 카드를 빠르게 바꿀 수 있습니다.',
  },
  {
    id: 'card-edit',
    selector: '[data-tutorial="card-edit"]',
    title: '문구와 스타일 편집',
    body: '편집 패널을 열어 두었어요. 다음 단계부터 레이아웃, 사진, 문구와 스타일 설정을 하나씩 살펴봅니다.',
  },
  {"id": "edit-layout", "selector": "[data-tutorial=\"edit-layout\"]", "title": "카드 레이아웃", "body": "사진 중심, 여백형, 포스터형 등 원하는 구성을 고릅니다. 선택한 카드의 디자인이 미리보기에 반영돼요."},
  {"id": "edit-photo", "selector": "[data-tutorial=\"edit-photo\"]", "title": "카드에 사용할 사진", "body": "업로드한 사진 중 현재 카드에 쓸 사진을 고릅니다. 사진이 한 장이면 선택할 다른 사진이 없어 비활성화돼요."},
  {"id": "edit-eyebrow", "selector": "[data-tutorial=\"edit-eyebrow\"]", "title": "작은 제목", "body": "메뉴 분류나 짧은 소개처럼 큰 제목 위에 들어갈 보조 문구를 적습니다."},
  {"id": "edit-title", "selector": "[data-tutorial=\"edit-title\"]", "title": "큰 제목", "body": "카드에서 가장 강조할 문구를 적습니다. 줄바꿈을 넣어 제목의 호흡을 조절할 수 있어요."},
  {"id": "edit-subtitle", "selector": "[data-tutorial=\"edit-subtitle\"]", "title": "부제목", "body": "메뉴의 특징이나 가격처럼 제목을 보충할 내용을 적습니다. 미리보기에서 글이 잘 보이는지 확인하세요."},
  {"id": "edit-body", "selector": "[data-tutorial=\"edit-body\"]", "title": "본문", "body": "더 자세한 설명을 적는 곳입니다. 선택한 레이아웃에 따라 본문의 위치와 보이는 분량이 달라져요."},
  {"id": "edit-text-color", "selector": "[data-tutorial=\"edit-text-color\"]", "title": "텍스트 색상", "body": "현재 카드에 사용할 글자 색을 고릅니다. 배경이나 사진과 대비되는 색을 쓰면 읽기 편해요."},
  {"id": "edit-background", "selector": "[data-tutorial=\"edit-background\"]", "title": "배경 색상", "body": "현재 카드의 배경 색을 바꿉니다. 사진이 덮는 부분을 제외한 영역에서 색을 확인할 수 있어요."},
  {"id": "edit-font-size", "selector": "[data-tutorial=\"edit-font-size\"]", "title": "글자 크기", "body": "슬라이더로 글자를 기본 크기의 85%부터 120%까지 조절합니다. 긴 문구는 크기를 줄여 맞춰 보세요."},
  {"id": "edit-alignment", "selector": "[data-tutorial=\"edit-alignment\"]", "title": "글자 정렬", "body": "글을 왼쪽, 가운데, 오른쪽 중 어디에 맞출지 고릅니다. 현재 카드에만 적용돼요."},
  {
    id: 'photo-chat',
    selector: '[data-tutorial="photo-chat"]',
    title: 'AI 사진 수정',
    body: '사진 수정 패널을 열면 선택한 카드 사진을 대화로 다듬거나 다시 사용할 인물을 만들 수 있습니다.',
  },
  { id: 'chat-card', selector: '[data-tutorial="chat-card"]', title: '현재 작업 중인 카드', body: '선택한 카드의 사진과 이름이 채팅 상단에 고정돼요. 누르면 현재 사진을 크게 확인할 수 있습니다. 대화가 길어져도 작업 대상을 바로 확인하세요.' },
  {"id": "chat-modes", "selector": "[data-tutorial=\"chat-modes\"]", "title": "인물 생성과 AI 사진 수정", "body": "인물 생성은 원본 없이 다시 사용할 인물을 만듭니다. AI 사진 수정은 현재 카드의 사진을 바꾸는 기능이에요. 작업에 맞는 탭을 선택하세요."},
  {"id": "chat-references", "selector": "[data-tutorial=\"chat-references\"]", "title": "참고 이미지", "body": "AI 사진 수정에 참고할 이미지를 최대 3장 추가합니다. 분위기를 참고할지, 인물·제품을 참고할지 사진마다 지정할 수 있어요."},
  { id: 'chat-library', selector: '[data-tutorial="chat-library"]', title: '인물 보관함 바로 열기', body: '입력창 옆에서 저장한 인물을 꺼내 씁니다. 인물을 고르면 보관함이 접히고 AI 사진 수정의 참고 이미지에 추가돼요. 실제 카드 사진은 수정 결과를 적용할 때 바뀝니다.' },
  {"id": "chat-prompt", "selector": "[data-tutorial=\"chat-prompt\"]", "title": "원하는 작업 설명", "body": "만들 인물이나 사진에서 바꾸고 싶은 내용을 적습니다. Enter는 전송, Shift+Enter는 줄바꿈이에요. 이 안내 중에는 요청을 보내지 않습니다."},
  {"id": "chat-submit", "selector": "[data-tutorial=\"chat-submit\"]", "title": "AI 작업 실행", "body": "내용을 확인한 뒤 실행합니다. 로그인 상태와 남은 사용량에 따라 버튼이 활성화돼요. 성공한 작업은 사용량에 반영됩니다."},
  {"id": "chat-review", "selector": "[data-tutorial=\"chat-review\"]", "title": "결과 확인과 적용", "body": "수정 결과는 먼저 확인한 뒤 이 사진 적용으로 카드에 반영합니다. 생성한 인물은 이 인물 사용으로 사진 수정의 참고에 넣을 수 있어요."},
  {
    id: 'export',
    selector: '[data-tutorial="export"]',
    title: '내보내기',
    body: '현재 카드만 PNG로 저장하거나 전체 카드 묶음을 ZIP으로 내려받아 바로 게시 준비에 사용할 수 있습니다.',
  },
  {
    id: 'navigation',
    selector: '[data-tutorial="navigation"]',
    title: '작업 공간 이동',
    body: '콘텐츠 만들기, 보관함, 브랜드 설정으로 이동합니다. 저장된 작업을 다시 열거나 브랜드 정보를 바꿀 때 사용하세요.',
  },
];

const focusableSelector = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function storageKey(userId: string | null) {
  return `moa:editor-tutorial:${userId ?? 'guest'}:dismissed`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function viewportRect(): ViewportRect {
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const width = viewport?.width ?? window.innerWidth;
  const height = viewport?.height ?? window.innerHeight;
  return {
    top,
    right: left + width,
    bottom: top + height,
    left,
    width,
    height,
  };
}

function dockRect(viewport: ViewportRect = viewportRect()) {
  const mobile = viewport.width <= MOBILE_BREAKPOINT;
  const left = viewport.left + DOCK_GAP;
  const width = mobile
    ? Math.max(0, viewport.width - DOCK_GAP * 2)
    : Math.min(POPOVER_WIDTH, Math.max(0, viewport.width - DOCK_GAP * 2));
  const height = clamp(
    Math.min(DOCK_HEIGHT, viewport.height * 0.45),
    Math.min(120, Math.max(0, viewport.height - DOCK_GAP * 2)),
    Math.max(0, viewport.height - DOCK_GAP * 2),
  );
  const top = viewport.bottom - DOCK_GAP - height;
  return {
    top,
    right: left + width,
    bottom: viewport.bottom - DOCK_GAP,
    left,
    width,
    height,
  };
}

function overlapsHorizontally(left: number, right: number, rect: { left: number; right: number }) {
  return Math.min(right, rect.right) - Math.max(left, rect.left) > 0;
}

function stickyHeaderBottom() {
  const viewport = viewportRect();
  if (viewport.width > 980) return viewport.top;
  const header = document.querySelector<HTMLElement>('.studio-header');
  if (!header) return viewport.top;
  const style = window.getComputedStyle(header);
  if (style.position !== 'sticky' && style.position !== 'fixed') return viewport.top;
  const rect = header.getBoundingClientRect();
  if (rect.top > viewport.top + 1 || rect.bottom <= viewport.top || rect.bottom >= viewport.bottom) return viewport.top;
  return rect.bottom;
}

function focusableElements(container: HTMLElement | null) {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector))
    .filter((element) => !element.hasAttribute('hidden') && element.offsetParent !== null);
}

function findTarget(step: TutorialStep) {
  const elements = Array.from(document.querySelectorAll<HTMLElement>(step.selector));
  return elements.find((element) => element.getClientRects().length > 0 && window.getComputedStyle(element).visibility !== 'hidden') ?? null;
}

function targetRect(element: HTMLElement): TargetRect {
  const raw = element.getBoundingClientRect();
  const viewport = viewportRect();
  const viewportWidth = viewport.width;
  const viewportHeight = viewport.height;
  const headerBottom = element.closest('.photo-chat-panel') ? viewport.top : stickyHeaderBottom();
  const dock = dockRect(viewport);
  const dockOverlapsTarget = overlapsHorizontally(raw.left - TARGET_PADDING, raw.right + TARGET_PADDING, dock);
  const bottomLimit = dockOverlapsTarget ? dock.top - DOCK_GAP : viewport.bottom - VIEWPORT_GAP;
  const headerWouldClip = raw.top < headerBottom && raw.bottom > headerBottom;
  const headerTopBound = headerWouldClip ? headerBottom : viewport.top + VIEWPORT_GAP;
  let topBound = bottomLimit - headerTopBound >= 48 ? headerTopBound : viewport.top + VIEWPORT_GAP;
  let bottomBound = Math.max(topBound, bottomLimit);
  let leftBound = viewport.left + VIEWPORT_GAP;
  let rightBound = Math.max(leftBound, viewport.right - VIEWPORT_GAP);
  // Only reveal the part of a control that its scroll container actually displays.
  for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    const style = window.getComputedStyle(parent);
    const bounds = parent.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      topBound = Math.max(topBound, bounds.top);
      bottomBound = Math.min(bottomBound, bounds.bottom);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      leftBound = Math.max(leftBound, bounds.left);
      rightBound = Math.min(rightBound, bounds.right);
    }
  }
  bottomBound = Math.max(topBound + 1, bottomBound);
  rightBound = Math.max(leftBound, rightBound);
  const left = clamp(raw.left - TARGET_PADDING, leftBound, rightBound);
  const right = clamp(raw.right + TARGET_PADDING, leftBound, rightBound);
  const top = clamp(raw.top - TARGET_PADDING, topBound, bottomBound);
  const bottom = clamp(raw.bottom + TARGET_PADDING, topBound, bottomBound);

  return {
    top: Math.min(top, bottom),
    right: Math.max(left, right),
    bottom: Math.max(top, bottom),
    left: Math.min(left, right),
    width: Math.max(0, Math.abs(right - left)),
    height: Math.max(0, Math.abs(bottom - top)),
    viewportWidth,
    viewportHeight,
  };
}

function scrollableParent(element: HTMLElement) {
  let parent = element.parentElement;
  while (parent && parent !== document.body) {
    const style = window.getComputedStyle(parent);
    const overflow = `${style.overflow}${style.overflowY}${style.overflowX}`;
    if (/(auto|scroll)/.test(overflow) && parent.scrollHeight > parent.clientHeight) return parent;
    parent = parent.parentElement;
  }
  return null;
}

function scrollTargetIntoView(element: HTMLElement) {
  const style = window.getComputedStyle(element);
  if (style.position === 'fixed' || style.position === 'sticky') return;

  const raw = element.getBoundingClientRect();
  const viewport = viewportRect();
  const dock = dockRect(viewport);
  const dockOverlapsTarget = overlapsHorizontally(raw.left - TARGET_PADDING, raw.right + TARGET_PADDING, dock);
  const scroller = scrollableParent(element);
  if (scroller) {
    const container = scroller.getBoundingClientRect();
    const top = container.top + VIEWPORT_GAP;
    const bottom = Math.max(top, Math.min(container.bottom - VIEWPORT_GAP, dockOverlapsTarget ? dock.top - DOCK_GAP : viewport.bottom - VIEWPORT_GAP));
    const availableHeight = Math.max(0, bottom - top);
    const targetHeight = raw.height + TARGET_PADDING * 2;
    const desiredTop = targetHeight >= availableHeight
      ? top
      : top + (availableHeight - targetHeight) / 2;
    const currentTop = raw.top - TARGET_PADDING;
    if (currentTop < top || raw.bottom + TARGET_PADDING > bottom) {
      scroller.scrollBy({ top: currentTop - desiredTop, behavior: 'auto' });
    }
    return;
  }

  const headerBottom = stickyHeaderBottom();
  const bottom = Math.max(viewport.top + VIEWPORT_GAP, dockOverlapsTarget ? dock.top - DOCK_GAP : viewport.bottom - VIEWPORT_GAP);
  const headerTop = Math.max(viewport.top + VIEWPORT_GAP, headerBottom + VIEWPORT_GAP);
  const top = bottom - headerTop >= 48 ? headerTop : viewport.top + VIEWPORT_GAP;
  const availableHeight = bottom - top;
  const targetHeight = raw.height + TARGET_PADDING * 2;
  const desiredTop = targetHeight >= availableHeight
    ? top
    : top + (availableHeight - targetHeight) / 2;
  const currentTop = raw.top - TARGET_PADDING;

  if (currentTop < top || raw.bottom + TARGET_PADDING > bottom) {
    window.scrollBy({ top: currentTop - desiredTop, behavior: 'auto' });
  }
}

function nextAvailableIndex(fromIndex: number, direction: 1 | -1) {
  for (let index = fromIndex; index >= 0 && index < steps.length; index += direction) {
    if (findTarget(steps[index])) return index;
  }
  return -1;
}

function roundedRectPath(x: number, y: number, width: number, height: number, radius: number) {
  const right = x + width;
  const bottom = y + height;
  const r = Math.min(radius, width / 2, height / 2);
  return [
    `M ${x + r} ${y}`,
    `H ${right - r}`,
    `Q ${right} ${y} ${right} ${y + r}`,
    `V ${bottom - r}`,
    `Q ${right} ${bottom} ${right - r} ${bottom}`,
    `H ${x + r}`,
    `Q ${x} ${bottom} ${x} ${bottom - r}`,
    `V ${y + r}`,
    `Q ${x} ${y} ${x + r} ${y}`,
    'Z',
  ].join(' ');
}

function overlayMask(rect: TargetRect | null) {
  const viewport = viewportRect();
  const hole = rect && rect.width > 0 && rect.height > 0
    ? roundedRectPath(rect.left - viewport.left, rect.top - viewport.top, rect.width, rect.height, HIGHLIGHT_RADIUS)
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewport.width} ${viewport.height}"><path fill="black" fill-rule="evenodd" d="M0 0H${viewport.width}V${viewport.height}H0Z ${hole}"/></svg>`;
  return {
    maskImage: `url("data:image/svg+xml,${encodeURIComponent(svg)}")`,
    WebkitMaskImage: `url("data:image/svg+xml,${encodeURIComponent(svg)}")`,
    maskSize: `${viewport.width}px ${viewport.height}px`,
    WebkitMaskSize: `${viewport.width}px ${viewport.height}px`,
    maskPosition: `${viewport.left}px ${viewport.top}px`,
    WebkitMaskPosition: `${viewport.left}px ${viewport.top}px`,
  };
}

export function EditorTutorial({ userId, suspended = false }: EditorTutorialProps) {
  const key = storageKey(userId);
  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<TargetRect | null>(null);
  const [dock, setDock] = useState(() => dockRect());
  const dialogRef = useRef<HTMLDivElement>(null);
  const copyRef = useRef<HTMLDivElement>(null);
  const replayRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const previousScroll = useRef({ left: 0, top: 0 });
  const autoOpened = useRef(false);
  const photoChatOpenRequested = useRef(false);
  const activeStep = steps[stepIndex] ?? steps[0];
  const visible = open && !suspended;
  const maskStyle = useMemo(() => overlayMask(rect), [rect]);

  useEffect(() => {
    if (!visible || (activeStep.id !== 'preview' && activeStep.id !== 'card-edit')) return;
    window.dispatchEvent(new CustomEvent('moa:tutorial:open-editor'));
  }, [activeStep.id, visible]);

  useEffect(() => {
    const shouldOpen = visible && (activeStep.id === 'photo-chat' || activeStep.id.startsWith('chat-'));
    if (shouldOpen && !photoChatOpenRequested.current) {
      window.dispatchEvent(new CustomEvent('moa:tutorial:photo-chat', { detail: 'open' }));
      photoChatOpenRequested.current = true;
    } else if (!shouldOpen && photoChatOpenRequested.current) {
      window.dispatchEvent(new CustomEvent('moa:tutorial:photo-chat', { detail: 'restore' }));
      photoChatOpenRequested.current = false;
    }
  }, [activeStep.id, visible]);

  useEffect(() => () => {
    if (!photoChatOpenRequested.current) return;
    window.dispatchEvent(new CustomEvent('moa:tutorial:photo-chat', { detail: 'restore' }));
    photoChatOpenRequested.current = false;
  }, []);

  const closeSession = useCallback(() => {
    setOpen(false);
    window.requestAnimationFrame(() => {
      window.scrollTo({ left: previousScroll.current.left, top: previousScroll.current.top, behavior: 'auto' });
    });
  }, []);

  const dismissPermanently = useCallback(() => {
    try {
      window.localStorage.setItem(key, '1');
    } catch {
      // Storage can be disabled; closing the current session still works.
    }
    closeSession();
  }, [closeSession, key]);

  const openTutorial = useCallback(() => {
    const first = nextAvailableIndex(0, 1);
    if (first === -1) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    previousScroll.current = { left: window.scrollX, top: window.scrollY };
    setStepIndex(first);
    setOpen(true);
  }, []);

  const showStep = useCallback((requestedIndex: number, direction: 1 | -1) => {
    const next = nextAvailableIndex(requestedIndex, direction);
    if (next === -1) {
      closeSession();
      return;
    }
    setStepIndex(next);
  }, [closeSession]);

  const move = useCallback((direction: 1 | -1) => {
    showStep(stepIndex + direction, direction);
  }, [showStep, stepIndex]);

  useEffect(() => {
    if (autoOpened.current || suspended) return;
    autoOpened.current = true;
    try {
      if (window.localStorage.getItem(key) === '1') return;
    } catch {
      // If storage is unavailable, keep the tutorial discoverable for this mount.
    }
    openTutorial();
  }, [key, openTutorial, suspended]);

  useEffect(() => {
    if (!visible) return undefined;

    const updateDockContract = () => {
      const nextDock = dockRect();
      setDock((current) => (
        Math.abs(current.left - nextDock.left) < 0.5
        && Math.abs(current.top - nextDock.top) < 0.5
        && Math.abs(current.width - nextDock.width) < 0.5
        && Math.abs(current.height - nextDock.height) < 0.5
          ? current
          : nextDock
      ));
      document.documentElement.style.setProperty('--editor-tutorial-dock-height', `${Math.ceil(nextDock.height + DOCK_GAP)}px`);
    };
    updateDockContract();
    document.documentElement.classList.add('editor-tutorial-active');
    document.documentElement.dataset.editorTutorial = 'active';
    window.addEventListener('resize', updateDockContract);
    window.visualViewport?.addEventListener('resize', updateDockContract);

    return () => {
      window.removeEventListener('resize', updateDockContract);
      window.visualViewport?.removeEventListener('resize', updateDockContract);
      document.documentElement.classList.remove('editor-tutorial-active');
      delete document.documentElement.dataset.editorTutorial;
      document.documentElement.style.removeProperty('--editor-tutorial-dock-height');
    };
  }, [visible]);

  useEffect(() => {
    if (!visible) return undefined;

    if (copyRef.current) copyRef.current.scrollTop = 0;

    const target = findTarget(activeStep);
    if (!target) {
      const next = nextAvailableIndex(stepIndex + 1, 1);
      const previous = next === -1 ? nextAvailableIndex(stepIndex - 1, -1) : -1;
      if (next !== -1) setStepIndex(next);
      else if (previous !== -1) setStepIndex(previous);
      else closeSession();
      return undefined;
    }

    scrollTargetIntoView(target);
    setRect(targetRect(target));
    const timeout = window.setTimeout(() => {
      const currentTarget = findTarget(activeStep);
      if (currentTarget) { scrollTargetIntoView(currentTarget); setRect(targetRect(currentTarget)); }
    }, 320);

    return () => window.clearTimeout(timeout);
  }, [activeStep, closeSession, stepIndex, visible]);

  useEffect(() => {
    if (!visible) return undefined;

    const update = () => {
      const target = findTarget(activeStep);
      if (!target) return;
      setRect(targetRect(target));
    };

    let frame = 0;
    const scheduleUpdate = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(update);
    };

    const resize = () => {
      const target = findTarget(activeStep);
      if (target) scrollTargetIntoView(target);
      scheduleUpdate();
    };
    update();
    window.addEventListener('resize', resize);
    window.addEventListener('scroll', scheduleUpdate, true);
    window.visualViewport?.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('scroll', scheduleUpdate);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      window.removeEventListener('scroll', scheduleUpdate, true);
      window.visualViewport?.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('scroll', scheduleUpdate);
    };
  }, [activeStep, visible]);

  useEffect(() => {
    if (!visible) return undefined;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [visible]);

  useEffect(() => {
    if (!visible) return undefined;

    const target = window.setTimeout(() => {
      dialogRef.current?.focus();
    }, 0);

    return () => {
      window.clearTimeout(target);
      window.requestAnimationFrame(() => {
        const destination = previousFocus.current?.isConnected ? previousFocus.current : replayRef.current;
        if (destination?.isConnected) destination.focus();
      });
    };
  }, [visible]);

  useEffect(() => {
    if (!visible) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeSession();
        return;
      }
      if (event.key !== 'Tab') return;
      const elements = focusableElements(dialog);
      if (!elements.length) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!dialog?.contains(document.activeElement) || document.activeElement === dialog) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const onFocusIn = (event: FocusEvent) => {
      const dialog = dialogRef.current;
      if (!dialog || dialog.contains(event.target as Node | null)) return;
      dialog.focus();
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
    };
  }, [closeSession, visible]);

  if (suspended) return null;

  const hasPrevious = nextAvailableIndex(stepIndex - 1, -1) !== -1;
  const hasNext = nextAvailableIndex(stepIndex + 1, 1) !== -1;

  return (
    <>
      <button ref={replayRef} className="editor-tutorial-replay" type="button" onClick={openTutorial}>
        사용법 보기
      </button>
      {visible ? (
        <div className="editor-tutorial-layer" aria-hidden={false}>
          <div className="editor-tutorial-scrim" style={maskStyle} />
          <div
            className="editor-tutorial-highlight"
            style={{ top: rect?.top ?? 0, left: rect?.left ?? 0, width: rect?.width ?? 0, height: rect?.height ?? 0 }}
            onClick={(event) => event.preventDefault()}
          />
          <div
            ref={dialogRef}
            className="editor-tutorial-popover"
            role="dialog"
            aria-modal="true"
            aria-labelledby="editor-tutorial-title"
            aria-describedby="editor-tutorial-body"
            tabIndex={-1}
            style={{ left: dock.left, top: dock.top, bottom: 'auto', width: dock.width, height: dock.height }}
          >
            <div ref={copyRef} className="editor-tutorial-copy">
              <div className="editor-tutorial-progress" aria-label={`사용법 ${stepIndex + 1} / ${steps.length}`}>
                <span>{String(stepIndex + 1).padStart(2, '0')}</span>
                <span>/ {String(steps.length).padStart(2, '0')}</span>
              </div>
              <h2 id="editor-tutorial-title">{activeStep.title}</h2>
              <p id="editor-tutorial-body">{activeStep.body}</p>
              <p className="editor-tutorial-note">완료해도 다음 방문에 다시 안내해요. 그만 보기를 누르면 자동 안내가 꺼져요.</p>
            </div>
            <div className="editor-tutorial-actions">
              <button className="editor-tutorial-secondary" type="button" onClick={closeSession}>
                이번만 닫기
              </button>
              <button className="editor-tutorial-secondary" type="button" onClick={dismissPermanently}>
                그만 보기
              </button>
              <span className="editor-tutorial-spacer" />
              <button className="editor-tutorial-secondary" type="button" onClick={() => move(-1)} disabled={!hasPrevious}>
                이전
              </button>
              <button className="editor-tutorial-primary" type="button" onClick={() => hasNext ? move(1) : closeSession()}>
                {hasNext ? '다음' : '완료'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
