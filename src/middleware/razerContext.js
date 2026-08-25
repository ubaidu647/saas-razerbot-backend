const RegisteredUser = require('../modules/auth/user.model');

/**
 * Resolves which Razer account the request operates on.
 *
 * Before the SaaS split the portal user *was* a Razer account, so downstream
 * modules (transactions, games, silver, wallet) could read `req.userId` for
 * both. Now that they are separate, this middleware re-populates `req.userId`
 * with the Razer account id those modules expect, scoped to the caller's
 * tenant so one customer can never drive another's account.
 *
 * The account is chosen from, in order:
 *   1. the `x-razer-account` header (email)
 *   2. `razerEmail` in the body or query string
 *   3. the caller's only Razer account, when they have exactly one
 *
 * Must run after `portalAuth`.
 */
async function razerContext(req, res, next) {
  try {
    if (!req.portalUserId) return res.status(401).json({ message: 'Unauthorized' });

    const requested =
      req.headers['x-razer-account'] ||
      req.body?.razerEmail ||
      req.query?.razerEmail;

    if (requested) {
      const email = String(requested).toLowerCase().trim();
      const account = await RegisteredUser.findOne({ email, ownerId: req.portalUserId });

      if (!account) {
        return res.status(404).json({
          success: false,
          code: 'RAZER_ACCOUNT_NOT_FOUND',
          message: `Razer account "${email}" is not loaded on this portal account.`,
        });
      }

      req.razerUser = account;
      req.userId = account._id;
      return next();
    }

    const owned = await RegisteredUser.find({ ownerId: req.portalUserId }).limit(2);

    if (owned.length === 0) {
      return res.status(409).json({
        success: false,
        code: 'NO_RAZER_ACCOUNT',
        message: 'No Razer account loaded yet. Add one before using this feature.',
      });
    }

    if (owned.length > 1) {
      return res.status(400).json({
        success: false,
        code: 'RAZER_ACCOUNT_REQUIRED',
        message: 'Multiple Razer accounts loaded — specify which one via the x-razer-account header.',
      });
    }

    req.razerUser = owned[0];
    req.userId = owned[0]._id;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = razerContext;
