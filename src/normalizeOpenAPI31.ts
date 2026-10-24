import type { OpenAPIV3 } from 'openapi-types';

// Adapt the supported JSON Schema vocabulary to the existing 3.0 renderer.
// This is deliberately not an OpenAPI/JSON Schema validator.
export default (document: Record<string, any>): OpenAPIV3.Document => {
  const unsupported = (location: string, feature: string): never => {
    throw new Error(`Unsupported OpenAPI ${document.openapi} feature at ${location}: ${feature}`);
  };
  const schema = (value: any, location: string): any => {
    if (typeof value === 'boolean') return value;
    if (!value || typeof value !== 'object') throw new Error(`Invalid schema at ${location}`);
    for (const key of [
      '$id',
      '$anchor',
      '$dynamicAnchor',
      '$dynamicRef',
      '$defs',
      'unevaluatedProperties',
      'unevaluatedItems',
      'if',
      'then',
      'else',
      'contains',
      'dependentSchemas',
    ]) {
      if (key in value) unsupported(location, key);
    }
    if (
      value.$schema &&
      ![
        'https://json-schema.org/draft/2020-12/schema',
        'https://spec.openapis.org/oas/3.1/dialect/base',
        'https://spec.openapis.org/oas/3.2/dialect/base',
      ].includes(value.$schema)
    ) {
      unsupported(location, 'custom $schema dialect');
    }
    if (value.$ref && !/^#\/components\/schemas\//.test(value.$ref) && value.$ref.startsWith('#'))
      unsupported(location, 'schema reference outside components/schemas');
    const result = { ...value };
    for (const key of ['properties', 'patternProperties']) {
      if (result[key]) {
        if (key === 'patternProperties') unsupported(location, key);
        result[key] = Object.fromEntries(
          Object.entries(result[key]).map(([name, child]) => [
            name,
            schema(child, `${location}/${key}/${name}`),
          ]),
        );
      }
    }
    for (const key of ['items', 'additionalProperties', 'not']) {
      if (key in result && !(key === 'additionalProperties' && typeof result[key] === 'boolean')) {
        if (key === 'not') unsupported(location, key);
        result[key] = schema(result[key], `${location}/${key}`);
      }
    }
    for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
      if (result[key])
        result[key] = result[key].map((child: any, index: number) =>
          schema(child, `${location}/${key}/${index}`),
        );
    }
    if ('const' in result) {
      const canonical = (value: any): string =>
        JSON.stringify(value, (_key, child) =>
          child && typeof child === 'object' && !Array.isArray(child)
            ? Object.fromEntries(
                Object.keys(child)
                  .sort()
                  .map((key) => [key, child[key]]),
              )
            : child,
        );
      result.enum = result.enum
        ? result.enum.filter((v: unknown) => canonical(v) === canonical(result.const))
        : [result.const];
      delete result.const;
      if (!result.enum.length) return false;
    }
    if (Array.isArray(result.type)) {
      const types = result.type;
      delete result.type;
      // A union member must retain its own items/properties and composition.
      return {
        anyOf: types.map((type: string) => {
          const member = { ...result, type };
          if (type !== 'object') {
            delete member.properties;
            delete member.additionalProperties;
          }
          if (type !== 'array') {
            delete member.items;
            delete member.prefixItems;
          }
          return schema(member, location);
        }),
        description: result.description,
      };
    }
    if (result.enum && typeof result.type === 'string') {
      result.enum = result.enum.filter((v: any) =>
        result.type === 'null'
          ? v === null
          : result.type === 'integer'
            ? typeof v === 'number' && Number.isInteger(v)
            : result.type === 'array'
              ? Array.isArray(v)
              : result.type === 'object'
                ? v !== null && typeof v === 'object' && !Array.isArray(v)
                : typeof v === result.type,
      );
      if (!result.enum.length) return false;
    }
    if (result.prefixItems && result.type !== 'array') {
      if (result.type) delete result.prefixItems;
      else unsupported(location, 'prefixItems without type: array');
    }
    if (
      result.$ref &&
      Object.keys(result).some((key) => !['$ref', 'description', 'summary'].includes(key))
    ) {
      const { $ref, ...siblings } = result;
      return { allOf: [{ $ref }, siblings], description: siblings.description };
    }
    if (
      result.enum &&
      ['properties', 'additionalProperties', 'items', 'prefixItems'].some((key) => key in result)
    ) {
      const { enum: values, ...constraints } = result;
      return {
        allOf: [{ enum: values }, schema(constraints, location)],
        description: result.description,
      };
    }
    const compositions = ['allOf', 'anyOf', 'oneOf'].filter((key) => key in result);
    if (
      compositions.length &&
      (compositions.length > 1 ||
        ['type', 'properties', 'additionalProperties', 'enum'].some((key) => key in result))
    ) {
      const base = { ...result };
      for (const key of compositions) delete base[key];
      return {
        allOf: [schema(base, location), ...compositions.map((key) => ({ [key]: result[key] }))],
        description: result.description,
      };
    }
    if (result.type === 'array' && !('items' in result)) result.items = true;
    if (result.type === 'object' && !result.properties) {
      result.properties = {};
      if (!('additionalProperties' in result)) result.additionalProperties = true;
    }
    // In JSON Schema an unconstrained schema admits every JSON value.
    if (
      !result.$ref &&
      !result.type &&
      !result.enum &&
      !result.properties &&
      !('additionalProperties' in result) &&
      !result.allOf &&
      !result.anyOf &&
      !result.oneOf
    )
      return true;
    return result;
  };

  const walk = (value: any, location: string, isMap = false): any => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((v, i) => walk(v, `${location}/${i}`));
    if (!isMap) {
      for (const key of [
        '$self',
        'webhooks',
        'additionalOperations',
        'query',
        'trace',
        'itemSchema',
      ]) {
        // `query` is an operation on Path Item Objects, not an arbitrary key.
        if (
          key in value &&
          ((key !== 'query' && key !== 'trace') || /^#\/paths\/[^/]+$/.test(location))
        )
          unsupported(location, key);
      }
      if (value.in === 'querystring') unsupported(location, 'querystring parameter');
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        const next = `${location}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
        if (!isMap && key === 'schema') return [key, schema(child, next)];
        if (location === '#/components' && key === 'schemas')
          return [
            key,
            Object.fromEntries(
              Object.entries(child as object).map(([name, s]) => [
                name,
                schema(s, `${next}/${name}`),
              ]),
            ),
          ];
        if (
          !isMap &&
          (['example', 'examples', 'default', 'enum', 'const'].includes(key) ||
            key.startsWith('x-'))
        )
          return [key, child];
        return [
          key,
          walk(
            child,
            next,
            !isMap &&
              [
                'paths',
                'content',
                'parameters',
                'headers',
                'responses',
                'requestBodies',
                'callbacks',
                'pathItems',
              ].includes(key),
          ),
        ];
      }),
    );
  };
  if (
    document.jsonSchemaDialect &&
    ![
      'https://spec.openapis.org/oas/3.1/dialect/base',
      'https://spec.openapis.org/oas/3.2/dialect/base',
      'https://json-schema.org/draft/2020-12/schema',
    ].includes(document.jsonSchemaDialect)
  )
    unsupported('#', 'custom jsonSchemaDialect');
  const result = walk(document, '#');
  return { ...result, paths: result.paths ?? {} };
};
