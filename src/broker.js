import amqp from 'amqplib';
import { config, QUEUE, DLQ, DELAYS, RETRY_QUEUES } from './config.js';

export async function declareTopology(channel) {
  await channel.assertQueue(QUEUE, { durable: true });
  await channel.assertQueue(DLQ, { durable: true });
  for (const [index, name] of RETRY_QUEUES.entries()) {
    await channel.assertQueue(name, { durable: true, arguments: {
      'x-message-ttl': DELAYS[index],
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': QUEUE,
    } });
  }
}

export class Broker {
  connection;
  connecting;
  async connect() {
    if (this.connection) return this.connection;
    if (!this.connecting) {
      this.connecting = (async () => {
        const conn = await amqp.connect(config.amqpUrl, { timeout: config.confirmTimeoutMs });
        conn.on('error', error => console.error('BROKER_ERROR', error.message));
        conn.on('close', () => { if (this.connection === conn) this.connection = undefined; });
        const channel = await conn.createChannel();
        channel.on('error', () => {});
        await declareTopology(channel);
        await channel.close();
        this.connection = conn;
        return conn;
      })().finally(() => { this.connecting = undefined; });
    }
    return this.connecting;
  }

  async publish(queue, message, headers = {}) {
    const connection = await this.connect();
    const channel = await connection.createConfirmChannel();
    channel.on('error', () => {});
    let timer;
    try {
      await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('PUBLISH_CONFIRM_TIMEOUT')), config.confirmTimeoutMs);
        channel.once('return', () => reject(new Error('UNROUTABLE_MESSAGE')));
        channel.once('close', () => reject(new Error('PUBLISH_CHANNEL_CLOSED')));
        channel.sendToQueue(queue, Buffer.from(JSON.stringify(message)), {
          persistent: true, mandatory: true, contentType: 'application/json',
          type: 'SummarizeVideo', messageId: message.message_id,
          correlationId: message.correlation_id, headers,
        }, error => error ? reject(error) : resolve());
      });
    } finally {
      clearTimeout(timer);
      await channel.close().catch(() => {});
    }
  }

  async close() {
    await this.connection?.close().catch(() => {});
    this.connection = undefined;
  }
}
export const broker = new Broker();
