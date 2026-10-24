import RefParser from '@apidevtools/json-schema-ref-parser';
import fs from 'fs';
import yaml from 'js-yaml';
import os from 'os';
import path from 'path';
import { expect, test, vi } from 'vitest';
import buildTemplate from '../src/buildTemplate';
import buildV3 from '../src/buildV3';
import { checkTypes, document } from './helpers';

const generate = (input: any, isYaml = false) => buildTemplate({ input, isYaml, output: '' });
const modern = (schemas: any = {}) => ({ ...document(schemas), openapi: '3.2.0' });

test.each(['3.1.0', '3.1.1', '3.2.0', '3.2.1'])(
  '%s preserves the existing 3.0 request/response contract',
  async (openapi) => {
    const input = document({
      顧客: { type: 'object', required: ['名前'], properties: { 名前: { type: 'string' } } },
    });
    input.paths = {
      '/customers': {
        post: {
          parameters: [{ in: 'query', name: 'limit', schema: { type: 'integer' } }],
          requestBody: {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/顧客' } } },
          },
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/顧客' } } },
            },
          },
        },
      },
    };
    const legacy = await generate(input);
    const result = await generate({ ...input, openapi });
    expect(result.types).toBe(legacy.types);
    expect(result.files).toEqual(legacy.files);
    expect(result.baseURL).toBe(legacy.baseURL);
  },
);

test('3.2 JSON Schema types, nullability, const, boolean schemas and ref siblings', async () => {
  const input = modern({
    名前: { type: ['string', 'null'] },
    数値: { type: ['number', 'string'] },
    顧客: {
      type: ['object', 'null'],
      properties: { 名前: { $ref: '#/components/schemas/名前' }, 禁止: false },
    },
    一覧: { type: 'array', items: { type: ['string', 'null'] } },
    定数: { const: "it's a customer" },
    混在: { enum: ['a', 1, null, true] },
    任意: true,
    禁止: false,
    空: {},
    共通: { type: 'object', properties: { id: { type: 'integer' } } },
    拡張: {
      $ref: '#/components/schemas/共通',
      type: 'object',
      properties: { extra: { const: 42 } },
    },
  });
  const old = buildV3(input);
  const result = await generate(input);
  expect(old.types).not.toContain('export type 名前 = string | null');
  for (const text of [
    'export type 名前 = string | null',
    'export type 数値 = number | string',
    'export type 一覧 = (string | null)[]',
    'export type 任意 = unknown',
    'export type 禁止 = never',
    'export type 空 = unknown',
    'export type 拡張 = 共通 &',
    'extra?: 42',
    "export type 混在 = 'a' | 1 | null | true",
  ])
    expect(result.types).toContain(text);
  checkTypes(
    `${result.types!}\nconst customer: 顧客 = null; const list: 一覧 = [null, "a"];\n// @ts-expect-error\nconst invalid: 名前 = 12;\n// @ts-expect-error\nconst impossible: 禁止 = 1;\n`,
  );
});

