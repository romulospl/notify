# Script tag

One tag in the `<head>` of your pages counts page views, with no cookies.

## Add the tag

Put this tag in the `<head>` of every page, with your gateway and website ID:

```html
<script
  defer
  src="https://<gateway>/s/v1.6.0/n.js"
  integrity="sha384-cAxHFzNxpJfof+rLRpDVRPPpZZk3btq/2AV2cCsbaDEZGntOrfxIIZX4L9+LW8qp"
  crossorigin="anonymous"
  data-site="<website-id>"
></script>
```

## Next.js

Put the same tag inside `<head>` in `app/layout.tsx` (in JSX, write `crossOrigin`). Do not load it with `next/script` and `lazyOnload`: the first page view may be lost.

## Requirements

- **HTTPS** (or `localhost`). On plain HTTP the browser does not offer what the script needs, and nothing is sent.
- Keep `integrity` and `crossorigin="anonymous"` together: the browser checks the file before running it.

## Versions never change

- Each version (`/s/vX.Y.Z/n.js`) is immutable, and the script never updates itself.
- To upgrade, change the version in the path **and** the `integrity` hash.
- Use **v1.6.0**. Custom events need v1.4.0 or newer, and wallet counts need v1.5.0 or newer.

## What a page view carries

- Website ID, hostname and path (plus only `utm_*` parameters).
- Referrer without query, page title, language and screen size.

**Do not put personal data in paths or titles**, such as `/profile/maria@example.com`: they would be stored.

## Ad blockers

The script and its endpoints use neutral names. Also give the gateway a neutral host name, such as `e.<your-domain>`, without words like `analytics`, `track` or `stats`. Some visitors will still be blocked.
