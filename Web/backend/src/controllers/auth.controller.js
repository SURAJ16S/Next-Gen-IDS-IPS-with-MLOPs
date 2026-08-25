const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Admin = require('../models/Admin');
const Otp = require('../models/Otp');
const sendEmail = require('../utils/sendEmail');

// ─── Helpers ────────────────────────────────────────────────────────────────

const generateToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '30d' });

const generateResetToken = (email) =>
  jwt.sign({ email }, process.env.JWT_RESET_SECRET, { expiresIn: '15m' });

const generateOtp = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

// ─── Register ────────────────────────────────────────────────────────────────

const registerUser = async (req, res) => {
  try {
    const { firstName, lastName, username, dob, mobile, email, password, role, githubRegToken, githubUsername } = req.body;

    const userExistsInUsers = await User.findOne({ $or: [{ email }, { username }] });
    const userExistsInAdmins = await Admin.findOne({ $or: [{ email }, { username }] });
    if (userExistsInUsers || userExistsInAdmins) {
      return res.status(400).json({ message: 'User or Admin with this email or username already exists' });
    }

    let extraFields = {};
    if (githubRegToken) {
      try {
        const decoded = jwt.verify(githubRegToken, process.env.JWT_SECRET);
        if (decoded.email === email && decoded.githubUsername === githubUsername) {
          extraFields.githubUsername = githubUsername;
          extraFields.githubAccessToken = decoded.githubAccessToken;
        } else {
          return res.status(400).json({ message: 'GitHub verification token mismatch.' });
        }
      } catch (err) {
        return res.status(400).json({ message: 'Invalid or expired GitHub registration token.' });
      }
    }

    const Model = (role === 'admin' || role === 'superadmin') ? Admin : User;
    const user = await Model.create({
      firstName,
      lastName,
      username,
      dob,
      mobile,
      email,
      password,
      role: role || 'user',
      ...extraFields
    });

    res.status(201).json({
      _id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      username: user.username,
      email: user.email,
      role: user.role,
      token: generateToken(user._id),
    });
  } catch (error) {
    console.error('REGISTER ERROR:', error);
    res.status(500).json({ message: error.message });
  }
};

// ─── Login ───────────────────────────────────────────────────────────────────

const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    let user = await User.findOne({ email });
    if (!user) {
      user = await Admin.findOne({ email });
    }

    if (user) {
      if (user.status === 'banned') {
        return res.status(403).json({ message: 'Your account has been banned. Please contact the administrator.' });
      }
      if (await user.matchPassword(password)) {
        return res.json({
          _id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          username: user.username,
          email: user.email,
          role: user.role,
          token: generateToken(user._id),
        });
      }
    }
    res.status(401).json({ message: 'Invalid email or password' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── Forgot Password (Send OTP) ───────────────────────────────────────────────

const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    let user = await User.findOne({ email });
    if (!user) {
      user = await Admin.findOne({ email });
    }
    if (!user) {
      // Return success anyway to avoid user enumeration
      return res.json({ message: 'If that email is registered, an OTP has been sent.' });
    }

    // Delete any existing OTPs for this email
    await Otp.deleteMany({ email });

    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    await Otp.create({ email, otp, expiresAt });


    console.log('KEY CHECK:', process.env.BREVO_API_KEY);

    await sendEmail({
      to: email,
      subject: 'Your OTP for password reset',
      htmlContent: `<p>Your OTP is <b>${otp}</b>. It expires in 5 minutes.</p>`,
    });
    // Return OTP in response body (dev mode only — remove in production)
    res.json({
      message: 'OTP generated successfully.',
    });
  } catch (error) {
    console.error('FORGOT PASSWORD ERROR:', error);
    res.status(500).json({ message: error.message });
  }
};

// ─── Verify OTP ───────────────────────────────────────────────────────────────