test.each(['json', 'yaml'])('reads 3.2 %s files and external Japanese refs', async (format) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openapi32-'));
  try {
    const input = modern({ 顧客: { $ref: './external.json#/components/schemas/顧客情報' } });
    fs.writeFileSync(
      path.join(dir, 'external.json'),
      JSON.stringify(modern({ 顧客情報: { type: ['string', 'null'] } })),
    );
    const file = path.join(dir, `api.${format}`);
    fs.writeFileSync(file, format === 'json' ? JSON.stringify(input) : yaml.dump(input));
    const result = await generate(file, format === 'yaml');
    expect(result.types).toContain('export type External0_顧客情報 = string | null');
    checkTypes(result.types!);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('components-only documents and false response bodies', async () => {
  const input = modern({ 顧客: { type: 'string' } });
  const componentsOnly = { openapi: input.openapi, info: input.info, components: input.components };
  expect((await generate(componentsOnly)).types).toContain('export type 顧客 = string');
  input.paths = {
    '/none': {
      get: {
        responses: {
          '200': { description: '', content: { 'application/json': { schema: false as any } } },
        },
      },
    },
  };
  expect((await generate(input)).files[0].methods).toContain('resBody: never');
});

test.each([
  ['$self', { $self: 'https://example.com/api' }],
  ['webhooks', { webhooks: {} }],
  ['additionalOperations', { paths: { '/x': { additionalOperations: { COPY: {} } } } }],
  ['query', { paths: { '/x': { query: {} } } }],
  ['trace', { paths: { '/x': { trace: {} } } }],
  [
    'querystring',
    {
      paths: {
        '/x': {
          get: { parameters: [{ in: 'querystring', name: 'filter', schema: { type: 'string' } }] },
        },
      },
    },
  ],
  [
    'itemSchema',
    {
      paths: {
        '/x': {
          get: {
            responses: {
              '200': { content: { 'application/jsonl': { itemSchema: { type: 'string' } } } },
            },
          },
        },
      },
    },
  ],
  [
    'prefixItems',
    { components: { schemas: { Tuple: { type: 'array', prefixItems: [{ type: 'string' }] } } } },
  ],
  ['$dynamicRef', { components: { schemas: { Dynamic: { $dynamicRef: '#node' } } } }],
  ['custom jsonSchemaDialect', { jsonSchemaDialect: 'https://example.com/custom' }],
])('rejects unsupported %s with a location', async (feature, extension) => {
  await expect(generate({ ...modern(), ...extension })).rejects.toThrow(
    new RegExp(`Unsupported OpenAPI 3.2.0 feature at .*: ${feature.replace(/\$/g, '\\$')}`),
  );
});

test('does not interpret user example data as OpenAPI features', async () => {
  const input = modern({
    Data: { type: 'string', example: { $self: 'literal', query: 1 }, const: 'hello' },
  });
  expect((await generate(input)).types).toContain("export type Data = 'hello'");
});

test('does not silently accept future OpenAPI versions', async () => {
  await expect(generate({ ...modern(), openapi: '3.3.0' })).rejects.toThrow(
    'Unsupported OpenAPI version',
  );
});

test('nested composition preserves intersections and unconstrained arrays', async () => {
  const result = await generate(
    modern({
      Value: { type: 'string', anyOf: [{ const: 'a' }, { const: 'b' }] },
      Items: { type: 'array' },
      Empty: { type: 'object', additionalProperties: false },
    }),
  );
  expect(result.types).toContain("export type Value = string & ('a' | 'b')");
  expect(result.types).toContain('export type Items = unknown[]');
  expect(result.types).toContain('export type Empty = {');
  checkTypes(
    `${result.types}\nconst valid: Value = 'a';\n// @ts-expect-error\nconst invalid: Value = 'c';`,
  );
});

test('3.2 descriptive metadata does not change the generated contract', async () => {
  const input = modern({ 顧客: { type: 'string' } });
  const baseline = await generate(input);
  const result = await generate({
    ...input,
    info: { ...input.info, summary: 'Customers' },
    tags: [{ name: 'customers', summary: 'Customers', kind: 'nav', parent: 'accounts' }],
    servers: [{ url: 'https://example.com', name: 'production' }],
  });
  expect(result.types).toBe(baseline.types);
  expect(result.files).toEqual(baseline.files);
  expect(result.baseURL).toBe('https://example.com');
});

test('resolves relative server URLs against the remote document URL', async () => {
  const input = { ...modern(), servers: [{ url: '../api' }] };
  const parse = vi.spyOn(RefParser, 'parse').mockResolvedValue(input as any);
  try {
    expect((await generate('https://example.com:8443/spec/openapi.json')).baseURL).toBe(
      'https://example.com:8443/api',
    );
  } finally {
    parse.mockRestore();
  }
});
