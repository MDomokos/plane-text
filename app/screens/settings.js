// Plane Text: settings.
//
// Written 2026-08-09. All three settings routes were registered stubs with
// nothing in the app linking to them, so calibration, polarity, the charset
// editor, the size test and the offline readout were unreachable.
// #app-header-slot is display:none on the three picture screens, so the offline
// readout had no home at all until this screen existed.
//
// This is what makes the service worker visible, and the ordering matters: "it
// will work on a plane" has to be checkable on the ground, since checking it in
// the air is too late.
//
// Not a preferences panel to grow. Everything here is a fact about the
// installation or a control the spec already names. No handedness setting in
// particular: the hero is 76% of the action bar, so a left thumb reaches it
// without a regrip, and only the low-frequency 24% slot is awkward.

import { defineScreen } from '../screen.js';
import { register } from '../router.js';
import { CALIBRATION_DEFAULT } from '../../src/constants.js';
import { offlineLabel, verify, applyUpdate, checkForUpdate } from '../offline.js';
import * as recents from '../recents.js';

const CALIBRATION = [
  { id: 'auto', label: 'AUTO', blurb: 'Measure this device’s font once, then use the measured ramp' },
  { id: 'off', label: 'OFF', blurb: 'Use the shipped ramp. Fastest, and what the tests pin' },
  { id: 'force', label: 'FORCE', blurb: 'Re-measure on every encode. For checking a font, not for daily use' },
];

function row(parent, label) {
  const r = document.createElement('div');
  r.className = 'sc-set-row';
  const l = document.createElement('span');
  l.className = 'sc-set-label';
  l.textContent = label;
  r.append(l);
  parent.append(r);
  return r;
}

function section(parent, title) {
  const h = document.createElement('h2');
  h.className = 'sc-set-head';
  h.textContent = title;
  parent.append(h);
  const box = document.createElement('div');
  box.className = 'sc-set-box';
  parent.append(box);
  return box;
}

