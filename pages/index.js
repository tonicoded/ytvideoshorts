import { useState } from 'react';
import Head from 'next/head';

const isValidYouTubeUrl = (value) => {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, '');
    return ['youtube.com', 'youtu.be', 'm.youtube.com'].includes(host);
  } catch {
    return false;
  }
};

export default function Home() {
  const [videoUrl, setVideoUrl] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handlePaste = async () => {
    setError('');
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        setError('Niks gevonden op je klembord.');
        return;
      }
      setVideoUrl(text.trim());
    } catch {
      setError('Kon niet plakken. Geef toegang tot het klembord.');
    }
  };

  const handleDownload = async (event) => {
    event.preventDefault();
    setError('');
    setStatus('');

    if (!isValidYouTubeUrl(videoUrl)) {
      setError('Voer een geldige YouTube of Shorts URL in.');
      return;
    }

    setIsLoading(true);
    setStatus('Video wordt klaargezet...');

    try {
      const response = await fetch(`/api/download?url=${encodeURIComponent(videoUrl)}`);

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error || 'Download mislukt. Probeer een andere link.');
      }

      const blob = await response.blob();
      const contentDisposition = response.headers.get('content-disposition') || '';
      const filenameMatch = /filename="?([^\";]+)"?/i.exec(contentDisposition);
      const filename = filenameMatch?.[1] || 'short.mp4';

      const downloadUrl = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = downloadUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(downloadUrl);

      setStatus('Download gestart 🚀');
    } catch (err) {
      setError(err.message);
      setStatus('');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <Head>
        <title>Shorts to MP4 | Smooth Downloader</title>
        <meta
          name="description"
          content="Download YouTube Shorts snel als MP4 in hoge kwaliteit."
        />
      </Head>

      <main className="page">
        <div className="card">
          <header className="header">
            <p className="eyebrow">YouTube Shorts → MP4</p>
            <h1>Direct plakken & downloaden</h1>
            <p className="subtitle">Altijd hoogste kwaliteit met audio. Klaar voor je telefoon.</p>
          </header>

          <form className="form" onSubmit={handleDownload}>
            <label className="label" htmlFor="url">
              Link naar YouTube Short
            </label>
            <div className="control">
              <input
                id="url"
                type="url"
                name="url"
                placeholder="https://youtube.com/shorts/..."
                value={videoUrl}
                onChange={(event) => setVideoUrl(event.target.value)}
                required
                aria-invalid={Boolean(error)}
              />
              <div className="actions">
                <button type="button" className="ghost" onClick={handlePaste} disabled={isLoading}>
                  Plakken
                </button>
                <button type="submit" disabled={isLoading}>
                  {isLoading ? 'Bezig...' : 'Download MP4'}
                </button>
              </div>
            </div>
          </form>

          {status && <div className="status status-ok">{status}</div>}
          {error && <div className="status status-error">{error}</div>}
        </div>
      </main>

      <style jsx>{`
        .page {
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 32px 20px 52px;
          min-height: 100vh;
        }

        .card {
          width: min(960px, 100%);
          background: var(--card);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 20px;
          padding: 28px;
          box-shadow: 0 25px 80px rgba(5, 11, 25, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.06);
          backdrop-filter: blur(10px);
        }

        .header {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          align-items: center;
          margin-bottom: 18px;
        }

        .eyebrow {
          text-transform: uppercase;
          letter-spacing: 0.12em;
          font-size: 11px;
          color: var(--muted);
          margin: 0 0 6px;
        }

        h1 {
          margin: 0;
          font-size: clamp(24px, 6vw, 32px);
          line-height: 1.1;
        }

        .subtitle {
          margin: 8px 0 0;
          color: var(--muted);
          max-width: 520px;
          line-height: 1.5;
        }

        .form {
          margin-top: 18px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .label {
          font-size: 14px;
          color: var(--muted);
        }

        .control {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        input {
          width: 100%;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.14);
          border-radius: 12px;
          color: var(--text);
          padding: 14px 16px;
          font-size: 16px;
          transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.15s ease;
        }

        input:focus {
          outline: none;
          border-color: var(--accent-strong);
          box-shadow: 0 0 0 4px rgba(110, 231, 255, 0.18);
          transform: translateY(-1px);
        }

        .actions {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
          gap: 10px;
        }

        button {
          background: linear-gradient(135deg, #22d3ee, #6366f1);
          border: none;
          color: #051124;
          font-weight: 700;
          padding: 14px 16px;
          border-radius: 12px;
          cursor: pointer;
          width: 100%;
          transition: transform 0.15s ease, box-shadow 0.2s ease, opacity 0.2s ease;
        }

        .ghost {
          background: rgba(255, 255, 255, 0.06);
          color: var(--text);
          border: 1px solid rgba(255, 255, 255, 0.12);
          box-shadow: none;
        }

        button:hover {
          transform: translateY(-1px);
          box-shadow: 0 18px 38px rgba(99, 102, 241, 0.35);
        }

        button:disabled {
          opacity: 0.65;
          cursor: not-allowed;
          transform: none;
          box-shadow: none;
        }

        .hints {
          display: flex;
          gap: 12px;
          flex-wrap: wrap;
          color: var(--muted);
          font-size: 13px;
        }

        .status {
          margin-top: 12px;
          padding: 12px 14px;
          border-radius: 12px;
          font-weight: 600;
          font-size: 14px;
          border: 1px solid rgba(255, 255, 255, 0.12);
        }

        .status-ok {
          background: rgba(34, 211, 238, 0.08);
          color: #b8f4ff;
        }

        .status-error {
          background: rgba(255, 107, 107, 0.12);
          color: #ffd0d0;
        }

        @media (max-width: 720px) {
          .card {
            padding: 20px;
          }

          .header {
            flex-direction: column;
            align-items: flex-start;
            gap: 6px;
          }
        }
      `}</style>
    </>
  );
}
