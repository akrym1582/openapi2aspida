import { expect, test } from 'vitest';
import buildTemplate from '../src/buildTemplate';
import { checkTypes } from './helpers';

export const modernDocument = (schemas: any, openapi = '3.1.1') => ({
  openapi,
  info: { title: 'Modern schemas', version: '1' },
  paths: {},
  components: { schemas },
});
export const generateModern = (input: any) => buildTemplate({ input, isYaml: false, output: '' });

test('tuples preserve optional prefixes, rest items, lengths, refs and nullable unions', async () => {
  const input = modernDocument({
    番号: { type: 'integer' },
    座標: {
      type: 'array',
      prefixItems: [{ type: 'number' }, { type: 'number' }],
      items: false,
      minItems: 2,
    },
    Optional: {
      type: 'array',
      prefixItems: [{ type: 'string' }, { type: 'boolean' }],
      items: false,
    },
    Rest: {
      type: 'array',
      prefixItems: [{ $ref: '#/components/schemas/番号' }],
      minItems: 1,
      items: { type: ['string', 'null'] },
    },
    Bounded: {
      type: 'array',
      prefixItems: [{ type: 'string' }],
      minItems: 2,
      maxItems: 3,
      items: { type: 'number' },
    },
    Truncated: {
      type: 'array',
      prefixItems: [{ type: 'string' }, { type: 'number' }],
      maxItems: 1,
    },
    Impossible: { type: 'array', prefixItems: [false], minItems: 1 },
    Stop: { type: 'array', prefixItems: [{ type: 'string' }, false, true] },
    Nullable: {
      type: ['array', 'null'],
      prefixItems: [{ type: 'string' }],
      items: false,
      minItems: 1,
    },
    Nested: {
      type: 'array',
      prefixItems: [{ type: 'array', prefixItems: [true], items: false }],
      items: false,
    },
  });
  const result = await generateModern(input);
  expect(result.types).toContain('export type 座標 = [number, number]');
  expect(result.types).toContain('export type Impossible = never');
  checkTypes(`${result.types}
const coordinate: 座標 = [1, 2];
const optional: Optional = [];
const rest: Rest = [1, 'a', null];
const bounded: Bounded = ['a', 1, 2];
const truncated: Truncated = ['a'];
const stop: Stop = ['a'];
const nullable: Nullable = null;
const nested: Nested = [[]];
// @ts-expect-error missing coordinate
const bad1: 座標 = [1];
// @ts-expect-error no tail allowed
const bad2: 座標 = [1, 2, 3];
// @ts-expect-error incorrect optional prefix
const bad3: Optional = [true];
// @ts-expect-error rest element type
const bad4: Rest = [1, false];
// @ts-expect-error minimum length
const bad5: Bounded = ['a'];
// @ts-expect-error maximum length
const bad6: Bounded = ['a', 1, 2, 3];
// @ts-expect-error false prefix ends the tuple
const bad7: Stop = ['a', 1];
// @ts-expect-error impossible tuple
const bad8: Impossible = [1];
// @ts-expect-error nullable tuple still requires an element
const bad9: Nullable = [];
`);
}, 20000);

test('structured const values and enum/type combinations retain literal types', async () => {
  const result = await generateModern(
    modernDocument({
      ObjectValue: {
        const: { 種類: '顧客', nested: { enabled: true }, values: [1, null, "it's"] },
      },
      ArrayValue: { const: [{ id: 1 }, 'x'] },
      Same: { const: { a: 1, b: 2 }, enum: [{ b: 2, a: 1 }] },
      Conflict: { const: { a: 1 }, enum: [{ a: 2 }] },
      Typed: { type: ['string', 'null'], enum: ['a', null, 42] },
      Invalid: { type: 'number', const: 'x' },
      LiteralReference: { const: { 'Types.key': 'Types.Value', text: ']?:' } },
      Constrained: { const: { x: 'value' }, type: 'object', properties: { x: { type: 'number' } } },
    }),
  );
  expect(result.types).toContain('export type Conflict = never');
  expect(result.types).toContain('export type Invalid = never');
  checkTypes(`${result.types}
const a: ObjectValue = { 種類: '顧客', nested: { enabled: true }, values: [1, null, "it's"] };
const b: ArrayValue = [{ id: 1 }, 'x'];
const c: Same = { a: 1, b: 2 };
const d: Typed = null;
const literalReference: LiteralReference = { 'Types.key': 'Types.Value', text: ']?:' };
// @ts-expect-error const must also satisfy sibling schema constraints
const conflict: Constrained = { x: 'value' };
// @ts-expect-error wrong deep literal
const bad1: ObjectValue = { 種類: '顧客', nested: { enabled: false }, values: [1, null, "it's"] };
// @ts-expect-error wrong tuple literal
const bad2: ArrayValue = [{ id: 2 }, 'x'];
// @ts-expect-error type filters enum
const bad3: Typed = 42;
`);
}, 20000);

test('very large tuple expansions fail explicitly', async () => {
  await expect(
    generateModern(
      modernDocument({ Large: { type: 'array', prefixItems: [true], minItems: 1001 } }),
    ),
  ).rejects.toThrow('Tuple length bounds above 1000');
});
