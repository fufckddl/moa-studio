import { useEffect, useState } from 'react';
import type { User } from './lib/auth';
import { confirmPayment, formatWon, getPaymentOrder, type PaymentOrder } from './lib/payments';
import './payments.css';

interface Props {
  user: User | null;
  onLogin: () => void;
  onHome: () => void;
}

type ResultState =
  | { status: 'checking' }
  | { status: 'login' }
  | { status: 'success'; order: PaymentOrder }
  | { status: 'fail'; title: string; detail: string; order?: PaymentOrder; canRetry?: boolean };

const confirmedOrders = new Map<string, Promise<PaymentOrder>>();

export function PaymentResult({ user, onLogin, onHome }: Props) {
  const [state, setState] = useState<ResultState>({ status: 'checking' });
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams(location.search);
    const paymentState = params.get('payment');
    const orderId = params.get('orderId')?.trim() ?? '';
    const paymentKey = params.get('paymentKey')?.trim() ?? '';
    const amountText = params.get('amount')?.trim() ?? '';

    async function resolveResult() {
      if (!user) {
        if (active) setState({ status: 'login' });
        return;
      }
      if (paymentState === 'fail') {
        const order = orderId ? await readOrder(orderId) : undefined;
        if (!active) return;
        if (order?.status === 'PAID') { setState({ status: 'success', order }); return; }
        setState({
          status: 'fail',
          title: '결제가 완료되지 않았어요.',
          detail: params.get('message') ?? '토스 결제창에서 결제가 취소되었거나 실패했습니다.',
          order,
          canRetry: !!orderId,
        });
        return;
      }
      const amount = Number(amountText);
      if (paymentState !== 'success' || !isValidOrderId(orderId)) {
        if (active) setState({ status: 'fail', title: '결제 정보를 확인할 수 없어요.', detail: '주문 정보가 올바르지 않습니다. 가격표에서 다시 시도해 주세요.' });
        return;
      }
      if (!paymentKey) {
        const order = await getPaymentOrder(orderId);
        if (!active) return;
        if (order.status === 'PAID') setState({ status: 'success', order });
        else setState({ status: 'fail', title: '결제 승인이 아직 완료되지 않았어요.', detail: '주문 상태를 다시 확인해 주세요.', order, canRetry: true });
        return;
      }
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        if (active) setState({ status: 'fail', title: '결제 금액을 확인할 수 없어요.', detail: '토스 결제 결과의 금액 정보가 올바르지 않습니다.', canRetry: true });
        return;
      }
      const order = await confirmOnce(user.id, orderId, paymentKey, amount);
      if (!active) return;
      stripSensitiveQuery(orderId);
      const refreshed = await getPaymentOrder(orderId).catch(() => order);
      if (!active) return;
      if (refreshed.status === 'PAID') setState({ status: 'success', order: refreshed });
      else setState({ status: 'fail', title: '결제 승인이 아직 완료되지 않았어요.', detail: '주문 상태를 다시 확인해 주세요.', order: refreshed, canRetry: true });
    }

    setState({ status: 'checking' });
    resolveResult().catch(failure => {
      if (active) setState({ status: 'fail', title: '결제 승인 중 문제가 생겼어요.', detail: failure instanceof Error ? failure.message : '잠시 후 주문을 다시 확인해 주세요.', canRetry: true });
    });
    return () => { active = false; };
  }, [user, retry]);

  if (state.status === 'checking') {
    return <main className="payment-result" aria-live="polite"><span>PAYMENT</span><h1>결제 결과를 확인하고 있어요.</h1><p>토스페이먼츠 승인 결과와 주문 금액을 대조하는 중입니다.</p></main>;
  }

  if (state.status === 'login') {
    return <main className="payment-result"><span>LOGIN REQUIRED</span><h1>로그인이 필요해요.</h1><p>결제 결과는 주문한 계정에서만 확인할 수 있습니다.</p><div className="payment-actions"><button onClick={onLogin}>로그인하기</button><button onClick={onHome}>홈으로</button></div></main>;
  }

  if (state.status === 'success') {
    return <main className="payment-result payment-result-success"><span>PAYMENT COMPLETE</span><h1>{state.order.mode === 'test' ? '테스트 결제가 완료됐어요.' : '결제가 완료됐어요.'}</h1><p>{state.order.orderName} · {formatWon(state.order.amount)}원</p><PaymentMeta order={state.order} /><div className="payment-actions"><button onClick={onHome}>홈으로</button>{state.order.receiptUrl && <a href={state.order.receiptUrl} target="_blank" rel="noreferrer">영수증 보기</a>}</div></main>;
  }

  return <main className="payment-result"><span>PAYMENT FAILED</span><h1>{state.title}</h1><p>{state.detail}</p>{state.order && <PaymentMeta order={state.order} />}<div className="payment-actions">{state.canRetry && <button onClick={() => setRetry(value => value + 1)}>다시 확인</button>}<button onClick={onHome}>홈으로 돌아가기</button></div></main>;
}

function PaymentMeta({ order }: { order: PaymentOrder }) {
  return <dl className="payment-meta">
    <div><dt>주문번호</dt><dd>{order.orderId}</dd></div>
    <div><dt>현재 상태</dt><dd>{statusLabel(order)}</dd></div>
    {order.createdAt && <div><dt>주문일</dt><dd>{new Date(order.createdAt).toLocaleDateString('ko-KR')}</dd></div>}
    {order.paidAt && <div><dt>구매일</dt><dd>{new Date(order.paidAt).toLocaleDateString('ko-KR')}</dd></div>}
    {order.periodEnd && <div><dt>{order.mode === 'test' ? '테스트 기간' : '이용 기간'}</dt><dd>{new Date(order.periodEnd).toLocaleDateString('ko-KR')}까지</dd></div>}
  </dl>;
}

function statusLabel(order: PaymentOrder) {
  if (order.providerStatus === 'PARTIAL_CANCELED') return '부분 취소됨';
  if (order.status === 'CANCELED') return '취소됨';
  if (order.status === 'PAID') return '결제 완료';
  if (order.status === 'PENDING') return '결제 대기';
  return order.status;
}

function confirmOnce(userId: string, orderId: string, paymentKey: string, amount: number) {
  const key = `${userId}:${orderId}:${paymentKey}:${amount}`;
  if (!confirmedOrders.has(key)) {
    const request = confirmPayment({ orderId, paymentKey, amount }).catch(error => {
      confirmedOrders.delete(key);
      throw error;
    });
    confirmedOrders.set(key, request);
  }
  return confirmedOrders.get(key)!;
}

function stripSensitiveQuery(orderId: string) {
  const next = new URL(location.href);
  next.search = `?payment=success&orderId=${encodeURIComponent(orderId)}`;
  history.replaceState(null, '', `${next.pathname}${next.search}${next.hash}`);
}

async function readOrder(orderId: string) {
  if (!isValidOrderId(orderId)) return undefined;
  try { return await getPaymentOrder(orderId); }
  catch { return undefined; }
}

function isValidOrderId(value: string) {
  return /^moa_[0-9a-f]{32}$/i.test(value);
}
