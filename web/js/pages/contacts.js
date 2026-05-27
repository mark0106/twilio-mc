import {
  collection,
  query,
  orderBy,
  onSnapshot,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { db } from '../firebase-init.js';
import { requireUser } from '../auth.js';
import { renderNav } from '../nav.js';
import { apiFetch } from '../api.js';
import { confirmDialog, alertDialog } from '../modal.js';

const user = await requireUser();
renderNav(user);

const loadingEl = document.getElementById('loading');
const tableEl = document.getElementById('lists-table');
const bodyEl = document.getElementById('lists-body');
const emptyEl = document.getElementById('empty');

function formatDate(ts) {
  if (!ts || !ts.toDate) return '';
  const d = ts.toDate();
  return d.toLocaleString();
}

function pct(progress) {
  if (!progress) return 0;
  const { processed = 0, total = 0 } = progress;
  if (!total) return 0;
  return Math.min(100, Math.round((processed / total) * 100));
}

function statusCell(data) {
  if (data.status === 'uploading') {
    const p = data.uploadProgress || { processed: 0, total: 0 };
    const percent = pct(p);
    const indeterminate = !p.total ? ' indeterminate' : '';
    const width = p.total ? `${percent}%` : '100%';
    return `
      <span class="status-badge" style="background:#fef3c7;color:#92400e">Uploading</span>
      <div style="margin-top:6px">
        <div class="progress${indeterminate}"><span style="width:${width}"></span></div>
        <span class="muted" style="margin-left:6px">
          ${p.processed.toLocaleString()}${p.total ? ' / ' + p.total.toLocaleString() : ''}
          ${p.errors ? ' · ' + p.errors + ' errors' : ''}
        </span>
      </div>
    `;
  }
  if (data.status === 'ready') {
    return `<span class="status-badge connected">Ready</span>`;
  }
  if (data.status === 'error') {
    return `<span class="status-badge disconnected">Error</span>`;
  }
  return `<span class="status-badge">${data.status || ''}</span>`;
}

function render(docs) {
  loadingEl.classList.add('hidden');
  if (!docs.length) {
    tableEl.classList.add('hidden');
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');
  tableEl.classList.remove('hidden');

  bodyEl.innerHTML = docs
    .map((d) => {
      const data = d.data();
      const id = d.id;
      const isUploading = data.status === 'uploading';
      const errorsBadge = data.uploadProgress?.errors
        ? `<span class="muted"> · ${data.uploadProgress.errors} errors</span>`
        : '';
      return `
        <tr>
          <td class="name">
            <a href="/contacts-detail.html?id=${id}">${escapeHtml(data.name || '(unnamed)')}</a>
            ${errorsBadge}
          </td>
          <td>${statusCell(data)}</td>
          <td>${(data.count || 0).toLocaleString()}</td>
          <td class="muted">${formatDate(data.createdAt)}</td>
          <td class="right">
            <a class="button secondary" href="/contacts-detail.html?id=${id}">View</a>
            ${isUploading ? '' : `<button class="button danger" data-delete="${id}">Delete</button>`}
          </td>
        </tr>
      `;
    })
    .join('');

  bodyEl.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-delete');
      const ok = await confirmDialog({
        title: 'Delete this contact list?',
        message:
          'The list and all its contacts will be permanently removed. This cannot be undone.',
        confirmText: 'Delete list',
        cancelText: 'Keep list',
        danger: true,
      });
      if (!ok) return;
      btn.disabled = true;
      btn.textContent = 'Deleting…';
      try {
        await apiFetch(`/contact-lists/${id}`, { method: 'DELETE' });
        // Snapshot will fire and re-render.
      } catch (err) {
        await alertDialog({
          title: 'Delete failed',
          message: err.message || 'Could not delete this contact list.',
          kind: 'danger',
        });
        btn.disabled = false;
        btn.textContent = 'Delete';
      }
    });
  });
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

const ref = collection(db, `tenants/${user.uid}/contactLists`);
const q = query(ref, orderBy('createdAt', 'desc'));
onSnapshot(
  q,
  (snap) => render(snap.docs),
  (err) => {
    loadingEl.textContent = 'Failed to load: ' + (err.message || 'unknown');
  }
);
