import * as amqplib from 'amqplib';
import { ConfigService } from '@nestjs/config';
import { RewardsService } from '../rewards/rewards.service';
import { EventConsumerService } from './event-consumer.service';

jest.mock('amqplib', () => ({ connect: jest.fn() }));

/**
 * Consumidor de transaction.completed (RabbitMQ simulado): cada pago suma puntos una sola vez; lo que no se pueda
 * procesar va a reintento o a la DLQ y nunca se pierde ni bloquea la cola.
 */
const QUEUE = 'rewards-service.transaction-completed';
const ANA = '11111111-1111-4111-8111-111111111111';
const TX = '33333333-3333-4333-8333-333333333333';

function fakeBroker() {
  const handlers: {
    connection: Record<string, (...args: any[]) => void>;
    channel: Record<string, (...args: any[]) => void>;
  } = {
    connection: {},
    channel: {},
  };
  const channel = {
    on: jest.fn((event: string, handler: (...args: any[]) => void) => (handlers.channel[event] = handler)),
    assertExchange: jest.fn().mockResolvedValue(undefined),
    assertQueue: jest.fn().mockResolvedValue(undefined),
    bindQueue: jest.fn().mockResolvedValue(undefined),
    consume: jest.fn().mockResolvedValue(undefined),
    sendToQueue: jest.fn(),
    ack: jest.fn(),
    nack: jest.fn(),
    checkQueue: jest.fn().mockResolvedValue({ messageCount: 0, consumerCount: 1 }),
    get: jest.fn().mockResolvedValue(false),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const connection = {
    on: jest.fn((event: string, handler: (...args: any[]) => void) => (handlers.connection[event] = handler)),
    createChannel: jest.fn().mockResolvedValue(channel),
    close: jest.fn().mockResolvedValue(undefined),
  };
  return { channel, connection, handlers };
}
const delivery = (body: unknown) =>
  ({
    content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
    fields: { routingKey: 'transaction.completed' },
    properties: { headers: {}, contentType: 'application/json', messageId: 'm1' },
  }) as unknown as amqplib.ConsumeMessage;
const event = { idUser: ANA, transactionId: TX, direction: 'out', amount: 50_000 };

describe('EventConsumerService de rewards', () => {
  const connect = amqplib.connect as unknown as jest.Mock;
  let broker: ReturnType<typeof fakeBroker>;
  let rewards: { handleTransaction: jest.Mock };

  const build = (env: Record<string, string> = { RABBITMQ_URL: 'amqp://rabbit' }) =>
    new EventConsumerService(new ConfigService(env), rewards as unknown as RewardsService);
  const started = async (service = build()) => {
    await service.onModuleInit();
    const onMessage = broker.channel.consume.mock.calls[0][1] as (msg: amqplib.ConsumeMessage | null) => Promise<void>;
    return { service, onMessage };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    broker = fakeBroker();
    connect.mockResolvedValue(broker.connection);
    rewards = { handleTransaction: jest.fn().mockResolvedValue(undefined) };
  });
  afterEach(() => jest.useRealTimers());

  describe('conexión', () => {
    it('sin RABBITMQ_URL no intenta conectar (modo degradado)', async () => {
      await build({}).onModuleInit();
      expect(connect).not.toHaveBeenCalled();
    });

    it('declara el exchange y la cola y se suscribe solo a transaction.completed, con su cola de reintentos y DLQ', async () => {
      await started();

      expect(broker.channel.assertExchange).toHaveBeenCalledWith('banklite.events', 'topic', { durable: true });
      expect(broker.channel.assertQueue).toHaveBeenCalledWith(QUEUE, { durable: true });
      expect(broker.channel.bindQueue).toHaveBeenCalledTimes(1);
      expect(broker.channel.bindQueue).toHaveBeenCalledWith(QUEUE, 'banklite.events', 'transaction.completed');
      expect(broker.channel.assertQueue).toHaveBeenCalledWith(`${QUEUE}.retry`, expect.any(Object));
      expect(broker.channel.assertQueue).toHaveBeenCalledWith(`${QUEUE}.dlq`, { durable: true });
    });

    it('si RabbitMQ no está disponible reintenta a los 5 s; si se cae después, vuelve a conectar', async () => {
      jest.useFakeTimers();
      connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const service = build();

      await service.onModuleInit();
      await jest.advanceTimersByTimeAsync(5_000);
      expect(connect).toHaveBeenCalledTimes(2);

      broker.handlers.connection.close();
      await jest.advanceTimersByTimeAsync(5_000);
      expect(connect).toHaveBeenCalledTimes(3);
    });

    it('cerrar el módulo cierra canal y conexión y cancela el reintento pendiente', async () => {
      jest.useFakeTimers();
      const { service } = await started();
      await service.onModuleDestroy();
      expect(broker.channel.close).toHaveBeenCalled();
      expect(broker.connection.close).toHaveBeenCalled();

      const second = await started(build());
      broker.handlers.connection.close();
      await second.service.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(20_000);
      expect(connect).toHaveBeenCalledTimes(2);
    });

    it('los errores de la conexión y del canal solo se registran', async () => {
      await started();

      expect(() => broker.handlers.connection.error(new Error('conexión'))).not.toThrow();
      expect(() => broker.handlers.channel.error(new Error('canal'))).not.toThrow();
      broker.handlers.channel.close();
      expect(broker.connection.close).toHaveBeenCalled();
    });
  });

  describe('mensajes', () => {
    it('un movimiento suma sus puntos y se confirma', async () => {
      const { onMessage } = await started();
      const msg = delivery({ event: 'transaction.completed', data: event });

      await onMessage(msg);

      expect(rewards.handleTransaction).toHaveBeenCalledWith(event);
      expect(broker.channel.ack).toHaveBeenCalledWith(msg);
    });

    it('el mismo movimiento llega una vez por titular (emisor y receptor): ambos se procesan', async () => {
      const { onMessage } = await started();

      await onMessage(delivery({ data: { ...event, direction: 'out' } }));
      await onMessage(
        delivery({ data: { ...event, idUser: '22222222-2222-4222-8222-222222222222', direction: 'in' } }),
      );

      expect(rewards.handleTransaction).toHaveBeenCalledTimes(2);
    });

    it('sin idUser o sin transactionId se descarta (se confirma para no bloquear la cola)', async () => {
      const { onMessage } = await started();

      for (const data of [{ transactionId: TX }, { idUser: ANA }, undefined]) {
        const msg = delivery({ data });
        await onMessage(msg);
        expect(broker.channel.ack).toHaveBeenLastCalledWith(msg);
      }

      expect(rewards.handleTransaction).not.toHaveBeenCalled();
      expect(broker.channel.sendToQueue).not.toHaveBeenCalled();
    });

    it('un mensaje que no es JSON va directo a la DLQ', async () => {
      const { onMessage } = await started();

      await onMessage(delivery('esto no es json'));

      expect(broker.channel.sendToQueue.mock.calls[0][0]).toBe(`${QUEUE}.dlq`);
      expect(rewards.handleTransaction).not.toHaveBeenCalled();
    });

    it('si sumar los puntos falla, va a la cola de espera para reintentarlo (el pago no queda sin puntos)', async () => {
      const { onMessage } = await started();
      rewards.handleTransaction.mockRejectedValueOnce(new Error('base caída'));
      const msg = delivery({ data: event });

      await onMessage(msg);

      expect(broker.channel.sendToQueue.mock.calls[0][0]).toBe(`${QUEUE}.retry`);
      expect(broker.channel.ack).toHaveBeenCalledWith(msg);
    });

    it('la entrega nula al cancelar el consumo se ignora', async () => {
      const { onMessage } = await started();
      await onMessage(null);
      expect(rewards.handleTransaction).not.toHaveBeenCalled();
    });
  });
});
