/*!
 * claude-motion v1 - class-driven scroll animation for page builders (Divi, Elementor).
 *
 * Add a class to any native module/widget/container (Divi: CSS Class field;
 * Elementor: Advanced > CSS Classes). Classes may sit on the module wrapper -
 * the runtime finds the real heading/image/text inside.
 *
 *   m-split      headline revealed line by line from a mask (SplitText)
 *   m-reveal     fade + rise into view                  (m-d1..m-d6 add 0.1s delay steps)
 *   m-stagger    each direct child reveals in turn      (rows, columns, containers, lists)
 *   m-parallax   image drifts inside its frame while scrolling
 *   m-parallax-bg  section/container background image drifts while scrolling
 *   m-clip       media opens from an inset clip as it scrolls into view
 *   m-count      the first number inside counts up from 0 (final value stays in the HTML)
 *   m-marquee    contents scroll sideways forever; direction follows scroll direction
 *   m-smooth     on any element: turn on Lenis smooth scrolling for the page
 *
 * Needs gsap + ScrollTrigger (+ SplitText for m-split, Lenis for m-smooth).
 * Content is never hidden unless this script is running: the loader adds
 * html.m-js, and removes it again after 3s if the libraries never arrive.
 * prefers-reduced-motion: everything is shown, nothing moves.
 */
