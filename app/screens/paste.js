// Plane Text: open. Route id `paste`, per the shell's v1 route table.
//
// The route is called paste and the screen is called OPEN. "Open" covers both
// doors here: a message someone sent you, and a photo you already have. SHOOT
// makes a new picture, OPEN brings in an existing one, and where it came from
// is something the screen explains rather than something the button has to say
// in 48 pixels.
//
// Why the library picker is here at all. Spec 9 puts "library picker" in the
// Out list for v1, spec 5.1 lists it in the bottom bar, and spec 8's
// camera-denied copy says "You can also pick a photo from your library". Three
// places, two answers. It is In, on two grounds:
//
//   1. Without it, declining the camera permission is a dead end. Spec 8
//      already promises the escape hatch; it did not exist.
//   2. It is probably the main source rather than the fallback. The scenario is
//      that you are on an aircraft, and the picture you want to send is usually
//      one from the trip you already took, not the wing outside the window.
//
// It costs about five lines: <input type="file" accept="image/*"> is the system
// picker.
//
// Paste leads and photos follow, and the hero matches the lead. The
// two-equal-tiles version of this screen was drawn and rejected: it put a paste
// tile beside a PASTE FROM CLIPBOARD button doing the same thing, which is a
// duplicate control. One primary target, one secondary row, and the hero slot
// is the primary target's action.
//
// The clipboard read has to be gesture-triggered. On iOS Safari
// navigator.clipboard.readText() requires a user gesture and shows a system
// paste confirmation, so a button is mandatory rather than a convenience (spec
// 5.5). Where readText is unavailable or denied the fallback is a focusable
// textarea, revealed only then: a software keyboard covering half the screen is
// the wrong default for an action that is a paste.

import { defineScreen } from '../screen.js';
import { register } from '../router.js';
import { actionBar } from '../actionbar.js';
import { messageName, currentWord } from '../words.js';
import * as recents from '../recents.js';
import { paintThumb } from '../thumb.js';
import { decodeMessage, looksLikeMessage, setSubject, takeSharedText } from '../pipeline.js';

// Longest edge a picked photo is decoded at.
//
// The grid is at most 130 cells wide and each cell samples a block of pixels,
// so anything past ~1600 px is thrown away by downscale() a moment later. It is
// not free to keep: toLuma() allocates one Float64Array element per pixel, so a
// 12 MP photo costs 96 MB to produce a 130-column picture.
const MAX_SOURCE_PX = 1600;

