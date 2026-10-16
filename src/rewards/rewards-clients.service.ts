import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Falla al entregar un canje.
 * - definitive: el otro servicio lo rechazó (4xx): seguro no se pagó, se
 *   devuelven los puntos.
 * - si no es definitiva (red caída, timeout, 5xx), no se sabe si se pagó: el
 *   canje queda pendiente y se reintenta con la MISMA clave de idempotencia
 *   (ledger y payment-service nunca pagan dos veces con la misma clave).
 */
export class DeliveryError extends Error {
  constructor(message: string, readonly definitive: boolean) {
    super(message);
  }
}

interface AccountView { id: string; accountNumber: string; accountType: string; status: string }

/**
 * Llamadas a otros servicios: con el token del cliente (sus cuentas, sus datos
 * verificados y sus llaves) o por la red interna con la INTERNAL_API_KEY de
 * rewards-service (ledger y payment-service).
 */
@Injectable()
export class RewardsClientsService {
  constructor(private readonly config: ConfigService) {}

  private url(key: string, fallback: string) {
    return this.config.get<string>(key, fallback).replace(/\/+$/, '');
  }

  private async userGet<T>(base: string, path: string, token: string): Promise<T | null> {
    try {
      const response = await fetch(`${base}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return null;
      return (await response.json()) as T;
    } catch {
      return null;
    }
  }

  /** Cuenta activa del cliente donde llega la plata de un canje. */
  async receivingAccount(token: string): Promise<AccountView | null> {
    const accounts = await this.userGet<AccountView[]>(this.url('ACCOUNT_SERVICE_URL', 'http://localhost:3002'), '/accounts', token);
    return (accounts ?? []).find((a) => a.status === 'active' && a.accountType !== 'merchant') ?? null;
  }

  /** Celular verificado del cliente (KYC), a 10 dígitos. */
  async verifiedPhone(idUser: string, token: string): Promise<string | null> {
    const kyc = await this.userGet<{ telefono?: string | null }>(this.url('KYC_SERVICE_URL', 'http://localhost:3003'), `/kyc/${idUser}`, token);
    const digits = String(kyc?.telefono ?? '').replace(/\D/g, '').slice(-10);
    return /^3\d{9}$/.test(digits) ? digits : null;
  }

  /** ¿El cliente ya registró alguna llave Bre-B? (reto "Tu primera llave"). */
  async hasBrebKey(token: string): Promise<boolean> {
    const data = await this.userGet<{ keys?: unknown[] }>(this.url('ACCOUNT_SERVICE_URL', 'http://localhost:3002'), '/accounts/keys', token);
    return (data?.keys?.length ?? 0) > 0;
  }

  /** Hitos de ahorro del cliente (savings-service): retos "Ahorrador" e "Inversionista". */
  async savingsMilestones(token: string): Promise<{ hasPocket: boolean; hasCdt: boolean }> {
    const data = await this.userGet<{ milestones?: { hasPocket: boolean; hasCdt: boolean } }>(
      this.url('SAVINGS_SERVICE_URL', 'http://localhost:3013'), '/savings', token,
    );
    return data?.milestones ?? { hasPocket: false, hasCdt: false };
  }

  /** Plata a la cuenta del cliente desde la cuenta "Recompensas" del ledger. */
  async creditCash(params: { accountId: string; idUser: string; amount: number; idempotencyKey: string; description: string }) {
    return this.internalPost<{ id: string }>(this.url('LEDGER_SERVICE_URL', 'http://localhost:3006'), '/ledger/internal/rewards', {
      target: 'account',
      accountId: params.accountId,
      beneficiaryUserId: params.idUser,
      amount: params.amount,
      idempotencyKey: params.idempotencyKey,
      description: params.description,
    });
  }

  /** Recarga pagada por el banco al operador (payment-service la registra y la paga desde "Recompensas"). */
  async rewardTopup(params: { idUser: string; operatorCode: string; phone: string; amount: number; idempotencyKey: string }) {
    return this.internalPost<{ ledgerTransactionId: string | null }>(this.url('PAYMENT_SERVICE_URL', 'http://localhost:3011'), '/internal/payments/reward-topups', {
      beneficiaryUserId: params.idUser,
      billerCode: params.operatorCode,
      phone: params.phone,
      amount: params.amount,
      idempotencyKey: params.idempotencyKey,
    });
  }

  private async internalPost<T>(base: string, path: string, body: unknown): Promise<T> {
    const key = this.config.get<string>('INTERNAL_API_KEY');
    if (!key) throw new DeliveryError('INTERNAL_API_KEY no está configurada en Rewards Service.', false);
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-key': key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new DeliveryError('No se pudo completar el canje en este momento.', false);
    }
    const payload = await response.json().catch(() => ({}));
    if (response.ok) return payload as T;
    const message = Array.isArray(payload?.message) ? payload.message.join(', ') : payload?.message || 'No se pudo completar el canje.';
    throw new DeliveryError(String(message).slice(0, 200), response.status >= 400 && response.status < 500);
  }
}
