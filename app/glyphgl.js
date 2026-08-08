// Plane Text: the grid renderer, in one draw call (spec 5.8).
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS, AND WHY IT IS NOT PREMATURE.
//
// Spec 5.8 says the atlas blit is fast enough and names WebGL as the next step
// "but measure before reaching for it". It has now been measured, and the 2D
// path does not hold:
//
//   65 columns, dpr 1, desktop Chrome, ART:
//     grab  0.3ms   encode  2.4ms   ATLAS BLIT ~30ms
//
// That is one drawImage per cell, 5,655 of them, and the cost tracks filled
// pixel area rather than cell count -- so a phone at dpr 3 fills nine times as
// much per cell. Ruled out along the way, so nobody re-investigates: per-frame
// layout thrash (0.1ms), on-screen versus detached canvas (no difference), and
// the fractional CSS scale of the display canvas (no difference). It is the
// blit itself.
//
// The teardown's claim that this architecture holds 30fps is still true -- for
// VectorCamera, which is native Android drawing into a Bitmap. It does not
// transfer to canvas2d in a browser, and the spec inherited it as though it
// would. That is the same shape as everything else in README.md's list: a
// figure measured on one artefact, trusted about another.
//
// ---------------------------------------------------------------------------
// HOW IT WORKS. One quad, two textures, one draw call.
//
//   u_atlas   the glyph atlas from app/atlas.js, uploaded once per atlas
//   u_index   cols x rows, one byte per cell, re-uploaded per frame
//
// The fragment shader works out which cell a pixel is in, reads that cell's
// glyph index out of the index texture, and samples the corresponding slot of
// the atlas. The per-frame upload is cols*rows bytes -- 14KB at 103 columns --
// against 14,111 drawImage calls. This is how terminal emulators render.
//
// Deliberately NOT instanced quads: one quad per cell would work and is the
// more obvious translation of the blit, but it needs an instancing extension on
// WebGL1 and gains nothing here. The whole grid is one triangle pair.
//
// The 2D path in atlas.js stays as the fallback and is not dead code -- it runs
// wherever WebGL is unavailable or the context is lost, and it is the reference
// this was checked against.

// Cell indices are read out of an 8-bit texture, so a codec whose cell values
// do not fit in a byte cannot use this path. Braille's 256 values are exactly
// representable, which is the tightest case in v1.
const MAX_GLYPHS = 256;

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  // Clip space is y-up and the grid is y-down. Flipping here rather than in the
  // texture upload keeps both textures in natural top-left-origin orientation.
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D u_index;
uniform sampler2D u_atlas;
uniform vec2 u_grid;    // cols, rows
uniform float u_count;  // glyphs in the atlas
uniform vec3 u_ink;
uniform vec3 u_bg;
varying vec2 v_uv;
void main() {
  vec2 g = v_uv * u_grid;
  vec2 cell = floor(g);
  vec2 local = g - cell;

  // Sample the index texture at the CENTRE of the texel, never at its edge.
  // At the edge a filtering unit is free to pick either neighbour, and the
  // failure is one column of cells showing its neighbour's glyph -- scrambled
  // per cell, globally plausible, which is this project's signature bug.
  float idx = texture2D(u_index, (cell + 0.5) / u_grid).r * 255.0;
  idx = floor(idx + 0.5);

  // The atlas is one row of cells, so the glyph selects a horizontal slot and
  // the position within the cell selects the pixel inside it.
  vec2 auv = vec2((idx + local.x) / u_count, local.y);

  // Alpha is the glyph's antialiased coverage. Reading it and mixing -- rather
  // than keying on a colour -- is spec 5.7 rule 1, and it is the one thing
  // VectorCamera's blit cannot do.
  float a = texture2D(u_atlas, auv).a;
  gl_FragColor = vec4(mix(u_bg, u_ink, a), 1.0);
}`;

function parseColor(css) {
  const s = String(css).trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) {
    const h = m[1];
    return [parseInt(h[0] + h[0], 16) / 255, parseInt(h[1] + h[1], 16) / 255, parseInt(h[2] + h[2], 16) / 255];
  }
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) {
    const h = m[1];
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x));
    return [(p[0] || 0) / 255, (p[1] || 0) / 255, (p[2] || 0) / 255];
  }
  // Unknown notation. Mid grey is visibly wrong rather than invisibly wrong,
  // which is the right failure for something only a token change can cause.
  return [0.5, 0.5, 0.5];
}

function compile(gl, type, source) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader failed to compile: ${log}`);
  }
  return sh;
}

