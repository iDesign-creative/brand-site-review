-- ============================================================================
-- PDF upload storage: a public bucket for review PDFs uploaded from the Library.
-- Run once in Supabase ▸ SQL Editor. MVP posture: uploads + reads allowed with
-- the anon key, same as the other tables.
-- ============================================================================

-- Public bucket (so the native PDF viewer can read the file by URL).
insert into storage.buckets (id, name, public)
values ('pdf-reviews', 'pdf-reviews', true)
on conflict (id) do update set public = true;

-- Allow uploading into this bucket with the anon key.
drop policy if exists "pdf-reviews insert" on storage.objects;
create policy "pdf-reviews insert" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'pdf-reviews');

-- Allow reading objects in this bucket (public bucket also serves /object/public/…).
drop policy if exists "pdf-reviews read" on storage.objects;
create policy "pdf-reviews read" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'pdf-reviews');
