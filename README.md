# Plane Text

A PWA that sends photographs as plain text, for networks that pass text
messages but block images — chiefly in-flight wifi.

A photo is reduced to a grid of characters (braille, block elements, or an
ASCII ramp) that fits in a single message and stays readable on a phone screen
without zooming. Roughly 108 columns, about 4,500 characters.

Status: in development.

## Running it

No dependencies, no build step, no framework.

```
npm test                                            # unit tests
node tools/encode-cli.js photo.jpg --sweep          # grid sizes vs character cost
node tools/encode-cli.js photo.jpg -o out/msg.txt   # encode a message
node tools/verify-render.js photo.jpg 108 out/x.pgm # decode the text back to dots
```

Serve `index.html` from any static server to run the app.

BMP and PPM are read natively. Other formats go through python3 + Pillow.

## Layout

| Path | Contents |
|---|---|
| `src/constants.js` | Budget and geometry figures, defined once |
| `src/sizing.js` | Character range, columns per codec, line-height, aspect error |
| `src/tone.js` | Luminance, unsharp, auto-levels, gamma, downscale, dither |
| `src/cells.js` | Pixels to cell grid to text rows, and back |
| `src/wrap.js` | The `<pre>` wrapper and the fit shim |
| `src/calibrate.js` | Ramp selection from measured glyph coverage |
| `src/styles.js` | Codec, charset and tone presets |
| `src/lint.js` | Banned-character and leading-whitespace checks |
| `src/encode.js` | The pipeline |
| `app/` | PWA shell: routing, state, screens |
| `tools/` | CLI harnesses for encoding, benchmarking and verification |
| `test/` | Unit tests |

Nothing in `src/` touches the DOM, so it all runs in Node.

## License

Not yet chosen.
