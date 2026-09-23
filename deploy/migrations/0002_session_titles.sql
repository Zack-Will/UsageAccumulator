-- 会话标题：Claude 桌面端 / Claude Code 在会话 JSONL 里写的 `custom-title` 行（侧边栏里那个名字）。
--
-- 为什么单独一张表而不是事件上的一列：标题会改（改名时整行重写），而且往往在会话开头
-- 几条消息**之后**才生成；事件按 message_id 去重、只写一次，挂在事件上就永远停在旧名字。
--
-- 只存标题，不存任何对话正文。探针在开了 hash_project_paths 的机器上不会发标题。
BEGIN;

CREATE TABLE IF NOT EXISTS session_titles (
  session_id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  title      TEXT NOT NULL CHECK (title <> ''),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
