const allowedOrigin = (headers) => {
  const origins = (process.env.CORS_ALLOWED_ORIGINS || '*').split(',');
  const reqOrigin = headers?.origin || headers?.Origin;
  return origins.includes(reqOrigin) ? reqOrigin : origins[0];
};

/**
 * Returns a curried response helper bound to the current request's Origin header.
 *
 * @param {object} event  – Lambda proxy-integration event
 * @param {object} [opts]
 * @param {string} [opts.methods='GET,POST,PUT,DELETE,OPTIONS'] – Access-Control-Allow-Methods value
 * @returns {(statusCode: number, body: any) => object}
 */
const buildResponse =
  (event, { methods = 'GET,POST,PUT,DELETE,OPTIONS' } = {}) =>
  (statusCode, body, extraHeaders = {}) => ({
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': allowedOrigin(event?.headers),
      'Access-Control-Allow-Headers':
        'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
      'Access-Control-Allow-Methods': methods,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });

export { allowedOrigin, buildResponse };
export default { allowedOrigin, buildResponse };
