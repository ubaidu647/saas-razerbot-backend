const Proxy = require('./proxy.model');
const { reloadProxies } = require('../../utils/proxyAxios');
const { assertCanAddProxies, getUsageSummary } = require('../packages/limits.service');

const isAdmin = (req) => req.portalUser?.role === 'superadmin';

/** Customers see the shared pool plus their own; the super admin sees everything. */
function scopeFor(req) {
  if (isAdmin(req)) return {};
  return { $or: [{ ownerId: req.portalUserId }, { ownerId: null }] };
}

async function listProxies(req, res, next) {
  try {
    const proxies = await Proxy.find(scopeFor(req)).sort({ id: 1 }).lean();

    const shaped = proxies.map((p) => ({
      ...p,
      // A customer may use a shared proxy but not edit it.
      owned: String(p.ownerId || '') === String(req.portalUserId),
      shared: p.ownerId == null,
      password: isAdmin(req) ? p.password : undefined,
    }));

    return res.json({
      success: true,
      proxies: shaped,
      usage: isAdmin(req) ? null : await getUsageSummary(req.portalUser),
    });
  } catch (err) {
    next(err);
  }
}

/** Numeric ids are globally unique, so allocate the next free one. */
async function nextProxyId() {
  const highest = await Proxy.findOne({}).sort({ id: -1 }).select('id').lean();
  return (highest?.id || 0) + 1;
}

async function createProxy(req, res, next) {
  try {
    const { label, country, ip, port, username, password, dedicated, disabled } = req.body || {};

    if (!label || !ip || !port) {
      return res.status(400).json({ success: false, message: 'label, ip, and port are required' });
    }

    // Package cap. Throws a 403 LimitError, handled by the global error handler.
    if (!isAdmin(req)) await assertCanAddProxies(req.portalUser, 1);

    // The super admin may pin an id and create shared proxies; customers cannot.
    const ownerId = isAdmin(req) ? (req.body.ownerId ?? null) : req.portalUserId;

    let proxy;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = isAdmin(req) && req.body.id != null ? Number(req.body.id) : await nextProxyId();

      const exists = await Proxy.findOne({ id });
      if (exists) {
        if (isAdmin(req) && req.body.id != null) {
          return res.status(409).json({ success: false, message: `Proxy with id ${id} already exists` });
        }
        continue; // id was taken between read and write — try the next one
      }

      try {
        proxy = await Proxy.create({
          id, label, country, ip, port, username, password,
          dedicated: !!dedicated,
          disabled: !!disabled,
          ownerId,
        });
        break;
      } catch (err) {
        if (err?.code === 11000 && !(isAdmin(req) && req.body.id != null)) continue;
        throw err;
      }
    }

    if (!proxy) {
      return res.status(409).json({ success: false, message: 'Could not allocate a proxy id, please retry' });
    }

    await reloadProxies();
    return res.status(201).json({
      success: true,
      proxy,
      usage: isAdmin(req) ? null : await getUsageSummary(req.portalUser),
    });
  } catch (err) {
    next(err);
  }
}

/** Resolves a proxy the caller is allowed to mutate (own only, unless admin). */
async function findEditable(req, id) {
  const filter = isAdmin(req) ? { id } : { id, ownerId: req.portalUserId };
  return Proxy.findOne(filter);
}

async function updateProxy(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, message: 'id must be a number' });
    }

    const existing = await findEditable(req, id);
    if (!existing) {
      return res.status(404).json({ success: false, message: `Proxy ${id} not found` });
    }

    const allowed = ['label', 'country', 'ip', 'port', 'username', 'password', 'dedicated', 'disabled'];
    for (const key of allowed) {
      if (key in (req.body || {})) existing[key] = req.body[key];
    }
    await existing.save();

    await reloadProxies();
    return res.json({ success: true, proxy: existing });
  } catch (err) {
    next(err);
  }
}

async function deleteProxy(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, message: 'id must be a number' });
    }

    const existing = await findEditable(req, id);
    if (!existing) {
      return res.status(404).json({ success: false, message: `Proxy ${id} not found` });
    }
    await existing.deleteOne();

    await reloadProxies();
    return res.json({
      success: true,
      usage: isAdmin(req) ? null : await getUsageSummary(req.portalUser),
    });
  } catch (err) {
    next(err);
  }
}

async function reload(req, res, next) {
  try {
    const list = await reloadProxies();
    return res.json({ success: true, count: list.length });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listProxies,
  createProxy,
  updateProxy,
  deleteProxy,
  reload,
};
