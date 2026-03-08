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

function buildInviteEmail({ inviteUrl, inviteeEmail, inviterLabel, workspaceName, expiresAt }) {
  const safeWorkspaceName = escapeHtml(workspaceName);
  const safeInviteeEmail = escapeHtml(inviteeEmail);
  const safeInviterLabel = escapeHtml(inviterLabel);
  const safeInviteUrl = escapeHtml(inviteUrl);
  const expiryLabel = escapeHtml(formatInviteExpiry(expiresAt));
  const subject = `${inviterLabel} invited you to join ${workspaceName}`;

  return {
    subject,
    text: [
      `${inviterLabel} invited you to join ${workspaceName}.`,
      '',
      `Invitee: ${inviteeEmail}`,
      `Accept invite: ${inviteUrl}`,
      `This invite expires ${formatInviteExpiry(expiresAt)}.`
    ].join('\n'),
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #1e2933; max-width: 560px; margin: 0 auto; padding: 20px 24px;">
        <p style="margin: 0 0 12px;">${safeInviterLabel} invited you to join <strong>${safeWorkspaceName}</strong>.</p>
        <p style="margin: 0 0 12px;">This invite was sent to <strong>${safeInviteeEmail}</strong>.</p>
        <p style="margin: 0 0 12px;">Accept the invite here:</p>
        <p style="margin: 0 0 16px; word-break: break-all;"><a href="${safeInviteUrl}" style="color: #0b66c3; text-decoration: underline;">${safeInviteUrl}</a></p>
        <p style="margin: 0; color: #5b6b79;">This invite expires ${expiryLabel}.</p>
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
    expiresAt
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
