# Building a Divi 5 site through Claude Connector

Workflow notes for Claude. The gotchas behind these steps are in
[KNOWLEDGE.md](KNOWLEDGE.md#divi); this file is just the order to do things in.

Requires plugin **1.6.0+** on the site and a matching `mcp-server/index.js`.
Run `wp_status` first and check three fields:

```
acting_as.unfiltered_html   must be true, or every builder write will be corrupted
builder.divi_generation     d5_json for Divi 5, d4_shortcode for Divi 4
version_check               must say ok - a stale MCP server silently hides tools
```

---

## 1. Learn the attribute paths before writing anything

Divi 5 attributes are a deep JSON tree with **no validation on write** — an
unrecognised path is silently dropped and the module renders with defaults. Do
not guess. Read the shape off a page a human already built in the Divi UI:

```
wp_divi_data_get({ id: <a page the client built> })
```

That is ground truth for this site's Divi version. `wp_divi_modules_list` gives
you the module slugs. Divi's own schema JSON under `wp-content/themes/Divi/` is
readable with `wp_files_read` if you need more.

Traps that cost real time, all verified:

| Want | Correct path |
|---|---|
| Centre text | `module.advanced.text.text.desktop.value.orientation: "center"` — **not** `font.textAlign`, which emits a duplicate declaration that loses |
| Image content | `image.innerContent` `{src, alt, titleText, id}` |
| Icon content | `icon.innerContent` |
| Anything else | `content.innerContent` |
| CSS class | `module.advanced.htmlAttributes.desktop.value.class` |
| Equal-height columns | `module.advanced.gutter.desktop.value.makeEqual: "on"` |
| Divider line | `divider.advanced.line.desktop.value.{show,color,style,position,weight}` |

Every leaf needs the `{breakpoint: {value: …}}` wrapper, even for desktop only.

## 2. Generate markup so it cannot be malformed

`post_content` is JSON inside HTML comments. One unbalanced brace corrupts the
page with no parse error. Build attribute objects programmatically and serialise
them (`JSON.stringify` or equivalent) rather than hand-writing the JSON — that
removes the whole bug class instead of catching it later.

Keep the markup structural and push presentation into a stylesheet. A CSS rule
styles every section on every page; the module equivalent is N copies of the
same attributes to write, transmit and maintain.

## 3. Write with the Divi tool, not the generic one

```
wp_divi_data_set({ id, content })
```

Prefer it over `wp_posts_update` for builder content. It applies the full
builder postmeta set (Divi 5 needs five rows or the page renders on the theme
default template with a widget sidebar), validates the block markup, and
flushes Divi's per-post CSS cache.

Check `blocks.valid` in the response. If a page was created some other way and
renders with a sidebar, repair it with `wp_divi_meta_set({ id })`.

## 4. Put custom CSS in real files, and beat Divi on specificity

Write stylesheets to `wp-content/uploads/` and link them from Divi → Theme
Options → Integration → Head. Not `divi_custom_css` — a serialised option is
painful to edit incrementally and impossible to diff.

```
wp_options_set({ key: "et_divi.divi_integration_head", value: "<link ... ?v=2 />" })
```

The dotted path patches that one field without rewriting the whole `et_divi`
array.

**Integration → Head prints before Divi's own stylesheet**, so on an
`!important` tie Divi wins on source order. Prefix contested selectors with
`html body` to win on specificity instead. Bump the `?v=` on every linked file
together when you edit any of them.

For the hero, scope structurally so the selector cannot also hit the Theme
Builder header:

```css
.et-l--post > .et_builder_inner_content > .et_pb_section:first-child { … }
```

## 5. Verify what rendered, not what you wrote

Every other tool reports database state. Several classes of defect only exist in
the output.

```
wp_page_render({ id, expect: { h1_count: 1, has_sidebar: false, kses_corruption: false } })
wp_blocks_validate({ id })
```

`wp_page_render` also reports the heading outline, section count, images missing
alt text and empty paragraphs — useful for catching content problems inherited
from a migration.

## 6. After raw SQL, after any plugin install: re-save

Raw SQL bypasses every WordPress hook, so Divi never learns the content changed
and keeps serving stale CSS.

```
wp_divi_resave({ ids: [...] })
```

Installing or updating **any** plugin is the dangerous one. It invalidates
Divi's caches, and the regeneration can emit per-module CSS whose indices are
offset by each page's module count — the stylesheet targets `.et_pb_text_0`
while the markup renders `.et_pb_text_12`, so **all** attribute styling stops
applying sitewide with nothing wrong in the database.

```
wp_divi_audit()            # finds it
wp_divi_resave()           # fixes it
wp_divi_audit()            # confirm healthy: true
```

Make `wp_divi_audit` a habit after every plugin operation.

## 7. Editing text on live pages

**Use `wp_content_replace`, not SQL.** Pass plain HTML and it handles the
escaping:

```
wp_content_replace({ id: 10, search: '<h1>Old</h1>', replace: '<h2>New</h2>', dry_run: true })
```

This matters more than it sounds. Block attributes are JSON inside an HTML
comment, so the HTML in them is escaped — and *how* depends on what wrote it.
The Divi 5 visual builder writes `<h1>` while keeping quotes as `\"`;
hand-written block JSON leaves the brackets literal and escapes only the quotes.
Both forms coexist on the same site. Searching for plain `<h1>` finds neither,
and a SQL `REPLACE` that matches nothing looks identical to one that succeeded.

`wp_content_replace` tries every known encoding, reports which matched
(`{"block_attr_mixed": 1}` or `{"json": 11}`), writes using the matching one,
revalidates the blocks and flushes Divi's CSS cache. When nothing matches it
lists every encoding it tried, so you can tell an escaping problem from an
absent string.

**Always `dry_run: true` first** and check `total_matches` is the number you
expect. That is the whole safety mechanism — it confirms the edit is scoped to
what you intended before anything is written.

If you do need raw SQL, use `wp_db_query` with bound `params` (never hand-built
quotes), and read `matched_rows` vs `changed_rows`: matched 1 / changed 0 means
the row was found but your search string was not in it. Then run
`wp_divi_resave` on the pages you touched.

## 8. Migrating content from another WordPress site

If the source site exposes its REST API, use it — structured content, no
scraping:

```
/wp-json/wp/v2/pages?per_page=100
/wp-json/wp/v2/posts?per_page=100
```

For media, `wp media import <url1> <url2> …` via `wp_wpcli` takes multiple URLs
per call. For any other file that already exists at a URL, use
`wp_files_fetch` so the bytes go straight to the server instead of through the
conversation.

Expect the source markup to carry defects. Lint what you migrate before writing
it: mismatched heading tags, headings with no body, and outbound links to
competitors are all things this workflow has turned up in real client content.

---

## Order of operations, condensed

```
wp_status                          # check acting_as.unfiltered_html + version_check
wp_divi_data_get(<built page>)     # learn the attribute paths
… generate markup programmatically …
wp_divi_data_set({ id, content })  # check blocks.valid
wp_files_write / wp_files_fetch    # stylesheet
wp_options_set et_divi.divi_integration_head
wp_page_render({ id, expect })     # verify the rendered result
wp_content_replace({ dry_run })    # any text edits, plain HTML
wp_divi_audit()                    # after any plugin install, and at the end
```
