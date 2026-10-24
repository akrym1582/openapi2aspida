import RefParser from '@apidevtools/json-schema-ref-parser';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { expect, test, vi } from 'vitest';
import buildTemplate from '../src/buildTemplate';
import resolveModernRefs from '../src/resolveModernRefs';
import { checkTypes } from './helpers';

const doc = (schemas: any, openapi = '3.1.1') => ({
  openapi,
  info: { title: 'Refs', version: '1' },
  paths: {},
  components: { schemas },
});
const generate = (input: any) => buildTemplate({ input, isYaml: false, output: '' });

test('local defs, URI identifiers, anchors, Japanese pointers and recursive types', async () => {
  const input = doc({
    顧客: {
      $id: 'https://schemas.example/customer',
      $anchor: 'customer',
      type: 'object',
      required: ['番号'],
      $defs: { '番号/~': { type: 'integer' }, 名前: { $anchor: 'name', type: 'string' } },
      properties: {
        番号: { $ref: '#/$defs/%E7%95%AA%E5%8F%B7~1~0' },
        名前: { $ref: '#name' },
        next: { $ref: '#customer' },
      },
    },
    Alias: { $ref: 'https://schemas.example/customer#name' },
    Schema_番号__: { type: 'boolean' },
  });
  const original = JSON.stringify(input);
  const result = await generate(input);
  expect(JSON.stringify(input)).toBe(original);
  expect(result.types).toContain('export type 顧客 =');
  checkTypes(`${result.types}
const a: 顧客 = { 番号: 1, 名前: '田中', next: { 番号: 2 } };
const b: Alias = '名前';
// @ts-expect-error reference must remain numeric
const bad: 顧客 = { 番号: '1' };
`);
}, 20000);

test('nested resource IDs reset pointer and anchor scope, including forward refs', async () => {
  const result = await generate(
    doc({
      Alias: { $ref: 'https://schemas.example/child#value' },
      Root: {
        $id: 'https://schemas.example/root',
        $defs: {
          child: {
            $id: 'child',
            $defs: { Value: { $anchor: 'value', type: 'integer' } },
            type: 'object',
            properties: { id: { $ref: '#/$defs/Value' } },
          },
          Value: { $anchor: 'value', type: 'string' },
        },
        type: 'object',
        properties: { child: { $ref: 'child' }, name: { $ref: '#value' } },
      },
    }),
  );
  checkTypes(`${result.types}
const a: Alias = 1;
const b: Root = { name: 'a', child: { id: 2 } };
// @ts-expect-error nested anchor has a different type from parent anchor
const bad: Alias = '1';
`);
}, 20000);

test('external relative files, recursion, retrieval aliases and generated-name collisions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modern-refs-'));
  try {
    fs.mkdirSync(path.join(dir, 'schemas'));
    fs.writeFileSync(
      path.join(dir, 'schemas/a.json'),
      JSON.stringify({
        $id: 'a.json',
        type: 'object',
        properties: { b: { $ref: './b.json' } },
        $defs: { Flag: false },
      }),
    );
    fs.writeFileSync(
      path.join(dir, 'schemas/b.json'),
      JSON.stringify({
        type: 'object',
        properties: { a: { $ref: './a.json' }, value: { type: 'string' } },
      }),
    );
    const input = doc({
      A: { $ref: './schemas/a.json' },
      B: { $ref: './schemas/b.json' },
      Flag: { $ref: './schemas/a.json#/$defs/Flag' },
      External0: { type: 'number' },
    });
    const file = path.join(dir, 'api.json');
    fs.writeFileSync(file, JSON.stringify(input));
    const result = await generate(file);
    expect(result.types).toContain('export type External0 = number');
    checkTypes(`${result.types}
const a: A = { b: { a: {}, value: 'ok' } };
// @ts-expect-error preserve externally referenced property type
const bad: B = { value: 1 };
// @ts-expect-error false external schema
const impossible: Flag = true;
`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20000);

test('3.2 self URI supplies the base for references and server URLs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modern-self-'));
  try {
    fs.mkdirSync(path.join(dir, 'canonical'));
    fs.writeFileSync(path.join(dir, 'canonical/value.json'), JSON.stringify({ type: 'integer' }));
    const file = path.join(dir, 'download.json');
    const input = {
      ...doc({ Value: { $ref: './value.json' } }, '3.2.0'),
      $self: './canonical/api.json',
    };
    fs.writeFileSync(file, JSON.stringify(input));
    expect((await generate(file)).types).toContain('export type External0 = number');
    const resolved = await resolveModernRefs(
      { ...doc({}, '3.2.0'), $self: '../canonical/api.json' },
      'https://example.com/download/api.json',
    );
    expect(resolved.baseURI).toBe('https://example.com/canonical/api.json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('literal examples and const data are never interpreted as schema references', async () => {
  const input = doc({
    Data: {
      const: { $ref: 'missing.json', $id: 'not-an-id', $defs: { x: 1 } },
      example: { $ref: 'missing.json' },
    },
  });
  const result = await generate(input);
  expect(result.types).toContain('"$ref":"missing.json"');
});

