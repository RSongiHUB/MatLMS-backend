/**
 * Route guard factory: checkRole(['admin', 'instructor']) rejects any
 * request whose req.user.role (set by requireAuth) isn't in the allow-list.
 * Must run AFTER requireAuth in the middleware chain.
 */
export function checkRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ status: 'error', message: 'Authentication required' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        status: 'error',
        message: `This action requires one of the following roles: ${allowedRoles.join(', ')}`,
      });
    }
    return next();
  };
}
