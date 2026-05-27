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
import { analyzeMessage } from '../segment-counter.js';
import { createPhonePreview } from '../phone-preview.js';

const user = await requireUser();
renderNav(user);

// Server-side configured rate (functions/.env.twilio-mc). Keep in sync if you
// change it there — only used to estimate fan-out time in the review modal.
const TWILIO_SEND_RATE_PER_SECOND = 3;

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'less than a minute';
  if (seconds < 90) return `about ${Math.round(seconds)} seconds`;
  const minutes = seconds / 60;
  if (minutes < 60) return `about ${Math.round(minutes)} minutes`;
  const hours = minutes / 60;
  if (hours < 2) return `about ${hours.toFixed(1)} hours`;
  return `about ${Math.round(hours)} hours`;
}

const els = {
  notConnected: document.getElementById('not-connected'),
  name: document.getElementById('name'),
  messagingService: document.getElementById('messagingService'),
  contactList: document.getElementById('contactList'),
  listMeta: document.getElementById('list-meta'),
  body: document.getElementById('body'),
  charCount: document.getElementById('char-count'),
  encodingBadge: document.getElementById('encoding-badge'),
  scheduleNow: document.querySelector('input[name="schedule"][value="now"]'),
  scheduleLater: document.querySelector('input[name="schedule"][value="later"]'),
  scheduledAt: document.getElementById('scheduledAt'),
  testTo: document.getElementById('testTo'),
  testBtn: document.getElementById('test-btn'),
  testStatus: document.getElementById('test-status'),
  reviewBtn: document.getElementById('review-btn'),
  emojiBtn: document.getElementById('emoji-btn'),
  errorEl: document.getElementById('error'),
  modal: document.getElementById('review-modal'),
  modalCancel: document.getElementById('modal-cancel'),
  modalConfirm: document.getElementById('modal-confirm'),
  modalError: document.getElementById('modal-error'),
};

const preview = createPhonePreview(document.getElementById('phone-preview'));

let messagingServices = [];
let contactLists = [];
let currentList = null;

function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}
function clearError(el) {
  el.classList.add('hidden');
}

function fmtSegmentInfo() {
  const a = analyzeMessage(els.body.value);
  els.charCount.innerHTML = a.charCount
    ? `${a.charCount} / ${a.singleMax} · <strong>${a.segments}</strong> segment${a.segments === 1 ? '' : 's'}`
    : '0 chars';
  if (a.charCount > a.singleMax) {
    els.charCount.classList.add('over-limit');
  } else {
    els.charCount.classList.remove('over-limit');
  }
  els.encodingBadge.textContent = a.encoding;
  els.encodingBadge.classList.toggle('ucs2', a.encoding === 'UCS-2');
  preview.update({
    body: els.body.value,
    segmentCount: a.segments,
    encoding: a.encoding,
    characterCount: a.charCount,
  });
  return a;
}

els.body.addEventListener('input', fmtSegmentInfo);
fmtSegmentInfo();

