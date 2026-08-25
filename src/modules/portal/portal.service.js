const PortalUser = require('./portalUser.model');
const { compare, hashPassword } = require('../../utils/hash');
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require('../../utils/jwt');
const { getUsageSummary } = require('../packages/limits.service');

/**
 * Customer portal sign-in.
 *
 * This authenticates against the credentials the super admin issued — it does
 * NOT touch Razer. Razer accounts are attached separately from the dashboard
 * once the user is signed in.
 */
async function login({ email, password }) {
  const user = await PortalUser.findOne({ email: String(email).toLowerCase().trim() });
  if (!user) throw { status: 401, message: 'Invalid credentials' };

  const ok = await compare(password, user.password);
  if (!ok) throw { status: 401, message: 'Invalid credentials' };

  if (user.status === 'suspended') {
    throw { status: 403, message: 'Your account has been suspended. Contact your administrator.' };
  }

  const accessToken = signAccessToken(user._id);
  const refreshToken = signRefreshToken(user._id);
  user.refreshToken = refreshToken;
  user.lastLoginAt = new Date();
  await user.save();

  return {
    user: user.toSafeJSON(),
    usage: await getUsageSummary(user),
    accessToken,
    refreshToken,
  };
}

async function refresh(token) {
  let payload;
  try {
    payload = verifyRefreshToken(token);
  } catch {
    throw { status: 401, message: 'Invalid token' };
  }

  const user = await PortalUser.findById(payload.sub);
  if (!user || user.refreshToken !== token) throw { status: 401, message: 'Invalid token' };
  if (user.status === 'suspended') throw { status: 403, message: 'Account suspended' };

  const accessToken = signAccessToken(user._id);
  const newRefresh = signRefreshToken(user._id);
  user.refreshToken = newRefresh;
  await user.save();

  return { accessToken, refreshToken: newRefresh };
}

async function logout(userId) {
  await PortalUser.findByIdAndUpdate(userId, { $set: { refreshToken: null } });
  return { success: true };
}

async function changePassword(user, { currentPassword, newPassword }) {
  const ok = await compare(currentPassword, user.password);
  if (!ok) throw { status: 400, message: 'Current password is incorrect' };

  user.password = await hashPassword(newPassword);
  // Force other sessions to re-authenticate with the new password.
  user.refreshToken = null;
  await user.save();

  return { success: true };
}

module.exports = { login, refresh, logout, changePassword };
