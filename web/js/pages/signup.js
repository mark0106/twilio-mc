import { createUserWithEmailAndPassword } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { auth } from '../firebase-init.js';
import { requireSignedOut } from '../auth.js';
import { apiFetch } from '../api.js';

await requireSignedOut();

const form = document.getElementById('signup-form');
const errorEl = document.getElementById('error');
const submitBtn = document.getElementById('submit');

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.classList.add('hidden');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Creating account…';
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  try {
    await createUserWithEmailAndPassword(auth, email, password);
    // Initialize the tenant document on the backend.
    await apiFetch('/tenant/init', { method: 'POST' });
    window.location.href = '/contacts.html';
  } catch (err) {
    showError(err.message || 'Sign-up failed');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create account';
  }
});
