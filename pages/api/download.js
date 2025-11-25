import { Innertube, UniversalCache, Platform } from 'youtubei.js';
import { Readable } from 'stream';
import vm from 'vm';

export const config = {
  api: {
    responseLimit: false,
    bodyParser: false,
  },
};

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const evaluator = (data, env) => {
  const sandbox = vm.createContext({
    ...env,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    URLSearchParams,
    Buffer,
    // Lightweight base64 helpers used by some player scripts.
    atob: (str) => Buffer.from(str, 'base64').toString('binary'),
    btoa: (str) => Buffer.from(str, 'binary').toString('base64'),
  });

  const script = new vm.Script(`${data.output}\n;exportedVars;`);
  const exported = script.runInContext(sandbox);

  const result = {};
  if (env?.sig && typeof exported?.sigFunction === 'function') {
    result.sig = exported.sigFunction(env.sig);
  }
  if (env?.n && typeof exported?.nFunction === 'function') {
    result.n = exported.nFunction(env.n);
  }

  return result;
};

const ensureCustomEval = () => {
  try {
    const current = Platform.shim;
    if (current.eval === evaluator) return;
    Platform.load({ ...current, eval: evaluator });
  } catch (err) {
    console.error('Failed to apply custom evaluator', err);
  }
};

let ytClientPromise;
const getClient = async () => {
  if (!ytClientPromise) {
    ensureCustomEval();
    ytClientPromise = Innertube.create({ cache: new UniversalCache(false) });
  }
  return ytClientPromise;
};

const sanitizeFileName = (name) =>
  (name || 'short')
    .replace(/[^a-z0-9-_]+/gi, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'short';

const extractVideoId = (input) => {
  try {
    const url = new URL(input);
    const host = url.hostname.replace(/^www\./, '');

    if (host === 'youtu.be') {
      return url.pathname.slice(1);
    }

    if (host === 'youtube.com' || host === 'm.youtube.com' || host.endsWith('.youtube.com')) {
      if (url.searchParams.get('v')) {
        return url.searchParams.get('v');
      }
      const pathParts = url.pathname.split('/').filter(Boolean);
      if (pathParts[0] === 'shorts' && pathParts[1]) {
        return pathParts[1];
      }
    }
  } catch {
    return null;
  }
  return null;
};

const toNodeStream = (stream) => {
  if (!stream) return null;
  if (typeof stream.pipe === 'function' || typeof stream.on === 'function') {
    return stream;
  }

  // Web ReadableStream -> Node stream
  if (typeof Readable.fromWeb === 'function' && typeof stream.getReader === 'function') {
    try {
      return Readable.fromWeb(stream);
    } catch {
      /* ignore */
    }
  }

  // Async iterable fallback
  if (stream[Symbol.asyncIterator]) {
    return Readable.from(stream);
  }

  return null;
};

const pickBestMuxed = (info) => {
  const sd = info?.streaming_data;
  if (!sd) return null;

  const candidates = [...(sd.formats || []), ...(sd.adaptive_formats || [])].filter((f) => {
    const hasAudio = f.has_audio || f.audio_codec || f.audioTrack;
    const hasVideo = f.has_video || typeof f.height === 'number' || f.quality_label;
    return hasAudio && hasVideo;
  });

  if (!candidates.length) return null;

  const mp4 = candidates.filter((f) => f.mime_type?.includes('mp4'));
  const pool = mp4.length ? mp4 : candidates;

  return pool.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
};

const pickBestVideoOnly = (info) => {
  const sd = info?.streaming_data;
  if (!sd) return null;

  const candidates = [...(sd.formats || []), ...(sd.adaptive_formats || [])].filter((f) => {
    const hasVideo = f.has_video || typeof f.height === 'number' || f.quality_label;
    const hasNoAudio = !(f.has_audio || f.audio_codec || f.audioTrack);
    return hasVideo && hasNoAudio;
  });

  if (!candidates.length) return null;
  const mp4 = candidates.filter((f) => f.mime_type?.includes('mp4'));
  const pool = mp4.length ? mp4 : candidates;
  return pool.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
};

const streamDirectUrl = async (url) => {
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; ytvideoshorts/1.0)',
      },
    });
    if (!res.ok || !res.body) return null;
    return toNodeStream(res.body);
  } catch (err) {
    console.warn('Direct URL stream failed', err?.message);
    return null;
  }
};

