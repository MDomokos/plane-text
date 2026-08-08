# Plane Text

Turns a photo into plain text so you can send it over networks that carry
messages but block images. Mostly this means in-flight wifi.

The photo becomes a grid of characters, either a calibrated ASCII ramp or
braille dots, that fits in a single message and stays readable on a phone
without zooming. The slider runs from 65 columns and about 5,700 characters up
to 130 columns and about 22,700, and opens in the middle at 98 columns. The
bottom of the range is too coarse to judge a picture at, which is why it is not
the default.

It installs as a web app and works offline, so it still runs once you are on
the plane. Settings reports which of those two is actually true right now:
being cached and being current are different states, and the readout gives a
build version rather than a tick that cannot tell them apart.


## Running it


```
npm run serve
```

Then open http://localhost:8080/plane-text/ (the script serves the parent
directory, so the app sits at that sub-path, same as on GitHub Pages).

The service worker needs a real origin. Opening `index.html` over `file://`
runs the app but not the offline shell, and settings says so rather than
pretending.

To encode a photo from the command line:

```
node tools/encode-cli.js photo.jpg -o out/msg.txt
```

BMP and PPM are read directly. Other formats need python3 and Pillow.

Tests:

```
npm test
```

Adding or removing a file under `app/` or `src/` means running `npm run
precache` and committing the regenerated manifest. A test fails if you forget.
That matters more than it looks: a hand-maintained list fails *open* on a new
file, so everything verifies, the readout goes green, and the app dies behind a
captive portal at 30,000 feet while telling you it is ready.

There is one optional check with a dependency, deliberately kept out of `npm
test` so the shipping code stays dependency-free. It mounts every screen in a
headless DOM and asserts each one builds what it claims to:

```
npm install --no-save jsdom && npm run smoke
```

## License

Not yet chosen.
