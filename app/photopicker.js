// Plane Text: a photo you already have.
//
// The system picker, and the decode from a File to the { rgba, width, height }
// the encoder wants. Added 2026-08-09, when the camera-denied notice on capture
// needed the same door the gallery's ALBUM slot already had.
//
// WHY IT IS A MODULE. This was `fileInput` plus `photoFromFile()` plus a change
// handler inside paste.js's mount(), about sixty lines, and capture needed all
// of it. Copying them would have put two decoders in the app, and the one thing
// each would have got subtly differently is the pair of createImageBitmap
// options below -- both invisible until a specific phone produces a sideways or
// gigantic photograph. That is the drift README.md opens with five instances of.
//
// It is NOT in pipeline.js, which is the other candidate. pipeline.js is a pure
// bridge to src/ and touches no DOM; this owns an <input> and a click. A module
// that builds an element belongs beside thumbstrip.js and artefact.js.
//
//   photoPicker(host, {
//     onPhoto   ({ rgba, width, height }, file) -- decoded and downscaled
//     onError   (message) -- one sentence, already phrased for a user
//     signal    AbortSignal, as everywhere in this codebase
//   })
//   -> { open }
//
// `open()` must be called inside a user gesture. Every browser requires it for
// a file dialog, and the two call sites are both real taps.

// Longest edge a picked photo is decoded at.
//
// The grid is at most 130 cells wide and each cell samples a block of pixels,
// so anything past ~1600 px is thrown away by downscale() a moment later. It is
// not free to keep: toLuma() allocates one Float64Array element per pixel, so a
// 12 MP photo costs 96 MB to produce a 130-column picture.
const MAX_SOURCE_PX = 1600;

// HEIC is the case worth naming. iOS shoots it by default, and Chrome and
// Firefox cannot decode it, so createImageBitmap rejects on a file the system
// picker was happy to offer. Safari can, which makes this a browser problem
// rather than a phone problem, and the sentence says so rather than blaming the
// picture.
const UNREADABLE = 'That image could not be read. HEIC photos only work in Safari — try a JPEG or PNG.';

// Decode a picked file to the shape the encoder wants. This is the same shape
// the camera hands over, so nothing downstream distinguishes the two sources.
//
// Two options on createImageBitmap earn their place. `imageOrientation:
// 'from-image'` applies the EXIF rotation, without which every photo taken in
// portrait on a phone arrives sideways and gets cropped to 3:4 along the wrong
// axis. `resizeWidth/Height` does the downscale in the decoder rather than on a
// canvas, so a 12 MP photo never exists at full size in memory.
export async function photoFromFile(file) {
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

export function photoPicker(host, { onPhoto = null, onError = null, signal = null } = {}) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  // Hidden, and clicked by whatever visible control the screen already has, so
  // there is no second styled thing for that control to fight with. On the
  // gallery that is an action-bar slot; on capture it is a button in the
  // camera-denied notice.
  input.hidden = true;
  host.append(input);

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    // Resetting the value is what makes picking the SAME file twice fire change
    // a second time. Without it the second attempt looks like a dead control.
    input.value = '';
    if (!file) return;
    try {
      const photo = await photoFromFile(file);
      if (signal?.aborted) return;
      onPhoto?.(photo, file);
    } catch (err) {
      console.error('photopicker: could not read the picked image', err);
      if (signal?.aborted) return;
      onError?.(UNREADABLE);
    }
  }, { signal });

  return {
    el: input,
    open() { input.click(); },
  };
}
