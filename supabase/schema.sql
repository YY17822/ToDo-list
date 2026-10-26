-- =====================================================================
-- ToDo 後端資料表（Supabase / Postgres，schema: todo）
-- 使用方式：Supabase 後台 → SQL Editor → 貼上整份 → Run
-- 整份包在一個交易裡：任何一步出錯，全部不會生效。
-- =====================================================================
begin;

create schema if not exists todo;

-- ---------- 共用：自動更新 updated_at ----------
create or replace function todo.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------- 1. tasks：母任務 ----------
create table todo.tasks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title       text not null check (length(btrim(title)) > 0),
  due_date    date,
  note        text not null default '',
  is_done     boolean not null default false,
  done_at     timestamptz,
  is_trashed  boolean not null default false,
  trashed_at  timestamptz,
  archived_at timestamptz,                   -- 封存時間；空白 = 未封存
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index tasks_user_id_idx on todo.tasks (user_id);

-- ---------- 2. subtasks：子任務 ----------
create table todo.subtasks (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references todo.tasks(id) on delete cascade,
  title       text not null check (length(btrim(title)) > 0),
  due_date    date,
  note        text not null default '',
  is_done     boolean not null default false,
  done_at     timestamptz,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index subtasks_task_id_idx on todo.subtasks (task_id);

-- ---------- 3. tiers：緊急程度層級 ----------
create table todo.tiers (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null check (length(btrim(name)) > 0),
  max_days    integer,                       -- 空白 = 其餘全部（含無期限）
  color       text not null check (color ~ '^#[0-9A-Fa-f]{6}$'),
  hide_done   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- 同一人天數上限不可重複；延到交易結束才檢查，才能一次對調兩個層級的天數
  constraint tiers_user_id_max_days_key unique (user_id, max_days) deferrable initially deferred
);
-- 每個使用者只能有一筆「其餘全部」
create unique index tiers_one_catchall_per_user on todo.tiers (user_id) where max_days is null;

-- ---------- 4. user_settings：個人設定 ----------
create table todo.user_settings (
  user_id     uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  group_by    text not null default 'earliest' check (group_by in ('earliest','self')),
  ui_theme    text not null default 'tech-light' check (ui_theme in ('classic','tech-light','tech-dark')),
  updated_at  timestamptz not null default now()
);

-- ---------- updated_at 觸發器 ----------
create trigger tasks_updated_at         before update on todo.tasks         for each row execute function todo.set_updated_at();
create trigger subtasks_updated_at      before update on todo.subtasks      for each row execute function todo.set_updated_at();
create trigger tiers_updated_at         before update on todo.tiers         for each row execute function todo.set_updated_at();
create trigger user_settings_updated_at before update on todo.user_settings for each row execute function todo.set_updated_at();

-- ---------- 列層級安全（RLS）：每個人只能讀寫自己的資料 ----------
alter table todo.tasks         enable row level security;
alter table todo.subtasks      enable row level security;
alter table todo.tiers         enable row level security;
alter table todo.user_settings enable row level security;

create policy "own tasks" on todo.tasks for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "own subtasks" on todo.subtasks for all to authenticated
  using (exists (select 1 from todo.tasks t where t.id = task_id and t.user_id = (select auth.uid())))
  with check (exists (select 1 from todo.tasks t where t.id = task_id and t.user_id = (select auth.uid())));

create policy "own tiers" on todo.tiers for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "own settings" on todo.user_settings for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ---------- 權限：只開給已登入的使用者（未登入的 anon 完全看不到） ----------
grant usage on schema todo to authenticated, service_role;
grant select, insert, update, delete on all tables in schema todo to authenticated;
grant all on all tables in schema todo to service_role;

commit;
