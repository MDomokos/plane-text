// Plane Text: cycling the style by dragging on the picture.
//
// Added 2026-08-09, from the UX review's §2. The problem it solves is reach,
// not discoverability:
//
//   The style row sat at y = 12-31px. That is 4% down the screen -- the single
//   worst reach on a phone for a right thumb pivoting at the bottom-right,
//   whose comfortable arc covers roughly the lower 55-60%. capture.js
//   justified the position as "chosen first, so it sits at the top where it is
//   visible and out of the thumb's way". But style is the ONLY expressive
//   choice in this app and the thing you will fiddle with most, and "out of the
//   thumb's way" is an argument for a control you want to avoid, not one you
//   want to play with.
//
//   It was also a 19px tap target, in an app whose actionbar.js THROWS AT
//   RUNTIME rather than ship a 43px one. Same rule, same app, broken on the
//   control the user touches second-most.
//
// The row stays -- as the state display and as the tappable fallback, now at a
// 44px hit area (capture.css). The gesture is the reach fix: it puts the
// control literally on the picture it changes, costs zero screen height, and
// is the native vocabulary of a camera app.
//
// ---------------------------------------------------------------------------
// WHY VERTICAL, AND WHY CAPTURE ONLY
//
// Vertical, because horizontal is the carousel on compose and a gesture that
// means two different things on two screens is the exact inconsistency the
// action bar's invariant exists to prevent.
//
// Capture only, because styleId is owned by the capture screen (state.js) and
// a swipe on compose would be compose writing it. That ownership was worth
// keeping: the import hole that made a viewer-side style picker look necessary
// is now closed by capture's frozen sub-mode instead. The knock-on is that on
// compose a vertical drag does nothing, which is a smaller cost than a screen
// where every drag on the picture is a mode guess between carousel and style.
//
// ---------------------------------------------------------------------------
// WHY IT MUST NOT FIRE ON A PINCH
//
// A crop pinch is two pointers whose midpoint drifts vertically. Tracked as one
// stream that is a slow vertical drag, and the style would change under the
// user's fingers while they were framing. So: the moment a second pointer
// arrives the gesture is cancelled outright and not resumed on that pointer's
// release. Cancelled rather than paused, because the surviving finger of a
// released pinch is in an arbitrary place and continuing from it is a guess.

// How far the thumb must travel before this counts as a style change.
//
// 44px, deliberately the same number as the tap minimum. Below about 30 a
// deliberate tap that lands with a bit of drift starts to register as a swipe,
// and a style that changes when you meant to tap the shutter is unforgivable
// on the one screen where the shutter is the point.
const THRESHOLD_PX = 44;

// Past this the drag is horizontal and not ours. 1.0 would hand every diagonal
// to whichever handler read it first; requiring the vertical component to
// dominate leaves a clean 45-degree dead zone that belongs to nobody.
const DOMINANCE = 1.0;

// The ordered list of ids a swipe walks. Built from the same two sources
// currentStyle() resolves against, in the same order the row renders them, so
// the gesture and the row can never disagree about what "next" means.
export function styleOrder(state, builtIn) {
  return [...builtIn.map((s) => s.id), ...state.customCharsets.map((c) => c.id)];
}

// Cycle by n places, wrapping. Wrapping rather than clamping because there are
// three or four styles and a stop at either end just reads as a dead gesture.
export function cycleStyle(state, builtIn, n) {
  const order = styleOrder(state, builtIn);
  if (!order.length) return state.styleId;
  const at = order.indexOf(state.styleId);
  // An unknown id (a deleted custom charset) starts from the beginning rather
  // than throwing. currentStyle() already falls back the same way.
  const from = at === -1 ? 0 : at;
  return order[(((from + n) % order.length) + order.length) % order.length];
}

// attach(el, { onCycle, signal })
//
// onCycle(n) is called with -1 for an upward drag and +1 for a downward one.
// Up is "next", because a list moving up under a finger that moves up is how
// every scrollable thing on a phone behaves, and the style row reads
// left-to-right in the same order.
export function attachStyleGesture(el, { onCycle, signal = null } = {}) {
  let id = null;        // the pointer we are following
  let x0 = 0;
  let y0 = 0;
  let fired = false;    // one style change per drag, not one per THRESHOLD_PX
  let cancelled = false;

  const reset = () => { id = null; fired = false; cancelled = false; };

  el.addEventListener('pointerdown', (e) => {
    if (id !== null) {
      // A second finger. This is a pinch, not a swipe. See the header.
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
  // A pointer that leaves the element mid-drag is over the chrome, and the
  // browser stops sending moves for it unless it was captured. Ending here
  // means a drag off the top of the stage does not leave the handler armed.
  el.addEventListener('pointerleave', end, { signal });

  return { cancel: reset };
}
