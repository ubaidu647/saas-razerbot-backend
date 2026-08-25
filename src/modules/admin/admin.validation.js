const Joi = require('joi');

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(),
});

const createUserSchema = Joi.object({
  name: Joi.string().allow('').max(100).default(''),
  email: Joi.string().email().required(),
  password: Joi.string().min(8).required(),
  packageId: Joi.string().hex().length(24).allow(null).default(null),
  packageExpiresAt: Joi.date().allow(null).default(null),
  status: Joi.string().valid('active', 'suspended').default('active'),
});

const updateUserSchema = Joi.object({
  name: Joi.string().allow('').max(100),
  email: Joi.string().email(),
  password: Joi.string().min(8),
  packageId: Joi.string().hex().length(24).allow(null),
  packageExpiresAt: Joi.date().allow(null),
  status: Joi.string().valid('active', 'suspended'),
}).min(1);

// `null` is accepted on every cap and means unlimited.
const packageBody = {
  name: Joi.string().min(2).max(60),
  description: Joi.string().allow('').max(500),
  maxGoldAccounts: Joi.number().integer().min(0).allow(null),
  maxSilverAccounts: Joi.number().integer().min(0).allow(null),
  maxProxies: Joi.number().integer().min(0).allow(null),
  price: Joi.number().min(0),
  currency: Joi.string().max(8),
  active: Joi.boolean(),
};

const createPackageSchema = Joi.object({
  ...packageBody,
  name: packageBody.name.required(),
  maxGoldAccounts: packageBody.maxGoldAccounts.default(1),
  maxSilverAccounts: packageBody.maxSilverAccounts.default(1),
  maxProxies: packageBody.maxProxies.default(1),
});

const updatePackageSchema = Joi.object(packageBody).min(1);

module.exports = {
  loginSchema,
  createUserSchema,
  updateUserSchema,
  createPackageSchema,
  updatePackageSchema,
};
