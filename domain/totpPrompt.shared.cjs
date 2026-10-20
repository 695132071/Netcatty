"use strict";

// SMS, email, RADIUS, menus, and confirmations must never be treated as a
// TOTP code prompt, even when earlier lines mention OTP.
// Assigned on `exports` so the renderer can import the name through Vite.
const NON_TOTP_PROMPT = /SMS|EMAIL|RADIUS|PASSKEY|MFA_CUSTOM|短信|邮件|郵件|Option>|\[Y\/n\]/i;
exports.NON_TOTP_PROMPT = NON_TOTP_PROMPT;
