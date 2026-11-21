import type { APIGatewayProxyResult } from 'aws-lambda';

export function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export function errorResponse(statusCode: number, message: string): APIGatewayProxyResult {
  return json(statusCode, { message });
}

/** REST API proxy events may base64-encode the body depending on binary media type settings. */
export function decodeBody(body: string | null, isBase64Encoded: boolean): string | null {
  if (body === null) {
    return null;
  }
  return isBase64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
}
