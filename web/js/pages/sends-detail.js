import {
  doc,
  collection,
  query,
  where,
  limit,
  orderBy,
  startAfter,
  onSnapshot,
  getDocs,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { db } from '../firebase-init.js';
import { requireUser, getIdToken } from '../auth.js';
import { renderNav } from '../nav.js';
import { animateNumber, pulse } from '../animate-number.js';
import { describeError } from '../twilio-error-codes.js';
import { apiFetch } from '../api.js';
import { confirmDialog, alertDialog } from '../modal.js';

const user = await requireUser();
renderNav(user);

const params = new URLSearchParams(window.location.search);
const sendId = params.get('id');
if (!sendId) {
  document.getElementById('loading').textContent = 'Missing send id.';
  throw new Error('missing sendId');
}

const COUNTERS = ['queued', 'sent', 'delivered', 'read', 'failed', 'undelivered', 'blocked', 'canceled'];
const ERROR_STATES = new Set(['failed', 'undelivered', 'blocked']);
const PAGE_SIZE = 50;

const CLOCK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';

function humanizeRelative(date) {
  const diffMs = date.getTime() - Date.now();
  const absMs = Math.abs(diffMs);
  const past = diffMs < 0;
  const minutes = Math.round(absMs / 60000);
  if (minutes < 1) return past ? 'just now' : 'in moments';
  if (minutes < 60) {
    return past ? `${minutes}m ago` : `in ${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return past ? `${hours}h ago` : `in ${hours}h`;
  }
  const days = Math.round(hours / 24);
  return past ? `${days}d ago` : `in ${days}d`;
}

const els = {
  loading: document.getElementById('loading'),
  content: document.getElementById('content'),
  name: document.getElementById('send-name'),
  statusPill: document.getElementById('status-pill'),
  recipientCount: document.getElementById('recipient-count'),
  scheduleBanner: document.getElementById('schedule-banner'),
  fanoutProgress: document.getElementById('fanout-progress'),
  fanoutCounts: document.getElementById('fanout-counts'),
  fanoutBar: document.getElementById('fanout-bar'),
  fanoutMeta: document.getElementById('fanout-meta'),
  tiles: document.getElementById('tiles'),
  metaGrid: document.getElementById('meta-grid'),
  bodyPreview: document.getElementById('body-preview'),
  exportBtn: document.getElementById('export-btn'),
  cancelBtn: document.getElementById('cancel-btn'),
  // recipients
  filterRecipients: document.getElementById('filter-recipients'),
  recipientsBody: document.getElementById('recipients-body'),
  recipientsInfo: document.getElementById('recipients-info'),
  recipientsPrev: document.getElementById('recipients-prev'),
  recipientsNext: document.getElementById('recipients-next'),
  recipientsPageInfo: document.getElementById('recipients-page-info'),
  // errors
  errorsBody: document.getElementById('errors-body'),
  errorsInfo: document.getElementById('errors-info'),
};

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

const sendRef = doc(db, `tenants/${user.uid}/singleSends/${sendId}`);
const shardsRef = collection(db, `tenants/${user.uid}/singleSends/${sendId}/counterShards`);
const recipientsRef = collection(db, `tenants/${user.uid}/singleSends/${sendId}/recipients`);

let currentSendData = null;

// --- live send doc ---
onSnapshot(
  sendRef,
  (snap) => {
    if (!snap.exists()) {
      els.loading.textContent = 'Send not found.';
      return;
    }
    currentSendData = snap.data();
    els.loading.classList.add('hidden');
    els.content.classList.remove('hidden');
    renderHeader(currentSendData);
    renderMeta(currentSendData);
  },
  (err) => {
    els.loading.textContent = 'Failed to load: ' + (err.message || 'unknown');
  }
);

function renderHeader(data) {
  els.name.textContent = data.name || 'Single Send';
  els.statusPill.className = `status-pill ${data.status || ''}`;
  els.statusPill.textContent = data.status || '';
  els.recipientCount.textContent = `${(data.recipientCount || 0).toLocaleString()} recipients`;

  // Scheduled-time banner — shown when the send is awaiting Twilio delivery
  // or being canceled. Stays visible after cancellation so the user can see
  // when it was *supposed* to go out.
  const dt = data.scheduledAt?.toDate?.();
  if (dt && (data.status === 'scheduled' || data.status === 'canceling' || data.status === 'canceled')) {
    const fullStr = dt.toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
    const rel = humanizeRelative(dt);
    const verb = data.status === 'canceled' ? 'Was scheduled for' : 'Scheduled for';
    els.scheduleBanner.innerHTML = `${CLOCK_SVG}<span>${verb} ${fullStr} (${rel})</span>`;
    els.scheduleBanner.classList.remove('hidden');
  } else {
    els.scheduleBanner.classList.add('hidden');
  }

  // Cancel button — only visible while still scheduled (Twilio still holding
  // the messages). Once canceling/canceled/sending we hide it.
  if (data.status === 'scheduled') {
    els.cancelBtn.classList.remove('hidden');
    els.cancelBtn.disabled = false;
    els.cancelBtn.textContent = 'Cancel send';
  } else if (data.status === 'canceling') {
    els.cancelBtn.classList.remove('hidden');
    els.cancelBtn.disabled = true;
    els.cancelBtn.textContent = 'Canceling…';
  } else {
    els.cancelBtn.classList.add('hidden');
  }

  // Fan-out progress bar — visible while we're actively pushing messages
  // to Twilio. processedQueued + processedFailed = total messages.create
  // calls completed (either accepted or failed) so far.
  const total = data.recipientCount || 0;
  const pushed = (data.processedQueued || 0) + (data.processedFailed || 0);
  const isFanningOut =
    data.status === 'sending' &&
    !data.fanOutCompletedAt &&
    total > 0 &&
    pushed < total;
  if (isFanningOut) {
    const pct = total ? Math.min(100, Math.round((pushed / total) * 100)) : 0;
    els.fanoutBar.style.width = `${pct}%`;
    els.fanoutCounts.textContent = `${pushed.toLocaleString()} / ${total.toLocaleString()}`;
    // 3 MPS hardcoded here to mirror functions/.env.twilio-mc. If the
    // server-side rate changes, change it here too.
    const remaining = total - pushed;
    const etaSec = remaining / 3;
    els.fanoutMeta.textContent = `~${pct}% complete · roughly ${formatRemaining(etaSec)} of fan-out remaining at 3 MPS`;
    els.fanoutProgress.classList.remove('hidden');
  } else {
    els.fanoutProgress.classList.add('hidden');
  }
}

function formatRemaining(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 seconds';
  if (seconds < 90) return `${Math.round(seconds)} seconds`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)} minutes`;
  const hours = minutes / 60;
  if (hours < 2) return `${hours.toFixed(1)} hours`;
  return `${Math.round(hours)} hours`;
}

function renderMeta(data) {
  const rows = [
    ['Status', data.status],
    ['Messaging Service', data.messagingServiceSid],
    ['Contact list', `${data.contactListName || '(unknown)'} — ${(data.recipientCount || 0).toLocaleString()} recipients`],
    ['Encoding', data.encoding],
    ['Segments per message', String(data.segmentCount ?? '—')],
    ['Schedule', data.scheduledAt ? data.scheduledAt.toDate().toLocaleString() : 'Send immediately'],
    ['Created', data.createdAt?.toDate?.()?.toLocaleString() || '—'],
    ['Sent at', data.sentAt?.toDate?.()?.toLocaleString() || '—'],
  ];
  els.metaGrid.innerHTML = rows
    .map(([k, v]) => `<div class="label">${escapeHtml(k)}</div><div>${escapeHtml(v ?? '')}</div>`)
    .join('');
  els.bodyPreview.textContent = data.body || '';
}

// --- live counter shards ---
onSnapshot(
  shardsRef,
  (snap) => {
    const totals = Object.fromEntries(COUNTERS.map((c) => [c, 0]));
    for (const d of snap.docs) {
      const data = d.data();
      for (const c of COUNTERS) totals[c] += data[c] || 0;
    }
    for (const counter of COUNTERS) {
      const el = els.tiles.querySelector(`[data-counter="${counter}"]`);
      if (!el) continue;
      const prev = Number(el.dataset.value || '0') || 0;
      animateNumber(el, totals[counter]);
      if (totals[counter] > prev) pulse(el.parentElement);
    }
  },
  (err) => console.error('shards listener failed', err)
);

// --- tabs ---
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === btn));
    const target = btn.dataset.tab;
    document.querySelectorAll('[data-pane]').forEach((p) => {
      p.classList.toggle('hidden', p.dataset.pane !== target);
    });
    if (target === 'recipients' && !recipientsLoaded) loadRecipientsPage(0);
    if (target === 'errors' && !errorsLoaded) loadErrors();
  });
});

