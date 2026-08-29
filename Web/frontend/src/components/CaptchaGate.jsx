// Web/frontend/src/components/CaptchaGate.jsx
//
// Renders a Cloudflare Turnstile widget when the backend responds with
// { captcha_required: true, sitekey } (see captcha.middleware.js). Drop
// this into Login.jsx / Register.jsx wherever you currently handle a
// failed submit — on captcha_required, render <CaptchaGate> instead of
// the normal error message, then retry the original request with the
// token attached once the user completes it.
//
// Add to index.html (or load dynamically) once:
//   <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>

import { useEffect, useRef } from 'react';

export default function CaptchaGate({ sitekey, onToken, onExpire }) {
  const containerRef = useRef(null);
  const widgetIdRef = useRef(null);

  useEffect(() => {
    if (!window.turnstile || !containerRef.current) return undefined;

    widgetIdRef.current = window.turnstile.render(containerRef.current, {
      sitekey,
      callback: (token) => onToken(token),
      'expired-callback': () => onExpire?.(),
    });

    return () => {
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
      }
    };
  }, [sitekey, onToken, onExpire]);

  return (
    <div className="captcha-gate">
      <p className="captcha-gate__message">
        We noticed unusually fast activity from your connection. Please
        confirm you&apos;re not a bot to continue.
      </p>
      <div ref={containerRef} />
    </div>
  );
}

/*
Example usage inside Login.jsx's submit handler:

  const [captchaSitekey, setCaptchaSitekey] = useState(null);
  const [captchaToken, setCaptchaToken] = useState(null);

  const submitLogin = async (payload) => {
    try {
      const res = await api.post('/auth/login', { ...payload, captchaToken });
      // success path...
    } catch (err) {
      if (err.response?.status === 403 && err.response.data?.captcha_required) {
        setCaptchaSitekey(err.response.data.sitekey);
        return; // wait for the user to complete the widget, then re-submit
      }
      // normal error handling...
    }
  };

  {captchaSitekey && (
    <CaptchaGate
      sitekey={captchaSitekey}
      onToken={(token) => { setCaptchaToken(token); submitLogin(lastPayload); }}
    />
  )}
*/
