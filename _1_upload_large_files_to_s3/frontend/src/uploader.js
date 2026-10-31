// Drives one file through the multipart upload flow:
//
//   initiate -> (for each part: get URL, PUT chunk to S3, collect ETag) -> complete
//
// Parts are uploaded with bounded concurrency and each byte goes straight from
// the browser to S3 -- the backend only ever sees metadata and presigned URLs,
// never the file itself, which is what lets a >2 GB file through.
import { uploadsApi } from './api';

const DEFAULT_CONCURRENCY = 4;
const MAX_PART_RETRIES = 3;

// PUT one chunk to its presigned S3 URL and return the ETag from the response.
function putPart(url, blob, { signal, onProgress }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        // S3 returns the part's ETag in a response header, quotes included.
        const etag = xhr.getResponseHeader('ETag');
        if (!etag) {
          reject(new Error('S3 did not return an ETag for this part'));
          return;
        }
        resolve(etag);
      } else {
        reject(new Error(`S3 responded ${xhr.status} for this part`));
      }
    };

    xhr.onerror = () => reject(new Error('Network error while uploading part'));
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));

    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        return;
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }

    xhr.send(blob);
  });
}

// Run `worker` over each item in `items` with at most `limit` in flight.
async function runPool(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * Upload `file` via S3 multipart. Returns the completed upload record.
 *
 * @param {File} file
 * @param {object} opts
 * @param {string} [opts.folder]
 * @param {number} [opts.concurrency]
 * @param {AbortSignal} [opts.signal]
 * @param {(id: string) => void} [opts.onInitiated]
 * @param {(progress: {loadedBytes:number,totalBytes:number,completedParts:number,totalParts:number}) => void} [opts.onProgress]
 */
export async function uploadFile(file, opts = {}) {
  const { folder, concurrency = DEFAULT_CONCURRENCY, signal, onInitiated, onProgress } = opts;

  // Step 1-4: open the multipart upload. The backend decides the part size.
  const upload = await uploadsApi.initiate({
    fileName: file.name,
    sizeBytes: file.size,
    mimeType: file.type || 'application/octet-stream',
    folder,
  });

  if (onInitiated) onInitiated(upload.id);

  const { id, partSize, totalParts } = upload;
  const totalBytes = file.size;

  // Per-part byte counters, so overall progress is accurate even with
  // concurrent uploads and retries.
  const loadedPerPart = new Array(totalParts).fill(0);
  const completedParts = [];
  let completedCount = 0;

  const emitProgress = () => {
    if (!onProgress) return;
    const loadedBytes = loadedPerPart.reduce((sum, n) => sum + n, 0);
    onProgress({ loadedBytes, totalBytes, completedParts: completedCount, totalParts });
  };

  const partNumbers = Array.from({ length: totalParts }, (_, i) => i + 1);

  try {
    await runPool(partNumbers, concurrency, async (partNumber) => {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      const start = (partNumber - 1) * partSize;
      const end = Math.min(start + partSize, totalBytes);
      const blob = file.slice(start, end);
      const index = partNumber - 1;

      let lastError;
      for (let attempt = 1; attempt <= MAX_PART_RETRIES; attempt += 1) {
        try {
          // Step 5-7: a fresh presigned URL (also covers a URL that expired
          // on an earlier attempt).
          const { url } = await uploadsApi.partUrl(id, partNumber);

          // Step 8-9: PUT the chunk straight to S3.
          loadedPerPart[index] = 0;
          const etag = await putPart(url, blob, {
            signal,
            onProgress: (loaded) => {
              loadedPerPart[index] = loaded;
              emitProgress();
            },
          });

          loadedPerPart[index] = blob.size;
          completedParts.push({ partNumber, etag, sizeBytes: blob.size });
          completedCount += 1;
          emitProgress();
          return;
        } catch (error) {
          if (error.name === 'AbortError') throw error;
          lastError = error;
          loadedPerPart[index] = 0;
          emitProgress();
          // Simple backoff before retrying a flaky part.
          if (attempt < MAX_PART_RETRIES) {
            await new Promise((r) => setTimeout(r, 500 * attempt));
          }
        }
      }

      throw new Error(`Part ${partNumber} failed after ${MAX_PART_RETRIES} attempts: ${lastError?.message}`);
    });

    // Step 10-13: hand the ETags back so S3 can stitch the object together.
    return await uploadsApi.complete(id, completedParts);
  } catch (error) {
    // Best-effort cleanup so S3 is not left holding orphaned parts.
    if (error.name === 'AbortError') {
      await uploadsApi.abort(id, 'Cancelled by user').catch(() => {});
    } else {
      await uploadsApi.abort(id, error.message?.slice(0, 200)).catch(() => {});
    }
    throw error;
  }
}
