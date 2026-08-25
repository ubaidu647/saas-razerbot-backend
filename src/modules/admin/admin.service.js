const PortalUser = require('../portal/portalUser.model');
const Package = require('../packages/package.model');
const Proxy = require('../proxy/proxy.model');
const RazerAccount = require('../razerAccounts/razerAccount.model');
const { getUsageFor } = require('../packages/limits.service');
const { hashPassword, compare } = require('../../utils/hash');
const { signAccessToken, signRefreshToken } = require('../../utils/jwt');

/* ---------------------------------------------------------------- auth ---- */

async function login({ email, password }) {
  const user = await PortalUser.findOne({ email: String(email).toLowerCase().trim() });

  // Same message either way so the endpoint can't be used to enumerate admins.
  if (!user || user.role !== 'superadmin') throw { status: 401, message: 'Invalid credentials' };

  const ok = await compare(password, user.password);
  if (!ok) throw { status: 401, message: 'Invalid credentials' };

  if (user.status === 'suspended') throw { status: 403, message: 'Account suspended' };

  const accessToken = signAccessToken(user._id);
  const refreshToken = signRefreshToken(user._id);
  user.refreshToken = refreshToken;
  user.lastLoginAt = new Date();
  await user.save();

  return { user: user.toSafeJSON(), accessToken, refreshToken };
}

/* --------------------------------------------------------------- users ---- */

async function listUsers({ search, status, packageId, page = 1, limit = 25 }) {
  const filter = { role: 'user' };
  if (status) filter.status = status;
  if (packageId) filter.packageId = packageId;
  if (search) {
    const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ email: rx }, { name: rx }];
  }

  const skip = (Math.max(1, page) - 1) * limit;

  const [users, total] = await Promise.all([
    PortalUser.find(filter)
      .populate('packageId', 'name maxGoldAccounts maxSilverAccounts maxProxies')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    PortalUser.countDocuments(filter),
  ]);

  // Attach live usage so the admin table shows consumption against each cap.
  const withUsage = await Promise.all(
    users.map(async (u) => ({
      ...u,
      id: u._id,
      password: undefined,
      refreshToken: undefined,
      usage: await getUsageFor(u._id),
    }))
  );

  return { users: withUsage, total, page: Math.max(1, page), limit };
}

async function getUser(id) {
  const user = await PortalUser.findById(id)
    .populate('packageId', 'name maxGoldAccounts maxSilverAccounts maxProxies')
    .lean();
  if (!user) throw { status: 404, message: 'User not found' };

  const [usage, accounts, proxies] = await Promise.all([
    getUsageFor(user._id),
    RazerAccount.find({ ownerId: user._id, status: 'active' }).lean(),
    Proxy.find({ ownerId: user._id }).select('-password').lean(),
  ]);

  return { ...user, id: user._id, password: undefined, refreshToken: undefined, usage, accounts, proxies };
}

async function createUser(data, createdBy) {
  const email = String(data.email).toLowerCase().trim();

  const existing = await PortalUser.findOne({ email });
  if (existing) throw { status: 409, message: 'Email already in use' };

  if (data.packageId) {
    const pkg = await Package.findById(data.packageId);
    if (!pkg) throw { status: 400, message: 'Package not found' };
  }

  const user = await PortalUser.create({
    name: data.name || '',
    email,
    password: await hashPassword(data.password),
    role: 'user',
    status: data.status || 'active',
    packageId: data.packageId || null,
    packageAssignedAt: data.packageId ? new Date() : null,
    packageExpiresAt: data.packageExpiresAt || null,
    createdBy: createdBy || null,
  });

  return user.toSafeJSON();
}

