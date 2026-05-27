// Tweens an element's textContent from one number to another over `duration`
// ms with an ease-out-cubic curve. Cancellable per element via the dataset
// flag so successive snapshot updates don't fight each other.

const RUNNING = Symbol('animateNumber.running');

export function animateNumber(el, toValue, { duration = 500 } = {}) {
  const from = Number((el.dataset.value || '0').replace(/[^0-9.-]/g, '')) || 0;
  const to = Number(toValue) || 0;
  el.dataset.value = String(to);
  if (from === to) {
    el.textContent = to.toLocaleString();
    return;
  }
  const tick = el[RUNNING] = Symbol('tick');
  const start = performance.now();
  function step(now) {
    if (el[RUNNING] !== tick) return; // a newer animation took over
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const current = Math.round(from + (to - from) * eased);
    el.textContent = current.toLocaleString();
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// Adds a quick "tick" pulse class to an element when a value increases so the
// user notices the change.
export function pulse(el) {
  el.classList.remove('tick');
  // force reflow so re-adding the class re-triggers the animation
  void el.offsetWidth;
  el.classList.add('tick');
}
