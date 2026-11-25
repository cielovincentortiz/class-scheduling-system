-- Class Scheduling System: first administrator bootstrap
-- Run this AFTER:
-- 1) database.sql has been executed successfully, and
-- 2) the first administrator has been created in Supabase Dashboard > Authentication > Users.
--
-- Replace the two placeholders before running this query.
-- The email must exactly match the Auth user's email address.

insert into public.profiles (
  user_id,
  email,
  display_name,
  role,
  active
)
select
  auth_user.id,
  lower(auth_user.email),
  'Cielo Vincent Ortiz',
  'admin',
  true
from auth.users as auth_user
where lower(auth_user.email) = lower('c.ortiz60490@mcc.edu.ph')
on conflict (user_id) do update
set
  email = excluded.email,
  display_name = excluded.display_name,
  role = 'admin',
  active = true,
  updated_at = now();

-- Verify that the first administrator profile exists.
select
  p.user_id,
  p.email,
  p.display_name,
  p.role,
  p.active
from public.profiles as p
where lower(p.email) = lower('REPLACE WITH ADMIN EMAIL');
