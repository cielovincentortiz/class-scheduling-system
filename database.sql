-- Class Scheduler cloud database (Supabase / PostgreSQL)
-- Run this file in Supabase Dashboard > SQL Editor.
--
-- The app keeps the school's timetable data in one JSONB workspace document
-- so the current vanilla-JavaScript UI can load/save one consistent revision.
-- User credentials are NOT stored here: Supabase Auth stores credentials and
-- public.profiles stores only the user's portal role and linked school record.

begin;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  display_name text not null,
  role text not null check (role in ('admin', 'teacher', 'student')),
  linked_record_id text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_workspace (
  id boolean primary key default true check (id = true),
  payload jsonb not null default '{}'::jsonb,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is 'Portal roles and linked teacher/student records. Passwords are managed by Supabase Auth.';
comment on table public.app_workspace is 'Shared academic data: programs, curriculum, teachers, students, rooms, schedules, consultation periods and settings.';

-- Security helper: reads the caller's profile without causing recursive RLS.
create or replace function public.current_portal_profile()
returns table(role text, active boolean, linked_record_id text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.role, p.active, p.linked_record_id
  from public.profiles p
  where p.user_id = (select auth.uid())
  limit 1;
$$;

create or replace function public.is_active_portal_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.user_id = (select auth.uid())
      and p.role = 'admin'
      and p.active = true
  );
$$;

alter table public.profiles enable row level security;
alter table public.app_workspace enable row level security;

-- Explicitly revoke broad defaults. The browser receives no direct access to
-- the workspace table and cannot create or edit profile rows.
revoke all on table public.profiles from anon, authenticated;
revoke all on table public.app_workspace from anon, authenticated;
grant select on table public.profiles to authenticated;
-- The account-management Edge Function uses a server-only secret/service key.
grant all on table public.profiles, public.app_workspace to service_role;

drop policy if exists "Profiles are visible to their owner or an active admin" on public.profiles;
create policy "Profiles are visible to their owner or an active admin"
  on public.profiles
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    or (select public.is_active_portal_admin())
  );

-- Workspace access is intentionally only through the two checked RPCs below.
-- Do not add direct table grants or permissive policies for app_workspace.

create or replace function public.get_class_scheduler_state()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile record;
  v_payload jsonb;
  v_revision bigint;
  v_own_student jsonb;
  v_schedules jsonb;
  v_rows jsonb;
  v_section_ids text[];
  v_subject_ids text[];
  v_teacher_ids text[];
  v_room_ids text[];
  v_batch_index text;
