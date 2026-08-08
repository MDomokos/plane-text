// The one list of screen imports. The router does not import screens. This
// does, for their registration side effect.
//
// Adding a screen: create app/screens/<id>.js, add one line here, run
// `npm run precache`. Nothing else in app/ changes.
//
// Its own file so four agents adding four lines conflict on four adjacent
// lines and nothing else.
import './capture.js';
import './compose.js';
import './paste.js';
import './settings.js';
import './size-test.js';
import './charsets.js';
