'use strict';

const { getPool } = require('../db');
const { hashPassword } = require('../utils/password');
const scheduler = require('./quota-scheduler');

/** 数据仓储层：SQL 集中此处，路由层只调用这些 async 方法，对外返回 camelCase。 */

/* ----------------------------- 映射 ----------------------------- */
function mapUser(r) {
  if (!r) return null;
  return { id: r.id, username: r.username, name: r.name, role: r.role, status: r.status, createdAt: r.created_at };
}
function mapUserWithHash(r) { return r ? { ...mapUser(r), passwordHash: r.password_hash } : null; }
function mapCanteen(r) {
  if (!r) return null;
  return { id: r.id, code: r.code, name: r.name, district: r.district, address: r.address, capacity: r.capacity, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
}
function mapElder(r) {
  if (!r) return null;
  return { id: r.id, code: r.code, name: r.name, gender: r.gender, age: r.age, phone: r.phone, subsidyLevel: r.subsidy_level, dietary: r.dietary, canteenId: r.canteen_id, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
}
function mapMeal(r) {
  if (!r) return null;
  return { id: r.id, canteenId: r.canteen_id, serveDate: r.serve_date, mealType: r.meal_type, dishName: r.dish_name, priceCents: r.price_cents, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
}
function mapOrder(r) {
  if (!r) return null;
  return { id: r.id, elderId: r.elder_id, mealId: r.meal_id, slotId: r.slot_id, diningType: r.dining_type, qty: r.qty, amountCents: r.amount_cents, subsidyCents: r.subsidy_cents, payCents: r.pay_cents, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
}
function mapTimeSlot(r) {
  if (!r) return null;
  return { id: r.id, canteenId: r.canteen_id, serveDate: r.serve_date, mealType: r.meal_type, startTime: r.start_time, endTime: r.end_time, capacity: r.capacity, used: r.used, version: r.version, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
}
function mapReservation(r) {
  if (!r) return null;
  return { id: r.id, orderId: r.order_id, elderId: r.elder_id, slotId: r.slot_id, kind: r.kind, waitlistSeq: r.waitlist_seq, status: r.status, promotedAt: r.promoted_at, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at };
}

/* ----------------------------- 用户 ----------------------------- */
async function getUserByUsername(u) { const [r] = await getPool().query('SELECT * FROM users WHERE username=?', [u]); return mapUserWithHash(r[0]); }
async function getUserById(id) { const [r] = await getPool().query('SELECT * FROM users WHERE id=?', [id]); return mapUser(r[0]); }
async function listUsers() { const [r] = await getPool().query('SELECT * FROM users ORDER BY id'); return r.map(mapUser); }
async function createUser({ username, password, name, role = 'VIEWER', status = 'ACTIVE' }) {
  const [x] = await getPool().query('INSERT INTO users (username,password_hash,name,role,status) VALUES (?,?,?,?,?)', [username, hashPassword(password), name, role, status]);
  return getUserById(x.insertId);
}
async function updateUser(id, f) {
  const sets = []; const p = [];
  for (const [k, col] of Object.entries({ name: 'name', role: 'role', status: 'status' })) if (f[k] !== undefined) { sets.push(`${col}=?`); p.push(f[k]); }
  if (f.password !== undefined) { sets.push('password_hash=?'); p.push(hashPassword(f.password)); }
  if (sets.length) { p.push(id); await getPool().query(`UPDATE users SET ${sets.join(',')} WHERE id=?`, p); }
  return getUserById(id);
}
async function deleteUser(id) { const [x] = await getPool().query('DELETE FROM users WHERE id=?', [id]); return x.affectedRows > 0; }
async function countUsers() { const [r] = await getPool().query('SELECT COUNT(*) AS n FROM users'); return r[0].n; }

/* ----------------------------- 助餐点 ----------------------------- */
async function listCanteens({ district, status, keyword } = {}) {
  const w = []; const p = [];
  if (district) { w.push('district=?'); p.push(district); }
  if (status) { w.push('status=?'); p.push(status); }
  if (keyword) { w.push('(code LIKE ? OR name LIKE ?)'); const k = `%${keyword}%`; p.push(k, k); }
  const c = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const [r] = await getPool().query(`SELECT * FROM canteens ${c} ORDER BY id DESC`, p); return r.map(mapCanteen);
}
async function getCanteenById(id) { const [r] = await getPool().query('SELECT * FROM canteens WHERE id=?', [id]); return mapCanteen(r[0]); }
async function getCanteenByCode(code) { const [r] = await getPool().query('SELECT * FROM canteens WHERE code=?', [code]); return mapCanteen(r[0]); }
async function createCanteen(d) {
  const [x] = await getPool().query('INSERT INTO canteens (code,name,district,address,capacity,status) VALUES (?,?,?,?,?,?)', [d.code, d.name, d.district, d.address || '', d.capacity || 0, d.status || 'OPEN']);
  return getCanteenById(x.insertId);
}
async function updateCanteen(id, d) {
  const sets = []; const p = [];
  for (const [k, col] of Object.entries({ name: 'name', district: 'district', address: 'address', capacity: 'capacity', status: 'status' })) if (d[k] !== undefined) { sets.push(`${col}=?`); p.push(d[k]); }
  if (sets.length) { sets.push('updated_at=CURRENT_TIMESTAMP(3)'); p.push(id); await getPool().query(`UPDATE canteens SET ${sets.join(',')} WHERE id=?`, p); }
  return getCanteenById(id);
}
async function deleteCanteen(id) { const [x] = await getPool().query('DELETE FROM canteens WHERE id=?', [id]); return x.affectedRows > 0; }

/* ----------------------------- 长者 ----------------------------- */
async function listElders({ canteenId, subsidyLevel, status, keyword } = {}) {
  const w = []; const p = [];
  if (canteenId !== undefined) { w.push('canteen_id=?'); p.push(canteenId); }
  if (subsidyLevel) { w.push('subsidy_level=?'); p.push(subsidyLevel); }
  if (status) { w.push('status=?'); p.push(status); }
  if (keyword) { w.push('(code LIKE ? OR name LIKE ? OR phone LIKE ?)'); const k = `%${keyword}%`; p.push(k, k, k); }
  const c = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const [r] = await getPool().query(`SELECT * FROM elders ${c} ORDER BY id DESC`, p); return r.map(mapElder);
}
async function getElderById(id) { const [r] = await getPool().query('SELECT * FROM elders WHERE id=?', [id]); return mapElder(r[0]); }
async function getElderByCode(code) { const [r] = await getPool().query('SELECT * FROM elders WHERE code=?', [code]); return mapElder(r[0]); }
async function createElder(d) {
  const [x] = await getPool().query('INSERT INTO elders (code,name,gender,age,phone,subsidy_level,dietary,canteen_id,status) VALUES (?,?,?,?,?,?,?,?,?)',
    [d.code, d.name, d.gender || 'U', d.age || 0, d.phone || '', d.subsidyLevel || 'C', d.dietary || '', d.canteenId ?? null, d.status || 'ACTIVE']);
  return getElderById(x.insertId);
}
async function updateElder(id, d) {
  const map = { name: 'name', gender: 'gender', age: 'age', phone: 'phone', subsidyLevel: 'subsidy_level', dietary: 'dietary', canteenId: 'canteen_id', status: 'status' };
  const sets = []; const p = [];
  for (const [k, col] of Object.entries(map)) if (d[k] !== undefined) { sets.push(`${col}=?`); p.push(d[k]); }
  if (sets.length) { sets.push('updated_at=CURRENT_TIMESTAMP(3)'); p.push(id); await getPool().query(`UPDATE elders SET ${sets.join(',')} WHERE id=?`, p); }
  return getElderById(id);
}
async function deleteElder(id) { const [x] = await getPool().query('DELETE FROM elders WHERE id=?', [id]); return x.affectedRows > 0; }

/* ----------------------------- 餐次 ----------------------------- */
async function listMeals({ canteenId, serveDate, mealType, status } = {}) {
  const w = []; const p = [];
  if (canteenId !== undefined) { w.push('canteen_id=?'); p.push(canteenId); }
  if (serveDate) { w.push('serve_date=?'); p.push(serveDate); }
  if (mealType) { w.push('meal_type=?'); p.push(mealType); }
  if (status) { w.push('status=?'); p.push(status); }
  const c = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const [r] = await getPool().query(`SELECT * FROM meals ${c} ORDER BY serve_date DESC, id DESC`, p); return r.map(mapMeal);
}
async function getMealById(id) { const [r] = await getPool().query('SELECT * FROM meals WHERE id=?', [id]); return mapMeal(r[0]); }
async function createMeal(d) {
  const [x] = await getPool().query('INSERT INTO meals (canteen_id,serve_date,meal_type,dish_name,price_cents,status) VALUES (?,?,?,?,?,?)',
    [d.canteenId, d.serveDate, d.mealType || 'LUNCH', d.dishName, d.priceCents || 0, d.status || 'PUBLISHED']);
  return getMealById(x.insertId);
}
async function updateMeal(id, d) {
  const map = { serveDate: 'serve_date', mealType: 'meal_type', dishName: 'dish_name', priceCents: 'price_cents', status: 'status' };
  const sets = []; const p = [];
  for (const [k, col] of Object.entries(map)) if (d[k] !== undefined) { sets.push(`${col}=?`); p.push(d[k]); }
  if (sets.length) { sets.push('updated_at=CURRENT_TIMESTAMP(3)'); p.push(id); await getPool().query(`UPDATE meals SET ${sets.join(',')} WHERE id=?`, p); }
  return getMealById(id);
}
async function deleteMeal(id) { const [x] = await getPool().query('DELETE FROM meals WHERE id=?', [id]); return x.affectedRows > 0; }

/* ----------------------------- 订餐 ----------------------------- */
async function listOrders({ elderId, mealId, status } = {}) {
  const w = []; const p = [];
  if (elderId !== undefined) { w.push('elder_id=?'); p.push(elderId); }
  if (mealId !== undefined) { w.push('meal_id=?'); p.push(mealId); }
  if (status) { w.push('status=?'); p.push(status); }
  const c = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const [r] = await getPool().query(`SELECT * FROM orders ${c} ORDER BY id DESC`, p); return r.map(mapOrder);
}
async function getOrderById(id) { const [r] = await getPool().query('SELECT * FROM orders WHERE id=?', [id]); return mapOrder(r[0]); }
async function createOrder(d) {
  const cols = ['elder_id', 'meal_id', 'dining_type', 'qty', 'amount_cents', 'subsidy_cents', 'pay_cents', 'status'];
  const vals = [d.elderId, d.mealId, d.diningType || 'DINE_IN', d.qty || 1, d.amountCents || 0, d.subsidyCents || 0, d.payCents || 0, d.status || 'RESERVED'];
  if (d.slotId !== undefined && d.slotId !== null) { cols.push('slot_id'); vals.push(d.slotId); }
  const [x] = await getPool().query(
    `INSERT INTO orders (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    vals,
  );
  return getOrderById(x.insertId);
}
async function updateOrder(id, d) {
  const map = { slotId: 'slot_id', diningType: 'dining_type', qty: 'qty', amountCents: 'amount_cents', subsidyCents: 'subsidy_cents', payCents: 'pay_cents', status: 'status' };
  const sets = []; const p = [];
  for (const [k, col] of Object.entries(map)) if (d[k] !== undefined) { sets.push(`${col}=?`); p.push(d[k]); }
  if (sets.length) { sets.push('updated_at=CURRENT_TIMESTAMP(3)'); p.push(id); await getPool().query(`UPDATE orders SET ${sets.join(',')} WHERE id=?`, p); }
  return getOrderById(id);
}

/* ----------------------------- 时段配额（time_slots） ----------------------------- */
async function listTimeSlots({ canteenId, serveDate, mealType, status } = {}) {
  const w = []; const p = [];
  if (canteenId !== undefined) { w.push('canteen_id=?'); p.push(canteenId); }
  if (serveDate) { w.push('serve_date=?'); p.push(serveDate); }
  if (mealType) { w.push('meal_type=?'); p.push(mealType); }
  if (status) { w.push('status=?'); p.push(status); }
  const c = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const [r] = await getPool().query(`SELECT * FROM time_slots ${c} ORDER BY serve_date ASC, start_time ASC`, p);
  return r.map(mapTimeSlot);
}
async function getTimeSlotById(id) {
  const [r] = await getPool().query('SELECT * FROM time_slots WHERE id=?', [id]);
  return mapTimeSlot(r[0]);
}
async function createTimeSlot(d) {
  const [x] = await getPool().query(
    `INSERT INTO time_slots (canteen_id,serve_date,meal_type,start_time,end_time,capacity,status) VALUES (?,?,?,?,?,?,?)`,
    [d.canteenId, d.serveDate, d.mealType || 'LUNCH', d.startTime, d.endTime, d.capacity || 0, d.status || 'ACTIVE'],
  );
  return getTimeSlotById(x.insertId);
}
async function updateTimeSlot(id, d) {
  const map = { startTime: 'start_time', endTime: 'end_time', status: 'status' };
  const sets = []; const p = [];
  for (const [k, col] of Object.entries(map)) if (d[k] !== undefined) { sets.push(`${col}=?`); p.push(d[k]); }
  if (sets.length) { sets.push('updated_at=CURRENT_TIMESTAMP(3)'); p.push(id); await getPool().query(`UPDATE time_slots SET ${sets.join(',')} WHERE id=?`, p); }
  return getTimeSlotById(id);
}

/**
 * 调整时段容量（带事务 + 调度，处理超额/候补递补）。
 * 返回 { slot, demoted: [], promoted: [] }
 */
async function updateTimeSlotCapacity(slotId, newCapacity) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await scheduler.resizeCapacity(conn, slotId, newCapacity);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * 带统计信息的时段列表（含候补人数），供运营视图和推荐用。
 * 返回字段中额外包含 waitlistCount、remaining、fillRatio。
 */
async function listTimeSlotsWithStats({ canteenId, serveDate, mealType, status } = {}) {
  const slots = await listTimeSlots({ canteenId, serveDate, mealType, status });
  if (!slots.length) return slots;
  const ids = slots.map(s => s.id);
  const placeholders = ids.map(() => '?').join(',');

  const [[confirmedRows], [waitlistRows]] = await Promise.all([
    getPool().query(
      `SELECT slot_id, COUNT(*) AS n FROM reservations
        WHERE slot_id IN (${placeholders}) AND kind='CONFIRMED' AND status IN ('ACTIVE','PROMOTED')
        GROUP BY slot_id`,
      ids,
    ),
    getPool().query(
      `SELECT slot_id, COUNT(*) AS n FROM reservations
        WHERE slot_id IN (${placeholders}) AND kind='WAITLIST' AND status='ACTIVE'
        GROUP BY slot_id`,
      ids,
    ),
  ]);
  const confirmedMap = Object.fromEntries(confirmedRows.map(r => [r.slot_id, Number(r.n)]));
  const waitlistMap = Object.fromEntries(waitlistRows.map(r => [r.slot_id, Number(r.n)]));

  return slots.map((s) => {
    const confirmed = confirmedMap[s.id] || 0;
    const waitlistCount = waitlistMap[s.id] || 0;
    const remaining = Math.max(0, s.capacity - confirmed);
    const fillRatio = s.capacity > 0 ? confirmed / s.capacity : 0;
    return {
      ...s,
      used: confirmed,
      waitlistCount,
      remaining,
      fillRatio: Number(fillRatio.toFixed(4)),
    };
  });
}

/* ----------------------------- 预约 / 候补（reservations） ----------------------------- */
async function listReservations({ slotId, elderId, kind, status } = {}) {
  const w = []; const p = [];
  if (slotId !== undefined) { w.push('slot_id=?'); p.push(slotId); }
  if (elderId !== undefined) { w.push('elder_id=?'); p.push(elderId); }
  if (kind) { w.push('kind=?'); p.push(kind); }
  if (status) { w.push('status=?'); p.push(status); }
  const c = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const [r] = await getPool().query(
    `SELECT * FROM reservations ${c} ORDER BY
       CASE WHEN kind='WAITLIST' THEN waitlist_seq ELSE id END ASC, id ASC`,
    p,
  );
  return r.map(mapReservation);
}
async function getReservationByOrderId(orderId) {
  const [r] = await getPool().query('SELECT * FROM reservations WHERE order_id=?', [orderId]);
  return mapReservation(r[0]);
}
async function getReservationById(id) {
  const [r] = await getPool().query('SELECT * FROM reservations WHERE id=?', [id]);
  return mapReservation(r[0]);
}

/* ----------------------------- 集成：订餐 + 时段预约 ----------------------------- */

/**
 * 订餐并锁定时段（事务原子操作）。
 *   - 若 slot 还有空 -> reservation.kind = CONFIRMED，used += 1
 *   - 若 slot 已满且 opt.joinWaitlist = true -> reservation.kind = WAITLIST，获取 waitlistSeq
 *   - 否则抛出 scheduler.SlotError(code = SLOT_FULL)
 * 返回 { order, reservation, kind: 'CONFIRMED' | 'WAITLIST', waitlistSeq? }
 */
async function createOrderWithSlot({ elderId, mealId, slotId, diningType = 'DINE_IN', qty = 1, joinWaitlist = false }) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();

    const meal = (await conn.query('SELECT * FROM meals WHERE id=?', [mealId]))[0][0];
    if (!meal) throw new scheduler.SlotError('MEAL_NOT_FOUND', '餐次不存在');
    if (meal.status !== 'PUBLISHED') throw new scheduler.SlotError('MEAL_UNAVAILABLE', '该餐次未开放订餐');

    const slot = (await conn.query('SELECT * FROM time_slots WHERE id=?', [slotId]))[0][0];
    if (!slot) throw new scheduler.SlotError(scheduler.errors.SLOT_NOT_FOUND, '时段不存在');
    if (slot.status !== 'ACTIVE') throw new scheduler.SlotError(scheduler.errors.SLOT_INACTIVE, '时段未开放');

    const amount = meal.price_cents * (Number(qty) || 1);
    const [orderIns] = await conn.query(
      `INSERT INTO orders (elder_id,meal_id,slot_id,dining_type,qty,amount_cents,subsidy_cents,pay_cents,status)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [elderId, mealId, slotId, diningType, Number(qty) || 1, amount, 0, amount, 'RESERVED'],
    );
    const orderId = orderIns.insertId;

    let kind = 'CONFIRMED';
    let waitlistSeq = null;
    try {
      await scheduler.tryConfirmSlot(conn, slotId);
      await conn.query(
        `INSERT INTO reservations (order_id,elder_id,slot_id,kind,status) VALUES (?,?,?,'CONFIRMED','ACTIVE')`,
        [orderId, elderId, slotId],
      );
    } catch (e) {
      if (e && e.code === scheduler.errors.SLOT_FULL && joinWaitlist) {
        const enq = await scheduler.enqueueWaitlist(conn, slotId, { orderId, elderId });
        kind = 'WAITLIST';
        waitlistSeq = enq.waitlistSeq;
      } else {
        throw e;
      }
    }

    await conn.commit();
    const [orderRows] = await getPool().query('SELECT * FROM orders WHERE id=?', [orderId]);
    const [resvRows] = await getPool().query('SELECT * FROM reservations WHERE order_id=?', [orderId]);
    const result = { order: mapOrder(orderRows[0]), reservation: mapReservation(resvRows[0]), kind };
    if (waitlistSeq !== null) result.waitlistSeq = waitlistSeq;
    return result;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * 取消订餐 + 释放名额 + 自动递补候补（事务原子）。
 * 返回 { order, promoted: [...] }，promoted 为被递补的 reservation 列表（供发通知用）。
 */
async function cancelOrderWithSlot(orderId) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();

    const [orderRows] = await conn.query('SELECT * FROM orders WHERE id=? FOR UPDATE', [orderId]);
    if (!orderRows.length) throw new scheduler.SlotError('ORDER_NOT_FOUND', '订餐不存在');
    const order = orderRows[0];
    if (order.status === 'SERVED') throw new scheduler.SlotError('ORDER_SERVED', '已核销的订餐不能取消');

    const [resvRows] = await conn.query('SELECT * FROM reservations WHERE order_id=? FOR UPDATE', [orderId]);
    const resv = resvRows[0];

    let promoted = [];
    if (resv) {
      if (resv.kind === 'CONFIRMED' && resv.status !== 'CANCELLED') {
        const result = await scheduler.releaseSlotAndPromote(conn, resv.slot_id, resv.id);
        promoted = result.promoted;
      } else if (resv.kind === 'WAITLIST' && resv.status === 'ACTIVE') {
        await conn.query(
          `UPDATE reservations SET status='CANCELLED', updated_at=CURRENT_TIMESTAMP(3) WHERE id=?`,
          [resv.id],
        );
      }
    }

    await conn.query(
      `UPDATE orders SET status='CANCELLED', updated_at=CURRENT_TIMESTAMP(3) WHERE id=?`,
      [orderId],
    );
    await conn.commit();

    const [finalOrder] = await getPool().query('SELECT * FROM orders WHERE id=?', [orderId]);
    return { order: mapOrder(finalOrder[0]), promoted };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/* ----------------------------- 错峰推荐 & 冷热分布 ----------------------------- */

/**
 * 错峰推荐：给同助餐点同日同餐别的所有时段按空闲程度排序。
 * 调用方直接在前端展示给老人，引导选空闲时段。
 */
async function recommendOffPeakSlots({ canteenId, serveDate, mealType }) {
  const slots = await listTimeSlotsWithStats({ canteenId, serveDate, mealType, status: 'ACTIVE' });
  return scheduler.recommendOffPeak(slots);
}

/**
 * 运营视图：时段冷热分布（EMPTY / COOL / WARM / HOT）。
 */
async function getSlotsHeatMap({ canteenId, serveDate, mealType }) {
  const slots = await listTimeSlotsWithStats({ canteenId, serveDate, mealType });
  return scheduler.classifyHeat(slots);
}

/* ----------------------------- 候补状态查询 ----------------------------- */

/**
 * 查某长者在某时段的候补位置（若不在候补中则返回 null）。
 */
async function getElderWaitlistPosition(slotId, elderId) {
  const [r] = await getPool().query(
    `SELECT waitlist_seq FROM reservations
      WHERE slot_id=? AND elder_id=? AND kind='WAITLIST' AND status='ACTIVE'
      LIMIT 1`,
    [slotId, elderId],
  );
  if (!r.length) return null;
  return Number(r[0].waitlist_seq);
}

module.exports = {
  mapUser, mapCanteen, mapElder, mapMeal, mapOrder, mapTimeSlot, mapReservation,
  getUserByUsername, getUserById, listUsers, createUser, updateUser, deleteUser, countUsers,
  listCanteens, getCanteenById, getCanteenByCode, createCanteen, updateCanteen, deleteCanteen,
  listElders, getElderById, getElderByCode, createElder, updateElder, deleteElder,
  listMeals, getMealById, createMeal, updateMeal, deleteMeal,
  listOrders, getOrderById, createOrder, updateOrder,
  listTimeSlots, getTimeSlotById, createTimeSlot, updateTimeSlot, updateTimeSlotCapacity, listTimeSlotsWithStats,
  listReservations, getReservationByOrderId, getReservationById,
  createOrderWithSlot, cancelOrderWithSlot,
  recommendOffPeakSlots, getSlotsHeatMap,
  getElderWaitlistPosition,
  scheduler,
  SchedulerError: scheduler.SlotError,
};