// --- Recipients tab (paginated, on demand) ---
let recipientsLoaded = false;
let pageCursors = [null]; // index = page number; value = startAfter cursor (null for page 0)
let currentPage = 0;
let currentFilter = '';

function statusCellHtml(s) {
  return `<span class="status-cell ${s}">${escapeHtml(s)}</span>`;
}
function fmtTs(ts) {
  return ts?.toDate?.()?.toLocaleString?.() || '';
}

async function loadRecipientsPage(page) {
  els.recipientsBody.innerHTML = '<tr><td colspan="5" class="muted">Loading…</td></tr>';
  let q = query(recipientsRef, orderBy('__name__'), limit(PAGE_SIZE + 1));
  if (currentFilter) {
    q = query(recipientsRef, where('status', '==', currentFilter), orderBy('__name__'), limit(PAGE_SIZE + 1));
  }
  if (page > 0 && pageCursors[page]) {
    q = query(q, startAfter(pageCursors[page]));
  }
  let snap;
  try {
    snap = await getDocs(q);
  } catch (err) {
    els.recipientsBody.innerHTML = `<tr><td colspan="5" class="muted">Failed: ${escapeHtml(err.message || 'unknown')}</td></tr>`;
    return;
  }

  const docs = snap.docs;
  const hasMore = docs.length > PAGE_SIZE;
  const pageDocs = hasMore ? docs.slice(0, PAGE_SIZE) : docs;

  if (pageDocs.length === 0) {
    els.recipientsBody.innerHTML = '<tr><td colspan="5" class="muted">No recipients on this page.</td></tr>';
  } else {
    els.recipientsBody.innerHTML = pageDocs
      .map((d) => {
        const data = d.data();
        const errBit = data.errorCode
          ? `${data.errorCode} — ${escapeHtml(describeError(data.errorCode))}`
          : '';
        return `
          <tr>
            <td>${escapeHtml(data.to || '')}</td>
            <td>${statusCellHtml(data.status)}</td>
            <td class="muted" style="font-family:ui-monospace,Menlo,monospace; font-size:12px">${escapeHtml(d.id)}</td>
            <td>${errBit}</td>
            <td class="muted">${fmtTs(data.updatedAt)}</td>
          </tr>`;
      })
      .join('');
  }

  // Store the last-doc cursor for the next page
  if (hasMore && pageDocs.length) {
    pageCursors[page + 1] = pageDocs[pageDocs.length - 1];
  }

  currentPage = page;
  els.recipientsPrev.disabled = page === 0;
  els.recipientsNext.disabled = !hasMore;
  els.recipientsPageInfo.textContent = `Page ${page + 1}`;
  els.recipientsInfo.textContent = `${pageDocs.length} on this page`;
  recipientsLoaded = true;
}

