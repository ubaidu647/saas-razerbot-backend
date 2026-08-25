const express = require('express');
const router = express.Router();
const Joi = require('joi');
const controller = require('./portal.controller');
const validate = require('../../middleware/validate');
const { portalAuth } = require('../../middleware/portalAuth');

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(),
});

const changePasswordSchema = Joi.object({
  currentPassword: Joi.string().required(),
  newPassword: Joi.string().min(8).required(),
});

router.post('/login', validate(loginSchema), controller.login);
router.post('/refresh', controller.refresh);

router.use(portalAuth);

router.get('/me', controller.me);
router.get('/usage', controller.usage);
router.post('/logout', controller.logout);
router.post('/change-password', validate(changePasswordSchema), controller.changePassword);

router.get('/accounts', controller.listAccounts);
router.delete('/accounts/:id', controller.releaseAccount);

module.exports = router;
