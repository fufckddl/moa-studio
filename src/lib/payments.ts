import type { User } from './auth';
import { getAccessToken, isCloudConfigured, supabasePublishableKey, supabaseUrl } from './supabase';
import { expectedAmount, formatWon, type PaymentInterval, type PaymentPlan } from './planPricing';

export type { PaymentInterval, PaymentPlan };
export type PaymentMode = 'test' | 'live' | 'disabled';

export interface PaymentConfig {
  configured: boolean;
  mode: PaymentMode;
  clientKey?: string;
  message?: string;
}

export interface CheckoutOrder {
  orderId: string;
  orderName: string;
  amount: number;
  clientKey: string;
  customerKey: string;
  successUrl: string;
  failUrl: string;
  mode: Exclude<PaymentMode, 'disabled'>;
}

export interface PaymentOrder {
  orderId: string;
  orderName: string;
  amount: number;
  status: 'PENDING' | 'PAID' | 'FAILED' | 'CANCELED' | string;
  mode: PaymentMode;
  plan?: PaymentPlan;
  interval?: PaymentInterval;
  receiptUrl?: string;
  periodEnd?: string;
  paidAt?: string;
  createdAt?: string;
  providerStatus?: string;
}

export interface Membership {
  plan: PaymentPlan;
  interval: PaymentInterval;
  mode: PaymentMode;
  periodEnd: string;
}

interface TossPayment {
  requestPayment: (request: TossPaymentRequest) => Promise<void>;
}

interface TossPaymentRequest {
  method: 'CARD';
  sandbox?: { paymentResult: 'SUCCESS' };
  amount: { currency: 'KRW'; value: number };
  orderId: string;
  orderName: string;
  successUrl: string;
  failUrl: string;
}

interface TossPaymentsFactory {
  payment: (options: { customerKey: string }) => TossPayment;
}

declare global {
  interface Window {
    TossPayments?: (clientKey: string) => TossPaymentsFactory;
  }
}

const TOSS_SDK_URL = 'https://js.tosspayments.com/v2/standard';
const TOSS_SDK_TIMEOUT_MS = 15000;
let sdkPromise: Promise<void> | null = null;

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const cloud = isCloudConfigured;
  const token = cloud ? await getAccessToken() : null;
  const response = await fetch(cloud ? cloudPaymentUrl(path) : `/api${path}`, {
    method,
    credentials: cloud ? undefined : 'same-origin',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cloud ? { apikey: supabasePublishableKey } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(readError(result));
  return result as T;
}

function readError(value: unknown) {
  if (value && typeof value === 'object' && 'error' in value && typeof value.error === 'string') return value.error;
  return '요청을 처리하지 못했어요. 다시 시도해 주세요.';
}

export function planLabel(plan: PaymentPlan) {
  return plan === 'light' ? '라이트' : plan === 'studio' ? '스탠다드' : '프로';
}

export function intervalLabel(interval: PaymentInterval) {
  return interval === 'year' ? '연간' : '월간';
}

export { expectedAmount, formatWon };

export const getPaymentConfig = () => request<PaymentConfig>('/payments/config');

export const createPaymentOrder = (plan: PaymentPlan, interval: PaymentInterval) =>
  request<CheckoutOrder>('/payments/orders', 'POST', { plan, interval });

export const getPaymentOrder = (orderId: string) =>
  request<PaymentOrder>(`/payments/orders/${encodeURIComponent(orderId)}`);

export const getPaymentOrders = () => request<{ orders: PaymentOrder[] }>('/payments/orders');

export const confirmPayment = (input: { orderId: string; paymentKey: string; amount: number }) =>
  request<PaymentOrder>('/payments/confirm', 'POST', input);

export const getMembership = () => request<{ membership: Membership | null }>('/payments/membership');

export async function requestTossPayment(order: CheckoutOrder) {
  await loadTossSdk();
  if (!window.TossPayments) throw new Error('토스 결제창을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.');
  await window.TossPayments(order.clientKey).payment({ customerKey: order.customerKey }).requestPayment({
    method: 'CARD',
    amount: { currency: 'KRW', value: order.amount },
    orderId: order.orderId,
    orderName: order.orderName,
    successUrl: order.successUrl,
    failUrl: order.failUrl,
    ...(order.mode === 'test' && order.clientKey.startsWith('test_')
      ? { sandbox: { paymentResult: 'SUCCESS' as const } }
      : {}),
  });
}

export function isSameUser(left: User | null, right: User | null) {
  return !!left && !!right && left.id === right.id;
}

function cloudPaymentUrl(path: string) {
  const route = path.replace(/^\/payments/, '') || '/';
  return `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/moa-payments${route}`;
}

function loadTossSdk() {
  if (window.TossPayments) return Promise.resolve();
  if (!sdkPromise) {
    sdkPromise = new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(`script[src="${TOSS_SDK_URL}"]`);
      let script = existing;
      let settled = false;
      const timeout = window.setTimeout(() => fail(new Error('토스 결제 SDK 응답 시간이 초과됐어요.')), TOSS_SDK_TIMEOUT_MS);
      const done = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        resolve();
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        script?.remove();
        reject(error);
      };
      if (existing) {
        existing.addEventListener('load', done, { once: true });
        existing.addEventListener('error', () => fail(new Error('토스 결제 SDK를 불러오지 못했어요.')), { once: true });
        return;
      }
      script = document.createElement('script');
      script.src = TOSS_SDK_URL;
      script.async = true;
      script.addEventListener('load', done, { once: true });
      script.addEventListener('error', () => fail(new Error('토스 결제 SDK를 불러오지 못했어요.')), { once: true });
      document.head.appendChild(script);
    }).catch(error => {
      sdkPromise = null;
      throw error;
    });
  }
  return sdkPromise;
}
