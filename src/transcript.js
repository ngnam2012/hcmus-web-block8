import dns from 'node:dns/promises';
import net from 'node:net';

export const MAX_TRANSCRIPT_CHARS = 50000;
const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

export function extractYouTubeId(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let id = null;
  if (host === 'youtu.be') {
    id = url.pathname.split('/').filter(Boolean)[0] || null;
  } else if (['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com'].includes(host)) {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'watch' || url.pathname === '/') {
      id = url.searchParams.get('v');
    } else if (['shorts', 'live', 'embed', 'v'].includes(parts[0])) {
      id = parts[1] || null;
    }
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

export function canonicalYouTubeUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)));
}

export function cleanSubtitleText(rawText) {
  const lines = String(rawText || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n');

  const out = [];
  let skippingBlock = false;
  let prev = '';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      skippingBlock = false;
      continue;
    }
    if (/^(WEBVTT|NOTE\b|STYLE\b|REGION\b)/i.test(line)) {
      skippingBlock = /^(NOTE|STYLE|REGION)\b/i.test(line);
      continue;
    }
    if (skippingBlock) continue;
    if (/^(Kind|Language):/i.test(line)) continue;
    if (/^\d+$/.test(line)) continue;
    if (/^\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3}\s*-->\s*\d{1,2}:\d{2}/.test(line)) continue;

    const cleaned = decodeHtmlEntities(line.replace(/<[^>]+>/g, ''))
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned || cleaned === prev) continue;
    out.push(cleaned);
    prev = cleaned;
  }

  return out.join('\n').slice(0, MAX_TRANSCRIPT_CHARS).trim();
}

export function parseYouTubeCaptionJson3(payload) {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  const lines = [];
  let prev = '';
  for (const ev of events) {
    if (!Array.isArray(ev?.segs)) continue;
    const text = ev.segs
      .map(s => s?.utf8 || '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text || text === prev) continue;
    lines.push(decodeHtmlEntities(text));
    prev = text;
  }
  return lines.join('\n').slice(0, MAX_TRANSCRIPT_CHARS).trim();
}

export function parseYouTubeCaptionXml(xml) {
  const matches = String(xml || '').matchAll(/<(?:text|p)\b[^>]*>([\s\S]*?)<\/(?:text|p)>/gi);
  const lines = [];
  let prev = '';
  for (const match of matches) {
    const text = decodeHtmlEntities(match[1].replace(/<[^>]+>/g, ''))
      .replace(/\s+/g, ' ')
      .trim();
    if (!text || text === prev) continue;
    lines.push(text);
    prev = text;
  }
  return lines.join('\n').slice(0, MAX_TRANSCRIPT_CHARS).trim();
}

export function pickCaptionTrack(tracks, preferredLang = 'vi') {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const langs = [...new Set([preferredLang, 'vi', 'en'].filter(Boolean))];
  const score = track => {
    const code = String(track?.languageCode || '').toLowerCase();
    const langIndex = langs.findIndex(l => code === l || code.startsWith(`${l}-`));
    const langScore = langIndex === -1 ? 99 : langIndex;
    const asrPenalty = track?.kind === 'asr' ? 1 : 0;
    return langScore * 10 + asrPenalty;
  };
  return [...tracks].sort((a, b) => score(a) - score(b))[0];
}

function extractBalancedJson(source, marker) {
  const idx = source.indexOf(marker);
  if (idx === -1) return null;
  const start = source.indexOf('{', idx + marker.length);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const norm = ip.toLowerCase();
    if (norm === '::' || norm === '::1') return true;
    if (norm.startsWith('fc') || norm.startsWith('fd') || norm.startsWith('fe80')) return true;
    if (norm.startsWith('::ffff:')) return isPrivateIp(norm.slice(7));
    return false;
  }
  return true;
}

export async function assertSafePublicHttpUrl(rawUrl, lookupFn = dns.lookup) {
  let url;
  try {
    url = new URL(String(rawUrl || '').trim());
  } catch {
    throw new Error('Link không hợp lệ');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Chỉ hỗ trợ link http:// hoặc https://');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || (!net.isIP(host) && !host.includes('.'))) {
    throw new Error('Không cho phép truy cập địa chỉ nội bộ');
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Không cho phép truy cập IP nội bộ');
    return url;
  }
  const records = await lookupFn(host, { all: true });
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('Không phân giải được tên miền của link');
  }
  if (records.some(r => isPrivateIp(r.address))) {
    throw new Error('Link trỏ tới địa chỉ IP nội bộ không hợp lệ');
  }
  return url;
}

async function fetchTextLimited(url, { timeoutMs = 12000, headers = {} } = {}) {
  let current = url;
  for (let redirects = 0; redirects <= 3; redirects++) {
    await assertSafePublicHttpUrl(current);
    const response = await fetch(current, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      current = new URL(response.headers.get('location'), current).toString();
      continue;
    }
    if (!response.ok) {
      throw new Error(`Không tải được link (HTTP ${response.status})`);
    }
    const contentType = response.headers.get('content-type') || '';
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.byteLength > MAX_SUBTITLE_BYTES) {
      throw new Error('File phụ đề vượt quá giới hạn 2MB');
    }
    return { text: buf.toString('utf8'), contentType };
  }
  throw new Error('Link chuyển hướng quá nhiều lần');
}

