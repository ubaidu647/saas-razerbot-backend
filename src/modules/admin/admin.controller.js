const adminService = require('./admin.service');

const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (err) {
    next(err);
  }
};

const login = handle(async (req, res) => {
  res.json(await adminService.login(req.body));
});

const me = handle(async (req, res) => {
  res.json({ user: req.portalUser.toSafeJSON() });
});

const overview = handle(async (req, res) => {
  res.json({ success: true, overview: await adminService.getOverview() });
});

const listUsers = handle(async (req, res) => {
  const { search, status, packageId } = req.query;
  const page = Number(req.query.page) || 1;
  const limit = Math.min(Number(req.query.limit) || 25, 100);
  res.json({ success: true, ...(await adminService.listUsers({ search, status, packageId, page, limit })) });
});

const getUser = handle(async (req, res) => {
  res.json({ success: true, user: await adminService.getUser(req.params.id) });
});

const createUser = handle(async (req, res) => {
  res.status(201).json({ success: true, user: await adminService.createUser(req.body, req.portalUserId) });
});

const updateUser = handle(async (req, res) => {
  res.json({ success: true, user: await adminService.updateUser(req.params.id, req.body) });
});

const deleteUser = handle(async (req, res) => {
  res.json(await adminService.deleteUser(req.params.id));
});

const listPackages = handle(async (req, res) => {
  res.json({ success: true, packages: await adminService.listPackages() });
});

const createPackage = handle(async (req, res) => {
  res.status(201).json({ success: true, package: await adminService.createPackage(req.body) });
});

const updatePackage = handle(async (req, res) => {
  res.json({ success: true, package: await adminService.updatePackage(req.params.id, req.body) });
});

const deletePackage = handle(async (req, res) => {
  res.json(await adminService.deletePackage(req.params.id));
});

module.exports = {
  login,
  me,
  overview,
  listUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  listPackages,
  createPackage,
  updatePackage,
  deletePackage,
};
