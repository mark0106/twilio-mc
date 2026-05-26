import { logout } from './auth.js';

const LINKS = [
  { href: '/contacts.html', label: 'Contact Lists' },
  { href: '/settings.html', label: 'Settings' },
];

export function renderNav(user, currentPath = window.location.pathname) {
  const header = document.querySelector('header');
  if (!header) return;
  header.innerHTML = `
    <h1>SMS Campaigns</h1>
    <nav>
      ${LINKS.map(({ href, label }) => {
        const active = currentPath === href ? ' style="color:#111827"' : '';
        return `<a href="${href}"${active}>${label}</a>`;
      }).join('')}
    </nav>
    <div class="user">
      <span>${user?.email || ''}</span>
      <button id="nav-logout">Log out</button>
    </div>
  `;
  document.getElementById('nav-logout').addEventListener('click', () => logout());
}