els.recipientsPrev.addEventListener('click', () => {
  if (currentPage > 0) loadRecipientsPage(currentPage - 1);
});
els.recipientsNext.addEventListener('click', () => {
  loadRecipientsPage(currentPage + 1);
});
els.filterRecipients.addEventListener('change', () => {
  currentFilter = els.filterRecipients.value;
  pageCursors = [null];
  loadRecipientsPage(0);
});

// --- Errors tab ---
let errorsLoaded = false;
async function loadErrors() {
  els.errorsBody.innerHTML = '<tr><td colspan="5" class="muted">Loading…</td></tr>';
  // Filtering on `status in [...]` would need a composite-friendly query; we
  // run three separate `where ==` queries and merge results client-side.
  // Capped to 100 per state to keep the UI snappy.
  const states = ['failed', 'undelivered', 'blocked'];
  const all = [];
  try {
    for (const s of states) {
      const q = query(
        recipientsRef,
        where('status', '==', s),
        limit(100)
      );
      const snap = await getDocs(q);
      for (const d of snap.docs) {
        const data = d.data();
        all.push({
          id: d.id,
          to: data.to,
          status: data.status,
          errorCode: data.errorCode,
          errorMessage: data.errorMessage,
          updatedAt: data.updatedAt,
        });
      }
    }
  } catch (err) {
    els.errorsBody.innerHTML = `<tr><td colspan="5" class="muted">Failed: ${escapeHtml(err.message || 'unknown')}</td></tr>`;
    return;
  }
  all.sort((a, b) => (b.updatedAt?.toMillis?.() || 0) - (a.updatedAt?.toMillis?.() || 0));

  if (!all.length) {
    els.errorsBody.innerHTML = '<tr><td colspan="5" class="muted">No errors. 🎉</td></tr>';
    els.errorsInfo.textContent = '';
  } else {
    els.errorsBody.innerHTML = all
      .map(
        (r) => `
        <tr>
          <td>${escapeHtml(r.to || '')}</td>
          <td>${statusCellHtml(r.status)}</td>
          <td>${escapeHtml(r.errorCode ?? '')}</td>
          <td>${escapeHtml(r.errorCode ? describeError(r.errorCode) : '')}</td>
          <td class="muted">${escapeHtml(r.errorMessage || '')}</td>
        </tr>`
      )
      .join('');
    els.errorsInfo.textContent = `Showing ${all.length} error${all.length === 1 ? '' : 's'} (up to 100 per status).`;
  }
  errorsLoaded = true;
}