export default register(defineScreen({
  id: 'paste',
  title: 'Open',

  mount(el, ctx) {
    // Build into a child, never onto `el` itself. See capture.js: assigning
    // el.className wipes the shell's own .app-screen class off #app-screen,
    // which on this screen costs the padding and the scrolling.
    const root = document.createElement('div');
    root.className = 'sc-open';
    el.append(root);

    const heading = document.createElement('p');
    heading.className = 'sc-open-heading';
    heading.textContent = 'OPEN';

    // Door one: a message.
    const target = document.createElement('button');
    target.type = 'button';
    target.className = 'sc-target';
    const glyph = document.createElement('span');
    glyph.className = 'sc-target-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = '[ ]';
    const lead = document.createElement('span');
    lead.className = 'sc-target-lead';
    lead.textContent = 'A MESSAGE SOMEONE SENT';
    const sub = document.createElement('span');
    sub.className = 'sc-target-sub';
    sub.textContent = 'PASTE OR SHARE IT HERE';
    target.append(glyph, lead, sub);

    // The fallback field, hidden until the clipboard route fails. Revealing it
    // by default summons a keyboard nobody asked for.
    const field = document.createElement('textarea');
    field.className = 'sc-field';
    field.hidden = true;
    field.setAttribute('aria-label', 'Paste a Plane Text message');
    field.placeholder = 'Paste the message here';

    const problem = document.createElement('p');
    problem.className = 'sc-problem';
    problem.hidden = true;
    problem.setAttribute('role', 'status');

    // Door two: a photo.
    const libRow = document.createElement('button');
    libRow.type = 'button';
    libRow.className = 'sc-library';
    const libGlyph = document.createElement('span');
    libGlyph.className = 'sc-library-glyph';
    libGlyph.setAttribute('aria-hidden', 'true');
    libGlyph.textContent = '[+]';
    const libLabel = document.createElement('span');
    libLabel.textContent = 'A PHOTO YOU ALREADY HAVE';
    libRow.append(libGlyph, libLabel);

    // The real picker. Hidden, and clicked by the row above, so the visible
    // control can be styled like everything else on the screen.
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.hidden = true;

    const recentWrap = document.createElement('div');
    recentWrap.className = 'sc-recent';

    root.append(heading, target, field, problem, libRow, fileInput, recentWrap);

    function fail(message) {
      problem.textContent = message;
      problem.hidden = false;
    }

    function openMessage(text, name) {
      problem.hidden = true;
      if (!looksLikeMessage(text)) {
        // Spec 8, first row. Phrased as something the user can act on, since
        // the commonest cause is a partial copy.
        fail("That doesn't look like a Plane Text image. Make sure you copied the whole message.");
        return;
      }
      const decoded = decodeMessage(text);
      if (!decoded) {
        fail('This image looks incomplete. It may have been cut off; ask the sender to try a smaller size.');
        return;
      }
      const label = name || messageName(currentWord());
      recents.add({ name: label, message: text, source: 'received' });
      setSubject({ kind: 'theirs', message: text, name: label, decoded });
      ctx.navigate('compose');
    }

    async function fromClipboard() {
      // Three failure modes, one answer: reveal the textarea and let the user
      // paste by hand. No permission prompt of our own and no explanation they
      // did not ask for. The field appearing is the explanation.
      try {
        if (!navigator.clipboard || !navigator.clipboard.readText) throw new Error('unsupported');
        const text = await navigator.clipboard.readText();
        if (!text) throw new Error('empty');
        openMessage(text);
      } catch {
        field.hidden = false;
        field.focus();
      }
    }

    target.addEventListener('click', fromClipboard, { signal: ctx.signal });

    field.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text');
      if (text) {
        e.preventDefault();
        field.value = text;
        openMessage(text);
      }
    }, { signal: ctx.signal });

    // Desktop: a paste anywhere on the screen should work without hunting for
    // the field first. Harmless on mobile, where there is no such gesture.
    el.addEventListener('paste', (e) => {
      if (e.target === field) return;
      const text = e.clipboardData?.getData('text');
      if (text) { e.preventDefault(); openMessage(text); }
    }, { signal: ctx.signal });

    libRow.addEventListener('click', () => fileInput.click(), { signal: ctx.signal });

    // Decode a picked file to the { rgba, width, height } shape the encoder
    // wants. This is the same shape the camera will hand over, so nothing
    // downstream distinguishes the two sources.
    //
    // Two options on createImageBitmap earn their place. `imageOrientation:
    // 'from-image'` applies the EXIF rotation, without which every photo taken
    // in portrait on a phone arrives sideways and gets cropped to 3:4 along the
    // wrong axis. `resizeWidth/Height` does the downscale in the decoder rather
    // than on a canvas, so a 12 MP photo never exists at full size in memory:
    // toLuma() would otherwise allocate a 12-million-element Float64Array, 96 MB,
    // to produce a grid that is at most 130 cells wide.
    async function photoFromFile(file) {
      const probe = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, MAX_SOURCE_PX / Math.max(probe.width, probe.height));
      const w = Math.max(1, Math.round(probe.width * scale));
      const h = Math.max(1, Math.round(probe.height * scale));
      probe.close?.();

      const bitmap = await createImageBitmap(file, {
        imageOrientation: 'from-image',
        resizeWidth: w,
        resizeHeight: h,
        resizeQuality: 'high',
      });
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const g = canvas.getContext('2d');
      g.drawImage(bitmap, 0, 0);
      bitmap.close?.();
      return { rgba: g.getImageData(0, 0, w, h).data, width: w, height: h };
    }

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      // Resetting the value is what makes picking the SAME file twice fire
      // change a second time. Without it the second attempt looks like a dead
      // control.
      fileInput.value = '';
      if (!file) return;
      problem.hidden = true;
      try {
        const photo = await photoFromFile(file);
        setSubject({
          kind: 'mine',
          photo,
          word: currentWord(),
          takenAt: Date.now(),
          source: 'library',
        });
        // Through capture, not straight to the viewer. Changed 2026-08-09.
        //
        // Spec 5.1 and state.js justify the composer having no style picker
        // with "style was chosen at capture". That was false for an imported
        // photo: this picker dropped the user into `compose`, so a library
        // import had no moment at which style could be chosen.
        //
        // `?import=1` puts capture into its frozen sub-mode. The alternative
        // was a style row in the viewer, which would make styleId a two-owner
        // field and the ownership table wrong.
        ctx.navigate('capture', { import: '1' });
      } catch (err) {
        // HEIC is the case worth naming: iOS shoots it by default, and Chrome
        // and Firefox cannot decode it, so createImageBitmap rejects on a file
        // the system picker was happy to offer. Safari can, which makes this a
        // browser problem rather than a phone problem.
        console.error('paste: could not read the picked image', err);
        fail('That image could not be read. HEIC photos only work in Safari — try a JPEG or PNG.');
      }
    }, { signal: ctx.signal });

    // Arming. Deliberately the same code as the carousel's in compose.js, and
    // deliberately not factored out: it is twenty lines that close over one
    // screen's root and its own render function, and a shared module would have
    // to be handed both plus the glyph and the label wording, which is more
    // interface than duplication. The two must not DIVERGE, which is what the
    // cross-references in both files and in settings.js are for.
    //
    // Two taps, the second on a different glyph, as CLEAR ALL in settings.js is
    // two taps on a different word, and 3000ms is that button's window. This
    // pays for the sub-44px hit box in paste.css: small enough to miss, so it
    // has to be harmless to hit.
    //
    // One armed control at a time. Capture phase on the screen root so it beats
    // the click that opens a thumbnail, and any tap anywhere else on the screen
    // -- the paste target, the library row, another thumbnail -- disarms.
    //
    // No status line on this screen, so unlike compose.js the button says it
    // alone. That is the only difference between the two, and it is a
    // difference in what the screens have rather than in how delete behaves.
    const ARM_MS = 3000;
    let armedDel = null;
    let armedName = '';
    let armTimer = 0;

    function disarm() {
      clearTimeout(armTimer);
      armTimer = 0;
      if (!armedDel) return;
      armedDel.dataset.armed = '';
      armedDel.textContent = '×';
      armedDel.setAttribute('aria-label', `Delete ${armedName}`);
      armedDel = null;
      armedName = '';
    }

    // The label changes with the glyph. A screen reader user gets no colour and
    // no ✓, so without this the control announces itself as Delete twice and
    // the second announcement is the one that fires.
    function arm(del, name) {
      disarm();
      armedDel = del;
      armedName = name;
      del.dataset.armed = '1';
      del.textContent = '✓';
      del.setAttribute('aria-label', `Confirm deleting ${name}`);
      armTimer = setTimeout(disarm, ARM_MS);
    }

    root.addEventListener('pointerdown', (e) => {
      if (armedDel && !armedDel.contains(e.target)) disarm();
    }, { signal: ctx.signal, capture: true });
    ctx.signal.addEventListener('abort', () => clearTimeout(armTimer), { once: true });

    // The strip. Changed 2026-08-09:
    //
    //   1. The label and an empty state always render. This returned early on
    //      an empty list, so on first run the feature did not exist until it
    //      silently appeared one day.
    //   2. Every entry has a delete control. See recents.js for why delete
    //      forces the cap to become visible.
    //   3. Thumbnails come from app/thumb.js, shared with the carousel.
    function renderRecents() {
      // Before replaceChildren(), because the button the arming state points at
      // is about to stop existing and its timer would then disarm a detached
      // node while the strip shows nothing armed.
      disarm();
      recentWrap.replaceChildren();
      const list = recents.list();

      const label = document.createElement('p');
      label.className = 'sc-recent-label';
      label.textContent = 'RECENT';

      const note = recents.capNote(list.length);
      if (note) {
        const cap = document.createElement('span');
        cap.className = 'sc-recent-cap';
        cap.textContent = note;
        label.append(' ', cap);
      }

      recentWrap.append(label);

      if (!list.length) {
        // Phrased as what the strip is for rather than "nothing here", so a
        // first-time user learns it exists before they have anything in it.
        const empty = document.createElement('p');
        empty.className = 'sc-recent-empty';
        empty.textContent = 'Pictures you open or take appear here, so you can get back to them without pasting again.';
        recentWrap.append(empty);
        return;
      }

      const strip = document.createElement('div');
      strip.className = 'sc-recent-strip';

      for (const entry of list) {
        const wrap = document.createElement('div');
        wrap.className = 'sc-thumb-wrap';

        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'sc-thumb';
        item.setAttribute('aria-label', `Open ${entry.name}`);

        const box = document.createElement('span');
        box.className = 'sc-thumb-box';
        const pre = document.createElement('pre');
        pre.className = 'sc-thumb-art';
        pre.setAttribute('aria-hidden', 'true');
        box.append(pre);

        const name = document.createElement('span');
        name.className = 'sc-thumb-name';
        // The word alone, not the full name: the date does not fit, and the
        // word is what makes it recognisable. The full name is the accessible
        // label.
        name.textContent = entry.name.split(' ')[0];

        item.append(box, name);
        item.addEventListener('click', () => openMessage(entry.message, entry.name), { signal: ctx.signal });

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'sc-thumb-del';
        del.setAttribute('aria-label', `Delete ${entry.name}`);
        del.textContent = '×';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          if (del.dataset.armed !== '1') { arm(del, entry.name); return; }
          disarm();
          recents.remove(entry.name);
          renderRecents();
        }, { signal: ctx.signal });

        wrap.append(item, del);
        strip.append(wrap);

        // Draw after layout, so the box has a measured size to fit into.
        requestAnimationFrame(() => paintThumb(pre, entry.message, box, ctx.state.get()));
      }

      recentWrap.append(strip);
    }

    renderRecents();

    // A share-target launch. Consumed here rather than in main.js because the
    // decode can fail and this screen knows how to say so.
    //
    // Deferred a tick so the screen renders first: openMessage() navigates on
    // success, and the error path needs somewhere to draw if it does not.
    const incoming = takeSharedText();
    if (incoming) queueMicrotask(() => { if (!ctx.signal.aborted) openMessage(incoming); });

    // Action bar. Leftmost leaves the screen, and here it is a real back:
    // capture is where you came from.
    actionBar(ctx.bottomBar, [
      { label: 'SHOOT', flex: 24, onTap: () => ctx.navigate('capture') },
      {
        label: 'PASTE',
        aria: 'Paste from clipboard',
        flex: 76,
        hero: true,
        onTap: fromClipboard,
      },
    ], { signal: ctx.signal });
  },
}));
