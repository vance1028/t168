'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { getPool, resetAll, waitForDb, close } = require('../src/db');
const { setupIsolatedDb, teardownIsolatedDb } = require('./helper');
const { seed } = require('../src/seed');
const store = require('../src/data/store');
const { createApp } = require('../src/app');

const app = createApp();
let dbName = null;

test.before(async () => {
  await waitForDb();
  dbName = await setupIsolatedDb();
  getPool();
});
test.beforeEach(async () => { await resetAll(); await seed(); });
test.after(async () => { await close(); if (dbName) await teardownIsolatedDb(dbName); });

async function loginAs(u, p) {
  const res = await request(app).post('/api/auth/login').send({ username: u, password: p });
  assert.strictEqual(res.status, 200, `登录失败: ${JSON.stringify(res.body)}`);
  return res.body.data.token;
}

async function ctx() {
  const canteens = await store.listCanteens({ status: 'OPEN' });
  const elders = await store.listElders();
  const meals = await store.listMeals({ status: 'PUBLISHED' });
  const lunch = meals.find((m) => m.mealType === 'LUNCH' && m.canteenId === canteens[0].id);
  return { canteen: canteens[0], elders, lunch };
}

async function makeSlot(token, overrides = {}) {
  const { canteen, lunch } = await ctx();
  const body = {
    canteenId: canteen.id, serveDate: lunch.serveDate, mealType: 'LUNCH',
    startTime: '11:00:00', endTime: '11:30:00', capacity: 2, ...overrides,
  };
  const res = await request(app).post('/api/slots').set('Authorization', `Bearer ${token}`).send(body);
  assert.strictEqual(res.status, 201, `建时段失败: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

async function order(token, body) {
  const res = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`).send(body);
  return res;
}

/* ============ 订餐接口：slotId + joinWaitlist ============ */

test('REST 订餐带 slotId：有空位 -> CONFIRMED', async () => {
  const token = await loginAs('admin', 'admin123');
  const { elders, lunch } = await ctx();
  const slot = await makeSlot(token, { capacity: 2 });

  const res = await order(token, { elderId: elders[0].id, mealId: lunch.id, slotId: slot.id });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.kind, 'CONFIRMED');
  assert.strictEqual(res.body.data.status, 'RESERVED');
  assert.ok(res.body.reservation.id > 0);
});

test('REST 订餐带 slotId：满 + joinWaitlist=false -> 409 SLOT_FULL', async () => {
  const token = await loginAs('admin', 'admin123');
  const { elders, lunch } = await ctx();
  const slot = await makeSlot(token, { capacity: 1 });

  await order(token, { elderId: elders[0].id, mealId: lunch.id, slotId: slot.id });
  const res = await order(token, { elderId: elders[1].id, mealId: lunch.id, slotId: slot.id, joinWaitlist: false });
  assert.strictEqual(res.status, 409);
});

test('REST 订餐带 slotId：满 + joinWaitlist=true -> WAITLIST 带 waitlistSeq', async () => {
  const token = await loginAs('admin', 'admin123');
  const { elders, lunch } = await ctx();
  const slot = await makeSlot(token, { capacity: 1 });

  await order(token, { elderId: elders[0].id, mealId: lunch.id, slotId: slot.id });
  const res = await order(token, { elderId: elders[1].id, mealId: lunch.id, slotId: slot.id, joinWaitlist: true });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.kind, 'WAITLIST');
  assert.strictEqual(res.body.waitlistSeq, 1);
});

test('REST 订餐不带 slotId：向后兼容基础下单', async () => {
  const token = await loginAs('admin', 'admin123');
  const { elders, lunch } = await ctx();
  const res = await order(token, { elderId: elders[0].id, mealId: lunch.id, qty: 1 });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.data.amountCents, lunch.priceCents);
  assert.strictEqual(res.body.kind, undefined, '无 slotId 时不返回 kind');
});

/* ============ 取消接口：释放名额 + 触发候补递补 ============ */

