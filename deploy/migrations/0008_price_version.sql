-- 事件成本是按哪一版价格算的（价格目录内容的指纹，见 packages/ua-server/src/pricing.ts）。
--
-- 价格现在是可热加载的数据：看板与 API 在读取时按当前价格现算，cost_usd 列只是给 SQL
-- 排查和 usage_hourly 用的缓存。价格一变，服务端后台把 price_version 不是最新的行重算一遍，
-- 不再需要手写 SQL 回填（2026-11-10 Fable 5.2 缺价那次就是手工回填的）。
--
-- NULL = 加这一列之前入库的，服务端启动后会全部重算一次。
BEGIN;

ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS price_version TEXT;

COMMIT;
