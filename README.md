# Plane Text

Turns a photo into plain text so you can send it over networks that carry
messages but block images. Mostly this means in-flight wifi.

The photo becomes a grid of characters, either a calibrated ASCII ramp or
braille dots, that fits in a single message and stays readable on a phone
without zooming. The default is 65 columns and about 5,700 characters, and the
size slider goes up to 130 columns and about 22,700.

It installs as a web app and works offline, so it still runs once you are on
the plane.


## Running it


```
npm run serve
```

Then open http://localhost:8080/plane-text/ (the script serves the parent
directory, so the app sits at that sub-path, same as on GitHub Pages).

To encode a photo from the command line:

```
node tools/encode-cli.js photo.jpg -o out/msg.txt
```

BMP and PPM are read directly. Other formats need python3 and Pillow.

Tests:

```
npm test
```

## License

Not yet chosen.
