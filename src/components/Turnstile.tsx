import { useEffect, useId, useRef } from 'react';

declare global {
  interface Window {
    turnstile?: {
      render(element: HTMLElement, options: { sitekey: string; callback(token: string): void; 'expired-callback'(): void; 'error-callback'(): void }): string;
      reset(widgetId?: string): void;
      remove(widgetId: string): void;
    };
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let scriptPromise: Promise<void> | null = null;

interface Props {
  siteKey: string;
  onVerify: (token: string) => void;
  onExpire?: () => void;
  onError?: () => void;
  resetKey?: number;
}

function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Turnstile failed to load')), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Turnstile failed to load'));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export function Turnstile({ siteKey, onVerify, onExpire, onError, resetKey = 0 }: Props) {
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const onVerifyRef = useRef(onVerify);
  const onExpireRef = useRef(onExpire);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onVerifyRef.current = onVerify;
    onExpireRef.current = onExpire;
    onErrorRef.current = onError;
  }, [onVerify, onExpire, onError]);

  useEffect(() => {
    let active = true;
    onExpireRef.current?.();
    if (!siteKey) return undefined;
    loadScript().then(() => {
      if (!active || !container.current || !window.turnstile) return;
      widget.current = window.turnstile.render(container.current, {
        sitekey: siteKey,
        callback: (token) => onVerifyRef.current(token),
        'expired-callback': () => onExpireRef.current?.(),
        'error-callback': () => {
          onExpireRef.current?.();
          onErrorRef.current?.();
        },
      });
    }).catch(() => onErrorRef.current?.());
    return () => {
      active = false;
      if (widget.current && window.turnstile) window.turnstile.remove(widget.current);
      widget.current = null;
    };
  }, [siteKey]);

  useEffect(() => {
    onExpireRef.current?.();
    if (widget.current && window.turnstile) window.turnstile.reset(widget.current);
  }, [resetKey]);

  return <div className="auth-turnstile" id={id} ref={container} aria-label="보안 확인" />;
}
