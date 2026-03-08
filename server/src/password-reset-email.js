import { escapeHtml, getEmailDeliveryConfig, sendTransactionalEmail } from './email-service.js';

function formatResetExpiry(expiresAt) {
  return new Date(expiresAt).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short'
  });
}

function buildPasswordResetEmail({ resetUrl, expiresAt, productName, recipientName, kind, providerLabel }) {
  const safeResetUrl = escapeHtml(resetUrl);
  const expiryLabel = escapeHtml(formatResetExpiry(expiresAt));
  const safeProductName = escapeHtml(productName);
  const safeRecipientName = escapeHtml(recipientName);
  const greeting = safeRecipientName ? `Hi ${safeRecipientName},` : 'Hi,';
  const safeProviderLabel = escapeHtml(providerLabel);
  const isSetup = kind === 'setup';
  const subject = isSetup ? `Set your ${productName} password` : `Reset your ${productName} password`;
  const preheader = isSetup
    ? `Add a password to your ${safeProductName} account.`
    : `Reset your ${safeProductName} password.`;
  const lead = isSetup
    ? `You signed in with ${safeProviderLabel} on ${safeProductName}. Use the button below to add a password to this account.`
    : `We received a request to reset your password for ${safeProductName}. Use the button below to choose a new one.`;
  const actionLabel = isSetup ? 'Set password' : 'Reset password';
  const expiryText = isSetup ? 'This setup link expires' : 'This reset link expires';
  const plainTextLead = isSetup
    ? `You signed in with ${providerLabel} on ${productName}.`
    : 'We received a request to reset your password.';
  const plainTextAction = isSetup ? 'Add a password to this account' : 'Choose a new password';

  return {
    subject,
    text: [
      subject,
      '',
      `${recipientName ? `Hi ${recipientName},` : 'Hi,'}`,
      '',
      plainTextLead,
      `${plainTextAction}: ${resetUrl}`,
      `${expiryText} ${formatResetExpiry(expiresAt)}.`,
      'If you did not request this, you can safely ignore this email.'
    ].join('\n'),
    html: `
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
        ${preheader}
      </div>
      <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #1e2933; max-width: 560px; margin: 0 auto; padding: 24px;">
        <p style="margin: 0 0 10px; font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; color: #5b6b79;">Password reset</p>
        <h1 style="margin: 0 0 14px; font-size: 28px; line-height: 1.2; color: #0f1720;">${actionLabel} for your account</h1>
        <p style="margin: 0 0 12px;">${greeting}</p>
        <p style="margin: 0 0 20px;">${lead}</p>
        <p style="margin: 0 0 20px;">
          <a href="${safeResetUrl}" style="display: inline-block; padding: 12px 18px; border-radius: 999px; background: #31baa0; color: #08121a; text-decoration: none; font-weight: 700;">
            ${actionLabel}
          </a>
        </p>
        <p style="margin: 0 0 8px; color: #5b6b79;">${expiryText} ${expiryLabel}.</p>
        <p style="margin: 0 0 10px; color: #5b6b79;">If the button does not work, open this link:</p>
        <p style="margin: 0 0 18px; word-break: break-all;">
          <a href="${safeResetUrl}" style="color: #0b66c3; text-decoration: underline;">${safeResetUrl}</a>
        </p>
        <p style="margin: 0; color: #5b6b79; font-size: 14px;">If you did not request this, you can safely ignore this email.</p>
      </div>
    `
  };
}

function passwordResetDeliveryMessage(status, email) {
  switch (status) {
    case 'disabled':
      return 'Password reset email delivery is disabled.';
    case 'unsupported-provider':
      return 'Password reset email delivery provider is not supported.';
    case 'misconfigured':
      return 'Password reset email delivery is enabled but not fully configured.';
    case 'sent':
      return `Password reset email sent to ${email}.`;
    default:
      return 'Password reset email delivery is unavailable.';
  }
}

export async function sendPasswordResetEmail({
  resetId,
  resetUrl,
  email,
  recipientName,
  expiresAt,
  kind = 'reset',
  providerLabel = 'your sign-in method'
}) {
  const config = getEmailDeliveryConfig();
  const message = buildPasswordResetEmail({
    resetUrl,
    expiresAt,
    productName: config.fromName || 'Tasked',
    recipientName,
    kind,
    providerLabel
  });
  const delivery = await sendTransactionalEmail({
    to: email,
    subject: message.subject,
    html: message.html,
    text: message.text,
    idempotencyKey: `password-reset-${resetId}`
  });

  return {
    ...delivery,
    message: passwordResetDeliveryMessage(delivery.status, email)
  };
}