// Try to build a WebGL renderer for `canvas`. Returns null rather than throwing
// when WebGL is simply not available: that is a fallback condition, not an
// error, and the caller has a working 2D path to fall back to.
export function createGlyphRenderer(canvas, { ink, bg, onLost = null } = {}) {
  const attrs = {
    alpha: false,
    antialias: false,        // we are drawing exact texels; AA would only blur
    depth: false,
    stencil: false,
    desynchronized: true,    // let the compositor run ahead of us where it can
    powerPreference: 'low-power',
    preserveDrawingBuffer: false,
    failIfMajorPerformanceCaveat: false,
  };

  let gl = null;
  try {
    gl = canvas.getContext('webgl2', attrs) || canvas.getContext('webgl', attrs);
  } catch {
    gl = null;
  }
  if (!gl) return null;

  let program;
  try {
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`program failed to link: ${gl.getProgramInfoLog(program)}`);
    }
  } catch (err) {
    console.warn('glyphgl: falling back to canvas2d --', err.message);
    return null;
  }

  const loc = {
    pos: gl.getAttribLocation(program, 'a_pos'),
    index: gl.getUniformLocation(program, 'u_index'),
    atlas: gl.getUniformLocation(program, 'u_atlas'),
    grid: gl.getUniformLocation(program, 'u_grid'),
    count: gl.getUniformLocation(program, 'u_count'),
    ink: gl.getUniformLocation(program, 'u_ink'),
    bg: gl.getUniformLocation(program, 'u_bg'),
  };

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

  const atlasTex = gl.createTexture();
  const indexTex = gl.createTexture();
  for (const tex of [atlasTex, indexTex]) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // NEAREST on both. The atlas is drawn at exactly 1:1, so there is nothing
    // to interpolate, and linear filtering on the INDEX texture would blend two
    // glyph numbers into a third that means something else entirely.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    // Both textures are non-power-of-two, which WebGL1 permits only with
    // CLAMP_TO_EDGE and no mipmaps. Set it explicitly rather than relying on
    // the default, because the symptom of getting it wrong is a black texture
    // with no error anywhere.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  // Rows of the index texture are cols bytes long and cols is arbitrary, so the
  // default 4-byte row alignment would skew every row after the first by up to
  // three cells. A shear, and a famous one.
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  // The atlas comes from a 2D canvas, whose pixels are premultiplied. We only
  // read .a, so this changes nothing today; it is set so that a later change to
  // read .rgb does not quietly get premultiplied values.
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

  let inkRGB = parseColor(ink);
  let bgRGB = parseColor(bg);
  let uploadedAtlas = null;
  let indexW = 0;
  let indexH = 0;
  let lost = false;
  let disposed = false;

  const onContextLost = (e) => {
    // Preventing the default is what makes restoration possible at all, but we
    // do not attempt to restore: the caller drops to the 2D path, which needs
    // no GPU resources and cannot be lost again.
    e.preventDefault();
    lost = true;
    if (onLost) onLost();
  };
  canvas.addEventListener('webglcontextlost', onContextLost);

  function draw(atlas, grid) {
    if (lost || disposed || gl.isContextLost()) return false;
    if (atlas.count > MAX_GLYPHS) return false;

    const w = grid.cols * atlas.dw;
    const h = grid.rows * atlas.dh;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);

    gl.useProgram(program);

    // The atlas changes on a style swap, an orientation change or a DPR change,
    // and not otherwise. Identity is enough: atlas.js caches and returns the
    // same object for the same key.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);
    if (uploadedAtlas !== atlas) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas.canvas);
      uploadedAtlas = atlas;
    }

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, indexTex);
    // texSubImage2D when the grid has not changed shape, which is the common
    // case: a full texImage2D reallocates, and reallocating 14KB twenty times a
    // second is work with nothing to show for it.
    if (indexW !== grid.cols || indexH !== grid.rows) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, grid.cols, grid.rows, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, grid.values);
      indexW = grid.cols;
      indexH = grid.rows;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, grid.cols, grid.rows, gl.LUMINANCE, gl.UNSIGNED_BYTE, grid.values);
    }

    gl.uniform1i(loc.atlas, 0);
    gl.uniform1i(loc.index, 1);
    gl.uniform2f(loc.grid, grid.cols, grid.rows);
    gl.uniform1f(loc.count, atlas.count);
    gl.uniform3fv(loc.ink, inkRGB);
    gl.uniform3fv(loc.bg, bgRGB);

    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(loc.pos);
    gl.vertexAttribPointer(loc.pos, 2, gl.FLOAT, false, 0, 0);

    // One oversized triangle rather than two. It covers the viewport with a
    // third fewer vertices and no seam down the diagonal.
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }

  return {
    backend: gl instanceof WebGL2RenderingContext ? 'webgl2' : 'webgl',
    draw,
    get lost() { return lost || gl.isContextLost(); },
    setColors(nextInk, nextBg) {
      inkRGB = parseColor(nextInk);
      bgRGB = parseColor(nextBg);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      canvas.removeEventListener('webglcontextlost', onContextLost);
      gl.deleteTexture(atlasTex);
      gl.deleteTexture(indexTex);
      gl.deleteBuffer(quad);
      gl.deleteProgram(program);
      // Ask the driver to drop the context now rather than at GC time. A
      // browser caps how many live WebGL contexts a page may have, and the cap
      // is low enough that a few navigations to and from capture would hit it.
      const ext = gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    },
  };
}
