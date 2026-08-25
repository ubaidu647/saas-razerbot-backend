const portalService = require('./portal.service');
const { getUsageSummary } = require('../packages/limits.service');
const razerAccountService = require('../razerAccounts/razerAccount.service');

const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (err) {
    next(err);
  }
};

const login = handle(async (req, res) => {
  res.json(await portalService.login(req.body));
});

const me = handle(async (req, res) => {
  res.json({
    user: req.portalUser.toSafeJSON(),
    usage: await getUsageSummary(req.portalUser),
  });
});

// Drives the limit meters on the dashboard.
const usage = handle(async (req, res) => {
  res.json({ success: true, ...(await getUsageSummary(req.portalUser)) });
});

const refresh = handle(async (req, res) => {
  const token = req.body.refreshToken || req.cookies?.refreshToken;
  if (!token) return res.status(400).json({ message: 'Refresh token required' });
  res.json(await portalService.refresh(token));
});

const logout = handle(async (req, res) => {
  res.json(await portalService.logout(req.portalUserId));
});

const changePassword = handle(async (req, res) => {
  res.json(await portalService.changePassword(req.portalUser, req.body));
});

const listAccounts = handle(async (req, res) => {
  const accounts = await razerAccountService.listForOwner(req.portalUserId, req.query.type);
  res.json({ success: true, accounts });
});

// Frees a slot against the package cap.
const releaseAccount = handle(async (req, res) => {
  const released = await razerAccountService.release(req.portalUserId, req.params.id);
  if (!released) return res.status(404).json({ success: false, message: 'Account not found' });
  res.json({ success: true, usage: await getUsageSummary(req.portalUser) });
});

module.exports = { login, me, usage, refresh, logout, changePassword, listAccounts, releaseAccount };
