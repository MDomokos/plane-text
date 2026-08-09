// Plane Text: the two things motion needs from JavaScript.
//
// Everything else about motion is CSS, and deliberately: a duration in a
// stylesheet can be read next to the thing it moves, and a duration in JS
// cannot. This file exists for the two cases CSS genuinely cannot cover.
//
// ---------------------------------------------------------------------------
// 1. reduced()
//
// There is a global `prefers-reduced-motion` guard in shell.css that flattens
// every transition and animation in the app, and it is the mechanism for
// almost all of this. But it cannot reach two kinds of code:
//
//   - A behaviour that is not an animation. actionbar.js's fire() resolves a
//     promise when the clamp ends and the caller navigates after it; under
//     reduced motion the right answer is to resolve immediately, not to play a
//     1ms clamp. That is a control-flow decision, not a duration.
//   - The Web Animations API. el.animate() takes its duration as a number and
//     no media query applies to it, so a CSS guard silently does nothing to it.
//     This is worth stating because it is the failure mode that looks fixed.
//
// It was written out three times before this file: actionbar.js, capture.js's
// warm-up painter, and the reduced check that the router now needs as well.
// Three copies of a media-query string is how a fourth one gets it wrong.
//
// Not cached. matchMedia is cheap, the setting can change while the app is
// open, and a cached `false` from launch would leave the app animating at a
// user who has just asked it to stop.
export function reduced() {
  return typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ---------------------------------------------------------------------------
// 2. flash(el)
//
// A 110ms opacity fade over an element whose text has just been replaced.
//
// .app-status already transitions `color` over --pt-dur-base, so a warn -> ok
// change animated the colour of a string that had been swapped out a frame
// earlier: the new text appeared instantly, wearing the old text's colour, and
// then drifted to its own. The transition was animating the wrong event.
//
// Fading the element makes the two agree -- the text and its colour arrive
// together -- and it is the only way to mark a change in a line that is
// otherwise identical, which is the `Deleted zap` -> `Deleted kachunk` case.
//
// It is here rather than in a status component because there is no status
// component: three screens each build their own .app-status and their own
// say(), which is a triplication worth removing but not in a motion change.
// This is the one line of it they can share today.
//
// Returns nothing and throws nothing. A status line is decoration over a
// message that has already been set; an engine without el.animate must still
// show the text.
export function flash(el) {
  if (!el || reduced() || typeof el.animate !== 'function') return;
  el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 110, easing: 'linear' });
}
