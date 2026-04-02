'use strict';

const serverless = require('serverless-http');
const app = require('../../server');

// The binary option here controls RESPONSE encoding only — it tells
// serverless-http which response content-types to base64-encode in the
// Netlify function return payload (required for binary file downloads).
// Request body decoding is handled explicitly below before handler() runs.
const handler = serverless(app, {
  binary: ['application/pdf', 'application/octet-stream'],
});

module.exports.handler = async (event, context) => {
  // Critical: tell Lambda not to wait for the event loop to drain before
  // returning the response. Without this, the Anthropic SDK's undici HTTP
  // connection pool keeps sockets open (for keep-alive reuse), which holds
  // the event loop open even after res.json() has been called and
  // serverless-http has collected the response. Lambda then sits frozen with
  // the response buffered internally until the 26-second execution limit fires.
  context.callbackWaitsForEmptyEventLoop = false;

  // Confirm the API key is present before anything else runs.
  console.log('[triangulation-api] ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY ? 'DEFINED' : 'UNDEFINED');

  // Visible in Netlify dashboard → Site → Functions → api → Logs
  console.log('[triangulation-api] invoked', JSON.stringify({
    method:      event.httpMethod,
    path:        event.path,
    rawUrl:      event.rawUrl,
    isBase64:    event.isBase64Encoded,
    contentType: (event.headers || {})['content-type']
                 || (event.headers || {})['Content-Type'],
  }));

  // Netlify base64-encodes all binary request bodies (multipart/form-data
  // file uploads arrive with isBase64Encoded: true). The serverless-http
  // binary option only controls response encoding — it does NOT decode the
  // request body. Without explicit decoding here, multer receives base64
  // ASCII text instead of raw multipart bytes and hangs parsing silently.
  if (event.isBase64Encoded && event.body) {
    event.body = Buffer.from(event.body, 'base64');
    event.isBase64Encoded = false;
    console.log('[triangulation-api] decoded base64 request body, bytes:', event.body.length);
  }

  // Restore the original request path if Netlify set event.path to the
  // function's own path instead of the client's original path.
  if (event.rawUrl && (event.path || '').startsWith('/.netlify')) {
    try {
      event.path = new URL(event.rawUrl).pathname;
      console.log('[triangulation-api] path corrected to', event.path);
    } catch (_) { /* rawUrl unparseable — leave path as-is */ }
  }

  try {
    const result = await handler(event, context);
    console.log('[triangulation-api] response status', result.statusCode);
    return result;
  } catch (err) {
    // Without this catch, any crash in serverless-http or Express causes
    // Netlify to return its own HTML error page.
    console.error('[triangulation-api] unhandled error:', err.message);
    console.error(err.stack);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error:   'function_error',
        message: err.message || 'Internal server error',
      }),
    };
  }
};
