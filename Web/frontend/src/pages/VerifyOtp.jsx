import { useState, useEffect, useRef } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import { AlertCircle, CheckCircle, Info } from 'lucide-react';
import { verifyOtp, forgotPassword } from '../services/api';
import './Auth.css';

function VerifyOtp() {
  const location = useLocation();
  const navigate = useNavigate();
  const email = location.state?.email;

  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(300); // 5 minutes
  const inputRefs = useRef([]);

  useEffect(() => {
    if (!email) {
      navigate('/forgot-password');
      return;
    }
    const timer = setInterval(() => {
      setSecondsLeft((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [email, navigate]);

  const handleChange = (index, value) => {
    if (!/^\d*$/.test(value)) return;
    const newOtp = [...otp];
    newOtp[index] = value.slice(-1);
    setOtp(newOtp);
    if (value && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (index, e) => {
    if (e.key === 'Backspace' && !otp[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handlePaste = (e) => {
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (pasted.length === 6) {
      const newOtp = pasted.split('');
      setOtp(newOtp);
      inputRefs.current[5]?.focus();
    }
    e.preventDefault();
  };

  const handleResend = async () => {
    setError('');
    setSuccess('');
    setInfo('');
    try {
      const res = await forgotPassword({ email });
      setSecondsLeft(300);
      if (res.data.otp) {
        setInfo(`OTP resent! (Dev mode) New OTP: ${res.data.otp}`);
      } else {
        setSuccess('OTP resent successfully');
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to resend OTP');
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    const otpValue = otp.join('');
    if (otpValue.length !== 6) {
      setError('Please enter the complete 6-digit OTP');
      return;
    }
    setLoading(true);
    try {
      const res = await verifyOtp({ email, otp: otpValue });
      setSuccess('OTP verified! Redirecting...');
      setTimeout(() => {
        navigate('/reset-password', { state: { email, resetToken: res.data.resetToken } });
      }, 1000);
    } catch (err) {
      setError(err.response?.data?.message || 'Invalid or expired OTP');
    } finally {
      setLoading(false);
    }
  };

  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;

  return (
    <div className="auth-bg">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="auth-shield">🔑</div>
          <h1>Verify OTP</h1>
          <p>Enter the 6-digit code sent to<br /><strong style={{ color: 'var(--accent-blue)' }}>{email}</strong></p>
        </div>

        {error && (
          <div className="auth-error">
            <AlertCircle size={14} />
            {error}
          </div>
        )}
        {success && (
          <div className="auth-success">
            <CheckCircle size={14} />
            {success}
          </div>
        )}
        {info && (
          <div className="auth-info">
            <Info size={14} />
            {info}
          </div>
        )}

        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="otp-inputs">
            {otp.map((digit, i) => (
              <input
                key={i}
                ref={(el) => (inputRefs.current[i] = el)}
                type="text"
                inputMode="numeric"
                maxLength={1}
                value={digit}
                placeholder="·"
                onChange={(e) => handleChange(i, e.target.value)}
                onKeyDown={(e) => handleKeyDown(i, e)}
                onPaste={i === 0 ? handlePaste : undefined}
                id={`otp-digit-${i}`}
              />
            ))}
          </div>

          <div className="otp-timer">
            {secondsLeft > 0 ? (
              <>
                Expires in&nbsp;
                <span className="otp-timer-countdown">
                  {minutes}:{seconds.toString().padStart(2, '0')}
                </span>
              </>
            ) : (
              <span className="otp-timer-expired">OTP expired</span>
            )}
          </div>

          <button
            className="auth-btn"
            id="otp-submit"
            type="submit"
            disabled={loading || secondsLeft === 0}
          >
            {loading && <span className="auth-btn-spinner" />}
            {loading ? 'Verifying...' : 'Verify OTP'}
          </button>
        </form>

        <div className="auth-links">
          {secondsLeft === 0 && (
            <>
              <a href="#" id="resend-otp" onClick={(e) => { e.preventDefault(); handleResend(); }}>
                Resend OTP
              </a>
              <br />
              <br />
            </>
          )}
          <Link to="/login" id="back-to-login-otp">← Back to Sign In</Link>
        </div>
      </div>
    </div>
  );
}

export default VerifyOtp;