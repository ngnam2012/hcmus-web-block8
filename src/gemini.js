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

export function buildSummaryPrompt({ title = '', transcript = '', videoUrl = '', options = {} }) {
  const rawLang = options.language || 'vi';
  const rawStyle = options.style || 'short';
  const language = LANGUAGE_MAP[rawLang] || rawLang;
  const style = STYLE_MAP[rawStyle] || rawStyle;
  const trimmedTranscript = String(transcript || '').trim();
  const trimmedUrl = String(videoUrl || '').trim();

  const systemInstruction =
    'You are a precise video summarizer. ' +
    'Summarize strictly using facts observed in the provided video or transcript without inventing information. ' +
    'Write in the requested language and style, and return only the final summary text.';

  const header = title ? `Video title: ${title}\n` : '';
  if (trimmedTranscript) {
    const input =
      `Output language: ${language}\n` +
      `Summary style: ${style}\n` +
      `${header}\n` +
      `Transcript:\n${trimmedTranscript}`;
    return { systemInstruction, input };
  }

  const text =
    `Output language: ${language}\n` +
    `Summary style: ${style}\n` +
    `${header}\n` +
    'Summarize the attached video accurately based on its audio and visuals.';
  return {
    systemInstruction,
    input: [
      { type: 'text', text },
      { type: 'video', uri: trimmedUrl },
    ],
  };
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

export async function summarizeWithGemini({ title = '', transcript = '', videoUrl = '', options = {}, apiKey, model, timeoutMs = 15000 }) {
  if (!apiKey) {
    const err = new Error('GEMINI_API_KEY is not configured');
    err.status = 401;
    throw err;
  }
  if (!String(transcript || '').trim() && !String(videoUrl || '').trim()) {
    const err = new Error('Transcript and video URL are both empty');
    err.status = 400;
    throw err;
  }

  const ai = getClient(apiKey);
  const { systemInstruction, input } = buildSummaryPrompt({ title, transcript, videoUrl, options });
  const isMultimodal = Array.isArray(input);

  const interaction = await ai.interactions.create(
    {
      model,
      system_instruction: systemInstruction,
      input,
      store: false,
      ...(isMultimodal ? { api_version: 'v1beta' } : {}),
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
