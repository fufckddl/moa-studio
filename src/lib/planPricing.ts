export type PaymentPlan = 'light' | 'studio' | 'plus';
export type PaymentInterval = 'month' | 'year';

export function expectedAmount(plan: PaymentPlan, interval: PaymentInterval) {
  if (plan === 'light') return interval === 'year' ? 42000 : 3900;
  if (plan === 'studio') return interval === 'year' ? 85000 : 7900;
  return interval === 'year' ? 139000 : 12900;
}

export function formatWon(value: number) {
  return new Intl.NumberFormat('ko-KR').format(value);
}
