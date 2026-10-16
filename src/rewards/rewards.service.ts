import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomInt } from 'crypto';
import { DataSource, EntityManager, LessThan, MoreThan, Repository } from 'typeorm';
import {
  Badge,
  COUPON_DAYS,
  levelFor,
  POINT_BADGES,
  POINT_REWARDS,
  POINT_VALUE,
  POINTS_PER,
  RECHARGE_OPERATORS,
} from './catalog';
import { PointsEntry, PointsKind } from './entities/points-entry.entity';
import { Redemption } from './entities/redemption.entity';
import { DeliveryError, RewardsClientsService } from './rewards-clients.service';

/** Evento transaction.completed del ledger (uno por titular afectado). */
export interface TransactionEvent {
  idUser: string;
  direction: 'in' | 'out';
  transactionId: string;
  type: string;
  amount: number;
  description?: string;
  reversedTransactionId?: string | null;
}

// Un canje pendiente más viejo que esto se vuelve a intentar (con la misma clave).
const STALE_PENDING_MS = 30_000;

@Injectable()
export class RewardsService {
  private readonly logger = new Logger('Rewards');

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(PointsEntry) private readonly entries: Repository<PointsEntry>,
    @InjectRepository(Redemption) private readonly redemptions: Repository<Redemption>,
    private readonly clients: RewardsClientsService,
  ) {}

  // =====================================================
  // GANAR PUNTOS (evento transaction.completed)
  // =====================================================

  /**
   * Suma puntos por las compras y pagos del cliente: pagos a comercios (facturas,
   * recargas, QR a comercios, suscripciones), compras con tarjeta y pagos con QR a
   * otra persona. Las transferencias, los abonos y los canjes no suman. Si el
   * movimiento se reversa, se quitan los puntos que dio. Idempotente por sourceKey.
   */
  async handleTransaction(event: TransactionEvent) {
    const description = String(event.description ?? '');

    if (event.type === 'reversal' && event.reversedTransactionId) {
      const earned = await this.entries.findOne({ where: { sourceKey: `earn:${event.reversedTransactionId}`, idUser: event.idUser } });
      if (earned && earned.points > 0) {
        await this.addEntry(event.idUser, -earned.points, 'reversal', 'Reverso de compra', earned.title, `reversal:${event.reversedTransactionId}`);
      }
      return;
    }

    if (event.direction !== 'out') return;
    const isQR = event.type === 'transfer' && description.startsWith('Pago QR');
    const isExternalTransfer = event.type === 'debit' && description.startsWith('Transferencia a ');
    const counts = event.type === 'payment' || isQR || (event.type === 'debit' && !isExternalTransfer);
    if (!counts) return;

    const amount = Number(event.amount) || 0;
    if (amount >= POINTS_PER) {
      const level = levelFor(await this.earnedOf(event.idUser));
      const points = Math.floor((amount / POINTS_PER) * level.multiplier);
      const title = isQR || description.startsWith('Pago QR') ? 'Pago con QR'
        : / · Ref\. \d+$/.test(description) ? 'Pago de factura'
          : description.startsWith('Suscripción') ? 'Suscripción'
            : event.type === 'debit' ? 'Compra con tarjeta' : 'Pago';
      await this.addEntry(event.idUser, points, 'earn', title, description.slice(0, 160), `earn:${event.transactionId}`);
    }

    // Retos que se cumplen con un movimiento.
    if (description.startsWith('Pago QR')) await this.awardBadge(event.idUser, 'first-qr');
    if (event.type === 'payment' && / · Ref\. \d+$/.test(description)) await this.awardBadge(event.idUser, 'first-bill');
    if (description.startsWith('Suscripción') || (event.type === 'debit' && !isExternalTransfer)) {
      await this.awardBadge(event.idUser, 'first-purchase');
    }
  }

  // =====================================================
  // RESUMEN (GET /rewards)
  // =====================================================

  async summary(idUser: string, token: string) {
    // Retos que no dependen de un movimiento.
    await this.awardBadge(idUser, 'welcome');
    if (!(await this.hasBadge(idUser, 'first-key')) && (await this.clients.hasBrebKey(token))) {
      await this.awardBadge(idUser, 'first-key');
    }
    if (!(await this.hasBadge(idUser, 'first-pocket')) || !(await this.hasBadge(idUser, 'first-cdt'))) {
      const savings = await this.clients.savingsMilestones(token);
      if (savings.hasPocket) await this.awardBadge(idUser, 'first-pocket');
      if (savings.hasCdt) await this.awardBadge(idUser, 'first-cdt');
    }
    // Canjes que quedaron a medias (p. ej. se cayó la red): se terminan o se devuelven.
    await this.resumeStale(idUser, token);

    const [balance, earned, history, badgeRows, coupons] = await Promise.all([
      this.balanceOf(idUser),
      this.earnedOf(idUser),
      this.entries.find({ where: { idUser }, order: { createdAt: 'DESC' }, take: 30 }),
      this.entries.find({ where: { idUser, kind: 'badge' } }),
      this.redemptions.find({
        where: { idUser, kind: 'coupon', status: 'completed', expiresAt: MoreThan(new Date()) },
        order: { createdAt: 'DESC' },
      }),
    ]);
    const level = levelFor(earned);
    const done = new Set(badgeRows.map((row) => row.sourceKey.replace(/^badge:/, '')));

    return {
      balance,
      value: balance * POINT_VALUE,
      pointValue: POINT_VALUE,
      earned,
      level: { name: level.name, index: level.index, multiplier: level.multiplier, min: level.min },
      next: level.next,
      rewards: POINT_REWARDS,
      operators: Object.entries(RECHARGE_OPERATORS).map(([code, name]) => ({ code, name })),
      badges: POINT_BADGES.map((badge: Badge) => ({ ...badge, done: done.has(badge.id) })),
      coupons: coupons.map((c) => ({
        id: c.id,
        code: c.couponCode,
        title: POINT_REWARDS.find((r) => r.id === c.rewardId)?.title ?? c.rewardId,
        text: POINT_REWARDS.find((r) => r.id === c.rewardId)?.text ?? '',
        expiresAt: c.expiresAt,
      })),
      history: history.map((h) => ({ id: h.id, points: h.points, kind: h.kind, title: h.title, detail: h.detail, createdAt: h.createdAt })),
    };
  }

  // =====================================================
  // CANJEAR (POST /rewards/redeem)
  // =====================================================

  /**
   * 1. Reserva los puntos (asiento negativo) con un candado por cliente.
   * 2. Entrega el premio: plata (ledger), recarga (payment-service) o bono.
   * 3. Si la entrega falla de forma definitiva, devuelve los puntos (asiento de
   *    compensación) y el canje queda "failed": no se descuenta nada.
   * La clave de idempotencia hace que un doble clic sea el mismo canje.
   */
  async redeem(idUser: string, token: string, rewardId: string, idempotencyKey: string, operatorCode?: string) {
    const reward = POINT_REWARDS.find((r) => r.id === rewardId);
    if (!reward) throw new NotFoundException('Ese premio no está en el catálogo.');
    if (reward.kind === 'recharge' && !RECHARGE_OPERATORS[operatorCode ?? '']) {
      throw new BadRequestException('Elige el operador de tu celular.');
    }

    let redemption = await this.redemptions.findOne({ where: { idempotencyKey } });
    if (redemption) {
      if (redemption.idUser !== idUser || redemption.rewardId !== rewardId) {
        throw new ConflictException('La clave de idempotencia ya se usó para otro canje.');
      }
      if (redemption.status === 'completed') return this.publicRedemption(redemption);
      if (redemption.status === 'failed') throw new ConflictException(redemption.failureReason || 'Ese canje no se pudo completar.');
      // pending: se reintenta la entrega (las llamadas son idempotentes).
    } else {
      // Datos que se validan antes de reservar puntos.
      const phone = reward.kind === 'recharge' ? await this.clients.verifiedPhone(idUser, token) : null;
      if (reward.kind === 'recharge' && !phone) {
        throw new BadRequestException('Necesitas un celular verificado en Banklite para canjear recargas.');
      }
      redemption = await this.reserve(idUser, reward.id, reward.kind, reward.points, idempotencyKey, operatorCode ?? null, phone);
    }

    return this.deliver(redemption, token);
  }

  private async reserve(
    idUser: string, rewardId: string, kind: Redemption['kind'], points: number,
    idempotencyKey: string, operatorCode: string | null, phone: string | null,
  ): Promise<Redemption> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        // Candado por cliente: dos canjes a la vez no pueden gastar los mismos puntos.
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [idUser]);
        const balance = await this.balanceOf(idUser, manager);
        if (balance < points) {
          throw new BadRequestException(`No tienes puntos suficientes: te faltan ${(points - balance).toLocaleString('es-CO')}.`);
        }
        const redemption = await manager.save(manager.create(Redemption, {
          idUser, rewardId, kind, points, idempotencyKey, status: 'pending', operatorCode, phone,
          couponCode: null, expiresAt: null, ledgerTransactionId: null, failureReason: null,
        }));
        const reward = POINT_REWARDS.find((r) => r.id === rewardId);
        await manager.save(manager.create(PointsEntry, {
          idUser, points: -points, kind: 'redeem', title: 'Canje', detail: reward?.title ?? rewardId, sourceKey: `redeem:${redemption.id}`,
        }));
        return redemption;
      });
    } catch (error) {
      // Doble clic simultáneo con la misma clave: la otra petición ya lo creó.
      if ((error as any)?.code === '23505') {
        const raced = await this.redemptions.findOne({ where: { idempotencyKey } });
        if (raced) return raced;
      }
      throw error;
    }
  }

  private async deliver(redemption: Redemption, token: string) {
    const reward = POINT_REWARDS.find((r) => r.id === redemption.rewardId);
    try {
      if (redemption.kind === 'cash') {
        const account = await this.clients.receivingAccount(token);
        if (!account) throw new DeliveryError('Necesitas una cuenta Banklite activa para recibir la plata.', true);
        const transaction = await this.clients.creditCash({
          accountId: account.id,
          idUser: redemption.idUser,
          amount: reward.value,
          // La misma clave del canje: si se reintenta, el ledger devuelve el mismo abono.
          idempotencyKey: redemption.id,
          description: `Canje de Puntos Banklite · ${reward.title}`,
        });
        redemption.ledgerTransactionId = transaction.id ?? null;
      } else if (redemption.kind === 'recharge') {
        const result = await this.clients.rewardTopup({
          idUser: redemption.idUser,
          operatorCode: redemption.operatorCode,
          phone: redemption.phone,
          amount: reward.value,
          idempotencyKey: redemption.id,
        });
        redemption.ledgerTransactionId = result.ledgerTransactionId ?? null;
      } else {
        redemption.couponCode = redemption.couponCode ?? couponCode();
        redemption.expiresAt = new Date(Date.now() + COUPON_DAYS * 86_400_000);
      }
      redemption.status = 'completed';
      await this.redemptions.save(redemption);
      return this.publicRedemption(redemption);
    } catch (error) {
      if (error instanceof DeliveryError && error.definitive) {
        await this.refund(redemption, error.message);
        throw new BadRequestException(`${error.message} No se descontaron puntos.`);
      }
      if (error instanceof DeliveryError) {
        // Incierto: queda pendiente (puntos reservados) y se reintenta después.
        this.logger.warn(`Canje ${redemption.id} pendiente: ${error.message}`);
        throw new ServiceUnavailableException('Estamos confirmando tu canje. Revisa en unos segundos; si no se completa, te devolvemos los puntos.');
      }
      if (error instanceof HttpException) throw error;
      throw error;
    }
  }

  /** Compensación: devuelve los puntos reservados y marca el canje como fallido. */
  private async refund(redemption: Redemption, reason: string) {
    await this.dataSource.transaction(async (manager) => {
      const claimed = await manager.update(Redemption, { id: redemption.id, status: 'pending' }, { status: 'failed', failureReason: reason.slice(0, 200) });
      if (!claimed.affected) return; // ya se resolvió por otra vía
      await manager.save(manager.create(PointsEntry, {
        idUser: redemption.idUser, points: redemption.points, kind: 'refund', title: 'Devolución de canje',
        detail: reason.slice(0, 160), sourceKey: `refund:${redemption.id}`,
      }));
    });
    redemption.status = 'failed';
  }

  private async resumeStale(idUser: string, token: string) {
    const stale = await this.redemptions.find({
      where: { idUser, status: 'pending', updatedAt: LessThan(new Date(Date.now() - STALE_PENDING_MS)) },
    });
    for (const redemption of stale) {
      await this.deliver(redemption, token).catch(() => undefined);
    }
  }

  // =====================================================
  // AUXILIARES
  // =====================================================

  private async awardBadge(idUser: string, id: string) {
    const badge = POINT_BADGES.find((b) => b.id === id);
    if (!badge || badge.soon) return;
    await this.addEntry(idUser, badge.points, 'badge', `Reto: ${badge.title}`, badge.text, `badge:${id}`);
  }

  private hasBadge(idUser: string, id: string) {
    return this.entries.exist({ where: { idUser, sourceKey: `badge:${id}` } });
  }

  /** Inserta un asiento; si su sourceKey ya existe (reentrega), no hace nada. */
  private async addEntry(idUser: string, points: number, kind: PointsKind, title: string, detail: string, sourceKey: string) {
    if (!points) return;
    await this.entries.createQueryBuilder()
      .insert()
      .into(PointsEntry)
      .values({ idUser, points, kind, title, detail, sourceKey })
      .orIgnore()
      .execute();
  }

  private async balanceOf(idUser: string, manager?: EntityManager): Promise<number> {
    const repo = manager ? manager.getRepository(PointsEntry) : this.entries;
    const row = await repo.createQueryBuilder('e').select('COALESCE(SUM(e.points), 0)', 'total').where('e.id_user = :idUser', { idUser }).getRawOne();
    return Number(row?.total ?? 0);
  }

  // El nivel depende de lo ganado (compras y retos): canjear no te baja de nivel.
  private async earnedOf(idUser: string): Promise<number> {
    const row = await this.entries.createQueryBuilder('e')
      .select('COALESCE(SUM(e.points), 0)', 'total')
      .where('e.id_user = :idUser', { idUser })
      .andWhere("e.kind IN ('earn', 'badge', 'reversal')")
      .getRawOne();
    return Math.max(0, Number(row?.total ?? 0));
  }

  private publicRedemption(r: Redemption) {
    const reward = POINT_REWARDS.find((x) => x.id === r.rewardId);
    return {
      id: r.id,
      rewardId: r.rewardId,
      title: reward?.title ?? r.rewardId,
      kind: r.kind,
      points: r.points,
      value: reward?.value ?? null,
      status: r.status,
      couponCode: r.couponCode,
      expiresAt: r.expiresAt,
      operator: r.operatorCode ? RECHARGE_OPERATORS[r.operatorCode] : null,
      phone: r.phone,
      ledgerTransactionId: r.ledgerTransactionId,
      createdAt: r.createdAt,
    };
  }
}

function couponCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = () => Array.from({ length: 4 }, () => chars[randomInt(chars.length)]).join('');
  return `BL-${part()}-${part()}`;
}