// --- schedule control ---
function syncSchedule() {
  const later = els.scheduleLater.checked;
  els.scheduledAt.disabled = !later;
  if (later && !els.scheduledAt.value) {
    // Default to "now + 30 minutes", formatted for datetime-local
    const d = new Date(Date.now() + 30 * 60 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    els.scheduledAt.value =
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
}
els.scheduleNow.addEventListener('change', syncSchedule);
els.scheduleLater.addEventListener('change', syncSchedule);

// --- load messaging services ---
async function loadMessagingServices() {
  try {
    const data = await apiFetch('/messaging-services');
    messagingServices = data.services || [];
    if (!messagingServices.length) {
      els.messagingService.innerHTML =
        '<option value="">No Messaging Services found in your Twilio account</option>';
      return;
    }
    els.messagingService.innerHTML =
      '<option value="">Choose…</option>' +
      messagingServices
        .map(
          (s) => `<option value="${s.sid}">${escapeHtml(s.friendlyName || s.sid)}</option>`
        )
        .join('');
  } catch (err) {
    if (err.details?.error === 'twilio_not_connected') {
      els.notConnected.classList.remove('hidden');
      els.messagingService.innerHTML = '<option value="">Connect Twilio first</option>';
      return;
    }
    if (err.details?.error === 'twilio_auth_failed') {
      els.messagingService.innerHTML =
        '<option value="">Twilio rejected your stored credentials — reconnect in Settings</option>';
      return;
    }
    els.messagingService.innerHTML = '<option value="">Failed to load</option>';
    showError(els.errorEl, 'Could not load Messaging Services: ' + (err.message || 'unknown'));
  }
}

// --- subscribe to contact lists ---
// We order by createdAt only and filter `status === 'ready'` client-side. A
// status+createdAt query would need a composite index, and there are at most
// a few dozen lists per tenant so this is cheap.
function subscribeContactLists() {
  const ref = collection(db, `tenants/${user.uid}/contactLists`);
  const q = query(ref, orderBy('createdAt', 'desc'));
  onSnapshot(
    q,
    (snap) => {
      const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      contactLists = all.filter((l) => l.status === 'ready');
      const prev = els.contactList.value;
      if (!contactLists.length) {
        const hint = all.length
          ? 'No ready contact lists (some are still uploading).'
          : 'No contact lists — upload one first.';
        els.contactList.innerHTML = `<option value="">${hint}</option>`;
        els.listMeta.textContent = '';
        currentList = null;
        return;
      }
      els.contactList.innerHTML =
        '<option value="">Choose…</option>' +
        contactLists
          .map(
            (l) =>
              `<option value="${l.id}">${escapeHtml(l.name)} (${(l.count || 0).toLocaleString()})</option>`
          )
          .join('');
      if (prev && contactLists.some((l) => l.id === prev)) {
        els.contactList.value = prev;
        onListChange();
      }
    },
    (err) => {
      console.error('contact lists query failed:', err);
      els.contactList.innerHTML = `<option value="">Failed to load: ${escapeHtml(err.message || err.code || 'unknown')}</option>`;
      showError(els.errorEl, 'Could not load contact lists. ' + (err.message || err.code || ''));
    }
  );
}

function onListChange() {
  const id = els.contactList.value;
  currentList = contactLists.find((l) => l.id === id) || null;
  els.listMeta.textContent = currentList
    ? `${(currentList.count || 0).toLocaleString()} recipients`
    : '';
}
els.contactList.addEventListener('change', onListChange);

// --- test SMS ---
els.testBtn.addEventListener('click', async () => {
  els.testStatus.textContent = '';
  els.testStatus.classList.remove('error', 'success');

  const msSid = els.messagingService.value;
  const to = els.testTo.value.trim();
  const body = els.body.value;
  if (!msSid) return setTestStatus('Choose a Messaging Service first.', 'error');
  if (!to) return setTestStatus('Enter a phone number to test to.', 'error');
  if (!body.trim()) return setTestStatus('Type a message body first.', 'error');

  els.testBtn.disabled = true;
  els.testBtn.textContent = 'Sending…';
  try {
    const res = await apiFetch('/sends/test', {
      method: 'POST',
      body: { messagingServiceSid: msSid, to, body },
    });
    setTestStatus(`Sent to ${res.to} (Twilio SID ${res.sid}, status: ${res.status})`, 'success');
  } catch (err) {
    if (err.details?.error === 'invalid_phone_to') {
      setTestStatus(
        'That phone number is not valid. Use E.164 like +14155552671.',
        'error'
      );
    } else if (err.details?.error === 'twilio_send_failed') {
      setTestStatus(
        `Twilio rejected the test: ${err.details.message || err.details.code || 'unknown'}`,
        'error'
      );
    } else {
      setTestStatus(err.message || 'Failed to send test', 'error');
    }
  } finally {
    els.testBtn.disabled = false;
    els.testBtn.textContent = 'Send test';
  }
});

function setTestStatus(msg, kind) {
  els.testStatus.textContent = msg;
  els.testStatus.style.color = kind === 'error' ? '#b91c1c' : kind === 'success' ? '#065f46' : '#6b7280';
}

// --- emoji picker ---
let pickerEl = null;
els.emojiBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  if (pickerEl) {
    pickerEl.remove();
    pickerEl = null;
    return;
  }
  try {
    const [{ Picker }, dataMod] = await Promise.all([
      import('https://esm.sh/emoji-mart@5.6.0'),
      import('https://esm.sh/@emoji-mart/data@1.2.1'),
    ]);
    const picker = new Picker({
      data: dataMod.default,
      theme: 'light',
      previewPosition: 'none',
      skinTonePosition: 'none',
      onEmojiSelect: (emoji) => {
        insertAtCursor(els.body, emoji.native);
        fmtSegmentInfo();
      },
    });
    const wrap = document.createElement('div');
    wrap.className = 'emoji-popover';
    wrap.appendChild(picker);
    document.body.appendChild(wrap);
    const rect = els.emojiBtn.getBoundingClientRect();
    wrap.style.top = `${rect.bottom + window.scrollY + 6}px`;
    wrap.style.left = `${rect.left + window.scrollX}px`;
    pickerEl = wrap;
    setTimeout(() => {
      document.addEventListener('click', closeOnOutside, { once: true });
    }, 0);
  } catch (err) {
    console.error('Failed to load emoji picker', err);
    setTestStatus('Could not load emoji picker. Paste an emoji into the body instead.', 'error');
  }
});
function closeOnOutside(e) {
  if (pickerEl && !pickerEl.contains(e.target) && e.target !== els.emojiBtn) {
    pickerEl.remove();
    pickerEl = null;
  } else if (pickerEl) {
    document.addEventListener('click', closeOnOutside, { once: true });
  }
}
function insertAtCursor(input, text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  input.selectionStart = input.selectionEnd = start + text.length;
  input.focus();
}

