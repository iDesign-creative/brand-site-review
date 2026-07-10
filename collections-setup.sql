-- ============================================================================
-- Collections: bundle several library reviews into one shareable batch so a
-- reviewer gets a single link. Run once in Supabase ▸ SQL Editor.
-- MVP uses permissive anon policies, matching the existing tables.
-- ============================================================================

create table if not exists public.collections (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by text,
  created_at timestamptz not null default now()
);

-- Join table: an item (review) can live in multiple collections.
create table if not exists public.collection_items (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references public.collections(id) on delete cascade,
  review_id uuid not null references public.reviews(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (collection_id, review_id)
);

-- RLS (MVP: open to the anon key, same as reviews/review_comments)
do $$
declare t text;
begin
  foreach t in array array['collections','collection_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "%s anon all" on public.%I', t, t);
    execute format('create policy "%s anon all" on public.%I for all using (true) with check (true)', t, t);
  end loop;
end $$;
