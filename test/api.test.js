'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { getPool, ensureSchema, resetAll, waitForDb, close } = require('../src/db');
const { seed } = require('../src/seed');
const { createApp } = require('../src/app');

const app = createApp();

test.before(async () => { await waitForDb(); await ensureSchema(); getPool(); });
test.beforeEach(async () => { await resetAll(); await seed(); });
test.after(async () => { await close(); });

async function loginAs(u, p) {
  const res = await request(app).post('/api/auth/login').send({ username: u, password: p });
  assert.strictEqual(res.status, 200, `登录失败: ${JSON.stringify(res.body)}`);
  return res.body.data.token;
}

test('健康检查无需鉴权', async () => {
  const res = await request(app).get('/api/health');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'ok');
});

test('登录返回 token，中文姓名不乱码', async () => {
  const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin123' });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.data.token);
  assert.strictEqual(res.body.data.user.name, '系统管理员');
});

test('错误密码 401', async () => {
  const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'bad' });
  assert.strictEqual(res.status, 401);
});

test('未带令牌访问受保护接口 401', async () => {
  const res = await request(app).get('/api/canteens');
  assert.strictEqual(res.status, 401);
});

test('助餐点列表读到种子数据，中文正确', async () => {
  const token = await loginAs('viewer', 'viewer123');
  const res = await request(app).get('/api/canteens').set('Authorization', `Bearer ${token}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.length, 3);
  assert.ok(res.body.data.map((c) => c.name).includes('城关街道长者食堂'));
});

test('长者档案含中文忌口正确返回', async () => {
  const token = await loginAs('operator', 'operator123');
  const list = await request(app).get('/api/elders').set('Authorization', `Bearer ${token}`);
  assert.strictEqual(list.status, 200);
  const wang = list.body.data.find((e) => e.code === 'E-0001');
  assert.strictEqual(wang.name, '王秀英');
  assert.strictEqual(wang.dietary, '低盐、忌花生');
});

test('operator 新建长者并能查到（含中文）', async () => {
  const token = await loginAs('operator', 'operator123');
  const create = await request(app).post('/api/elders').set('Authorization', `Bearer ${token}`)
    .send({ code: 'E-9001', name: '孙桂芳', gender: 'F', age: 75, phone: '13900000000', subsidyLevel: 'B', dietary: '软烂、忌海鲜' });
  assert.strictEqual(create.status, 201, JSON.stringify(create.body));
  const id = create.body.data.id;
  const get = await request(app).get(`/api/elders/${id}`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(get.body.data.name, '孙桂芳');
  assert.strictEqual(get.body.data.dietary, '软烂、忌海鲜');
});

test('viewer 无权新建助餐点 403', async () => {
  const token = await loginAs('viewer', 'viewer123');
  const res = await request(app).post('/api/canteens').set('Authorization', `Bearer ${token}`)
    .send({ code: 'CT-X-001', name: '测试点', district: '某区' });
  assert.strictEqual(res.status, 403);
});

test('助餐点编号重复 409', async () => {
  const token = await loginAs('admin', 'admin123');
  const res = await request(app).post('/api/canteens').set('Authorization', `Bearer ${token}`)
    .send({ code: 'CT-CG-001', name: '重复', district: '某区' });
  assert.strictEqual(res.status, 409);
});

test('订餐：下单后核销，状态流转与重复核销拦截', async () => {
  const token = await loginAs('operator', 'operator123');
  const elders = (await request(app).get('/api/elders').set('Authorization', `Bearer ${token}`)).body.data;
  const meals = (await request(app).get('/api/meals').set('Authorization', `Bearer ${token}`)).body.data;
  const meal = meals.find((m) => m.status === 'PUBLISHED');
  const order = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
    .send({ elderId: elders[0].id, mealId: meal.id, diningType: 'DINE_IN', qty: 1 });
  assert.strictEqual(order.status, 201, JSON.stringify(order.body));
  assert.strictEqual(order.body.data.amountCents, meal.priceCents);
  const oid = order.body.data.id;

  const serve1 = await request(app).post(`/api/orders/${oid}/serve`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(serve1.status, 200);
  assert.strictEqual(serve1.body.data.status, 'SERVED');

  const serve2 = await request(app).post(`/api/orders/${oid}/serve`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(serve2.status, 409, '已核销不能重复核销');
});

test('删除助餐点需要 admin，operator 被拒 403', async () => {
  const token = await loginAs('operator', 'operator123');
  const list = (await request(app).get('/api/canteens').set('Authorization', `Bearer ${token}`)).body.data;
  const res = await request(app).delete(`/api/canteens/${list[0].id}`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(res.status, 403);
});

test('不存在的接口 404', async () => {
  const res = await request(app).get('/api/not-exist');
  assert.strictEqual(res.status, 404);
});
