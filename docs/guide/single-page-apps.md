# Single-page apps

In a single-page app, route changes count as page views with no extra code.

## Setup

Put the [script tag](script-tag.md) once, in `index.html`. That is all.

## What counts as a page view

- Route changes made through `history.pushState` and `history.replaceState`, and the browser's back and forward buttons. React Router, Vue Router and SvelteKit use these.
- Hash routes, such as `/#/settings` or `/#!/settings` (Vue Router's hash mode, Angular), since v1.6.0. Only the route part is sent.
- Plain anchors, such as `#section`, are **not** page views.

## Examples

- [Static HTML](../../examples/static-html)
- [Single-page app](../../examples/spa)
- [Next.js with SSR](../../examples/nextjs-ssr)
