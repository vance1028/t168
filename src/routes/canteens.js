'use strict';

const express = require('express');
const store = require('../data/store');
const { authRequired, requireRole } = require('../auth');
const { sendData, sendError, parseId } = require('../utils/http');

const router = express.Router();
router.use(authRequired);

router.get('/', async (req, res, next) => {
  try {
    const { district, status, keyword } = req.query;
    return sendData(res, 200, await store.listCanteens({ district, status, keyword }));
  } catch (e) { return next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const c = await store.getCanteenById(id);
    if (!c) return sendError(res, 404, '助餐点不存在');
    return sendData(res, 200, c);
  } catch (e) { return next(e); }
});

router.get('/:id/elders', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!(await store.getCanteenById(id))) return sendError(res, 404, '助餐点不存在');
    return sendData(res, 200, await store.listElders({ canteenId: id }));
  } catch (e) { return next(e); }
});

router.post('/', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const { code, name, district } = req.body || {};
    if (!code || !name || !district) return sendError(res, 400, '编号、名称、区域不能为空');
    if (await store.getCanteenByCode(code)) return sendError(res, 409, '助餐点编号已存在');
    return sendData(res, 201, await store.createCanteen(req.body));
  } catch (e) { return next(e); }
});

router.put('/:id', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!(await store.getCanteenById(id))) return sendError(res, 404, '助餐点不存在');
    return sendData(res, 200, await store.updateCanteen(id, req.body || {}));
  } catch (e) { return next(e); }
});

router.delete('/:id', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!(await store.getCanteenById(id))) return sendError(res, 404, '助餐点不存在');
    await store.deleteCanteen(id);
    return sendData(res, 200, { id });
  } catch (e) { return next(e); }
});

module.exports = router;
