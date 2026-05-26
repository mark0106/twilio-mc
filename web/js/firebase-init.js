// Fill these in with your Firebase web app config (Project Settings → Your apps).
// These values are NOT secrets — they identify the project, not authorize writes.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

export const firebaseConfig = {
  apiKey: "AIzaSyBGGIj8g8nV24_D9PeQohqntKHKHKMyFbM",
  authDomain: "twilio-mc.firebaseapp.com",
  projectId: "twilio-mc",
  storageBucket: "twilio-mc.firebasestorage.app",
  messagingSenderId: "700989256858",
  appId: "1:700989256858:web:bddd4ec7e2d0b7901e5b23",
  measurementId: "G-81SBZEGDTR"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
