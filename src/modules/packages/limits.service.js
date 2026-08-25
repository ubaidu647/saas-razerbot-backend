const Package = require('./package.model');
const Proxy = require('../proxy/proxy.model');
const RazerAccount = require('../razerAccounts/razerAccount.model');

/**
 * Central place where package caps are resolved and enforced. Every limit
 * check in the app goes through here so the rules live in exactly one file.
 */

const UNLIMITED = null;

// Applied when a customer has no package assigned. Deliberately zero: an
// unassigned account can look around but cannot consume resources.
const NO_PACKAGE_LIMITS = {
  maxGoldAccounts: 0,
  maxSilverAccounts: 0,
  maxProxies: 0,
};

const SUPERADMIN_LIMITS = {
  maxGoldAccounts: UNLIMITED,
  maxSilverAccounts: UNLIMITED,
  maxProxies: UNLIMITED,
};

class LimitError extends Error {
  constructor(message, details) {
    super(message);
    this.status = 403;
    this.code = 'PACKAGE_LIMIT_REACHED';
    this.details = details;
  }
}

function isUnlimited(limit) {
  return limit === null || limit === undefined;
}

/** Resolves the effective caps for a portal user, honouring package expiry. */
async function getLimitsFor(portalUser) {
  if (!portalUser) return { ...NO_PACKAGE_LIMITS, packageName: null };
  if (portalUser.role === 'superadmin') return { ...SUPERADMIN_LIMITS, packageName: 'Super Admin' };

  if (!portalUser.packageId) return { ...NO_PACKAGE_LIMITS, packageName: null, reason: 'No package assigned' };

  if (portalUser.packageExpiresAt && portalUser.packageExpiresAt.getTime() < Date.now()) {
    return { ...NO_PACKAGE_LIMITS, packageName: null, reason: 'Package expired' };
  }

  const pkg = await Package.findById(portalUser.packageId).lean();
  if (!pkg) return { ...NO_PACKAGE_LIMITS, packageName: null, reason: 'Package no longer exists' };
  if (!pkg.active) return { ...NO_PACKAGE_LIMITS, packageName: pkg.name, reason: 'Package is inactive' };

  return {
    packageId: pkg._id,
    packageName: pkg.name,
    maxGoldAccounts: pkg.maxGoldAccounts,
    maxSilverAccounts: pkg.maxSilverAccounts,
    maxProxies: pkg.maxProxies,
  };
}

/** Counts what the user is currently consuming against each cap. */
async function getUsageFor(ownerId) {
  const [gold, silver, proxies] = await Promise.all([
    RazerAccount.countDocuments({ ownerId, type: 'gold', status: 'active' }),
    RazerAccount.countDocuments({ ownerId, type: 'silver', status: 'active' }),
    Proxy.countDocuments({ ownerId }),
  ]);
  return { goldAccounts: gold, silverAccounts: silver, proxies };
}

/** Limits + usage + remaining, shaped for the dashboard. */
async function getUsageSummary(portalUser) {
  const limits = await getLimitsFor(portalUser);
  const usage = await getUsageFor(portalUser._id);

  const remaining = (limit, used) => (isUnlimited(limit) ? null : Math.max(0, limit - used));

  return {
    package: {
      id: limits.packageId || null,
      name: limits.packageName,
      reason: limits.reason || null,
    },
    limits: {
      goldAccounts: limits.maxGoldAccounts,
      silverAccounts: limits.maxSilverAccounts,
      proxies: limits.maxProxies,
    },
    usage,
    remaining: {
      goldAccounts: remaining(limits.maxGoldAccounts, usage.goldAccounts),
      silverAccounts: remaining(limits.maxSilverAccounts, usage.silverAccounts),
      proxies: remaining(limits.maxProxies, usage.proxies),
    },
  };
}

/**
 * Throws unless the user can add `count` more proxies.
 */
async function assertCanAddProxies(portalUser, count = 1) {
  const limits = await getLimitsFor(portalUser);
  if (isUnlimited(limits.maxProxies)) return;

  const used = await Proxy.countDocuments({ ownerId: portalUser._id });
  if (used + count > limits.maxProxies) {
    throw new LimitError(
      limits.maxProxies === 0
        ? `Your ${limits.packageName ? `"${limits.packageName}" package` : 'account'} does not allow adding proxies.${limits.reason ? ` (${limits.reason})` : ''}`
        : `Proxy limit reached — your package allows ${limits.maxProxies}, you have ${used}.`,
      { limit: limits.maxProxies, used, requested: count, resource: 'proxies' }
    );
  }
}

/**
 * Throws unless the user can hold the given Razer accounts of `type`.
 *
 * Accounts already registered to this owner do not consume a new slot, so
 * reloading the same batch is always allowed.
 */
async function assertCanLoadAccounts(portalUser, type, emails) {
  const limits = await getLimitsFor(portalUser);
  const max = type === 'gold' ? limits.maxGoldAccounts : limits.maxSilverAccounts;
  if (isUnlimited(max)) return { newEmails: emails, limit: null };

  const normalized = [...new Set(emails.map((e) => String(e).toLowerCase().trim()))];

  const existing = await RazerAccount.find({
    ownerId: portalUser._id,
    type,
    status: 'active',
  }).select('email').lean();

  const held = new Set(existing.map((a) => a.email));
  const newEmails = normalized.filter((e) => !held.has(e));

  if (held.size + newEmails.length > max) {
    const label = type === 'gold' ? 'gold' : 'silver';
    throw new LimitError(
      max === 0
        ? `Your ${limits.packageName ? `"${limits.packageName}" package` : 'account'} does not allow loading ${label} accounts.${limits.reason ? ` (${limits.reason})` : ''}`
        : `${label[0].toUpperCase() + label.slice(1)} account limit reached — your package allows ${max}, you already have ${held.size} and this request adds ${newEmails.length} more.`,
      { limit: max, used: held.size, requested: newEmails.length, resource: `${type}Accounts` }
    );
  }

  return { newEmails, limit: max };
}

module.exports = {
  LimitError,
  UNLIMITED,
  isUnlimited,
  getLimitsFor,
  getUsageFor,
  getUsageSummary,
  assertCanAddProxies,
  assertCanLoadAccounts,
};
