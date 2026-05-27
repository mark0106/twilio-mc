import { requireUser, getIdToken } from '../auth.js';
import { renderNav } from '../nav.js';

const user = await requireUser();
renderNav(user);

const fileInput = document.getElementById('file');
const filenameEl = document.getElementById('filename');
const dropzoneEl = document.getElementById('dropzone');
const previewBlock = document.getElementById('preview-block');
const previewEl = document.getElementById('preview');
const submitBtn = document.getElementById('submit');
const errorEl = document.getElementById('error');
const statusEl = document.getElementById('status');
const formEl = document.getElementById('upload-form');
const nameInput = document.getElementById('name');
const regionInput = document.getElementById('region');

let selectedFile = null;

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
}
function clearError() {
  errorEl.classList.add('hidden');
}
function showStatus(msg) {
  statusEl.textContent = msg;
  statusEl.classList.remove('hidden');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

function renderPreview(headers, rows) {
  if (!rows.length) {
    previewEl.innerHTML = '<p class="muted">File appears empty.</p>';
    return;
  }
  const head = '<tr>' + headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('') + '</tr>';
  const body = rows
    .map(
      (r) =>
        '<tr>' +
        headers.map((h) => `<td>${escapeHtml(r[h] ?? '')}</td>`).join('') +
        '</tr>'
    )
    .join('');
  previewEl.innerHTML = `<table class="preview-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function parsePreview(file) {
  // Read just enough to get a few rows — slice to ~64 KB.
  const slice = file.slice(0, Math.min(file.size, 64 * 1024));
  // eslint-disable-next-line no-undef
  Papa.parse(slice, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => String(h || '').trim(),
    preview: 5,
    complete: (results) => {
      const headers = results.meta?.fields || [];
      renderPreview(headers, results.data || []);
    },
    error: (err) => {
      previewEl.innerHTML =
        '<p class="error" style="margin:8px 0">Could not preview CSV: ' +
        escapeHtml(err.message || 'unknown') +
        '</p>';
    },
  });
}

function handleFile(file) {
  selectedFile = file;
  filenameEl.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
  previewBlock.classList.remove('hidden');
  submitBtn.disabled = false;
  clearError();
  parsePreview(file);
}

fileInput.addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) handleFile(f);
});

['dragenter', 'dragover'].forEach((ev) =>
  dropzoneEl.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzoneEl.classList.add('drag');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  dropzoneEl.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzoneEl.classList.remove('drag');
  })
);
dropzoneEl.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) {
    fileInput.files = e.dataTransfer.files;
    handleFile(f);
  }
});

formEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();
  if (!selectedFile) return showError('Choose a CSV file.');

  submitBtn.disabled = true;
  submitBtn.textContent = 'Uploading…';
  showStatus(
    'Uploading and processing — for large files this can take several minutes. Live progress will appear on the contact lists page.'
  );

  try {
    const token = await getIdToken();
    const formData = new FormData();
    formData.append('name', nameInput.value.trim() || 'Untitled list');
    formData.append('csv', selectedFile);

    const region = encodeURIComponent(regionInput.value || 'US');
    const res = await fetch(`/api/contact-lists?region=${region}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 413) {
        throw new Error(
          `File too large. Max is ${Math.round(
            (data?.maxBytes || 0) / 1024 / 1024
          )} MB.`
        );
      }
      throw new Error(data?.error || `Upload failed (HTTP ${res.status})`);
    }

    window.location.href = `/contacts-detail.html?id=${data.listId}`;
  } catch (err) {
    showError(err.message || 'Upload failed');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Upload';
    statusEl.classList.add('hidden');
  }
});
