const jwt = require('jsonwebtoken');
const PortalUser = require('../modules/portal/portalUser.model');

/**
 * Authenticates a PortalUser (super admin or customer) from a Bearer token and
 * attaches the live document to the request.
 *
 * Unlike `auth`, this re-reads the user on every request so a suspension or a
 * package change from the admin portal takes effect immediately rather than
 * when the token happens to expire.
 */
async function portalAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) return res.status(401).json({ message: 'Unauthorized' });

    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);

    const portalUser = await PortalUser.findById(decoded.sub);
    if (!portalUser) return res.status(401).json({ message: 'Unauthorized' });

    if (portalUser.status === 'suspended') {
      return res.status(403).json({ message: 'Account suspended. Contact your administrator.' });
    }

    req.portalUser = portalUser;
    req.portalUserId = portalUser._id;
    // Keep `req.userId` populated so existing handlers that read it keep working.
    req.userId = portalUser._id;

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    next(err);
  }
}

/** Restricts a route to the given portal roles. Use after `portalAuth`. */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.portalUser) return res.status(401).json({ message: 'Unauthorized' });
    if (!roles.includes(req.portalUser.role)) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    next();
  };
}

module.exports = { portalAuth, requireRole };
