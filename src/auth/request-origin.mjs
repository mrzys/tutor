import { isIP } from 'node:net';

function trustedLoopback(request, trustProxy) {
  return trustProxy && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
}

/** Forwarded protocol is accepted only from an explicitly trusted local proxy. */
export function secureRequest(request, trustProxy = process.env.TUTOR_TRUST_PROXY === 'loopback') {
  return Boolean(request.socket.encrypted || (trustedLoopback(request, trustProxy)
    && request.headers['x-forwarded-proto'] === 'https'));
}

export function requestClientAddress(request, trustProxy = process.env.TUTOR_TRUST_PROXY === 'loopback') {
  const forwarded = request.headers['x-real-ip'];
  return trustedLoopback(request, trustProxy) && typeof forwarded === 'string' && isIP(forwarded)
    ? forwarded : request.socket.remoteAddress ?? 'unknown';
}

export function requestOrigin(request, trustProxy) {
  return `${secureRequest(request, trustProxy) ? 'https' : 'http'}://${request.headers.host}`;
}
