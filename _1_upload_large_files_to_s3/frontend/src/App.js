import { useCallback, useEffect, useRef, useState } from 'react';

import './App.css';
import { uploadsApi } from './api';
import { uploadFile } from './uploader';

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec) return '--';
  return `${formatBytes(bytesPerSec)}/s`;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.ceil(seconds % 60);
  return `${m}m ${s}s`;
}

const STATUS_LABELS = {
  idle: 'Ready',
  initiating: 'Starting upload…',
  uploading: 'Uploading',
  completing: 'Finalizing in S3…',
  completed: 'Completed',
  aborted: 'Cancelled',
  error: 'Failed',
};

function App() {
  const [file, setFile] = useState(null);
  const [folder, setFolder] = useState('');
  const [phase, setPhase] = useState('idle');
  const [progress, setProgress] = useState(null);
  const [speed, setSpeed] = useState(0);
  const [eta, setEta] = useState(null);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [recent, setRecent] = useState([]);

  const abortRef = useRef(null);
  const sampleRef = useRef({ time: 0, bytes: 0 });

  const refreshRecent = useCallback(async () => {
    try {
      setRecent(await uploadsApi.list(10));
    } catch {
      // The list is a convenience; ignore if the API is unreachable.
    }
  }, []);

  useEffect(() => {
    refreshRecent();
  }, [refreshRecent]);

  const busy = phase === 'initiating' || phase === 'uploading' || phase === 'completing';

  const onPickFile = (event) => {
    const picked = event.target.files?.[0] ?? null;
    setFile(picked);
    setError(null);
    setResult(null);
    setProgress(null);
    setPhase('idle');
  };

  const onStart = async () => {
    if (!file) return;

    setError(null);
    setResult(null);
    setPhase('initiating');
    setProgress({ loadedBytes: 0, totalBytes: file.size, completedParts: 0, totalParts: 0 });
    setSpeed(0);
    setEta(null);
    sampleRef.current = { time: Date.now(), bytes: 0 };

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const completed = await uploadFile(file, {
        folder: folder.trim() || undefined,
        signal: controller.signal,
        onInitiated: () => setPhase('uploading'),
        onProgress: (p) => {
          setProgress(p);

          // Sample throughput over ~1s windows for a stable speed/ETA readout.
          const now = Date.now();
          const elapsed = (now - sampleRef.current.time) / 1000;
          if (elapsed >= 1) {
            const deltaBytes = p.loadedBytes - sampleRef.current.bytes;
            const bps = deltaBytes / elapsed;
            setSpeed(bps);
            setEta(bps > 0 ? (p.totalBytes - p.loadedBytes) / bps : null);
            sampleRef.current = { time: now, bytes: p.loadedBytes };
          }

          if (p.completedParts === p.totalParts && p.totalParts > 0) {
            setPhase('completing');
          }
        },
      });

      setResult(completed);
      setPhase('completed');
      setSpeed(0);
      setEta(null);
      refreshRecent();
    } catch (err) {
      if (err.name === 'AbortError') {
        setPhase('aborted');
      } else {
        setError(err.message || String(err));
        setPhase('error');
      }
      refreshRecent();
    } finally {
      abortRef.current = null;
    }
  };

  const onCancel = () => {
    abortRef.current?.abort();
  };

  const pct =
    progress && progress.totalBytes > 0
      ? Math.min(100, (progress.loadedBytes / progress.totalBytes) * 100)
      : 0;

  return (
    <div className="page">
      <header className="masthead">
        <h1>Large File Uploader</h1>
        <p>Multipart upload straight to Amazon S3 — handles files well over 2&nbsp;GB.</p>
      </header>

      <main className="card">
        <label className={`dropzone ${file ? 'has-file' : ''} ${busy ? 'disabled' : ''}`}>
          <input type="file" onChange={onPickFile} disabled={busy} />
          {file ? (
            <div className="file-info">
              <span className="file-name">{file.name}</span>
              <span className="file-meta">
                {formatBytes(file.size)} · {file.type || 'unknown type'}
              </span>
            </div>
          ) : (
            <div className="file-info">
              <span className="file-name">Choose a file</span>
              <span className="file-meta">or drag one onto this box</span>
            </div>
          )}
        </label>

        <div className="field">
          <label htmlFor="folder">Destination folder (optional)</label>
          <input
            id="folder"
            type="text"
            placeholder="e.g. videos/2026"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            disabled={busy}
          />
        </div>

        <div className="actions">
          {!busy ? (
            <button className="primary" onClick={onStart} disabled={!file}>
              Upload to S3
            </button>
          ) : (
            <button className="danger" onClick={onCancel}>
              Cancel
            </button>
          )}
          <span className={`status status-${phase}`}>{STATUS_LABELS[phase]}</span>
        </div>

        {progress && (phase === 'uploading' || phase === 'completing' || phase === 'completed') && (
          <div className="progress-block">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="progress-stats">
              <span>{pct.toFixed(1)}%</span>
              <span>
                {formatBytes(progress.loadedBytes)} / {formatBytes(progress.totalBytes)}
              </span>
              <span>
                {progress.completedParts}/{progress.totalParts} parts
              </span>
              <span>{formatSpeed(speed)}</span>
              <span>ETA {formatEta(eta)}</span>
            </div>
          </div>
        )}

        {error && <div className="alert error">⚠ {error}</div>}

        {result && (
          <div className="alert success">
            <strong>Upload complete.</strong>
            <div className="result-grid">
              <span>Object key</span>
              <code>{result.objectKey}</code>
              <span>Size</span>
              <code>{formatBytes(result.sizeBytes)}</code>
              <span>Parts</span>
              <code>{result.totalParts}</code>
              <span>Location</span>
              <code className="break">{result.location}</code>
            </div>
          </div>
        )}
      </main>

      <section className="card">
        <div className="section-head">
          <h2>Recent uploads</h2>
          <button className="ghost" onClick={refreshRecent}>
            Refresh
          </button>
        </div>
        {recent.length === 0 ? (
          <p className="empty">No uploads yet.</p>
        ) : (
          <table className="uploads-table">
            <thead>
              <tr>
                <th>File</th>
                <th>Size</th>
                <th>Parts</th>
                <th>Status</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((u) => (
                <tr key={u.id}>
                  <td className="file-cell" title={u.objectKey}>
                    {u.fileName}
                  </td>
                  <td>{formatBytes(u.sizeBytes)}</td>
                  <td>{u.totalParts}</td>
                  <td>
                    <span className={`pill pill-${u.status.toLowerCase()}`}>{u.status}</span>
                  </td>
                  <td>{new Date(u.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

export default App;
