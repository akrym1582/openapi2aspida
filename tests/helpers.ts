import fs from 'fs';
import type { OpenAPIV3 } from 'openapi-types';
import os from 'os';
import path from 'path';
import ts from 'typescript';
import { expect } from 'vitest';
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
      moduleResolution: ts.ModuleResolutionKind.Node10,
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
