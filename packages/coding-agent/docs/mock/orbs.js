/* orbs.js — thinking-orbs 原生 JS 包装层（omp mock 用）
 * 依赖 orbs-engine.js（thinking-orbs v0.3.1 engine 提取，MIT）
 * 用法：<canvas data-orb data-orb-state="composing" data-orb-size="64" data-orb-theme="light"></canvas>
 *       <script src="../orbs-engine.js"></script><script src="../orbs.js"></script>
 * 或 JS 动态：Orb.mount(canvas, { state, size, theme }) / Orb.setState(canvas, state)
 * 状态映射（wire phase → orb state）：
 *   streaming → composing · executing_tool → solving · listening → listening
 *   connecting → connecting · planning → shaping · idle → breathing
 */
(function () {
  "use strict";
  const E = window.OrbsEngine;
  if (!E) { console.error("orbs.js: OrbsEngine not loaded"); return; }

  const LABELS = {
    working: "Working…", searching: "Searching…", solving: "Solving…",
    listening: "Listening…", connecting: "Connecting…", weaving: "Weaving…",
    composing: "Composing…", breathing: "Thinking…", shaping: "Shaping…",
  };

  function isDark(el) {
    for (let n = el; n; n = n.parentElement) {
      const t = n.getAttribute && n.getAttribute("data-theme");
      if (t === "dark") return true;
      if (t === "light") return false;
      if (n.classList && n.classList.contains("dark")) return true;
      if (n.classList && n.classList.contains("light")) return false;
    }
    return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function reduceMotion() {
    return typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function mount(canvas, opts) {
    const o = Object.assign({ state: "working", size: 64, theme: "auto", speed: 1, paused: false }, opts);
    const size = o.size === 20 ? 20 : 64;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    canvas.style.width = size + "px";
    canvas.style.height = size + "px";
    canvas.style.display = "block";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", LABELS[o.state] || o.state);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    const dark = o.theme === "auto" ? isDark(canvas) : o.theme === "dark";
    const { mode, speed, opts: modeOpts } = E.resolvePreset(o.state, size);
    const draw = E.MODE_DRAWS[mode];
    const w = speed * o.speed;

    function frame(t) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      draw(ctx, size, t, dark, modeOpts);
    }

    if (reduceMotion() || o.paused) { frame(0.6); return { canvas, setState() {}, destroy() {} }; }

    let raf = 0, running = false, visible = true;
    function loop() {
      frame(performance.now() / 1000 * w);
      if (running) raf = requestAnimationFrame(loop);
    }
    function start() { if (!running) { running = true; raf = requestAnimationFrame(loop); } }
    function stop() { running = false; cancelAnimationFrame(raf); }

    frame(performance.now() / 1000 * w);
    let io = null;
    if (typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver(([en]) => {
        visible = en.isIntersecting;
        if (visible && document.visibilityState !== "hidden") start(); else stop();
      });
      io.observe(canvas);
    }
    const onVis = () => { if (document.visibilityState === "hidden") stop(); else if (visible) start(); };
    document.addEventListener("visibilitychange", onVis);
    if (!io) start();

    return {
      canvas,
      setState(newState) {
        stop(); io && io.disconnect(); document.removeEventListener("visibilitychange", onVis);
        const fresh = mount(canvas, Object.assign({}, o, { state: newState }));
        canvas._orb = fresh;
      },
      destroy() { stop(); io && io.disconnect(); document.removeEventListener("visibilitychange", onVis); },
    };
  }

  function scan(root) {
    (root || document).querySelectorAll("canvas[data-orb]").forEach(c => {
      if (c._orb) return;
      c._orb = mount(c, {
        state: c.dataset.orbState || "working",
        size: parseInt(c.dataset.orbSize || "64", 10),
        theme: c.dataset.orbTheme || "auto",
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => scan());
  } else { scan(); }

  window.Orb = { mount, scan, setState(c, s) { c._orb && c._orb.setState(s); } };
})();
