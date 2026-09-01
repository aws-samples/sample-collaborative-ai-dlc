export const actorFrom = (event) => {
  const claims = event?.requestContext?.authorizer?.claims ?? {};
  return claims.email || claims.sub || 'unknown';
};

export const requireUser = (event) => {
  if (event?.requestContext?.authorizer?.claims?.sub) return null;
  return { statusCode: 401, error: 'Unauthorized' };
};

export const parseBody = (event) => {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400 });
  }
};

export const pathParts = (event) =>
  String(event.path ?? '')
    .split('/')
    .filter(Boolean);

export const responseError = (response, error) =>
  response(error.statusCode ?? 500, {
    error: error.statusCode ? error.message : 'Internal server error',
    ...(error.code ? { code: error.code } : {}),
    ...(error.issues ? { issues: error.issues } : {}),
  });

export const createRetryableInitializer = (initialize) => {
  let initialization;
  return () => {
    initialization ??= Promise.resolve()
      .then(initialize)
      .catch((error) => {
        initialization = null;
        throw error;
      });
    return initialization;
  };
};
