'use strict';

const express = require('express');
const store = require('../data/store');
const { authRequired, requireRole } = require('../auth');
const { sendData, sendError, parseId } = require('../utils/http');

const router = express.Router();
router.use(authRequired);

/* 解析查询参数为数字（空串视为未传）。 */
function num(v) { return v === undefined || v === '' ? undefined : Number(v); }

/* ---------- 查询类（静态路径置于 :id 之前避免被捕获） ---------- */

/** GET /api/slots —— 时段配额列表（运营管理）。 */
router.get('/', async (req, res, next) => {
  try {
    const { status } = req.query;
    const f = { status };
    const canteenId = num(req.query.canteenId);
    if (canteenId !== undefined) f.canteenId = canteenId;
    if (req.query.serveDate) f.serveDate = req.query.serveDate;
    if (req.query.mealType) f.mealType = req.query.mealType;
    return sendData(res, 200, await store.listTimeSlots(f));
  } catch (e) { return next(e); }
});

/** GET /api/slots/stats —— 运营实时余量视图（含已用、剩余、候补数、填充率）。 */
router.get('/stats', async (req, res, next) => {
  try {
    const f = {};
    const canteenId = num(req.query.canteenId);
    if (canteenId !== undefined) f.canteenId = canteenId;
    if (req.query.serveDate) f.serveDate = req.query.serveDate;
    if (req.query.mealType) f.mealType = req.query.mealType;
    return sendData(res, 200, await store.listTimeSlotsWithStats(f));
  } catch (e) { return next(e); }
});

/** GET /api/slots/recommend —— 错峰推荐（按空闲程度排序，给老人推荐避开高峰的时段）。 */
router.get('/recommend', async (req, res, next) => {
  try {
    const f = {};
    const canteenId = num(req.query.canteenId);
    if (canteenId !== undefined) f.canteenId = canteenId;
    if (req.query.serveDate) f.serveDate = req.query.serveDate;
    if (req.query.mealType) f.mealType = req.query.mealType;
    return sendData(res, 200, await store.recommendOffPeakSlots(f));
  } catch (e) { return next(e); }
});

/** GET /api/slots/heatmap —— 时段冷热分布（EMPTY/COOL/WARM/HOT）。 */
router.get('/heatmap', async (req, res, next) => {
  try {
    const f = {};
    const canteenId = num(req.query.canteenId);
    if (canteenId !== undefined) f.canteenId = canteenId;
    if (req.query.serveDate) f.serveDate = req.query.serveDate;
    if (req.query.mealType) f.mealType = req.query.mealType;
    return sendData(res, 200, await store.getSlotsHeatMap(f));
  } catch (e) { return next(e); }
});

/* ---------- 单个时段 ---------- */

/** GET /api/slots/:id —— 时段详情。 */
router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const s = await store.getTimeSlotById(id);
    if (!s) return sendError(res, 404, '时段不存在');
    return sendData(res, 200, s);
  } catch (e) { return next(e); }
});

/** GET /api/slots/:id/reservations —— 该时段的预约/候补列表。 */
router.get('/:id/reservations', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!(await store.getTimeSlotById(id))) return sendError(res, 404, '时段不存在');
    const f = { slotId: id };
    if (req.query.kind) f.kind = req.query.kind;
    if (req.query.status) f.status = req.query.status;
    return sendData(res, 200, await store.listReservations(f));
  } catch (e) { return next(e); }
});

/** GET /api/slots/:id/waitlist-position?elderId=xxx —— 某长者在此时段的候补排队位置。 */
router.get('/:id/waitlist-position', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const elderId = num(req.query.elderId);
    if (elderId === undefined) return sendError(res, 400, '缺少 elderId 参数');
    if (!(await store.getTimeSlotById(id))) return sendError(res, 404, '时段不存在');
    const seq = await store.getElderWaitlistPosition(id, elderId);
    return sendData(res, 200, { slotId: id, elderId, waitlistSeq: seq, inWaitlist: seq !== null });
  } catch (e) { return next(e); }
});

/* ---------- 写操作（运营/管理员） ---------- */

/** POST /api/slots —— 新建一个时段配额（如午餐切出 11:00/11:30/12:00 若干档）。 */
router.post('/', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const { canteenId, serveDate, mealType, startTime, endTime, capacity, status } = req.body || {};
    if (canteenId === undefined || !serveDate || !startTime || !endTime) {
      return sendError(res, 400, '助餐点、日期、起止时间不能为空');
    }
    if (!(await store.getCanteenById(Number(canteenId)))) return sendError(res, 400, '助餐点不存在');
    return sendData(res, 201, await store.createTimeSlot({
      canteenId: Number(canteenId), serveDate, mealType: mealType || 'LUNCH',
      startTime, endTime, capacity: capacity === undefined ? 0 : Number(capacity), status,
    }));
  } catch (e) { return next(e); }
});

/** PUT /api/slots/:id —— 修改时段基础信息（起止时间、开放状态，不含容量）。 */
router.put('/:id', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!(await store.getTimeSlotById(id))) return sendError(res, 404, '时段不存在');
    return sendData(res, 200, await store.updateTimeSlot(id, req.body || {}));
  } catch (e) { return next(e); }
});

/** POST /api/slots/:id/resize —— 调整容量（临时加座/减座）。
 *  body: { capacity }。扩容会自动从候补递补；缩容会把超出的正式预约（按创建晚优先）转为候补。
 *  返回 { slot, demoted, promoted }。
 */
router.post('/:id/resize', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const capacity = Number((req.body || {}).capacity);
    if (!Number.isInteger(capacity) || capacity < 0) {
      return sendError(res, 400, '容量必须为非负整数');
    }
    const result = await store.updateTimeSlotCapacity(id, capacity);
    return sendData(res, 200, result.slot, { demoted: result.demoted, promoted: result.promoted });
  } catch (e) { return next(e); }
});

module.exports = router;
