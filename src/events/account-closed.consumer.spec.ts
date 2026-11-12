import * as amqplib from 'amqplib';
import { ConfigService } from '@nestjs/config';
import { RewardsService } from '../rewards/rewards.service';
import { AccountClosedConsumer } from './account-closed.consumer';

jest.mock('amqplib', () => ({ connect: jest.fn() }));

/**
 * Consumidor de account.closed (RabbitMQ simulado): al cancelarse la cuenta, los puntos
 * del cliente se pierden con su asiento. Lo que falle va a reintento o a la DLQ;
 * procesarlo dos veces es inofensivo.
 */
const QUEUE = 'rewards-service.account-closed';
const ANA = '11111111-1111-4111-8111-111111111111';

function fakeBroker() {
  const handlers: {
    connection: Record<string, (...args: any[]) => void>;
    channel: Record<string, (...args: any[]) => void>;
  } = { connection: {}, channel: {} };
  const channel = {
    on: jest.fn((event: string, handler: (...args: any[]) => void) => (handlers.channel[event] = handler)),
    assertExchange: jest.fn().mockResolvedValue(undefined),
    assertQueue: jest.fn().mockResolvedValue(undefined),
    bindQueue: jest.fn().mockResolvedValue(undefined),
    consume: jest.fn().mockResolvedValue(undefined),
    sendToQueue: jest.fn(),
    ack: jest.fn(),
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
    fields: { routingKey: 'account.closed' },
    properties: { headers: {}, contentType: 'application/json', messageId: 'm1' },
  }) as unknown as amqplib.ConsumeMessage;

describe('AccountClosedConsumer de rewards', () => {
  const connect = amqplib.connect as unknown as jest.Mock;
  let broker: ReturnType<typeof fakeBroker>;
  const rewards = { handleAccountClosed: jest.fn() };

  const started = async (env: Record<string, string> = { RABBITMQ_URL: 'amqp://rabbit' }) => {
    const consumer = new AccountClosedConsumer(new ConfigService(env), rewards as unknown as RewardsService);
    await consumer.onModuleInit();
    const onMessage = broker.channel.consume.mock.calls[0]?.[1] as
      ((msg: amqplib.ConsumeMessage | null) => Promise<void>) | undefined;
    return { consumer, onMessage: onMessage! };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    broker = fakeBroker();
    connect.mockResolvedValue(broker.connection);
    rewards.handleAccountClosed.mockResolvedValue(undefined);
  });
  afterEach(() => jest.useRealTimers());

  it('sin RABBITMQ_URL no conecta; con ella se suscribe solo a account.closed, con su cola de reintentos y DLQ', async () => {
    await started({});
    expect(connect).not.toHaveBeenCalled();

    await started();
    expect(broker.channel.bindQueue).toHaveBeenCalledTimes(1);
    expect(broker.channel.bindQueue).toHaveBeenCalledWith(QUEUE, 'banklite.events', 'account.closed');
    expect(broker.channel.assertQueue).toHaveBeenCalledWith(`${QUEUE}.dlq`, { durable: true });
  });

  it('al cancelarse la cuenta, los puntos se pierden con la fecha del cierre y se confirma el mensaje', async () => {
    const { onMessage } = await started();
    const msg = delivery({ event: 'account.closed', data: { idUser: ANA, cerradaEn: '2026-11-11T15:00:00.000Z' } });

    await onMessage(msg);

    expect(rewards.handleAccountClosed).toHaveBeenCalledWith({ idUser: ANA, cerradaEn: '2026-11-11T15:00:00.000Z' });
    expect(broker.channel.ack).toHaveBeenCalledWith(msg);
  });

  it('sin un idUser válido se descarta (se confirma para no bloquear la cola) y no toca ningún punto', async () => {
    const { onMessage } = await started();

    for (const data of [{}, { idUser: 'abc' }, { idUser: 7 }, undefined]) {
      const msg = delivery({ data });
      await onMessage(msg);
      expect(broker.channel.ack).toHaveBeenLastCalledWith(msg);
    }

    expect(rewards.handleAccountClosed).not.toHaveBeenCalled();
    expect(broker.channel.sendToQueue).not.toHaveBeenCalled();
  });

  it('un mensaje que no es JSON va a la DLQ; si la base falla, a la cola de espera para reintentar', async () => {
    const { onMessage } = await started();

    await onMessage(delivery('esto no es json'));
    expect(broker.channel.sendToQueue.mock.calls[0][0]).toBe(`${QUEUE}.dlq`);

    rewards.handleAccountClosed.mockRejectedValueOnce(new Error('base caída'));
    await onMessage(delivery({ data: { idUser: ANA, cerradaEn: '2026-11-11T15:00:00.000Z' } }));
    expect(broker.channel.sendToQueue.mock.calls[1][0]).toBe(`${QUEUE}.retry`);

    await onMessage(null);
  });

  it('reconecta a los 5 s si RabbitMQ no está o se cae, y cerrar el módulo cancela el reintento', async () => {
    jest.useFakeTimers();
    connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const consumer = new AccountClosedConsumer(
      new ConfigService({ RABBITMQ_URL: 'amqp://rabbit' }),
      rewards as unknown as RewardsService,
    );
    await consumer.onModuleInit();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(connect).toHaveBeenCalledTimes(2);

    broker.handlers.connection.close();
    await consumer.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(20_000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(() => broker.handlers.connection.error(new Error('x'))).not.toThrow();
    expect(() => broker.handlers.channel.error(new Error('x'))).not.toThrow();
  });
});
