const express = require('express');
const router = express.Router();
const controller = require('./admin.controller');
const validate = require('../../middleware/validate');
const { portalAuth, requireRole } = require('../../middleware/portalAuth');
const {
  loginSchema,
  createUserSchema,
  updateUserSchema,
  createPackageSchema,
  updatePackageSchema,
} = require('./admin.validation');

// Public: super admin sign-in.
router.post('/login', validate(loginSchema), controller.login);

// Everything below is super-admin only.
router.use(portalAuth, requireRole('superadmin'));

router.get('/me', controller.me);
router.get('/overview', controller.overview);

router.get('/users', controller.listUsers);
router.post('/users', validate(createUserSchema), controller.createUser);
router.get('/users/:id', controller.getUser);
router.patch('/users/:id', validate(updateUserSchema), controller.updateUser);
router.delete('/users/:id', controller.deleteUser);

router.get('/packages', controller.listPackages);
router.post('/packages', validate(createPackageSchema), controller.createPackage);
router.patch('/packages/:id', validate(updatePackageSchema), controller.updatePackage);
router.delete('/packages/:id', controller.deletePackage);

module.exports = router;
