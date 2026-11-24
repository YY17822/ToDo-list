-- =====================================================================
-- 新增：標籤功能（labels、task_labels 兩張表）
-- 已經執行過 schema.sql 的資料庫，執行這一份一次即可；重複執行也不會出錯。
-- 一個任務可以掛多個標籤；刪除標籤時，只會從任務上拿掉，不會刪除任務。
-- =====================================================================
begin;

-- ---------- 5. labels：標籤（名稱＋顏色，由使用者自己建立） ----------
create table if not exists todo.labels (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null check (length(btrim(name)) > 0),
  color       text not null check (color ~ '^#[0-9A-Fa-f]{6}$'),
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- 同一人的標籤名稱不可重複；延到交易結束才檢查，才能一次對調兩個標籤的名稱
  constraint labels_user_id_name_key unique (user_id, name) deferrable initially deferred
);

-- ---------- 6. task_labels：哪個任務掛了哪個標籤（一筆一個配對） ----------
create table if not exists todo.task_labels (
  task_id     uuid not null references todo.tasks(id) on delete cascade,
  label_id    uuid not null references todo.labels(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (task_id, label_id)
);
create index if not exists task_labels_label_id_idx on todo.task_labels (label_id);

drop trigger if exists labels_updated_at on todo.labels;
create trigger labels_updated_at before update on todo.labels for each row execute function todo.set_updated_at();

alter table todo.labels      enable row level security;
alter table todo.task_labels enable row level security;

drop policy if exists "own labels" on todo.labels;
create policy "own labels" on todo.labels for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "own task_labels" on todo.task_labels;
create policy "own task_labels" on todo.task_labels for all to authenticated
  using (exists (select 1 from todo.tasks t where t.id = task_id and t.user_id = (select auth.uid())))
  with check (exists (select 1 from todo.tasks t  where t.id = task_id  and t.user_id = (select auth.uid()))
          and exists (select 1 from todo.labels l where l.id = label_id and l.user_id = (select auth.uid())));

grant select, insert, update, delete on todo.labels, todo.task_labels to authenticated;
grant all on todo.labels, todo.task_labels to service_role;

commit;
-- 讓 API 立刻認得新資料表
notify pgrst, 'reload schema';
