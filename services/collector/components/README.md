# services/collector/components

Go components of the collector, one package per component:

| Component | Type | Role |
|---|---|---|
| Key authentication | extension | [`ingestkeyauth/`](ingestkeyauth/) (#30): validates the ingest key against `ingest_key_active` and puts tenant and service in the request context. Never trusts an attribute sent by the client |
| Tenant stamp | processor | [`tenantattr/`](tenantattr/) (#30): replaces the resource's tenant attributes with the key's `stellytics.tenant.id` and `stellytics.api_service.id`. Comes before `batch` |
| Route normalization | processor | Rules in [`routenorm/`](routenorm/) (#32): `{uuid}`, `{address}` (StrKey G/C/M), `{hash}` (16+ hex) and `{id}`, without a trailing slash. An `http.route` sent by the client takes priority. The processor that uses the package lands in #31 |
| PostgreSQL | exporter | [`pgexporter/`](pgexporter/) (#31): writes the 1-minute points to `api_metric_1m` |
| Metric extraction | package | [`httpmetrics/`](httpmetrics/) (#31): HTTP server spans and `http.server.request.duration` become 1-minute points; the rest is dropped |
