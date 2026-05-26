import {
  onAuthStateChanged,
  signOut,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { auth } from './firebase-init.js';

export function onAuthReady() {
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, (user) => {
      unsub();
      resolve(user);
    });
  });
}

export async function requireUser(redirectTo = '/login.html') {
  const user = await onAuthReady();
  if (!user) {
    window.location.href = redirectTo;
    return null;
  }
  return user;
}

export async function requireSignedOut(redirectTo = '/contacts.html') {
  const user = await onAuthReady();
  if (user) {
    window.location.href = redirectTo;
  }
}

export async function getIdToken(forceRefresh = false) {
  const user = auth.currentUser;
  if (!user) throw new Error('not_signed_in');
  return user.getIdToken(forceRefresh);
}

export async function logout() {
  await signOut(auth);
  window.location.href = '/login.html';
}
