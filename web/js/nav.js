import { logout } from './auth.js';

const ICONS = {
  contacts: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  sends: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  menu: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`,
};

const LINKS = [
  { href: '/contacts.html', label: 'Contact Lists', icon: ICONS.contacts, matchPrefix: '/contacts' },
  { href: '/sends.html', label: 'Single Sends', icon: ICONS.sends, matchPrefix: '/sends' },
  { href: '/settings.html', label: 'Settings', icon: ICONS.settings, matchPrefix: '/settings' },
];

function initials(email) {
  if (!email) return '?';
  const local = email.split('@')[0];
  const parts = local.split(/[._-]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

export function renderNav(user, currentPath = window.location.pathname) {
  document.body.classList.add('app');

  const sidebar = document.querySelector('header');
  if (!sidebar) return;

  const navHtml = LINKS.map(({ href, label, icon, matchPrefix }) => {
    const active = currentPath === href || (matchPrefix && currentPath.startsWith(matchPrefix));
    return `<a href="${href}"${active ? ' class="active"' : ''}>${icon}<span>${label}</span></a>`;
  }).join('');

  sidebar.innerHTML = `
    <div class="sidebar-inner">
      <a class="sidebar-brand" href="/contacts.html" aria-label="InvestPub home">
        <span class="logo-pill"><img src="/images/logo.png" alt="InvestPub" /></span>
      </a>
      <nav class="sidebar-nav" aria-label="Primary">
        ${navHtml}
      </nav>
      <div class="sidebar-user">
        <div class="avatar" aria-hidden="true">${escapeHtml(initials(user?.email))}</div>
        <div class="info">
          <div class="email" title="${escapeHtml(user?.email || '')}">${escapeHtml(user?.email || '')}</div>
          <button class="logout" id="nav-logout">Log out</button>
        </div>
      </div>
    </div>
  `;

  // Mobile hamburger + backdrop are injected as siblings of the sidebar.
  ensureMobileChrome();

  // Close sidebar on link tap (mobile).
  sidebar.querySelectorAll('.sidebar-nav a').forEach((a) => {
    a.addEventListener('click', () => closeSidebar());
  });

  document.getElementById('nav-logout').addEventListener('click', () => logout());
}

function ensureMobileChrome() {
  if (!document.querySelector('.hamburger')) {
    const btn = document.createElement('button');
    btn.className = 'hamburger';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Open menu');
    btn.innerHTML = ICONS.menu;
    btn.addEventListener('click', () => toggleSidebar());
    document.body.appendChild(btn);
  }
  if (!document.querySelector('.sidebar-backdrop')) {
    const bd = document.createElement('div');
    bd.className = 'sidebar-backdrop';
    bd.addEventListener('click', () => closeSidebar());
    document.body.appendChild(bd);
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSidebar();
  });
}

function toggleSidebar() {
  document.body.classList.toggle('sidebar-open');
}
function closeSidebar() {
  document.body.classList.remove('sidebar-open');
}
