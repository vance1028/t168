'use strict';

const express = require('express');
const store = require('../data/store');
const { authRequired, requireRole } = require('../auth');
const { sendData, sendError, parseId } = require('../utils/http');

const router = express.Router();
router.use(authRequired);

router.get('/', async (req, res, next) => {
  try {
    const { canteenId, subsidyLevel, status, keyword } = req.query;
    const f = { subsidyLevel, status, keyword };
    if (canteenId !== undefined) f.canteenId = Number(canteenId);
    return sendData(res, 200, await store.listElders(f));
  } catch (e) { return next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const el = await store.getElderById(id);
    if (!el) return sendError(res, 404, '长者档案不存在');
    return sendData(res, 200, el);
  } catch (e) { return next(e); }
});

router.post('/', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const { code, name } = req.body || {};
    if (!code || !name) return sendError(res, 400, '编号和姓名不能为空');
    if (await store.getElderByCode(code)) return sendError(res, 409, '长者编号已存在');
    if (req.body.canteenId !== undefined && req.body.canteenId !== null && !(await store.getCanteenById(Number(req.body.canteenId)))) {
      return sendError(res, 400, '所属助餐点不存在');
    }
    return sendData(res, 201, await store.createElder(req.body));
  } catch (e) { return next(e); }
});

router.put('/:id', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!(await store.getElderById(id))) return sendError(res, 404, '长者档案不存在');
    return sendData(res, 200, await store.updateElder(id, req.body || {}));
  } catch (e) { return next(e); }
});

router.delete('/:id', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!(await store.getElderById(id))) return sendError(res, 404, '长者档案不存在');
    await store.deleteElder(id);
    return sendData(res, 200, { id });
  } catch (e) { return next(e); }
});

module.exports = router;
