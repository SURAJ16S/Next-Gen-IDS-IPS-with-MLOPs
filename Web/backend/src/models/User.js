const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const GH_ENC_KEY = process.env.JWT_SECRET
  ? crypto.createHash('sha256').update(process.env.JWT_SECRET).digest('hex').slice(0, 32)
  : '0'.repeat(32);

const encryptToken = (text) => {
  if (!text) return text;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(GH_ENC_KEY), iv);
  let enc = cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
  return iv.toString('hex') + ':' + enc;
};

const decryptToken = (text) => {
  if (!text || !text.includes(':')) return text;
  try {
    const [ivHex, encHex] = text.split(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(GH_ENC_KEY), Buffer.from(ivHex, 'hex'));
    return decipher.update(encHex, 'hex', 'utf8') + decipher.final('utf8');
  } catch (_) { return null; }
};

const userSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    username: { type: String, required: true, unique: true },
    dob: { type: Date, required: true },
    mobile: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, enum: ['superadmin', 'admin', 'analyst', 'viewer'], default: 'viewer' },
    // GitHub OAuth
    githubAccessToken: { type: String, set: encryptToken, get: decryptToken },
    githubUsername:    { type: String },
  },
  { timestamps: true, toJSON: { getters: true }, toObject: { getters: true } }
);

userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);