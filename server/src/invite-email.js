const RESEND_API_URL = 'https://api.resend.com/emails';

function isFlagEnabled(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatInviteExpiry(expiresAt) {
  return new Date(expiresAt).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short'
  });
}

function getInviteEmailConfig() {
  return {
    enabled: isFlagEnabled(process.env.INVITE_EMAILS_ENABLED),
    provider: String(process.env.INVITE_EMAIL_PROVIDER || 'resend').trim().toLowerCase(),
    resendApiKey: String(process.env.RESEND_API_KEY || '').trim(),
    fromEmail: String(process.env.INVITE_FROM_EMAIL || '').trim(),
    fromName: String(process.env.INVITE_FROM_NAME || 'Tasked').trim() || 'Tasked'
  };
}

function isInviteEmailConfigured() {
  const config = getInviteEmailConfig();
  return Boolean(
    config.enabled &&
    config.provider === 'resend' &&
    config.resendApiKey &&
    config.fromEmail
  );
}

function buildFromAddress({ fromName, fromEmail }) {
  return `${fromName} <${fromEmail}>`;
}

function buildInviteEmail({ inviteUrl, inviteeEmail, inviterLabel, workspaceName, expiresAt, productName }) {
  const safeWorkspaceName = escapeHtml(workspaceName);
  const safeInviteeEmail = escapeHtml(inviteeEmail);
  const safeInviterLabel = escapeHtml(inviterLabel);
  const safeInviteUrl = escapeHtml(inviteUrl);
  const expiryLabel = escapeHtml(formatInviteExpiry(expiresAt));
  const safeProductName = escapeHtml(productName);
  const subject = `Join ${workspaceName} on ${productName}`;

  return {
    subject,
    text: [
      `Join ${workspaceName} on ${productName}`,
      '',
      `${inviterLabel} invited ${inviteeEmail} to collaborate in ${workspaceName}.`,
      `Open invite: ${inviteUrl}`,
      `This invite expires ${formatInviteExpiry(expiresAt)}.`,
      `If you were not expecting this invitation, you can safely ignore this email.`
    ].join('\n'),
    html: `
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
        ${safeInviterLabel} invited you to join ${safeWorkspaceName} on ${safeProductName}.
      </div>
      <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #1e2933; max-width: 560px; margin: 0 auto; padding: 24px;">
        <p style="margin: 0 0 10px; font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; color: #5b6b79;">Workspace invitation</p>
        <h1 style="margin: 0 0 14px; font-size: 28px; line-height: 1.2; color: #0f1720;">Join ${safeWorkspaceName}</h1>
        <p style="margin: 0 0 12px;">${safeInviterLabel} invited <strong>${safeInviteeEmail}</strong> to collaborate in <strong>${safeWorkspaceName}</strong> on ${safeProductName}.</p>
        <p style="margin: 0 0 20px;">Use the button below to accept the invitation.</p>
        <p style="margin: 0 0 20px;">
          <a href="${safeInviteUrl}" style="display: inline-block; padding: 12px 18px; border-radius: 999px; background: #31baa0; color: #08121a; text-decoration: none; font-weight: 700;">
            Accept invitation
          </a>
        </p>
        <p style="margin: 0 0 8px; color: #5b6b79;">This invite expires ${expiryLabel}.</p>
        <p style="margin: 0 0 10px; color: #5b6b79;">If the button does not work, open this link:</p>
        <p style="margin: 0 0 18px; word-break: break-all;">
          <a href="${safeInviteUrl}" style="color: #0b66c3; text-decoration: underline;">${safeInviteUrl}</a>
        </p>
        <p style="margin: 0; color: #5b6b79; font-size: 14px;">If you were not expecting this invitation, you can safely ignore this email.</p>
      </div>
    `
  };
}

export function getInviteEmailStatus() {
  const config = getInviteEmailConfig();
  return {
    enabled: isInviteEmailConfigured(),
    requested: config.enabled,
    provider: config.provider
  };
}

export async function sendWorkspaceInviteEmail({
  inviteId,
  inviteUrl,
  inviteeEmail,
  inviterLabel,
  replyTo,
  workspaceName,
  expiresAt
}) {
  const config = getInviteEmailConfig();

  if (!config.enabled) {
    return {
      attempted: false,
      ok: false,
      status: 'disabled',
      message: 'Invite email delivery is disabled.'
    };
  }

  if (config.provider !== 'resend') {
    return {
      attempted: false,
      ok: false,
      status: 'unsupported-provider',
      message: `Invite email provider "${config.provider}" is not supported.`
    };
  }

  if (!isInviteEmailConfigured()) {
    return {
      attempted: false,
      ok: false,
      status: 'misconfigured',
      message: 'Invite email delivery is enabled but not fully configured.'
    };
  }

  const email = buildInviteEmail({
    inviteUrl,
    inviteeEmail,
    inviterLabel,
    workspaceName,
    expiresAt,
    productName: config.fromName || 'Tasked'
  });

  const response = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `workspace-invite-${inviteId}`
    },
    body: JSON.stringify({
      from: buildFromAddress(config),
      to: [inviteeEmail],
      subject: email.subject,
      html: email.html,
      text: email.text,
      ...(replyTo ? { reply_to: replyTo } : {})
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.id) {
    const error = new Error(payload?.message || 'Invite email delivery failed.');
    error.status = 502;
    throw error;
  }

  return {
    attempted: true,
    ok: true,
    status: 'sent',
    message: `Invite email sent to ${inviteeEmail}.`,
    provider: config.provider,
    providerMessageId: payload.id
  };
}
