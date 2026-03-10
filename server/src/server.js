import 'dotenv/config';
import http from 'node:http';
import crypto from 'node:crypto';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import geoip from 'geoip-lite';
import { WebSocketServer } from 'ws';
import { buildAppleAuthUrl, exchangeAppleCode, isAppleAuthEnabled, parseAppleUserProfile } from './apple-oauth.js';
import { issueAuthToken, issueOAuthState, verifyAuthToken, verifyOAuthState } from './auth.js';
import { buildGoogleAuthUrl, exchangeGoogleCode, isGoogleAuthEnabled } from './google-oauth.js';
import { getInviteEmailStatus, sendWorkspaceInviteEmail } from './invite-email.js';
import { sendPasswordResetEmail } from './password-reset-email.js';
import {
  acceptInviteForUser,
  authenticateWithApple,
  authenticateWithGoogle,
  authenticateUser,
  cancelWorkspaceInvite,
  createPasswordResetRequest,
  createWorkspace,
  createList,
  createTask,
  createWorkspaceInvite,
  deleteWorkspace,
  deleteList,
  deleteTask,
  ensureMembership,
  getArchivedWorkspaces,
  getAdminDashboardSnapshot,
  getAuthContext,
  getAuthSession,
  getInviteByToken,
  getWorkspaceInviteLink,
  getSnapshot,
  initDb,
  leaveWorkspace,
  markUserLogin,
  renameWorkspace,
  promoteWorkspaceMemberToOwner,
  recordAuditLog,
  recordSystemErrorLog,
  removeWorkspaceMember,
  registerUser,
  resendWorkspaceInvite,
  resetPasswordWithToken,
  updateUserProfile,
  updateTask
} from './db.js';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const port = Number(process.env.PORT || 3001);
const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const serverOrigin = process.env.SERVER_ORIGIN || (clientOrigin.includes('localhost:5173') ? `http://localhost:${port}` : clientOrigin);
const appleCallbackPath = '/api/auth/apple/callback';
const googleCallbackPath = '/api/auth/google/callback';
const appleStateCookieName = 'todo_saas_apple_oauth_state';
const googleStateCookieName = 'todo_saas_google_oauth_state';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDistPath = path.resolve(__dirname, '../../client/dist');
const socketGroups = new Map();
const userWorkspaceSockets = new Map();
const PASSWORD_RESET_REQUEST_NOTICE = 'If an account exists for that email, a password link will arrive shortly.';

