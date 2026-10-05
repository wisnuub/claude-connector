// Minimal Divi 5 block serialiser. Builds post_content from plain JS objects so
// the markup can never be malformed, and escapes attribute JSON the same way
// WordPress core's serialize_block_attributes() does (which is also what the
// Divi 5 Visual Builder writes) - so `--`, `<`, `>`, `&` and `\"` inside CSS or
// HTML can't terminate the surrounding HTML comment.

// Stamped on every block, as the Visual Builder does. Set it to the site's Divi
// version (wp_status → builder.divi_version) before generating.
export let BUILDER_VERSION = '5.11.1';
export function setBuilderVersion(v) { BUILDER_VERSION = String(v); }

export function serializeAttrs(attrs) {
  return JSON.stringify(attrs)
    .replace(/--/g, '\\u002d\\u002d')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\\"/g, '\\u0022');
}

const d = value => ({ desktop: { value } });

function withClass(attrs, cls) {
  if (!cls) return attrs;
  attrs.module = attrs.module || {};
  attrs.module.advanced = attrs.module.advanced || {};
  attrs.module.advanced.htmlAttributes = d({ id: '', class: cls });
  return attrs;
}

function block(name, attrs, children) {
  const a = { ...attrs, builderVersion: BUILDER_VERSION };
  const open = `<!-- wp:divi/${name} ${serializeAttrs(a)}`;
  if (children === undefined) return `${open} /-->`;
  return `${open} -->\n${[].concat(children).join('\n')}\n<!-- /wp:divi/${name} -->`;
}

/**
 * Section. Backgrounds are set natively, so they stay editable in the builder:
 * opts.bg = image URL; opts.video = { mp4, webm } background video (the image,
 * if also given, shows until the video plays).
 */
export function section(cls, children, opts = {}) {
  const attrs = withClass({}, cls);
  const bg = {};
  if (opts.bg) bg.image = { url: opts.bg };
  if (opts.video) bg.video = { ...opts.video };
  if (opts.bg || opts.video) (attrs.module = attrs.module || {}).decoration = { background: d(bg) };
  return block('section', attrs, children);
}

export function row(cls, columns) {
  return block('row', withClass({ module: { decoration: { layout: d({ display: 'flex' }) } } }, cls), columns);
}

/** Column. type: 4_4, 1_2, 1_3, 2_3, 1_4, 3_4, 2_5, 3_5 ... */
export function column(type, children, cls) {
  const attrs = withClass({ module: { advanced: { type: d(type) } } }, cls);
  return block('column', attrs, children);
}

/** Text module. html is real markup (h1/h2/p/ul ...); styling comes from cls. */
export function text(html, cls) {
  return block('text', withClass({ content: { innerContent: d(html) } }, cls));
}

export function button(label, url, cls, newTab = false) {
  return block('button', withClass({
    button: { innerContent: d({ text: label, linkUrl: url, linkTarget: newTab ? 'on' : 'off' }) },
  }, cls));
}

export function image(src, alt, cls) {
  return block('image', withClass({ image: { innerContent: d({ src, alt }) } }, cls));
}

/** Code module - used once per layout to carry the scoped stylesheet. */
export function code(html, cls) {
  return block('code', withClass({ content: { innerContent: d(html) } }, cls));
}

/** Wraps a layout the way Divi 5 stores a builder page. */
export function page(sections) {
  return `<!-- wp:divi/placeholder -->\n${sections.join('\n')}\n<!-- /wp:divi/placeholder -->`;
}

/** Collapses a stylesheet onto one line so wpautop can't inject <p>/<br> into it. */
export function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}:;,>])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim();
}
