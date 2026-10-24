# OpenAPI 3.1 / 3.2 support in this fork

This is **partial support**, not a claim of complete OpenAPI 3.2 conformance.
The baseline is upstream `main` at `101ddff46206cada57ddd3f3494a30bf275bc98e`
(also the fork's starting revision, checked on 2026-10-24).

The existing Swagger Parser 10 rejects `3.2.0` before generation. The fork reads
JSON/YAML with JSON Schema Ref Parser, keeps the existing Swagger 2.0 / OpenAPI
3.0 parser checks, and adapts the supported 3.1/3.2 schema vocabulary before the
3.0 renderer. `buildV3` still uses the renderer's existing `OpenAPIV3.Document`
shape; this does not mean all 3.2 objects are represented by that type.
Newer dialects also permit boolean schemas in the schema renderer. There is no
full document validation step, just as before.

## Tested scope

| Feature | Result |
| --- | --- |
| Swagger 2.0 / OpenAPI 3.0 existing fixtures | Generated output unchanged |
| 3.1.x / 3.2.x version strings, JSON/YAML | Accepted (future minor versions remain rejected) |
| Existing GET/POST/PUT/DELETE/HEAD/OPTIONS/PATCH paths, parameters, request/response bodies | Existing aspida representation retained |
| Japanese component names, local references and name collisions | See [component names](unicode-names.md) |
| Local external-file references to Japanese schemas | Resolved before schema adaptation and name allocation |
| `type: [string, null]`, other type arrays, nullable objects and array items | TypeScript unions |
| Primitive `const`, mixed primitive `enum` | Literal types, with escaped strings |
| `true`, `false`, empty schema; array without `items` | `unknown`, `never`, `unknown`; `unknown[]` |
| Schema `$ref` siblings | Intersection with the referenced type |
| Nested union/intersection composition | Parentheses preserve intersection precedence |
| Components-only documents | Types generated without requiring `paths` |
| Descriptive 3.2 tag/server metadata | Accepted; does not alter the client interface |
| Remote document with relative root server URL | Resolved against document URL (tested with mocked loading) |

OpenAPI component keys formally use an ASCII pattern. Japanese keys are accepted
as a deliberate generator extension, not a change to that standard.

## Explicitly unsupported

For 3.1/3.2 input, the following detected features raise an error with the document
location instead of silently producing an incomplete client:

- `$self`, webhooks, `query` and `trace` operations, `additionalOperations`.
  aspida 1.14's method union only supports the seven methods above.
- `in: querystring`, streaming media `itemSchema`.
- `$id`, `$anchor`, `$dynamicAnchor`, `$dynamicRef`, `$defs`, local schema refs
  outside `components/schemas`, and custom JSON Schema dialects.
- `prefixItems`, `unevaluatedProperties`, `unevaluatedItems`, `if` / `then` / `else`,
  `contains`, `dependentSchemas`, `patternProperties`, and `not`.
- Object/array `const` and contradictory `const`/`enum` combinations.

These checks are not an exhaustive validator. Existing generator limitations
remain: runtime constraints (e.g. bounds, patterns and formats) are not validated;
`oneOf` is a TypeScript union, not an exclusive union; exact-object restrictions
such as `additionalProperties: false` are not generally expressible in TypeScript.
Cookie parameters, advanced serialization/encoding, callbacks, security schemes,
Path Item references, status ranges and path/operation server overrides have not
been expanded here. Authentication and transport setup remain the application's
responsibility. External resolution retains the original resolver's limitations
(including nontrivial URI bases and anchors); the added tests cover local files.

## aspida and SWR

No runtime dependency on SWR or React was added. They are development dependencies
for the compatibility test. `tests/aspida-swr.spec.ts` generates a real client,
compiles normal `useAspidaSWR(client.customers, { query: ... })` usage with
`@aspida/swr` 1.14 and SWR 2, and verifies response inference and rejected invalid
query arguments. It executes `$get`, `$path` and SWR's real default-key helper with
a mock transport. It does not test React rendering or a live backend.

Changes to exported Japanese or colliding type names require updating explicit
imports. Existing ASCII sample output and ordinary client call sites are preserved.

## Use the fork without an upstream release

The npm package `openapi2aspida` still refers to the upstream release. Build this
branch and install its tarball in the consuming project:

```sh
git clone --branch feat/unicode-openapi32 https://github.com/akrym1582/openapi2aspida.git
cd openapi2aspida
npm ci
npm run build
npm pack
# In the consuming project:
npm install --save-dev /absolute/path/to/openapi2aspida/openapi2aspida-0.0.0.tgz
npx openapi2aspida -i ./openapi.yaml
```

Record the fork commit SHA with the tarball for reproducibility. Git dependencies
alone do not build `dist` automatically in this repository. Keep the consuming
project's aspida transport and SWR configuration as before.

## Verification

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run lint
```

Tests are divided into the existing sample-output regression suite, Unicode and
reference reproduction tests (including compilation of generated types), a
3.1/3.2 support/unsupported-case matrix, and aspida/SWR integration. The Unicode
reproduction tests fail on the upstream baseline and pass with the fix.

Specification reference: [OpenAPI 3.2.0](https://spec.openapis.org/oas/v3.2.0.html).
No upstream PR or package publication is part of this change.
