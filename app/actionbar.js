// Plane Text: the action bar.
//
// One bar, one position, on every screen. This module exists so the invariant
// is enforced in one place rather than re-implemented per screen, which is the
// shape of drift documented in README.md.
//
// The invariant:
//
//   The leftmost slot always leaves the screen.
//   The rightmost slot is always the primary action, and is always the hero.
//   Anything between them is secondary.
//
// The geometry is fixed but the split is not: two slots on the picture screens,
// three on the viewer. What never moves is which end means what, so a thumb can
// find the primary action without looking.
//
// "Leaves the screen" rather than "goes back", because at the root there is
// nowhere back to. On capture the leftmost slot is OPEN, a lateral move. Read
// literally that is an exception; read as "this is the way out of here" it is
// consistent. Recorded as a decision so it is not filed as a bug.
//
// The small slot is on the left because one-handed use is the capture screen's
// stated priority. For a right thumb the right edge is the easiest reach and
// the left the hardest, so the primary action takes the easy side and the
// control you least want to hit by accident takes the hard one. This is correct
// for a right hand and backwards for a left one. There is no handedness setting
// yet; that is an open item.
//
// The double-tap hazard, which this module only half solves. The primary action
// changes meaning without moving: tap the shutter, land on compose, and the
// thumb is still over the same 76% of the bar, which is now SHARE. A second tap
// opens the system share sheet for a message the user has not seen. `armAfter`
// is the guard. It is opt-in rather than automatic, because a bar built in
// response to a deliberate navigation should not make the user wait.

const MIN_TAP = 44;          // iOS HIG. Android's 48dp is checked at review.
const REF_VIEWPORT = 390;    // Layout sanity check only. Not a geometry figure
                             // the encoder shares, so not imported from src/.
const BAR_INSET = 28;        // horizontal padding the shell applies, both sides
const SLOT_GAP = 8;

// A slot:
//   { label, onTap, flex, hero?, dot?, aria?, armAfter? }
//
//   label     what it says. Uppercase in the source; the CSS does not
//             transform it, because a transform lies to a screen reader.
//   aria      accessible name, when the label is not one. The hero on capture
//             is labelled with a rotating sound-effect word, so its aria is
//             'Capture' and the word is decorative.
//   flex      share of the bar, in percent. Must total 100.
//   hero      the primary. Exactly one, and it must be last.
//   dot       a gold dot after the label. Used on OPEN when the clipboard
//             holds a payload.
//   armAfter  ms before a hero accepts taps.

function check(slots) {
  if (!Array.isArray(slots) || slots.length < 1) {
    throw new Error('actionBar: needs at least one slot');
  }
  const heroes = slots.filter((s) => s.hero);
  if (heroes.length !== 1) {
    throw new Error(`actionBar: expected exactly one hero slot, got ${heroes.length}`);
  }
  if (!slots[slots.length - 1].hero) {
    throw new Error('actionBar: the hero must be the last slot. The primary action is always rightmost.');
  }
  const total = slots.reduce((n, s) => n + s.flex, 0);
  if (Math.abs(total - 100) > 0.001) {
    throw new Error(`actionBar: slot flex must total 100, got ${total}`);
  }
  // Why 76/24 is a floor rather than a preference: at 390px it puts the small
  // slot on 48px, and anything above about 80/20 drops it under the minimum.
  const usable = REF_VIEWPORT - BAR_INSET - SLOT_GAP * (slots.length - 1);
  for (const s of slots) {
    const px = Math.round((usable * s.flex) / 100);
    if (px < MIN_TAP) {
      throw new Error(
        `actionBar: slot "${s.label}" is ${px}px at a ${REF_VIEWPORT}px viewport, under the ${MIN_TAP}px minimum. Rebalance the flex values.`,
      );
    }
  }
}

function slotEl(spec, signal) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = spec.hero ? 'pt-slot pt-slot-hero' : 'pt-slot';
  b.style.flex = `${spec.flex} 1 0`;
  if (spec.aria) b.setAttribute('aria-label', spec.aria);

  if (spec.hero) {
    // The brackets are the shutter: `[` and `]` closing toward each other is a
    // shutter closing. They are decorative, so a screen reader gets spec.aria
    // and never hears two brackets read out.
    const l = document.createElement('span');
    l.className = 'pt-bracket pt-bracket-l';
    l.setAttribute('aria-hidden', 'true');
    l.textContent = '[';
    const w = document.createElement('span');
    w.className = 'pt-hero-label';
    if (spec.aria) w.setAttribute('aria-hidden', 'true');
    w.textContent = spec.label;
    const r = document.createElement('span');
    r.className = 'pt-bracket pt-bracket-r';
    r.setAttribute('aria-hidden', 'true');
    r.textContent = ']';
    b.append(l, w, r);
  } else {
    const w = document.createElement('span');
    w.className = 'pt-slot-label';
    w.textContent = spec.label;
    b.append(w);
    if (spec.dot) {
      const d = document.createElement('span');
      d.className = 'pt-dot';
      d.setAttribute('aria-hidden', 'true');
      b.append(d);
    }
  }

  if (spec.armAfter) {
    b.disabled = true;
    const t = setTimeout(() => { b.disabled = false; }, spec.armAfter);
    signal?.addEventListener('abort', () => clearTimeout(t), { once: true });
  }

  if (spec.onTap) b.addEventListener('click', () => spec.onTap(b), { signal });
  return b;
}

// Fill ctx.bottomBar. Returns { fire } so a screen can play the clamp before
// navigating away.
export function actionBar(host, slots, { signal = null } = {}) {
  check(slots);
  const bar = document.createElement('div');
  bar.className = 'pt-actionbar';
  const els = slots.map((s) => slotEl(s, signal));
  bar.append(...els);
  host.replaceChildren(bar);

  const hero = els[els.length - 1];

  // The capture feedback in full. There is no flash over the frame and no
  // shutter sound: the brackets clamp inward over the word, then the screen
  // changes. The screen change confirms; this acknowledges the tap.
  //
  // Resolves when the animation ends so the caller can navigate straight after.
  // Under prefers-reduced-motion it resolves immediately rather than playing a
  // shorter animation, because a 110ms clamp cut down is a flicker.
  function fire() {
    const reduced = typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return Promise.resolve();
    hero.classList.add('is-firing');
    return new Promise((resolve) => {
      const t = setTimeout(() => { hero.classList.remove('is-firing'); resolve(); }, 230);
      signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }

  return { el: bar, hero, fire };
}
