import fs from 'fs';
import type { OpenAPIV3 } from 'openapi-types';
import os from 'os';
import path from 'path';
import ts from 'typescript';
import { expect, test } from 'vitest';
import buildV3 from '../src/buildV3';
import { $ref2Type, defKey2defName } from '../src/builderUtils/converters';

export const document = (schemas: OpenAPIV3.ComponentsObject['schemas']): OpenAPIV3.Document => ({
  openapi: '3.0.3',
  info: { title: 'Test', version: '1' },
  paths: {},
  components: { schemas },
});

export function checkTypes(source: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openapi-types-'));
  try {
    const file = path.join(dir, 'types.ts');
    fs.writeFileSync(file, source);
    const program = ts.createProgram([file], {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
    });
    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
    ).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('Japanese, Unicode and invalid names produce legal identifiers', () => {
  expect(defKey2defName('顧客情報')).toBe('顧客情報');
  expect(defKey2defName('顧客番号')).toBe('顧客番号');
  expect(defKey2defName('pet')).toBe('Pet');
  expect(defKey2defName('123')).toBe('$123');
  const names = [
    '',
    '顧客情報',
    '顧客番号',
    'あア漢字',
    '𠮷野家',
    'e\u0301',
    '😀name',
    '-name',
    '1name',
    '$name',
  ];
  checkTypes(
    [...new Set(names.map(defKey2defName))]
      .map((name) => `export type ${name} = string;`)
      .join('\n'),
  );
});

test('declarations and refs agree across collisions, categories, cycles and escaped pointers', () => {
  const input = document({
    顧客情報: {
      type: 'object',
      properties: {
        番号: { $ref: '#/components/schemas/顧客番号' },
        default: { $ref: '#/components/schemas/a-b' },
        next: { $ref: '#/components/schemas/顧客情報' },
      },
    },
    顧客番号: { type: 'integer' },
    'a-b': { type: 'string' },
    a_b: { type: 'number' },
    A_b_2: { type: 'boolean' },
    '顧客/詳細~': { type: 'object', properties: { "名'前": { type: 'string' } } },
    Alias: { $ref: '#/components/schemas/%E9%A1%A7%E5%AE%A2~1%E8%A9%B3%E7%B4%B0~0' },
    CustomerArray: { type: 'array', items: { $ref: '#/components/schemas/顧客情報' } },
    List: { $ref: '#/components/schemas/CustomerArray' },
  });
  input.components!.parameters = {
    顧客情報: { name: 'search', in: 'query', schema: { type: 'string' } },
  };
  input.paths = {
    '/customers': {
      get: {
        parameters: [{ $ref: '#/components/parameters/顧客情報' }],
        responses: {
          '200': {
            description: '',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/顧客情報' } } },
          },
        },
      },
    },
  };
  const before = JSON.stringify(input);
  const result = buildV3(input);
  expect(JSON.stringify(input)).toBe(before);
  expect(result.types).toContain('export type 顧客情報 =');
  expect(result.types).toContain('export type 顧客番号 = number');
  expect(result.types).toContain('export type A_b = string');
  expect(result.types).toContain('export type A_b_2_ = number');
  expect(result.types).toContain('export type 顧客情報_2 =');
  expect(result.types).toContain('export type List = CustomerArray');
  expect(result.files[0].methods).toContain('Types.顧客情報_2');
  expect(result.files[0].methods).toContain('Types.顧客情報');
  checkTypes(result.types!);
  const reversed = document(
    Object.fromEntries(Object.entries(input.components!.schemas!).reverse()),
  );
  reversed.components!.parameters = input.components!.parameters;
  expect(buildV3(reversed).types?.match(/export type A_b[^\n]+/g)).toEqual(
    expect.arrayContaining(result.types!.match(/export type A_b[^\n]+/g)!),
  );
});

test('property references decode JSON Pointer and URI escapes', () => {
  expect($ref2Type('#/components/schemas/顧客/properties/a~1b~0c')).toBe("Types.顧客['a/b~c']");
  expect($ref2Type('#/components/schemas/顧客/properties/')).toBe("Types.顧客['']");
});
