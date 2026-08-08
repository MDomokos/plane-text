// Plane Text: cycling the style by dragging on the picture.
//
// The word row is a readout that stays tappable. This is the primary way to
// change style, because the row sits at the top of the screen, which is the
// worst reach for a thumb.
//
// Vertical, because horizontal is the carousel on compose. Capture only,
// because state.js gives styleId one owning screen.

// Travel before a drag counts. Deliberately the tap minimum: below about 30px
// a tap with some drift starts registering as a swipe, and the shutter is on
// this screen.
const THRESHOLD_PX = 44;

// The vertical component must dominate, leaving a 45 degree dead zone that
// belongs to nobody.
const DOMINANCE = 1.0;

// The ids a swipe walks, in the order the row renders them, from the two
// sources currentStyle() resolves against.
export function styleOrder(state, builtIn) {
  return [...builtIn.map((s) => s.id), ...state.customCharsets.map((c) => c.id)];
}

// Cycle by n places, wrapping. With three or four styles a stop at either end
// reads as a dead gesture.
export function cycleStyle(state, builtIn, n) {
  const order = styleOrder(state, builtIn);
  if (!order.length) return state.styleId;
  const at = order.indexOf(state.styleId);
  // An unknown id is a deleted custom charset. currentStyle() falls back the
  // same way rather than throwing.
  const from = at === -1 ? 0 : at;
  return order[(((from + n) % order.length) + order.length) % order.length];
}

// onCycle(n) gets -1 down, +1 up. Up is "next", matching how every scrollable
// thing on a phone moves under a finger.
export function attachStyleGesture(el, { onCycle, signal = null } = {}) {
  let id = null;
  let x0 = 0;
  let y0 = 0;
  let fired = false;    // one change per drag
  let cancelled = false;

  const reset = () => { id = null; fired = false; cancelled = false; };

  el.addEventListener('pointerdown', (e) => {
    if (id !== null) {
      // Second finger. A crop pinch drifts vertically and would otherwise
      // change style under the user while framing. Cancel rather than pause:
      // the surviving finger of a released pinch is somewhere arbitrary.
      cancelled = true;
      id = null;
      return;
    }
    if (cancelled) return;
    id = e.pointerId;
    x0 = e.clientX;
    y0 = e.clientY;
    fired = false;
  }, { signal });

  el.addEventListener('pointermove', (e) => {
    if (id === null || e.pointerId !== id || fired) return;
    const dx = e.clientX - x0;
    const dy = e.clientY - y0;
    if (Math.abs(dy) < THRESHOLD_PX) return;
    if (Math.abs(dy) < Math.abs(dx) * DOMINANCE) return;
    fired = true;
    onCycle(dy < 0 ? 1 : -1);
  }, { signal });

  const end = (e) => {
    if (id !== null && e.pointerId !== id) return;
    reset();
  };
  el.addEventListener('pointerup', end, { signal });
  el.addEventListener('pointercancel', end, { signal });
  // A pointer leaving the element stops sending moves unless captured, so this
  // stops a drag off the top of the stage leaving the handler armed.
  el.addEventListener('pointerleave', end, { signal });

  return { cancel: reset };
}