begin
  select * into v_profile from public.current_portal_profile();
  if v_profile is null or coalesce(v_profile.active, false) = false then
    raise exception 'Active portal account required.' using errcode = '42501';
  end if;

  select w.payload, w.revision
    into v_payload, v_revision
  from public.app_workspace w
  where w.id = true;

  if not found then
    return jsonb_build_object('payload', '{}'::jsonb, 'revision', 0);
  end if;

  v_payload := coalesce(v_payload, '{}'::jsonb) - 'users';

  if v_profile.role = 'teacher' then
    -- Teachers receive only their own class meetings and consultation periods.
    -- Student records, other teachers' records, and the activity log stay private.
    select coalesce(jsonb_agg(s.schedule_row), '[]'::jsonb)
      into v_schedules
    from jsonb_array_elements(coalesce(v_payload->'schedules', '[]'::jsonb)) as s(schedule_row)
    where s.schedule_row->>'teacherId' = v_profile.linked_record_id;

    select coalesce(array_agg(distinct x.schedule_row->>'sectionId'), ARRAY[]::text[])
      into v_section_ids
    from jsonb_array_elements(v_schedules) as x(schedule_row)
    where nullif(x.schedule_row->>'sectionId', '') is not null;

    select coalesce(array_agg(distinct x.schedule_row->>'subjectId'), ARRAY[]::text[])
      into v_subject_ids
    from jsonb_array_elements(v_schedules) as x(schedule_row)
    where nullif(x.schedule_row->>'subjectId', '') is not null;

    select coalesce(array_agg(distinct x.schedule_row->>'roomId'), ARRAY[]::text[])
      into v_room_ids
    from jsonb_array_elements(v_schedules) as x(schedule_row)
    where nullif(x.schedule_row->>'roomId', '') is not null;

    v_payload := jsonb_set(v_payload - 'students' - 'activityLog' - 'lastGeneration', '{schedules}', v_schedules, true);

    select coalesce(jsonb_agg(t.teacher_row), '[]'::jsonb) into v_rows
    from jsonb_array_elements(coalesce(v_payload->'teachers', '[]'::jsonb)) as t(teacher_row)
    where t.teacher_row->>'id' = v_profile.linked_record_id;
    v_payload := jsonb_set(v_payload, '{teachers}', v_rows, true);

    select coalesce(jsonb_agg(c.section_row), '[]'::jsonb) into v_rows
    from jsonb_array_elements(coalesce(v_payload->'sections', '[]'::jsonb)) as c(section_row)
    where c.section_row->>'id' = any(v_section_ids);
    v_payload := jsonb_set(v_payload, '{sections}', v_rows, true);

    select coalesce(jsonb_agg(s.subject_row), '[]'::jsonb) into v_rows
    from jsonb_array_elements(coalesce(v_payload->'subjects', '[]'::jsonb)) as s(subject_row)
    where s.subject_row->>'id' = any(v_subject_ids);
    v_payload := jsonb_set(v_payload, '{subjects}', v_rows, true);

    select coalesce(jsonb_agg(r.room_row), '[]'::jsonb) into v_rows
    from jsonb_array_elements(coalesce(v_payload->'rooms', '[]'::jsonb)) as r(room_row)
    where r.room_row->>'id' = any(v_room_ids);
    v_payload := jsonb_set(v_payload, '{rooms}', v_rows, true);

    select coalesce(jsonb_agg(c.consultation_row), '[]'::jsonb) into v_rows
    from jsonb_array_elements(coalesce(v_payload->'consultationPeriods', '[]'::jsonb)) as c(consultation_row)
    where c.consultation_row->>'teacherId' = v_profile.linked_record_id;
    v_payload := jsonb_set(v_payload, '{consultationPeriods}', v_rows, true);

  elsif v_profile.role = 'student' then
    -- Students receive only their own student record and meetings for their
    -- primary/additional sections. Batch students see whole-section classes
    -- plus meetings for their own batch only.
    select s.student_row
      into v_own_student
    from jsonb_array_elements(coalesce(v_payload->'students', '[]'::jsonb)) as s(student_row)
    where s.student_row->>'id' = v_profile.linked_record_id
    limit 1;

    if v_own_student is null then
      raise exception 'The student account is not linked to an active student record.' using errcode = '42501';
    end if;

    select coalesce(array_agg(section_id), ARRAY[]::text[])
      into v_section_ids
    from (
      select v_own_student->>'sectionId' as section_id
      union
      select jsonb_array_elements_text(coalesce(v_own_student->'additionalSectionIds', '[]'::jsonb)) as section_id
    ) assigned_sections
    where nullif(section_id, '') is not null;

    select coalesce(array_agg(subject_id), ARRAY[]::text[])
      into v_subject_ids
    from jsonb_array_elements_text(coalesce(v_own_student->'enrolledSubjectIds', '[]'::jsonb)) as assigned_subjects(subject_id);

    v_batch_index := v_own_student->>'batchIndex';

    select coalesce(jsonb_agg(s.schedule_row), '[]'::jsonb)
      into v_schedules
    from jsonb_array_elements(coalesce(v_payload->'schedules', '[]'::jsonb)) as s(schedule_row)
    where s.schedule_row->>'sectionId' = any(v_section_ids)
      and (coalesce(array_length(v_subject_ids, 1), 0) = 0 or s.schedule_row->>'subjectId' = any(v_subject_ids))
      and (
        s.schedule_row->>'sectionId' <> coalesce(v_own_student->>'sectionId', '')
        or v_batch_index is null
        or s.schedule_row->>'batchIndex' is null
        or s.schedule_row->>'batchIndex' = v_batch_index
      );

    select coalesce(array_agg(distinct x.schedule_row->>'teacherId'), ARRAY[]::text[])
      into v_teacher_ids
    from jsonb_array_elements(v_schedules) as x(schedule_row)
    where nullif(x.schedule_row->>'teacherId', '') is not null;

    select coalesce(array_agg(distinct x.schedule_row->>'roomId'), ARRAY[]::text[])
      into v_room_ids
    from jsonb_array_elements(v_schedules) as x(schedule_row)
    where nullif(x.schedule_row->>'roomId', '') is not null;

    v_payload := jsonb_set(v_payload, '{students}', jsonb_build_array(v_own_student), true)
      - 'activityLog' - 'lastGeneration';
    v_payload := jsonb_set(v_payload, '{schedules}', v_schedules, true);

    select coalesce(jsonb_agg(c.section_row), '[]'::jsonb) into v_rows
    from jsonb_array_elements(coalesce(v_payload->'sections', '[]'::jsonb)) as c(section_row)
    where c.section_row->>'id' = any(v_section_ids);
    v_payload := jsonb_set(v_payload, '{sections}', v_rows, true);

    select coalesce(jsonb_agg(t.teacher_row), '[]'::jsonb) into v_rows
    from jsonb_array_elements(coalesce(v_payload->'teachers', '[]'::jsonb)) as t(teacher_row)
    where t.teacher_row->>'id' = any(v_teacher_ids);
    v_payload := jsonb_set(v_payload, '{teachers}', v_rows, true);

    select coalesce(jsonb_agg(r.room_row), '[]'::jsonb) into v_rows
    from jsonb_array_elements(coalesce(v_payload->'rooms', '[]'::jsonb)) as r(room_row)
    where r.room_row->>'id' = any(v_room_ids);
    v_payload := jsonb_set(v_payload, '{rooms}', v_rows, true);

  elsif v_profile.role <> 'admin' then
    raise exception 'Unsupported portal role.' using errcode = '42501';
  end if;

  return jsonb_build_object('payload', v_payload, 'revision', coalesce(v_revision, 0));
