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

  return {
    subject: `Join ${workspaceName} on Tasked`,
    text: [
      `${inviterLabel} invited ${inviteeEmail} to join ${workspaceName} on Tasked.`,
      '',
      `Open the invite: ${inviteUrl}`,
      `This invite expires ${formatInviteExpiry(expiresAt)}.`
    ].join('\n'),
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e2933; max-width: 560px; margin: 0 auto; padding: 24px;">
        <p style="margin: 0 0 12px; font-size: 14px; letter-spacing: 0.08em; text-transform: uppercase; color: #6a7a89;">Tasked workspace invite</p>
        <h1 style="margin: 0 0 16px; font-size: 28px; line-height: 1.2;">Join ${safeWorkspaceName}</h1>
        <p style="margin: 0 0 12px;">${safeInviterLabel} invited <strong>${safeInviteeEmail}</strong> to collaborate in <strong>${safeWorkspaceName}</strong>.</p>
        <p style="margin: 0 0 24px;">Use the button below to accept the invite.</p>
        <p style="margin: 0 0 24px;">
          <a href="${safeInviteUrl}" style="display: inline-block; background: #0d8b73; color: #ffffff; text-decoration: none; padding: 14px 22px; border-radius: 999px; font-weight: 700;">Open invite</a>
        </p>
        <p style="margin: 0 0 12px; font-size: 14px; color: #6a7a89;">This invite expires ${expiryLabel}.</p>
        <p style="margin: 0; font-size: 14px; color: #6a7a89;">If the button does not work, copy and paste this link into your browser:</p>
        <p style="margin: 8px 0 0; font-size: 14px; word-break: break-all;"><a href="${safeInviteUrl}" style="color: #0d8b73;">${safeInviteUrl}</a></p>
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
      text: email.text
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
