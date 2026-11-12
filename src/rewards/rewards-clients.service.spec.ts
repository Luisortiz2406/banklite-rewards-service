import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { rewardsCatalog } from './catalog';
import { DeliveryError, RewardsClientsService } from './rewards-clients.service';
import { RewardsCatalogController } from './rewards-catalog.controller';
import { RewardsController } from './rewards.controller';
import { RewardsService } from './rewards.service';

/**
 * Entrega de canjes (ledger y payment-service, fetch simulado). Regla: un 4xx es un rechazo
 * definitivo y se devuelven los puntos; un 5xx, la falta de respuesta o el 401 de la clave
 * interna son inciertos: el canje queda pendiente y se reintenta con la MISMA clave.
 */
const KEY = 'clave-interna-de-rewards-para-pruebas-0123';
const reply = (status: number, body: unknown = {}) =>
  Promise.resolve({ status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response);

describe('RewardsClientsService', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  const build = (env: Record<string, string> = {}) =>
    new RewardsClientsService(new ConfigService({ INTERNAL_API_KEY: KEY, ...env }));
  const failure = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error as DeliveryError;
    }
    throw new Error('no lanzó excepción');
  };
  const cash = { accountId: 'a1', idUser: 'u1', amount: 5_000, idempotencyKey: 'k1', description: 'Canje' };
  const topup = { idUser: 'u1', operatorCode: 'rec-claro', phone: '3001234567', amount: 10_000, idempotencyKey: 'k2' };

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as never;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  describe('lecturas con el token del cliente (tolerantes)', () => {
    it('la cuenta que recibe es la primera activa de persona', async () => {
      fetchMock.mockReturnValue(
        reply(200, [
          { id: 'm', accountNumber: '1', accountType: 'merchant', status: 'active' },
          { id: 'x', accountNumber: '2', accountType: 'savings', status: 'blocked' },
          { id: 'a', accountNumber: '3', accountType: 'savings', status: 'active' },
        ]),
      );

      expect(
        await build({ ACCOUNT_SERVICE_URL: 'http://account.interno:3002/' }).receivingAccount('tok'),
      ).toMatchObject({
        id: 'a',
      });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://account.interno:3002/accounts');
      expect(init.headers.Authorization).toBe('Bearer tok');
    });

    it('si el otro servicio falla o no responde, devuelven valores neutros en vez de romper', async () => {
      fetchMock.mockReturnValue(reply(503));
      expect(await build().receivingAccount('tok')).toBeNull();
      expect(await build().verifiedPhone('u1', 'tok')).toBeNull();
      expect(await build().hasBrebKey('tok')).toBe(false);
      expect(await build().savingsMilestones('tok')).toEqual({ hasPocket: false, hasCdt: false });
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      expect(await build().receivingAccount('tok')).toBeNull();
    });

    it('el celular verificado sale de KYC a 10 dígitos y solo vale si empieza por 3', async () => {
      fetchMock.mockReturnValueOnce(reply(200, { telefono: '+57 300 123 4567' }));
      expect(await build().verifiedPhone('u1', 'tok')).toBe('3001234567');
      expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3003/kyc/u1');

      fetchMock.mockReturnValueOnce(reply(200, { telefono: '2001234567' }));
      expect(await build().verifiedPhone('u1', 'tok')).toBeNull();
      fetchMock.mockReturnValueOnce(reply(200, {}));
      expect(await build().verifiedPhone('u1', 'tok')).toBeNull();
    });

    it('los hitos del reto: llave registrada y hitos de ahorro', async () => {
      fetchMock.mockReturnValueOnce(reply(200, { keys: [{ key: '@ana' }] }));
      expect(await build().hasBrebKey('tok')).toBe(true);
      fetchMock.mockReturnValueOnce(reply(200, { keys: [] }));
      expect(await build().hasBrebKey('tok')).toBe(false);
      fetchMock.mockReturnValueOnce(reply(200, { milestones: { hasPocket: true, hasCdt: false } }));
      expect(await build().savingsMilestones('tok')).toEqual({ hasPocket: true, hasCdt: false });
    });
  });

  describe('entrega del canje', () => {
    it('la plata a la cuenta sale de "Recompensas" en el ledger, con la clave interna y la de idempotencia', async () => {
      fetchMock.mockReturnValue(reply(201, { id: 'tx-1' }));

      expect(await build({ LEDGER_SERVICE_URL: 'http://ledger.interno:3006/' }).creditCash(cash)).toEqual({
        id: 'tx-1',
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://ledger.interno:3006/ledger/internal/rewards');
      expect(init.headers['x-internal-key']).toBe(KEY);
      expect(JSON.parse(init.body)).toEqual({
        target: 'account',
        accountId: 'a1',
        beneficiaryUserId: 'u1',
        amount: 5_000,
        idempotencyKey: 'k1',
        description: 'Canje',
      });
    });

    it('la recarga la paga el banco al operador por payment-service', async () => {
      fetchMock.mockReturnValue(reply(200, { ledgerTransactionId: 'tx-2' }));

      expect(await build().rewardTopup(topup)).toEqual({ ledgerTransactionId: 'tx-2' });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://localhost:3011/internal/payments/reward-topups');
      expect(JSON.parse(init.body)).toEqual({
        beneficiaryUserId: 'u1',
        billerCode: 'rec-claro',
        phone: '3001234567',
        amount: 10_000,
        idempotencyKey: 'k2',
      });
    });

    it('un 4xx es un rechazo definitivo (se devuelven los puntos), con el motivo recortado a 200 caracteres', async () => {
      for (const status of [400, 403, 409]) {
        fetchMock.mockReturnValueOnce(reply(status, { message: 'La cuenta destino no es del cliente.' }));
        expect(await failure(build().creditCash(cash))).toMatchObject({
          definitive: true,
          message: 'La cuenta destino no es del cliente.',
        });
      }
      fetchMock.mockReturnValueOnce(reply(400, {}));
      expect((await failure(build().creditCash(cash))).message).toBe('No se pudo completar el canje.');
      fetchMock.mockReturnValueOnce(reply(400, { message: 'x'.repeat(500) }));
      expect((await failure(build().creditCash(cash))).message).toHaveLength(200);
    });

    it('un 5xx, un 401 (clave interna) o la falta de respuesta son inciertos: el canje se reintenta con la misma clave', async () => {
      for (const status of [500, 503, 401]) {
        fetchMock.mockReturnValueOnce(reply(status, { message: 'x' }));
        expect(await failure(build().creditCash(cash))).toMatchObject({ definitive: false });
      }
      fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
      expect(await failure(build().rewardTopup(topup))).toMatchObject({ definitive: false });
    });

    it('la entrega no se reintenta sola, y sin INTERNAL_API_KEY no sale la llamada', async () => {
      fetchMock.mockReturnValue(reply(503));
      await failure(build().creditCash(cash));
      expect(fetchMock).toHaveBeenCalledTimes(1);

      fetchMock.mockClear();
      const error = await failure(new RewardsClientsService(new ConfigService({})).creditCash(cash));
      expect(error).toMatchObject({ definitive: false });
      expect(error.message).toContain('INTERNAL_API_KEY');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

describe('Controladores de rewards', () => {
  const guardsOf = (target: object) => Reflect.getMetadata('__guards__', target) ?? [];
  const request = { user: { idUser: 'u1' }, accessToken: 'tok-1' } as never;
  const service = { summary: jest.fn().mockResolvedValue({}), redeem: jest.fn().mockResolvedValue({}) };
  const controller = new RewardsController(service as unknown as RewardsService);

  it('exige sesión y usa siempre al cliente de la sesión y su token', async () => {
    expect(guardsOf(RewardsController)).toContain(JwtAuthGuard);

    await controller.summary(request);
    expect(service.summary).toHaveBeenCalledWith('u1', 'tok-1');
    await controller.redeem(
      { rewardId: 'recarga10', idempotencyKey: '33333333-3333-4333-8333-333333333333', operatorCode: 'rec-claro' },
      request,
    );
    expect(service.redeem).toHaveBeenCalledWith(
      'u1',
      'tok-1',
      'recarga10',
      '33333333-3333-4333-8333-333333333333',
      'rec-claro',
    );
  });

  it('el catálogo de puntos es público', () => {
    expect(guardsOf(RewardsCatalogController)).toEqual([]);
    expect(new RewardsCatalogController().catalog()).toEqual(rewardsCatalog());
  });
});
