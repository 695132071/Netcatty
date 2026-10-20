// SMS, email, RADIUS, menus, and confirmations must never be treated as a
// TOTP code prompt, even when earlier lines mention OTP.
// Keep this pattern identical to domain/totpPrompt.shared.cjs.
export const NON_TOTP_PROMPT = /SMS|EMAIL|RADIUS|PASSKEY|MFA_CUSTOM|短信|邮件|郵件|Option>|\[Y\/n\]/i;
