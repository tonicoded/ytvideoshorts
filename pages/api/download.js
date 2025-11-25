import { Innertube, UniversalCache, Platform } from 'youtubei.js';
import { Readable } from 'stream';
import vm from 'vm';

export const config = {
  api: {
    responseLimit: false,
    bodyParser: false,
  },
};

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

  const candidates = [...(sd.formats || []), ...(sd.adaptive_formats || [])].filter(
    (f) => (f.has_audio || f.audio_codec) && f.has_video
  );

  if (!candidates.length) return null;

  const mp4 = candidates.filter((f) => f.mime_type?.includes('mp4'));
  const pool = mp4.length ? mp4 : candidates;

  return pool.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
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
    const info = await yt.getBasicInfo(videoId);

    const bestFormat = pickBestMuxed(info);

    if (!bestFormat || (!bestFormat.has_audio && !bestFormat.audio_codec)) {
      return res.status(500).json({ error: 'Geen geschikt formaat met audio gevonden voor deze video.' });
    }

    const safeTitle = sanitizeFileName(info.basic_info?.title);
    const mime = bestFormat.mime_type?.split(';')[0] || 'video/mp4';

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.mp4"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

    const downloadStream = await info.download({
      type: 'video+audio',
      itag: bestFormat.itag,
      format: bestFormat.mime_type?.includes('mp4') ? 'mp4' : undefined,
    });

    const stream = toNodeStream(downloadStream);
    if (!stream) {
      return res.status(500).json({ error: 'Kon stream niet openen. Probeer opnieuw.' });
    }

    stream.on('error', (err) => {
      console.error('Download stream error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Probleem tijdens downloaden. Probeer opnieuw.' });
      } else {
        res.destroy(err);
      }
    });

    stream.pipe(res);
  } catch (err) {
    console.error('Download error:', err);
    return res.status(500).json({ error: 'Kon de video niet ophalen. Controleer de link en probeer opnieuw.' });
  }
}
