-- Community discussion feature migration for Class Scheduling System.
-- Run once in Supabase Dashboard > SQL Editor after database.sql has succeeded.
-- All discussion content is visible to active, signed-in portal members.
-- Schedule requests are discussions only; an administrator must update the timetable.

begin;

create or replace function public.is_active_portal_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.user_id = (select auth.uid())
      and p.active = true
  );
$$;

revoke all on function public.is_active_portal_user() from public, anon;
grant execute on function public.is_active_portal_user() to authenticated;

create table if not exists public.community_posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users(id) on delete cascade,
  author_name text not null,
  author_role text not null check (author_role in ('admin','teacher','student')),
  category text not null check (category in ('schedule_request','timetable_question','announcement','class_update','venue_issue','other')),
  title varchar(140) not null check (length(trim(title)) >= 4),
  body varchar(3000) not null check (length(trim(body)) >= 8),
  section_id text,
  section_label text not null default 'General',
  status text not null default 'open' check (status in ('open','in_review','resolved','closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.community_posts
  add column if not exists section_label text not null default 'General';

create table if not exists public.community_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.community_posts(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  author_name text not null,
  author_role text not null check (author_role in ('admin','teacher','student')),
  body varchar(1200) not null check (length(trim(body)) >= 2),
  created_at timestamptz not null default now()
);

create index if not exists community_posts_created_at_idx
  on public.community_posts (created_at desc);
create index if not exists community_posts_category_status_idx
  on public.community_posts (category, status, created_at desc);
create index if not exists community_comments_post_created_idx
  on public.community_comments (post_id, created_at asc);

-- The database obtains the displayed author identity from the authenticated
-- user's active portal profile, rather than trusting a name/role sent by JS.
create or replace function public.set_community_author()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile record;
  v_section_label text;
begin
  select p.display_name, p.role, p.active
    into v_profile
  from public.profiles p
  where p.user_id = (select auth.uid())
  limit 1;

  if not found or v_profile.active is distinct from true then
    raise exception 'An active portal account is required to post or comment.'
      using errcode = '42501';
  end if;

  new.author_id := (select auth.uid());
  new.author_name := v_profile.display_name;
  new.author_role := v_profile.role;

  if tg_table_name = 'community_posts' then
    if new.section_id is null or btrim(new.section_id) = '' then
      new.section_id := null;
      new.section_label := 'General';
    else
      select section_row->>'code' into v_section_label
      from public.app_workspace w,
           lateral jsonb_array_elements(coalesce(w.payload->'sections', '[]'::jsonb)) as section_data(section_row)
      where w.id = true and section_row->>'id' = new.section_id
      limit 1;
      if v_section_label is null then
        raise exception 'The selected section could not be found in the current school workspace.'
          using errcode = '22023';
      end if;
      new.section_label := v_section_label;
    end if;
    new.updated_at := now();
  end if;

  return new;
end;
$$;

revoke all on function public.set_community_author() from public, anon, authenticated;

drop trigger if exists community_posts_set_author on public.community_posts;
create trigger community_posts_set_author
  before insert on public.community_posts
  for each row execute function public.set_community_author();

drop trigger if exists community_comments_set_author on public.community_comments;
create trigger community_comments_set_author
  before insert on public.community_comments
  for each row execute function public.set_community_author();

create or replace function public.set_community_post_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.set_community_post_updated_at() from public, anon, authenticated;
drop trigger if exists community_posts_updated_at on public.community_posts;
create trigger community_posts_updated_at
  before update on public.community_posts
  for each row execute function public.set_community_post_updated_at();

alter table public.community_posts enable row level security;
alter table public.community_comments enable row level security;

revoke all on table public.community_posts from anon, authenticated;
revoke all on table public.community_comments from anon, authenticated;
grant select, insert, delete on table public.community_posts to authenticated;
grant update (status, updated_at) on table public.community_posts to authenticated;
grant select, insert, delete on table public.community_comments to authenticated;

-- Active signed-in members can read the community feed.
drop policy if exists "Active portal members can read community posts" on public.community_posts;
create policy "Active portal members can read community posts"
  on public.community_posts for select to authenticated
  using ((select public.is_active_portal_user()));

-- Author identity is overwritten by the database trigger and must belong to caller.
drop policy if exists "Active portal members can create community posts" on public.community_posts;
create policy "Active portal members can create community posts"
  on public.community_posts for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and (select public.is_active_portal_user())
  );

-- Authors can remove their own posts; administrators can moderate any post.
drop policy if exists "Authors or admins can delete community posts" on public.community_posts;
create policy "Authors or admins can delete community posts"
  on public.community_posts for delete to authenticated
  using (
    author_id = (select auth.uid())
    or (select public.is_active_portal_admin())
  );

-- Only an active administrator can change a post's status (e.g. mark resolved).
drop policy if exists "Admins can update community post status" on public.community_posts;
create policy "Admins can update community post status"
  on public.community_posts for update to authenticated
  using ((select public.is_active_portal_admin()))
  with check ((select public.is_active_portal_admin()));

-- Comments are readable only when their parent post is visible to the caller.
drop policy if exists "Active members can read community comments" on public.community_comments;
create policy "Active members can read community comments"
  on public.community_comments for select to authenticated
  using (
    (select public.is_active_portal_user())
    and exists (
      select 1 from public.community_posts p
      where p.id = community_comments.post_id
    )
  );

drop policy if exists "Active members can comment on open discussions" on public.community_comments;
create policy "Active members can comment on open discussions"
  on public.community_comments for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and (select public.is_active_portal_user())
    and exists (
      select 1 from public.community_posts p
      where p.id = community_comments.post_id
        and p.status <> 'closed'
    )
  );

drop policy if exists "Authors or admins can delete community comments" on public.community_comments;
create policy "Authors or admins can delete community comments"
  on public.community_comments for delete to authenticated
  using (
    author_id = (select auth.uid())
    or (select public.is_active_portal_admin())
  );

commit;
