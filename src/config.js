const llmTimeoutMs = Number(process.env.LLM_TIMEOUT_MS || 15000);
if (!Number.isFinite(llmTimeoutMs) || llmTimeoutMs <= 0) {
  throw new Error('LLM_TIMEOUT_MS must be a positive number');
}
const llmProvider = process.env.LLM_PROVIDER || 'gemini';
if (!['gemini', 'mock'].includes(llmProvider)) {
  throw new Error('LLM_PROVIDER must be gemini or mock');
}

export const config = {
  appVersion: process.env.APP_VERSION || 'V3',
  databaseUrl: process.env.DATABASE_URL || 'postgres://lab:lab@127.0.0.1:5438/broker_lab',
  amqpUrl: process.env.AMQP_URL || 'amqp://lab:lab@127.0.0.1:5678',
  mockUrl: process.env.MOCK_URL || 'http://127.0.0.1:3001',
  apiPort: Number(process.env.PORT || 3000),
  confirmTimeoutMs: 3000,
  llmTimeoutMs,
  llmProvider,
  geminiApiKey: (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim(),
  geminiModel: (process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite').trim(),
  labMode: process.env.LAB_MODE === 'true',
  workerId: process.env.WORKER_ID || 'worker-local',
};
if (!['V0', 'V1', 'V2', 'V3'].includes(config.appVersion)) throw new Error('APP_VERSION must be V0, V1, V2 or V3');
export const QUEUE = 'summaries.main';
export const DLQ = 'summaries.dlq';
export const DELAYS = [1000, 3000, 9000];
export const RETRY_QUEUES = DELAYS.map(ms => `summaries.retry.${ms}`);
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