async function updateUser(id, data) {
  const user = await PortalUser.findById(id);
  if (!user) throw { status: 404, message: 'User not found' };
  if (user.role === 'superadmin') throw { status: 403, message: 'Cannot modify a super admin from this endpoint' };

  if (data.email) {
    const email = String(data.email).toLowerCase().trim();
    const clash = await PortalUser.findOne({ email, _id: { $ne: user._id } });
    if (clash) throw { status: 409, message: 'Email already in use' };
    user.email = email;
  }

  if (data.password) user.password = await hashPassword(data.password);
  if (data.name !== undefined) user.name = data.name;
  if (data.status) user.status = data.status;
  if (data.packageExpiresAt !== undefined) user.packageExpiresAt = data.packageExpiresAt;

  if (data.packageId !== undefined) {
    if (data.packageId) {
      const pkg = await Package.findById(data.packageId);
      if (!pkg) throw { status: 400, message: 'Package not found' };
    }
    // Only stamp the assignment date when the package actually changes.
    if (String(user.packageId || '') !== String(data.packageId || '')) {
      user.packageAssignedAt = data.packageId ? new Date() : null;
    }
    user.packageId = data.packageId || null;
  }

  await user.save();
  return user.toSafeJSON();
}

async function deleteUser(id) {
  const user = await PortalUser.findById(id);
  if (!user) throw { status: 404, message: 'User not found' };
  if (user.role === 'superadmin') throw { status: 403, message: 'Cannot delete a super admin' };

  // Free everything the user was holding so the resources are reusable.
  await Promise.all([
    RazerAccount.deleteMany({ ownerId: user._id }),
    Proxy.deleteMany({ ownerId: user._id }),
  ]);
  await user.deleteOne();

  return { success: true };
}

/* ------------------------------------------------------------ packages ---- */

async function listPackages() {
  const packages = await Package.find({}).sort({ price: 1, createdAt: 1 }).lean();

  // Subscriber count per package, so a tier in use is obvious before deleting.
  return Promise.all(
    packages.map(async (p) => ({
      ...p,
      id: p._id,
      subscribers: await PortalUser.countDocuments({ packageId: p._id }),
    }))
  );
}

async function createPackage(data) {
  const existing = await Package.findOne({ name: data.name });
  if (existing) throw { status: 409, message: 'A package with that name already exists' };
  const pkg = await Package.create(data);
  return pkg.toObject();
}

async function updatePackage(id, data) {
  if (data.name) {
    const clash = await Package.findOne({ name: data.name, _id: { $ne: id } });
    if (clash) throw { status: 409, message: 'A package with that name already exists' };
  }
  const pkg = await Package.findByIdAndUpdate(id, { $set: data }, { new: true, runValidators: true });
  if (!pkg) throw { status: 404, message: 'Package not found' };
  return pkg.toObject();
}

async function deletePackage(id) {
  const subscribers = await PortalUser.countDocuments({ packageId: id });
  if (subscribers > 0) {
    throw {
      status: 409,
      message: `Cannot delete — ${subscribers} user(s) are on this package. Move them to another package first.`,
    };
  }
  const pkg = await Package.findByIdAndDelete(id);
  if (!pkg) throw { status: 404, message: 'Package not found' };
  return { success: true };
}

/* ------------------------------------------------------------ overview ---- */

async function getOverview() {
  const [totalUsers, activeUsers, suspendedUsers, totalPackages, goldAccounts, silverAccounts, totalProxies] =
    await Promise.all([
      PortalUser.countDocuments({ role: 'user' }),
      PortalUser.countDocuments({ role: 'user', status: 'active' }),
      PortalUser.countDocuments({ role: 'user', status: 'suspended' }),
      Package.countDocuments({}),
      RazerAccount.countDocuments({ type: 'gold', status: 'active' }),
      RazerAccount.countDocuments({ type: 'silver', status: 'active' }),
      Proxy.countDocuments({}),
    ]);

  return {
    users: { total: totalUsers, active: activeUsers, suspended: suspendedUsers },
    packages: totalPackages,
    accounts: { gold: goldAccounts, silver: silverAccounts },
    proxies: totalProxies,
  };
}

module.exports = {
  login,
  listUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  listPackages,
  createPackage,
  updatePackage,
  deletePackage,
  getOverview,
};
