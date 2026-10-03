-- 输出 token 是否为最终值（CONTRACT §1.1 output_final）。
--
-- 子代理转录把一条消息拆成多行，只有最后一行才是 message_delta 合并后的最终用量，
-- 之前「先到先得」的去重把流式中途值（output_tokens 2~7）存了进来。
-- 2026-10-02 实测 NAS 一个 Workflow 会话：库里子代理 output 合计 50,648，文件末行合计 1,348,177。
-- 入库从 DO NOTHING 改成「更完整就覆盖」，这一列既用来比谁更完整，也让看板能标出
-- 「最终用量没写进文件、output 只是下界」的事件。
--
-- NULL = 旧探针上报，不知道。不回填成 true：没量过就不能说是对的。
BEGIN;

ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS output_final BOOLEAN;

COMMIT;
