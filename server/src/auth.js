import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

const TOKEN_TTL = '7d';
const SCRYPT_KEYLEN = 64;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-jwt-secret';

export function issueAuthToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

export function verifyAuthToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt);
  return `${salt}:${hash}`;
}

export async function verifyPassword(password, storedValue) {
  const [salt, storedHash] = String(storedValue || '').split(':');
  if (!salt || !storedHash) return false;

  const candidate = await scrypt(password, salt);
  return crypto.timingSafeEqual(Buffer.from(storedHash, 'hex'), Buffer.from(candidate, 'hex'));
}

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(derivedKey.toString('hex'));
    });
  });
}