const verifyOtp = async (req, res) => {
  try {
    const { email, otp } = req.body;

    const record = await Otp.findOne({ email, otp });

    if (!record) {
      return res.status(400).json({ message: 'Invalid OTP' });
    }

    if (record.expiresAt < new Date()) {
      await Otp.deleteOne({ _id: record._id });
      return res.status(400).json({ message: 'OTP has expired. Please request a new one.' });
    }

    // Mark as verified
    record.verified = true;
    await record.save();

    const resetToken = generateResetToken(email);

    res.json({ message: 'OTP verified successfully.', resetToken });
  } catch (error) {
    console.error('VERIFY OTP ERROR:', error);
    res.status(500).json({ message: error.message });
  }
};

// ─── Reset Password ───────────────────────────────────────────────────────────

const resetPassword = async (req, res) => {
  try {
    const { email, resetToken, newPassword } = req.body;

    // Verify reset token
    let decoded;
    try {
      decoded = jwt.verify(resetToken, process.env.JWT_RESET_SECRET);
    } catch (err) {
      return res.status(400).json({ message: 'Invalid or expired reset token. Please restart the process.' });
    }

    if (decoded.email !== email) {
      return res.status(400).json({ message: 'Token email mismatch.' });
    }

    // Ensure OTP was verified
    const otpRecord = await Otp.findOne({ email, verified: true });
    if (!otpRecord) {
      return res.status(400).json({ message: 'OTP not verified for this email.' });
    }

    let user = await User.findOne({ email });
    if (!user) {
      user = await Admin.findOne({ email });
    }
    if (!user) {
      return res.status(404).json({ message: 'User or Admin not found.' });
    }

    user.password = newPassword;
    await user.save(); // triggers bcrypt pre-save hook

    // Cleanup OTP record
    await Otp.deleteMany({ email });

    res.json({ message: 'Password reset successfully. You can now log in.' });
  } catch (error) {
    console.error('RESET PASSWORD ERROR:', error);
    res.status(500).json({ message: error.message });
  }
};

// ─── Get Me (profile) ─────────────────────────────────────────────────────────

