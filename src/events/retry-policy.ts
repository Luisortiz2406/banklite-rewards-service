import type { Logger } from '@nestjs/common';
import type * as amqplib from 'amqplib';

const MAX_RETRIES = Number(process.env.EVENT_MAX_RETRIES ?? 5);
const RETRY_DELAY_MS = Number(process.env.EVENT_RETRY_DELAY_MS ?? 10_000);

const RETRY_COUNT_HEADER = 'x-retry-count';
const ORIGINAL_KEY_HEADER = 'x-original-routing-key';

/** Mensaje que nunca se podrá procesar (p. ej. JSON corrupto): va directo a la DLQ. */
export class PoisonMessageError extends Error {}

/**
 * Colas auxiliares de una cola de consumo:
 * - <cola>.retry: retiene el mensaje RETRY_DELAY_MS y lo devuelve a <cola>
 *   (TTL + dead-letter al exchange por defecto).
 * - <cola>.dlq: mensajes que agotaron los reintentos, para revisión manual.
 * La cola principal no cambia de argumentos, así que funciona con colas ya creadas.
 */
export async function assertRetryQueues(channel: amqplib.Channel, queue: string) {
  await channel.assertQueue(`${queue}.retry`, {
    durable: true,
    arguments: {
      'x-message-ttl': RETRY_DELAY_MS,
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': queue,
    },
  });
  await channel.assertQueue(`${queue}.dlq`, { durable: true });
}

/** Routing key con la que se publicó el evento, también en los mensajes reintentados. */
export function originalRoutingKey(msg: amqplib.ConsumeMessage): string {
  return (msg.properties.headers?.[ORIGINAL_KEY_HEADER] as string | undefined) ?? msg.fields.routingKey;
}

/**
 * Tras un fallo: reintenta más tarde o, si se agotaron los intentos (o el
 * mensaje es irrecuperable), lo manda a la DLQ. En ambos casos confirma el
 * original para que no bloquee la cola.
 */
export function handleFailure(
  channel: amqplib.Channel,
  queue: string,
  msg: amqplib.ConsumeMessage,
  error: Error,
  logger: Logger,
) {
  const attempt = Number(msg.properties.headers?.[RETRY_COUNT_HEADER] ?? 0) + 1;
  const poison = error instanceof PoisonMessageError;
  const target = poison || attempt > MAX_RETRIES ? `${queue}.dlq` : `${queue}.retry`;

  const headers = {
    ...msg.properties.headers,
    [RETRY_COUNT_HEADER]: attempt,
    [ORIGINAL_KEY_HEADER]: originalRoutingKey(msg),
    'x-last-error': error.message.slice(0, 500),
  };

  try {
    channel.sendToQueue(target, msg.content, {
      persistent: true,
      contentType: msg.properties.contentType,
      messageId: msg.properties.messageId,
      headers,
    });
    channel.ack(msg);
  } catch {
    // Canal cerrado: RabbitMQ reentregará el mensaje original al reconectar.
    return;
  }

  if (target.endsWith('.dlq')) {
    logger.error(`Evento '${originalRoutingKey(msg)}' enviado a ${target} tras ${attempt} intento(s): ${error.message}`);
  } else {
    logger.warn(`Evento '${originalRoutingKey(msg)}' falló (intento ${attempt}/${MAX_RETRIES}); se reintenta en ${RETRY_DELAY_MS / 1000}s: ${error.message}`);
  }
}

/** Mensajes en la cola principal, en espera de reintento y en la DLQ (para el panel). */
export async function queueStats(channel: amqplib.Channel, queue: string) {
  const [main, retry, dlq] = await Promise.all([
    channel.checkQueue(queue),
    channel.checkQueue(`${queue}.retry`),
    channel.checkQueue(`${queue}.dlq`),
  ]);
  return {
    queue,
    ready: main.messageCount,
    consumers: main.consumerCount,
    waitingRetry: retry.messageCount,
    deadLetters: dlq.messageCount,
  };
}

/** Lista hasta `max` mensajes de la DLQ sin sacarlos (los devuelve a la cola). */
export async function peekDeadLetters(channel: amqplib.Channel, queue: string, max = 20) {
  const items: Record<string, unknown>[] = [];
  const held: amqplib.GetMessage[] = [];
  try {
    for (let i = 0; i < max; i++) {
      const msg = await channel.get(`${queue}.dlq`, { noAck: false });
      if (!msg) break;
      held.push(msg);
      const headers = msg.properties.headers ?? {};
      let data: unknown = null;
      try {
        data = JSON.parse(msg.content.toString());
      } catch {
        data = msg.content.toString().slice(0, 500);
      }
      items.push({
        routingKey: headers[ORIGINAL_KEY_HEADER] ?? msg.fields.routingKey,
        attempts: headers[RETRY_COUNT_HEADER] ?? 0,
        lastError: headers['x-last-error'] ?? null,
        message: data,
      });
    }
  } finally {
    // nack con requeue: vuelven a la DLQ en su lugar.
    for (const msg of held.reverse()) channel.nack(msg, false, true);
  }
  return items;
}

/** Devuelve hasta `max` mensajes de la DLQ a la cola principal con el contador en cero. */
export async function requeueDeadLetters(channel: amqplib.Channel, queue: string, max = 100) {
  let moved = 0;
  for (; moved < max; moved++) {
    const msg = await channel.get(`${queue}.dlq`, { noAck: false });
    if (!msg) break;
    const headers = { ...msg.properties.headers };
    delete headers[RETRY_COUNT_HEADER];
    channel.sendToQueue(queue, msg.content, {
      persistent: true,
      contentType: msg.properties.contentType,
      messageId: msg.properties.messageId,
      headers,
    });
    channel.ack(msg);
  }
  return { moved };
}
