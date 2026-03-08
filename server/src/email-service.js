const RESEND_API_URL = 'https://api.resend.com/emails';

function isFlagEnabled(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

export function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function getEmailDeliveryConfig() {
  return {
    enabled: isFlagEnabled(process.env.INVITE_EMAILS_ENABLED),
    provider: String(process.env.INVITE_EMAIL_PROVIDER || 'resend').trim().toLowerCase(),
    resendApiKey: String(process.env.RESEND_API_KEY || '').trim(),
    fromEmail: String(process.env.INVITE_FROM_EMAIL || '').trim(),
    fromName: String(process.env.INVITE_FROM_NAME || 'Tasked').trim() || 'Tasked'
  };
}

function isEmailDeliveryConfigured() {
  const config = getEmailDeliveryConfig();
  return Boolean(
    config.enabled &&
    config.provider === 'resend' &&
    config.resendApiKey &&
    config.fromEmail
  );
}

export function buildFromAddress({ fromName, fromEmail }) {
  return `${fromName} <${fromEmail}>`;
}

export function getEmailDeliveryStatus() {
  const config = getEmailDeliveryConfig();
  return {
    enabled: isEmailDeliveryConfigured(),
    requested: config.enabled,
    provider: config.provider
  };
}

export async function sendTransactionalEmail({
  to,
  subject,
  html,
  text,
  replyTo = '',
  idempotencyKey = ''
}) {
  const config = getEmailDeliveryConfig();

  if (!config.enabled) {
    return {
      attempted: false,
      ok: false,
      status: 'disabled'
    };
  }

  if (config.provider !== 'resend') {
    return {
      attempted: false,
      ok: false,
      status: 'unsupported-provider'
    };
  }

  if (!isEmailDeliveryConfigured()) {
    return {
      attempted: false,
      ok: false,
      status: 'misconfigured'
    };
  }

  const recipients = Array.isArray(to) ? to.filter(Boolean) : [to].filter(Boolean);
  if (!recipients.length) {
    const error = new Error('Email recipient is required.');
    error.status = 400;
    throw error;
  }

  const response = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
    },
    body: JSON.stringify({
      from: buildFromAddress(config),
      to: recipients,
      subject,
      html,
      text,
      ...(replyTo ? { reply_to: replyTo } : {})
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.id) {
    const error = new Error(payload?.message || 'Email delivery failed.');
    error.status = 502;
    throw error;
  }

  return {
    attempted: true,
    ok: true,
    status: 'sent',
    provider: config.provider,
    providerMessageId: payload.id
  };
}
