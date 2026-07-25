/**
 * Small HTTP helpers shared by the router and the Durable Objects.
 *
 * Every response the API produces is JSON with a machine-readable `error` code,
 * so the client can map a failure to a specific, actionable message rather than
 * showing a status number to someone standing in a field.
 */

export function json(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, {
    ...init,
    headers: {
      // The API is never cacheable; the shell is, and that is the assets
      // binding's business rather than ours.
      'cache-control': 'no-store',
      ...init.headers,
    },
  });
}

export function apiError(
  code: string,
  message: string,
  status = 400,
  extra: Record<string, unknown> = {},
): Response {
  return json({ error: code, message, ...extra }, { status });
}

/**
 * For endpoints and classes that exist so a deploy succeeds, but are not built
 * yet. Names the plan file, so a 501 in a log points at the work rather than
 * being a mystery.
 */
export function notImplemented(what: string, planFile: string): Response {
  return apiError(
    'not_implemented',
    `${what} is not built yet. See ${planFile}.`,
    501,
  );
}
