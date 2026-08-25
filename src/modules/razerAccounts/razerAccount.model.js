const mongoose = require('mongoose');

/**
 * Registry of the Razer accounts a portal user has loaded.
 *
 * This is what package limits are counted against: `maxGoldAccounts` and
 * `maxSilverAccounts` cap how many distinct accounts of each type an owner may
 * hold at once. Releasing an account frees a slot.
 */
const razerAccountSchema = new mongoose.Schema(
  {
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'PortalUser', required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    type: { type: String, enum: ['gold', 'silver'], required: true, index: true },

    status: { type: String, enum: ['active', 'released', 'failed'], default: 'active', index: true },
    lastLoadedAt: { type: Date, default: Date.now },
    lastError: { type: String, default: '' },
  },
  { timestamps: true }
);

// One slot per (owner, account, type) — reloading the same account is not a new slot.
razerAccountSchema.index({ ownerId: 1, email: 1, type: 1 }, { unique: true });

module.exports = mongoose.model('RazerAccount', razerAccountSchema);
