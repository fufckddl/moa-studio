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

type DialogPlacement = {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
  width?: number;
};

type DialogSize = {
  width: number;
  height: number;
};

export interface EditorTutorialProps {
  userId: string | null;
  suspended?: boolean;
}

const TARGET_PADDING = 8;
const VIEWPORT_GAP = 16;
const POPOVER_GAP = 14;
const POPOVER_WIDTH = 360;
const INITIAL_POPOVER_HEIGHT = 246;

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
    body: '문구 편집을 열면 제목, 설명, 가격에 맞춘 문장, 레이아웃, 색상, 글자 크기와 정렬을 직접 다듬을 수 있습니다.',
  },
  {
    id: 'photo-chat',
    selector: '[data-tutorial="photo-chat"]',
    title: 'AI 사진 수정',
    body: '사진 수정 패널을 열면 선택한 카드 사진을 대화로 다듬거나 다시 사용할 인물을 만들 수 있습니다.',
  },
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

function stickyHeaderBottom() {
  if (window.innerWidth > 980) return 0;
  const header = document.querySelector<HTMLElement>('.studio-header');
  if (!header) return 0;
  const style = window.getComputedStyle(header);
  if (style.position !== 'sticky' && style.position !== 'fixed') return 0;
  const rect = header.getBoundingClientRect();
  if (rect.top > 1 || rect.bottom <= 0 || rect.bottom >= window.innerHeight) return 0;
  return rect.bottom;
}

function focusableElements(container: HTMLElement | null) {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector))
    .filter((element) => !element.hasAttribute('hidden') && element.offsetParent !== null);
}

function findTarget(step: TutorialStep) {
  const element = document.querySelector<HTMLElement>(step.selector);
  if (!element || element.getClientRects().length === 0 || window.getComputedStyle(element).visibility === 'hidden') return null;
  return element;
}

