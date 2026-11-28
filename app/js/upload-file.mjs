// An attachment’s upload (POST /api/files). Moved from app/js/client.mjs.

/**
 * Uploads a file, telling onProgress how much has gone (#870): XMLHttpRequest reports an upload’s progress, which
 * fetch doesn’t. A stale page token is fetched again and the upload sent once more, as client.mjs’s write() does for
 * the API.
 * @param {File} file @param {(sent: number, total: number) => void} [onProgress]
 */
export async function uploadFile(file, onProgress = () => {}) {
  let r = await sendFile(file, onProgress);
  if (r.status === 403 && r.data.code === 'token') {
    await fetch('/', { cache: 'no-store' });
    r = await sendFile(file, onProgress);
  }
  if (r.status < 200 || r.status >= 300) throw new Error(r.data.error ?? 'The upload failed.');
  return r.data;
}

/**
 * One POST of a file to /api/files: its status and answer. @param {File} file
 * @param {(sent: number, total: number) => void} onProgress
 * @returns {Promise<{ status: number, data: any }>}
 */
function sendFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/files');
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('x-filename', encodeURIComponent(file.name || 'pasted'));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      resolve({ status: xhr.status, data });
    };
    xhr.onerror = () => reject(new Error('The upload didn’t reach Postbox. Check that it’s still running, then attach the file again.'));
    xhr.send(file);
  });
}
