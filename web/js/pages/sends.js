import {
  collection,
  query,
  orderBy,
  onSnapshot,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { db } from '../firebase-init.js';
import { requireUser } from '../auth.js';
import { renderNav } from '../nav.js';

const user = await requireUser();
renderNav(user);

const loadingEl = document.getElementById('loading');
const tableEl = document.getElementById('sends-table');
const bodyEl = document.getElementById('sends-body');
const emptyEl = document.getElementById('empty');
const filterEl = document.getElementById('filter-status');

const COUNTERS = ['sent', 'delivered', 'failed', 'undelivered', 'blocked'];

// Track which sends are listed in the DOM and the per-row shard subscriptions
// so we can unsubscribe when the row disappears (filter changes, doc deleted).
const rows = new Map(); // id → { el, totals, unsubShards }

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

function formatDate(ts) {
  if (!ts || !ts.toDate) return '';
  return ts.toDate().toLocaleString();
}

const CLOCK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';

function scheduledBadge(scheduledAt) {
  if (!scheduledAt || !scheduledAt.toDate) return '';
  const dt = scheduledAt.toDate();
  const opts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  return `<div class="scheduled-info" title="${dt.toLocaleString()}">${CLOCK_SVG}<span>${dt.toLocaleString(undefined, opts)}</span></div>`;
}

function buildRow(id, data) {
  const tr = document.createElement('tr');
  tr.id = `row-${id}`;
  const scheduled =
    (data.status === 'scheduled' || data.status === 'canceling') && data.scheduledAt
      ? scheduledBadge(data.scheduledAt)
      : '';
  tr.innerHTML = `
    <td class="name">
      <a href="/sends-detail.html?id=${id}">${escapeHtml(data.name || '(untitled)')}</a>
      ${scheduled}
    </td>
    <td><span class="status-pill ${data.status}">${escapeHtml(data.status || '')}</span></td>
    <td class="right" data-counter="sent">0</td>
    <td class="right" data-counter="delivered">0</td>
    <td class="right" data-counter="failed">0</td>
    <td class="right" data-counter="undelivered">0</td>
    <td class="right" data-counter="blocked">0</td>
    <td class="muted">${formatDate(data.createdAt)}</td>
  `;
  return tr;
}

function updateCounterCells(tr, totals) {
  for (const counter of COUNTERS) {
    const cell = tr.querySelector(`[data-counter="${counter}"]`);
    if (!cell) continue;
    const val = totals[counter] || 0;
    cell.textContent = val.toLocaleString();
  }
}

function subscribeShards(id, tr) {
  const shardsRef = collection(
    db,
    `tenants/${user.uid}/singleSends/${id}/counterShards`
  );
  return onSnapshot(
    shardsRef,
    (snap) => {
      const totals = Object.fromEntries(COUNTERS.map((c) => [c, 0]));
      for (const d of snap.docs) {
        const data = d.data();
        for (const c of COUNTERS) totals[c] += data[c] || 0;
      }
      const entry = rows.get(id);
      if (entry) entry.totals = totals;
      if (tr.isConnected) updateCounterCells(tr, totals);
    },
    (err) => console.error(`shard listener for ${id} failed`, err)
  );
}

function applyFilter() {
  const f = filterEl.value;
  for (const [, entry] of rows) {
    const matches = !f || entry.status === f;
    entry.el.style.display = matches ? '' : 'none';
  }
}

filterEl.addEventListener('change', applyFilter);

const ref = collection(db, `tenants/${user.uid}/singleSends`);
const q = query(ref, orderBy('createdAt', 'desc'));

onSnapshot(
  q,
  (snap) => {
    loadingEl.classList.add('hidden');

    if (snap.empty) {
      tableEl.classList.add('hidden');
      emptyEl.classList.remove('hidden');
      for (const [, entry] of rows) entry.unsubShards?.();
      rows.clear();
      bodyEl.innerHTML = '';
      return;
    }
    emptyEl.classList.add('hidden');
    tableEl.classList.remove('hidden');

    const seen = new Set();
    for (const docSnap of snap.docs) {
      const id = docSnap.id;
      const data = docSnap.data();
      seen.add(id);
      let entry = rows.get(id);
      if (!entry) {
        const tr = buildRow(id, data);
        bodyEl.appendChild(tr);
        const unsubShards = subscribeShards(id, tr);
        entry = { el: tr, totals: {}, unsubShards, status: data.status };
        rows.set(id, entry);
      } else {
        // Update status pill + name + scheduled badge in case they changed
        entry.status = data.status;
        const statusPill = entry.el.querySelector('.status-pill');
        statusPill.className = `status-pill ${data.status}`;
        statusPill.textContent = data.status || '';
        const nameCell = entry.el.querySelector('.name');
        const nameLink = nameCell.querySelector('a');
        nameLink.textContent = data.name || '(untitled)';
        const oldBadge = nameCell.querySelector('.scheduled-info');
        if (oldBadge) oldBadge.remove();
        if (
          (data.status === 'scheduled' || data.status === 'canceling') &&
          data.scheduledAt
        ) {
          nameCell.insertAdjacentHTML('beforeend', scheduledBadge(data.scheduledAt));
        }
      }
    }
    // Clean up rows whose docs were deleted
    for (const [id, entry] of rows) {
      if (!seen.has(id)) {
        entry.unsubShards?.();
        entry.el.remove();
        rows.delete(id);
      }
    }
    applyFilter();
  },
  (err) => {
    loadingEl.textContent = 'Failed to load: ' + (err.message || 'unknown');
  }
);
