// The snippet that switches claude-motion on for a page. Put it in the FIRST
// module of the layout (Divi: a Code module; Elementor: an HTML widget) so the
// inline part runs before the content it hides is parsed. Everything is scoped
// to pages that contain it; to enable motion sitewide later, the same snippet
// can go in Divi > Theme Options > Integration > Head (or an Elementor Custom
// Code snippet) - it is class-gated, so pages without m-* classes are untouched.
//
// prefix: URL prefix the five files share, e.g. ".../uploads/claude-motion/" (a
// folder) or ".../uploads/claude-motion-" (flat names). Self-hosting in uploads
// is best: no third-party dependency, and the files are inert until referenced.

export const MOTION_FILES = {
  'gsap.min.js': 'https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js',
  'ScrollTrigger.min.js': 'https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/ScrollTrigger.min.js',
  'SplitText.min.js': 'https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/SplitText.min.js',
  'lenis.min.js': 'https://cdn.jsdelivr.net/npm/lenis@1.3.26/dist/lenis.min.js',
};

export function motionLoader(prefix, version = '1') {
  const src = f => `${prefix}${f}?v=${version}`;
  // Hidden only while html.m-js is set: the runtime removes it once initial
  // animation states are applied, and the timeout removes it if the scripts
  // never arrive - content can't get stuck invisible.
  const hide = 'html.m-js .m-split,html.m-js .m-reveal,html.m-js .m-stagger>:not(.e-con-inner),html.m-js .m-stagger>.e-con-inner>*{opacity:0}';
  const boot = "(function(d){d.classList.add('m-js');setTimeout(function(){if(!window.__claudeMotion)d.classList.remove('m-js')},3000)})(document.documentElement);";
  return [
    `<style>${hide}</style>`,
    `<script>${boot}</script>`,
    ...['gsap.min.js', 'ScrollTrigger.min.js', 'SplitText.min.js', 'lenis.min.js', 'motion.js']
      .map(f => `<script src="${src(f)}" defer></script>`),
  ].join('');
}
