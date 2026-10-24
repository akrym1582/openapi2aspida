import { getSWRDefaultKey } from '@aspida/swr';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { expect, test } from 'vitest';
import buildTemplate from '../src/buildTemplate';
import writeRouteFile from '../src/writeRouteFile';

// Compile the actual generated client together with a normal useAspidaSWR call,
// then exercise $get, $path and SWR's real key helper without making HTTP calls.
test('generated 3.2 client keeps aspida and SWR typing and runtime contract', async () => {
  const dir = fs.mkdtempSync(path.resolve('.swr-test-'));
  try {
    const outputDir = path.join(dir, 'api');
    fs.mkdirSync(outputDir);
    const result = await buildTemplate({
      input: {
        openapi: '3.2.0',
        info: { title: 'Customers', version: '1' },
        servers: [{ url: 'https://example.com' }],
        components: {
          schemas: {
            顧客情報: {
              type: 'object',
              required: ['名前'],
              properties: { 名前: { type: 'string' } },
            },
          },
        },
        paths: {
          '/customers': {
            get: {
              parameters: [
                { name: 'limit', in: 'query', required: true, schema: { type: 'integer' } },
              ],
              responses: {
                '200': {
                  description: 'OK',
                  content: {
                    'application/json': { schema: { $ref: '#/components/schemas/顧客情報' } },
                  },
                },
              },
            },
          },
        },
      },
      isYaml: false,
      output: outputDir,
    });
    writeRouteFile({
      config: { input: outputDir, baseURL: result.baseURL },
      outputDir,
      types: result.types,
      files: result.files,
    });
    const consumer = path.join(dir, 'consumer.ts');
    fs.writeFileSync(
      consumer,
      `
import useAspidaSWR from '@aspida/swr';
import type { AspidaClient } from 'aspida';
import api from './api/$api';
import type { 顧客情報 } from './api/@types';
declare const transport: AspidaClient<{}>;
const client = api(transport);
const response = useAspidaSWR(client.customers, { query: { limit: 10 } });
const customer: 顧客情報 | undefined = response.data;
// @ts-expect-error required query is still enforced
useAspidaSWR(client.customers);
// @ts-expect-error numeric query type is still enforced
useAspidaSWR(client.customers, { query: { limit: 'ten' } });
// @ts-expect-error response shape is preserved
const wrong: number | undefined = response.data;
`,
    );
    const program = ts.createProgram([consumer], {
      strict: true,
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      target: ts.ScriptTarget.ES2022,
      outDir: path.join(dir, 'js'),
    });
    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
    ).toEqual([]);
    program.emit();
    const factory = require(path.join(dir, 'js/api/$api.js')).default;
    const calls: unknown[] = [];
    const customer = { 名前: '田中' };
    const client = factory({
      baseURL: 'https://example.com',
      fetch: (...args: unknown[]) => {
        calls.push(args);
        return { json: async () => ({ body: customer, status: 200, headers: {} }) };
      },
    });
    expect(await client.customers.$get({ query: { limit: 10 } })).toEqual(customer);
    expect(calls[0]).toEqual([
      'https://example.com',
      '/customers',
      'GET',
      { query: { limit: 10 } },
    ]);
    expect(getSWRDefaultKey(client.customers, { query: { limit: 10 } })).toEqual([
      'https://example.com/customers?limit=10',
      '$get',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20000);
