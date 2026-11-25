import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function cleanText(value: unknown, maxLength = 160) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function readDefaultKey(jsonEnvironmentName: string) {
  const raw = Deno.env.get(jsonEnvironmentName);
  if (!raw) return null;
  try {
    const keys = JSON.parse(raw) as Record<string, unknown>;
    const key = keys.default;
    return typeof key === 'string' && key.trim() ? key.trim() : null;
  } catch {
    return null;
  }
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    || Deno.env.get('SUPABASE_PUBLISHABLE_KEY')
    || readDefaultKey('SUPABASE_PUBLISHABLE_KEYS');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    || Deno.env.get('SUPABASE_SECRET_KEY')
    || readDefaultKey('SUPABASE_SECRET_KEYS');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse({ error: 'The account-management function is missing its Supabase environment settings.' }, 500);
  }

  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return jsonResponse({ error: 'Sign in as an administrator first.' }, 401);

  // Validate the caller's JWT with the public client. The privileged client is
  // used only after that validation and the administrator-profile check.
  const callerClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  });
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const { data: callerData, error: callerError } = await callerClient.auth.getUser();
    if (callerError || !callerData.user) return jsonResponse({ error: 'Your session is invalid or expired.' }, 401);

    const { data: callerProfile, error: profileError } = await adminClient
      .from('profiles')
      .select('user_id, role, active')
      .eq('user_id', callerData.user.id)
      .maybeSingle();

    if (profileError) throw profileError;
    if (!callerProfile || callerProfile.role !== 'admin' || callerProfile.active !== true) {
      return jsonResponse({ error: 'Only an active administrator can manage accounts.' }, 403);
    }

    const body = await request.json();
    const action = cleanText(body?.action, 20);

    async function validateLinkedRecord(role: string, linkedRecordId: unknown) {
      if (role === 'admin') return null;
      const id = cleanText(linkedRecordId, 120);
      if (!id) throw new Error(`A ${role} account must be linked to an existing ${role} record.`);
      const { data: workspace, error: workspaceError } = await adminClient
        .from('app_workspace')
        .select('payload')
        .eq('id', true)
        .maybeSingle();
      if (workspaceError) throw workspaceError;
      const collection = role === 'teacher' ? 'teachers' : 'students';
      const exists = Array.isArray(workspace?.payload?.[collection])
        && workspace.payload[collection].some((record: Record<string, unknown>) => record.id === id);
      if (!exists) throw new Error(`Select an existing ${role} record before creating this account.`);
      return id;
    }

    if (action === 'create') {
      const email = cleanText(body.email, 254).toLowerCase();
      const password = String(body.password ?? '');
      const displayName = cleanText(body.display_name ?? body.displayName, 120);
      const role = cleanText(body.role, 20);
      const rawLinkedRecordId = body.linked_record_id ?? body.linkedId ?? null;
      const active = body.active !== false;

      if (!email || !email.includes('@') || !displayName || !['admin', 'teacher', 'student'].includes(role)) {
        return jsonResponse({ error: 'Enter a valid email, display name, and portal role.' }, 400);
      }
      if (password.length < 10) return jsonResponse({ error: 'Initial passwords must contain at least 10 characters.' }, 400);
      const linkedRecordId = await validateLinkedRecord(role, rawLinkedRecordId);

      const { data: created, error: createError } = await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { display_name: displayName, portal_role: role },
      });
      if (createError || !created.user) throw createError ?? new Error('Could not create the authentication account.');

      const { data: profile, error: insertProfileError } = await adminClient
        .from('profiles')
        .insert({
          user_id: created.user.id,
          email,
          display_name: displayName,
          role,
          linked_record_id: linkedRecordId ? String(linkedRecordId) : null,
          active,
        })
        .select('user_id,email,display_name,role,linked_record_id,active,created_at')
        .single();

      if (insertProfileError) {
        await adminClient.auth.admin.deleteUser(created.user.id);
        throw insertProfileError;
      }
      return jsonResponse({ profile });
    }

    if (action === 'update') {
      const userId = cleanText(body.user_id ?? body.userId, 80);
      const email = cleanText(body.email, 254).toLowerCase();
      const password = String(body.password ?? '');
      const displayName = cleanText(body.display_name ?? body.displayName, 120);
      const role = cleanText(body.role, 20);
      const rawLinkedRecordId = body.linked_record_id ?? body.linkedId ?? null;
      const active = body.active !== false;

      if (!userId || !email || !email.includes('@') || !displayName || !['admin', 'teacher', 'student'].includes(role)) {
        return jsonResponse({ error: 'Complete the account details before saving.' }, 400);
      }
      if (password && password.length < 10) return jsonResponse({ error: 'New passwords must contain at least 10 characters.' }, 400);
      if (userId === callerData.user.id && (role !== 'admin' || !active)) {
        return jsonResponse({ error: 'You cannot remove administrator access or deactivate the account currently signed in.' }, 400);
      }

      const { data: existingTarget, error: existingTargetError } = await adminClient
        .from('profiles')
        .select('user_id, role, active')
        .eq('user_id', userId)
        .maybeSingle();
      if (existingTargetError) throw existingTargetError;
      if (!existingTarget) return jsonResponse({ error: 'The account was not found.' }, 404);
      if (existingTarget.role === 'admin' && existingTarget.active && (role !== 'admin' || !active)) {
        const { count, error: countError } = await adminClient.from('profiles')
          .select('user_id', { count: 'exact', head: true })
          .eq('role', 'admin').eq('active', true);
        if (countError) throw countError;
        if ((count ?? 0) <= 1) return jsonResponse({ error: 'The last active administrator cannot be demoted or deactivated. Create another active administrator first.' }, 400);
      }
      const linkedRecordId = await validateLinkedRecord(role, rawLinkedRecordId);

      const authUpdate: Record<string, unknown> = {
        email,
        email_confirm: true,
        user_metadata: { display_name: displayName, portal_role: role },
      };
      if (password) authUpdate.password = password;
      const { error: updateAuthError } = await adminClient.auth.admin.updateUserById(userId, authUpdate);
      if (updateAuthError) throw updateAuthError;

      const { data: profile, error: updateProfileError } = await adminClient
        .from('profiles')
        .update({
          email,
          display_name: displayName,
          role,
          linked_record_id: linkedRecordId ? String(linkedRecordId) : null,
          active,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId)
        .select('user_id,email,display_name,role,linked_record_id,active,created_at')
        .single();
      if (updateProfileError) throw updateProfileError;
      return jsonResponse({ profile });
    }

    if (action === 'delete') {
      const userId = cleanText(body.user_id ?? body.userId, 80);
      if (!userId) return jsonResponse({ error: 'Account ID is required.' }, 400);
      if (userId === callerData.user.id) return jsonResponse({ error: 'You cannot delete the account currently signed in.' }, 400);

      const { data: target, error: targetError } = await adminClient
        .from('profiles')
        .select('user_id, role, active')
        .eq('user_id', userId)
        .maybeSingle();
      if (targetError) throw targetError;
      if (!target) return jsonResponse({ error: 'The account was not found.' }, 404);

      if (target.role === 'admin' && target.active) {
        const { count, error: countError } = await adminClient
          .from('profiles')
          .select('user_id', { count: 'exact', head: true })
          .eq('role', 'admin')
          .eq('active', true);
        if (countError) throw countError;
        if ((count ?? 0) <= 1) return jsonResponse({ error: 'The last active administrator cannot be deleted. Create another active administrator first.' }, 400);
      }

      const { error: deleteError } = await adminClient.auth.admin.deleteUser(userId);
      if (deleteError) throw deleteError;
      // profiles.user_id references auth.users with ON DELETE CASCADE.
      return jsonResponse({ deleted: true, user_id: userId });
    }

    return jsonResponse({ error: 'Unsupported account action.' }, 400);
  } catch (error) {
    console.error('manage-account error:', error);
    return jsonResponse({ error: error instanceof Error ? error.message : 'Account management failed.' }, 400);
  }
});
