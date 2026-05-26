import { signInWithEmailAndPassword } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { auth } from '../firebase-init.js';
import { requireSignedOut } from '../auth.js';

await requireSignedOut();

const form = document.getElementById('login-form');
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
  submitBtn.textContent = 'Logging in…';
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  try {
    await signInWithEmailAndPassword(auth, email, password);
    window.location.href = '/settings.html';
  } catch (err) {
    showError(err.message || 'Login failed');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Log in';
  }
});