test('REST 取消正式预约：候补队头自动递补，返回 promoted', async () => {
  const token = await loginAs('admin', 'admin123');
  const { elders, lunch } = await ctx();
  const slot = await makeSlot(token, { capacity: 1 });

  const r1 = await order(token, { elderId: elders[0].id, mealId: lunch.id, slotId: slot.id });
  const w1 = await order(token, { elderId: elders[1].id, mealId: lunch.id, slotId: slot.id, joinWaitlist: true });

  const cancel = await request(app).post(`/api/orders/${r1.body.data.id}/cancel`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(cancel.status, 200);
  assert.strictEqual(cancel.body.data.status, 'CANCELLED');
  assert.strictEqual(cancel.body.promoted.length, 1);
  assert.strictEqual(cancel.body.promoted[0].elderId, elders[1].id);
  assert.strictEqual(cancel.body.promoted[0].kind, 'CONFIRMED');

  // 候补者已转正
  const got = await store.getReservationByOrderId(w1.body.data.id);
  assert.strictEqual(got.kind, 'CONFIRMED');
});

test('REST 取消候补者：不触发递补，promoted 为空', async () => {
  const token = await loginAs('admin', 'admin123');
  const { elders, lunch } = await ctx();
  const slot = await makeSlot(token, { capacity: 1 });

  await order(token, { elderId: elders[0].id, mealId: lunch.id, slotId: slot.id });
  const w = await order(token, { elderId: elders[1].id, mealId: lunch.id, slotId: slot.id, joinWaitlist: true });

  const cancel = await request(app).post(`/api/orders/${w.body.data.id}/cancel`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(cancel.status, 200);
  assert.strictEqual(cancel.body.promoted.length, 0);
});

test('REST 取消无时段订单：向后兼容，仅改状态', async () => {
  const token = await loginAs('admin', 'admin123');
  const { elders, lunch } = await ctx();
  const r = await order(token, { elderId: elders[0].id, mealId: lunch.id });
  const cancel = await request(app).post(`/api/orders/${r.body.data.id}/cancel`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(cancel.status, 200);
  assert.strictEqual(cancel.body.data.status, 'CANCELLED');
  assert.deepStrictEqual(cancel.body.promoted, []);
});

test('REST 取消已核销订单 -> 409', async () => {
  const token = await loginAs('admin', 'admin123');
  const { elders, lunch } = await ctx();
  const r = await order(token, { elderId: elders[0].id, mealId: lunch.id });
  await request(app).post(`/api/orders/${r.body.data.id}/serve`).set('Authorization', `Bearer ${token}`);
  const cancel = await request(app).post(`/api/orders/${r.body.data.id}/cancel`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(cancel.status, 409);
});

/* ============ 时段管理 ============ */

test('REST 时段 CRUD：建/查/列表/改', async () => {
  const token = await loginAs('admin', 'admin123');
  const { canteen, lunch } = await ctx();
  const slot = await makeSlot(token, { capacity: 5 });

  const list = await request(app).get('/api/slots').set('Authorization', `Bearer ${token}`)
    .query({ canteenId: canteen.id, serveDate: lunch.serveDate, mealType: 'LUNCH' });
  assert.strictEqual(list.status, 200);
  assert.ok(list.body.data.some((s) => s.id === slot.id));

  const one = await request(app).get(`/api/slots/${slot.id}`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(one.status, 200);
  assert.strictEqual(one.body.data.capacity, 5);

  const upd = await request(app).put(`/api/slots/${slot.id}`).set('Authorization', `Bearer ${token}`).send({ status: 'CLOSED' });
  assert.strictEqual(upd.status, 200);
  assert.strictEqual(upd.body.data.status, 'CLOSED');
});

test('REST POST /api/slots 校验：缺参 -> 400', async () => {
  const token = await loginAs('admin', 'admin123');
  const res = await request(app).post('/api/slots').set('Authorization', `Bearer ${token}`).send({ canteenId: 1 });
  assert.strictEqual(res.status, 400);
});

test('REST viewer 无权建时段 -> 403', async () => {
  const token = await loginAs('viewer', 'viewer123');
  const res = await request(app).post('/api/slots').set('Authorization', `Bearer ${token}`).send({});
  assert.strictEqual(res.status, 403);
});

/* ============ 容量调整 ============ */

test('REST resize 扩容：候补递补上来', async () => {
  const token = await loginAs('admin', 'admin123');
  const { elders, lunch } = await ctx();
  const slot = await makeSlot(token, { capacity: 1 });

  await order(token, { elderId: elders[0].id, mealId: lunch.id, slotId: slot.id });
  await order(token, { elderId: elders[1].id, mealId: lunch.id, slotId: slot.id, joinWaitlist: true });

  const res = await request(app).post(`/api/slots/${slot.id}/resize`).set('Authorization', `Bearer ${token}`).send({ capacity: 2 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.capacity, 2);
  assert.strictEqual(res.body.data.used, 2);
  assert.strictEqual(res.body.promoted.length, 1);
  assert.strictEqual(res.body.demoted.length, 0);
});

test('REST resize 缩容：超出的正式转候补', async () => {
  const token = await loginAs('admin', 'admin123');
  const { elders, lunch } = await ctx();
  const slot = await makeSlot(token, { capacity: 2 });

  await order(token, { elderId: elders[0].id, mealId: lunch.id, slotId: slot.id });
  await order(token, { elderId: elders[1].id, mealId: lunch.id, slotId: slot.id });

  const res = await request(app).post(`/api/slots/${slot.id}/resize`).set('Authorization', `Bearer ${token}`).send({ capacity: 1 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.used, 1);
  assert.strictEqual(res.body.demoted.length, 1);
  assert.strictEqual(res.body.promoted.length, 0);
});

test('REST resize 非法容量 -> 400', async () => {
  const token = await loginAs('admin', 'admin123');
  const slot = await makeSlot(token, { capacity: 2 });
  const res = await request(app).post(`/api/slots/${slot.id}/resize`).set('Authorization', `Bearer ${token}`).send({ capacity: -1 });
  assert.strictEqual(res.status, 400);
});

/* ============ 运营视图 / 错峰 / 冷热 ============ */

test('REST stats / recommend / heatmap 三类查询', async () => {
  const token = await loginAs('admin', 'admin123');
  const { canteen, elders, lunch } = await ctx();
  const s1 = await makeSlot(token, { startTime: '11:00:00', endTime: '11:30:00', capacity: 1 });
  const s2 = await makeSlot(token, { startTime: '12:30:00', endTime: '13:00:00', capacity: 2 });

  // s1 填满 + 候补，s2 留空
  await order(token, { elderId: elders[0].id, mealId: lunch.id, slotId: s1.id });
  await order(token, { elderId: elders[1].id, mealId: lunch.id, slotId: s1.id, joinWaitlist: true });

  const q = `canteenId=${canteen.id}&serveDate=${lunch.serveDate}&mealType=LUNCH`;

  const stats = await request(app).get(`/api/slots/stats?${q}`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(stats.status, 200);
  const s1Stats = stats.body.data.find((s) => s.id === s1.id);
  assert.strictEqual(s1Stats.waitlistCount, 1);
  assert.strictEqual(s1Stats.remaining, 0);

  const rec = await request(app).get(`/api/slots/recommend?${q}`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(rec.status, 200);
  assert.strictEqual(rec.body.data[0].id, s2.id, '空位多的时段排第一');

  const heat = await request(app).get(`/api/slots/heatmap?${q}`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(heat.status, 200);
  assert.strictEqual(heat.body.data.find((s) => s.id === s1.id).heat, 'HOT');
  assert.strictEqual(heat.body.data.find((s) => s.id === s2.id).heat, 'EMPTY');
});

/* ============ 预约列表 / 候补位置 ============ */

test('REST 预约列表 & 候补位置查询', async () => {
  const token = await loginAs('admin', 'admin123');
  const { elders, lunch } = await ctx();
  const slot = await makeSlot(token, { capacity: 1 });

  await order(token, { elderId: elders[0].id, mealId: lunch.id, slotId: slot.id });
  await order(token, { elderId: elders[1].id, mealId: lunch.id, slotId: slot.id, joinWaitlist: true });

  const resv = await request(app).get(`/api/slots/${slot.id}/reservations`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(resv.status, 200);
  assert.strictEqual(resv.body.data.length, 2);

  const pos = await request(app).get(`/api/slots/${slot.id}/waitlist-position`).set('Authorization', `Bearer ${token}`).query({ elderId: elders[1].id });
  assert.strictEqual(pos.status, 200);
  assert.strictEqual(pos.body.data.inWaitlist, true);
  assert.strictEqual(pos.body.data.waitlistSeq, 1);

  const posNone = await request(app).get(`/api/slots/${slot.id}/waitlist-position`).set('Authorization', `Bearer ${token}`).query({ elderId: elders[0].id });
  assert.strictEqual(posNone.body.data.inWaitlist, false);
  assert.strictEqual(posNone.body.data.waitlistSeq, null);
});

test('REST 候补位置缺 elderId -> 400', async () => {
  const token = await loginAs('admin', 'admin123');
  const slot = await makeSlot(token, { capacity: 1 });
  const res = await request(app).get(`/api/slots/${slot.id}/waitlist-position`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(res.status, 400);
});

test('REST 静态路径优先于 :id（stats/recommend/heatmap 不被当作 id）', async () => {
  const token = await loginAs('admin', 'admin123');
  for (const p of ['/api/slots/stats', '/api/slots/recommend', '/api/slots/heatmap']) {
    const res = await request(app).get(p).set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 200, `${p} 应返回 200 而非 404`);
    assert.ok(Array.isArray(res.body.data));
  }
});
