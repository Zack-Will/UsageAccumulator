-- profile 绑定 claude.ai 组织（ARCHITECTURE §4.1）。
--
-- 同一个 claude.ai 账号（同一个 sessionKey）可以同时挂 team 组织和个人订阅组织，
-- 两边的额度毫不相干。profile 的本义是「一份订阅」，所以它对应的是组织，不是账号。
-- 绑定由看板显式选择，服务端不猜（2026-09-27 实测：个人 Max 组织不带 raven，按 raven 猜会选错）。
BEGIN;

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS org_uuid TEXT;

-- 一个组织只能挂在一个 profile 上：否则同一份额度会被两个 profile 各抓一遍、各标定一遍
CREATE UNIQUE INDEX IF NOT EXISTS profiles_org_uuid_uidx ON profiles (org_uuid) WHERE org_uuid IS NOT NULL;

COMMIT;