app.set('trust proxy', true);
app.use(cors({ origin: clientOrigin, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

function normalizeClientIp(value = '') {
  let normalized = String(value || '')
    .split(',')[0]
    .trim();

  if (!normalized) {
    return '';
  }

  if (normalized.startsWith('::ffff:')) {
    normalized = normalized.slice(7);
  }

  if (normalized.startsWith('[') && normalized.includes(']')) {
    normalized = normalized.slice(1, normalized.indexOf(']'));
  }

  return normalized;
}

function isPrivateOrLocalIp(ipAddress) {
  const normalized = normalizeClientIp(ipAddress);
  const family = isIP(normalized);

  if (!family) {
    return true;
  }

  if (family === 4) {
    const [firstOctet, secondOctet] = normalized.split('.').map(Number);

    return (
      firstOctet === 10 ||
      firstOctet === 127 ||
      (firstOctet === 169 && secondOctet === 254) ||
      (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) ||
      (firstOctet === 192 && secondOctet === 168)
    );
  }

  const lower = normalized.toLowerCase();
  return (
    lower === '::1' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe80:')
  );
}

function buildLocationLabel(location) {
  const label = [location.city, location.region, location.country]
    .filter(Boolean)
    .join(', ');

  return label || location.country || 'Location unavailable';
}

function lookupIpLocation(ipAddress) {
  const normalized = normalizeClientIp(ipAddress);

  if (!normalized) {
    return {
      status: 'missing-ip',
      label: 'IP unavailable'
    };
  }

  if (isPrivateOrLocalIp(normalized)) {
    return {
      status: 'private-or-local',
      label: 'Private/local IP'
    };
  }

  const match = geoip.lookup(normalized);
  if (!match) {
    return {
      status: 'not-found',
      label: 'Location unavailable'
    };
  }

  const location = {
    status: 'resolved',
    city: match.city || '',
    region: match.region || '',
    country: match.country || '',
    timezone: match.timezone || '',
    latitude: Array.isArray(match.ll) ? match.ll[0] : null,
    longitude: Array.isArray(match.ll) ? match.ll[1] : null
  };

  return {
    ...location,
    label: buildLocationLabel(location)
  };
}

function getClientIp(req) {
  if (!req) {
    return '';
  }

  return normalizeClientIp(
    req.headers['x-forwarded-for'] ||
    req.ip ||
    req.socket?.remoteAddress ||
    req.connection?.remoteAddress ||
    ''
  );
}

function getRequestContext(req) {
  if (!req) {
    return {
      ipAddress: null,
      userAgent: '',
      location: {
        status: 'missing-request',
        label: 'Request unavailable'
      }
    };
  }

  const ipAddress = getClientIp(req);

  return {
    ipAddress: ipAddress || null,
    userAgent: String(req.headers['user-agent'] || ''),
    location: lookupIpLocation(ipAddress)
  };
}

function buildRequestMetadata(req, metadata = {}) {
  const requestContext = getRequestContext(req);

  return {
    ...metadata,
    ipAddress: requestContext.ipAddress,
    userAgent: requestContext.userAgent,
    location: requestContext.location
  };
}

function logBackgroundFailure(message, error, details = {}) {
  console.error(message, {
    ...details,
    error: error?.message || String(error)
  });
}

function logAuditEvent(entry) {
  recordAuditLog(entry).catch((error) => {
    logBackgroundFailure('Failed to record audit log', error, {
      eventType: entry?.eventType
    });
  });
}

function logSystemEvent(entry) {
  recordSystemErrorLog(entry).catch((error) => {
    logBackgroundFailure('Failed to record system error log', error, {
      source: entry?.source
    });
  });
}

function sendError(res, error) {
  const status = error.status || 500;
  const req = res.req;

  if (status >= 500) {
    logSystemEvent({
      level: 'error',
      source: 'api',
      message: error.message || 'Internal server error.',
      stack: error.stack || '',
      statusCode: status,
      requestMethod: req?.method || '',
      requestPath: req?.originalUrl || req?.url || '',
      userId: req?.auth?.userId || null,
      metadata: buildRequestMetadata(req, {
        params: req?.params || {},
        query: req?.query || {},
        bodyKeys: Object.keys(req?.body || {}).filter((key) => (
          !['password', 'currentPassword', 'newPassword', 'resetToken'].includes(key)
        ))
      })
    });
  }

  res.status(status).json({ error: error.message || 'Internal server error.' });
}

function buildInviteUrl(req, inviteToken) {
  const baseUrl = String(req.headers.origin || process.env.CLIENT_ORIGIN || clientOrigin);
  const inviteUrl = new URL(baseUrl);
  inviteUrl.searchParams.set('invite', inviteToken);
  return inviteUrl.toString();
}

function buildPasswordResetUrl(req, resetToken) {
  const baseUrl = String(req.headers.origin || process.env.CLIENT_ORIGIN || clientOrigin);
  const resetUrl = new URL(baseUrl);
  resetUrl.searchParams.set('reset', resetToken);
  return resetUrl.toString();
}

async function deliverInviteEmail({ req, invite }) {
  const inviteUrl = buildInviteUrl(req, invite.token);
  const inviterLabel = invite.invitedByName || req.currentUser?.email || req.auth.email || 'A teammate';

  let emailDelivery;
  try {
    emailDelivery = await sendWorkspaceInviteEmail({
      inviteId: invite.id,
      inviteUrl,
      inviteeEmail: invite.email,
      inviterLabel,
      replyTo: req.auth.email || '',
      workspaceName: invite.workspace?.name || 'your workspace',
      expiresAt: invite.expiresAt
    });
  } catch (error) {
    console.error('Failed to send invite email', {
      inviteId: invite.id,
      email: invite.email,
      error: error.message
    });
    logSystemEvent({
      level: 'error',
      source: 'invite-email',
      message: 'Failed to send invite email.',
      stack: error.stack || '',
      userId: req?.auth?.userId || null,
      metadata: buildRequestMetadata(req, {
        inviteId: invite.id,
        email: invite.email
      })
    });
    emailDelivery = {
      attempted: true,
      ok: false,
      status: 'failed',
      message: 'Invite created, but the email could not be sent.'
    };
  }

  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    inviteUrl,
    emailDelivery
  };
}

async function deliverPasswordResetEmail({ req, resetRequest }) {
  const resetUrl = buildPasswordResetUrl(req, resetRequest.token);

  try {
    const emailDelivery = await sendPasswordResetEmail({
      resetId: resetRequest.id,
      resetUrl,
      email: resetRequest.email,
      recipientName: resetRequest.name,
      expiresAt: resetRequest.expiresAt,
      kind: resetRequest.kind,
      providerLabel: resetRequest.providerLabel
    });

    if (!emailDelivery.ok) {
      console.warn('Password link email was not sent', {
        resetId: resetRequest.id,
        userId: resetRequest.userId,
        email: resetRequest.email,
        kind: resetRequest.kind,
        status: emailDelivery.status
      });
      logSystemEvent({
        level: 'warning',
        source: 'password-reset-email',
        message: 'Password link email was not sent.',
        userId: resetRequest.userId,
        metadata: buildRequestMetadata(req, {
          resetId: resetRequest.id,
          email: resetRequest.email,
          kind: resetRequest.kind,
          status: emailDelivery.status
        })
      });
    }
  } catch (error) {
    console.error('Failed to send password link email', {
      resetId: resetRequest.id,
      userId: resetRequest.userId,
      email: resetRequest.email,
      kind: resetRequest.kind,
      error: error.message
    });
    logSystemEvent({
      level: 'error',
      source: 'password-reset-email',
      message: 'Failed to send password link email.',
      stack: error.stack || '',
      userId: resetRequest.userId,
      metadata: buildRequestMetadata(req, {
        resetId: resetRequest.id,
        email: resetRequest.email,
        kind: resetRequest.kind
      })
    });
  }
}

function parseCookies(header = '') {
  return String(header)
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, entry) => {
      const separatorIndex = entry.indexOf('=');
      if (separatorIndex === -1) {
        return cookies;
      }

      const key = entry.slice(0, separatorIndex).trim();
      const value = entry.slice(separatorIndex + 1).trim();
      cookies[key] = decodeURIComponent(value);
      return cookies;
    }, {});
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  if (options.path) {
    parts.push(`Path=${options.path}`);
  }

  if (options.httpOnly) {
    parts.push('HttpOnly');
  }

  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }

  if (options.secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

function getGoogleRedirectUri() {
  return new URL(googleCallbackPath, serverOrigin).toString();
}

function getAppleRedirectUri() {
  return new URL(appleCallbackPath, serverOrigin).toString();
}

function getClearedOAuthCookie(name, pathName) {
  return serializeCookie(name, '', {
    maxAge: 0,
    path: pathName,
    httpOnly: true,
    sameSite: 'Lax',
    secure: serverOrigin.startsWith('https://')
  });
}

function getGoogleCallbackCookie() {
  return getClearedOAuthCookie(googleStateCookieName, googleCallbackPath);
}

function getAppleCallbackCookie() {
  return getClearedOAuthCookie(appleStateCookieName, appleCallbackPath);
}

function buildClientRedirect({ inviteToken = '', hashParams = {} }) {
  const redirectUrl = new URL(clientOrigin);
  if (inviteToken) {
    redirectUrl.searchParams.set('invite', inviteToken);
  }

  const hash = new URLSearchParams(
    Object.entries(hashParams).filter(([, value]) => value !== undefined && value !== null && value !== '')
  ).toString();

  redirectUrl.hash = hash;
  return redirectUrl.toString();
}

function redirectWithOAuthError(res, { message, inviteToken = '', authMode = 'google', cookie = null }) {
  if (cookie) {
    res.setHeader('Set-Cookie', cookie);
  }
  res.redirect(
    buildClientRedirect({
      inviteToken,
      hashParams: {
        authError: message,
        authMode
      }
    })
  );
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }

  let auth;
  try {
    auth = verifyAuthToken(token);
  } catch {
    res.status(401).json({ error: 'Invalid or expired token.' });
    return;
  }

  try {
    const currentUser = await getAuthContext(auth.userId);
    if (!currentUser) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }

    req.auth = auth;
    req.currentUser = currentUser;
    next();
  } catch (error) {
    sendError(res, error);
  }
}

