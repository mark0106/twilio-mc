// Lightweight promise-based dialogs that replace native alert() / confirm().
// Styled to match the brand (cream/navy/orange palette), supports keyboard
// (Esc cancels, Enter confirms on alert), and traps clicks on the backdrop.

const ICONS = {
  info: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
  success: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
  warning: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  danger: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
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

function build(kind, title, message) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-backdrop dialog-backdrop';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <div class="modal modal-dialog modal-${kind}">
      <div class="modal-dialog-icon" aria-hidden="true">${ICONS[kind] || ICONS.info}</div>
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(message)}</p>
      <div class="modal-actions"></div>
    </div>
  `;
  return overlay;
}

function attach(overlay, onClose, options = {}) {
  const { closeOnBackdrop = true, closeOnEscape = true } = options;

  function close(value) {
    document.removeEventListener('keydown', onKey, true);
    overlay.classList.add('dialog-closing');
    setTimeout(() => overlay.remove(), 120);
    onClose(value);
  }
  function onKey(e) {
    if (closeOnEscape && e.key === 'Escape') {
      e.stopPropagation();
      close(false);
    }
  }
  if (closeOnBackdrop) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(false);
    });
  }
  document.addEventListener('keydown', onKey, true);
  return close;
}

export function confirmDialog({
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  danger = false,
  kind,
} = {}) {
  return new Promise((resolve) => {
    const effectiveKind = kind || (danger ? 'warning' : 'info');
    const overlay = build(effectiveKind, title || 'Are you sure?', message || '');
    const actions = overlay.querySelector('.modal-actions');
    actions.innerHTML = `
      <button class="button secondary" type="button" data-act="cancel">${escapeHtml(cancelText)}</button>
      <button class="button ${danger ? 'danger' : ''}" type="button" data-act="confirm">${escapeHtml(confirmText)}</button>
    `;
    document.body.appendChild(overlay);
    const close = attach(overlay, resolve);
    actions.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
    actions.querySelector('[data-act="confirm"]').addEventListener('click', () => close(true));
    requestAnimationFrame(() => {
      // Focus the confirm button by default; users hitting Enter confirm.
      overlay.querySelector('[data-act="confirm"]')?.focus();
    });
  });
}

export function alertDialog({
  title,
  message,
  confirmText = 'OK',
  kind = 'info',
} = {}) {
  return new Promise((resolve) => {
    const overlay = build(kind, title || '', message || '');
    const actions = overlay.querySelector('.modal-actions');
    actions.innerHTML = `
      <button class="button" type="button" data-act="ok">${escapeHtml(confirmText)}</button>
    `;
    document.body.appendChild(overlay);
    const close = attach(overlay, resolve);
    actions.querySelector('[data-act="ok"]').addEventListener('click', () => close(true));

    // Enter to dismiss on alerts
    const onEnter = (e) => {
      if (e.key === 'Enter') {
        e.stopPropagation();
        document.removeEventListener('keydown', onEnter, true);
        close(true);
      }
    };
    document.addEventListener('keydown', onEnter, true);

    requestAnimationFrame(() => {
      overlay.querySelector('[data-act="ok"]')?.focus();
    });
  });
}
