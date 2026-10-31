// Thin wrapper around the backend's /api/uploads endpoints.
//
// In development, Create React App proxies unknown paths to the backend via the
// "proxy" field in package.json, so a relative "/api" base works. Override with
// REACT_APP_API_BASE when the API lives elsewhere.
const API_BASE = (process.env.REACT_APP_API_BASE || '').replace(/\/+$/, '');

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message = Array.isArray(body?.message)
      ? body.message.join(', ')
      : body?.message || `Request failed with status ${response.status}`;
    throw new Error(message);
  }

  return body;
}

export const uploadsApi = {
  // Step 1: initiate. Returns { id, partSize, totalParts, ... }.
  initiate: ({ fileName, sizeBytes, mimeType, folder }) =>
    request('/api/uploads/initiate', {
      method: 'POST',
      body: JSON.stringify({ fileName, sizeBytes, mimeType, folder }),
    }),

  // Step 5: get a presigned PUT URL for one part.
  partUrl: (id, partNumber) =>
    request(`/api/uploads/${id}/part-url`, {
      method: 'POST',
      body: JSON.stringify({ partNumber }),
    }),

  // Step 10: complete the multipart upload with the collected ETags.
  complete: (id, parts) =>
    request(`/api/uploads/${id}/complete`, {
      method: 'POST',
      body: JSON.stringify({ parts }),
    }),

  // Cancel an in-flight upload.
  abort: (id, reason) =>
    request(`/api/uploads/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason }),
    }),

  // Which parts S3 already holds (used to resume).
  status: (id) => request(`/api/uploads/${id}/status`),

  list: (limit = 25) => request(`/api/uploads?limit=${limit}`),
};

export { API_BASE };
