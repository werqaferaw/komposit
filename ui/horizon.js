// The backdrop behind the main area: a soft white-grey light rising from the
// bottom of the black page and fading out around the middle. No hard shape:
// it's a gradient whose edge dissolves into film grain, so it reads as light
// through haze. The grain flickers and the light drifts and breathes very
// slowly. Full strength on the start screen, dimmed behind a chat.
//
// One WebGL fragment shader (about 0.1 ms a frame); a CSS gradient when WebGL
// is missing. It's a still frame when the user asked for reduced motion or
// the machine draws it slowly, and it stops while the window is hidden.
(() => {
  const main = document.querySelector("main");
  const cv = document.getElementById("horizon");
  if (!main || !cv) return;

  const gl = cv.getContext("webgl", { antialias: false, alpha: false, preserveDrawingBuffer: false, powerPreference: "low-power" });
  if (!gl) { main.classList.add("noglow"); return; }

  const VS = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;
  const FS = `
    precision highp float;
    uniform vec2 uC;        // centre of the light, device px (origin bottom-left)
    uniform vec2 uRad;      // its radii, device px
    uniform float uPeak;    // brightness at the centre (0..1 of white)
    uniform float uSeed;    // changes every frame: moving grain
    uniform float uGrain;   // grain cell, device px

    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * .1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    void main() {
      vec2 px = gl_FragCoord.xy;
      float n = hash(floor(px / uGrain) + uSeed * 61.7);

      float d = length((px - uC) / uRad);
      // a long, eased gradient from the centre out to the rim
      float a = 1.0 - smoothstep(0.0, 1.0, d);
      a = pow(a, 1.5);
      // grain is strongest where the light thins out, so the edge dissolves
      // into speckle rather than ending in a clean gradient
      float rim = smoothstep(0.0, 0.25, a) * (1.0 - smoothstep(0.25, 0.9, a));
      a = clamp(a + (n - 0.5) * (0.06 + 0.80 * rim), 0.0, 1.0);

      vec3 black = vec3(10.0, 11.0, 12.0) / 255.0;   // --bg
      vec3 light = vec3(0.86, 0.87, 0.88);            // neutral, a touch cool
      vec3 col = mix(black, light, a * uPeak);
      col += (n - 0.5) * 0.012;                       // faint grain everywhere
      gl_FragColor = vec4(col, 1.0);
    }`;

  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; };
  const vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, FS);
  if (!vs || !fs) { main.classList.add("noglow"); return; }
  const prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { main.classList.add("noglow"); return; }
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = (n) => gl.getUniformLocation(prog, n);
  const uC = U("uC"), uRad = U("uRad"), uPeak = U("uPeak"), uSeed = U("uSeed"), uGrain = U("uGrain");

  // Strength: full on the start screen, dimmed behind a chat; eased between.
  const PEAK_HOME = 0.30, PEAK_CHAT = 0.12;
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  const target = () => (main.classList.contains("home") ? PEAK_HOME : PEAK_CHAT);
  let W = 0, H = 0, dpr = 1, peak = target();

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = cv.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width * dpr)); H = Math.max(1, Math.round(r.height * dpr));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    gl.viewport(0, 0, W, H);
  }

  const TAU = Math.PI * 2;
  function draw(t) {
    const s = t / 1000;
    // Wide and low: centred under the bottom edge, its rim reaching about the
    // middle of the page. Breathes and wanders very slowly.
    const breathe = 1 + 0.04 * Math.sin(TAU * s / 14);
    const rx = W * 0.80 * breathe, ry = H * 1.10 * breathe;
    const cx = W * 0.5 + W * 0.06 * Math.sin(TAU * s / 31);
    const cy = -H * 0.16 + H * 0.025 * Math.sin(TAU * s / 21 + 1.3);
    gl.uniform2f(uC, cx, cy);
    gl.uniform2f(uRad, rx, ry);
    gl.uniform1f(uPeak, peak);
    gl.uniform1f(uSeed, (Math.floor(s * 24) % 997) / 997);
    gl.uniform1f(uGrain, Math.max(1, Math.round(dpr * 1.5)));   // ~1.5 CSS px grain
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // 24 fps on the start screen, 12 behind a chat. The first frames are timed;
  // if this machine draws it slowly it stays a still frame.
  let raf = 0, last = 0, timed = 0, spent = 0, tooSlow = false;
  const live = () => !document.hidden;
  const moving = () => !still.matches && !tooSlow;
  function frame(now) {
    peak += (target() - peak) * 0.12;
    if (Math.abs(target() - peak) < 0.002) peak = target();
    if (timed < 6) {
      const t0 = performance.now(); draw(now); gl.finish();
      spent += performance.now() - t0; timed++;
      if (timed === 6 && spent / 6 > 14) tooSlow = true;
    } else draw(now);
  }
  function loop(now) {
    raf = 0;
    if (!live()) return;
    const fps = main.classList.contains("home") ? 24 : 12;
    if (now - last >= 1000 / fps) { last = now; frame(now); }
    if (moving() || peak !== target()) raf = requestAnimationFrame(loop);
  }
  function kick() { if (!raf && live()) { resize(); frame(performance.now()); raf = requestAnimationFrame(loop); } }

  new ResizeObserver(() => { resize(); if (live()) draw(performance.now()); }).observe(cv);
  new MutationObserver(kick).observe(main, { attributes: true, attributeFilter: ["class"] });
  document.addEventListener("visibilitychange", kick);
  still.addEventListener?.("change", kick);
  cv.addEventListener("webglcontextlost", (e) => { e.preventDefault(); main.classList.add("noglow"); });

  // Debug hooks: state, and a still image of the current frame.
  window.__horizon = () => ({ timed, avgMs: timed ? +(spent / timed).toFixed(1) : null, tooSlow, moving: moving(), peak: +peak.toFixed(3) });
  window.__horizon.snap = (t = performance.now()) => { resize(); draw(t); return cv.toDataURL("image/png"); };
  kick();
})();
