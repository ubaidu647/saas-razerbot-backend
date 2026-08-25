const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    first_name: { type: String, default: '' },
    last_name: { type: String, default: '' },
    email: { type: String, required: true, unique: true },
    password: { type: String },
    userPassword: { type: String },
    email_verified: { type: String },
    refresh_token_razer: { type: String },
    accessToken_razer: { type: String },
    refreshToken: { type: String },
    open_id: { type: String },
    provider: { type: String, enum: ['local', 'razer'], default: 'local' },
    proxyId: { type: Number, default: null },
    // Portal user this Razer account belongs to. Null for pre-SaaS records.
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'PortalUser', default: null, index: true },
  },
  { timestamps: true }
);

const registeredUserSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    first_name: { type: String, default: '' },
    last_name: { type: String, default: '' },
    email: { type: String, required: true, unique: true },
    password: { type: String },
    status: { type: String, default: 'active' },
    refresh_token_razer: { type: String },
    accessToken_razer: { type: String },
    refreshToken: { type: String },
    open_id: { type: String },
    provider: { type: String, enum: ['local', 'razer'], default: 'local' },
    proxyId: { type: Number, default: null },
    // Portal user this Razer account belongs to. Null for pre-SaaS records.
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'PortalUser', default: null, index: true },
  },
  { timestamps: true }
);

const User = mongoose.model('User', userSchema);
const RegisteredUser = mongoose.model('RegisteredUser', registeredUserSchema);

// NOTE: this file previously did `module.exports = model('User')` followed by
// `module.exports = model('RegisteredUser')`, so every `require` of it — under
// either name — resolved to RegisteredUser. Existing data therefore lives in
// the `registeredusers` collection, and `RegisteredUser` stays the default
// export so those call sites keep hitting the same collection.
module.exports = RegisteredUser;
module.exports.User = User;
module.exports.RegisteredUser = RegisteredUser;