test.each([
  ['missing pointer', { A: { $ref: '#/components/schemas/Missing' } }, 'Unresolved reference'],
  ['missing anchor', { A: { $ref: '#missing' } }, 'Unresolved anchor'],
  ['bad escape', { A: { $ref: '#/components/schemas/~2' } }, 'Invalid JSON Pointer'],
  [
    'duplicate ID',
    {
      A: { $id: 'https://example.com/x', type: 'string' },
      B: { $id: 'https://example.com/x', type: 'number' },
    },
    'Duplicate schema identifier',
  ],
  [
    'duplicate anchor',
    { A: { $anchor: 'x', type: 'string' }, B: { $anchor: 'x', type: 'number' } },
    'Duplicate schema identifier',
  ],
  ['non-schema target', { A: { $ref: '#/info' } }, 'Reference is not a schema'],
  ['dynamic', { A: { $dynamicRef: '#node' } }, '$dynamicRef'],
])('rejects %s with a diagnostic', async (_name, schemas, message) => {
  await expect(generate(doc(schemas))).rejects.toThrow(message);
});

test('remote self and nested external resources resolve against their own base and load once', async () => {
  const root = {
    ...doc({ A: { $ref: './schemas/a.json' }, B: { $ref: './schemas/a.json#value' } }, '3.2.0'),
    $self: 'https://canonical.example/spec/api.json',
    servers: [{ url: '../api' }],
  };
  const external = {
    $id: './a.json',
    $defs: { Value: { $anchor: 'value', type: 'integer' } },
    type: 'object',
    properties: { value: { $ref: '#value' } },
  };
  const parse = vi.spyOn(RefParser, 'parse').mockImplementation(async (input: any) => {
    if (input === 'https://download.example/api.json') return root as any;
    if (input === 'https://canonical.example/spec/schemas/a.json') return external as any;
    throw new Error(`Unexpected retrieval: ${input}`);
  });
  try {
    const result = await generate('https://download.example/api.json');
    expect(result.baseURL).toBe('https://canonical.example/api');
    expect(parse.mock.calls.map((call) => call[0])).toEqual([
      'https://download.example/api.json',
      'https://canonical.example/spec/schemas/a.json',
    ]);
    expect(result.types).toContain('export type External0_Value = number');
  } finally {
    parse.mockRestore();
  }
});

test('pure alias cycles fail before the legacy renderer recurses', async () => {
  await expect(
    generate(doc({ A: { $ref: '#/components/schemas/B' }, B: { $ref: '#/components/schemas/A' } })),
  ).rejects.toThrow('schema alias cycle');
});

test('schema data named $ref and URI special characters remain literal', async () => {
  const input = doc({
    A: {
      type: 'object',
      $defs: { '百分率%': { type: 'number' } },
      properties: { $ref: { $ref: '#/components/schemas/A/$defs/百分率%25' } },
    },
  });
  const result = await generate(input);
  checkTypes(
    `${result.types}\nconst a: A = { $ref: 1 };\n// @ts-expect-error\nconst bad: A = { $ref: 'x' };`,
  );
});

test('retrieval URI aliases resolve anchors under an absolute canonical schema id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modern-alias-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'schema.json'),
      JSON.stringify({ $id: 'https://schemas.example/canonical', $anchor: 'root', type: 'string' }),
    );
    const input = doc({
      Alias: { $ref: './schema.json#root' },
      Canonical: { $ref: 'https://schemas.example/canonical#root' },
    });
    const file = path.join(dir, 'api.json');
    fs.writeFileSync(file, JSON.stringify(input));
    const result = await generate(file);
    expect(result.types).toContain('export type Alias = External0');
    expect(result.types).toContain('export type Canonical = External0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