end;
$$;

create or replace function public.save_class_scheduler_state(
  p_payload jsonb,
  p_expected_revision bigint
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile record;
  v_new_revision bigint;
begin
  select * into v_profile from public.current_portal_profile();
  if v_profile is null or coalesce(v_profile.active, false) = false or v_profile.role <> 'admin' then
    raise exception 'Only an active administrator can save the school workspace.' using errcode = '42501';
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Workspace payload must be a JSON object.' using errcode = '22023';
  end if;

  -- Accounts and profile fields are intentionally kept out of this document.
  insert into public.app_workspace (id, payload, revision, updated_at)
  values (true, p_payload - 'users', 1, now())
  on conflict (id) do update
    set payload = excluded.payload,
        revision = public.app_workspace.revision + 1,
        updated_at = now()
    where public.app_workspace.revision = p_expected_revision
  returning revision into v_new_revision;

  if v_new_revision is null then
    raise exception 'Workspace revision conflict. Refresh the page to load the latest cloud data before saving.'
      using errcode = '40001';
  end if;

  return v_new_revision;
end;
$$;

revoke all on function public.current_portal_profile() from public, anon;
revoke all on function public.is_active_portal_admin() from public, anon;
revoke all on function public.get_class_scheduler_state() from public, anon;
revoke all on function public.save_class_scheduler_state(jsonb, bigint) from public, anon;
grant execute on function public.current_portal_profile() to authenticated;
grant execute on function public.is_active_portal_admin() to authenticated;
grant execute on function public.get_class_scheduler_state() to authenticated;
grant execute on function public.save_class_scheduler_state(jsonb, bigint) to authenticated;

commit;

-- FIRST ADMIN ACCOUNT SETUP (run after creating the initial user under
-- Supabase Dashboard > Authentication > Users):
-- Replace the email and display name below with the initial administrator.
--
-- insert into public.profiles (user_id, email, display_name, role, active)
-- select id, email, 'Portal Administrator', 'admin', true
-- from auth.users
-- where lower(email) = lower('admin@your-school.example')
-- on conflict (user_id) do update
-- set email = excluded.email,
--     display_name = excluded.display_name,
--     role = 'admin',
--     active = true,
--     updated_at = now();


-- The first administrator bootstrap is intentionally separate.
-- After creating the first Auth user, run supabase/bootstrap-first-admin.sql.