// --- Cancel scheduled send ---
els.cancelBtn.addEventListener('click', async () => {
  if (!currentSendData) return;
  const recipients = (currentSendData.recipientCount || 0).toLocaleString();
  const ok = await confirmDialog({
    title: 'Cancel this scheduled send?',
    message:
      `Twilio will stop delivery to all ${recipients} recipients. ` +
      `This can't be undone — you'd have to create a new send to retry.`,
    confirmText: 'Cancel send',
    cancelText: 'Keep send',
    danger: true,
  });
  if (!ok) return;

  els.cancelBtn.disabled = true;
  els.cancelBtn.textContent = 'Canceling…';
  try {
    const result = await apiFetch(`/sends/${sendId}/cancel`, { method: 'POST' });
    const inFlight = result?.alreadyInFlight || 0;
    const canceled = result?.canceled || 0;
    let msg = `Canceled ${canceled.toLocaleString()} scheduled message${canceled === 1 ? '' : 's'}.`;
    if (inFlight > 0) {
      msg += ` ${inFlight.toLocaleString()} had already started delivering and couldn't be canceled.`;
    }
    await alertDialog({
      title: 'Send canceled',
      message: msg,
      kind: 'success',
    });
  } catch (err) {
    await alertDialog({
      title: 'Cancel failed',
      message: err.details?.error || err.message || 'Unknown error. Please try again.',
      kind: 'danger',
    });
    els.cancelBtn.disabled = false;
    els.cancelBtn.textContent = 'Cancel send';
  }
  // The send doc onSnapshot listener will pick up the status flip and
  // re-render the header (button hidden, schedule banner adjusted, etc.)
});

// --- CSV export ---
els.exportBtn.addEventListener('click', async () => {
  els.exportBtn.disabled = true;
  els.exportBtn.textContent = 'Exporting…';
  try {
    const token = await getIdToken();
    const res = await fetch(`/api/sends/${sendId}/export.csv`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Export failed: HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const filename =
      res.headers.get('content-disposition')?.match(/filename="?([^";]+)"?/)?.[1] ||
      `send-${sendId}.csv`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    await alertDialog({
      title: 'Export failed',
      message: err.message || 'Could not export this send.',
      kind: 'danger',
    });
  } finally {
    els.exportBtn.disabled = false;
    els.exportBtn.textContent = 'Export CSV';
  }
});
