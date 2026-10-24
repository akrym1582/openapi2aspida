import type { OpenAPIV3 } from 'openapi-types';
import { decodePointer, defKey2defName, encodePointer } from './builderUtils/converters';

const categories = ['schemas', 'parameters', 'requestBodies', 'responses', 'headers'] as const;

// All component categories share one generated TypeScript module. Allocate names
// before rendering so declarations and references cannot disagree, including cycles.
export default (document: OpenAPIV3.Document): OpenAPIV3.Document => {
  const components = document.components;
  if (!components) return document;
  const entries = categories.flatMap((category) =>
    Object.keys(components[category] ?? {})
      .sort()
      .map((key) => ({
        category,
        key,
        base: defKey2defName(key),
      })),
  );
  const reserved = new Set(entries.map(({ base }) => base));
  const used = new Set<string>();
  const names = new Map<string, string>();
  for (const { category, key, base } of entries) {
    let name = base;
    for (let suffix = 2; used.has(name); suffix++) {
      name = `${base}_${suffix}`;
      while (reserved.has(name)) name += '_';
    }
    used.add(name);
    names.set(`${category}/${key}`, name);
  }

  const rewrite = (value: any, isMap = false): any => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((child) => rewrite(child));
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if (!isMap && key === '$ref' && typeof child === 'string' && child.startsWith('#/')) {
          const parts = decodeURIComponent(child).split('/').map(decodePointer);
          const name = parts[1] === 'components' && names.get(`${parts[2]}/${parts[3]}`);
          if (name) {
            parts[3] = name;
            return [
              key,
              `#/${parts
                .slice(1)
                .map((part) => encodeURIComponent(encodePointer(part)))
                .join('/')}`,
            ];
          }
        }
        // These values are user data, not OpenAPI references.
        return [
          key,
          !isMap &&
          (['example', 'examples', 'default', 'enum', 'const'].includes(key) ||
            key.startsWith('x-'))
            ? child
            : rewrite(
                child,
                !isMap &&
                  [
                    'schemas',
                    'properties',
                    'parameters',
                    'requestBodies',
                    'responses',
                    'headers',
                    'paths',
                    'content',
                  ].includes(key),
              ),
        ];
      }),
    );
  };
  const result = rewrite(document) as OpenAPIV3.Document;
  for (const category of categories) {
    const values = result.components![category];
    if (values) {
      result.components![category] = Object.fromEntries(
        Object.entries(values).map(([key, value]) => [names.get(`${category}/${key}`)!, value]),
      );
    }
  }
  return result;
};
