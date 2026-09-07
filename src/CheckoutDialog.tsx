import { useEffect, useRef, useState } from 'react';
import type { User } from './lib/auth';
import {
  createPaymentOrder,
  expectedAmount,
  formatWon,
  getPaymentConfig,
  getPaymentOrders,
  intervalLabel,
  planLabel,
  requestTossPayment,
  type PaymentConfig,
  type PaymentInterval,
  type PaymentOrder,
  type PaymentPlan,
} from './lib/payments';
import './payments.css';

interface Props {
  plan: PaymentPlan;
  interval: PaymentInterval;
  user: User | null;
  onClose: () => void;
  onLogin: () => void;
}

export function CheckoutDialog({ plan, interval, user, onClose, onLogin }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const bodyOverflow = useRef('');
  const [config, setConfig] = useState<PaymentConfig | null>(null);
  const [orders, setOrders] = useState<PaymentOrder[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const amount = expectedAmount(plan, interval);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    bodyOverflow.current = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    getPaymentConfig().then(setConfig).catch(failure => setError(message(failure)));
    if (user) getPaymentOrders().then(result => setOrders(result.orders)).catch(() => setOrders([]));
    return () => {
      element?.close();
      document.body.style.overflow = bodyOverflow.current;
    };
  }, [user]);

  async function startPayment() {
    if (!user) {
      onLogin();
      return;
    }
    if (!config?.configured || busy) return;
    setBusy(true);
    setError('');
    try {
      const order = await createPaymentOrder(plan, interval);
      dialog.current?.close();
      await requestTossPayment(order);
    } catch (failure) {
      setError(message(failure));
      if (!dialog.current?.open) dialog.current?.showModal();
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || (!!user && (!config || !config.configured));
  const modeLabel = config?.mode === 'live' ? '실결제' : config?.mode === 'test' ? '테스트 결제' : '결제 준비 중';

  return (
    <dialog
      ref={dialog}
      className="payment-dialog"
      aria-labelledby="payment-title"
      onCancel={event => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={event => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section className="payment-checkout">
        <button className="payment-close" type="button" disabled={busy} onClick={onClose} aria-label="결제 창 닫기">×</button>
        <div className="payment-kicker">MO:A STUDIO PLAN</div>
        <h2 id="payment-title">{planLabel(plan)} {intervalLabel(interval)} 플랜</h2>
        <p className="payment-copy">선택한 기간만큼 결제합니다. 자동 반복 결제는 별도 계약 전까지 실행되지 않습니다.</p>
        <div className="payment-summary" aria-label="결제 요약">
          <div><span>플랜</span><strong>{planLabel(plan)}</strong></div>
          <div><span>주기</span><strong>{intervalLabel(interval)}</strong></div>
          <div><span>결제 금액</span><strong>{formatWon(amount)}원</strong></div>
        </div>
        <div className="payment-status" data-mode={config?.mode ?? 'disabled'}>
          <span>{modeLabel}</span>
          <p>{!user ? '로그인 후 결제를 이어갈 수 있어요.' : config?.configured ? (config.mode === 'test' ? '테스트 키로 결제창을 엽니다. 실제 청구는 발생하지 않습니다.' : '토스페이먼츠 실결제 키로 결제창을 엽니다.') : config?.message ?? '토스페이먼츠 설정을 확인하고 있어요.'}</p>
        </div>
        {error && <p className="payment-error" role="alert">{error}</p>}
        {orders.length > 0 && <RecentOrders orders={orders.slice(0, 3)} />}
        <button className="payment-primary" type="button" disabled={disabled} onClick={startPayment}>
          {busy ? '토스 결제창 여는 중…' : user ? `${formatWon(amount)}원 결제하기` : '로그인하고 결제하기'}
          <span aria-hidden="true">↗</span>
        </button>
      </section>
    </dialog>
  );
}

function RecentOrders({ orders }: { orders: PaymentOrder[] }) {
  return <div className="payment-history" aria-label="최근 결제 내역">
    <div className="payment-history-title">최근 결제 내역</div>
    {orders.map(order => <div className="payment-history-row" key={order.orderId}>
      <div>
        <strong>{order.orderName}</strong>
        <span>{order.createdAt ? new Date(order.createdAt).toLocaleDateString('ko-KR') : order.orderId}</span>
      </div>
      <div>
        <strong>{formatWon(order.amount)}원</strong>
        <span>{statusLabel(order)}</span>
      </div>
      {order.receiptUrl && <a href={order.receiptUrl} target="_blank" rel="noreferrer">영수증</a>}
    </div>)}
  </div>;
}

function statusLabel(order: PaymentOrder) {
  if (order.providerStatus === 'PARTIAL_CANCELED') return '부분 취소됨';
  if (order.status === 'CANCELED') return '취소됨';
  if (order.status === 'PAID') return order.periodEnd ? `${new Date(order.periodEnd).toLocaleDateString('ko-KR')}까지` : '결제 완료';
  if (order.status === 'PENDING') return '결제 대기';
  return order.status;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : '결제를 시작하지 못했어요. 다시 시도해 주세요.';
}
