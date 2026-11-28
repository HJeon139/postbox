// An attachment’s upload (POST /api/files). Moved from app/js/client.mjs.

import { write } from './client.mjs';

export async function uploadFile(file) {
  const r = await write('/api/files', {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name || 'pasted') },
    body: file,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? 'The upload failed.');
  return data;
}
