'use strict';

const express = require('express');
const store = require('../data/store');
const { authRequired, requireRole } = require('../auth');
const { sendData, sendError, parseId } = require('../utils/http');

const router = express.Router();
const ROLES = ['ADMIN', 'OPERATOR', 'VIEWER'];

router.use(authRequired, requireRole('ADMIN'));

router.get('/', async (req, res, next) => { try { return sendData(res, 200, await store.listUsers()); } catch (e) { return next(e); } });

router.post('/', async (req, res, next) => {
  try {
    const { username, password, name, role = 'VIEWER' } = req.body || {};
    if (!username || !password || !name) return sendError(res, 400, '用户名、密码、姓名不能为空');
    if (!ROLES.includes(role)) return sendError(res, 400, '非法的角色');
    if (await store.getUserByUsername(username)) return sendError(res, 409, '用户名已存在');
    return sendData(res, 201, await store.createUser({ username, password, name, role }));
  } catch (e) { return next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!(await store.getUserById(id))) return sendError(res, 404, '用户不存在');
    if (req.body && req.body.role !== undefined && !ROLES.includes(req.body.role)) return sendError(res, 400, '非法的角色');
    return sendData(res, 200, await store.updateUser(id, req.body || {}));
  } catch (e) { return next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === req.user.id) return sendError(res, 400, '不能删除当前登录用户');
    if (!(await store.getUserById(id))) return sendError(res, 404, '用户不存在');
    await store.deleteUser(id);
    return sendData(res, 200, { id });
  } catch (e) { return next(e); }
});

module.exports = router;