const fetchInfoWithFallback = async (yt, videoId) => {
  const clients = [undefined, 'ANDROID', 'WEB_EMBEDDED', 'MWEB'];
  for (const client of clients) {
    try {
      const info = client ? await yt.getInfo(videoId, { client }) : await yt.getBasicInfo(videoId);
      const format = pickBestMuxed(info);
      if (format) return { info, format, videoOnly: false };
      const videoOnly = pickBestVideoOnly(info);
      if (videoOnly) return { info, format: videoOnly, videoOnly: true };
    } catch (err) {
      // continue to next client
      console.warn('Client fallback failed', client, err?.message);
    }
  }
  return { info: null, format: null, videoOnly: false };
};

const attemptDirectDownload = async (yt, videoId) => {
  const attempts = [
    { type: 'video+audio', client: 'ANDROID', format: 'mp4', quality: 'best' },
    { type: 'video+audio', client: 'WEB', format: 'mp4', quality: 'best' },
    { type: 'video', client: 'ANDROID', format: 'mp4', quality: 'best' },
    { type: 'video', client: 'WEB', format: 'mp4', quality: 'best' },
  ];

  for (const opts of attempts) {
    try {
      const stream = await yt.download(videoId, opts);
      const converted = toNodeStream(stream);
      if (converted) return { stream: converted, videoOnly: opts.type === 'video' };
    } catch (err) {
      console.warn('Direct download attempt failed', opts, err?.message);
    }
  }
  return { stream: null, videoOnly: false };
};

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Alleen GET is toegestaan.' });
  }

  const { url } = req.query;
  if (!url || Array.isArray(url)) {
    return res.status(400).json({ error: 'Voer een YouTube link in als query parameter "url".' });
  }

  let decodedUrl = url;
  try {
    decodedUrl = decodeURIComponent(url);
  } catch {
    decodedUrl = url;
  }

  const videoId = extractVideoId(decodedUrl);
  if (!videoId) {
    return res.status(400).json({ error: 'Dit lijkt geen geldige YouTube/Shorts link.' });
  }

  try {
    const yt = await getClient();
    const { info, format: bestFormat, videoOnly } = await fetchInfoWithFallback(yt, videoId);

    let downloadStream = null;
    let usingVideoOnly = videoOnly;
    let safeTitle = 'short';
    let mime = 'video/mp4';

    if (bestFormat && info) {
      safeTitle = sanitizeFileName(info.basic_info?.title);
      mime = bestFormat.mime_type?.split(';')[0] || 'video/mp4';

      // If YouTube already gives a direct URL, stream it without decipher.
      if (bestFormat.url) {
        downloadStream = await streamDirectUrl(bestFormat.url);
      }

      // Fallback to deciphered download if needed.
      if (!downloadStream) {
        const fetchedStream = await info.download({
          type: videoOnly ? 'video' : 'video+audio',
          itag: bestFormat.itag,
          format: bestFormat.mime_type?.includes('mp4') ? 'mp4' : undefined,
        });
        downloadStream = toNodeStream(fetchedStream);
        usingVideoOnly = videoOnly;
      }
    }

    if (!downloadStream) {
      const { stream, videoOnly: vo } = await attemptDirectDownload(yt, videoId);
      downloadStream = stream;
      usingVideoOnly = vo;
    }

    if (!downloadStream) {
      return res.status(500).json({ error: 'Geen geschikt formaat gevonden voor deze video.' });
    }

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.mp4"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

    downloadStream.on('error', (err) => {
      console.error('Download stream error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Probleem tijdens downloaden. Probeer opnieuw.' });
      } else {
        res.destroy(err);
      }
    });

    downloadStream.pipe(res);
  } catch (err) {
    console.error('Download error:', err);
    return res.status(500).json({ error: 'Kon de video niet ophalen. Controleer de link en probeer opnieuw.' });
  }
}
