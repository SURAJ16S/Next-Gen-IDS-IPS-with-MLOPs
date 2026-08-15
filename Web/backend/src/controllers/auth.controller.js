const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
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
    const { firstName, lastName, username, dob, mobile, email, password, role } = req.body;

    const userExists = await User.findOne({ $or: [{ email }, { username }] });
    if (userExists) {
      return res.status(400).json({ message: 'User with this email or username already exists' });
    }

    const user = await User.create({
      firstName,
      lastName,
      username,
      dob,
      mobile,
      email,
      password,
      role: role || 'viewer',
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

    const user = await User.findOne({ email });

    if (user && (await user.matchPassword(password))) {
      res.json({
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        username: user.username,
        email: user.email,
        role: user.role,
        token: generateToken(user._id),
      });
    } else {
      res.status(401).json({ message: 'Invalid email or password' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── Forgot Password (Send OTP) ───────────────────────────────────────────────

const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ email });
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

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
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
    const user = await User.findById(req.user._id).select('-password');
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { registerUser, loginUser, forgotPassword, verifyOtp, resetPassword, getMe };
