const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const GOOGLE_SCOPES = ['openid', 'email', 'profile'];

function isFlagEnabled(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

export function isGoogleAuthEnabled() {
  return Boolean(
    isFlagEnabled(process.env.GOOGLE_AUTH_ENABLED) &&
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET
  );
}

export function buildGoogleAuthUrl({ redirectUri, state }) {
  if (!isGoogleAuthEnabled()) {
    const error = new Error('Google sign-in is disabled or not configured.');
    error.status = 503;
    throw error;
  }

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    prompt: 'select_account',
    state
  });

  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function exchangeGoogleCode({ code, redirectUri }) {
  if (!isGoogleAuthEnabled()) {
    const error = new Error('Google sign-in is disabled or not configured.');
    error.status = 503;
    throw error;
  }

  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    })
  });

  const tokenPayload = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenPayload.access_token) {
    const error = new Error('Google sign-in failed while exchanging the authorization code.');
    error.status = 502;
    throw error;
  }

  const profileResponse = await fetch(GOOGLE_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${tokenPayload.access_token}`
    }
  });

  const profile = await profileResponse.json().catch(() => ({}));
  if (!profileResponse.ok) {
    const error = new Error('Google sign-in failed while loading the user profile.');
    error.status = 502;
    throw error;
  }

  if (!profile.email || !profile.sub || !profile.email_verified) {
    const error = new Error('Google did not return a verified email address for this account.');
    error.status = 403;
    throw error;
  }

  return {
    email: String(profile.email).toLowerCase(),
    googleSubject: String(profile.sub),
    name: String(profile.name || profile.given_name || profile.email.split('@')[0]).trim()
  };
}
