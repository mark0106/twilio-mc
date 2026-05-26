import { auth } from '../firebase-init.js';
import { requireUser } from '../auth.js';
import { apiFetch } from '../api.js';
import { renderNav } from '../nav.js';

const user = await requireUser();
renderNav(user);

const loadingEl = document.getElementById('loading');
const connectedEl = document.getElementById('connected');
const connectFormEl = document.getElementById('connect-form');
const errorEl = document.getElementById('error');
const successEl = document.getElementById('success');

function showError(msg) {
  successEl.classList.add('hidden');
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
}

function showSuccess(msg) {
  errorEl.classList.add('hidden');
  successEl.textContent = msg;
  successEl.classList.remove('hidden');
}

function clearMessages() {
  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');
}

function render(status) {
  loadingEl.classList.add('hidden');
  if (status.connected) {
    connectedEl.classList.remove('hidden');
    connectFormEl.classList.add('hidden');
    document.getElementById('connected-sid').textContent = status.accountSid || '';
    document.getElementById('connected-at').textContent = status.connectedAt
      ? new Date(status.connectedAt).toLocaleString()
      : '';
  } else {
    connectedEl.classList.add('hidden');
    connectFormEl.classList.remove('hidden');
  }
}

async function refresh() {
  try {
    const status = await apiFetch('/tenant/twilio');
    render(status);
  } catch (err) {
    showError(err.message || 'Failed to load status');
  }
}

connectFormEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearMessages();
  const btn = document.getElementById('connect-submit');
  btn.disabled = true;
  btn.textContent = 'Validating…';
  const accountSid = document.getElementById('accountSid').value.trim();
  const authToken = document.getElementById('authToken').value;
  try {
    await apiFetch('/tenant/twilio', {
      method: 'POST',
      body: { accountSid, authToken },
    });
    showSuccess('Twilio connected.');
    document.getElementById('authToken').value = '';
    await refresh();
  } catch (err) {
    if (err.status === 400 && err.details?.error === 'twilio_validation_failed') {
      showError('Twilio rejected those credentials. Double-check the SID and Auth Token.');
    } else if (err.status === 400) {
      showError('Invalid input. The Account SID must look like ACxxxxxxxx… (34 chars).');
    } else {
      showError(err.message || 'Failed to connect');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
});

document.getElementById('disconnect').addEventListener('click', async () => {
  clearMessages();
  if (!confirm('Disconnect Twilio? The stored Auth Token will be deleted.')) return;
  try {
    await apiFetch('/tenant/twilio', { method: 'DELETE' });
    showSuccess('Twilio disconnected.');
    await refresh();
  } catch (err) {
    showError(err.message || 'Failed to disconnect');
  }
});

// In case the user lands here without a tenant doc yet (e.g. signup from a different env),
// initialize lazily — POST /tenant/init is idempotent.
try {
  await apiFetch('/tenant/init', { method: 'POST' });
} catch (_err) {
  // non-fatal
}

await refresh();