function targetRect(element: HTMLElement): TargetRect {
  const raw = element.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const headerBottom = stickyHeaderBottom();
  const topBound = raw.top < headerBottom && raw.bottom > headerBottom ? headerBottom : VIEWPORT_GAP;
  const bottomBound = Math.max(topBound, viewportHeight - VIEWPORT_GAP);
  const left = clamp(raw.left - TARGET_PADDING, VIEWPORT_GAP, Math.max(VIEWPORT_GAP, viewportWidth - VIEWPORT_GAP));
  const right = clamp(raw.right + TARGET_PADDING, VIEWPORT_GAP, Math.max(VIEWPORT_GAP, viewportWidth - VIEWPORT_GAP));
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

function scrollTargetIntoView(element: HTMLElement) {
  const style = window.getComputedStyle(element);
  if (style.position === 'fixed' || style.position === 'sticky') return;

  const raw = element.getBoundingClientRect();
  const headerBottom = stickyHeaderBottom();
  const top = Math.max(VIEWPORT_GAP, headerBottom + VIEWPORT_GAP);
  const bottom = Math.max(top, window.innerHeight - VIEWPORT_GAP);
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

function overlap(top: number, height: number, rect: TargetRect) {
  const bottom = top + height;
  return Math.max(0, Math.min(bottom, rect.bottom) - Math.max(top, rect.top));
}

function dialogPlacement(rect: TargetRect | null, size: DialogSize): DialogPlacement {
  const viewportWidth = rect?.viewportWidth ?? window.innerWidth;
  const viewportHeight = rect?.viewportHeight ?? window.innerHeight;
  const width = Math.min(POPOVER_WIDTH, viewportWidth - VIEWPORT_GAP * 2);
  const height = Math.min(size.height, viewportHeight - VIEWPORT_GAP * 2);

  if (!rect || viewportWidth <= 720) {
    if (rect && rect.bottom + POPOVER_GAP + height <= viewportHeight - VIEWPORT_GAP) {
      return { left: VIEWPORT_GAP, right: VIEWPORT_GAP, top: rect.bottom + POPOVER_GAP };
    }
    if (rect && rect.top - POPOVER_GAP - height >= VIEWPORT_GAP) {
      return { left: VIEWPORT_GAP, right: VIEWPORT_GAP, top: rect.top - POPOVER_GAP - height };
    }
    if (rect) {
      const topDock = VIEWPORT_GAP;
      const bottomDock = viewportHeight - height - VIEWPORT_GAP;
      return {
        left: VIEWPORT_GAP,
        right: VIEWPORT_GAP,
        top: overlap(topDock, height, rect) <= overlap(bottomDock, height, rect) ? topDock : bottomDock,
      };
    }
    return { left: VIEWPORT_GAP, right: VIEWPORT_GAP, bottom: VIEWPORT_GAP };
  }

  const sideTop = clamp(rect.top, VIEWPORT_GAP, viewportHeight - height - VIEWPORT_GAP);
  if (viewportWidth - rect.right >= width + POPOVER_GAP + VIEWPORT_GAP) {
    return { width, left: rect.right + POPOVER_GAP, top: sideTop };
  }
  if (rect.left >= width + POPOVER_GAP + VIEWPORT_GAP) {
    return { width, left: rect.left - width - POPOVER_GAP, top: sideTop };
  }
  if (rect.bottom + POPOVER_GAP + height <= viewportHeight - VIEWPORT_GAP) {
    return { width, left: clamp(rect.left, VIEWPORT_GAP, viewportWidth - width - VIEWPORT_GAP), top: rect.bottom + POPOVER_GAP };
  }
  return {
    width,
    left: clamp(rect.left, VIEWPORT_GAP, viewportWidth - width - VIEWPORT_GAP),
    top: clamp(rect.top - POPOVER_GAP - height, VIEWPORT_GAP, viewportHeight - height - VIEWPORT_GAP),
  };
}

export function EditorTutorial({ userId, suspended = false }: EditorTutorialProps) {
  const key = storageKey(userId);
  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<TargetRect | null>(null);
  const [dialogSize, setDialogSize] = useState<DialogSize>({ width: POPOVER_WIDTH, height: INITIAL_POPOVER_HEIGHT });
  const dialogRef = useRef<HTMLDivElement>(null);
  const replayRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const previousScroll = useRef({ left: 0, top: 0 });
  const autoOpened = useRef(false);
  const activeStep = steps[stepIndex] ?? steps[0];
  const visible = open && !suspended;
  const placement = useMemo(() => dialogPlacement(rect, dialogSize), [dialogSize, rect]);

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
    const timeout = window.setTimeout(() => setRect(targetRect(target)), 320);

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

    update();
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('scroll', scheduleUpdate, true);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('scroll', scheduleUpdate, true);
    };
  }, [activeStep, visible]);

  useEffect(() => {
    if (!visible || !dialogRef.current) return undefined;

    const updateSize = () => {
      const bounds = dialogRef.current?.getBoundingClientRect();
      if (!bounds) return;
      setDialogSize({ width: bounds.width, height: bounds.height });
    };
    updateSize();

    if (!('ResizeObserver' in window)) return undefined;
    const observer = new ResizeObserver(updateSize);
    observer.observe(dialogRef.current);
    return () => observer.disconnect();
  }, [visible, stepIndex]);

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
          <div className="editor-tutorial-pane top" style={{ height: rect?.top ?? 0 }} />
          <div className="editor-tutorial-pane bottom" style={{ top: rect?.bottom ?? 0 }} />
          <div className="editor-tutorial-pane left" style={{ top: rect?.top ?? 0, width: rect?.left ?? 0, height: rect?.height ?? 0 }} />
          <div className="editor-tutorial-pane right" style={{ top: rect?.top ?? 0, left: rect?.right ?? 0, height: rect?.height ?? 0 }} />
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
            style={placement}
          >
            <div className="editor-tutorial-progress" aria-label={`사용법 ${stepIndex + 1} / ${steps.length}`}>
              <span>{String(stepIndex + 1).padStart(2, '0')}</span>
              <span>/ {String(steps.length).padStart(2, '0')}</span>
            </div>
            <h2 id="editor-tutorial-title">{activeStep.title}</h2>
            <p id="editor-tutorial-body">{activeStep.body}</p>
            <p className="editor-tutorial-note">완료해도 다음 방문에 다시 안내해요. 그만 보기를 누르면 자동 안내가 꺼져요.</p>
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