const getMe = async (req, res) => {
  try {
    const Model = (req.user.role === 'admin' || req.user.role === 'superadmin') ? Admin : User;
    const user = await Model.findById(req.user._id).select('-password');
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const githubLoginRedirect = (req, res) => {
  const { GITHUB_CLIENT_ID, GITHUB_CALLBACK_URL } = process.env;
  const state = jwt.sign({ action: 'login', from: req.query.from || 'user' }, process.env.JWT_SECRET, { expiresIn: '15m' });
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: GITHUB_CALLBACK_URL,
    scope: 'repo read:user user:email',
    allow_signup: 'true',
    state,
    // Force GitHub account picker so user can switch between accounts
    prompt: 'select_account',
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
};

const githubLoginCallback = async (req, res) => {
  const axios = require('axios');
  const crypto = require('crypto');
  const { code, state } = req.query;
  const { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, FRONTEND_URL, GITHUB_CALLBACK_URL } = process.env;
  const authCallbackUrl = GITHUB_CALLBACK_URL;

  // Resolve redirect prefix based on state payload context
  let redirectPrefix = '/login';
  if (state) {
    try {
      const decodedState = jwt.verify(state, process.env.JWT_SECRET);
      if (decodedState.from === 'admin') {
        redirectPrefix = '/admin/login';
      }
    } catch (_) {}
  }

  if (!code) {
    return res.redirect(`${FRONTEND_URL}${redirectPrefix}?error=no_code`);
  }

  try {
    const tokenRes = await axios.post(
      'https://github.com/login/oauth/access_token',
      {
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: authCallbackUrl,
      },
      { headers: { Accept: 'application/json' } }
    );

    const { access_token, error } = tokenRes.data;
    if (error || !access_token) {
      return res.redirect(`${FRONTEND_URL}${redirectPrefix}?error=token_failed`);
    }

    const userRes = await axios.get('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${access_token}`, 'User-Agent': 'IDPS-Auth' },
    });
    const ghUser = userRes.data;

    let email = ghUser.email;
    if (!email) {
      try {
        const emailsRes = await axios.get('https://api.github.com/user/emails', {
          headers: { Authorization: `Bearer ${access_token}`, 'User-Agent': 'IDPS-Auth' },
        });
        const primaryEmail = emailsRes.data.find(e => e.primary && e.verified);
        if (primaryEmail) email = primaryEmail.email;
      } catch (_) {}
    }
    if (!email) email = `${ghUser.login}@github.com`;

    // 1. First, search if a user is already linked with this GitHub username
    let user = await User.findOne({ githubUsername: ghUser.login });
    if (!user) {
      user = await Admin.findOne({ githubUsername: ghUser.login });
    }

    if (!user) {
      // 2. If not linked by githubUsername, search by email
      user = await User.findOne({ email });
      if (!user) {
        user = await Admin.findOne({ email });
      }

      if (user) {
        // 3. User exists by email but isn't linked to this GitHub account yet.
        // Generate a secure, short-lived JWT token containing linking details.
        const linkToken = jwt.sign(
          {
            email,
            githubUsername: ghUser.login,
            githubAccessToken: access_token,
          },
          process.env.JWT_SECRET,
          { expiresIn: '15m' }
        );

        return res.redirect(
          `${FRONTEND_URL}${redirectPrefix}?action=link_github&email=${encodeURIComponent(email)}&githubUsername=${encodeURIComponent(ghUser.login)}&linkToken=${linkToken}`
        );
      } else {
        // 4. No account exists. Register as a new user.
        const nameParts = (ghUser.name || ghUser.login).split(' ');
        const firstName = nameParts[0] || ghUser.login;
        const lastName = nameParts.slice(1).join(' ') || ' ';
        
        user = await User.create({
          firstName,
          lastName,
          username: ghUser.login + Math.floor(100 + Math.random() * 900),
          email,
          dob: new Date('2000-01-01'),
          mobile: '0000000000',
          password: crypto.randomBytes(16).toString('hex'),
          role: 'user',
          githubAccessToken: access_token,
          githubUsername: ghUser.login,
        });
      }
    } else {
      // User is already linked. Update the access token.
      user.githubAccessToken = access_token;
      await user.save();
    }

    if (user.status === 'banned') {
      return res.redirect(`${FRONTEND_URL}${redirectPrefix}?error=banned`);
    }

    const token = generateToken(user._id);
    const userJSON = encodeURIComponent(JSON.stringify({
      _id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      username: user.username,
      email: user.email,
      role: user.role,
    }));

    res.redirect(`${FRONTEND_URL}${redirectPrefix}?token=${token}&user=${userJSON}`);
  } catch (err) {
    console.error('GitHub OAuth error:', err.message);
    res.redirect(`${FRONTEND_URL}${redirectPrefix}?error=server_error`);
  }
};

// ─── Link GitHub Account ──────────────────────────────────────────────────────

const linkGithubAccount = async (req, res) => {
  try {
    const { email, password, linkToken } = req.body;

    if (!email || !password || !linkToken) {
      return res.status(400).json({ message: 'Email, password, and linkToken are required.' });
    }

    // Verify linkToken
    let decoded;
    try {
      decoded = jwt.verify(linkToken, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(400).json({ message: 'Invalid or expired link token. Please restart the process.' });
    }

    if (decoded.email !== email) {
      return res.status(400).json({ message: 'Token email mismatch.' });
    }

    // Find the user or admin
    let user = await User.findOne({ email });
    if (!user) {
      user = await Admin.findOne({ email });
    }
    if (!user) {
      return res.status(404).json({ message: 'User or Admin not found.' });
    }

    if (user.status === 'banned') {
      return res.status(403).json({ message: 'Your account has been banned. Please contact the administrator.' });
    }

    // Verify password
    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid password.' });
    }

    // Update GitHub fields
    user.githubUsername = decoded.githubUsername;
    user.githubAccessToken = decoded.githubAccessToken;
    await user.save();

    res.json({
      _id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      username: user.username,
      email: user.email,
      role: user.role,
      token: generateToken(user._id),
    });
  } catch (error) {
    console.error('LINK GITHUB ERROR:', error);
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  registerUser,
  loginUser,
  forgotPassword,
  verifyOtp,
  resetPassword,
  getMe,
  githubLoginRedirect,
  githubLoginCallback,
  linkGithubAccount,
};
