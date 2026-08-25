const mongoose = require('mongoose');

const proxySchema = new mongoose.Schema(
  {
    id: { type: Number, required: true, unique: true, index: true },
    label: { type: String, required: true },
    country: { type: String, default: '' },
    ip: { type: String, required: true },
    port: { type: String, required: true },
    username: { type: String, default: '' },
    password: { type: String, default: '' },
    dedicated: { type: Boolean, default: false },
    // Portal user that added this proxy. null === system/shared proxy, which
    // every customer may use but only the super admin may edit.
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'PortalUser', default: null, index: true },
    disabled: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Proxy', proxySchema);
