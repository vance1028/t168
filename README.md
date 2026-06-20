# 社区长者助餐运营管理平台 - 后端 API

纯后端 REST API 服务，管理社区助餐点、长者档案、餐次与订餐，含登录鉴权与基于角色的权限控制。
作为「功能迭代」类评测题目的基础工程：Node + Express + MySQL，docker compose 一键编排，结构清晰、留有充分扩展点（分级补贴结算、营养餐与忌口校验、送餐排线、刷卡核销、健康预警等可在此长出来）。

## 技术栈

- Node.js (≥ 18) + Express 4
- MySQL 8（`mysql2/promise` 连接池，全程 utf8mb4）
- JWT（`jsonwebtoken`）+ scrypt 密码哈希
- Docker Compose；测试用 Node 内置 `node:test` + `supertest`

## 一键启动

```bash
docker compose up --build
```

- API：`http://localhost:5090`
- MySQL：宿主机 `13377` 端口
- 首次启动 `db/schema.sql` 自动建表，应用检测到空库自动写入种子数据，无需额外步骤

## 本地运行 / 测试

```bash
docker compose up -d db     # 仅起数据库
npm install
npm test                    # 测试连真实 MySQL（127.0.0.1:13377），用例前重置并播种
npm start
```

## 种子账号

| 用户名 | 密码 | 角色 | 说明 |
| --- | --- | --- | --- |
| admin | admin123 | ADMIN | 管理员，全部权限 |
| operator | operator123 | OPERATOR | 食堂工作人员，可建/改档案餐次、登记订餐核销 |
| viewer | viewer123 | VIEWER | 社工，只读查询 |

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `5090` | API 端口 |
| `DB_HOST` / `DB_PORT` | `127.0.0.1` / `13377` | MySQL 地址 |
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `care` / `carepass` / `eldercare` | MySQL 凭据 |
| `JWT_SECRET` | `elder-canteen-dev-secret` | JWT 密钥 |
| `SEED_ON_START` | - | 设 `false` 禁用空库自动播种 |

## 数据模型

- **users**：`username, password_hash, name, role(ADMIN/OPERATOR/VIEWER), status`
- **canteens 助餐点**：`code, name, district, address, capacity, status(OPEN/CLOSED)`
- **elders 长者**：`code, name, gender, age, phone, subsidy_level(A/B/C 补贴等级), dietary(忌口), canteen_id(FK), status`
- **meals 餐次**：`canteen_id(FK), serve_date, meal_type(BREAKFAST/LUNCH/DINNER), dish_name, price_cents, status(PUBLISHED/CLOSED)`
- **orders 订餐**：`elder_id(FK), meal_id(FK), dining_type(DINE_IN/DELIVERY), qty, amount_cents, subsidy_cents, pay_cents, status(RESERVED/SERVED/CANCELLED)`

## API 一览

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/health` | 公开 | 健康检查 |
| POST | `/api/auth/login` | 公开 | 登录 |
| GET | `/api/auth/me` | 登录 | 当前用户 |
| GET/POST/PUT/DELETE | `/api/users[...]` | ADMIN | 用户管理 |
| GET | `/api/canteens` `?district/status/keyword` | 登录 | 助餐点列表 |
| GET | `/api/canteens/:id/elders` | 登录 | 该点长者 |
| POST/PUT | `/api/canteens[...]` | ADMIN/OPERATOR | 建/改 |
| DELETE | `/api/canteens/:id` | ADMIN | 删除 |
| GET/POST/PUT/DELETE | `/api/elders[...]` | 登录/操作 | 长者档案 |
| GET/POST/PUT/DELETE | `/api/meals[...]` | 登录/操作 | 餐次 |
| GET | `/api/orders` `?elderId/mealId/status` | 登录 | 订餐列表 |
| POST | `/api/orders` | ADMIN/OPERATOR | 订餐 |
| POST | `/api/orders/:id/serve` | ADMIN/OPERATOR | 核销 |
| POST | `/api/orders/:id/cancel` | ADMIN/OPERATOR | 取消 |

## 响应约定

- 成功：`{ "data": ... }`；失败：`{ "error": { "message": "..." } }`，配合 HTTP 状态码。
