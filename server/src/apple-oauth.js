import jwt from 'jsonwebtoken';

const APPLE_AUTH_URL = 'https://appleid.apple.com/auth/authorize';
const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';

function isFlagEnabled(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function normalizePrivateKey(value) {
  return String(value || '').replace(/\\n/g, '\n').trim();
}

function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) {
    return {};
  }

  const payload = parts[1]
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(parts[1].length / 4) * 4, '=');

  return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
}

export function isAppleAuthEnabled() {
  return Boolean(
    isFlagEnabled(process.env.APPLE_AUTH_ENABLED) &&
    process.env.APPLE_CLIENT_ID &&
    process.env.APPLE_TEAM_ID &&
    process.env.APPLE_KEY_ID &&
    process.env.APPLE_PRIVATE_KEY
  );
}

function issueAppleClientSecret() {
  if (!isAppleAuthEnabled()) {
    const error = new Error('Apple sign-in is disabled or not configured.');
    error.status = 503;
    throw error;
  }

  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iss: process.env.APPLE_TEAM_ID,
      aud: 'https://appleid.apple.com',
      sub: process.env.APPLE_CLIENT_ID,
      iat: now,
      exp: now + 60 * 5
    },
    normalizePrivateKey(process.env.APPLE_PRIVATE_KEY),
    {
      algorithm: 'ES256',
      keyid: process.env.APPLE_KEY_ID
    }
  );
}

export function buildAppleAuthUrl({ redirectUri, state, nonce }) {
  if (!isAppleAuthEnabled()) {
    const error = new Error('Apple sign-in is disabled or not configured.');
    error.status = 503;
    throw error;
  }

  const params = new URLSearchParams({
    client_id: process.env.APPLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    response_mode: 'form_post',
    scope: 'name email',
    state,
    nonce
  });

  return `${APPLE_AUTH_URL}?${params.toString()}`;
}

export async function exchangeAppleCode({ code, redirectUri }) {
  const response = await fetch(APPLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: process.env.APPLE_CLIENT_ID,
      client_secret: issueAppleClientSecret(),
      redirect_uri: redirectUri
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.id_token) {
    const error = new Error('Apple sign-in failed while exchanging the authorization code.');
    error.status = 502;
    throw error;
  }

  const idToken = decodeJwtPayload(payload.id_token);
  if (!idToken.sub || !idToken.email) {
    const error = new Error('Apple did not return an email address for this account.');
    error.status = 403;
    throw error;
  }

  return {
    email: String(idToken.email).toLowerCase(),
    appleSubject: String(idToken.sub),
    emailVerified: String(idToken.email_verified || '').toLowerCase() === 'true' || idToken.email_verified === true
  };
}

export function parseAppleUserProfile(rawUser) {
  if (!rawUser) {
    return null;
  }

  try {
    const parsed = typeof rawUser === 'string' ? JSON.parse(rawUser) : rawUser;
    const firstName = String(parsed?.name?.firstName || '').trim();
    const lastName = String(parsed?.name?.lastName || '').trim();
    const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();

    return {
      name: fullName || '',
      email: String(parsed?.email || '').trim().toLowerCase()
    };
  } catch {
    return null;
  }
}
