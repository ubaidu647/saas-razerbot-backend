const express = require('express');
const router = express.Router();
const controller = require('./auth.controller');
const validate = require('../../middleware/validate');
const { registerSchema, loginSchema } = require('./user.validation');
const auth = require('../../middleware/auth');
const { portalAuth, requireRole } = require('../../middleware/portalAuth');

// Self-service registration is closed: only the super admin provisions
// accounts now. Customer portal accounts are created via POST /api/admin/users.
router.post('/register', portalAuth, requireRole('superadmin'), validate(registerSchema), controller.register);
// Attaches a Razer account to the signed-in portal user (SSE stream).
router.post('/login', portalAuth, controller.login);
router.get('/homepage', controller.homepage);

// Razer OAuth endpoints
router.get('/razer', controller.redirectToRazer);
router.get('/razer/callback', controller.razerCallback);

router.post('/refresh', controller.refresh);
router.post('/logout', auth, controller.logout);
router.get('/me', auth, controller.me);
router.get('/proxies', controller.getProxies);
router.patch('/proxy', auth, controller.setProxy);

module.exports = router;
