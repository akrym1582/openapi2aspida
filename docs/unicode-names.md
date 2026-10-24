# Component names

Japanese and other ECMAScript Unicode identifier characters are preserved in
exported type names. ASCII names keep the existing initial-uppercase convention.
Digits at the start receive `$`; invalid characters become `_`. Empty names are
handled defensively. This generator accepts Japanese component keys as an
extension: OpenAPI's component-key pattern itself is limited to ASCII.

All generated component categories share one TypeScript namespace. Names are
allocated before rendering, in category order (schemas, parameters, request
bodies, responses, headers), then sorted by original key. Collisions receive a
numeric suffix, avoiding names already present in the input. Reordering input
keys does not change the allocation. Adding a colliding component may change
which component receives a suffix.

Declarations and local `$ref` targets use the same allocation, including recursive
references, percent-encoded fragments and JSON Pointer `~0` / `~1` escapes.
External references use the existing external-document resolver before allocation.
`Array` at the end of a component name is now treated literally; array semantics
come from the schema's `type: array`, not from its name.

Existing valid ASCII output is covered by the sample regression suite. Consumers
of formerly mangled Japanese names or colliding names must update their type
imports. HTTP paths and the aspida client method interface are unchanged.
