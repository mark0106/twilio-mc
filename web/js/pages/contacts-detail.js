import {
  doc,
  collection,
  query,
  limit,
  onSnapshot,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { db } from '../firebase-init.js';
import { requireUser } from '../auth.js';
import { renderNav } from '../nav.js';
import { apiFetch } from '../api.js';
import { confirmDialog, alertDialog } from '../modal.js';

const user = await requireUser();
renderNav(user);

const params = new URLSearchParams(window.location.search);
const listId = params.get('id');
if (!listId) {
  document.getElementById('loading').textContent = 'Missing list id.';
  throw new Error('missing listId');
}

const nameEl = document.getElementById('list-name');
const loadingEl = document.getElementById('loading');
const metaEl = document.getElementById('meta');
const statusEl = document.getElementById('meta-status');
const countEl = document.getElementById('meta-count');
const errorsEl = document.getElementById('meta-errors');
const progressRow = document.getElementById('progress-row');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const contactsEl = document.getElementById('contacts-preview');
const errorBlock = document.getElementById('error-sample-block');
const errorSampleEl = document.getElementById('error-sample');
const deleteBtn = document.getElementById('delete');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

function statusBadge(s) {
  if (s === 'ready') return '<span class="status-badge connected">Ready</span>';
  if (s === 'uploading')
    return '<span class="status-badge" style="background:#fef3c7;color:#92400e">Uploading</span>';
  if (s === 'error') return '<span class="status-badge disconnected">Error</span>';
  return `<span class="status-badge">${escapeHtml(s || '')}</span>`;
}

const listRef = doc(db, `tenants/${user.uid}/contactLists/${listId}`);
const contactsRef = collection(db, `tenants/${user.uid}/contactLists/${listId}/contacts`);
const contactsQuery = query(contactsRef, limit(20));

let listDataCache = null;

onSnapshot(
  listRef,
  (snap) => {
    if (!snap.exists()) {
      loadingEl.textContent = 'List not found.';
      metaEl.classList.add('hidden');
      return;
    }
    const data = snap.data();
    listDataCache = data;
    loadingEl.classList.add('hidden');
    metaEl.classList.remove('hidden');
    nameEl.textContent = data.name || 'Contact List';
    statusEl.innerHTML = statusBadge(data.status);
    countEl.textContent = (data.count || 0).toLocaleString();
    errorsEl.textContent = (data.uploadProgress?.errors || 0).toLocaleString();

    if (data.status === 'uploading') {
      const p = data.uploadProgress || { processed: 0, total: 0 };
      const percent = p.total ? Math.min(100, Math.round((p.processed / p.total) * 100)) : 0;
      progressRow.classList.remove('hidden');
      progressBar.style.width = p.total ? `${percent}%` : '100%';
      progressText.textContent =
        `${p.processed.toLocaleString()}${p.total ? ' / ' + p.total.toLocaleString() : ''}` +
        ` rows processed${p.errors ? ' · ' + p.errors + ' errors' : ''}`;
      deleteBtn.disabled = true;
    } else {
      progressRow.classList.add('hidden');
      deleteBtn.disabled = false;
    }

    if (data.errorSample?.length) {
      errorBlock.classList.remove('hidden');
      errorSampleEl.innerHTML = `
        <table class="preview-table">
          <thead><tr><th>Row #</th><th>Reason</th><th>Raw value</th></tr></thead>
          <tbody>
            ${data.errorSample
              .map(
                (e) => `
              <tr>
                <td>${e.row}</td>
                <td>${escapeHtml(e.reason || '')}</td>
                <td>${escapeHtml(e.value ?? '')}</td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      `;
    } else {
      errorBlock.classList.add('hidden');
    }
  },
  (err) => {
    loadingEl.textContent = 'Failed to load: ' + (err.message || 'unknown');
  }
);

onSnapshot(
  contactsQuery,
  (snap) => {
    if (snap.empty) {
      contactsEl.innerHTML = '<p class="muted">No contacts yet.</p>';
      return;
    }
    const cols = ['phone', 'firstName', 'lastName'];
    contactsEl.innerHTML = `
      <table class="preview-table">
        <thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}<th>custom</th></tr></thead>
        <tbody>
          ${snap.docs
            .map((d) => {
              const c = d.data();
              const custom = c.customFields
                ? Object.entries(c.customFields)
                    .map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(v)}`)
                    .join(', ')
                : '';
              return `<tr>
                <td>${escapeHtml(c.phone || '')}</td>
                <td>${escapeHtml(c.firstName || '')}</td>
                <td>${escapeHtml(c.lastName || '')}</td>
                <td class="muted">${custom}</td>
              </tr>`;
            })
            .join('')}
        </tbody>
      </table>
    `;
  },
  (_err) => {
    contactsEl.innerHTML = '<p class="muted">Could not load contacts.</p>';
  }
);

deleteBtn.addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'Delete this contact list?',
    message:
      'The list and all its contacts will be permanently removed. This cannot be undone.',
    confirmText: 'Delete list',
    cancelText: 'Keep list',
    danger: true,
  });
  if (!ok) return;
  deleteBtn.disabled = true;
  deleteBtn.textContent = 'Deleting…';
  try {
    await apiFetch(`/contact-lists/${listId}`, { method: 'DELETE' });
    window.location.href = '/contacts.html';
  } catch (err) {
    await alertDialog({
      title: 'Delete failed',
      message: err.message || 'Could not delete this contact list.',
      kind: 'danger',
    });
    deleteBtn.disabled = false;
    deleteBtn.textContent = 'Delete';
  }
});
