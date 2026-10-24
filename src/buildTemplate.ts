import RefParser from '@apidevtools/json-schema-ref-parser';
import SwaggerParser from '@apidevtools/swagger-parser';
import type { OpenAPI, OpenAPIV3 } from 'openapi-types';
import buildV3 from './buildV3';
import type { Config } from './getConfig';
import normalizeOpenAPI31 from './normalizeOpenAPI31';
import resolveExternalRefs from './resolveExternalRefs';

const isV3 = (openapi: OpenAPI.Document): openapi is OpenAPIV3.Document => 'openapi' in openapi;

export default async ({ input, isYaml }: Config) => {
  const parsed = await RefParser.parse(input as any, { parse: { json: !isYaml } });
  const modern = /^3\.[12]\.\d+$/.test((parsed as any).openapi);
  if (modern) {
    const document = parsed as unknown as OpenAPIV3.Document;
    if (
      !document.info ||
      typeof document.info.version !== 'string' ||
      !('paths' in document || 'components' in document || 'webhooks' in document)
    ) {
      throw new Error(
        'Invalid OpenAPI document: info and paths, components or webhooks are required',
      );
    }
    // Fail before resolving external references whose base URI semantics we do not support.
    normalizeOpenAPI31(document);
    const resolved = await resolveExternalRefs(document, typeof input === 'string' ? input : '');
    const normalized = normalizeOpenAPI31(resolved);
    if (typeof input === 'string' && /^https?:\/\//.test(input)) {
      normalized.servers = normalized.servers?.map((server) => ({
        ...server,
        url: new URL(server.url, input).href,
      }));
    }
    return buildV3(normalized);
  }
  // Keep the legacy parser's checks and relative-server handling for 2.0/3.0.
  const openapi = await SwaggerParser.parse(
    typeof input === 'string' ? input : '',
    parsed as OpenAPI.Document,
    { parse: { json: !isYaml } },
  );
  const docs = isV3(openapi)
    ? openapi
    : await require('swagger2openapi').convertObj(openapi, { direct: true, resolveInternal: true });

  return resolveExternalRefs(docs, typeof input === 'string' ? input : '').then(buildV3);
};
