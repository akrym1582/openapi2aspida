import type { OpenAPIV3 } from 'openapi-types';
import type { Prop, PropValue } from './props2String';
import { value2String } from './props2String';

// ECMAScript identifiers allow Unicode letters, combining marks and joiners.
export const defKey2defName = (key: string) => {
  const [first = '_', ...rest] = Array.from(key);
  const start = /^[$_\p{ID_Start}]$/u.test(first)
    ? first.toUpperCase()
    : `$${/^\p{ID_Continue}$/u.test(first) ? first : '_'}`;
  return start + rest.map((c) => (/^[$\u200c\u200d\p{ID_Continue}]$/u.test(c) ? c : '_')).join('');
};

export const decodePointer = (token: string) => token.replace(/~1/g, '/').replace(/~0/g, '~');
export const encodePointer = (token: string) => token.replace(/~/g, '~0').replace(/\//g, '~1');

export const $ref2TypeName = (ref: string) => {
  const [, , , typeName, , propName] = decodeURIComponent(ref).split('/').map(decodePointer);
  return { typeName, propName: propName ?? null };
};

export const quoteString = (value: string) =>
  /['\\\r\n\u2028\u2029]/.test(value) ? JSON.stringify(value) : `'${value}'`;

export const $ref2Type = (ref: string) => {
  const { typeName, propName } = $ref2TypeName(ref);
  return `Types.${defKey2defName(typeName)}${propName !== null ? `[${quoteString(propName)}]` : ''}`;
};

export const isRefObject = (
  params:
    | OpenAPIV3.ReferenceObject
    | OpenAPIV3.ResponseObject
    | OpenAPIV3.RequestBodyObject
    | OpenAPIV3.HeaderObject
    | OpenAPIV3.ParameterObject
    | OpenAPIV3.SchemaObject,
): params is OpenAPIV3.ReferenceObject =>
  !!params && typeof params === 'object' && '$ref' in params;

const isArraySchema = (schema: OpenAPIV3.SchemaObject): schema is OpenAPIV3.ArraySchemaObject =>
  schema.type === 'array';

export const isObjectSchema = (
  schema: OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject,
): schema is OpenAPIV3.NonArraySchemaObject => !isRefObject(schema) && schema.type !== 'array';

export const getPropertyName = (name: string) =>
  /^[a-zA-Z_$][0-9a-zA-Z_$]*$/.test(name) ? name : quoteString(name);

const of2Values = (obj: OpenAPIV3.SchemaObject): PropValue[] | null => {
  const values = (obj.oneOf || obj.allOf || obj.anyOf || [])
    .map((p) => schema2value(p))
    .filter(Boolean) as PropValue[];
  return values.length ? values : null;
};

const object2value = (obj: OpenAPIV3.NonArraySchemaObject): Prop[] => {
  const properties = obj.properties ?? {};

  const value = Object.keys(properties)
    .filter((name) => {
      const target = properties[name];
      return isRefObject(target) || !target.deprecated;
    })
    .map<Prop | null>((name) => {
      const val = schema2value(properties[name]);
      if (!val) return null;

      return {
        name: getPropertyName(name),
        required: obj.required?.includes(name) ?? false,
        description: val.description,
        values: [val],
      };
    })
    .filter((v) => v) as Prop[];

  const additionalProps = obj.additionalProperties;
  if (additionalProps) {
    const val =
      additionalProps === true
        ? {
            isArray: false,
            isEnum: false,
            nullable: false,
            description: null,
            value: 'any',
          }
        : schema2value(additionalProps);

    if (val)
      value.push({
        name: '[key: string]',
        required: true,
        description: val.description,
        values: [val],
      });
  }

  return value;
};

export const BINARY_TYPE = '(File | ReadStream)';

export const schema2value = (
  schema: OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject | boolean | undefined,
  isResponse?: true,
): PropValue | null => {
  if (typeof schema === 'boolean')
    return {
      isArray: false,
      isEnum: false,
      nullable: false,
      description: null,
      value: schema ? 'unknown' : 'never',
    };
  if (!schema) return null;

  let isArray = false;
  let isEnum = false;
  let nullable = false;
  let hasOf: PropValue['hasOf'];
  let value: PropValue['value'] | null = null;
  let description: PropValue['description'] = null;

  if (isRefObject(schema)) {
    value = $ref2Type(schema.$ref);
  } else {
    nullable = !!schema.nullable;
    description = schema.description ?? null;

    if (schema.oneOf || schema.allOf || schema.anyOf) {
      hasOf = schema.oneOf ? 'oneOf' : schema.allOf ? 'allOf' : 'anyOf';
      value = of2Values(schema);
    } else if (schema.enum) {
      isEnum = true;
      value = schema.enum.map((e) => (typeof e === 'string' ? quoteString(e) : JSON.stringify(e)));
    } else if ('prefixItems' in schema && Array.isArray(schema.prefixItems)) {
      const tuple = schema as OpenAPIV3.ArraySchemaObject & {
        prefixItems: (OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject | boolean)[];
      };
      const min = tuple.minItems ?? 0;
      const max = tuple.maxItems ?? Infinity;
      if (
        !Number.isInteger(min) ||
        min < 0 ||
        (max !== Infinity && (!Number.isInteger(max) || max < 0))
      )
        throw new Error('Invalid tuple length bounds');
      // Avoid unbounded source expansion from huge minItems/maxItems values.
      if (min > 1000 || (max !== Infinity && max > 1000))
        throw new Error('Tuple length bounds above 1000 are unsupported');
      const count = Math.min(tuple.prefixItems.length, max);
      const parts: string[] = [];
      let impossible = min > max;
      for (let index = 0; index < count; index++) {
        const item = tuple.prefixItems[index];
        if (item === false) {
          impossible ||= index < min;
          break;
        }
        const text = value2String(schema2value(item, isResponse)!, '');
        parts.push(index < min ? text : `(${text})?`);
      }
      const stopped = parts.length < count;
      const rest = schema2value(tuple.items ?? true, isResponse)!;
      if (!stopped) {
        if ((tuple.items as unknown) === false && min > count) impossible = true;
        else {
          for (let index = count; index < Math.max(min, max === Infinity ? count : max); index++) {
            if ((tuple.items as unknown) === false) break;
            const text = value2String(rest, '');
            parts.push(index < min ? text : `(${text})?`);
          }
          if (max === Infinity && (tuple.items as unknown) !== false)
            parts.push(`...(${value2String(rest, '')})[]`);
        }
      }
      value = impossible ? 'never' : `[${parts.join(', ')}]`;
    } else if (isArraySchema(schema)) {
      isArray = true;
      value = schema2value(schema.items);
    } else if (schema.properties || schema.additionalProperties) {
      value = object2value(schema);
    } else if (schema.format === 'binary') {
      value = isResponse ? 'Blob' : BINARY_TYPE;
    } else if (schema.type !== 'object') {
      value = schema.type
        ? {
            integer: 'number',
            number: 'number',
            null: 'null',
            string: 'string',
            boolean: 'boolean',
          }[schema.type]
        : null;
    }
  }

  return value ? { isArray, isEnum, nullable, hasOf, value, description } : null;
};
