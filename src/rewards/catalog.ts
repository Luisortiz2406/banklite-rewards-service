/**
 * Programa Puntos Banklite: valores, niveles, catálogo de canjes y retos.
 * Los mismos de la versión simulada del frontend.
 */
export const POINT_VALUE = 10; // 1 punto = $10 al canjear
export const POINTS_PER = 1000; // 1 punto por cada $1.000

export interface Level {
  name: string;
  min: number;
  multiplier: number;
}

export const POINT_LEVELS: Level[] = [
  { name: 'Bronce', min: 0, multiplier: 1 },
  { name: 'Plata', min: 1500, multiplier: 1.25 },
  { name: 'Oro', min: 5000, multiplier: 1.5 },
];

export type RewardKind = 'cash' | 'recharge' | 'coupon';

export interface Reward {
  id: string;
  kind: RewardKind;
  title: string;
  text: string;
  points: number;
  value?: number; // pesos (plata y recargas)
}

export const POINT_REWARDS: Reward[] = [
  {
    id: 'cash5',
    kind: 'cash',
    title: '$5.000 a tu cuenta',
    text: 'Se suman a tu saldo al instante',
    points: 500,
    value: 5000,
  },
  {
    id: 'cash20',
    kind: 'cash',
    title: '$20.000 a tu cuenta',
    text: 'Se suman a tu saldo al instante',
    points: 2000,
    value: 20000,
  },
  {
    id: 'cash50',
    kind: 'cash',
    title: '$50.000 a tu cuenta',
    text: 'Se suman a tu saldo al instante',
    points: 5000,
    value: 50000,
  },
  {
    id: 'recharge10',
    kind: 'recharge',
    title: 'Recarga de $10.000',
    text: 'A tu celular verificado',
    points: 1000,
    value: 10000,
  },
  { id: 'coffee', kind: 'coupon', title: 'Café gratis', text: 'En Café La Esquina', points: 600 },
  { id: 'shop20', kind: 'coupon', title: '20% en compras online', text: 'Hasta $40.000 de descuento', points: 1200 },
  { id: 'cinema', kind: 'coupon', title: 'Cine 2x1', text: 'Dos entradas por el precio de una', points: 1500 },
];

export const COUPON_DAYS = 30;

// Operadores para el canje de recarga (códigos de payment-service).
export const RECHARGE_OPERATORS: Record<string, string> = {
  'rec-claro': 'Claro',
  'rec-movistar': 'Movistar',
  'rec-tigo': 'Tigo',
  'rec-wom': 'WOM',
  'rec-virgin': 'Virgin Mobile',
};

export interface Badge {
  id: string;
  title: string;
  text: string;
  points: number;
  icon: string;
  link?: string;
  // Funciones que todavía no existen en Banklite: el reto se muestra, pero no se puede cumplir.
  soon?: boolean;
}

export const POINT_BADGES: Badge[] = [
  { id: 'welcome', title: 'Bienvenida', text: 'Por unirte a Puntos Banklite', points: 250, icon: '★' },
  {
    id: 'first-key',
    title: 'Tu primera llave',
    text: 'Registra una llave Bre-B',
    points: 150,
    icon: '@',
    link: 'llaves.html',
  },
  {
    id: 'first-qr',
    title: 'Paga con QR',
    text: 'Haz tu primer pago con QR',
    points: 150,
    icon: '▦',
    link: 'qr.html?tab=pagar',
  },
  {
    id: 'first-bill',
    title: 'Cero filas',
    text: 'Paga tu primera factura',
    points: 100,
    icon: '◫',
    link: 'pagos.html',
  },
  {
    id: 'first-purchase',
    title: 'Estrena tu tarjeta',
    text: 'Inscribe una suscripción o compra con tu tarjeta',
    points: 50,
    icon: '▭',
    link: 'dashboard.html#tarjetas',
  },
  {
    id: 'first-pocket',
    title: 'Ahorrador',
    text: 'Aparta plata en un bolsillo',
    points: 100,
    icon: '$',
    link: 'inversiones.html',
  },
  {
    id: 'first-cdt',
    title: 'Inversionista',
    text: 'Abre tu primer CDT',
    points: 300,
    icon: '↗',
    link: 'inversiones.html',
  },
];

export function levelFor(earned: number) {
  let index = 0;
  POINT_LEVELS.forEach((level, i) => {
    if (earned >= level.min) index = i;
  });
  return { ...POINT_LEVELS[index], index, next: POINT_LEVELS[index + 1] ?? null };
}
