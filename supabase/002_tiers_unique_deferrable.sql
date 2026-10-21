-- =====================================================================
-- 修正：層級的「天數上限不可重複」改成交易結束時才檢查
-- 只有在「已經執行過舊版 schema.sql」時才需要執行這一份（執行一次即可）。
-- 原因：在層級設定裡對調兩個層級的天數（例如 3 和 7 互換）時，
--       舊版會在中途誤判為重複而儲存失敗。
-- =====================================================================
begin;
alter table todo.tiers drop constraint if exists tiers_user_id_max_days_key;
alter table todo.tiers add constraint tiers_user_id_max_days_key
  unique (user_id, max_days) deferrable initially deferred;
commit;