(function () {
  'use strict';
  var root = document.documentElement;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function finish() { root.classList.remove('m-js'); root.classList.add('m-ready'); window.__claudeMotion = true; }

  if (window.__claudeMotion) return;
  if (reduce || !window.gsap || !window.ScrollTrigger) { finish(); return; }

  var gsap = window.gsap;
  gsap.registerPlugin(window.ScrollTrigger);
  if (window.SplitText) gsap.registerPlugin(window.SplitText);
  var ST = window.ScrollTrigger;

  // Structural CSS the effects need (overflow for parallax, marquee track).
  var css = document.createElement('style');
  css.textContent =
    '.m-parallax,.m-parallax .et_pb_image_wrap,.m-parallax .elementor-widget-container{overflow:hidden}' +
    '.m-parallax img{will-change:transform}' +
    '.m-marquee{overflow:hidden}.m-marquee-track{display:flex;width:max-content;will-change:transform}' +
    '.m-marquee-track>*{flex:none;margin-right:var(--m-gap,56px)}' +
    // SplitText wraps each line in <line-class>-mask with overflow:clip; pad it so
    // descenders (g, y, q) aren't cut off at a tight hero line-height.
    '.m-line-mask{padding-bottom:.26em;margin-bottom:-.26em}' +
    'html.lenis,html.lenis body{height:auto}.lenis.lenis-smooth{scroll-behavior:auto!important}' +
    '.lenis.lenis-stopped{overflow:hidden}';
  document.head.appendChild(css);

  var all = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };
  var delayOf = function (el) { var m = (el.className.match ? el.className : '').match(/\bm-d([1-9])\b/); return m ? m[1] * 0.1 : 0; };
  var inner = function (el, sel) { return el.matches(sel) ? el : (el.querySelector(sel) || el); };
  // Children of a builder element: Elementor boxed containers wrap them in .e-con-inner.
  var kids = function (el) {
    var box = el.querySelector(':scope > .e-con-inner');
    return Array.prototype.slice.call((box || el).children).filter(function (c) {
      return c.nodeType === 1 && !/^(STYLE|SCRIPT|LINK)$/.test(c.tagName) && c.offsetParent !== null;
    });
  };
  var trig = function (el, start) { return { trigger: el, start: start || 'top 88%', once: true }; };

  // Always fromTo(... -> autoAlpha:1), never from(): the loader's CSS hides these
  // elements until setup() finishes, and from() would read that hidden opacity as
  // its end value - animating from invisible to invisible.
  function setup() {
    // Headlines: masked line reveal. Wait for webfonts - line breaks depend on them.
    all('.m-split').forEach(function (el) {
      var target = inner(el, 'h1,h2,h3,h4,h5,h6,.elementor-heading-title,p');
      if (!window.SplitText) { gsap.fromTo(target, { autoAlpha: 0, y: 30 }, { autoAlpha: 1, y: 0, duration: 1, ease: 'power3.out', delay: delayOf(el), scrollTrigger: trig(el) }); return; }
      var split = new window.SplitText(target, { type: 'lines', mask: 'lines', linesClass: 'm-line' });
      gsap.from(split.lines, {
        yPercent: 110, duration: 1.1, ease: 'expo.out', stagger: 0.09, delay: delayOf(el),
        scrollTrigger: trig(el),
        onComplete: function () { split.revert(); },
      });
    });

    all('.m-reveal').forEach(function (el) {
      gsap.fromTo(el, { autoAlpha: 0, y: 36 }, { autoAlpha: 1, y: 0, duration: 1, ease: 'power3.out', delay: delayOf(el), scrollTrigger: trig(el) });
    });

    all('.m-stagger').forEach(function (el) {
      var items = kids(el);
      if (!items.length) return;
      gsap.fromTo(items, { autoAlpha: 0, y: 40 }, { autoAlpha: 1, y: 0, duration: 0.9, ease: 'power3.out', stagger: 0.1, delay: delayOf(el), scrollTrigger: trig(el) });
    });

    all('.m-parallax').forEach(function (el) {
      var img = inner(el, 'img');
      gsap.set(img, { scale: 1.16, transformOrigin: '50% 50%' });
      gsap.fromTo(img, { yPercent: -7 }, { yPercent: 7, ease: 'none', scrollTrigger: { trigger: el, start: 'top bottom', end: 'bottom top', scrub: true } });
    });

    all('.m-parallax-bg').forEach(function (el) {
      gsap.fromTo(el, { backgroundPosition: '50% 0%' }, { backgroundPosition: '50% 100%', ease: 'none', scrollTrigger: { trigger: el, start: 'top bottom', end: 'bottom top', scrub: true } });
    });

    all('.m-clip').forEach(function (el) {
      var target = inner(el, '.et_pb_image_wrap,.elementor-widget-container,img');
      gsap.fromTo(target,
        { clipPath: 'inset(10% 7% 10% 7% round 24px)' },
        { clipPath: 'inset(0% 0% 0% 0% round 24px)', ease: 'none', scrollTrigger: { trigger: el, start: 'top 95%', end: 'top 35%', scrub: 0.6 } });
    });

    // Count-ups: animate only the text node holding the number, so markup like
    // <sup>+</sup> survives, and always land on the exact original text.
    all('.m-count').forEach(function (el) {
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      var node;
      while ((node = walker.nextNode()) && !/\d/.test(node.nodeValue)) { /* find first number */ }
      if (!node) return;
      var original = node.nodeValue;
      var m = original.match(/(\d[\d,]*(?:\.\d+)?)/);
      if (!m) return;
      var value = parseFloat(m[1].replace(/,/g, ''));
      var commas = m[1].indexOf(',') > -1;
      var decimals = (m[1].split('.')[1] || '').length;
      var fmt = function (v) {
        var s = v.toFixed(decimals);
        return commas ? s.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : s;
      };
      var state = { v: 0 };
      node.nodeValue = original.replace(m[1], fmt(0));
      gsap.to(state, {
        v: value, duration: 1.8, ease: 'power2.out', delay: delayOf(el), scrollTrigger: trig(el),
        onUpdate: function () { node.nodeValue = original.replace(m[1], fmt(state.v)); },
        onComplete: function () { node.nodeValue = original; },
      });
    });

    // Marquees: duplicate the content once, slide by half its width, loop.
    all('.m-marquee').forEach(function (el) {
      var host = inner(el, 'ul,ol,.elementor-widget-container,.et_pb_text_inner');
      if (host.querySelector('.m-marquee-track')) return;
      var track = document.createElement('div');
      track.className = 'm-marquee-track';
      while (host.firstChild) track.appendChild(host.firstChild);
      var copy = track.cloneNode(true);
      copy.setAttribute('aria-hidden', 'true');
      Array.prototype.slice.call(copy.childNodes).forEach(function (c) { track.appendChild(c); });
      host.appendChild(track);
      host.style.overflow = 'hidden';
      var tween = gsap.to(track, { xPercent: -50, ease: 'none', duration: Math.max(18, track.scrollWidth / 90), repeat: -1 });
      ST.create({ trigger: el, start: 'top bottom', end: 'bottom top', onUpdate: function (self) {
        gsap.to(tween, { timeScale: self.direction === -1 ? -1 : 1, duration: 0.6, overwrite: true });
      } });
    });

    // Initial states are set; it's now safe to stop hiding content.
    finish();
    ST.refresh();
  }

  function smooth() {
    if (!window.Lenis || !document.querySelector('.m-smooth')) return;
    var lenis = new window.Lenis({ lerp: 0.1, wheelMultiplier: 1 });
    lenis.on('scroll', ST.update);
    gsap.ticker.add(function (t) { lenis.raf(t * 1000); });
    gsap.ticker.lagSmoothing(0);
    window.__claudeLenis = lenis;
  }

  function start() {
    smooth();
    var fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    // Don't let a slow font hold the hero back: lines split before the font
    // arrives only affect the reveal itself, since the split is reverted after.
    Promise.race([fonts, new Promise(function (r) { setTimeout(r, 600); })]).then(setup);
    window.addEventListener('load', function () { ST.refresh(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
