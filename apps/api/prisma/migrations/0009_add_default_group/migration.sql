-- v0.0.4 W1-D1（QA 回归缺陷，需求.md §5.2 默认分组 / §5.5 删除保护 / §21.1 Project→Group 行 /
-- §19 表 groups.is_default / 验收条款 7、8）：预置「默认」分组。
-- 1) groups 加 `is_default INTEGER NOT NULL DEFAULT 0`。SQLite 允许对常量默认值的列直接
--    ALTER ADD COLUMN，不牵动外键与索引，无需像 0007/0008 那样整表重建（那两次改的是
--    列名/表名，重建是被外键引用逼出来的；这里没有那个约束）。
-- 2) 插入预置「默认」分组：固定 id `grp_default`（服务层 DEFAULT_GROUP_ID 同值），is_default=1。
--    uniq_groups_name 可能撞名：若存量已有名为「默认」的分组，不再插新行，而是把既有那行
--    标记为 is_default=1（id 保持不变，指向它的 tasks.group_id 与偏好引用原样有效）——
--    与 0008「偏好值定点改写、命不中就是空更新」的先例同口径：迁移不假设数据、逐分支兜底。
-- 3) 存量 group_id IS NULL 的任务归入默认分组（§5.2「未指定分组归入默认」对存量同口径）。
--    不改 updated_at：这是数据归位而非用户编辑，不应刷新卡片的「更新时间」。
-- 本文件与 0001~0008 一样是权威 DDL，不要用 `prisma migrate dev` 重算。

-- ---------------------------------------------------------------- groups 加列
ALTER TABLE groups ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------- 预置「默认」分组
INSERT INTO groups (id, name, is_default)
SELECT 'grp_default', '默认', 1
WHERE NOT EXISTS (SELECT 1 FROM groups WHERE name = '默认');

-- 撞名分支：既有「默认」行就地转正（含上面新插的行重复确认，幂等）。
UPDATE groups SET is_default = 1 WHERE name = '默认';

-- §5.6「默认分组不可归档」：若转正的既有行此前已归档，就地恢复活跃，避免升级即违约。
UPDATE groups SET status = 'ACTIVE' WHERE is_default = 1 AND status = 'ARCHIVED';

-- ---------------------------------------------------------------- 存量无归属任务归位
UPDATE tasks
SET group_id = (SELECT id FROM groups WHERE is_default = 1)
WHERE group_id IS NULL;