function requireAppUser(req, res, next) {
  if (req.currentUser?.siteRole === 'SUPER_ADMIN') {
    res.status(403).json({ error: 'Super admins can only access the admin dashboard.' });
    return;
  }

  next();
}

function requireSuperAdmin(req, res, next) {
  if (req.currentUser?.siteRole !== 'SUPER_ADMIN') {
    res.status(403).json({ error: 'Super admin access is required.' });
    return;
  }

  next();
}

async function requireWorkspace(req, res, next) {
  const workspaceId = Number(req.headers['x-workspace-id'] || req.query.workspaceId || req.body?.workspaceId);
  if (!workspaceId) {
    res.status(400).json({ error: 'workspaceId is required.' });
    return;
  }

  const membership = await ensureMembership(req.auth.userId, workspaceId);
  if (!membership) {
    res.status(403).json({ error: 'You do not have access to this workspace.' });
    return;
  }

  req.workspaceId = workspaceId;
  req.membership = membership;
  next();
}

function broadcastToWorkspace(workspaceId, action, details = {}) {
  const clients = socketGroups.get(String(workspaceId));
  if (!clients?.size) return;

  const payload = JSON.stringify({
    type: 'event',
    data: {
      action,
      details,
      sentAt: new Date().toISOString()
    }
  });

  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

function attachSocketToWorkspace(workspaceId, socket) {
  const key = String(workspaceId);
  const group = socketGroups.get(key) || new Set();
  group.add(socket);
  socketGroups.set(key, group);
  const userKey = `${workspaceId}:${socket.userId}`;
  const userGroup = userWorkspaceSockets.get(userKey) || new Set();
  userGroup.add(socket);
  userWorkspaceSockets.set(userKey, userGroup);

  socket.on('close', () => {
    group.delete(socket);
    if (!group.size) {
      socketGroups.delete(key);
    }

    userGroup.delete(socket);
    if (!userGroup.size) {
      userWorkspaceSockets.delete(userKey);
    }
  });
}

function revokeWorkspaceAccess({ workspaceId, userId, reason = 'Access revoked.' }) {
  const userKey = `${workspaceId}:${userId}`;
  const sockets = userWorkspaceSockets.get(userKey);
  if (!sockets?.size) return;
  const workspaceKey = String(workspaceId);
  const group = socketGroups.get(workspaceKey);

  const payload = JSON.stringify({
    type: 'access_revoked',
    data: {
      workspaceId,
      reason
    }
  });

  for (const socket of Array.from(sockets)) {
    group?.delete(socket);
    sockets.delete(socket);
    if (socket.readyState === 1) {
      socket.send(payload);
    }
    socket.close(4001, 'workspace access revoked');
  }

  if (group && !group.size) {
    socketGroups.delete(workspaceKey);
  }

  if (!sockets.size) {
    userWorkspaceSockets.delete(userKey);
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/auth/providers', (_req, res) => {
  res.json({
    google: {
      enabled: isGoogleAuthEnabled()
    },
    apple: {
      enabled: isAppleAuthEnabled()
    },
    inviteEmail: getInviteEmailStatus()
  });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '');
    const workspaceName = String(req.body.workspaceName || '').trim();
    const inviteToken = req.body.inviteToken ? String(req.body.inviteToken) : null;

    if (!name || !email || !password) {
      res.status(400).json({ error: 'name, email, and password are required.' });
      return;
    }

    if (name.length < 2 || name.length > 60) {
      res.status(400).json({ error: 'name must be between 2 and 60 characters.' });
      return;
    }

    const { user, workspace, workspaces, defaultWorkspaceId } = await registerUser({
      name,
      email,
      password,
      workspaceName,
      inviteToken
    });
    await markUserLogin(user.id);
    logAuditEvent({
      actorUserId: user.id,
      eventType: 'auth.register',
      targetType: 'user',
      targetId: user.id,
      workspaceId: workspace?.id || null,
      metadata: buildRequestMetadata(req, {
        provider: 'password',
        workspaceCreated: Boolean(workspace?.id)
      })
    });
    const token = issueAuthToken({ userId: user.id, email: user.email });
    res.status(201).json({ token, user, workspaces, defaultWorkspaceId: defaultWorkspaceId || workspace?.id || null });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/auth/password-reset/request', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim();
    if (!email) {
      res.status(400).json({ error: 'Email is required.' });
      return;
    }

    const resetRequest = await createPasswordResetRequest({ email });
    if (resetRequest) {
      await deliverPasswordResetEmail({ req, resetRequest });
      logAuditEvent({
        actorUserId: resetRequest.userId,
        eventType: 'auth.password_reset.requested',
        targetType: 'user',
        targetId: resetRequest.userId,
        metadata: buildRequestMetadata(req, {
          kind: resetRequest.kind
        })
      });
    }

    res.json({ notice: PASSWORD_RESET_REQUEST_NOTICE });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/auth/password-reset/complete', async (req, res) => {
  try {
    const resetToken = String(req.body.resetToken || '').trim();
    const password = String(req.body.password || '');

    if (!resetToken || !password) {
      res.status(400).json({ error: 'resetToken and password are required.' });
      return;
    }

    const authResult = await resetPasswordWithToken({ resetToken, password });
    await markUserLogin(authResult.user.id);
    logAuditEvent({
      actorUserId: authResult.user.id,
      eventType: 'auth.password_reset.completed',
      targetType: 'user',
      targetId: authResult.user.id,
      metadata: buildRequestMetadata(req, {
        provider: 'password'
      })
    });
    const token = issueAuthToken({ userId: authResult.user.id, email: authResult.user.email });
    res.json({
      token,
      user: authResult.user,
      workspaces: authResult.workspaces,
      defaultWorkspaceId: authResult.defaultWorkspaceId
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/auth/session', requireAuth, async (req, res) => {
  try {
    const session = await getAuthSession(req.auth.userId);
    res.json(session);
  } catch (error) {
    sendError(res, error);
  }
});

app.patch('/api/auth/profile', requireAuth, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const currentPassword = String(req.body.currentPassword || '');
    const newPassword = String(req.body.newPassword || '');

    if (!name) {
      res.status(400).json({ error: 'Name is required.' });
      return;
    }

    if (name.length < 2 || name.length > 60) {
      res.status(400).json({ error: 'Name must be between 2 and 60 characters.' });
      return;
    }

    const updateResult = await updateUserProfile({
      userId: req.auth.userId,
      name,
      currentPassword,
      newPassword
    });
    const session = await getAuthSession(req.auth.userId);

    if (updateResult.nameChanged) {
      for (const workspace of session.workspaces) {
        broadcastToWorkspace(workspace.id, 'profile.updated', {
          userId: req.auth.userId
        });
      }
    }

    res.json({
      user: session.user,
      workspaces: session.workspaces,
      pendingInvites: session.pendingInvites,
      defaultWorkspaceId: session.defaultWorkspaceId
    });
    logAuditEvent({
      actorUserId: req.auth.userId,
      eventType: 'profile.updated',
      targetType: 'user',
      targetId: req.auth.userId,
      metadata: {
        nameChanged: updateResult.nameChanged,
        passwordChanged: Boolean(newPassword)
      }
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/admin/dashboard', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const dashboard = await getAdminDashboardSnapshot();
    res.json(dashboard);
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/workspaces', requireAuth, requireAppUser, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) {
      res.status(400).json({ error: 'Workspace name is required.' });
      return;
    }

    const workspace = await createWorkspace({ userId: req.auth.userId, name });
    const session = await getAuthSession(req.auth.userId);
    logAuditEvent({
      actorUserId: req.auth.userId,
      eventType: 'workspace.created',
      targetType: 'workspace',
      targetId: workspace.id,
      workspaceId: workspace.id,
      metadata: {
        workspaceName: workspace.name
      }
    });
    res.status(201).json({
      workspace,
      workspaces: session.workspaces,
      defaultWorkspaceId: workspace.id
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.patch('/api/workspaces/:id', requireAuth, requireAppUser, async (req, res) => {
  try {
    const workspaceId = Number(req.params.id);
    const name = String(req.body.name || '').trim();
    if (!workspaceId) {
      res.status(400).json({ error: 'Workspace id is required.' });
      return;
    }
    if (!name) {
      res.status(400).json({ error: 'Workspace name is required.' });
      return;
    }

    const workspace = await renameWorkspace({
      workspaceId,
      actorUserId: req.auth.userId,
      name
    });

    broadcastToWorkspace(workspaceId, 'workspace.renamed', {
      workspaceId,
      name: workspace.name
    });
    logAuditEvent({
      actorUserId: req.auth.userId,
      eventType: 'workspace.renamed',
      targetType: 'workspace',
      targetId: workspaceId,
      workspaceId,
      metadata: {
        previousName: workspace.previousName,
        workspaceName: workspace.name
      }
    });

    res.json({ workspace });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/workspaces/:id/leave', requireAuth, requireAppUser, async (req, res) => {
  try {
    const workspaceId = Number(req.params.id);
    if (!workspaceId) {
      res.status(400).json({ error: 'Workspace id is required.' });
      return;
    }

    const leftWorkspace = await leaveWorkspace({
      workspaceId,
      userId: req.auth.userId
    });
    revokeWorkspaceAccess({
      workspaceId,
      userId: req.auth.userId,
      reason: `You left ${leftWorkspace.workspaceName}.`
    });
    broadcastToWorkspace(workspaceId, 'member.left', {
      userId: req.auth.userId
    });
    logAuditEvent({
      actorUserId: req.auth.userId,
      eventType: 'workspace.left',
      targetType: 'workspace',
      targetId: workspaceId,
      workspaceId,
      metadata: {
        workspaceName: leftWorkspace.workspaceName
      }
    });

    const session = await getAuthSession(req.auth.userId);
    res.json({
      workspaces: session.workspaces,
      defaultWorkspaceId: session.defaultWorkspaceId,
      leftWorkspaceId: workspaceId
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/workspaces/archived', requireAuth, requireAppUser, async (req, res) => {
  try {
    const workspaces = await getArchivedWorkspaces(req.auth.userId);
    res.json({ workspaces });
  } catch (error) {
    sendError(res, error);
  }
});

app.delete('/api/workspaces/:id', requireAuth, requireAppUser, async (req, res) => {
  try {
    const workspaceId = Number(req.params.id);
    if (!workspaceId) {
      res.status(400).json({ error: 'Workspace id is required.' });
      return;
    }

    const deletedWorkspace = await deleteWorkspace({
      workspaceId,
      actorUserId: req.auth.userId
    });

    for (const member of deletedWorkspace.members) {
      revokeWorkspaceAccess({
        workspaceId,
        userId: member.userId,
        reason: `${deletedWorkspace.workspaceName} was deleted.`
      });
    }
    logAuditEvent({
      actorUserId: req.auth.userId,
      eventType: 'workspace.deleted',
      targetType: 'workspace',
      targetId: workspaceId,
      workspaceId,
      metadata: {
        workspaceName: deletedWorkspace.workspaceName,
        impactedMembers: deletedWorkspace.members.length
      }
    });

    const session = await getAuthSession(req.auth.userId);
    res.json({
      workspaces: session.workspaces,
      defaultWorkspaceId: session.defaultWorkspaceId,
      deletedWorkspaceId: workspaceId
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '');
    if (!email || !password) {
      res.status(400).json({ error: 'email and password are required.' });
      return;
    }

    const authResult = await authenticateUser({ email, password });
    await markUserLogin(authResult.user.id);
    logAuditEvent({
      actorUserId: authResult.user.id,
      eventType: 'auth.login',
      targetType: 'user',
      targetId: authResult.user.id,
      metadata: buildRequestMetadata(req, {
        provider: 'password'
      })
    });
    const token = issueAuthToken({ userId: authResult.user.id, email: authResult.user.email });
    res.json({ token, user: authResult.user, workspaces: authResult.workspaces, defaultWorkspaceId: authResult.defaultWorkspaceId });
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/auth/google', async (req, res) => {
  if (!isGoogleAuthEnabled()) {
    res.status(503).json({ error: 'Google sign-in is not configured.' });
    return;
  }

  try {
    const inviteToken = String(req.query.invite || req.query.inviteToken || '').trim();
    const nonce = crypto.randomBytes(24).toString('hex');
    const state = issueOAuthState({ nonce, inviteToken, provider: 'google' });

    res.setHeader(
      'Set-Cookie',
      serializeCookie(googleStateCookieName, nonce, {
        maxAge: 600,
        path: googleCallbackPath,
        httpOnly: true,
        sameSite: 'Lax',
        secure: serverOrigin.startsWith('https://')
      })
    );
    res.redirect(
      buildGoogleAuthUrl({
        redirectUri: getGoogleRedirectUri(),
        state
      })
    );
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/auth/google/callback', async (req, res) => {
  const inviteTokenFromQuery = String(req.query.invite || req.query.inviteToken || '').trim();
  let callbackInviteToken = inviteTokenFromQuery;

  try {
    const code = String(req.query.code || '').trim();
    const stateToken = String(req.query.state || '').trim();
    const errorCode = String(req.query.error || '').trim();

    if (errorCode) {
      redirectWithOAuthError(res, {
        message: 'Google sign-in was canceled or denied.',
        inviteToken: inviteTokenFromQuery,
        authMode: 'google',
        cookie: getGoogleCallbackCookie()
      });
      return;
    }

    if (!code || !stateToken) {
      redirectWithOAuthError(res, {
        message: 'Google sign-in returned an incomplete response.',
        inviteToken: inviteTokenFromQuery,
        authMode: 'google',
        cookie: getGoogleCallbackCookie()
      });
      return;
    }

    const state = verifyOAuthState(stateToken);
    if (state.provider !== 'google') {
      throw new Error('Invalid Google sign-in state.');
    }
    callbackInviteToken = state.inviteToken || inviteTokenFromQuery;
    const cookies = parseCookies(req.headers.cookie);
    if (!cookies[googleStateCookieName] || cookies[googleStateCookieName] !== state.nonce) {
      redirectWithOAuthError(res, {
        message: 'Google sign-in could not be verified. Please try again.',
        inviteToken: callbackInviteToken,
        authMode: 'google',
        cookie: getGoogleCallbackCookie()
      });
      return;
    }

    const profile = await exchangeGoogleCode({
      code,
      redirectUri: getGoogleRedirectUri()
    });
    const authResult = await authenticateWithGoogle({
      email: profile.email,
      googleSubject: profile.googleSubject,
      name: profile.name,
      inviteToken: callbackInviteToken || null
    });
    await markUserLogin(authResult.user.id);
    logAuditEvent({
      actorUserId: authResult.user.id,
      eventType: 'auth.oauth.google',
      targetType: 'user',
      targetId: authResult.user.id,
      metadata: buildRequestMetadata(req, {
        provider: 'google'
      })
    });
    const token = issueAuthToken({ userId: authResult.user.id, email: authResult.user.email });

    res.setHeader('Set-Cookie', getGoogleCallbackCookie());
    res.redirect(
      buildClientRedirect({
        inviteToken: callbackInviteToken,
        hashParams: {
          token
        }
      })
    );
  } catch (error) {
    redirectWithOAuthError(res, {
      message: error.message || 'Google sign-in failed.',
      inviteToken: callbackInviteToken,
      authMode: 'google',
      cookie: getGoogleCallbackCookie()
    });
  }
});

app.get('/api/auth/apple', async (req, res) => {
  if (!isAppleAuthEnabled()) {
    res.status(503).json({ error: 'Apple sign-in is not configured.' });
    return;
  }

  try {
    const inviteToken = String(req.query.invite || req.query.inviteToken || '').trim();
    const nonce = crypto.randomBytes(24).toString('hex');
    const state = issueOAuthState({ nonce, inviteToken, provider: 'apple' });

    res.setHeader(
      'Set-Cookie',
      serializeCookie(appleStateCookieName, nonce, {
        maxAge: 600,
        path: appleCallbackPath,
        httpOnly: true,
        sameSite: 'Lax',
        secure: serverOrigin.startsWith('https://')
      })
    );
    res.redirect(
      buildAppleAuthUrl({
        redirectUri: getAppleRedirectUri(),
        state,
        nonce: crypto.randomBytes(16).toString('hex')
      })
    );
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/auth/apple/callback', async (req, res) => {
  const inviteTokenFromQuery = String(req.query.invite || req.query.inviteToken || '').trim();
  let callbackInviteToken = inviteTokenFromQuery;

  try {
    const code = String(req.body.code || '').trim();
    const stateToken = String(req.body.state || '').trim();
    const errorCode = String(req.body.error || '').trim();

    if (errorCode) {
      redirectWithOAuthError(res, {
        message: 'Apple sign-in was canceled or denied.',
        inviteToken: inviteTokenFromQuery,
        authMode: 'apple',
        cookie: getAppleCallbackCookie()
      });
      return;
    }

    if (!code || !stateToken) {
      redirectWithOAuthError(res, {
        message: 'Apple sign-in returned an incomplete response.',
        inviteToken: inviteTokenFromQuery,
        authMode: 'apple',
        cookie: getAppleCallbackCookie()
      });
      return;
    }

    const state = verifyOAuthState(stateToken);
    if (state.provider !== 'apple') {
      throw new Error('Invalid Apple sign-in state.');
    }

    callbackInviteToken = state.inviteToken || inviteTokenFromQuery;
    const cookies = parseCookies(req.headers.cookie);
    if (!cookies[appleStateCookieName] || cookies[appleStateCookieName] !== state.nonce) {
      redirectWithOAuthError(res, {
        message: 'Apple sign-in could not be verified. Please try again.',
        inviteToken: callbackInviteToken,
        authMode: 'apple',
        cookie: getAppleCallbackCookie()
      });
      return;
    }

    const tokenResult = await exchangeAppleCode({
      code,
      redirectUri: getAppleRedirectUri()
    });
    if (!tokenResult.emailVerified) {
      throw new Error('Apple did not return a verified email address for this account.');
    }

    const appleUser = parseAppleUserProfile(req.body.user);
    const name = appleUser?.name || tokenResult.email.split('@')[0];
    const authResult = await authenticateWithApple({
      email: appleUser?.email || tokenResult.email,
      appleSubject: tokenResult.appleSubject,
      name,
      inviteToken: callbackInviteToken || null
    });
    await markUserLogin(authResult.user.id);
    logAuditEvent({
      actorUserId: authResult.user.id,
      eventType: 'auth.oauth.apple',
      targetType: 'user',
      targetId: authResult.user.id,
      metadata: buildRequestMetadata(req, {
        provider: 'apple'
      })
    });
    const token = issueAuthToken({ userId: authResult.user.id, email: authResult.user.email });

    res.setHeader('Set-Cookie', getAppleCallbackCookie());
    res.redirect(
      buildClientRedirect({
        inviteToken: callbackInviteToken,
        hashParams: {
          token
        }
      })
    );
  } catch (error) {
    redirectWithOAuthError(res, {
      message: error.message || 'Apple sign-in failed.',
      inviteToken: callbackInviteToken,
      authMode: 'apple',
      cookie: getAppleCallbackCookie()
    });
  }
});

app.get('/api/bootstrap', requireAuth, requireAppUser, async (req, res) => {
  try {
    const workspaceId = Number(req.query.workspaceId);
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId is required.' });
      return;
    }

    const snapshot = await getSnapshot({ userId: req.auth.userId, workspaceId });
    res.json(snapshot);
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/invites/:token', async (req, res) => {
  try {
    const invite = await getInviteByToken(String(req.params.token || ''));
    if (!invite) {
      res.status(404).json({ error: 'Invite not found or expired.' });
      return;
    }

    res.json({
      invite: {
        email: invite.email,
        role: invite.role,
        hasAccount: invite.hasAccount,
        workspaceId: invite.workspaceId,
        workspaceName: invite.workspaceName,
        workspaceSlug: invite.workspaceSlug,
        expiresAt: invite.expiresAt
      }
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/invites', requireAuth, requireAppUser, requireWorkspace, async (req, res) => {
  try {
    if (!['owner', 'member'].includes(req.membership.role)) {
      res.status(403).json({ error: 'You do not have permission to create invites in this workspace.' });
      return;
    }

    const email = String(req.body.email || '').trim();
    if (!email) {
      res.status(400).json({ error: 'email is required.' });
      return;
    }

    const invite = await createWorkspaceInvite({ workspaceId: req.workspaceId, userId: req.auth.userId, email });
    const invitePayload = await deliverInviteEmail({ req, invite });

    broadcastToWorkspace(req.workspaceId, 'invite.created', { email: invite.email });
    logAuditEvent({
      actorUserId: req.auth.userId,
      eventType: 'invite.created',
      targetType: 'invite',
      targetId: invite.id,
      workspaceId: req.workspaceId,
      metadata: {
        email: invite.email
      }
    });
    res.status(201).json({ invite: invitePayload });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/invites/:id/resend', requireAuth, requireAppUser, requireWorkspace, async (req, res) => {
  try {
    if (!['owner', 'member'].includes(req.membership.role)) {
      res.status(403).json({ error: 'You do not have permission to manage invites in this workspace.' });
      return;
    }

    const invite = await resendWorkspaceInvite({
      workspaceId: req.workspaceId,
      inviteId: Number(req.params.id),
      userId: req.auth.userId
    });
    const invitePayload = await deliverInviteEmail({ req, invite });

    broadcastToWorkspace(req.workspaceId, 'invite.resent', { inviteId: invite.id, email: invite.email });
    logAuditEvent({
      actorUserId: req.auth.userId,
      eventType: 'invite.resent',
      targetType: 'invite',
      targetId: invite.id,
      workspaceId: req.workspaceId,
      metadata: {
        email: invite.email
      }
    });
    res.json({ invite: invitePayload });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/invites/:id/link', requireAuth, requireAppUser, requireWorkspace, async (req, res) => {
  try {
    if (!['owner', 'member'].includes(req.membership.role)) {
      res.status(403).json({ error: 'You do not have permission to manage invites in this workspace.' });
      return;
    }

    const invite = await getWorkspaceInviteLink({
      workspaceId: req.workspaceId,
      inviteId: Number(req.params.id)
    });
    const inviteUrl = buildInviteUrl(req, invite.token);

    res.json({
      invite: {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        createdAt: invite.createdAt,
        expiresAt: invite.expiresAt,
        inviteUrl
      }
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.delete('/api/invites/:id', requireAuth, requireAppUser, requireWorkspace, async (req, res) => {
  try {
    if (!['owner', 'member'].includes(req.membership.role)) {
      res.status(403).json({ error: 'You do not have permission to manage invites in this workspace.' });
      return;
    }

    const invite = await cancelWorkspaceInvite({
      workspaceId: req.workspaceId,
      inviteId: Number(req.params.id)
    });
    if (!invite) {
      res.status(404).json({ error: 'Invite not found or no longer pending.' });
      return;
    }

    broadcastToWorkspace(req.workspaceId, 'invite.cancelled', { inviteId: invite.id, email: invite.email });
    logAuditEvent({
      actorUserId: req.auth.userId,
      eventType: 'invite.cancelled',
      targetType: 'invite',
      targetId: invite.id,
      workspaceId: req.workspaceId,
      metadata: {
        email: invite.email
      }
    });
    res.status(204).end();
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/invites/accept', requireAuth, requireAppUser, async (req, res) => {
  try {
    const inviteToken = String(req.body.inviteToken || '').trim();
    const inviteId = Number(req.body.inviteId || 0);
    if (!inviteToken && !inviteId) {
      res.status(400).json({ error: 'inviteToken or inviteId is required.' });
      return;
    }

    const workspaceId = await acceptInviteForUser({
      inviteToken: inviteToken || null,
      inviteId: inviteId || null,
      userId: req.auth.userId,
      email: req.currentUser.email
    });

    logAuditEvent({
      actorUserId: req.auth.userId,
      eventType: 'invite.accepted',
      targetType: 'workspace',
      targetId: workspaceId,
      workspaceId
    });
    res.status(201).json({ workspaceId });
  } catch (error) {
    sendError(res, error);
  }
});

app.delete('/api/members/:id', requireAuth, requireAppUser, requireWorkspace, async (req, res) => {
  try {
    const targetUserId = Number(req.params.id);
    if (!targetUserId) {
      res.status(400).json({ error: 'Member id is required.' });
      return;
    }

    const removed = await removeWorkspaceMember({
      workspaceId: req.workspaceId,
      actorUserId: req.auth.userId,
      targetUserId
    });

    revokeWorkspaceAccess({
      workspaceId: req.workspaceId,
      userId: Number(removed.userId),
      reason: `You were removed from ${req.membership.name}.`
    });
    broadcastToWorkspace(req.workspaceId, 'member.removed', {
      userId: Number(removed.userId),
      email: removed.email
    });
    logAuditEvent({
      actorUserId: req.auth.userId,
      eventType: 'member.removed',
      targetType: 'user',
      targetId: removed.userId,
      workspaceId: req.workspaceId,
      metadata: {
        email: removed.email
      }
    });
    res.status(204).end();
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/members/:id/owner', requireAuth, requireAppUser, requireWorkspace, async (req, res) => {
  try {
    const targetUserId = Number(req.params.id);
    if (!targetUserId) {
      res.status(400).json({ error: 'Member id is required.' });
      return;
    }

    const promoted = await promoteWorkspaceMemberToOwner({
      workspaceId: req.workspaceId,
      actorUserId: req.auth.userId,
      targetUserId
    });

    broadcastToWorkspace(req.workspaceId, 'member.promoted', {
      userId: Number(promoted.userId),
      email: promoted.email
    });
    logAuditEvent({
      actorUserId: req.auth.userId,
      eventType: 'member.promoted',
      targetType: 'user',
      targetId: promoted.userId,
      workspaceId: req.workspaceId,
      metadata: {
        email: promoted.email
      }
    });
    res.status(204).end();
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/lists', requireAuth, requireAppUser, requireWorkspace, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const type = String(req.body.type || 'task').trim().toLowerCase();
    if (!name) {
      res.status(400).json({ error: 'List name is required.' });
      return;
    }

    if (!['task', 'grocery'].includes(type)) {
      res.status(400).json({ error: 'List type must be task or grocery.' });
      return;
    }

    const list = await createList({ workspaceId: req.workspaceId, userId: req.auth.userId, name, type });
    broadcastToWorkspace(req.workspaceId, 'list.created', { listId: list.id });
    logAuditEvent({
      actorUserId: req.auth.userId,
      eventType: 'list.created',
      targetType: 'list',
      targetId: list.id,
      workspaceId: req.workspaceId,
      metadata: {
        listName: list.name,
        type: list.type
      }
    });
    res.status(201).json({ list });
  } catch (error) {
    sendError(res, error);
  }
});

app.delete('/api/lists/:id', requireAuth, requireAppUser, requireWorkspace, async (req, res) => {
  try {
    const removed = await deleteList({ workspaceId: req.workspaceId, listId: Number(req.params.id) });
    if (!removed.ok) {
      if (removed.reason === 'last-list') {
        res.status(400).json({ error: 'You must keep at least one list in the workspace.' });
        return;
      }

      res.status(404).json({ error: 'List not found.' });
      return;
    }

    broadcastToWorkspace(req.workspaceId, 'list.deleted', { listId: Number(req.params.id) });
    logAuditEvent({
      actorUserId: req.auth.userId,
      eventType: 'list.deleted',
      targetType: 'list',
      targetId: Number(req.params.id),
      workspaceId: req.workspaceId
    });
    res.status(204).end();
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/tasks', requireAuth, requireAppUser, requireWorkspace, async (req, res) => {
  try {
    const listId = Number(req.body.listId);
    const title = String(req.body.title || '').trim();
    const description = String(req.body.description || '').trim();
    const quantity = String(req.body.quantity || '').trim();
    const dueDate = req.body.dueDate ? String(req.body.dueDate) : null;
    const priority = String(req.body.priority || 'medium').trim().toLowerCase();
    if (!listId || !title) {
      res.status(400).json({ error: 'listId and title are required.' });
      return;
    }

    if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      res.status(400).json({ error: 'dueDate must be in YYYY-MM-DD format.' });
      return;
    }

    if (!['low', 'medium', 'high'].includes(priority)) {
      res.status(400).json({ error: 'priority must be low, medium, or high.' });
      return;
    }

    const task = await createTask({ workspaceId: req.workspaceId, userId: req.auth.userId, listId, title, description, quantity, dueDate, priority });
    if (!task) {
      res.status(404).json({ error: 'List not found.' });
      return;
    }

    broadcastToWorkspace(req.workspaceId, 'task.created', { taskId: task.id, listId });
    logAuditEvent({
      actorUserId: req.auth.userId,
      eventType: 'task.created',
      targetType: 'task',
      targetId: task.id,
      workspaceId: req.workspaceId,
      metadata: {
        listId,
        title: task.title,
        priority: task.priority
      }
    });
    res.status(201).json({ task });
  } catch (error) {
    sendError(res, error);
  }
});

app.patch('/api/tasks/:id', requireAuth, requireAppUser, requireWorkspace, async (req, res) => {
  try {
    const hasOwn = (key) => Object.prototype.hasOwnProperty.call(req.body, key);
    const titleProvided = hasOwn('title');
    const descriptionProvided = hasOwn('description');
    const dueDateProvided = hasOwn('dueDate');
    const priorityProvided = hasOwn('priority');
    const completedProvided = hasOwn('completed');

    const title = titleProvided ? String(req.body.title || '').trim() : undefined;
    const description = descriptionProvided ? String(req.body.description || '').trim() : undefined;
    const quantity = hasOwn('quantity') ? String(req.body.quantity || '').trim() : undefined;
    const dueDate = dueDateProvided ? (req.body.dueDate ? String(req.body.dueDate) : null) : undefined;
    const priority = priorityProvided ? String(req.body.priority || '').trim().toLowerCase() : undefined;
    const completed = completedProvided ? Boolean(req.body.completed) : undefined;

    if (!titleProvided && !descriptionProvided && !dueDateProvided && !priorityProvided && !completedProvided) {
      res.status(400).json({ error: 'No task changes were provided.' });
      return;
    }

    if (titleProvided && !title) {
      res.status(400).json({ error: 'title cannot be empty.' });
      return;
    }

    if (dueDateProvided && dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      res.status(400).json({ error: 'dueDate must be in YYYY-MM-DD format.' });
      return;
    }

    if (priorityProvided && !['low', 'medium', 'high'].includes(priority)) {
      res.status(400).json({ error: 'priority must be low, medium, or high.' });
      return;
    }

    const updated = await updateTask({
      workspaceId: req.workspaceId,
      userId: req.auth.userId,
      taskId: Number(req.params.id),
      titleProvided,
      title,
      descriptionProvided,
      description,
      quantityProvided: hasOwn('quantity'),
      quantity,
      dueDateProvided,
      dueDate,
      priorityProvided,
      priority,
      completedProvided,
      completed
    });

    if (!updated) {
      res.status(404).json({ error: 'Task not found.' });
      return;
    }

    broadcastToWorkspace(req.workspaceId, 'task.updated', { taskId: Number(req.params.id) });
    logAuditEvent({
      actorUserId: req.auth.userId,
      eventType: completedProvided
        ? (completed ? 'task.completed' : 'task.reopened')
        : 'task.updated',
      targetType: 'task',
      targetId: Number(req.params.id),
      workspaceId: req.workspaceId,
      metadata: {
        completedProvided,
        titleProvided,
        descriptionProvided,
        dueDateProvided,
        priorityProvided,
        quantityProvided: hasOwn('quantity')
      }
    });
    res.status(204).end();
  } catch (error) {
    sendError(res, error);
  }
});

app.delete('/api/tasks/:id', requireAuth, requireAppUser, requireWorkspace, async (req, res) => {
  try {
    const removed = await deleteTask({ workspaceId: req.workspaceId, taskId: Number(req.params.id) });
    if (!removed) {
      res.status(404).json({ error: 'Task not found.' });
      return;
    }

    broadcastToWorkspace(req.workspaceId, 'task.deleted', { taskId: Number(req.params.id) });
    logAuditEvent({
      actorUserId: req.auth.userId,
      eventType: 'task.deleted',
      targetType: 'task',
      targetId: Number(req.params.id),
      workspaceId: req.workspaceId
    });
    res.status(204).end();
  } catch (error) {
    sendError(res, error);
  }
});

app.use(express.static(clientDistPath));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDistPath, 'index.html'));
});

server.on('upgrade', async (request, socket, head) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const token = url.searchParams.get('token');
    const workspaceId = Number(url.searchParams.get('workspaceId'));
    if (!token || !workspaceId) {
      socket.destroy();
      return;
    }

    const auth = verifyAuthToken(token);
    const currentUser = await getAuthContext(auth.userId);
    if (!currentUser || currentUser.siteRole === 'SUPER_ADMIN') {
      socket.destroy();
      return;
    }

    const membership = await ensureMembership(auth.userId, workspaceId);
    if (!membership) {
      socket.destroy();
      return;
    }

    request.auth = auth;
    request.currentUser = currentUser;
    request.workspaceId = workspaceId;

    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.userId = Number(auth.userId);
      wss.emit('connection', ws, request);
    });
  } catch {
    socket.destroy();
  }
});

wss.on('connection', async (socket, request) => {
  attachSocketToWorkspace(request.workspaceId, socket);
  const snapshot = await getSnapshot({ userId: request.auth.userId, workspaceId: request.workspaceId });
  socket.send(JSON.stringify({ type: 'snapshot', data: snapshot }));
});

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  console.error('Unhandled promise rejection', error);
  logSystemEvent({
    level: 'error',
    source: 'process.unhandledRejection',
    message: error.message,
    stack: error.stack || ''
  });
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception', error);
  recordSystemErrorLog({
    level: 'fatal',
    source: 'process.uncaughtException',
    message: error.message || 'Uncaught exception.',
    stack: error.stack || ''
  })
    .catch((loggingError) => {
      logBackgroundFailure('Failed to persist uncaught exception', loggingError);
    })
    .finally(() => {
      process.exit(1);
    });
});

initDb()
  .then(() => {
    server.listen(port, () => {
      console.log(`Todo SaaS server listening on http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize database', error);
    process.exit(1);
  });
