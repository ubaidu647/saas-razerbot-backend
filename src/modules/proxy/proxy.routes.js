const express = require('express');
const router = express.Router();
const { portalAuth, requireRole } = require('../../middleware/portalAuth');
const proxyController = require('./proxy.controller');

router.use(portalAuth);

router.get('/', proxyController.listProxies);
router.post('/', proxyController.createProxy);
router.patch('/:id', proxyController.updateProxy);
router.delete('/:id', proxyController.deleteProxy);

// Refreshing the shared rotation pool is a global side effect — admin only.
router.post('/reload', requireRole('superadmin'), proxyController.reload);

module.exports = router;
