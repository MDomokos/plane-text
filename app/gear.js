// Plane Text: the settings door, and the offline dot on it.
//
//   settingsGear(host, ctx)  ->  { el }
//
// A `[=]` glyph in the top-right corner of a picture screen's top band. Tapping
// it navigates to settings. It carries a gold dot when the app is NOT ready to
// run offline.
//
// ---------------------------------------------------------------------------
// WHY IT IS A COMPONENT AND NOT capture.css's .sc-gear
//
// It was capture's alone from 2026-08-09, which was already the fix for a worse
// problem: all three settings routes were registered with nothing linking to
// them, so calibration, the charset editor, the size test and the offline
// readout were unreachable. One door closed that.
//
// Two doors did not. Reaching settings from the viewer or the gallery meant
// navigating back to the viewfinder, which on a cold start opens a camera and
// may raise a permission prompt -- a getUserMedia call as the price of reading a
// version string. The door belongs on every picture screen, and three copies of
// one corner control is how the two recents strips started (thumbstrip.js).
//
// ---------------------------------------------------------------------------
// THE OFFLINE DOT
//
// The app has to be installed and cached before you board. app/offline.js knows
// whether it is, publishes it to state.offline, and until now said so in two
// places: `#app-header-slot` and the settings screen. The header is
// `display: none` on all three picture screens (shell.css), which is every
// screen a user is ever on, so the readout existed and nobody could see it.
//
// A dot rather than the string. `pt-a1b2c3 · update ready` in a 44px corner is a
// version number floating over a photograph. What is needed here is one bit --
// whether there is something to deal with -- and the door to the detail is what
// carries it. Same mark as the clipboard dot on the OPEN slot (actionbar.js),
// meaning the same thing: there is something behind this.
//
// Shown when NOT ready, not when ready: an always-lit tick is one nobody reads.
// The four states with something to say are caching, incomplete, unsupported,
// and an update waiting to be applied.
//
// The accessible name carries the reason, since a dot cannot. It goes on the
// button rather than on the dot, so the name reads "Settings, offline: 2
// missing" instead of adding a second focus stop for a decoration.

import { offlineLabel } from './offline.js';

// The states with something to say. `ready` is the silent one, unless an update
// is waiting, which is why this reads `update` and not only the state name.
function needsAttention(offline) {
  if (!offline) return false;
  if (offline.update) return true;
  return offline.state !== 'ready';
}

export function settingsGear(host, ctx) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'app-gear';
  // Brackets, like every other glyph here. A gear would be the only pictographic
  // icon in a monospace interface, and it renders differently in every font
  // stack without the hero's bar to hold the silhouette.
  el.textContent = '[=]';

  const dot = document.createElement('span');
  dot.className = 'app-gear-dot';
  // Decoration; the reason is in the button's name.
  dot.setAttribute('aria-hidden', 'true');
  dot.hidden = true;
  el.append(dot);

  function render() {
    const offline = ctx.state.get().offline;
    const on = needsAttention(offline);
    dot.hidden = !on;
    el.setAttribute('aria-label', on ? `Settings — ${offlineLabel(offline)}` : 'Settings');
  }

  el.addEventListener('click', () => ctx.navigate('settings'), { signal: ctx.signal });
  ctx.state.subscribe((_s, changed) => { if (changed.has('offline')) render(); }, { signal: ctx.signal });

  render();
  if (host) host.append(el);
  return { el };
}
