-- Class Scheduling System: first administrator bootstrap
-- Run this AFTER:
-- 1) database.sql has been executed successfully, and
-- 2) the first administrator has been created in Supabase Dashboard > Authentication > Users.
--
-- Replace the two placeholders before running this query.
-- The email must exactly match the Auth user's email address.

INSERT INTO public.profiles (
    user_id,
    email,
    display_name,
    role,
    active
)
SELECT
    auth_user.id,
    lower(auth_user.email),
    $admin_name$Cielo Vincent Ortiz$admin_name$,
    'admin',
    true
FROM auth.users AS auth_user
WHERE lower(auth_user.email) =
      lower($admin_email$c.ortiz60490@mcc.edu.ph$admin_email$)

ON CONFLICT (user_id) DO UPDATE
SET
    email = EXCLUDED.email,
    display_name = EXCLUDED.display_name,
    role = 'admin',
    active = true,
    updated_at = now()

RETURNING
    user_id,
    email,
    display_name,
    role,
    active;
