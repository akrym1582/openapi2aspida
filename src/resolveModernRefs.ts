import RefParser from '@apidevtools/json-schema-ref-parser';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { $ref2TypeName, decodePointer, encodePointer } from './builderUtils/converters';

type Mode = 'oas' | 'map' | 'schema' | 'schemaMap' | 'schemaArray';
type Node = { value: any; base: string; document: string; tokens: string[]; mode: Mode };
const schemaMaps = ['$defs', 'properties', 'patternProperties', 'dependentSchemas'];
const schemaArrays = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
const schemaSingles = [
  'items',
  'additionalProperties',
  'not',
  'if',
  'then',
  'else',
  'contains',
  'unevaluatedProperties',
  'unevaluatedItems',
  'propertyNames',
];
const dataKeys = ['example', 'examples', 'default', 'enum', 'const'];
const oasMaps = [
  'paths',
  'content',
  'parameters',
  'headers',
  'responses',
  'requestBodies',
  'callbacks',
  'pathItems',
];
const pointer = (tokens: string[]) => tokens.map(encodePointer).join('/');
const reference = (category: string, name: string) =>
  `#/components/${category}/${encodeURIComponent(encodePointer(name))}`;

// Resolve static JSON Schema resources without dereferencing cycles. All promoted
// targets become ordinary components before the existing name allocator runs.
export default async (document: Record<string, any>, input: string) => {
  const retrieval =
    input && /^[a-z][a-z0-9+.-]*:/i.test(input) && !/^[a-z]:[\\/]/i.test(input)
      ? new URL(input).href
      : pathToFileURL(path.resolve(input || 'openapi.json')).href;
  const nodes = new Map<string, Node>();
  const resources = new Map<string, Node>();
  const anchors = new Map<string, Node>();
  const loaded = new Set<string>();
  const outputs = new Map<Node, string>();
  const components: Record<string, Record<string, any>> = {};
  const used = new Map<string, Set<string>>();
  const location = (node: Node) => `${node.document}#/${pointer(node.tokens)}`;
  const fail = (node: Node, message: string): never => {
    throw new Error(`${message} at ${location(node)}`);
  };
  const uri = (value: string, base: string, node: Node) => {
    try {
      return new URL(value, base).href;
    } catch {
      return fail(node, `Invalid reference URI ${value}`);
    }
  };
  const register = (map: Map<string, Node>, key: string, node: Node) => {
    if (map.has(key) && map.get(key) !== node) fail(node, `Duplicate schema identifier ${key}`);
    map.set(key, node);
  };
  const childMode = (node: Node, key: string): Mode | undefined => {
    if (node.mode === 'schemaMap' || node.mode === 'schemaArray') return 'schema';
    if (node.mode === 'schema') {
      if (schemaMaps.includes(key)) return 'schemaMap';
      if (schemaArrays.includes(key)) return 'schemaArray';
      if (schemaSingles.includes(key)) return 'schema';
      return undefined;
    }
    if (node.mode === 'map') return 'oas';
    if (key === 'schema') return 'schema';
    if (node.tokens.length === 1 && node.tokens[0] === 'components' && key === 'schemas')
      return 'schemaMap';
    if (dataKeys.includes(key) || key.startsWith('x-')) return undefined;
    return oasMaps.includes(key) ? 'map' : 'oas';
  };
  const index = (value: any, base: string, doc: string, tokens: string[], mode: Mode): Node => {
    const node: Node = { value, base, document: doc, tokens, mode };
    nodes.set(location(node), node);
    if (mode === 'schema' && value && typeof value === 'object') {
      if ('$dynamicRef' in value || '$dynamicAnchor' in value)
        throw new Error(
          `Unsupported OpenAPI ${document.openapi} feature at ${location(node)}: ${'$dynamicRef' in value ? '$dynamicRef' : '$dynamicAnchor'}`,
        );
      if (value.$id !== undefined) {
        if (typeof value.$id !== 'string') fail(node, 'Invalid $id');
        node.base = uri(value.$id, base, node);
        if (new URL(node.base).hash) fail(node, '$id must not contain a nonempty fragment');
        register(resources, node.base.replace(/#$/, ''), node);
      }
      if (value.$anchor !== undefined) {
        if (typeof value.$anchor !== 'string' || !/^[A-Za-z_][-A-Za-z0-9._]*$/.test(value.$anchor))
          fail(node, 'Invalid $anchor');
        register(anchors, `${node.base.split('#')[0]}#${value.$anchor}`, node);
      }
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        const next = Array.isArray(value)
          ? mode === 'schemaArray'
            ? 'schema'
            : 'oas'
          : childMode(node, key);
        if (next) index(child, node.base, doc, [...tokens, key], next);
      }
    }
    return node;
  };
  const addDocument = (value: any, url: string, isOpenAPI: boolean) => {
    loaded.add(url);
    let base = url;
    if (isOpenAPI && value.$self !== undefined) {
      if (!/^3\.2\./.test(value.openapi)) throw new Error('$self requires OpenAPI 3.2');
      if (typeof value.$self !== 'string') throw new Error('Invalid $self: expected a URI string');
      base = new URL(value.$self, url).href;
      if (new URL(base).hash) throw new Error('$self must not contain a nonempty fragment');
    }
    const root = index(value, base, url, [], isOpenAPI ? 'oas' : 'schema');
    register(resources, url, root);
    if (isOpenAPI) register(resources, base, root);
    return root;
  };
  const root = addDocument(document, retrieval, true);
  for (const [category, values] of Object.entries(document.components ?? {})) {
    used.set(category, new Set(Object.keys(values as object)));
    for (const name of Object.keys(values as object)) {
      const node = nodes.get(`${retrieval}#/components/${category}/${encodePointer(name)}`);
      if (node) outputs.set(node, reference(category, name));
    }
  }
  const target = async (ref: string, from: Node): Promise<Node> => {
    const absolute = uri(ref, from.base, from);
    const url = absolute.split('#')[0];
    if (!resources.has(url)) {
      if (loaded.has(url)) fail(from, `Unresolved resource ${url}`);
      const parsed = await RefParser.parse(url.startsWith('file:') ? fileURLToPath(url) : url);
      addDocument(parsed, url, !!(parsed as any)?.openapi);
    }
    const resource = resources.get(url)!;
    let fragment: string;
    try {
      fragment = decodeURIComponent(new URL(absolute).hash.slice(1));
    } catch {
      return fail(from, `Invalid fragment ${ref}`);
    }
    if (!fragment) return resource;
    if (!fragment.startsWith('/')) {
      const anchored =
        anchors.get(`${url}#${fragment}`) ??
        anchors.get(`${resource.base.split('#')[0]}#${fragment}`);
      return anchored ?? fail(from, `Unresolved anchor ${ref}`);
    }
    const tokens = fragment.slice(1).split('/');
    if (tokens.some((token) => /~(?![01])/u.test(token))) fail(from, `Invalid JSON Pointer ${ref}`);
    const found = nodes.get(
      `${resource.document}#/${pointer([...resource.tokens, ...tokens.map(decodePointer)])}`,
    );
    return found ?? fail(from, `Unresolved reference ${ref}`);
  };
  const promoted = new Map<Node, Promise<any>>();
  const promote = async (node: Node, category: string): Promise<string> => {
    const existing = outputs.get(node);
    if (existing) return existing;
    const names = used.get(category) ?? new Set<string>();
    used.set(category, names);
    const leaf = node.tokens[node.tokens.length - 1] || 'Schema';
    const externalIndex = [...loaded].indexOf(node.document) - 1;
    const baseName =
      externalIndex < 0
        ? `Schema_${leaf}`
        : `External${externalIndex}${node.tokens.length ? `_${leaf}` : ''}`;
    let name = baseName;
    for (let suffix = 2; names.has(name); suffix++) name = `${baseName}_${suffix}`;
    names.add(name);
    const ref = reference(category, name);
    outputs.set(node, ref); // Reserve before visiting recursive references.
    const value = render(node);
    promoted.set(node, value);
    (components[category] ??= {})[name] = await value;
    return ref;
  };
  const render = async (node: Node): Promise<any> => {
    if (!node.value || typeof node.value !== 'object') return node.value;
    const result: any = Array.isArray(node.value) ? [] : {};
    for (const [key, value] of Object.entries(node.value)) {
      if (node.mode === 'schema' && ['$id', '$anchor', '$defs'].includes(key)) continue;
      if (!node.tokens.length && key === '$self') continue;
      if (
        (node.mode === 'schema' || node.mode === 'oas') &&
        key === '$ref' &&
        typeof value === 'string'
      ) {
        const resolved = await target(value, node);
        const category =
          node.mode === 'schema'
            ? 'schemas'
            : resolved.tokens[0] === 'components'
              ? resolved.tokens[1]
              : undefined;
        if (!category) fail(node, `Unsupported non-schema reference ${value}`);
        if (node.mode === 'schema' && resolved.mode !== 'schema')
          fail(node, `Reference is not a schema: ${value}`);
        result[key] = await promote(resolved, category!);
      } else {
        const child = nodes.get(`${node.document}#/${pointer([...node.tokens, key])}`);
        // Copy literal data without interpreting its $ref/$id keys.
        Object.defineProperty(result, key, {
          value: child ? await render(child) : value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
    return result;
  };
  const result = await render(root);
  await Promise.all(promoted.values());
  result.components ??= {};
  for (const [category, values] of Object.entries(components))
    result.components[category] = { ...result.components[category], ...values };
  // A cycle consisting only of aliases has no structural TypeScript type and
  // would otherwise recurse indefinitely in the legacy component resolver.
  const schemas = result.components.schemas ?? {};
  const checked = new Set<string>();
  const visiting = new Set<string>();
  const checkAlias = (name: string) => {
    if (checked.has(name)) return;
    if (visiting.has(name))
      throw new Error(
        `Unsupported schema alias cycle at #/components/schemas/${encodePointer(name)}`,
      );
    visiting.add(name);
    const schema = schemas[name];
    if (
      schema &&
      typeof schema === 'object' &&
      schema.$ref &&
      Object.keys(schema).every((key) => ['$ref', 'summary', 'description'].includes(key))
    ) {
      checkAlias($ref2TypeName(schema.$ref).typeName);
    }
    visiting.delete(name);
    checked.add(name);
  };
  Object.keys(schemas).forEach(checkAlias);
  return { document: result, baseURI: root.base };
};
