import { GoogleGenAI } from '@google/genai';

const clients = new Map();

function getClient(apiKey) {
  if (!clients.has(apiKey)) {
    clients.set(apiKey, new GoogleGenAI({ apiKey }));
  }
  return clients.get(apiKey);
}

const LANGUAGE_MAP = {
  vi: 'Vietnamese (Tiếng Việt)',
  en: 'English',
};

const STYLE_MAP = {
  short: 'concise (2 to 4 clear sentences capturing the core ideas)',
  detailed: 'detailed (structured bullet points covering key points and conclusion)',
};

export function buildSummaryPrompt({ title = '', transcript, options = {} }) {
  const rawLang = options.language || 'vi';
  const rawStyle = options.style || 'short';
  const language = LANGUAGE_MAP[rawLang] || rawLang;
  const style = STYLE_MAP[rawStyle] || rawStyle;

  const systemInstruction =
    'You are a precise video transcript summarizer. ' +
    'Summarize strictly using facts from the provided transcript without inventing information. ' +
    'Write in the requested language and style, and return only the final summary text.';

  const header = title ? `Video title: ${title}\n` : '';
  const input =
    `Output language: ${language}\n` +
    `Summary style: ${style}\n` +
    `${header}\n` +
    `Transcript:\n${transcript}`;

  return { systemInstruction, input };
}

export function extractErrorStatus(error) {
  if (
    error?.name === 'RequestTimeoutError' ||
    error?.name === 'TimeoutError' ||
    error?.name === 'AbortError' ||
    error?.name === 'ContinuationInterruptedError'
  ) {
    return 504;
  }
  const status = Number(error?.status ?? error?.statusCode);
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    return status;
  }
  return 503;
}

export async function summarizeWithGemini({ title = '', transcript, options = {}, apiKey, model, timeoutMs = 15000 }) {
  if (!apiKey) {
    const err = new Error('GEMINI_API_KEY is not configured');
    err.status = 401;
    throw err;
  }
  if (!transcript || !transcript.trim()) {
    const err = new Error('Transcript is empty');
    err.status = 400;
    throw err;
  }

  const ai = getClient(apiKey);
  const { systemInstruction, input } = buildSummaryPrompt({ title, transcript, options });

  const interaction = await ai.interactions.create(
    {
      model,
      system_instruction: systemInstruction,
      input,
      store: false,
    },
    {
      timeout_ms: timeoutMs,
      maxRetries: 0,
    },
  );

  const summary = interaction?.output_text?.trim();
  if (!summary) {
    const err = new Error(`Gemini returned empty output (status: ${interaction?.status || 'unknown'})`);
    err.status = 502;
    throw err;
  }

  return {
    summary,
    model: interaction.model || model,
    usage: interaction.usage || null,
  };
}
