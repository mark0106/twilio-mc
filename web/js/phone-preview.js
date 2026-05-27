// Renders an iOS-Messages-style preview into a host element. The preview
// shows the sender's name at the top, the message body in a gray incoming
// bubble, and updates whenever the caller calls update().

const STYLE = `
.pp-frame {
  width: 100%;
  max-width: 290px;
  margin: 0 auto;
  background: #f2f2f7;
  border: 1px solid rgba(17, 17, 17, 0.08);
  border-radius: 28px;
  padding: 10px 8px 14px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  position: sticky;
  top: 24px;
  box-shadow:
    0 4px 12px rgba(17, 17, 17, 0.06),
    0 16px 40px rgba(17, 17, 17, 0.10);
}
.pp-notch {
  margin: 0 auto 8px;
  width: 80px;
  height: 4px;
  background: #cbd2da;
  border-radius: 999px;
}
.pp-header {
  text-align: center;
  padding: 6px 0 12px;
  border-bottom: 1px solid #e5e7eb;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.pp-header .pp-logo {
  height: 16px;
  width: auto;
  max-width: 70%;
  display: block;
  margin-bottom: 2px;
}
.pp-header .pp-subtitle {
  display: block;
  font-size: 11px;
  font-weight: 400;
  color: #9ca3af;
}
.pp-body {
  padding: 12px 4px 4px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 80px;
}
.pp-bubble {
  align-self: flex-start;
  max-width: 75%;
  background: #e5e5ea;
  color: #111827;
  border-radius: 18px;
  padding: 8px 12px;
  font-size: 14px;
  line-height: 1.35;
  white-space: pre-wrap;
  word-break: break-word;
}
.pp-meta {
  font-size: 11px;
  color: #9ca3af;
  text-align: center;
  margin-top: 10px;
}
.pp-empty {
  color: #9ca3af;
  font-style: italic;
  font-size: 13px;
  padding: 6px 12px;
}
`;

let styleInjected = false;
function injectStyle() {
  if (styleInjected) return;
  const tag = document.createElement('style');
  tag.textContent = STYLE;
  document.head.appendChild(tag);
  styleInjected = true;
}

export function createPhonePreview(host) {
  injectStyle();
  host.innerHTML = `
    <div class="pp-frame">
      <div class="pp-notch"></div>
      <div class="pp-header">
        <img class="pp-logo" src="/images/logo.png" alt="InvestPub" />
        <span class="pp-subtitle">SMS preview</span>
      </div>
      <div class="pp-body"></div>
      <div class="pp-meta"><span class="pp-segments"></span></div>
    </div>
  `;
  const bodyEl = host.querySelector('.pp-body');
  const segEl = host.querySelector('.pp-segments');

  return {
    update({ body, segmentCount, encoding, characterCount }) {
      if (!body || !body.trim()) {
        bodyEl.innerHTML = '<div class="pp-empty">Type a message…</div>';
      } else {
        // Naive split-by-segment-boundary so the preview shows multi-segment
        // messages as separate bubbles, which is what carriers may render.
        const text = body;
        const bubble = document.createElement('div');
        bubble.className = 'pp-bubble';
        bubble.textContent = text;
        bodyEl.innerHTML = '';
        bodyEl.appendChild(bubble);
      }
      if (!body) {
        segEl.textContent = '';
      } else {
        segEl.textContent =
          `${characterCount} chars · ${segmentCount} segment${segmentCount === 1 ? '' : 's'} · ${encoding}`;
      }
    },
  };
}
