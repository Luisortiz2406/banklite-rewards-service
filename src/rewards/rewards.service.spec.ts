import { randomUUID } from 'crypto';
import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { createTestDatabase, describeWithDb, truncateAll } from '../testing/test-database';
import { POINT_BADGES } from './catalog';
import { PointsEntry } from './entities/points-entry.entity';
import { Redemption } from './entities/redemption.entity';
import { DeliveryError, RewardsClientsService } from './rewards-clients.service';
import { RewardsService, TransactionEvent } from './rewards.service';

/**
 * Puntos Banklite contra PostgreSQL real: el "no contar dos veces el mismo
 * evento" lo garantiza la clave única de source_key, y la reserva de puntos un
 * candado por cliente; las dos cosas solo existen en la base.
 */
const ANA = '11111111-1111-4111-8111-111111111111';

describeWithDb('RewardsService (PostgreSQL)', () => {
  let dataSource: DataSource;
  let drop: () => Promise<void>;
  let entries: Repository<PointsEntry>;
  let rewards: RewardsService;

  const clients = {
    receivingAccount: jest.fn(async () => ({ id: randomUUID(), accountNumber: '10000000001', status: 'active' })),
    creditCash: jest.fn(async () => ({ id: randomUUID() })),
    verifiedPhone: jest.fn(async () => '3001234567'),
    rewardTopup: jest.fn(async () => ({ ledgerTransactionId: randomUUID() })),
    hasBrebKey: jest.fn(async () => false),
  };

  beforeAll(async () => {
    ({ dataSource, drop } = await createTestDatabase('rewards', [PointsEntry, Redemption]));
    entries = dataSource.getRepository(PointsEntry);
    rewards = new RewardsService(
      dataSource,
      entries,
      dataSource.getRepository(Redemption),
      clients as unknown as RewardsClientsService,
    );
  });

  afterAll(() => drop?.());

  beforeEach(async () => {
    await truncateAll(dataSource);
    jest.clearAllMocks();
  });

  const payment = (amount: number, transactionId = randomUUID()): TransactionEvent => ({
    idUser: ANA,
    direction: 'out',
    transactionId,
    type: 'payment',
    amount,
    description: 'Acueducto de Bogotá · Ref. 12345678',
  });
  const earned = async () =>
    Number(
      (
        await entries
          .createQueryBuilder('e')
          .select('COALESCE(SUM(e.points), 0)', 'total')
          .where("e.kind = 'earn'")
          .getRawOne()
      ).total,
    );
  const balance = async () =>
    Number((await entries.createQueryBuilder('e').select('COALESCE(SUM(e.points), 0)', 'total').getRawOne()).total);
  const givePoints = (points: number) =>
    entries.save(
      entries.create({
        idUser: ANA,
        points,
        kind: 'earn',
        title: 'Saldo inicial',
        detail: '',
        sourceKey: randomUUID(),
      }),
    );

  describe('acumulación', () => {
    it('1 punto por cada $1.000 de un pago', async () => {
      await rewards.handleTransaction(payment(85_500));
      expect(await earned()).toBe(85);
    });

    it('el mismo evento entregado dos veces suma una sola vez', async () => {
      const event = payment(85_000);
      await rewards.handleTransaction(event);
      await rewards.handleTransaction(event);
      expect(await earned()).toBe(85);
    });

    it('el mismo evento procesado en paralelo (varias réplicas) suma una sola vez', async () => {
      const event = payment(85_000);
      await Promise.all(Array.from({ length: 6 }, () => rewards.handleTransaction(event)));
      expect(await earned()).toBe(85);
      expect(await entries.countBy({ kind: 'earn' })).toBe(1);
    });

    it('los retos también se otorgan una sola vez', async () => {
      await rewards.handleTransaction(payment(10_000));
      await rewards.handleTransaction(payment(10_000));
      expect(await entries.countBy({ kind: 'badge', sourceKey: 'badge:first-bill' })).toBe(1);
    });

    it('las transferencias, los abonos y el dinero que entra no suman', async () => {
      await rewards.handleTransaction({ ...payment(100_000), type: 'transfer', description: 'Arriendo' });
      await rewards.handleTransaction({ ...payment(100_000), type: 'credit', description: 'Abono' });
      await rewards.handleTransaction({ ...payment(100_000), direction: 'in' });
      expect(await earned()).toBe(0);
    });

    it('el nivel multiplica los puntos (Plata ×1,25)', async () => {
      await givePoints(1_500);
      await rewards.handleTransaction(payment(100_000));
      expect(await earned()).toBe(1_500 + 125);
    });

    it('el reverso de un pago quita sus puntos una sola vez', async () => {
      const original = payment(85_000);
      await rewards.handleTransaction(original);
      const reversal: TransactionEvent = {
        ...payment(85_000),
        type: 'reversal',
        direction: 'in',
        reversedTransactionId: original.transactionId,
      };
      await rewards.handleTransaction(reversal);
      await rewards.handleTransaction({ ...reversal, transactionId: randomUUID() });
      expect(await entries.countBy({ kind: 'reversal' })).toBe(1);
      const firstBill = POINT_BADGES.find((b) => b.id === 'first-bill')!.points;
      expect(await balance()).toBe(85 + firstBill - 85); // el reto "first-bill" se conserva
    });
  });

  describe('canjes', () => {
    const redeem = (rewardId = 'cash5', idempotencyKey = randomUUID(), operatorCode?: string) =>
      rewards.redeem(ANA, 'token', rewardId, idempotencyKey, operatorCode);

    it('no se canjea con puntos insuficientes y no queda nada reservado', async () => {
      await givePoints(499);
      await expect(redeem('cash5')).rejects.toBeInstanceOf(BadRequestException);
      expect(await balance()).toBe(499);
      expect(clients.creditCash).not.toHaveBeenCalled();
    });

    it('un canje descuenta los puntos y entrega con la clave del canje', async () => {
      await givePoints(600);
      const result = await redeem('cash5');
      expect(result).toMatchObject({ status: 'completed' });
      expect(await balance()).toBe(100);
      expect(clients.creditCash).toHaveBeenCalledWith(expect.objectContaining({ amount: 5_000 }));
    });

    it('dos canjes simultáneos no gastan los mismos puntos', async () => {
      await givePoints(700);
      const results = await Promise.allSettled([redeem('cash5'), redeem('cash5'), redeem('cash5')]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await balance()).toBe(200);
      expect(clients.creditCash).toHaveBeenCalledTimes(1);
    });

    it('un doble clic (misma clave) es el mismo canje', async () => {
      await givePoints(1_000);
      const key = randomUUID();
      await redeem('cash5', key);
      await redeem('cash5', key);
      expect(await balance()).toBe(500);
      expect(clients.creditCash).toHaveBeenCalledTimes(1);
    });

    it('si la entrega se rechaza (definitivo), devuelve los puntos una sola vez', async () => {
      await givePoints(1_000);
      clients.creditCash.mockRejectedValueOnce(new DeliveryError('La cuenta no está activa.', true));
      const key = randomUUID();
      await expect(redeem('cash5', key)).rejects.toBeInstanceOf(BadRequestException);
      expect(await balance()).toBe(1_000);
      // Reintentar un canje fallido no vuelve a entregar ni a devolver puntos.
      await expect(redeem('cash5', key)).rejects.toBeInstanceOf(ConflictException);
      expect(await balance()).toBe(1_000);
      expect(await entries.countBy({ kind: 'refund' })).toBe(1);
    });

    it('si la entrega es incierta, los puntos quedan reservados y el reintento la completa con la misma clave', async () => {
      await givePoints(1_000);
      clients.rewardTopup.mockRejectedValueOnce(new DeliveryError('Payment no responde.', false));
      const key = randomUUID();
      await expect(redeem('recharge10', key, 'rec-claro')).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(await balance()).toBe(0); // reservados, no devueltos

      await expect(redeem('recharge10', key, 'rec-claro')).resolves.toMatchObject({ status: 'completed' });
      expect(await balance()).toBe(0);
      const keys = clients.rewardTopup.mock.calls.map(
        (call: unknown[]) => (call[0] as { idempotencyKey: string }).idempotencyKey,
      );
      expect(keys).toHaveLength(2);
      expect(new Set(keys).size).toBe(1);
    });
  });
});
