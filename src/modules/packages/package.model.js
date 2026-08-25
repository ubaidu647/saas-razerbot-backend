const mongoose = require('mongoose');

/**
 * A subscription package (tier) defined by the super admin.
 * Every limit is a hard cap; `null` means "unlimited" for that dimension.
 */
const packageSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: '' },

    // Hard caps enforced across the app. null === unlimited.
    maxGoldAccounts: { type: Number, default: 1, min: 0 },
    maxSilverAccounts: { type: Number, default: 1, min: 0 },
    maxProxies: { type: Number, default: 1, min: 0 },

    price: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'USD' },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Package', packageSchema);
