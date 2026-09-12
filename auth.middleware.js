import jwt from 'jsonwebtoken';

/**
 * Requires a valid JWT in the Authorization header:
 *   Authorization: Bearer <token>
 * On success, attaches { id, role, email } to req.user.
 */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ status: 'error', message: 'Missing or malformed Authorization header' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.sub, role: payload.role, email: payload.email, full_name: payload.full_name };
    return next();
  } catch (err) {
    const message = err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token';
    return res.status(401).json({ status: 'error', message });
  }
}

/**
 * Like requireAuth, but does not fail the request if no/invalid token is
 * present — it just leaves req.user undefined. Useful for endpoints whose
 * response shape depends on whether the caller is logged in (e.g. the
 * public course list also showing an instructor's own drafts).
 */
export function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) return next();

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.sub, role: payload.role, email: payload.email, full_name: payload.full_name };
  } catch (err) {
    // Invalid/expired token on an optional route — proceed as anonymous.
  }
  return next();
}
