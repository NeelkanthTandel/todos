// Decides whether copied text is safe and sensible to suggest as a todo. Pure functions, no clipboard access.
// It errs on the side of skipping: a missed suggestion costs a ⌘V, a shown secret can leak on a shared screen.
// Token patterns are adapted from gitleaks (https://github.com/gitleaks/gitleaks, MIT).
(() => {
  const MAX_CHARS = 2000, MAX_LINES = 50;

  const SECRET_PATTERNS = [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/,                  // PEM / SSH / PGP private keys
    /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_\w{82})\b/,            // GitHub
    /\bglpat-[\w-]{20}\b/,                                            // GitLab
    /\bxox[abeoprs]-[\w-]{10,}|\bxapp-\d-[A-Z0-9-]+/i,                // Slack tokens
    /hooks\.slack\.com\/(?:services|workflows|triggers)\//,          // Slack webhooks
    /\b(?:sk|rk|pk)_(?:live|test|prod)_[A-Za-z0-9]{10,}/,             // Stripe
    /\bsk-(?:ant-|proj-|svcacct-|admin-)?[\w-]{20,}/,                 // Anthropic / OpenAI
    /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/,            // AWS access keys
    /\bAIza[\w-]{35}\b/,                                              // Google API keys
    /\bnpm_[A-Za-z0-9]{36}\b/,                                        // npm
    /\bSG\.[\w-]{16,}\.[\w-]{16,}/,                                   // SendGrid
    /\bSK[0-9a-fA-F]{32}\b/,                                          // Twilio
    /\bey[\w-]{10,}\.ey[\w-]{10,}\.[\w-]{10,}/,                       // JWT
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s/@]+@/i,                   // user:password@ in any URL (postgres, mongodb+srv, redis, amqp, https…)
    /\b(?:pass(?:word|wd|code)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth|signature|sig|credentials?)\s*["']?\s*[:=]\s*["']?(?:(?=[^\s"']*\d)[^\s"']{6,}|[^\s"']{16,})/i, // KEY=value, ?token=…
  ];

  // Shannon entropy in bits per character: random keys score high (~4+), words and sentences lower.
  function entropy(s) {
    const counts = new Map();
    for (const c of s) counts.set(c, (counts.get(c) || 0) + 1);
    let e = 0;
    for (const n of counts.values()) { const p = n / s.length; e -= p * Math.log2(p); }
    return e;
  }
  function luhn(digits) {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = +digits[digits.length - 1 - i];
      if (i % 2) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
    }
    return sum % 10 === 0;
  }
  const isUrl = s => /^https?:\/\/[^\s]+$/i.test(s);

  // Returns { ok: true } or { ok: false, reason } (the reason is for tests and debugging, never shown).
  function check(raw) {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) return { ok: false, reason: "empty" };
    if (text.length > MAX_CHARS || text.split("\n").length > MAX_LINES) return { ok: false, reason: "too long" };
    for (const re of SECRET_PATTERNS) if (re.test(text)) return { ok: false, reason: "secret pattern" };

    const compact = text.replace(/[\s-]/g, "");
    if (/^\d{13,19}$/.test(compact) && luhn(compact)) return { ok: false, reason: "card number" };

    // One token, no spaces: only plain words and links. Anything mixing digits or symbols reads as a password,
    // code, id or hash.
    if (!/\s/.test(text)) {
      if (isUrl(text) || /^[\p{L}][\p{L}'’-]{0,39}$/u.test(text)) return { ok: true };
      return { ok: false, reason: "single token" };
    }
    // Inside longer text: a long random-looking token (letters and digits mixed) is probably a key.
    for (const tok of text.split(/\s+/)) {
      if (tok.length >= 20 && !isUrl(tok) && /[a-z]/i.test(tok) && /\d/.test(tok) && entropy(tok) >= 3.5) {
        return { ok: false, reason: "random token" };
      }
    }
    return { ok: true };
  }

  window.TodoClipboard = { check };
})();