export default register(defineScreen({
  id: 'settings',
  title: 'Settings',

  mount(el, ctx) {
    const state = ctx.state;

    // Build into a child, never onto `el`.
    const root = document.createElement('div');
    root.className = 'sc-set';
    el.append(root);

    // --- offline ---------------------------------------------------------
    // First: the only thing here that can tell you the app will not do the one
    // thing it exists for.
    const offBox = section(root, 'OFFLINE');

    const offState = row(offBox, 'STATUS');
    const offValue = document.createElement('span');
    offValue.className = 'sc-set-value';
    offState.append(offValue);

    // A separate row from the status, because they answer different questions:
    // will this work on a plane, and which build is this.
    const verRow = row(offBox, 'VERSION');
    const verValue = document.createElement('span');
    verValue.className = 'sc-set-value';
    verRow.append(verValue);

    const missRow = row(offBox, 'MISSING');
    const missValue = document.createElement('span');
    missValue.className = 'sc-set-value is-warn';
    missRow.append(missValue);

    const actions = document.createElement('div');
    actions.className = 'sc-set-actions';
    const recheck = document.createElement('button');
    recheck.type = 'button';
    recheck.className = 'sc-set-btn';
    recheck.textContent = 'CHECK AGAIN';
    const update = document.createElement('button');
    update.type = 'button';
    update.className = 'sc-set-btn';
    update.textContent = 'APPLY UPDATE';
    actions.append(recheck, update);
    offBox.append(actions);

    function paintOffline() {
      const o = state.get().offline || {};
      offValue.textContent = offlineLabel(o);
      offValue.classList.toggle('is-warn', o.state === 'incomplete' || o.state === 'unsupported');
      offValue.classList.toggle('is-ok', o.state === 'ready');
      verValue.textContent = o.version || '—';
      const missing = o.missing || [];
      missRow.hidden = missing.length === 0;
      // Names rather than a count. The common cause is a file added without
      // running `npm run precache`, and the names say which.
      missValue.textContent = missing.slice(0, 4).join(', ') + (missing.length > 4 ? `, +${missing.length - 4}` : '');
      // Offering this with nothing waiting is a reload dressed as a fix.
      update.hidden = !o.update;
    }

    state.subscribe((_s, changed) => { if (changed.has('offline')) paintOffline(); }, { signal: ctx.signal });
    // CHECK AGAIN DID NOTHING. Fixed 2026-08-09.
    //
    // It was `() => { verify(); }`. Two faults, either one fatal.
    //
    // verify() has no side effects: it returns a promise carrying the worker's
    // reply. The store patch lives in run(), a closure inside startOffline()
    // that this screen has no reference to. So the click posted a message, the
    // worker audited its cache, replied down the MessageChannel, and the answer
    // was dropped. Nothing repainted. checkedAt did not even move, so the one
    // observable thing the button could have changed did not change.
    //
    // And the question was the wrong one anyway. PT_VERIFY asks the CURRENT
    // controller to audit ITS OWN cache -- "is the build I am running
    // complete". A button labelled CHECK AGAIN, sitting under a version string,
    // in an app that ships from a push to main, is read as "is there a newer
    // one", and nothing in the app asked that. See checkForUpdate() in
    // offline.js.
    //
    // Now it does both, in that order, and reports. Awaiting the update check
    // first matters: if it finds a new worker, the registration's updatefound
    // handler fires and patches `update: true`, and the APPLY UPDATE button is
    // hidden until it does.
    recheck.addEventListener('click', async () => {
      recheck.disabled = true;
      recheck.textContent = 'CHECKING…';
      try {
        await checkForUpdate({ force: true });
        const result = await verify();
        // Patched here rather than left to startOffline's run(), because this
        // screen is where the readout is and a button that changes nothing on
        // screen is the bug being fixed.
        state.set({
          offline: {
            ...state.get().offline,
            ...(result
              ? {
                state: result.ready ? 'ready' : 'incomplete',
                ready: Boolean(result.ready),
                version: result.version || null,
                missing: result.missing || [],
                shell: Boolean(result.shell),
              }
              : {}),
            checkedAt: Date.now(),
          },
        });
      } finally {
        if (recheck.isConnected) { recheck.disabled = false; recheck.textContent = 'CHECK AGAIN'; }
      }
    }, { signal: ctx.signal });
    update.addEventListener('click', () => { applyUpdate(); }, { signal: ctx.signal });

    // --- calibration -----------------------------------------------------
    // The one encoder setting with a visible effect: the shipped ramp was
    // calibrated on a Linux font and regressed on a real device font.
    const calBox = section(root, 'CALIBRATION');
    const calRow = document.createElement('div');
    calRow.className = 'sc-set-choice';
    const calButtons = new Map();
    for (const opt of CALIBRATION) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sc-set-opt';
      b.textContent = opt.label;
      b.title = opt.blurb;
      b.addEventListener('click', () => state.set({ calibration: opt.id }), { signal: ctx.signal });
      calButtons.set(opt.id, b);
      calRow.append(b);
    }
    calBox.append(calRow);
    const calBlurb = document.createElement('p');
    calBlurb.className = 'sc-set-blurb';
    calBox.append(calBlurb);

    // --- polarity --------------------------------------------------------
    // Spec calls this "no v1 UI", which was defensible while nothing here was
    // reachable. One row, and it changes what the recipient sees.
    const invBox = section(root, 'POLARITY');
    const invRow = row(invBox, 'DARK BACKGROUND');
    const invBtn = document.createElement('button');
    invBtn.type = 'button';
    invBtn.className = 'sc-set-toggle';
    invRow.append(invBtn);
    invBtn.addEventListener('click', () => state.set({ invert: !state.get().invert }), { signal: ctx.signal });
    const invBlurb = document.createElement('p');
    invBlurb.className = 'sc-set-blurb';
    invBlurb.textContent = 'Light characters on black, the way the app renders. Turning this off inverts the message for a light chat theme.';
    invBox.append(invBlurb);

    // --- destinations ----------------------------------------------------
    const goBox = section(root, 'MORE');
    for (const [path, label, blurb] of [
      ['settings/charsets', 'CHARACTER SETS', 'Add or edit a ramp'],
      ['settings/size-test', 'SIZE TEST', 'Find out what your network actually passes'],
    ]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sc-set-link';
      const l = document.createElement('span');
      l.className = 'sc-set-label';
      l.textContent = label;
      const d = document.createElement('span');
      d.className = 'sc-set-blurb';
      d.textContent = blurb;
      b.append(l, d);
      b.addEventListener('click', () => ctx.navigate(path), { signal: ctx.signal });
      goBox.append(b);
    }

    // --- recents ---------------------------------------------------------
    // clear() existed and was surfaced nowhere. With per-entry delete on the
    // strip and the carousel, the bulk control belongs here: a destructive
    // control on a picture screen is one you can hit while framing.
    const recBox = section(root, 'RECENT PICTURES');
    const recRow = row(recBox, 'STORED');
    const recValue = document.createElement('span');
    recValue.className = 'sc-set-value';
    recRow.append(recValue);
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'sc-set-btn is-danger';
    clearBtn.textContent = 'CLEAR ALL';
    const recActions = document.createElement('div');
    recActions.className = 'sc-set-actions';
    recActions.append(clearBtn);
    recBox.append(recActions);
    const recBlurb = document.createElement('p');
    recBlurb.className = 'sc-set-blurb';
    recBlurb.textContent = `Up to ${recents.MAX} messages are kept so you can get back to one after leaving the app. The oldest drops off. This is not a photo library and nothing here is backed up.`;
    recBox.append(recBlurb);

    // Two taps, the second on a different word. There is no undo.
    //
    // ARM_MS is thumbstrip.js's name for this same 3000, and the two are still
    // separate numbers. That was argued out when the strip's delete was built
    // -- "two disarm timings for one idiom would be two idioms" -- and it is
    // recorded here as well now that both controls DRAW the window, because a
    // drift between them is visible from 2026-08-09 onward rather than only
    // being felt.
    const ARM_MS = 3000;
    let arming = 0;
    clearBtn.addEventListener('click', () => {
      if (clearBtn.dataset.armed !== '1') {
        clearBtn.dataset.armed = '1';
        clearBtn.textContent = 'TAP AGAIN TO CLEAR';
        clearBtn.style.setProperty('--pt-arm-ms', `${ARM_MS}ms`);
        clearTimeout(arming);
        arming = setTimeout(() => {
          clearBtn.dataset.armed = '';
          clearBtn.textContent = 'CLEAR ALL';
        }, ARM_MS);
        return;
      }
      clearTimeout(arming);
      recents.clear();
      clearBtn.dataset.armed = '';
      clearBtn.textContent = 'CLEAR ALL';
      paintRecents();
    }, { signal: ctx.signal });
    ctx.signal.addEventListener('abort', () => clearTimeout(arming), { once: true });

    function paintRecents() {
      const n = recents.list().length;
      recValue.textContent = `${n} of ${recents.MAX}`;
      clearBtn.disabled = n === 0;
    }

    function paint() {
      const s = state.get();
      for (const [id, b] of calButtons) {
        const on = id === s.calibration;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-pressed', String(on));
      }
      const chosen = CALIBRATION.find((c) => c.id === s.calibration) || CALIBRATION[0];
      calBlurb.textContent = chosen.blurb
        + (s.calibration === CALIBRATION_DEFAULT ? ' · the default' : '');

      invBtn.textContent = s.invert ? 'ON' : 'OFF';
      invBtn.classList.toggle('is-on', Boolean(s.invert));
      invBtn.setAttribute('aria-pressed', String(Boolean(s.invert)));
    }

    state.subscribe((_s, changed) => {
      if (changed.has('calibration') || changed.has('invert')) paint();
    }, { signal: ctx.signal });

    // No action bar. These routes keep the header, so its back button is
    // already there, and a bar with one control would be a second way to do the
    // only thing this screen offers. See shell.css.

    paint();
    paintOffline();
    paintRecents();
    verify();
  },
}));