async function fetchYouTubeOEmbed(url, timeoutMs) {
  try {
    const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function fetchYouTubePlayerFromWatch(videoId, preferredLang, timeoutMs) {
  try {
    const response = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=${encodeURIComponent(preferredLang)}`, {
      headers: {
        'user-agent': BROWSER_UA,
        'accept-language': `${preferredLang},en;q=0.9`,
        cookie: 'CONSENT=YES+cb.20210328-17-p0.en+FX+000',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const html = await response.text();
    const player =
      extractBalancedJson(html, 'var ytInitialPlayerResponse = ') ||
      extractBalancedJson(html, 'ytInitialPlayerResponse = ');
    const apiKeyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
    return { player, apiKey: apiKeyMatch?.[1] || null };
  } catch {
    return null;
  }
}

async function fetchYouTubePlayerInnertube(videoId, apiKey, preferredLang, timeoutMs) {
  try {
    const url = apiKey
      ? `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(apiKey)}`
      : 'https://www.youtube.com/youtubei/v1/player';
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'com.google.android.youtube/20.10.38' },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: 'ANDROID',
            clientVersion: '20.10.38',
            hl: preferredLang,
          },
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function downloadCaptionTrack(track, timeoutMs) {
  if (!track?.baseUrl) return '';
  try {
    const jsonUrl = new URL(track.baseUrl);
    if (!jsonUrl.searchParams.has('fmt')) jsonUrl.searchParams.set('fmt', 'json3');
    const res = await fetch(jsonUrl.toString(), {
      headers: { 'user-agent': BROWSER_UA },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const raw = await res.text();
      if (raw.trim().startsWith('{')) {
        const parsed = parseYouTubeCaptionJson3(JSON.parse(raw));
        if (parsed) return parsed;
      }
      const xmlParsed = parseYouTubeCaptionXml(raw);
      if (xmlParsed) return xmlParsed;
    }
  } catch {}

  try {
    const res = await fetch(track.baseUrl, {
      headers: { 'user-agent': BROWSER_UA },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return '';
    return parseYouTubeCaptionXml(await res.text());
  } catch {
    return '';
  }
}

export async function fetchTranscriptFromLink(rawUrl, { preferredLang = 'vi', timeoutMs = 12000 } = {}) {
  const youtubeId = extractYouTubeId(rawUrl);
  if (youtubeId) {
    const videoUrl = canonicalYouTubeUrl(youtubeId);
    const [oembed, innertube] = await Promise.all([
      fetchYouTubeOEmbed(videoUrl, Math.min(timeoutMs, 6000)),
      fetchYouTubePlayerInnertube(youtubeId, null, preferredLang, timeoutMs),
    ]);

    let player = innertube;
    let tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    let chosen = pickCaptionTrack(tracks, preferredLang);
    let transcript = chosen ? await downloadCaptionTrack(chosen, timeoutMs) : '';

    if (!transcript) {
      const watch = await fetchYouTubePlayerFromWatch(youtubeId, preferredLang, timeoutMs);
      if (watch?.player) {
        player = player || watch.player;
        const watchTracks = watch.player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (Array.isArray(watchTracks) && watchTracks.length > 0) {
          const watchChosen = pickCaptionTrack(watchTracks, preferredLang);
          const watchTranscript = watchChosen ? await downloadCaptionTrack(watchChosen, timeoutMs) : '';
          if (watchTranscript) {
            chosen = watchChosen;
            transcript = watchTranscript;
          }
        }
        if (!transcript && watch.apiKey) {
          const keyedInnertube = await fetchYouTubePlayerInnertube(youtubeId, watch.apiKey, preferredLang, timeoutMs);
          const keyedTracks = keyedInnertube?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
          const keyedChosen = pickCaptionTrack(keyedTracks, preferredLang);
          const keyedTranscript = keyedChosen ? await downloadCaptionTrack(keyedChosen, timeoutMs) : '';
          if (keyedTranscript) {
            player = keyedInnertube;
            chosen = keyedChosen;
            transcript = keyedTranscript;
          }
        }
      }
    }

    const title = String(oembed?.title || player?.videoDetails?.title || `YouTube ${youtubeId}`).trim().slice(0, 200);

    return {
      kind: 'youtube',
      video_id_hint: `YT-${youtubeId}`,
      video_url: videoUrl,
      title,
      transcript,
      transcript_found: Boolean(transcript),
      track_language: chosen?.languageCode || null,
      warning: transcript
        ? null
        : 'Chưa lấy được phụ đề tự động từ YouTube (video không có phụ đề hoặc bị giới hạn). Bạn vẫn có thể lưu link này để Gemini tóm tắt trực tiếp từ video YouTube.',
    };
  }

  const { text, contentType } = await fetchTextLimited(rawUrl, { timeoutMs });
  if (/text\/html/i.test(contentType) || /^\s*<!doctype\s+html|^\s*<html/i.test(text)) {
    throw new Error('Link trả về trang HTML. Hãy dùng link YouTube hoặc link trực tiếp tới file phụ đề (.vtt, .srt, .txt)');
  }
  const transcript = cleanSubtitleText(text);
  if (!transcript) {
    throw new Error('Không trích xuất được nội dung văn bản từ link phụ đề');
  }
  const urlObj = new URL(rawUrl.trim());
  const fileName = decodeURIComponent(urlObj.pathname.split('/').filter(Boolean).pop() || 'Subtitle link');
  const title = fileName.replace(/\.(vtt|srt|txt)$/i, '').replace(/[-_]+/g, ' ').trim().slice(0, 200) || 'Video từ link phụ đề';

  return {
    kind: 'subtitle_file',
    video_url: urlObj.toString(),
    title,
    transcript,
    transcript_found: true,
    track_language: null,
    warning: null,
  };
}
