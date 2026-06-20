'use strict';

const crypto = require('crypto');

/** scrypt 密码哈希，存储格式：scrypt$<saltHex>$<hashHex>。 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const derived = crypto.scryptSync(String(password), salt, expected.length);
  return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
}

module.exports = { hashPassword, verifyPassword };
