// Tiny helpers for writing Elementor (v3-style widgets + Flexbox Containers) data
// as plain JS, so every element gets a unique id and a valid shape. Styling goes
// into each widget's own settings, so it shows up - and stays editable - in the
// Elementor panel.
import crypto from 'crypto';

const ids = new Set();
export function id() {
  let v;
  do { v = crypto.randomBytes(4).toString('hex').slice(0, 7); } while (ids.has(v));
  ids.add(v);
  return v;
}

export const px = (size, unit = 'px') => ({ unit, size, sizes: [] });
/** Box value for padding/margin/radius: box(t, r, b, l) or box(all). */
export function box(t, r = t, b = t, l = r, unit = 'px') {
  return { unit, top: String(t), right: String(r), bottom: String(b), left: String(l), isLinked: t === r && r === b && b === l };
}
export const gap = (size, unit = 'px') => ({ column: String(size), row: String(size), isLinked: true, unit, size });

/** Responsive helper: r('padding', {desktop, tablet, mobile}) → flat Elementor keys. */
export function r(key, values) {
  const out = {};
  if (values.desktop !== undefined) out[key] = values.desktop;
  for (const bp of ['laptop', 'tablet_extra', 'tablet', 'mobile_extra', 'mobile']) {
    if (values[bp] !== undefined) out[`${key}_${bp}`] = values[bp];
  }
  return out;
}

/** Typography preset → Elementor typography_* settings (prefix for widgets with several). */
export function type(t, prefix = 'typography') {
  const s = { [`${prefix}_typography`]: 'custom' };
  if (t.family) s[`${prefix}_font_family`] = t.family;
  if (t.weight) s[`${prefix}_font_weight`] = String(t.weight);
  if (t.size) Object.assign(s, r(`${prefix}_font_size`, typeof t.size === 'number' ? { desktop: px(t.size) } : mapPx(t.size)));
  if (t.lh) Object.assign(s, r(`${prefix}_line_height`, typeof t.lh === 'number' ? { desktop: px(t.lh, 'em') } : mapPx(t.lh, 'em')));
  if (t.ls !== undefined) Object.assign(s, r(`${prefix}_letter_spacing`, typeof t.ls === 'number' ? { desktop: px(t.ls) } : mapPx(t.ls)));
  s[`${prefix}_text_transform`] = t.transform || 'none';
  if (t.style) s[`${prefix}_font_style`] = t.style;
  return s;
}
function mapPx(obj, unit = 'px') {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, px(v, unit)]));
}

export function container(settings, children = [], isInner = true) {
  // Elementor gives every container 10px padding by default, which compounds with
  // nesting and knocks inner content out of alignment - zero it unless set.
  const base = { content_width: 'full' };
  if (isInner && !('padding' in settings)) base.padding = box(0);
  return { id: id(), elType: 'container', isInner, settings: { ...base, ...settings }, elements: children };
}
export function widget(widgetType, settings) {
  return { id: id(), elType: 'widget', widgetType, isInner: false, settings, elements: [] };
}

export const heading = (title, tag, settings = {}) => widget('heading', { title, header_size: tag, ...settings });
export const textEditor = (html, settings = {}) => widget('text-editor', { editor: html, ...settings });
/**
 * Image widget. Pass the media-library attachment id whenever there is one: with
 * an id Elementor serves a resized file plus srcset instead of the original
 * upload (which can be many MB). The url is required either way - the Image
 * widget renders nothing when image.url is empty, even if image.id is set.
 */
export function image(url, alt, settings = {}, attachmentId = '', size = '1536x1536') {
  if (!url) throw new Error('image(): url is required - Elementor renders nothing without image.url');
  return widget('image', {
    image: { url, id: attachmentId, alt, source: attachmentId ? 'library' : 'url' },
    image_size: attachmentId ? size : 'full',
    ...settings,
  });
}
export function button(text, url, settings = {}, external = false) {
  return widget('button', {
    text,
    link: { url, is_external: external ? 'on' : '', nofollow: '', custom_attributes: '' },
    ...settings,
  });
}
