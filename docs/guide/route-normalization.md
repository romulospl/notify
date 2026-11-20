# Route normalization

Paths with IDs become one route, so `/accounts/GABC…` and `/accounts/GXYZ…` add up together.

## Your route comes first

If your API sends `http.route` (for example `/accounts/{id}`), it is kept exactly as sent. Send it whenever your framework knows it.

## Otherwise, fixed rules

Without `http.route`, each path segment is checked:

| Segment | Becomes |
|---|---|
| UUID | `{uuid}` |
| Stellar address (G…, C… or M…) | `{address}` |
| Hex hash, 16 characters or more | `{hash}` |
| Digits only | `{id}` |

The query string, the fragment and a trailing slash are removed.

## Example

```text
/accounts/GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ/payments/
→ /accounts/{address}/payments
```

## Route limit

Each service keeps up to 500 routes per day. Anything beyond that is counted as `{other}`. Many `{other}` rows usually mean `http.route` is missing.

## Keep personal data out

Other segments are stored as they are. A path like `/users/maria` would be stored, so send `http.route` or keep names out of your URLs.