// --- review + confirm ---
function getScheduledIso() {
  if (!els.scheduleLater.checked) return null;
  const v = els.scheduledAt.value;
  if (!v) return null;
  // datetime-local has no timezone; treat as local
  const d = new Date(v);
  return d.toISOString();
}

function validateForm() {
  if (!els.name.value.trim()) return 'Give the Single Send a name.';
  if (!els.messagingService.value) return 'Choose a Messaging Service.';
  if (!els.contactList.value || !currentList) return 'Choose a contact list.';
  if (!els.body.value.trim()) return 'Type a message body.';
  if (els.scheduleLater.checked) {
    if (!els.scheduledAt.value) return 'Set a scheduled time.';
    const ts = new Date(els.scheduledAt.value).getTime();
    const now = Date.now();
    if (ts - now < 15 * 60 * 1000) return 'Scheduled time must be at least 15 minutes from now.';
    if (ts - now > 7 * 24 * 60 * 60 * 1000) return 'Scheduled time must be within 7 days.';
  }
  return null;
}

els.reviewBtn.addEventListener('click', () => {
  clearError(els.errorEl);
  const err = validateForm();
  if (err) return showError(els.errorEl, err);

  const a = analyzeMessage(els.body.value);
  const ms = messagingServices.find((s) => s.sid === els.messagingService.value);

  document.getElementById('rv-name').textContent = els.name.value.trim();
  document.getElementById('rv-ms').textContent = ms?.friendlyName || els.messagingService.value;
  document.getElementById('rv-list').textContent = currentList.name;
  document.getElementById('rv-recipients').textContent = (currentList.count || 0).toLocaleString();
  document.getElementById('rv-encoding').textContent = a.encoding;
  document.getElementById('rv-segments').textContent = a.segments;
  document.getElementById('rv-schedule').textContent = els.scheduleLater.checked
    ? new Date(els.scheduledAt.value).toLocaleString()
    : 'Send immediately';
  document.getElementById('rv-body').textContent = els.body.value;
  const recipients = currentList.count || 0;
  const totalSegments = recipients * a.segments;
  const estSeconds = recipients / TWILIO_SEND_RATE_PER_SECOND;
  document.getElementById('rv-cost').textContent =
    `Approx ${recipients.toLocaleString()} × ${a.segments} = ${totalSegments.toLocaleString()} message segments. ` +
    `At your account's ${TWILIO_SEND_RATE_PER_SECOND} MPS rate, full delivery will take ${formatDuration(estSeconds)}.`;

  els.modal.classList.remove('hidden');
});

