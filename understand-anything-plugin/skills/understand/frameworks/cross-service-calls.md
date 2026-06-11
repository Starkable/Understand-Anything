# Cross-Service Call Recognition (Federation Supplement)

Supplementary guidance for recognizing **outbound cross-service HTTP calls** across stacks. Applies to every framework — append alongside the framework-specific addendum when the project belongs to a multi-project workspace (or whenever outbound HTTP usage is visible).

These signals feed the deterministic cross-community linker (`resolve-cross-community-links.mjs`). The analyzer's job is to make them **discoverable** (summaries + tags), never to create `community` nodes or `calls_community` edges directly.

## What to look for, by stack

### Java / Spring
| Pattern | Hint to capture |
|---|---|
| `@FeignClient(name = "order-service", url = "${order.url}")` | Target service name + the url/config key; each interface method's `@GetMapping`/`@PostMapping` path is the outbound path |
| `RestTemplate` (`getForObject`, `postForEntity`, `exchange`) | The URL expression — literal, or `baseUrl + "/relative/path"` |
| `WebClient.create(baseUrl)` / `.uri("/orders/{id}")` | baseUrl source + relative path |
| `@Value("${order.service.url}")` injected into HTTP calls | Config key — the linker correlates it with `application.yml` values |

### JavaScript / TypeScript
| Pattern | Hint to capture |
|---|---|
| `fetch("https://other.internal.com/...")` | Full URL |
| `axios.get(...)` / `axios.create({ baseURL })` | baseURL source + per-call relative paths |
| `process.env.ORDER_API_URL` used in request helpers | Env var name |
| Generated API clients (OpenAPI, tRPC over HTTP) | Target service name from the client package/config |

### Python
| Pattern | Hint to capture |
|---|---|
| `requests.get(f"{ORDER_URL}/orders/{id}")` | Config/env var name + relative path |
| `httpx.Client(base_url=...)` | base_url source + per-call paths |

### Go
| Pattern | Hint to capture |
|---|---|
| `http.Get("https://...")` / `http.NewRequest` | URL expression |
| Client structs wrapping a `baseURL` field | Where baseURL is loaded from (env/config) |

## How to annotate (file-analyzer)

1. **Summary**: name the dependency concretely — service/domain + method + path when statically visible. Example: 「查询退费流程，调用订单服务 `GET order.internal.com/order-api/orders/{id}` 获取订单信息」.
2. **Tag**: add `external-call` to nodes performing outbound cross-service calls.
3. **Feign/typed clients**: always record the declared service name (`name`/`value`) and url/config key — interface-based clients carry no literal URL at the call site, so this is the only recoverable hint.
4. **Do NOT**: emit `community` nodes, `calls_community` edges, or guess which workspace project owns a URL. The deterministic linker performs the matching (`domain + method + fullPath`) and applies the placeholder/backfill lifecycle.

## What is NOT a cross-service call

- Calls to the project's OWN domains (declared in README `understand-community.domains`)
- `localhost` / `127.0.0.1` (local dev wiring)
- Third-party SaaS APIs (github.com, api.stripe.com, …) — still worth a summary mention, but they will never match a workspace community
- URLs in comments, test fixtures, or example docs
