'use strict';

const jwt = require('jsonwebtoken');
const store = require('./data/store');
const { verifyPassword } = require('./utils/password');
const { sendError } = require('./utils/http');

const JWT_SECRET = process.env.JWT_SECRET || 'elder-canteen-dev-secret';
const TOKEN_TTL = process.env.TOKEN_TTL || '8h';

async function login(username, password) {
  const raw = await store.getUserByUsername(username);
  if (!raw || raw.status !== 'ACTIVE') return null;
  if (!verifyPassword(password, raw.passwordHash)) return null;
  const user = await store.getUserById(raw.id);
  const token = jwt.sign({ sub: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: TOKEN_TTL });
  return { token, user };
}

async function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return sendError(res, 401, '缺少或非法的认证令牌');
  try {
    const payload = jwt.verify(m[1], JWT_SECRET);
    const user = await store.getUserById(payload.sub);
    if (!user || user.status !== 'ACTIVE') return sendError(res, 401, '用户不存在或已停用');
    req.user = user;
    return next();
  } catch (e) {
    return sendError(res, 401, '令牌无效或已过期');
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return sendError(res, 401, '未认证');
    if (!roles.includes(req.user.role)) return sendError(res, 403, '权限不足');
    return next();
  };
}

module.exports = { login, authRequired, requireRole, JWT_SECRET };
