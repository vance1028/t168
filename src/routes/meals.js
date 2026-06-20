'use strict';

const express = require('express');
const store = require('../data/store');
const { authRequired, requireRole } = require('../auth');
const { sendData, sendError, parseId } = require('../utils/http');

const router = express.Router();
router.use(authRequired);

router.get('/', async (req, res, next) => {
  try {
    const { canteenId, serveDate, mealType, status } = req.query;
    const f = { serveDate, mealType, status };
    if (canteenId !== undefined) f.canteenId = Number(canteenId);
    return sendData(res, 200, await store.listMeals(f));
  } catch (e) { return next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const m = await store.getMealById(id);
    if (!m) return sendError(res, 404, '餐次不存在');
    return sendData(res, 200, m);
  } catch (e) { return next(e); }
});

router.post('/', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const { canteenId, serveDate, dishName } = req.body || {};
    if (canteenId === undefined || !serveDate || !dishName) return sendError(res, 400, '助餐点、供应日期、菜品名不能为空');
    if (!(await store.getCanteenById(Number(canteenId)))) return sendError(res, 400, '助餐点不存在');
    return sendData(res, 201, await store.createMeal({ ...req.body, canteenId: Number(canteenId) }));
  } catch (e) { return next(e); }
});

router.put('/:id', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!(await store.getMealById(id))) return sendError(res, 404, '餐次不存在');
    return sendData(res, 200, await store.updateMeal(id, req.body || {}));
  } catch (e) { return next(e); }
});

router.delete('/:id', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!(await store.getMealById(id))) return sendError(res, 404, '餐次不存在');
    await store.deleteMeal(id);
    return sendData(res, 200, { id });
  } catch (e) { return next(e); }
});

module.exports = router;
