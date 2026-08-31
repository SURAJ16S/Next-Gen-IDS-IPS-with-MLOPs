import { useState } from 'react';
import { RefreshCw, ArrowRight } from 'lucide-react';

export default function CaptchaGate({ challenge, onToken, onRefresh, loading, status }) {
  const [answer, setAnswer] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!answer.trim()) return;
    onToken({
      challenge_id: challenge.challenge_id,
      answer: answer.trim()
    });
  };

  if (!challenge || !challenge.image_svg) return null;

  return (
    <div className="captcha-gate" style={{
      background: 'rgba(15, 23, 42, 0.4)',
      border: '1px solid rgba(56, 189, 248, 0.2)',
      borderRadius: 'var(--radius-md)',
      padding: '16px',
      marginBottom: '16px'
    }}>
      <style>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          10%, 30%, 50%, 70%, 90% { transform: translateX(-5px); }
          20%, 40%, 60%, 80% { transform: translateX(5px); }
        }
        .shake-anim {
          animation: shake 0.4s ease-in-out;
          border-color: var(--danger-red) !important;
        }
      `}</style>
      
      <p className="captcha-gate__message" style={{ 
        fontSize: '13px', 
        color: status === 'error' ? 'var(--danger-red)' : status === 'success' ? 'var(--success-green)' : 'var(--text-muted)', 
        marginBottom: '12px' 
      }}>
        {status === 'error' ? '❌ Incorrect characters. Please try again.' : 
         status === 'success' ? '✅ Success! Access Granted.' : 
         'We noticed unusually fast activity from your connection. Please type the characters you see below to continue.'}
      </p>
      
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <div 
          style={{ background: '#ffffff', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.1)', flex: 1, display: 'flex', justifyContent: 'center' }}
          dangerouslySetInnerHTML={{ __html: challenge.image_svg }}
        />
        <button 
          type="button" 
          onClick={onRefresh} 
          disabled={loading || status === 'success'}
          style={{ 
            background: 'rgba(255,255,255,0.05)', 
            border: '1px solid rgba(255,255,255,0.1)', 
            borderRadius: 'var(--radius-sm)', 
            padding: '8px', 
            cursor: 'pointer',
            color: 'var(--text-muted)'
          }}
          title="Refresh Image"
        >
          <RefreshCw size={18} />
        </button>
      </div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', gap: '8px' }}>
        <input 
          type="text" 
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="Enter characters..."
          disabled={loading || status === 'success'}
          className={status === 'error' ? 'shake-anim' : ''}
          style={{ 
            flex: 1, 
            background: 'rgba(2, 6, 23, 0.5)', 
            border: '1px solid rgba(56, 189, 248, 0.3)', 
            borderRadius: 'var(--radius-sm)', 
            padding: '10px 12px',
            color: 'var(--text-main)',
            outline: 'none',
            transition: 'border-color 0.2s'
          }}
          autoFocus
        />
        <button 
          type="submit" 
          disabled={loading || !answer.trim() || status === 'success'}
          style={{ 
            background: 'var(--primary-cyan)', 
            color: '#000', 
            border: 'none', 
            borderRadius: 'var(--radius-sm)', 
            padding: '0 16px', 
            cursor: 'pointer',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: '6px'
          }}
        >
          Verify <ArrowRight size={16} />
        </button>
      </form>
    </div>
  );
}