els.modalCancel.addEventListener('click', () => {
  els.modal.classList.add('hidden');
});

els.modalConfirm.addEventListener('click', async () => {
  clearError(els.modalError);
  els.modalConfirm.disabled = true;
  els.modalConfirm.textContent = 'Working…';
  try {
    const create = await apiFetch('/sends', {
      method: 'POST',
      body: {
        name: els.name.value.trim(),
        messagingServiceSid: els.messagingService.value,
        contactListId: els.contactList.value,
        body: els.body.value,
        scheduledAt: getScheduledIso(),
      },
    });
    await apiFetch(`/sends/${create.sendId}/confirm`, { method: 'POST' });

    // Replace the modal contents with a success card, then redirect.
    const scheduled = !!getScheduledIso();
    const headline = scheduled ? 'Single Send scheduled!' : 'Single Send created!';
    const subline = scheduled
      ? 'Twilio is holding the messages until your scheduled time. Track delivery in Single Sends.'
      : 'Fan-out has started. Track live delivery progress in Single Sends.';
    const modal = els.modal.querySelector('.modal');
    modal.innerHTML = `
      <div style="text-align:center; padding: 12px 0;">
        <div class="success-check" aria-hidden="true">
          <svg viewBox="0 0 48 48" width="56" height="56">
            <circle cx="24" cy="24" r="22" fill="none" stroke="#059669" stroke-width="3" />
            <path d="M14 25 L21 32 L34 17" fill="none" stroke="#059669" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>
        <h2 style="margin: 14px 0 6px;">${headline}</h2>
        <p class="muted" style="margin: 0 0 12px;">${subline}</p>
        <button class="button" id="success-go" type="button" style="margin-top: 4px;">View Single Sends</button>
        <p class="muted" style="font-size: 12px; margin: 10px 0 0;" id="success-countdown">Redirecting…</p>
      </div>
    `;
    els.reviewBtn.disabled = true;

    // Manual fallback in case the auto-redirect is blocked by the browser
    // or the View Transitions handoff hiccups.
    const goBtn = document.getElementById('success-go');
    const goNow = () => {
      // Bypass View Transitions for this navigation to avoid any
      // edge case where it stalls — use assign() which is the most explicit.
      window.location.assign('/sends.html');
    };
    goBtn.addEventListener('click', goNow);

    // Countdown + auto-navigate. Updates the helper line so the user can
    // see something is happening, even if redirect is delayed.
    let seconds = 2;
    const countdownEl = document.getElementById('success-countdown');
    countdownEl.textContent = `Redirecting in ${seconds}s…`;
    const interval = setInterval(() => {
      seconds--;
      if (seconds > 0) {
        countdownEl.textContent = `Redirecting in ${seconds}s…`;
      } else {
        clearInterval(interval);
        countdownEl.textContent = 'Redirecting now…';
        goNow();
      }
    }, 1000);
  } catch (err) {
    showError(
      els.modalError,
      err.details?.error
        ? `Failed: ${err.details.error}`
        : err.message || 'Confirm failed'
    );
    els.modalConfirm.disabled = false;
    els.modalConfirm.textContent = 'Confirm Send';
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

// boot
subscribeContactLists();
loadMessagingServices();
