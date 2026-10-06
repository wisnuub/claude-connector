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
 *   m-marquee    contents scroll sideways forever, right to left (add m-reverse for
 *                left to right; m-follow to reverse while the page scrolls up)
 *   m-fill       statement text: words fill from faint to full as it scrolls through
 *   m-horizontal children slide sideways while the parent section is pinned (>=900px)
 *   m-magnetic   button/link drifts toward the cursor (fine pointers only)
 *   m-pin        holds a section in place: with m-fill inside, until every word has
 *                filled; with m-steps inside, until every step has been shown
 *   m-steps      (desktop) activates its children one at a time while pinned; the
 *                matching child of an m-steps-media element crossfades in
 *   m-steps-media  the images that change per step (hide children 2+ in CSS)
 *   m-smooth     on any element: turn on Lenis smooth scrolling for the page
 *   m-load       on an element or section: its reveals play on page load, not on scroll
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
    // !important: the loop maths needs the same space after every item, and page
    // CSS (e.g. ul/li{margin:0} at #et-boc specificity) would otherwise win.
    '.m-marquee-track>*{flex:none;margin:0 var(--m-gap,56px) 0 0!important}' +
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
  // m-load on the element or an ancestor (e.g. the hero section): play on page
  // load, not when scrolled into view - a hero's lower lines can sit below the
  // trigger line on a short screen and would wait for a scroll.
  var trig = function (el, start) { return el.closest('.m-load') ? undefined : { trigger: el, start: start || 'top 88%', once: true }; };
  // Bottom edge of a fixed/sticky site header (Divi Theme Builder, Elementor
  // header templates...), so pinned blocks can be centred in the space below it
  // instead of sliding under it. Anything covering >40% of the screen is not a
  // header (e.g. another pin that is currently fixed) and is ignored.
  var headerOffset = function () {
    var el = document.elementFromPoint(window.innerWidth / 2, 2), best = 0;
    while (el && el !== document.body && el !== root) {
      var cs = getComputedStyle(el), r = el.getBoundingClientRect();
      if ((cs.position === 'fixed' || cs.position === 'sticky') && r.top <= 1) best = Math.max(best, r.bottom);
      el = el.parentElement;
    }
    return best > window.innerHeight * 0.4 ? 0 : best;
  };
  // The header height pins and layouts use. Many headers shrink once the page
  // scrolls (Divi's fixed header: 172px at the top, 104px scrolled), and pins
  // are only ever seen scrolled, so it is re-measured after scrolling settles.
  // Published as --m-header for CSS (e.g. padding-top: var(--m-header, 104px)).
  var header = 0;
  var measureHeader = function () {
    var h = Math.round(headerOffset());
    if (Math.abs(h - header) < 2) return false;
    header = h;
    root.style.setProperty('--m-header', h + 'px');
    return true;
  };

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
      if (el.querySelector('.m-marquee-track')) return;
      // Loop the actual items: descend through single-child wrappers (builder
      // inner divs, a lone <ul>) so a list's <li>s become the track's children.
      // Looping the whole list as one block leaves no gap where the copies meet.
      var host = el;
      while (host.children.length === 1 && /^(DIV|UL|OL|SECTION)$/.test(host.firstElementChild.tagName)) host = host.firstElementChild;
      var track = document.createElement('div');
      track.className = 'm-marquee-track';
      while (host.firstChild) track.appendChild(host.firstChild);
      var copy = track.cloneNode(true);
      copy.setAttribute('aria-hidden', 'true');
      Array.prototype.slice.call(copy.childNodes).forEach(function (c) { track.appendChild(c); });
      host.appendChild(track);
      host.style.overflow = 'hidden';
      // One steady direction (items travel right to left); m-reverse flips it.
      // m-follow makes it reverse while the page scrolls up.
      var rev = el.classList.contains('m-reverse');
      var tween = gsap.fromTo(track, { xPercent: rev ? -50 : 0 }, { xPercent: rev ? 0 : -50, ease: 'none', duration: Math.max(18, track.scrollWidth / 90), repeat: -1 });
      if (el.classList.contains('m-follow')) ST.create({ trigger: el, start: 'top bottom', end: 'bottom top', onUpdate: function (self) {
        gsap.to(tween, { timeScale: self.direction === -1 ? -1 : 1, duration: 0.6, overwrite: true });
      } });
    });

    // Statement text: words fill from faint to full ink as it scrolls through.
    all('.m-fill').forEach(function (el) {
      var target = inner(el, 'h1,h2,h3,h4,h5,h6,.elementor-heading-title,p');
      if (!window.SplitText) return;
      var split = new window.SplitText(target, { type: 'words', wordsClass: 'm-word' });
      // pinSpacing: true is explicit on every pin here: ScrollTrigger turns it OFF
      // by default when the pinned element's parent is a flex container - which
      // every Divi 5 section and Elementor container is - and the next section
      // then slides up over the pinned one.
      // Inside an m-pin element, the section holds still until every word has
      // filled, then releases - instead of filling while it scrolls past.
      var pinEl = el.classList.contains('m-pin') ? el : el.closest('.m-pin');
      var st = pinEl
        ? { trigger: pinEl, start: 'top top', end: function () { return '+=' + Math.round(window.innerHeight * 1.4); }, pin: pinEl, pinSpacing: true, scrub: true, invalidateOnRefresh: true }
        : { trigger: el, start: 'top 80%', end: 'bottom 45%', scrub: true };
      gsap.fromTo(split.words, { opacity: 0.16 }, { opacity: 1, ease: 'none', stagger: 0.1, scrollTrigger: st });
    });

    // Pinned horizontal strip: the element's children slide sideways while its
    // parent section stays pinned. Desktop only - on narrow screens the builder's
    // normal stacked layout is the better experience.
    var mm = gsap.matchMedia();
    mm.add('(min-width: 900px)', function () {
      all('.m-horizontal').forEach(function (el) {
        var pinTarget = el.parentElement && el.parentElement.closest('.et_pb_section, .e-con.e-parent, section') || el.parentElement;
        el.style.flexWrap = 'nowrap';
        var track = el.querySelector(':scope > .e-con-inner') || el;
        track.style.flexWrap = 'nowrap';
        var distance = function () { return Math.max(0, track.scrollWidth - el.clientWidth); };
        gsap.to(track, {
          x: function () { return -distance(); }, ease: 'none',
          scrollTrigger: { trigger: pinTarget, start: 'top top', end: function () { return '+=' + distance(); }, pin: pinTarget, pinSpacing: true, scrub: 0.8, invalidateOnRefresh: true },
        });
      });
    });

    // Scrollytelling steps: the m-pin element (or the section) holds still while
    // the m-steps list activates its items one at a time, and the matching
    // child of an m-steps-media element crossfades in. Desktop only; without
    // JS, on phones or with reduced motion, the stacked layout is used instead
    // (keep media children 2+ hidden in your CSS so only the first shows).
    mm.add('(min-width: 900px)', function () {
      all('.m-steps').forEach(function (list) {
        var pinEl = list.closest('.m-pin') || list.closest('.et_pb_section, .e-con.e-parent, section') || list.parentElement;
        var items = kids(list);
        if (items.length < 2) return;
        var media = pinEl.querySelector('.m-steps-media');
        var frames = media ? Array.prototype.slice.call((media.querySelector(':scope > .e-con-inner') || media).children) : [];
        if (media) {
          var box = media.querySelector(':scope > .e-con-inner') || media;
          box.style.display = 'grid';
          frames.forEach(function (f) {
            f.style.gridArea = '1 / 1'; f.style.display = 'block';
            // Fetch and decode every step image now: builders mark them
            // loading="lazy", and a photo decoded on first show stutters its
            // crossfade (badly for multi-megapixel originals).
            Array.prototype.forEach.call(f.querySelectorAll('img'), function (img) {
              img.loading = 'eager';
              if (img.decode) img.decode().catch(function () {});
            });
          });
          gsap.set(frames, { autoAlpha: 0, willChange: 'opacity' });
          gsap.set(frames[0], { autoAlpha: 1 });
        }
        gsap.set(items, { opacity: 0.22 });
        gsap.set(items[0], { opacity: 1 });
        // Each step holds steady for most of its scroll distance and crossfades
        // only in the last part; the last step holds before release.
        var tl = gsap.timeline({ scrollTrigger: {
          trigger: pinEl, pin: pinEl, pinSpacing: true, scrub: 0.5, invalidateOnRefresh: true,
          // Centre the pinned block in the viewport space below any fixed header.
          start: function () {
            var off = header, avail = window.innerHeight - off;
            return 'top ' + Math.round(off + Math.max(0, (avail - pinEl.offsetHeight) / 2)) + 'px';
          },
          end: function () { return '+=' + Math.round(items.length * window.innerHeight * 0.6); },
        } });
        items.forEach(function (item, i) {
          if (i === 0) return;
          var at = (i - 1) + 0.6;
          tl.to(items[i - 1], { opacity: 0.22, duration: 0.4 }, at)
            .to(item, { opacity: 1, duration: 0.4 }, at);
          if (frames[i]) tl.to(frames[i - 1], { autoAlpha: 0, duration: 0.4 }, at).to(frames[i], { autoAlpha: 1, duration: 0.4 }, at);
        });
        tl.to({}, { duration: 0.6 });

        // Snapping that works WITH smooth scrolling: when scrolling stops inside
        // a crossfade, glide to the next clean step in the direction of travel
        // (or back to the previous one when scrolling up). Stopping while a
        // step is fully shown is left alone. Goes through Lenis when present -
        // ScrollTrigger's own snap scrolls natively and Lenis eases it back.
        var st = tl.scrollTrigger, T = tl.duration();
        var snapToStep = function () {
          if (!st || !st.isActive) return;
          var t = st.progress * T, frac = t - Math.floor(t), eps = 0.02;
          if (frac <= 0.6 + eps || frac >= 1 - eps) return; // a step is fully shown
          var target = st.direction > 0 ? Math.ceil(t) : Math.floor(t) + 0.6;
          var y = st.start + (st.end - st.start) * (target / T);
          if (window.__claudeLenis) window.__claudeLenis.scrollTo(y, { duration: 0.6 });
          else window.scrollTo({ top: y, behavior: 'smooth' });
        };
        ST.addEventListener('scrollEnd', snapToStep);

        return function () {
          ST.removeEventListener('scrollEnd', snapToStep);
          if (media) frames.forEach(function (f) { f.style.gridArea = ''; f.style.display = ''; });
        };
      });
    });

    // Magnetic buttons/links: drift toward the cursor, spring back on leave.
    if (window.matchMedia('(pointer: fine)').matches) {
      all('.m-magnetic').forEach(function (el) {
        var target = inner(el, 'a,button,.elementor-button,.et_pb_button');
        var xTo = gsap.quickTo(target, 'x', { duration: 0.5, ease: 'power3.out' });
        var yTo = gsap.quickTo(target, 'y', { duration: 0.5, ease: 'power3.out' });
        target.addEventListener('pointermove', function (e) {
          var r = target.getBoundingClientRect();
          xTo((e.clientX - (r.left + r.width / 2)) * 0.35);
          yTo((e.clientY - (r.top + r.height / 2)) * 0.35);
        });
        target.addEventListener('pointerleave', function () {
          gsap.to(target, { x: 0, y: 0, duration: 0.9, ease: 'elastic.out(1, 0.4)' });
        });
      });
    }

    // Initial states are set; it's now safe to stop hiding content.
    finish();
    // Pins created in a different order from their position on the page would
    // compute their start points without the spacing earlier pins add.
    ST.sort();
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
    measureHeader();
    var rt, ht;
    var remeasure = function () { if (measureHeader()) ST.refresh(); };
    window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(remeasure, 150); });
    // After the header's own shrink transition has finished.
    ST.addEventListener('scrollEnd', function () {
      if (window.scrollY < 50) return;
      clearTimeout(ht); ht = setTimeout(remeasure, 400);
    });
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
