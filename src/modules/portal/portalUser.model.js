const mongoose = require('mongoose');

/**
 * A SaaS portal account.
 *
 * This is deliberately separate from `RegisteredUser` (which stores the Razer
 * accounts a customer drives). A PortalUser is who logs into *our* product:
 * either the super admin, or a customer the super admin created.
 */
const portalUserSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, default: '' },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },

    role: { type: String, enum: ['superadmin', 'user'], default: 'user', index: true },
    status: { type: String, enum: ['active', 'suspended'], default: 'active', index: true },

    // Customers get a package; the super admin does not need one.
    packageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Package', default: null },
    packageAssignedAt: { type: Date, default: null },
    packageExpiresAt: { type: Date, default: null },

    refreshToken: { type: String, default: null },
    lastLoginAt: { type: Date, default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'PortalUser', default: null },
  },
  { timestamps: true }
);

portalUserSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id,
    name: this.name,
    email: this.email,
    role: this.role,
    status: this.status,
    packageId: this.packageId,
    packageAssignedAt: this.packageAssignedAt,
    packageExpiresAt: this.packageExpiresAt,
    lastLoginAt: this.lastLoginAt,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model('PortalUser', portalUserSchema);
