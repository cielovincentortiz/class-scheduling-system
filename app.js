/*
 * CLASS SCHEDULER - academic scheduling portal
 * Front end: HTML, CSS, and JavaScript. Cloud authentication and shared data: Supabase.
 */

(() => {
  'use strict';

  const STORAGE_KEY = 'classSchedulerData_v2';
  const FONT_SCALE_STORAGE_KEY = 'classSchedulerFontScale_v1';
  const THEME_STORAGE_KEY = 'classSchedulerTheme_v1';
  const FONT_SCALE_MIN = 0.9;
  const FONT_SCALE_MAX = 1.4;
  const FONT_SCALE_STEP = 0.1;
  let currentFontScale = 1;
  let currentTheme = 'light';
  let navCloseTimer = null;
  let navOpenTimer = null;
  let navLayoutFrame = 0;
  let navResizeObserver = null;
  let currentNavItems = [];

  // Public browser configuration is kept separately in supabase-config.js.
  // Only the Project URL and publishable key belong there. Never add a secret/service-role key.
  const SUPABASE_CONFIG = window.CLASS_SCHEDULER_CONFIG || {};
  let supabaseClient = null;
  let cloudMode = false;
  let cloudRevision = 0;
  let cloudSaveTimer = null;
  let cloudSaveInProgress = false;
  let cloudSaveQueued = false;
  const fallbackLocal = Object.create(null);
  const fallbackSession = Object.create(null);
  function safeLocalGet(key) { try { return window.localStorage.getItem(key); } catch { return fallbackLocal[key] ?? null; } }
  function safeLocalSet(key, value) { try { window.localStorage.setItem(key, value); } catch { fallbackLocal[key] = String(value); } }
  function safeSessionGet(key) { try { return window.sessionStorage.getItem(key); } catch { return fallbackSession[key] ?? null; } }
  function safeSessionSet(key, value) { try { window.sessionStorage.setItem(key, value); } catch { fallbackSession[key] = String(value); } }
  function safeSessionRemove(key) { try { window.sessionStorage.removeItem(key); } catch { delete fallbackSession[key]; } }
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const START_OF_DAY = 7 * 60;
  const END_OF_DAY = 21 * 60;
  const INTERVAL = 30;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const uid = (prefix = 'id') => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const clone = value => JSON.parse(JSON.stringify(value));
  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const byId = (items, id) => items.find(item => item.id === id);
  const fmtTime = minutes => {
    const hour24 = Math.floor(minutes / 60);
    const minute = minutes % 60;
    const suffix = hour24 >= 12 ? 'PM' : 'AM';
    const hour12 = hour24 % 12 || 12;
    return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
  };
  const parseTime = value => {
    if (typeof value === 'number') return value;
    const [h, m] = String(value || '').split(':').map(Number);
    return h * 60 + m;
  };
  const timeInput = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  const durationHours = schedule => (schedule.end - schedule.start) / 60;
  const normalizeCode = value => String(value || '').trim().toUpperCase();
  const nowISO = () => new Date().toISOString();


  function applyTheme(theme, persist = true) {
    currentTheme = theme === 'dark' ? 'dark' : 'light';
    const isDark = currentTheme === 'dark';
    document.body.classList.toggle('dark', isDark);
    document.documentElement.dataset.theme = currentTheme;
    document.documentElement.style.colorScheme = currentTheme;

    document.querySelectorAll('[data-theme-toggle]').forEach(button => {
      const icon = button.querySelector('.theme-icon');
      const label = button.querySelector('.theme-label');
      const nextLabel = isDark ? 'Light' : 'Dark';
      if (icon) icon.textContent = isDark ? '☀' : '☾';
      if (label) label.textContent = nextLabel;
      button.setAttribute('aria-label', `Switch to ${nextLabel.toLowerCase()} mode`);
      button.setAttribute('title', `Switch to ${nextLabel.toLowerCase()} mode`);
      button.setAttribute('aria-pressed', String(isDark));
    });

    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.setAttribute('content', isDark ? '#21191b' : '#6f0918');
    if (persist) safeLocalSet(THEME_STORAGE_KEY, currentTheme);
  }

  function initializeTheme() {
    const savedTheme = safeLocalGet(THEME_STORAGE_KEY);
    applyTheme(savedTheme === 'dark' ? 'dark' : 'light', false);
  }

  function applyFontScale(scale, persist = true) {
    const bounded = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, Number(scale) || 1));
    currentFontScale = Math.round(bounded * 100) / 100;
    document.documentElement.style.setProperty('--font-scale', String(currentFontScale));
    document.querySelectorAll('[data-font-scale-label]').forEach(output => {
      output.value = `${Math.round(currentFontScale * 100)}%`;
      output.textContent = `${Math.round(currentFontScale * 100)}%`;
    });
    document.querySelectorAll('[data-font-action="decrease"]').forEach(button => {
      button.disabled = currentFontScale <= FONT_SCALE_MIN;
    });
    document.querySelectorAll('[data-font-action="increase"]').forEach(button => {
      button.disabled = currentFontScale >= FONT_SCALE_MAX;
    });
    document.querySelectorAll('[data-font-action="reset"]').forEach(button => {
      button.disabled = currentFontScale === 1;
    });
    if (persist) safeLocalSet(FONT_SCALE_STORAGE_KEY, String(currentFontScale));
    scheduleNavigationLayout();
  }

  function initializeFontControls() {
    const savedScale = Number(safeLocalGet(FONT_SCALE_STORAGE_KEY));
    applyFontScale(Number.isFinite(savedScale) && savedScale > 0 ? savedScale : 1, false);
  }

  function handleFontAdjustment(action) {
    if (action === 'increase') applyFontScale(currentFontScale + FONT_SCALE_STEP);
    else if (action === 'decrease') applyFontScale(currentFontScale - FONT_SCALE_STEP);
    else if (action === 'reset') applyFontScale(1);
  }

  function setCloudStatus(message, kind = 'info') {
    const status = $('#cloudStatusMessage');
    if (!status) return;
    status.textContent = message;
    status.dataset.status = kind;
    status.classList.toggle('is-error', kind === 'error');
    status.classList.toggle('is-ready', kind === 'success');
  }

  function initializeCloudConnection() {
    const url = String(SUPABASE_CONFIG.url || '').trim().replace(/\/$/, '');
    const key = String(SUPABASE_CONFIG.publishableKey || '').trim();
    const loginButton = $('#loginForm button[type="submit"]');

    // Fail closed. A public deployment must never silently fall back to local/demo accounts.
    if (!url || !key) {
      cloudMode = false;
      if (loginButton) loginButton.disabled = true;
      setCloudStatus(
        'Sign-in is temporarily unavailable. Please contact the school administrator.',
        'error'
      );
      return false;
    }

    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== 'https:' || !parsedUrl.hostname) {
        throw new Error('The Supabase Project URL must be a valid HTTPS URL.');
      }
      if (!window.supabase?.createClient) {
        throw new Error('The Supabase browser library did not load. Check your internet connection and refresh this page.');
      }

      supabaseClient = window.supabase.createClient(url, key, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
      cloudMode = true;
      if (loginButton) loginButton.disabled = false;
      setCloudStatus('', 'info');
      $('#loginUsername').placeholder = 'Enter your account email';
      const label = $('label[for="loginUsername"]');
      if (label) label.textContent = 'Email address';
      return true;
    } catch (error) {
      console.error('Supabase initialization failed:', error);
      cloudMode = false;
      supabaseClient = null;
      if (loginButton) loginButton.disabled = true;
      setCloudStatus('Sign-in is temporarily unavailable. Please contact the school administrator.', 'error');
      return false;
    }
  }

  function mapCloudProfile(profile) {
    return {
      id: profile.user_id,
      username: profile.email || '',
      email: profile.email || '',
      displayName: profile.display_name || profile.email || 'Portal user',
      role: profile.role,
      linkedId: profile.linked_record_id || null,
      active: profile.active !== false
    };
  }

  async function loadCloudProfileAndState(authUser) {
    const { data: profile, error: profileError } = await supabaseClient
      .from('profiles')
      .select('user_id,email,display_name,role,linked_record_id,active')
      .eq('user_id', authUser.id)
      .maybeSingle();
    if (profileError) throw profileError;
    if (!profile || profile.active === false) {
      await supabaseClient.auth.signOut();
      throw new Error('This account is not active or has not been assigned a portal role. Contact the administrator.');
    }

    const { data: result, error: stateError } = await supabaseClient.rpc('get_class_scheduler_state');
    if (stateError) throw stateError;
    const payload = result?.payload || {};
    cloudRevision = Number(result?.revision || 0);
    // A new cloud workspace starts empty; initial records are used when no cloud workspace is connected.
    const seed = makeEmptyWorkspace();
    const nextState = { ...seed, ...payload };
    nextState.version = 2;
    nextState.createdAt = payload.createdAt || seed.createdAt;
    nextState.users = [mapCloudProfile(profile)];
    if (profile.role === 'admin') {
      const { data: profiles, error: usersError } = await supabaseClient
        .from('profiles')
        .select('user_id,email,display_name,role,linked_record_id,active,created_at')
        .order('created_at', { ascending: true });
      if (usersError) throw usersError;
      nextState.users = (profiles || []).map(mapCloudProfile);
    }
    state = nextState;

    if (!payload || Object.keys(payload).length === 0) {
      if (profile.role === 'admin') {
        const initialPayload = clone(state);
        delete initialPayload.users;
        const { data: revision, error: initializeError } = await supabaseClient.rpc('save_class_scheduler_state', {
          p_payload: initialPayload,
          p_expected_revision: cloudRevision
        });
        if (initializeError) throw initializeError;
        cloudRevision = Number(revision ?? 1);
      } else {
        throw new Error('The school database has not been initialized yet. Ask the administrator to sign in first.');
      }
    }
    return mapCloudProfile(profile);
  }

  async function pushCloudState(isInitial = false) {
    if (!cloudMode || !supabaseClient || !currentUser || currentUser.role !== 'admin') return;
    if (cloudSaveInProgress) { cloudSaveQueued = true; return; }
    cloudSaveInProgress = true;
    try {
      const payload = clone(state);
      delete payload.users; // Authentication accounts live in Supabase Auth + profiles, never in the timetable JSON.
      const { data, error } = await supabaseClient.rpc('save_class_scheduler_state', {
        p_payload: payload,
        p_expected_revision: cloudRevision
      });
      if (error) {
        if (/revision|changed|conflict/i.test(error.message || '')) {
          showToast('The cloud data changed in another session. Refresh the page before saving again.', 'error');
        } else {
          showToast(`Cloud save failed: ${error.message}`, 'error');
        }
        console.error('Cloud save error:', error);
      } else {
        cloudRevision = Number(data ?? cloudRevision + 1);
        if (isInitial) console.info('Initial workspace created in the cloud database.');
      }
    } catch (error) {
      showToast(`Cloud save failed: ${error.message || 'Unknown error'}`, 'error');
      console.error(error);
    } finally {
      cloudSaveInProgress = false;
      if (cloudSaveQueued) {
        cloudSaveQueued = false;
        pushCloudState();
      }
    }
  }

  function queueCloudSave() {
    if (!cloudMode || currentUser?.role !== 'admin') return;
    window.clearTimeout(cloudSaveTimer);
    cloudSaveTimer = window.setTimeout(() => pushCloudState(), 650);
  }

  async function flushCloudState() {
    if (!cloudMode || currentUser?.role !== 'admin') return;
    window.clearTimeout(cloudSaveTimer);
    cloudSaveTimer = null;
    // Wait for a currently running debounced save, then write the latest in-memory state.
    while (cloudSaveInProgress) {
      await new Promise(resolve => window.setTimeout(resolve, 40));
    }
    await pushCloudState();
  }

  async function restoreCloudSession() {
    if (!cloudMode) return;
    try {
      const { data, error } = await supabaseClient.auth.getSession();
      if (error) throw error;
      const authUser = data?.session?.user;
      if (!authUser) return;
      const profile = await loadCloudProfileAndState(authUser);
      signInAs(profile);
    } catch (error) {
      console.error('Could not restore cloud session:', error);
      showToast('Your previous session could not be restored. Please sign in again.', 'error');
    }
  }

  async function getFunctionErrorMessage(error) {
    // Supabase FunctionsHttpError stores the Response in error.context.
    // Read its JSON body so the UI shows the server's useful explanation.
    try {
      const response = error?.context;
      if (response && typeof response.clone === 'function') {
        const body = await response.clone().json();
        if (body?.error) return String(body.error);
        if (body?.message) return String(body.message);
      }
    } catch { /* Keep the SDK message when the response has no JSON body. */ }
    return error?.message || 'The account request failed. Check the Edge Function logs.';
  }

  async function handleCloudAccountSave(form) {
    const id = form.dataset.id || null;
    const values = new FormData(form);
    const payload = {
      action: id ? 'update' : 'create',
      user_id: id,
      email: String(values.get('email') || '').trim().toLowerCase(),
      password: String(values.get('password') || ''),
      display_name: String(values.get('displayName') || '').trim(),
      role: String(values.get('role') || 'student'),
      linked_record_id: String(values.get('linkedId') || '') || null,
      active: form.querySelector('[name="active"]')?.checked !== false
    };
    if (payload.role === 'admin') payload.linked_record_id = null;
    if (!payload.email || !payload.display_name || !payload.role) return showToast('Complete the account details.', 'error');
    if (payload.role === 'teacher' && !state.teachers.some(item => item.id === payload.linked_record_id)) return showToast('Link the teacher account to an existing teacher record.', 'error');
    if (payload.role === 'student' && !state.students.some(item => item.id === payload.linked_record_id)) return showToast('Link the student account to an existing student record.', 'error');
    if (!id && payload.password.length < 10) return showToast('Use an initial password with at least 10 characters.', 'error');
    if (payload.password && payload.password.length < 10) return showToast('A new password must contain at least 10 characters.', 'error');
    const submit = $('button[type="submit"]', form);
    if (submit) { submit.disabled = true; submit.textContent = 'Saving account…'; }
    try {
      // A teacher/student account must link to a school record that already exists
      // in the shared workspace. Flush the last record edit before asking the
      // Edge Function to validate that link in PostgreSQL.
      if (!id && payload.role !== 'admin') await flushCloudState();
      const { data, error } = await supabaseClient.functions.invoke('manage-account', { body: payload });
      if (error) throw new Error(await getFunctionErrorMessage(error));
      if (data?.error) throw new Error(data.error);
      if (!data?.profile) throw new Error('Supabase did not return the saved account profile.');
      const profile = mapCloudProfile(data.profile);
      if (id) {
        const index = state.users.findIndex(item => item.id === id);
        if (index >= 0) state.users[index] = profile;
      } else {
        state.users.push(profile);
      }
      $('#modalRoot').innerHTML = '';
      saveState(`${id ? 'Updated' : 'Created'} cloud account for ${profile.email}.`);
      showToast(`Account ${id ? 'updated' : 'created'} successfully in Supabase.`);
      renderApp();
    } catch (error) {
      console.error('Account save failed:', error);
      if (submit) { submit.disabled = false; submit.textContent = id ? 'Save changes' : 'Create account'; }
      showToast(error.message || 'The cloud account could not be saved.', 'error');
    }
  }

  async function deleteCloudAccount(id) {
    if (!cloudMode || id === currentUser?.id) return showToast('You cannot delete the account currently signed in.', 'error');
    const record = byId(state.users, id);
    if (!record || !window.confirm(`Permanently delete the account for ${record.email || record.displayName}?`)) return;
    try {
      const { data, error } = await supabaseClient.functions.invoke('manage-account', { body: { action: 'delete', user_id: id } });
      if (error) throw new Error(await getFunctionErrorMessage(error));
      if (data?.error) throw new Error(data.error);
      state.users = state.users.filter(item => item.id !== id);
      saveState(`Deleted cloud account ${record.email || record.displayName}.`);
      showToast('Account deleted from cloud authentication.');
      renderApp();
    } catch (error) {
      console.error('Account deletion failed:', error);
      showToast(error.message || 'The account could not be deleted.', 'error');
    }
  }

  function makeSeedData() {
    const subjects = [
      { id: 'sub_dsmath101', code: 'DSMATH101', name: 'Discrete Mathematics', units: 3, classification: 'major', lectureHours: 2, labHours: 3, weeklyHours: 5, roomType: 'lecture', active: true },
      { id: 'sub_cc21dstruc', code: 'CC21DSTRUC', name: 'Data Structures and Algorithms', units: 3, classification: 'major', lectureHours: 2, labHours: 3, weeklyHours: 5, roomType: 'lecture', active: true },
      { id: 'sub_itess', code: 'IT21ITESS', name: 'Cisco IT Essentials', units: 3, classification: 'major', lectureHours: 2, labHours: 3, weeklyHours: 5, roomType: 'lecture', active: true },
      { id: 'sub_webprog', code: 'IT21WEBPROG', name: 'Web Programming', units: 3, classification: 'major', lectureHours: 2, labHours: 3, weeklyHours: 5, roomType: 'lecture', active: true },
      { id: 'sub_dbsys', code: 'CC21DBSYS', name: 'Database Systems Fundamentals', units: 3, classification: 'major', lectureHours: 2, labHours: 3, weeklyHours: 5, roomType: 'lecture', active: true },
      { id: 'sub_soc101', code: 'SOCSCI101', name: 'Understanding the Self for IT', units: 3, classification: 'minor', lectureHours: 0, labHours: 0, weeklyHours: 3, roomType: 'lecture', active: true },
      { id: 'sub_soc104', code: 'SOCSCI104', name: 'Art Appreciation for IT', units: 3, classification: 'minor', lectureHours: 0, labHours: 0, weeklyHours: 3, roomType: 'lecture', active: true },
      { id: 'sub_pathfit3', code: 'PATHFIT3', name: 'Physical Activity Towards Health and Fitness III', units: 2, classification: 'minor', lectureHours: 0, labHours: 0, weeklyHours: 2, roomType: 'gym', active: true },
      { id: 'sub_acctna', code: 'ACCTNA101', name: 'Accounting for Non-Accountants', units: 3, classification: 'minor', lectureHours: 0, labHours: 0, weeklyHours: 3, roomType: 'lecture', active: true },
      { id: 'sub_gelect', code: 'GELECT1', name: 'General Education Elective', units: 2, classification: 'minor', lectureHours: 0, labHours: 0, weeklyHours: 2, roomType: 'lecture', active: true }
    ];

    const teachers = [
      { id: 'tea_01', code: 'T001', name: 'Alex Rivera', department: 'Computing Studies', qualifiedSubjectIds: ['sub_dsmath101', 'sub_cc21dstruc'], maxWeeklyHours: 30, maxDailyHours: 8, availableDays: [...DAYS], availableStart: 420, availableEnd: 1260, preferredStart: 480, preferredEnd: 1080, active: true },
      { id: 'tea_02', code: 'T002', name: 'Jamie Santos', department: 'Computing Studies', qualifiedSubjectIds: ['sub_cc21dstruc', 'sub_itess'], maxWeeklyHours: 30, maxDailyHours: 8, availableDays: [...DAYS], availableStart: 420, availableEnd: 1260, preferredStart: 480, preferredEnd: 1080, active: true },
      { id: 'tea_03', code: 'T003', name: 'Morgan Cruz', department: 'Computing Studies', qualifiedSubjectIds: ['sub_itess', 'sub_webprog'], maxWeeklyHours: 30, maxDailyHours: 8, availableDays: [...DAYS], availableStart: 420, availableEnd: 1260, preferredStart: 480, preferredEnd: 1080, active: true },
      { id: 'tea_04', code: 'T004', name: 'Taylor Garcia', department: 'Computing Studies', qualifiedSubjectIds: ['sub_webprog', 'sub_dbsys'], maxWeeklyHours: 30, maxDailyHours: 8, availableDays: [...DAYS], availableStart: 420, availableEnd: 1260, preferredStart: 480, preferredEnd: 1080, active: true },
      { id: 'tea_05', code: 'T005', name: 'Casey Mendoza', department: 'Computing Studies', qualifiedSubjectIds: ['sub_dbsys', 'sub_dsmath101'], maxWeeklyHours: 30, maxDailyHours: 8, availableDays: [...DAYS], availableStart: 420, availableEnd: 1260, preferredStart: 480, preferredEnd: 1080, active: true },
      { id: 'tea_06', code: 'T006', name: 'Jordan Flores', department: 'General Education', qualifiedSubjectIds: ['sub_soc101', 'sub_soc104', 'sub_acctna', 'sub_gelect'], maxWeeklyHours: 30, maxDailyHours: 8, availableDays: [...DAYS], availableStart: 420, availableEnd: 1260, preferredStart: 480, preferredEnd: 1080, active: true },
      { id: 'tea_07', code: 'T007', name: 'Riley Dizon', department: 'General Education', qualifiedSubjectIds: ['sub_soc104', 'sub_acctna', 'sub_gelect'], maxWeeklyHours: 30, maxDailyHours: 8, availableDays: [...DAYS], availableStart: 420, availableEnd: 1260, preferredStart: 480, preferredEnd: 1080, active: true },
      { id: 'tea_08', code: 'T008', name: 'Avery Lim', department: 'Physical Education', qualifiedSubjectIds: ['sub_pathfit3'], maxWeeklyHours: 18, maxDailyHours: 6, availableDays: [...DAYS], availableStart: 420, availableEnd: 1260, preferredStart: 480, preferredEnd: 1080, active: true },
      { id: 'tea_09', code: 'T009', name: 'Quinn Reyes', department: 'General Education', qualifiedSubjectIds: ['sub_acctna', 'sub_soc101', 'sub_gelect'], maxWeeklyHours: 30, maxDailyHours: 8, availableDays: [...DAYS], availableStart: 420, availableEnd: 1260, preferredStart: 480, preferredEnd: 1080, active: true },
      { id: 'tea_10', code: 'T010', name: 'Drew Navarro', department: 'Computing Studies', qualifiedSubjectIds: ['sub_dsmath101', 'sub_webprog', 'sub_itess'], maxWeeklyHours: 30, maxDailyHours: 8, availableDays: [...DAYS], availableStart: 420, availableEnd: 1260, preferredStart: 480, preferredEnd: 1080, active: true }
    ];

    const programs = [
      { id: 'pro_bsit', code: 'BSIT', name: 'Bachelor of Science in Information Technology', yearLevels: [1, 2, 3, 4], active: true },
      { id: 'pro_bscs', code: 'BSCS', name: 'Bachelor of Science in Computer Science', yearLevels: [1, 2, 3, 4], active: true }
    ];
    const curriculum = [
      { id: 'cur_bsit2s1', programId: 'pro_bsit', yearLevel: 2, semester: 'First Semester', subjectIds: subjects.map(s => s.id) },
      { id: 'cur_bscs1s1', programId: 'pro_bscs', yearLevel: 1, semester: 'First Semester', subjectIds: ['sub_dsmath101', 'sub_itess', 'sub_webprog', 'sub_soc101', 'sub_pathfit3', 'sub_gelect'] }
    ];
    const sections = [
      { id: 'sec_bsit2a', code: 'BSIT-2A', academicYear: '2026–2027', programId: 'pro_bsit', yearLevel: 2, semester: 'First Semester', studentCount: 42, customSubjectIds: null, active: true },
      { id: 'sec_bsit2b', code: 'BSIT-2B', academicYear: '2026–2027', programId: 'pro_bsit', yearLevel: 2, semester: 'First Semester', studentCount: 48, customSubjectIds: null, active: true },
      { id: 'sec_bsit2c', code: 'BSIT-2C', academicYear: '2026–2027', programId: 'pro_bsit', yearLevel: 2, semester: 'First Semester', studentCount: 36, customSubjectIds: null, active: true },
      { id: 'sec_bscs1a', code: 'BSCS-1A', academicYear: '2026–2027', programId: 'pro_bscs', yearLevel: 1, semester: 'First Semester', studentCount: 32, customSubjectIds: null, active: true }
    ];
    const rooms = [];
    for (let i = 1; i <= 5; i++) rooms.push({ id: `room_lecture_${i}`, code: `MB10${i}`, name: `Main Building ${100 + i}`, type: 'lecture', capacity: 40, availableDays: [...DAYS], status: 'Available' });
    for (let i = 1; i <= 5; i++) rooms.push({ id: `room_lab_${i}`, code: `CLAB${i}`, name: `Computer Laboratory ${i}`, type: 'lab', capacity: 25, availableDays: [...DAYS], status: 'Available' });
    rooms.push({ id: 'room_gym', code: 'GYM', name: 'School Gymnasium', type: 'gym', capacity: null, availableDays: [...DAYS], status: 'Available' });
    rooms.push({ id: 'room_online', code: 'ONLINE', name: 'Synchronous Online Class', type: 'online', capacity: null, availableDays: [...DAYS], status: 'Available' });

    const students = [
      { id: 'stu_01', studentNo: 'STU-001', name: 'Sam Mendoza', sectionId: 'sec_bsit2a', enrolledSubjectIds: [], batchIndex: null, active: true },
      { id: 'stu_02', studentNo: 'STU-002', name: 'Chris Dizon', sectionId: 'sec_bsit2b', enrolledSubjectIds: [], batchIndex: null, active: true },
      { id: 'stu_03', studentNo: 'STU-003', name: 'Pat Reyes', sectionId: 'sec_bscs1a', enrolledSubjectIds: [], batchIndex: null, active: true }
    ];
    const users = []; // Account identities are supplied only by Supabase Auth.

    return {
      version: 1,
      createdAt: nowISO(),
      settings: { academicYear: '2026–2027', semester: 'First Semester', days: [...DAYS], startTime: START_OF_DAY, endTime: END_OF_DAY, interval: INTERVAL, preferences: { reduceGaps: true, distributeSubjects: true, respectPreferredTimes: true, avoidLongConsecutive: true, maxConsecutiveHours: 5 } },
      programs, curriculum, sections, subjects, teachers, rooms, students, users,
      consultationPeriods: [], schedules: [], activityLog: [{ id: uid('log'), at: nowISO(), text: 'Initial academic records created.' }]
    };
  }

  function makeEmptyWorkspace() {
    const empty = makeSeedData();
    for (const key of ['programs','curriculum','sections','subjects','teachers','rooms','students','users','consultationPeriods','schedules']) empty[key] = [];
    empty.activityLog = [{ id: uid('log'), at: nowISO(), text: 'Cloud workspace initialized.' }];
    delete empty.lastGeneration;
    return empty;
  }

  let state = loadState();
  let currentUser = null;
  let currentPage = 'dashboard';
  let scheduleFilters = { day: 'all', teacherId: 'all', sectionId: 'all', roomId: 'all', view: 'calendar' };
  let reportType = 'overview';
  let generatorResult = null;
  let communityPosts = [];
  let communityCategoryFilter = 'all';
  let communityStatusFilter = 'all';
  let communityLoading = false;

  function loadState() {
    try {
      const raw = safeLocalGet(STORAGE_KEY);
      if (!raw) return makeSeedData();
      const parsed = JSON.parse(raw);
      const seed = makeSeedData();
      // Add any new schema collections if an older saved copy is opened.
      for (const key of Object.keys(seed)) if (parsed[key] === undefined) parsed[key] = seed[key];
      if (!parsed.settings) parsed.settings = seed.settings;
      return parsed;
    } catch (error) {
      console.warn('Saved data could not be read. Loading initial records instead.', error);
      return makeSeedData();
    }
  }

  function saveState(logText = '') {
    if (logText) {
      state.activityLog = state.activityLog || [];
      state.activityLog.unshift({ id: uid('log'), at: nowISO(), text: logText });
      state.activityLog = state.activityLog.slice(0, 100);
    }
    try {
      // Keep a local cache for recovery, but Supabase is authoritative in cloud mode.
      const localSnapshot = clone(state);
      if (cloudMode) delete localSnapshot.users;
      safeLocalSet(STORAGE_KEY, JSON.stringify(localSnapshot));
    } catch (error) {
      showToast('Could not update the local recovery cache.', 'error');
      console.error(error);
    }
    if (cloudMode && currentUser?.role === 'admin') queueCloudSave();
  }

  function programName(id) { return byId(state.programs, id)?.code || 'Unknown program'; }
  function teacherName(id) { return byId(state.teachers, id)?.name || 'Unassigned'; }
  function subjectName(id) { const s = byId(state.subjects, id); return s ? `${s.code} · ${s.name}` : 'Unknown subject'; }
  function roomName(id) { const r = byId(state.rooms, id); return r ? r.code : 'Unassigned'; }
  function sectionName(id) { return byId(state.sections, id)?.code || 'Unknown section'; }
  function studentSection(student) { return byId(state.sections, student.sectionId); }
  function getStudentSectionIds(student) { return [...new Set([student?.sectionId, ...(student?.additionalSectionIds || [])].filter(Boolean))]; }
  function defaultMeetingType(subject) {
    if (!subject || subject.classification === 'major') return 'lecture';
    return ['online','gym','other'].includes(subject.roomType) ? subject.roomType : 'lecture';
  }
  function requiredRoomType(meetingType, subject) {
    if (['lab','online','gym','other'].includes(meetingType)) return meetingType;
    return subject?.classification === 'minor' && subject.roomType && subject.roomType !== 'lecture' ? subject.roomType : 'lecture';
  }
  function getCurriculumSubjectIds(section) {
    if (Array.isArray(section.customSubjectIds)) return section.customSubjectIds;
    return state.curriculum.find(c => c.programId === section.programId && Number(c.yearLevel) === Number(section.yearLevel) && c.semester === section.semester)?.subjectIds || [];
  }
  function getSectionStudents(sectionId) { return state.students.filter(s => s.active !== false && s.sectionId === sectionId); }
  function getLargestLabCapacity() {
    const capacities = state.rooms.filter(r => r.type === 'lab' && r.status === 'Available' && Number(r.capacity) > 0).map(r => Number(r.capacity));
    return capacities.length ? Math.max(...capacities) : 25;
  }
  function getSectionBatchSizes(section) {
    if (Array.isArray(section?.labBatchSizes) && section.labBatchSizes.length) return section.labBatchSizes.map(Number);
    const capacity = getLargestLabCapacity();
    const total = Math.max(1, Number(section?.studentCount) || 1);
    const count = Math.max(1, Math.ceil(total / capacity));
    return Array.from({ length: count }, (_, index) => Math.min(capacity, total - index * capacity));
  }

  function teacherAccount(teacherId) { return state.users.find(u => u.role === 'teacher' && u.linkedId === teacherId); }
  function studentAccount(studentId) { return state.users.find(u => u.role === 'student' && u.linkedId === studentId); }
  function logAndRender(message) { saveState(message); renderApp(); }

  function showToast(message, type = 'success') {
    const region = $('#toastRegion');
    if (!region) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    region.appendChild(toast);
    window.setTimeout(() => toast.remove(), 3800);
  }

  async function init() {
    initializeTheme();
    initializeFontControls();
    initializeNavigationSizing();
    initializeCloudConnection();
    $('#footerYear').textContent = String(new Date().getFullYear());
    $('#loginForm').addEventListener('submit', handleLogin);
    const focusLogin = () => $('.login-panel-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('#showLoginButton')?.addEventListener('click', focusLogin);
    $('#showLoginButtonHero')?.addEventListener('click', focusLogin);
    $('#logoutButton').addEventListener('click', logout);

    const profileWrap = $('.profile-wrap');
    const profileButton = $('#profileButton');
    const profileMenu = $('#profileMenu');
    const supportsHover = window.matchMedia?.('(hover: hover) and (pointer: fine)').matches ?? false;
    const openProfileMenu = () => {
      profileMenu.classList.remove('hidden');
      profileButton.setAttribute('aria-expanded', 'true');
    };
    const closeProfileMenu = () => {
      profileMenu.classList.add('hidden');
      profileButton.setAttribute('aria-expanded', 'false');
    };
    if (supportsHover) {
      profileWrap.addEventListener('mouseenter', openProfileMenu);
      profileWrap.addEventListener('mouseleave', closeProfileMenu);
    }
    profileWrap.addEventListener('focusin', openProfileMenu);
    profileWrap.addEventListener('focusout', event => {
      if (!profileWrap.contains(event.relatedTarget)) closeProfileMenu();
    });
    profileButton.addEventListener('click', () => {
      if (supportsHover) return;
      const opening = profileMenu.classList.contains('hidden');
      if (opening) openProfileMenu(); else closeProfileMenu();
    });
    $('#profileAccount').addEventListener('click', () => { closeProfileMenu(); openAccountDetails(); });
    const mainNav = $('#mainNav');
    mainNav.addEventListener('click', handleNavClick);
    mainNav.addEventListener('pointerover', event => {
      const wrap = event.target.closest('.nav-more-wrap');
      const toggle = event.target.closest('[data-nav-more-toggle]');
      const supportsHover = window.matchMedia?.('(hover: hover) and (pointer: fine)').matches ?? false;
      if (!wrap || !toggle || wrap.hidden || !supportsHover || (event.relatedTarget && wrap.contains(event.relatedTarget))) return;
      // A short hover delay prevents the menu opening accidentally when layout reflows under a stationary pointer.
      scheduleOpenMoreMenu(140);
    });
    mainNav.addEventListener('pointerout', event => {
      const wrap = event.target.closest('.nav-more-wrap');
      const supportsHover = window.matchMedia?.('(hover: hover) and (pointer: fine)').matches ?? false;
      if (!wrap || !supportsHover || (event.relatedTarget && wrap.contains(event.relatedTarget))) return;
      window.clearTimeout(navOpenTimer);
      scheduleCloseMoreMenu(180);
    });
    mainNav.addEventListener('focusout', event => {
      const wrap = event.target.closest('.nav-more-wrap');
      if (wrap && !wrap.contains(event.relatedTarget)) scheduleCloseMoreMenu(0);
    });
    document.addEventListener('click', event => {
      const moreWrap = $('.nav-more-wrap');
      if (moreWrap && !moreWrap.contains(event.target)) closeMoreMenu();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        const wasOpen = $('#navMoreMenu') && !$('#navMoreMenu').hidden;
        closeMoreMenu();
        if (wasOpen) $('[data-nav-more-toggle]')?.focus();
      }
    });
    $('#viewRoot').addEventListener('click', handleViewClick);
    $('#viewRoot').addEventListener('change', handleViewChange);
    $('#viewRoot').addEventListener('input', handleViewInput);
    $('#viewRoot').addEventListener('submit', handleViewSubmit);
    $('#modalRoot').addEventListener('click', handleModalClick);
    $('#modalRoot').addEventListener('submit', handleModalSubmit);
    $('#modalRoot').addEventListener('change', handleModalChange);
    $('#jsonImportInput').addEventListener('change', importJSONFile);
    $('#csvImportInput').addEventListener('change', importCSVFile);
    document.addEventListener('click', event => {
      if (!event.target.closest('.profile-wrap')) closeProfileMenu();
      const themeToggle = event.target.closest('[data-theme-toggle]');
      if (themeToggle) {
        applyTheme(document.body.classList.contains('dark') ? 'light' : 'dark');
        scheduleNavigationLayout();
        return;
      }
      const fontAction = event.target.closest('[data-font-action]');
      if (fontAction) {
        handleFontAdjustment(fontAction.dataset.fontAction);
        return;
      }
      const toggle = event.target.closest('[data-password-target]');
      if (toggle) {
        const input = document.getElementById(toggle.dataset.passwordTarget);
        if (!input) return;
        const showing = input.type === 'password';
        input.type = showing ? 'text' : 'password';
        toggle.textContent = showing ? 'Hide' : 'Show';
        toggle.setAttribute('aria-label', showing ? 'Hide password' : 'Show password');
        toggle.setAttribute('aria-pressed', String(showing));
      }
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeProfileMenu();
    });
    if (cloudMode) await restoreCloudSession();
  }

  async function handleLogin(event) {
    event.preventDefault();
    const username = $('#loginUsername').value.trim();
    const password = $('#loginPassword').value;
    const submitButton = $('button[type="submit"]', $('#loginForm'));
    if (!cloudMode || !supabaseClient) {
      setCloudStatus('Sign-in is temporarily unavailable. Please contact the school administrator.', 'error');
      showToast('Sign-in is temporarily unavailable. Please contact the school administrator.', 'error');
      return;
    }
    if (submitButton) { submitButton.disabled = true; submitButton.textContent = 'Signing in…'; }
    try {
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email: username.toLowerCase(), password });
      if (error) throw error;
      const profile = await loadCloudProfileAndState(data.user);
      signInAs(profile);
    } catch (error) {
      console.error('Cloud login failed:', error);
      showToast(error.message || 'Unable to sign in. Check your email and password.', 'error');
    } finally {
      if (submitButton) { submitButton.disabled = false; submitButton.innerHTML = 'Sign in <span aria-hidden="true">→</span>'; }
    }
  }

  function signInAs(user) {
    currentUser = user;
    safeSessionSet('classSchedulerLastRole', user.role);
    $('#loginScreen').classList.add('hidden');
    $('#workspace').classList.remove('hidden');
    $('#footerYear').textContent = String(new Date().getFullYear());
    $('#workspaceAcademicPeriod').textContent = `${state.settings.academicYear} · ${state.settings.semester}`;
    currentPage = user.role === 'admin' ? 'dashboard' : 'my-schedule';
    renderApp();
  }

  async function logout() {
    if (cloudMode && supabaseClient) {
      try { await supabaseClient.auth.signOut(); } catch (error) { console.error(error); }
    }
    currentUser = null;
    safeSessionRemove('classSchedulerLastRole');
    $('#workspace').classList.add('hidden');
    $('#loginScreen').classList.remove('hidden');
    $('#loginPassword').value = '';
    $('#profileMenu').classList.add('hidden');
    $('#profileButton').setAttribute('aria-expanded', 'false');
  }

  function setMoreMenuOpen(open) {
    const menu = $('#navMoreMenu');
    const toggle = $('[data-nav-more-toggle]');
    const wrap = $('.nav-more-wrap');
    if (!menu || !toggle || !wrap || wrap.hidden) return;
    window.clearTimeout(navCloseTimer);
    window.clearTimeout(navOpenTimer);
    menu.hidden = !open;
    toggle.setAttribute('aria-expanded', String(Boolean(open)));
    wrap.classList.toggle('is-open', Boolean(open));
  }

  function closeMoreMenu() {
    window.clearTimeout(navCloseTimer);
    window.clearTimeout(navOpenTimer);
    const menu = $('#navMoreMenu');
    const toggle = $('[data-nav-more-toggle]');
    const wrap = $('.nav-more-wrap');
    if (!menu || !toggle || !wrap) return;
    menu.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    wrap.classList.remove('is-open');
  }

  function scheduleCloseMoreMenu(delay = 180) {
    window.clearTimeout(navCloseTimer);
    navCloseTimer = window.setTimeout(() => {
      const wrap = $('.nav-more-wrap');
      const menu = $('#navMoreMenu');
      const focusInside = Boolean(wrap && wrap.contains(document.activeElement));
      const pointerInside = Boolean(wrap && wrap.matches(':hover'));
      if (wrap && menu && !focusInside && !pointerInside) closeMoreMenu();
    }, delay);
  }

  function scheduleOpenMoreMenu(delay = 140) {
    window.clearTimeout(navOpenTimer);
    window.clearTimeout(navCloseTimer);
    navOpenTimer = window.setTimeout(() => {
      const wrap = $('.nav-more-wrap');
      if (wrap && !wrap.hidden && wrap.matches(':hover')) setMoreMenuOpen(true);
    }, delay);
  }

  function handleNavClick(event) {
    const moreToggle = event.target.closest('[data-nav-more-toggle]');
    if (moreToggle) {
      const menu = $('#navMoreMenu');
      if (!menu) return;
      const supportsHover = window.matchMedia?.('(hover: hover) and (pointer: fine)').matches ?? false;
      // A mouse click happens after pointerenter has already opened the menu; keep it open.
      // Keyboard and touch users can still toggle it with the button.
      if (supportsHover && event.detail > 0) setMoreMenuOpen(true);
      else setMoreMenuOpen(menu.hidden);
      return;
    }

    const button = event.target.closest('[data-page]');
    if (!button) return;
    closeMoreMenu();
    currentPage = button.dataset.page;
    generatorResult = null;
    renderApp();
  }

  // Re-render the signed-in workspace after login, navigation, or data changes.
  // This function must remain in the application: signInAs() calls it immediately
  // after a successful Supabase login.
  function renderApp() {
    if (!currentUser) return;
    renderNavigation();
    const profileName = $('#profileName');
    const profileRole = $('#profileRole');
    const profileAvatar = $('#profileAvatar');
    const academicPeriod = $('#workspaceAcademicPeriod');
    if (profileName) profileName.textContent = currentUser.displayName || currentUser.username || currentUser.email || 'Portal user';
    if (profileRole) profileRole.textContent = roleLabel(currentUser.role);
    if (profileAvatar) profileAvatar.textContent = (currentUser.displayName || currentUser.username || currentUser.email || 'U').slice(0, 1).toUpperCase();
    renderCurrentPage();
    if (academicPeriod) academicPeriod.textContent = `${state.settings.academicYear} · ${state.settings.semester}`;
    scheduleNavigationLayout();
  }

  function roleLabel(role) {
    return role === 'admin' ? 'Administrator' : role === 'teacher' ? 'Teacher' : 'Student';
  }

  function renderNavItem([page, label, icon], menuItem = false, activePage = currentPage) {
    const recordPages = ['teachers','programs','sections','subjects','rooms','students'];
    const normalizedActive = recordPages.includes(activePage) ? 'records' : activePage;
    return `<button class="${menuItem ? 'nav-more-item' : 'nav-link'} ${normalizedActive === page ? 'active' : ''}" type="button" data-page="${page}" ${normalizedActive === page ? 'aria-current="page"' : ''}><span class="nav-item-icon" aria-hidden="true">${icon}</span><span>${label}</span></button>`;
  }

  function renderNavigation() {
    currentNavItems = NAV_ITEMS[currentUser.role] || NAV_ITEMS.student;
    const nav = $('#mainNav');
    if (!nav) return;
    const measureItems = currentNavItems.map(item => renderNavItem(item).replace('data-page=', 'data-nav-measure-item data-page=')).join('');
    nav.innerHTML = `
      <div class="nav-measure" aria-hidden="true" inert>
        ${measureItems}
        <button class="nav-link nav-more-toggle" type="button" data-nav-measure-more tabindex="-1"><span>More</span></button>
      </div>
      <div class="nav-visible-items" data-nav-visible-items></div>
      <div class="nav-more-wrap" data-nav-more-wrap hidden>
        <button class="nav-link nav-more-toggle" type="button" data-nav-more-toggle aria-expanded="false" aria-controls="navMoreMenu"><span>More</span></button>
        <div id="navMoreMenu" class="nav-more-menu" aria-label="Additional navigation pages" hidden></div>
      </div>`;
    scheduleNavigationLayout();
  }

  function updateNavigationOverflow() {
    const nav = $('#mainNav');
    const visible = $('[data-nav-visible-items]', nav || document);
    const moreWrap = $('[data-nav-more-wrap]', nav || document);
    const menu = $('#navMoreMenu');
    const measure = $('.nav-measure', nav || document);
    if (!nav || !visible || !moreWrap || !menu || !measure || !currentNavItems.length) return;
    if (!nav.isConnected || nav.clientWidth < 1 || nav.getClientRects().length === 0) return;

    const itemWidths = [...measure.querySelectorAll('[data-nav-measure-item]')]
      .map(button => button.getBoundingClientRect().width);
    const moreWidth = $('[data-nav-measure-more]', measure)?.getBoundingClientRect().width || 78;
    const gap = parseFloat(getComputedStyle(nav).columnGap) || 5;
    const available = nav.clientWidth;
    const totalItemsWidth = itemWidths.reduce((sum, width) => sum + width, 0) + Math.max(0, itemWidths.length - 1) * gap;

    let visibleCount = currentNavItems.length;
    if (totalItemsWidth > available + 1) {
      visibleCount = 0;
      let prefixWidth = 0;
      // Find the largest leading set that fits beside the More button.
      for (let count = 0; count < currentNavItems.length; count++) {
        if (count > 0) prefixWidth += gap;
        prefixWidth += itemWidths[count] || 0;
        const neededWidth = prefixWidth + gap + moreWidth;
        if (neededWidth <= available + 1) visibleCount = count;
        else break;
      }
    }

    const visibleItems = currentNavItems.slice(0, visibleCount);
    const overflowItems = currentNavItems.slice(visibleCount);
    const activePage = ['teachers','programs','sections','subjects','rooms','students'].includes(currentPage) ? 'records' : currentPage;
    const moreIsActive = overflowItems.some(([page]) => page === activePage);

    visible.innerHTML = visibleItems.map(item => renderNavItem(item, false, currentPage)).join('');
    menu.innerHTML = overflowItems.map(item => renderNavItem(item, true, currentPage)).join('');
    moreWrap.hidden = overflowItems.length === 0;
    const toggle = $('[data-nav-more-toggle]', moreWrap);
    if (toggle) {
      toggle.classList.toggle('active', moreIsActive);
      if (moreIsActive) toggle.setAttribute('aria-current', 'page');
      else toggle.removeAttribute('aria-current');
    }
    if (!overflowItems.length) closeMoreMenu();
    nav.dataset.overflowing = overflowItems.length ? 'true' : 'false';
  }

  function scheduleNavigationLayout() {
    if (navLayoutFrame) cancelAnimationFrame(navLayoutFrame);
    navLayoutFrame = requestAnimationFrame(() => {
      navLayoutFrame = 0;
      updateNavigationOverflow();
    });
  }

  function initializeNavigationSizing() {
    const nav = $('#mainNav');
    if (!nav) return;
    if ('ResizeObserver' in window) {
      navResizeObserver = new ResizeObserver(scheduleNavigationLayout);
      navResizeObserver.observe(nav);
      const actions = $('.topbar-actions');
      if (actions) navResizeObserver.observe(actions);
    }
    window.addEventListener('resize', scheduleNavigationLayout, { passive: true });
    window.addEventListener('orientationchange', scheduleNavigationLayout, { passive: true });
  }

  function renderCurrentPage() {
    const root = $('#viewRoot');
    const pageMap = {
      dashboard: renderDashboard, records: renderRecordsHub, teachers: renderTeachers, programs: renderPrograms, sections: renderSections,
      subjects: renderSubjects, rooms: renderRooms, students: renderStudents, generator: renderGenerator,
      schedules: renderSchedules, reports: renderReports, accounts: renderAccounts, settings: renderSettings,
      'my-schedule': renderMySchedule, 'my-load': renderTeacherLoad, consultation: renderConsultation, 'consultation-admin': renderConsultationAdmin, 'my-subjects': renderStudentSubjects, community: renderCommunity
    };
    const renderer = pageMap[currentPage] || renderDashboard;
    const recordPages = ['teachers','programs','sections','subjects','rooms','students'];
    root.innerHTML = `${recordPages.includes(currentPage) ? '<div class="record-back"><button class="btn btn-quiet btn-small" type="button" data-page="records">← All records</button></div>' : ''}${renderer()}`;
    if (currentPage === 'schedules' || currentPage === 'my-schedule') attachScheduleControls();
    if (currentPage === 'community') void loadCommunityPosts();
  }

  const COMMUNITY_CATEGORIES = {
    schedule_request: 'Schedule change request',
    timetable_question: 'Timetable question',
    announcement: 'Announcement',
    class_update: 'Class update',
    venue_issue: 'Room / online class issue',
    other: 'General discussion'
  };

  function communityDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }

  function renderCommunity() {
    if (!cloudMode || !supabaseClient) {
      return `${pageHeader('Community', 'Class-related discussions, schedule requests, and announcements.')}
        <section class="card"><div class="empty-state"><div class="empty-icon">◉</div><strong>Community is unavailable</strong><p>Please contact the system administrator.</p></div></section>`;
    }
    const sectionOptions = state.sections.map(section => `<option value="${escapeHTML(section.id)}">${escapeHTML(section.code)}</option>`).join('');
    return `${pageHeader('Community', 'Discuss class schedules, raise timetable concerns, and share class announcements.')}
      <section class="card community-compose-card">
        <div class="card-header"><div><h2>Start a discussion</h2><p>Share a scheduling request, ask a question, or post a class update.</p></div><span class="badge red">COMMUNITY</span></div>
        <form id="communityPostForm" class="community-compose-form">
          <div class="form-grid">
            <div class="form-field"><label for="communityCategory">Post type</label><select id="communityCategory" name="category" required>${Object.entries(COMMUNITY_CATEGORIES).map(([value,label])=>`<option value="${value}">${label}</option>`).join('')}</select></div>
            <div class="form-field"><label for="communitySection">Related section (optional)</label><select id="communitySection" name="sectionId"><option value="">General / not section-specific</option>${sectionOptions}</select></div>
            <div class="form-field full"><label for="communityTitle">Title</label><input id="communityTitle" name="title" maxlength="140" required placeholder="Example: Request to review Friday's laboratory schedule"></div>
            <div class="form-field full"><label for="communityBody">Message</label><textarea id="communityBody" name="body" rows="4" maxlength="3000" required placeholder="Explain the concern, question, or announcement. Avoid sharing private student information."></textarea></div>
            <div class="form-field full community-compose-actions"><span class="form-hint">Posts are visible to signed-in members of the school portal. Schedule changes are not applied until approved by an administrator.</span><button class="btn btn-primary" type="submit">Publish post</button></div>
          </div>
        </form>
      </section>
      <section class="community-feed-section">
        <div class="community-feed-toolbar">
          <div><h2>Recent discussions</h2><p>Follow updates and add comments to a discussion.</p></div>
          <div class="community-filters"><select id="communityCategoryFilter" aria-label="Filter community by post type"><option value="all">All post types</option>${Object.entries(COMMUNITY_CATEGORIES).map(([value,label])=>`<option value="${value}">${label}</option>`).join('')}</select><select id="communityStatusFilter" aria-label="Filter community by status"><option value="all">All statuses</option><option value="open">Open</option><option value="in_review">In review</option><option value="resolved">Resolved</option><option value="closed">Closed</option></select><button class="btn btn-secondary btn-small" type="button" data-action="community-refresh">Refresh</button></div>
        </div>
        <div id="communityFeed" class="community-feed" aria-live="polite"><div class="community-loading">Loading discussions…</div></div>
      </section>`;
  }

  async function loadCommunityPosts() {
    const feed = $('#communityFeed');
    if (!feed || !supabaseClient || !currentUser) return;
    communityLoading = true;
    feed.innerHTML = '<div class="community-loading">Loading discussions…</div>';
    try {
      const { data: posts, error: postError } = await supabaseClient
        .from('community_posts')
        .select('id,author_id,author_name,author_role,category,title,body,section_id,section_label,status,created_at,updated_at')
        .order('created_at', { ascending: false })
        .limit(75);
      if (postError) throw postError;
      const postIds = (posts || []).map(post => post.id);
      let comments = [];
      if (postIds.length) {
        const { data, error } = await supabaseClient
          .from('community_comments')
          .select('id,post_id,author_id,author_name,author_role,body,created_at')
          .in('post_id', postIds)
          .order('created_at', { ascending: true });
        if (error) throw error;
        comments = data || [];
      }
      communityPosts = (posts || []).map(post => ({
        ...post,
        comments: comments.filter(comment => comment.post_id === post.id)
      }));
      renderCommunityFeed();
    } catch (error) {
      console.error('Community load failed:', error);
      feed.innerHTML = '<div class="notice danger"><span>!</span><div><strong>Could not load community discussions.</strong>Please refresh the page or contact the school administrator.</div></div>';
    } finally {
      communityLoading = false;
    }
  }

  function renderCommunityFeed() {
    const feed = $('#communityFeed');
    if (!feed) return;
    const visible = communityPosts.filter(post =>
      (communityCategoryFilter === 'all' || post.category === communityCategoryFilter)
      && (communityStatusFilter === 'all' || post.status === communityStatusFilter)
    );
    if (!visible.length) {
      feed.innerHTML = `<div class="empty-state"><div class="empty-icon">◉</div><strong>No discussions found</strong><p>${communityPosts.length ? 'Try another filter to see more posts.' : 'Be the first to start a class-related discussion.'}</p></div>`;
      return;
    }
    feed.innerHTML = visible.map(renderCommunityPost).join('');
  }

  function renderCommunityPost(post) {
    const isAdmin = currentUser?.role === 'admin';
    const isAuthor = post.author_id === currentUser?.id;
    const section = post.section_label || 'General';
    const statusLabel = ({ open:'Open', in_review:'In review', resolved:'Resolved', closed:'Closed' })[post.status] || 'Open';
    const statusClass = post.status === 'resolved' ? 'green' : post.status === 'closed' ? 'gray' : post.status === 'in_review' ? 'yellow' : 'blue';
    const nextStatus = post.status === 'open' ? 'in_review' : post.status === 'in_review' ? 'resolved' : post.status === 'resolved' ? 'open' : 'open';
    const nextLabel = post.status === 'open' ? 'Mark in review' : post.status === 'in_review' ? 'Mark resolved' : 'Reopen';
    const comments = (post.comments || []).map(comment => `<div class="community-comment"><div class="community-comment-avatar">${escapeHTML((comment.author_name || '?').slice(0,1).toUpperCase())}</div><div class="community-comment-content"><div class="community-comment-meta"><strong>${escapeHTML(comment.author_name)}</strong><span class="badge ${comment.author_role === 'admin' ? 'red' : comment.author_role === 'teacher' ? 'blue' : 'green'}">${escapeHTML(roleLabel(comment.author_role))}</span><time>${escapeHTML(communityDate(comment.created_at))}</time>${(comment.author_id === currentUser?.id || isAdmin) ? `<button class="text-action danger-text" type="button" data-action="community-delete-comment" data-id="${comment.id}" aria-label="Delete comment">Delete</button>` : ''}</div><p>${escapeHTML(comment.body)}</p></div></div>`).join('');
    return `<article class="community-post card" data-post-id="${post.id}">
      <div class="community-post-top"><div class="community-post-author"><span class="community-avatar ${post.author_role}">${escapeHTML((post.author_name || '?').slice(0,1).toUpperCase())}</span><div><strong>${escapeHTML(post.author_name || 'Portal member')}</strong><div class="community-post-meta"><span class="badge ${post.author_role === 'admin' ? 'red' : post.author_role === 'teacher' ? 'blue' : 'green'}">${escapeHTML(roleLabel(post.author_role))}</span><time>${escapeHTML(communityDate(post.created_at))}</time></div></div></div><span class="badge ${statusClass}">${statusLabel}</span></div>
      <div class="community-post-tags"><span class="badge gray">${escapeHTML(COMMUNITY_CATEGORIES[post.category] || 'General discussion')}</span><span class="badge gray">${escapeHTML(section)}</span></div>
      <h3>${escapeHTML(post.title)}</h3><p class="community-post-body">${escapeHTML(post.body)}</p>
      <div class="community-post-actions"><span class="community-comment-count">${(post.comments || []).length} comment(s)</span>${(isAuthor || isAdmin) ? `<button class="text-action danger-text" type="button" data-action="community-delete-post" data-id="${post.id}">Delete post</button>` : ''}${isAdmin ? `<button class="btn btn-secondary btn-small" type="button" data-action="community-status" data-id="${post.id}" data-status="${nextStatus}">${post.status === 'closed' ? 'Reopen discussion' : nextLabel}</button>` : ''}${isAdmin && post.status !== 'closed' ? `<button class="text-action" type="button" data-action="community-status" data-id="${post.id}" data-status="closed">Close discussion</button>` : ''}</div>
      <div class="community-comments">${comments || '<p class="community-no-comments">No comments yet. Add the first reply.</p>'}</div>
      ${post.status !== 'closed' ? `<form class="community-comment-form" data-post-id="${post.id}"><input name="body" maxlength="1200" required placeholder="Write a helpful reply…" aria-label="Write a comment"><button class="btn btn-secondary btn-small" type="submit">Reply</button></form>` : '<p class="community-closed-note">This discussion is closed.</p>'}
    </article>`;
  }

  async function submitCommunityPost(form) {
    const values = new FormData(form);
    const title = String(values.get('title') || '').trim();
    const body = String(values.get('body') || '').trim();
    const category = String(values.get('category') || 'other');
    const sectionId = String(values.get('sectionId') || '') || null;
    if (title.length < 4 || body.length < 8) return showToast('Enter a more descriptive title and message.', 'error');
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Publishing…';
    try {
      const { error } = await supabaseClient.from('community_posts').insert({
        author_id: currentUser.id, category, title, body, section_id: sectionId
      });
      if (error) throw error;
      form.reset();
      showToast('Your discussion has been published.');
      await loadCommunityPosts();
    } catch (error) {
      console.error('Community post creation failed:', error);
      showToast('Your post could not be published. Please try again.', 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Publish post';
    }
  }

  async function submitCommunityComment(form) {
    const postId = form.dataset.postId;
    const body = String(new FormData(form).get('body') || '').trim();
    if (body.length < 2) return showToast('Write a comment before replying.', 'error');
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const { error } = await supabaseClient.from('community_comments').insert({ post_id: postId, author_id: currentUser.id, body });
      if (error) throw error;
      form.reset();
      await loadCommunityPosts();
      showToast('Reply added.');
    } catch (error) {
      console.error('Community comment failed:', error);
      showToast('Your reply could not be added. Please try again.', 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function updateCommunityPostStatus(id, status) {
    if (currentUser?.role !== 'admin') return showToast('Only administrators can update discussion status.', 'error');
    try {
      const { error } = await supabaseClient.from('community_posts').update({ status, updated_at: nowISO() }).eq('id', id);
      if (error) throw error;
      await loadCommunityPosts();
      showToast('Discussion status updated.');
    } catch (error) {
      showToast(error.message || 'Could not update discussion status.', 'error');
    }
  }

  async function deleteCommunityPost(id) {
    const post = communityPosts.find(item => item.id === id);
    if (!post || (post.author_id !== currentUser?.id && currentUser?.role !== 'admin')) return;
    if (!window.confirm('Delete this discussion and its comments?')) return;
    try {
      const { error } = await supabaseClient.from('community_posts').delete().eq('id', id);
      if (error) throw error;
      await loadCommunityPosts();
      showToast('Discussion deleted.');
    } catch (error) {
      showToast(error.message || 'Could not delete the discussion.', 'error');
    }
  }

  async function deleteCommunityComment(id) {
    if (!window.confirm('Delete this comment?')) return;
    try {
      const { error } = await supabaseClient.from('community_comments').delete().eq('id', id);
      if (error) throw error;
      await loadCommunityPosts();
      showToast('Comment deleted.');
    } catch (error) {
      showToast(error.message || 'Could not delete the comment.', 'error');
    }
  }

  function pageHeader(title, description, actions = '') {
    return `<div class="page-heading"><div><p class="eyebrow">${currentUser.role === 'admin' ? 'ADMINISTRATION' : roleLabel(currentUser.role).toUpperCase() + ' PORTAL'}</p><h1>${title}</h1><p>${description}</p></div><div class="heading-actions">${actions}</div></div>`;
  }

  function statCard(label, value, note, icon, color = 'var(--crimson)', tint = 'var(--red-soft)') {
    return `<article class="stat-card" style="--stat-color:${color};--stat-tint:${tint}"><div class="stat-top"><span>${label}</span><span class="stat-icon">${icon}</span></div><div class="stat-number">${value}</div><div class="stat-foot">${note}</div></article>`;
  }

  function emptyState(title, description, icon = '✳') {
    return `<div class="empty-state"><div class="empty-icon">${icon}</div><strong>${title}</strong><p>${description}</p></div>`;
  }

  function renderRecordsHub() {
    const cards = [
      { page:'teachers', title:'Teachers', count:state.teachers.length, text:'Profiles, qualifications, availability, and teaching loads.', icon:'♙' },
      { page:'programs', title:'Programs & curriculum', count:state.programs.length, text:'Academic programs, year levels, and default subject sets.', icon:'▦' },
      { page:'sections', title:'Sections', count:state.sections.length, text:'Student counts, curriculum, and laboratory batches.', icon:'▤' },
      { page:'subjects', title:'Subjects', count:state.subjects.length, text:'Codes, units, lecture and laboratory requirements.', icon:'◈' },
      { page:'rooms', title:'Rooms & facilities', count:state.rooms.length, text:'Lecture rooms, computer labs, gym, and online venues.', icon:'⌂' },
      { page:'students', title:'Students', count:state.students.length, text:'Individual student records and timetable access.', icon:'♧' }
    ];
    return `${pageHeader('Academic records', 'Manage the information used by the timetable and schedule generator.')}
      <div class="records-grid">${cards.map(card=>`<button type="button" class="record-card" data-page="${card.page}"><span class="record-card-icon">${card.icon}</span><span class="record-card-top"><strong>${escapeHTML(card.title)}</strong><span class="record-card-count">${card.count}</span></span><span class="record-card-copy">${escapeHTML(card.text)}</span><span class="record-card-link">Open records <span aria-hidden="true">→</span></span></button>`).join('')}</div>
      <div class="notice info" style="margin-top:18px"><span>ⓘ</span><div><strong>Start with the academic records</strong>Add programs, subjects, teachers, sections, and rooms before generating a complete timetable. Sections can inherit a curriculum or use their own subject list.</div></div>`;
  }

  function renderDashboard() {
    if (currentUser.role !== 'admin') return renderMySchedule();
    const weekSchedules = state.schedules.length;
    const locked = state.schedules.filter(s => s.locked).length;
    const activeSections = state.sections.filter(s => s.active !== false).length;
    const activeTeachers = state.teachers.filter(t => t.active !== false).length;
    const unscheduledCount = (state.lastGeneration?.unscheduled || []).length;
    const latest = state.activityLog.slice(0, 6);
    const today = new Date().getDay();
    const dayName = today === 0 ? 'Monday' : DAYS[(today - 1) % 6];
    const todayClasses = state.schedules.filter(s => s.day === dayName).sort((a, b) => a.start - b.start).slice(0, 5);
    return `${pageHeader('Your scheduling overview', `A quick look at your academic scheduling workspace · ${state.settings.academicYear}`,
      `<button class="btn btn-secondary" data-action="export-json">↓ Backup data</button><button class="btn btn-primary" data-page="generator">✳ Generate schedule</button>`)}
      <div class="stats-grid">
        ${statCard('TEACHERS', activeTeachers, `${state.teachers.length} total profiles`, '♙')}
        ${statCard('ACTIVE SECTIONS', activeSections, `${state.programs.length} academic programs`, '▤', '#365e9d', '#edf3ff')}
        ${statCard('SCHEDULED MEETINGS', weekSchedules, `${locked} locked / approved`, '▦', '#1b5507', '#edf5e9')}
        ${statCard('UNSCHEDULED', unscheduledCount, unscheduledCount ? 'Needs administrator review' : 'No pending generation issues', '!', '#9a7600', '#fff8d9')}
      </div>
      <div class="section-label">WORKSPACE</div>
      <div class="content-grid">
        <section class="card">
          <div class="card-header"><div><h2>Quick actions</h2><p>Go directly to a common task.</p></div><span class="badge red">ADMIN TOOLS</span></div>
          <div class="quick-actions">
            <button class="quick-action" data-page="records"><span class="quick-action-icon">▤</span><span><strong>Manage academic records</strong><small>Teachers, subjects, sections, rooms, and students</small></span></button>
            <button class="quick-action" data-page="sections"><span class="quick-action-icon">▤</span><span><strong>Manage sections</strong><small>Programs and student counts</small></span></button>
            <button class="quick-action" data-page="subjects"><span class="quick-action-icon">◈</span><span><strong>Manage subjects</strong><small>Units and weekly meetings</small></span></button>
            <button class="quick-action" data-page="rooms"><span class="quick-action-icon">⌂</span><span><strong>Manage classrooms</strong><small>Facilities and capacity</small></span></button>
            <button class="quick-action" data-page="schedules"><span class="quick-action-icon">▦</span><span><strong>View timetable</strong><small>Master, teacher, and room views</small></span></button>
            <button class="quick-action" data-page="reports"><span class="quick-action-icon">▥</span><span><strong>View reports</strong><small>Workloads and utilization</small></span></button>
          </div>
          ${cloudMode ? '<div class="section-label">DATA STATUS</div><div class="notice success"><span>✓</span><div><strong>Shared academic workspace</strong>Changes made by administrators are saved to the connected school database. Teachers and students can view their assigned timetables.</div></div>' : ''}
        </section>
        <section class="card">
          <div class="card-header"><div><h2>Recent activity</h2><p>Latest changes in this browser.</p></div></div>
          ${latest.length ? `<div class="list-schedule">${latest.map(item => `<div class="list-schedule-item"><div class="list-schedule-time">${new Date(item.at).toLocaleDateString()}</div><div><strong>${escapeHTML(item.text)}</strong><small>${new Date(item.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</small></div></div>`).join('')}</div>` : emptyState('No activity yet', 'Changes to records and schedules will appear here.', '◷')}
        </section>
      </div>
      <div class="section-label">${escapeHTML(dayName.toUpperCase())} · SELECTED DAY</div>
      <section class="card"><div class="card-header"><div><h2>Class meetings</h2><p>Meetings currently assigned to ${dayName}.</p></div><button class="btn btn-secondary btn-small" data-page="schedules">Open schedules →</button></div>
      ${todayClasses.length ? `<div class="list-schedule">${todayClasses.map(s => scheduleListItem(s)).join('')}</div>` : emptyState('No meetings on this day', 'The selected day currently has no scheduled classes.', '▦')}</section>`;
  }

  function scheduleListItem(s) {
    const subject = byId(state.subjects, s.subjectId);
    return `<div class="list-schedule-item"><div class="list-schedule-time">${fmtTime(s.start)}<br>– ${fmtTime(s.end)}</div><div><strong>${escapeHTML(subject?.code || 'Subject')} · ${escapeHTML(subject?.name || '')}</strong><small>${escapeHTML(sectionName(s.sectionId))} · ${escapeHTML(teacherName(s.teacherId))} · ${escapeHTML(roomName(s.roomId))}${s.batchLabel ? ` · ${escapeHTML(s.batchLabel)}` : ''}</small></div><span class="badge ${s.meetingType === 'lab' ? 'yellow' : s.meetingType === 'online' ? 'blue' : 'red'}">${escapeHTML(s.meetingType.toUpperCase())}</span></div>`;
  }

  function renderTeachers() {
    const rows = state.teachers.map(t => {
      const qualified = t.qualifiedSubjectIds.map(id => byId(state.subjects, id)?.code).filter(Boolean).join(', ') || 'No subjects assigned';
      const weekly = state.schedules.filter(s => s.teacherId === t.id).reduce((sum, s) => sum + durationHours(s), 0);
      return `<tr><td><span class="cell-title">${escapeHTML(t.name)}</span><span class="cell-subtitle">${escapeHTML(t.code)} · ${escapeHTML(t.department || 'No department')}</span></td><td>${t.qualifiedSubjectIds.length} subjects<span class="cell-subtitle">${escapeHTML(qualified)}</span></td><td>${weekly.toFixed(1)} / ${Number(t.maxWeeklyHours || 0)} hrs</td><td>${escapeHTML((t.availableDays || []).map(d => d.slice(0,3)).join(', '))}<span class="cell-subtitle">${fmtTime(t.availableStart)}–${fmtTime(t.availableEnd)}</span></td><td><span class="badge ${t.active === false ? 'gray' : 'green'}">${t.active === false ? 'Inactive' : 'Active'}</span></td><td><div class="row-actions"><button class="action-button" data-action="edit" data-type="teacher" data-id="${t.id}">Edit</button><button class="action-button danger" data-action="delete" data-type="teacher" data-id="${t.id}">Delete</button></div></td></tr>`;
    }).join('');
    return `${pageHeader('Teachers', 'Manage teacher profiles, qualifications, availability, and teaching loads.', '<button class="btn btn-primary" data-action="add" data-type="teacher">＋ Add teacher</button>')}
      <div class="toolbar"><div class="toolbar-left"><div class="search-box"><input id="teacherSearch" placeholder="Search teacher or subject..."></div><select id="teacherStatusFilter"><option value="all">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option></select></div><div class="toolbar-right"><span class="badge gray">${state.teachers.length} teacher records</span></div></div>
      <section class="card"><div class="table-wrap"><table id="teachersTable"><thead><tr><th>Teacher</th><th>Qualified subjects</th><th>Weekly load</th><th>Availability</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows || `<tr><td colspan="6">${emptyState('No teachers found', 'Add a teacher profile to get started.', '♙')}</td></tr>`}</tbody></table></div></section>`;
  }

  function renderPrograms() {
    const rows = state.programs.map(p => {
      const sections = state.sections.filter(s => s.programId === p.id).length;
      const mappings = state.curriculum.filter(c => c.programId === p.id).length;
      return `<tr><td><span class="cell-title">${escapeHTML(p.code)}</span><span class="cell-subtitle">${escapeHTML(p.name)}</span></td><td>${(p.yearLevels || []).map(y => `Year ${y}`).join(', ')}</td><td>${sections}</td><td>${mappings} curriculum mapping(s)</td><td><div class="row-actions"><button class="action-button" data-action="edit" data-type="program" data-id="${p.id}">Edit</button><button class="action-button danger" data-action="delete" data-type="program" data-id="${p.id}">Delete</button></div></td></tr>`;
    }).join('');
    const curriculumRows = state.curriculum.map(c => `<tr><td>${escapeHTML(programName(c.programId))}</td><td>Year ${c.yearLevel}</td><td>${escapeHTML(c.semester)}</td><td>${c.subjectIds.length} subjects</td><td><button class="action-button" data-action="edit" data-type="curriculum" data-id="${c.id}">Edit subjects</button></td></tr>`).join('');
    return `${pageHeader('Programs & curriculum', 'Organize academic programs, year levels, and shared subject sets.', '<button class="btn btn-primary" data-action="add" data-type="program">＋ Add program</button>')}
      <div class="content-grid"><section class="card"><div class="card-header"><div><h2>Academic programs</h2><p>Programs available in this scheduling workspace.</p></div></div><div class="table-wrap"><table><thead><tr><th>Program</th><th>Year levels</th><th>Sections</th><th>Curriculum</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div></section>
      <section class="card"><div class="card-header"><div><h2>Curriculum assignments</h2><p>Default subjects by program, year, and semester.</p></div><button class="btn btn-secondary btn-small" data-action="add" data-type="curriculum">＋ Add mapping</button></div><div class="table-wrap"><table><thead><tr><th>Program</th><th>Year</th><th>Semester</th><th>Subjects</th><th></th></tr></thead><tbody>${curriculumRows || '<tr><td colspan="5">No curriculum mappings yet.</td></tr>'}</tbody></table></div></section></div>
      <div class="notice info" style="margin-top:16px"><span>ⓘ</span><div><strong>Default curriculum behavior</strong>Sections inherit subjects from their matching program, year level, and semester unless an administrator customizes that section.</div></div>`;
  }

  function renderSections() {
    const rows = state.sections.map(s => {
      const subjects = getCurriculumSubjectIds(s);
      const batchCount = getSectionBatchSizes(s).length;
      return `<tr><td><span class="cell-title">${escapeHTML(s.code)}</span><span class="cell-subtitle">${escapeHTML(programName(s.programId))} · Year ${s.yearLevel} · ${escapeHTML(s.academicYear || state.settings.academicYear)}</span></td><td>${escapeHTML(s.semester)}</td><td>${s.studentCount}</td><td>${subjects.length} subjects<span class="cell-subtitle">${Array.isArray(s.customSubjectIds) ? 'Customized curriculum' : 'Inherited curriculum'}</span></td><td>${batchCount} lab batch(es)</td><td><span class="badge ${s.active === false ? 'gray' : 'green'}">${s.active === false ? 'Inactive' : 'Active'}</span></td><td><div class="row-actions"><button class="action-button" data-action="edit" data-type="section" data-id="${s.id}">Edit</button><button class="action-button danger" data-action="delete" data-type="section" data-id="${s.id}">Delete</button></div></td></tr>`;
    }).join('');
    return `${pageHeader('Sections', 'Manage enrolment, academic placement, and section curriculum.', '<button class="btn btn-primary" data-action="add" data-type="section">＋ Add section</button>')}
      <div class="toolbar"><div class="toolbar-left"><div class="search-box"><input id="sectionSearch" placeholder="Search section or program..."></div><select id="sectionProgramFilter"><option value="all">All programs</option>${state.programs.map(p => `<option value="${p.id}">${escapeHTML(p.code)}</option>`).join('')}</select></div><div class="toolbar-right"><span class="badge gray">${state.sections.length} sections</span></div></div>
      <section class="card"><div class="table-wrap"><table id="sectionsTable"><thead><tr><th>Section</th><th>Semester</th><th>Students</th><th>Curriculum</th><th>Lab batches</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }

  function renderSubjects() {
    const rows = state.subjects.map(s => {
      const teachers = state.teachers.filter(t => t.qualifiedSubjectIds.includes(s.id)).map(t => t.name).join(', ') || 'No qualified teacher';
      const hours = s.classification === 'major' ? `${s.lectureHours || 2}h lecture + ${s.labHours || 3}h lab` : `${s.weeklyHours || s.units}h / week`;
      return `<tr><td><span class="cell-title">${escapeHTML(s.code)}</span><span class="cell-subtitle">${escapeHTML(s.name)}</span></td><td><span class="badge ${s.classification === 'major' ? 'red' : 'blue'}">${escapeHTML(s.classification)}</span></td><td>${s.units}</td><td>${hours}</td><td>${escapeHTML(s.roomType)}</td><td><span class="cell-title">${state.teachers.filter(t => t.qualifiedSubjectIds.includes(s.id)).length} teacher(s)</span><span class="cell-subtitle">${escapeHTML(teachers)}</span></td><td><div class="row-actions"><button class="action-button" data-action="edit" data-type="subject" data-id="${s.id}">Edit</button><button class="action-button danger" data-action="delete" data-type="subject" data-id="${s.id}">Delete</button></div></td></tr>`;
    }).join('');
    return `${pageHeader('Subjects', 'Define subject codes, units, meeting requirements, and qualified teachers.', '<button class="btn btn-primary" data-action="add" data-type="subject">＋ Add subject</button>')}
      <div class="toolbar"><div class="toolbar-left"><div class="search-box"><input id="subjectSearch" placeholder="Search code or subject name..."></div><select id="subjectTypeFilter"><option value="all">All types</option><option value="major">Major</option><option value="minor">Minor</option></select></div><div class="toolbar-right"><span class="badge gray">${state.subjects.length} subject records</span></div></div>
      <section class="card"><div class="table-wrap"><table id="subjectsTable"><thead><tr><th>Subject</th><th>Type</th><th>Units</th><th>Weekly requirement</th><th>Venue type</th><th>Qualified teachers</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div></section>
      <div class="notice info" style="margin-top:15px"><span>ⓘ</span><div><strong>Default subject rules</strong>Major subjects default to a 2-hour lecture and a 3-hour laboratory. Minor subjects default to one 2- or 3-hour weekly meeting based on units. Administrators may customize individual records.</div></div>`;
  }

  function renderRooms() {
    const rows = state.rooms.map(r => {
      const assigned = state.schedules.filter(s => s.roomId === r.id).length;
      return `<tr><td><span class="cell-title">${escapeHTML(r.code)}</span><span class="cell-subtitle">${escapeHTML(r.name)}</span></td><td><span class="badge ${r.type === 'lab' ? 'yellow' : r.type === 'online' ? 'blue' : r.type === 'gym' ? 'green' : 'gray'}">${escapeHTML(r.type)}</span></td><td>${r.capacity ? `${r.capacity} seats` : 'Not applicable'}</td><td>${(r.availableDays || []).map(d => d.slice(0,3)).join(', ')}</td><td>${assigned} meeting(s)</td><td><span class="badge ${r.status === 'Available' ? 'green' : 'gray'}">${escapeHTML(r.status)}</span></td><td><div class="row-actions"><button class="action-button" data-action="edit" data-type="room" data-id="${r.id}">Edit</button><button class="action-button danger" data-action="delete" data-type="room" data-id="${r.id}">Delete</button></div></td></tr>`;
    }).join('');
    return `${pageHeader('Classrooms & facilities', 'Manage lecture rooms, computer laboratories, online venues, and special facilities.', '<button class="btn btn-primary" data-action="add" data-type="room">＋ Add venue</button>')}
      <div class="stats-grid">${statCard('LECTURE ROOMS', state.rooms.filter(r => r.type === 'lecture').length, 'Physical classroom venues', '⌂')}${statCard('COMPUTER LABS', state.rooms.filter(r => r.type === 'lab').length, 'Capacity-checked venues', '▦', '#9a7600', '#fff8d9')}${statCard('SPECIAL VENUES', state.rooms.filter(r => ['gym','online','other'].includes(r.type)).length, 'Gym, online, and other', '✳', '#365e9d', '#edf3ff')}${statCard('ROOM MEETINGS', state.schedules.length, 'Current saved timetable', '◷', '#1b5507', '#edf5e9')}</div>
      <div class="section-label">VENUE DIRECTORY</div><section class="card"><div class="toolbar"><div class="toolbar-left"><div class="search-box"><input id="roomSearch" placeholder="Search room code or name..."></div><select id="roomTypeFilter"><option value="all">All venue types</option><option value="lecture">Lecture</option><option value="lab">Computer lab</option><option value="gym">Gym</option><option value="online">Online</option><option value="other">Other</option></select></div></div><div class="table-wrap"><table id="roomsTable"><thead><tr><th>Venue</th><th>Type</th><th>Capacity</th><th>Days</th><th>Scheduled meetings</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }

  function renderStudents() {
    const rows = state.students.map(s => `<tr><td><span class="cell-title">${escapeHTML(s.name)}</span><span class="cell-subtitle">${escapeHTML(s.studentNo)}</span></td><td>${escapeHTML(sectionName(s.sectionId))}</td><td>${s.enrolledSubjectIds?.length ? `${s.enrolledSubjectIds.length} selected subject(s)` : 'Section curriculum'}</td><td><span class="badge ${s.active === false ? 'gray' : 'green'}">${s.active === false ? 'Inactive' : 'Active'}</span></td><td><div class="row-actions"><button class="action-button" data-action="edit" data-type="student" data-id="${s.id}">Edit</button><button class="action-button danger" data-action="delete" data-type="student" data-id="${s.id}">Delete</button></div></td></tr>`).join('');
    return `${pageHeader('Students', 'Maintain individual student records and connect accounts to the classes they attend.', '<button class="btn btn-primary" data-action="add" data-type="student">＋ Add student</button>')}
      <div class="notice info" style="margin-bottom:15px"><span>ⓘ</span><div><strong>Simple individual access</strong>A student can follow their section timetable or select specific subjects when their enrolment differs from the standard section curriculum.</div></div>
      <section class="card"><div class="toolbar"><div class="toolbar-left"><div class="search-box"><input id="studentSearch" placeholder="Search student or student number..."></div><select id="studentSectionFilter"><option value="all">All sections</option>${state.sections.map(s => `<option value="${s.id}">${escapeHTML(s.code)}</option>`).join('')}</select></div><span class="badge gray">${state.students.length} student records</span></div><div class="table-wrap"><table id="studentsTable"><thead><tr><th>Student</th><th>Section</th><th>Timetable basis</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No student records.</td></tr>'}</tbody></table></div></section>`;
  }

  function renderAccounts() {
    const rows = state.users.map(u => `<tr><td><span class="cell-title">${escapeHTML(u.displayName || u.username)}</span><span class="cell-subtitle">${escapeHTML(u.email || u.username)}</span></td><td><span class="badge ${u.role === 'admin' ? 'red' : u.role === 'teacher' ? 'blue' : 'green'}">${roleLabel(u.role)}</span></td><td>${u.role === 'teacher' ? escapeHTML(teacherName(u.linkedId)) : u.role === 'student' ? escapeHTML(byId(state.students, u.linkedId)?.studentNo || 'Student profile') : 'Full administration'}</td><td><span class="badge ${u.active === false ? 'gray' : 'green'}">${u.active === false ? 'Inactive' : 'Active'}</span></td><td><div class="row-actions"><button class="action-button" data-action="edit" data-type="account" data-id="${u.id}">Edit</button>${u.id !== currentUser.id ? `<button class="action-button danger" data-action="delete" data-type="account" data-id="${u.id}">Delete</button>` : '<span class="badge gray">Signed in</span>'}</div></td></tr>`).join('');
    const accountNotice = cloudMode
      ? '<div class="notice success" style="margin-bottom:15px"><span>✓</span><div><strong>Account management</strong>Accounts use the connected authentication service. Passwords are not stored in academic records. Create or remove administrator, teacher, and student access here.</div></div>'
      : '';
    return `${pageHeader('User accounts', 'Manage account access and connect each person to the appropriate school record.', '<button class="btn btn-primary" data-action="add" data-type="account">＋ Add account</button>')}
      ${accountNotice}
      <section class="card"><div class="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Linked record</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No accounts have been created yet.</td></tr>'}</tbody></table></div></section>`;
  }

  function renderGenerator() {
    const activeSections = state.sections.filter(s => s.active !== false);
    const labRooms = state.rooms.filter(r => r.type === 'lab' && r.status === 'Available' && Number(r.capacity) > 0);
    const estimatedMeetings = activeSections.reduce((sum, section) => sum + getCurriculumSubjectIds(section).reduce((n, subjectId) => {
      const subject = byId(state.subjects, subjectId);
      if (!subject) return n;
      return n + (subject.classification === 'major' ? 1 + getSectionBatchSizes(section).length : 1);
    }, 0), 0);
    const lockedCurrent = state.schedules.filter(s => s.locked).length;
    const resultHTML = generatorResult ? renderGeneratorResult() : '';
    return `${pageHeader('Schedule generator', 'Create a proposed timetable using teacher, section, room, and time restrictions.', '<button class="btn btn-secondary" data-page="schedules">View current schedules</button>')}
      <div class="generator-steps"><div class="generator-step active"><strong>01 · Academic scope</strong>Choose active sections</div><div class="generator-step"><strong>02 · Generate</strong>Find valid time slots</div><div class="generator-step"><strong>03 · Review</strong>Check conflicts and gaps</div><div class="generator-step"><strong>04 · Approve</strong>Save the timetable</div></div>
      <div class="content-grid">
        <section class="card"><div class="card-header"><div><h2>Generation settings</h2><p>Schedules are generated for the selected academic period.</p></div><span class="badge red">HYBRID MODE</span></div>
          <div class="form-grid">
            <div class="form-field"><label for="generatorYear">Academic year</label><input id="generatorYear" value="${escapeHTML(state.settings.academicYear)}"></div>
            <div class="form-field"><label for="generatorSemester">Semester</label><select id="generatorSemester">${['First Semester','Second Semester','Summer'].map(s => `<option ${state.settings.semester === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
            <div class="form-field full"><label>Sections included</label><div class="checkbox-grid">${activeSections.map(s => `<label class="check-option"><input type="checkbox" name="generatorSections" value="${s.id}" ${s.semester === state.settings.semester && (s.academicYear || state.settings.academicYear) === state.settings.academicYear ? 'checked' : ''}> ${escapeHTML(s.code)} <small>${escapeHTML(s.academicYear || state.settings.academicYear)} · ${escapeHTML(s.semester)}</small></label>`).join('')}</div><span class="form-hint">Choose sections from any academic period. The generator will include only those matching the year and semester entered above.</span></div>
            <div class="form-field full"><label>Scheduling preferences</label>
              <div class="checkbox-grid">
                <label class="check-option"><input type="checkbox" id="prefGaps" ${state.settings.preferences.reduceGaps ? 'checked' : ''}> Reduce teacher gaps</label>
                <label class="check-option"><input type="checkbox" id="prefSpread" ${state.settings.preferences.distributeSubjects ? 'checked' : ''}> Spread subjects across days</label>
                <label class="check-option"><input type="checkbox" id="prefTime" ${state.settings.preferences.respectPreferredTimes ? 'checked' : ''}> Respect preferred times</label>
                <label class="check-option"><input type="checkbox" id="prefConsecutive" ${state.settings.preferences.avoidLongConsecutive ? 'checked' : ''}> Avoid long consecutive hours</label>
              </div>
            </div>
          </div>
          <div class="notice info" style="margin-top:17px"><span>ⓘ</span><div><strong>How generation works</strong>The generator uses 30-minute increments between 7:00 AM and 9:00 PM. Hard constraints are never bypassed. Locked meetings are preserved; unlocked meetings in the selected sections and semester will be replaced by the new proposal.</div></div>
          <div class="heading-actions" style="margin-top:17px"><button class="btn btn-primary" id="runGenerator">✳ Generate proposed timetable</button><button class="btn btn-secondary" data-action="clear-unlocked">Clear unlocked schedules</button></div>
        </section>
        <aside class="card"><div class="card-header"><div><h2>Generation readiness</h2><p>Quick checks before running.</p></div></div>
          <div class="list-schedule">
            <div class="list-schedule-item"><div class="list-schedule-time">${activeSections.length}</div><div><strong>Active sections</strong><small>Eligible for scheduling</small></div><span class="badge green">Ready</span></div>
            <div class="list-schedule-item"><div class="list-schedule-time">${estimatedMeetings}</div><div><strong>Estimated meetings</strong><small>Includes repeated lab batches</small></div></div>
            <div class="list-schedule-item"><div class="list-schedule-time">${state.teachers.filter(t => t.active !== false).length}</div><div><strong>Active teachers</strong><small>Must be qualified for assigned subjects</small></div></div>
            <div class="list-schedule-item"><div class="list-schedule-time">${labRooms.length}</div><div><strong>Available computer labs</strong><small>${labRooms.length ? `Largest capacity: ${getLargestLabCapacity()}` : 'Add a capacity-defined lab'}</small></div></div>
            <div class="list-schedule-item"><div class="list-schedule-time">${lockedCurrent}</div><div><strong>Locked meetings</strong><small>Will be preserved during generation</small></div></div>
          </div>
          <div class="section-label">IMPORTANT</div><p class="muted" style="font-size:calc(10px * var(--font-scale, 1))">A successful generation depends on having qualified teachers, available rooms of the correct type, realistic teaching-load limits, and a curriculum mapping for each section.</p>
        </aside>
      </div>
      ${resultHTML}`;
  }

  function renderGeneratorResult() {
    const r = generatorResult;
    if (!r) return '';
    const unscheduledRows = r.unscheduled.map(item => `<tr><td>${escapeHTML(item.sectionCode)}</td><td>${escapeHTML(item.subjectCode)}</td><td>${escapeHTML(item.meetingLabel)}</td><td>${escapeHTML(item.reason)}</td></tr>`).join('');
    return `<div class="section-label">GENERATION RESULT</div><section class="card"><div class="card-header"><div><h2>${r.complete ? 'Proposed timetable generated' : 'Generation needs review'}</h2><p>${escapeHTML(r.message)}</p></div><span class="badge ${r.complete ? 'green' : 'yellow'}">${r.complete ? 'COMPLETE' : 'PARTIAL'}</span></div>
      <div class="result-summary"><div class="result-chip"><strong>${r.placed}</strong> meetings placed</div><div class="result-chip"><strong>${r.unscheduled.length}</strong> unscheduled</div><div class="result-chip"><strong>${r.conflicts}</strong> hard conflicts</div><div class="result-chip"><strong>${r.attempts}</strong> search steps</div></div>
      ${r.unscheduled.length ? `<div class="notice danger" style="margin-bottom:13px"><span>!</span><div><strong>Some meetings could not be placed</strong>Review the reasons below. The system will not ignore these restrictions.</div></div><div class="table-wrap"><table><thead><tr><th>Section</th><th>Subject</th><th>Meeting</th><th>Reason / suggested next step</th></tr></thead><tbody>${unscheduledRows}</tbody></table></div><div class="heading-actions" style="margin-top:14px"><button class="btn btn-secondary" id="retryGenerator">Try another arrangement</button><span class="form-hint">This retries with a different ordering while keeping all hard restrictions.</span></div>` : `<div class="notice success"><span>✓</span><div><strong>All requested meetings were placed.</strong>Review the timetable and run the final conflict check before approving it.</div></div>`}
      <div class="heading-actions" style="margin-top:16px"><button class="btn btn-secondary" data-page="schedules">Review timetable</button><button class="btn btn-primary" id="approveGenerated" ${r.placed ? '' : 'disabled'}>Approve and save ${r.placed} meeting(s)</button></div>
    </section>`;
  }

  function renderSchedules() {
    const filtered = getFilteredSchedules();
    return `${pageHeader('Schedule management', 'Review and adjust the master timetable, individual teaching schedules, and room usage.', '<button class="btn btn-secondary" data-action="export-schedules-csv">↓ Export CSV</button><button class="btn btn-primary" data-action="add" data-type="schedule">＋ Add class meeting</button>')}
      <section class="card">
        <div class="schedule-toolbar"><div class="toolbar-left"><select id="scheduleView"><option value="calendar" ${scheduleFilters.view === 'calendar' ? 'selected' : ''}>Weekly calendar</option><option value="table" ${scheduleFilters.view === 'table' ? 'selected' : ''}>Table view</option></select><select id="scheduleDayFilter"><option value="all">All days</option>${DAYS.map(d => `<option value="${d}" ${scheduleFilters.day === d ? 'selected' : ''}>${d}</option>`).join('')}</select><select id="scheduleSectionFilter"><option value="all">All sections</option>${state.sections.map(s => `<option value="${s.id}" ${scheduleFilters.sectionId === s.id ? 'selected' : ''}>${escapeHTML(s.code)}</option>`).join('')}</select></div><div class="toolbar-right"><select id="scheduleTeacherFilter"><option value="all">All teachers</option>${state.teachers.map(t => `<option value="${t.id}" ${scheduleFilters.teacherId === t.id ? 'selected' : ''}>${escapeHTML(t.name)}</option>`).join('')}</select><select id="scheduleRoomFilter"><option value="all">All venues</option>${state.rooms.map(r => `<option value="${r.id}" ${scheduleFilters.roomId === r.id ? 'selected' : ''}>${escapeHTML(r.code)}</option>`).join('')}</select><button class="btn btn-secondary btn-small" data-action="print-schedules">Print / PDF</button></div></div>
        <div id="scheduleDisplay">${renderScheduleDisplay(filtered, scheduleFilters.view)}</div>
      </section>
      <div class="notice info" style="margin-top:14px"><span>ⓘ</span><div><strong>Schedule editing</strong>Use Edit to change a class. Conflict validation runs when schedule fields change and again before saving. Locked meetings cannot be edited until unlocked.</div></div>`;
  }

  function getFilteredSchedules() {
    let schedules = state.schedules.filter(s => (s.academicYear || state.settings.academicYear) === state.settings.academicYear && (s.semester || state.settings.semester) === state.settings.semester);
    if (scheduleFilters.day !== 'all') schedules = schedules.filter(s => s.day === scheduleFilters.day);
    if (scheduleFilters.teacherId !== 'all') schedules = schedules.filter(s => s.teacherId === scheduleFilters.teacherId);
    if (scheduleFilters.sectionId !== 'all') schedules = schedules.filter(s => s.sectionId === scheduleFilters.sectionId);
    if (scheduleFilters.roomId !== 'all') schedules = schedules.filter(s => s.roomId === scheduleFilters.roomId);
    return schedules.sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.start - b.start);
  }

  function renderScheduleDisplay(schedules, view = 'calendar') {
    if (!schedules.length) return emptyState('No scheduled meetings', 'Generate a timetable or add a class meeting to see the schedule here.', '▦');
    if (view === 'table') {
      const canManage = currentUser?.role === 'admin';
      const actionHeading = canManage ? '<th>Actions</th>' : '';
      return `<div class="table-wrap"><table><thead><tr><th>Day / time</th><th>Subject</th><th>Section / batch</th><th>Teacher</th><th>Venue</th><th>Type</th><th>Status</th>${actionHeading}</tr></thead><tbody>${schedules.map(s => `<tr><td><span class="cell-title">${s.day}</span><span class="cell-subtitle">${fmtTime(s.start)}–${fmtTime(s.end)}</span></td><td><span class="cell-title">${escapeHTML(byId(state.subjects, s.subjectId)?.code || 'Subject')}</span><span class="cell-subtitle">${escapeHTML(byId(state.subjects, s.subjectId)?.name || '')}</span></td><td>${escapeHTML(sectionName(s.sectionId))}<span class="cell-subtitle">${escapeHTML(s.batchLabel || 'Whole section')}</span></td><td>${escapeHTML(teacherName(s.teacherId))}</td><td>${escapeHTML(roomName(s.roomId))}</td><td><span class="badge ${s.meetingType === 'lab' ? 'yellow' : 'red'}">${escapeHTML(s.meetingType)}</span></td><td><span class="badge ${s.locked ? 'green' : 'gray'}">${s.locked ? 'Locked' : 'Draft'}</span></td>${canManage ? `<td><div class="row-actions"><button class="action-button" data-action="edit" data-type="schedule" data-id="${s.id}" ${s.locked ? 'disabled' : ''}>Edit</button><button class="action-button" data-action="duplicate-schedule" data-id="${s.id}">Duplicate</button><button class="action-button" data-action="lock-schedule" data-id="${s.id}">${s.locked ? 'Unlock' : 'Lock'}</button><button class="action-button danger" data-action="delete" data-type="schedule" data-id="${s.id}" ${s.locked ? 'disabled' : ''}>Delete</button></div></td>` : ''}</tr>`).join('')}</tbody></table></div>`;
    }
    const start = state.settings.startTime;
    const end = state.settings.endTime;
    const slots = [];
    for (let t = start; t < end; t += 60) slots.push(t);
    const visibleDays = scheduleFilters.day === 'all' ? DAYS : [scheduleFilters.day];
    const cols = visibleDays.length;
    const grid = `<div class="schedule-grid" style="grid-template-columns:78px repeat(${cols},minmax(110px,1fr))"><div class="grid-head time-head">TIME</div>${visibleDays.map(d => `<div class="grid-head">${d.slice(0,3).toUpperCase()}</div>`).join('')}${slots.map(slot => `<div class="time-label">${fmtTime(slot)}</div>${visibleDays.map(day => {
      const events = schedules.filter(s => s.day === day && s.start < slot + 60 && s.end > slot);
      const firstRows = events.filter(s => s.start >= slot && s.start < slot + 60);
      const eventHTML = firstRows.map(s => {
        const height = Math.max(38, ((s.end - s.start) / 60) * 56 - 6);
        const top = ((s.start - slot) / 60) * 56 + 3;
        const className = s.meetingType === 'lab' ? 'lab' : s.meetingType === 'online' ? 'online' : s.meetingType === 'gym' ? 'gym' : '';
        const subject = byId(state.subjects, s.subjectId);
        return `<button class="schedule-card ${className}" style="top:${top}px;height:${height}px" data-action="view-schedule" data-id="${s.id}" title="${escapeHTML(subject?.name || '')} · ${fmtTime(s.start)}–${fmtTime(s.end)}"><strong>${escapeHTML(subject?.code || 'Class')}</strong><span>${escapeHTML(sectionName(s.sectionId))} · ${escapeHTML(teacherName(s.teacherId).split(' ')[0])}</span><span>${fmtTime(s.start)}–${fmtTime(s.end)}</span></button>`;
      }).join('');
      return `<div class="day-cell" style="min-height:56px">${eventHTML}</div>`;
    }).join('')}`).join('')}</div>`;
    return `<div class="schedule-grid-wrap">${grid}</div><div class="schedule-legend"><span><i></i> Lecture</span><span><i class="legend-lab"></i> Laboratory</span><span><i class="legend-online"></i> Online</span><span><i class="legend-gym"></i> Gym / physical activity</span></div>`;
  }

  function attachScheduleControls() {
    const view = $('#scheduleView');
    if (!view) return;
    view.addEventListener('change', updateScheduleFilters);
    ['scheduleDayFilter','scheduleSectionFilter','scheduleTeacherFilter','scheduleRoomFilter'].forEach(id => $(`#${id}`)?.addEventListener('change', updateScheduleFilters));
  }

  function updateScheduleFilters() {
    scheduleFilters = {
      view: $('#scheduleView')?.value || 'calendar', day: $('#scheduleDayFilter')?.value || 'all',
      sectionId: $('#scheduleSectionFilter')?.value || 'all', teacherId: $('#scheduleTeacherFilter')?.value || 'all', roomId: $('#scheduleRoomFilter')?.value || 'all'
    };
    const periodSchedules = state.schedules.filter(s => (s.academicYear || state.settings.academicYear) === state.settings.academicYear && (s.semester || state.settings.semester) === state.settings.semester);
    const visibleSchedules = currentPage === 'my-schedule' ? (currentUser.role === 'teacher' ? periodSchedules.filter(s => s.teacherId === currentUser.linkedId) : getStudentSchedules()) : getFilteredSchedules();
    $('#scheduleDisplay').innerHTML = renderScheduleDisplay(visibleSchedules, scheduleFilters.view);
  }

  function renderMySchedule() {
    const periodSchedules = state.schedules.filter(s => (s.academicYear || state.settings.academicYear) === state.settings.academicYear && (s.semester || state.settings.semester) === state.settings.semester);
    const schedules = currentUser.role === 'teacher'
      ? periodSchedules.filter(s => s.teacherId === currentUser.linkedId)
      : getStudentSchedules();
    const title = currentUser.role === 'teacher' ? 'My teaching schedule' : 'My class schedule';
    const description = currentUser.role === 'teacher' ? 'Your assigned classes, venues, and consultation periods.' : 'Your section timetable and enrolled class meetings.';
    const sorted = schedules.sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.start - b.start);
    return `${pageHeader(title, description, '<button class="btn btn-secondary" data-action="print-schedules">Print / PDF</button>')}
      <div class="stats-grid">${statCard('WEEKLY MEETINGS', sorted.length, 'Scheduled class sessions', '▦')}${statCard('TEACHING / CLASS HOURS', sorted.reduce((sum,s) => sum + durationHours(s),0).toFixed(1), 'Hours per week', '◷', '#1b5507', '#edf5e9')}${statCard('CLASS DAYS', new Set(sorted.map(s => s.day)).size, 'Days with assigned classes', '▤', '#365e9d', '#edf3ff')}${statCard('LOCKED MEETINGS', sorted.filter(s => s.locked).length, 'Approved schedule entries', '✓', '#9a7600', '#fff8d9')}</div>
      <div class="section-label">WEEKLY TIMETABLE</div><section class="card"><div class="schedule-toolbar"><div><strong>${currentUser.role === 'teacher' ? escapeHTML(currentUser.displayName) : escapeHTML(studentDisplaySection())}</strong><p class="muted" style="margin:3px 0 0;font-size:calc(10px * var(--font-scale, 1))">${escapeHTML(state.settings.academicYear)} · ${escapeHTML(state.settings.semester)}</p></div><select id="scheduleView"><option value="calendar">Weekly calendar</option><option value="table">Table view</option></select></div><div id="scheduleDisplay">${renderScheduleDisplay(sorted, 'calendar')}</div></section>`;
  }

  function studentDisplaySection() {
    const student = byId(state.students, currentUser.linkedId);
    return student ? `${student.name} · ${sectionName(student.sectionId)}` : 'Student account';
  }

  function getStudentSchedules() {
    const student = byId(state.students, currentUser.linkedId);
    if (!student) return [];
    const sectionIds = getStudentSectionIds(student);
    let schedules = state.schedules.filter(s => sectionIds.includes(s.sectionId) && (s.academicYear || state.settings.academicYear) === state.settings.academicYear && (s.semester || state.settings.semester) === state.settings.semester);
    if (Array.isArray(student.enrolledSubjectIds) && student.enrolledSubjectIds.length) schedules = schedules.filter(s => student.enrolledSubjectIds.includes(s.subjectId));
    if (student.batchIndex !== null && student.batchIndex !== undefined) {
      schedules = schedules.filter(s => s.sectionId !== student.sectionId || s.batchIndex === null || s.batchIndex === undefined || Number(s.batchIndex) === Number(student.batchIndex));
    }
    return schedules;
  }

  function renderTeacherLoad() {
    const teacher = byId(state.teachers, currentUser.linkedId);
    if (!teacher) return emptyState('Teacher profile not found', 'Ask the administrator to link this account to a teacher record.');
    const meetings = state.schedules.filter(s => s.teacherId === teacher.id && (s.academicYear || state.settings.academicYear) === state.settings.academicYear && (s.semester || state.settings.semester) === state.settings.semester);
    const total = meetings.reduce((sum, s) => sum + durationHours(s), 0);
    const daily = DAYS.map(day => ({ day, hours: meetings.filter(s => s.day === day).reduce((sum,s) => sum + durationHours(s),0) }));
    return `${pageHeader('Teaching load', 'Review your assigned hours and daily teaching distribution.')}
      <div class="stats-grid">${statCard('WEEKLY HOURS', total.toFixed(1), `Maximum ${teacher.maxWeeklyHours} hours`, '◷')}${statCard('DAILY LIMIT', teacher.maxDailyHours, 'Maximum hours per day', '⌁', '#365e9d', '#edf3ff')}${statCard('QUALIFIED SUBJECTS', teacher.qualifiedSubjectIds.length, 'Subjects you can teach', '◈', '#1b5507', '#edf5e9')}${statCard('MEETINGS', meetings.length, 'Scheduled sessions', '▦', '#9a7600', '#fff8d9')}</div>
      <section class="card" style="margin-top:16px"><div class="card-header"><div><h2>Daily hours</h2><p>Scheduled hours compared with your daily maximum.</p></div></div>${daily.map(item => `<div style="margin:13px 0"><div class="toolbar" style="margin:0 0 6px"><strong style="font-size:calc(11px * var(--font-scale, 1))">${item.day}</strong><span class="muted" style="font-size:calc(10px * var(--font-scale, 1))">${item.hours.toFixed(1)} / ${teacher.maxDailyHours} hrs</span></div><div class="report-bar"><span style="width:${Math.min(100, item.hours / Math.max(1, teacher.maxDailyHours) * 100)}%"></span></div></div>`).join('')}</section>
      <div class="section-label">ASSIGNED MEETINGS</div><section class="card">${meetings.length ? `<div class="list-schedule">${meetings.sort((a,b)=>DAYS.indexOf(a.day)-DAYS.indexOf(b.day)||a.start-b.start).map(scheduleListItem).join('')}</div>` : emptyState('No assigned classes', 'Your timetable has no saved meetings yet.')}</section>`;
  }

  function renderConsultation() {
    const teacher = byId(state.teachers, currentUser.linkedId);
    if (!teacher) return emptyState('Teacher profile not found', 'Ask the administrator to link this account to a teacher record.');
    const busy = state.schedules.filter(s => s.teacherId === teacher.id);
    const reserved = state.consultationPeriods.filter(c => c.teacherId === teacher.id);
    const candidates = [];
    for (const day of teacher.availableDays || DAYS) {
      for (let t = teacher.availableStart; t < teacher.availableEnd; t += 60) {
        const end = Math.min(t + 60, teacher.availableEnd);
        const overlaps = busy.some(s => s.day === day && s.start < end && s.end > t) || reserved.some(c => c.day === day && c.start < end && c.end > t);
        if (!overlaps) candidates.push({ day, start: t, end });
      }
    }
    return `${pageHeader('Consultation availability', 'Vacant periods that may be available for student consultation.')}
      <div class="notice info" style="margin-bottom:15px"><span>ⓘ</span><div><strong>Suggested vacant periods</strong>These are calculated from your currently saved classes and reserved consultation periods. The administrator may reserve consultation hours in the system.</div></div>
      <section class="card"><div class="card-header"><div><h2>Possible consultation periods</h2><p>One-hour vacant windows within your recorded availability.</p></div><span class="badge green">${candidates.length} possible slot(s)</span></div>${candidates.length ? `<div class="list-schedule">${candidates.slice(0,50).map(c=>`<div class="list-schedule-item"><div class="list-schedule-time">${c.day.slice(0,3)}<br>${fmtTime(c.start)}–${fmtTime(c.end)}</div><div><strong>Vacant period</strong><small>Potential consultation time</small></div><span class="badge green">Available</span></div>`).join('')}</div>` : emptyState('No vacant periods found', 'Your current schedule has no one-hour vacant windows during availability.')}</section>`;
  }

  function renderStudentSubjects() {
    const student = byId(state.students, currentUser.linkedId);
    if (!student) return emptyState('Student profile not found', 'Ask the administrator to link this account to a student record.');
    const sectionIds = getStudentSectionIds(student);
    const sectionSubjects = sectionIds.flatMap(sectionId => getCurriculumSubjectIds(byId(state.sections, sectionId) || {}));
    const subjectIds = student.enrolledSubjectIds?.length ? student.enrolledSubjectIds : [...new Set(sectionSubjects)];
    const rows = subjectIds.map(id => {
      const subject = byId(state.subjects, id);
      if (!subject) return '';
      const meetings = state.schedules.filter(s => sectionIds.includes(s.sectionId) && s.subjectId === id && (s.academicYear || state.settings.academicYear) === state.settings.academicYear && (s.semester || state.settings.semester) === state.settings.semester);
      const sections = [...new Set(meetings.map(m => sectionName(m.sectionId)))];
      return `<tr><td><span class="cell-title">${escapeHTML(subject.code)}</span><span class="cell-subtitle">${escapeHTML(subject.name)}</span></td><td>${subject.units}</td><td><span class="badge ${subject.classification === 'major' ? 'red' : 'blue'}">${subject.classification}</span></td><td>${escapeHTML(sections.join(', ') || '—')}</td><td>${meetings.length} scheduled meeting(s)</td><td>${meetings.map(m => `${escapeHTML(sectionName(m.sectionId))}: ${m.day.slice(0,3)} ${fmtTime(m.start)}`).join(', ') || 'Not scheduled'}</td></tr>`;
    }).join('');
    return `${pageHeader('My subjects', 'Subjects connected to your student timetable.')}
      <div class="notice info" style="margin-bottom:15px"><span>ⓘ</span><div><strong>${escapeHTML(sectionName(student.sectionId))}${(student.additionalSectionIds || []).length ? ` + ${(student.additionalSectionIds || []).length} additional section(s)` : ''}</strong>Your account follows your primary section and any additional section schedules assigned by the administrator. Specific subject selections can further narrow your timetable.</div></div>
      <section class="card"><div class="table-wrap"><table><thead><tr><th>Subject</th><th>Units</th><th>Type</th><th>Section(s)</th><th>Meetings</th><th>Scheduled times</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No subjects assigned.</td></tr>'}</tbody></table></div></section>`;
  }

  function renderReports() {
    const termSchedules = state.schedules.filter(s => (s.academicYear || state.settings.academicYear) === state.settings.academicYear && (s.semester || state.settings.semester) === state.settings.semester);
    const teacherLoads = state.teachers.map(t => ({ teacher: t, hours: termSchedules.filter(s => s.teacherId === t.id).reduce((sum,s)=>sum+durationHours(s),0) })).sort((a,b)=>b.hours-a.hours);
    const roomUsage = state.rooms.map(r => ({ room: r, meetings: state.schedules.filter(s => s.roomId === r.id).length })).sort((a,b)=>b.meetings-a.meetings);
    const totalMinutes = state.schedules.reduce((sum,s)=>sum+s.end-s.start,0);
    const subjectsScheduled = new Set(state.schedules.map(s=>s.subjectId)).size;
    const conflicts = findAllConflicts(state.schedules);
    return `${pageHeader('Reports & insights', 'Understand teaching loads, classroom usage, and timetable quality.', '<button class="btn btn-secondary" data-action="export-schedules-csv">↓ Export schedule CSV</button><button class="btn btn-secondary" data-action="print-schedules">Print report</button>')}
      <div class="stats-grid">${statCard('TOTAL CLASS HOURS', (totalMinutes/60).toFixed(1), 'Hours assigned per week', '◷')}${statCard('SUBJECTS SCHEDULED', subjectsScheduled, `Of ${state.subjects.length} subject records`, '◈', '#365e9d', '#edf3ff')}${statCard('SCHEDULE CONFLICTS', conflicts.length, conflicts.length ? 'Review required' : 'No current hard conflicts', '!', conflicts.length ? 'var(--crimson)' : '#1b5507', conflicts.length ? 'var(--red-soft)' : '#edf5e9')}${statCard('VENUES IN USE', new Set(state.schedules.map(s=>s.roomId)).size, `Of ${state.rooms.length} registered venues`, '⌂', '#9a7600', '#fff8d9')}</div>
      <div class="two-col" style="margin-top:16px"><section class="card"><div class="card-header"><div><h2>Teacher teaching loads</h2><p>Scheduled weekly hours against configured limits.</p></div></div>${teacherLoads.length ? teacherLoads.map(({teacher,hours})=>`<div style="margin:12px 0"><div class="toolbar" style="margin:0 0 5px"><span><strong style="font-size:calc(11px * var(--font-scale, 1))">${escapeHTML(teacher.name)}</strong><small class="cell-subtitle">${escapeHTML(teacher.code)}</small></span><span class="muted" style="font-size:calc(10px * var(--font-scale, 1))">${hours.toFixed(1)} / ${teacher.maxWeeklyHours} hrs</span></div><div class="report-bar"><span style="width:${Math.min(100,hours/Math.max(1,teacher.maxWeeklyHours)*100)}%;${hours>teacher.maxWeeklyHours?'background:#bf1e2e':''}"></span></div></div>`).join('') : emptyState('No teacher records','Add teachers to see teaching load reports.')}</section>
      <section class="card"><div class="card-header"><div><h2>Classroom utilization</h2><p>Number of meetings assigned to each venue.</p></div></div>${roomUsage.length ? roomUsage.map(({room,meetings})=>`<div style="margin:12px 0"><div class="toolbar" style="margin:0 0 5px"><span><strong style="font-size:calc(11px * var(--font-scale, 1))">${escapeHTML(room.code)}</strong><small class="cell-subtitle">${escapeHTML(room.type)}</small></span><span class="muted" style="font-size:calc(10px * var(--font-scale, 1))">${meetings} meeting(s)</span></div><div class="report-bar"><span style="width:${Math.min(100,meetings/Math.max(1,state.schedules.length)*100)}%;background:${room.type==='lab'?'#bb8b00':'var(--crimson)'}"></span></div></div>`).join('') : emptyState('No venues registered','Add classrooms and special venues.')}</section></div>
      <div class="section-label">SCHEDULING QUALITY</div><section class="card"><div class="card-header"><div><h2>Conflict checker</h2><p>Recheck all saved timetable entries against hard scheduling restrictions.</p></div><button class="btn btn-primary btn-small" data-action="run-conflict-check">Run conflict check</button></div><div id="reportConflictOutput">${conflicts.length ? renderConflictList(conflicts) : '<div class="notice success"><span>✓</span><div><strong>No schedule overlaps detected.</strong>Current saved meetings pass the basic teacher, section, and room overlap check.</div></div>'}</div></section>`;
  }

  function renderConflictList(conflicts) {
    return `<div class="notice danger"><span>!</span><div><strong>${conflicts.length} issue(s) detected</strong>Review these entries and adjust the schedule.</div></div><div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Issue</th><th>Class A</th><th>Class B</th><th>Day / time</th></tr></thead><tbody>${conflicts.map(c=>`<tr><td><span class="badge red">${escapeHTML(c.type)}</span></td><td>${escapeHTML(c.aCode)}</td><td>${escapeHTML(c.bCode)}</td><td>${escapeHTML(c.day)} · ${fmtTime(c.start)}–${fmtTime(c.end)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function renderSettings() {
    const backupNotice = `<div class="notice info" style="margin-top:15px"><span>ⓘ</span><div><strong>Backup and restore</strong>Importing a workspace backup replaces the current academic records and schedules. Export a copy first if you need to preserve the current version. Account credentials remain managed separately by the authentication service when connected.</div></div>`;
    return `${pageHeader('System settings', 'Configure the academic period, operating hours, schedule defaults, and data tools.')}
      <div class="content-grid"><section class="card"><div class="card-header"><div><h2>Academic and scheduling settings</h2><p>Default constraints used by the schedule generator.</p></div></div>
        <form id="settingsForm" class="form-grid">
          <div class="form-field"><label for="settingAcademicYear">Academic year</label><input id="settingAcademicYear" name="academicYear" value="${escapeHTML(state.settings.academicYear)}" required></div>
          <div class="form-field"><label for="settingSemester">Current semester</label><select id="settingSemester" name="semester">${['First Semester','Second Semester','Summer'].map(s=>`<option ${state.settings.semester===s?'selected':''}>${s}</option>`).join('')}</select></div>
          <div class="form-field"><label for="settingStartTime">First class time</label><input id="settingStartTime" name="startTime" type="time" step="1800" value="${timeInput(state.settings.startTime)}"></div>
          <div class="form-field"><label for="settingEndTime">Last class end</label><input id="settingEndTime" name="endTime" type="time" step="1800" value="${timeInput(state.settings.endTime)}"></div>
          <div class="form-field"><label for="settingMaxConsecutive">Preferred maximum consecutive hours</label><input id="settingMaxConsecutive" name="maxConsecutiveHours" type="number" min="1" max="12" value="${state.settings.preferences.maxConsecutiveHours}"></div>
          <div class="form-field"><label>Scheduling interval</label><input value="30 minutes" disabled></div>
          <div class="form-field full"><label>Available class days</label><div class="checkbox-grid">${DAYS.map(d=>`<label class="check-option"><input type="checkbox" name="settingDays" value="${d}" ${(state.settings.days||DAYS).includes(d)?'checked':''}> ${d}</label>`).join('')}</div></div>
          <div class="form-field full"><button class="btn btn-primary" type="submit">Save settings</button></div>
        </form>
      </section>
      <section class="card"><div class="card-header"><div><h2>Data management</h2><p>Export a copy of your academic records and schedules or restore a saved workspace backup.</p></div></div>
        <div class="list-schedule">
          <div class="list-schedule-item"><div class="list-schedule-time">JSON</div><div><strong>Export workspace backup</strong><small>Includes academic records and schedules. Authentication credentials are managed separately and are not exported.</small></div><button class="btn btn-secondary btn-small" data-action="export-json">Export</button></div>
          <div class="list-schedule-item"><div class="list-schedule-time">JSON</div><div><strong>Restore backup</strong><small>Replace current academic records with a saved backup.</small></div><button class="btn btn-secondary btn-small" data-action="import-json">Import</button></div>
          <div class="list-schedule-item"><div class="list-schedule-time">CSV</div><div><strong>Export records</strong><small>Download selected data as a spreadsheet-friendly file.</small></div><button class="btn btn-secondary btn-small" data-action="export-csv">Export</button></div>
          <div class="list-schedule-item"><div class="list-schedule-time">CSV</div><div><strong>Import records</strong><small>Import a supported Teachers, Subjects, Sections, or Rooms CSV file.</small></div><button class="btn btn-secondary btn-small" data-action="import-csv">Import</button></div>
        </div>
        ${backupNotice}
      </section></div>`;
  }

  function renderConflictSummary() {
    const conflicts = findAllConflicts(state.schedules);
    return conflicts.length ? renderConflictList(conflicts) : '<div class="notice success"><span>✓</span><div><strong>No conflicts detected.</strong>All saved meeting entries passed the current overlap checks.</div></div>';
  }

  function findAllConflicts(schedules) {
    const conflicts = [];
    schedules = schedules.filter(s => (s.academicYear || state.settings.academicYear) === state.settings.academicYear && (s.semester || state.settings.semester) === state.settings.semester);
    const addIssue = (type, schedule, detail) => conflicts.push({
      type,
      aCode: `${subjectCode(schedule.subjectId)} / ${sectionName(schedule.sectionId)}`,
      bCode: detail,
      day: schedule.day || 'Period',
      start: Number(schedule.start) || state.settings.startTime,
      end: Number(schedule.end) || state.settings.startTime + 30
    });

    // Pairwise overlap checks for teachers, rooms, sections, and batches.
    for (let i = 0; i < schedules.length; i++) {
      for (let j = i + 1; j < schedules.length; j++) {
        const a = schedules[i], b = schedules[j];
        if (a.day !== b.day || !timeOverlaps(a.start, a.end, b.start, b.end)) continue;
        if (a.teacherId === b.teacherId) conflicts.push({ type:'Teacher overlap', aCode:`${subjectCode(a.subjectId)} / ${sectionName(a.sectionId)}`, bCode:`${subjectCode(b.subjectId)} / ${sectionName(b.sectionId)}`, day:a.day, start:Math.max(a.start,b.start), end:Math.min(a.end,b.end) });
        if (a.roomId === b.roomId && byId(state.rooms,a.roomId)?.type !== 'online') conflicts.push({ type:'Room overlap', aCode:`${subjectCode(a.subjectId)} / ${sectionName(a.sectionId)}`, bCode:`${subjectCode(b.subjectId)} / ${sectionName(b.sectionId)}`, day:a.day, start:Math.max(a.start,b.start), end:Math.min(a.end,b.end) });
        if (sameSectionConflict(a,b)) conflicts.push({ type:'Section overlap', aCode:`${subjectCode(a.subjectId)} / ${sectionName(a.sectionId)}`, bCode:`${subjectCode(b.subjectId)} / ${sectionName(b.sectionId)}`, day:a.day, start:Math.max(a.start,b.start), end:Math.min(a.end,b.end) });
      }
    }

    // Individual meeting restrictions.
    for (const schedule of schedules) {
      const teacher = byId(state.teachers, schedule.teacherId);
      const section = byId(state.sections, schedule.sectionId);
      const subject = byId(state.subjects, schedule.subjectId);
      const room = byId(state.rooms, schedule.roomId);
      if (!state.settings.days.includes(schedule.day)) addIssue('Unavailable day', schedule, 'The day is not enabled in system settings.');
      if (schedule.start < state.settings.startTime || schedule.end > state.settings.endTime || schedule.start >= schedule.end) addIssue('Operating hours', schedule, 'Class is outside the configured school day or has an invalid time range.');
      if (schedule.start % state.settings.interval || schedule.end % state.settings.interval) addIssue('Time increment', schedule, 'Start and end times must follow 30-minute increments.');
      if (!teacher) addIssue('Missing teacher', schedule, 'Assign a valid teacher.');
      else {
        if (teacher.active === false) addIssue('Inactive teacher', schedule, `${teacher.name} is inactive.`);
        if (!(teacher.qualifiedSubjectIds || []).includes(schedule.subjectId)) addIssue('Teacher qualification', schedule, `${teacher.name} is not qualified for this subject.`);
        if (!(teacher.availableDays || []).includes(schedule.day) || schedule.start < teacher.availableStart || schedule.end > teacher.availableEnd) addIssue('Teacher availability', schedule, `${teacher.name} is unavailable during this period.`);
        if (state.consultationPeriods.some(c=>c.teacherId===teacher.id&&c.day===schedule.day&&timeOverlaps(c.start,c.end,schedule.start,schedule.end))) addIssue('Consultation overlap', schedule, 'The teacher has a reserved consultation period.');
      }
      if (!section) addIssue('Missing section', schedule, 'Assign a valid section.');
      if (!subject) addIssue('Missing subject', schedule, 'Assign a valid subject.');
      else {
        const actualHours = (schedule.end - schedule.start) / 60;
        const expectedHours = subject.classification === 'major' ? (schedule.meetingType === 'lab' ? Number(subject.labHours || 3) : Number(subject.lectureHours || 2)) : Number(subject.weeklyHours || subject.units || 2);
        if (Math.abs(actualHours - expectedHours) > 0.001) addIssue('Meeting duration', schedule, `${subject.code} requires ${expectedHours} hour(s), but this entry is ${actualHours} hour(s).`);
      }
      if (!room) addIssue('Missing venue', schedule, 'Assign a valid room or venue.');
      else {
        if (room.status !== 'Available' || !(room.availableDays || []).includes(schedule.day)) addIssue('Venue availability', schedule, `${room.code} is unavailable on this day.`);
        const requiredType = requiredRoomType(schedule.meetingType, subject);
        if (room.type !== requiredType) addIssue('Venue type', schedule, `${requiredType} venue required, but ${room.code} is ${room.type}.`);
        if (room.type === 'lab' && section) {
          const batchSizes = getSectionBatchSizes(section);
          const batchSize = schedule.batchIndex === null || schedule.batchIndex === undefined
            ? Number(section.studentCount)
            : Number(batchSizes[Number(schedule.batchIndex)] || section.studentCount);
          if (Number(room.capacity) < batchSize) addIssue('Room capacity', schedule, `${room.code} capacity ${room.capacity} is below group size ${batchSize}.`);
        }
      }
    }

    // Teacher maximum weekly and daily loads.
    for (const teacher of state.teachers) {
      const own = schedules.filter(s=>s.teacherId===teacher.id);
      const weekly = own.reduce((sum,s)=>sum+(s.end-s.start)/60,0);
      if (weekly > Number(teacher.maxWeeklyHours || 999)) {
        const sample = own[0]; if (sample) addIssue('Weekly teaching load', sample, `${teacher.name}: ${weekly.toFixed(1)} / ${teacher.maxWeeklyHours} hours.`);
      }
      for (const day of state.settings.days) {
        const daily = own.filter(s=>s.day===day).reduce((sum,s)=>sum+(s.end-s.start)/60,0);
        if (daily > Number(teacher.maxDailyHours || 999)) {
          const sample = own.find(s=>s.day===day); if (sample) addIssue('Daily teaching load', sample, `${teacher.name}: ${daily.toFixed(1)} / ${teacher.maxDailyHours} hours on ${day}.`);
        }
      }
    }
    return conflicts;
  }

  function subjectCode(id) { return byId(state.subjects, id)?.code || 'Subject'; }

  function renderCurrentPageAfterStateChange() { renderCurrentPage(); }

  function saveSettingsFromForm(form) {
    const data = new FormData(form);
    const startTime = parseTime(data.get('startTime'));
    const endTime = parseTime(data.get('endTime'));
    const days = data.getAll('settingDays');
    if (!days.length) return showToast('Select at least one available class day.', 'error');
    if (startTime < START_OF_DAY || endTime > END_OF_DAY || startTime >= endTime || startTime % 30 || endTime % 30) {
      return showToast('Operating hours must use 30-minute increments between 7:00 AM and 9:00 PM.', 'error');
    }
    state.settings.academicYear = data.get('academicYear').trim();
    state.settings.semester = data.get('semester');
    state.settings.startTime = startTime;
    state.settings.endTime = endTime;
    state.settings.days = days;
    state.settings.preferences.maxConsecutiveHours = Number(data.get('maxConsecutiveHours')) || 5;
    saveState('Updated system settings.');
    showToast('System settings saved.');
    renderApp();
  }

  function generateTaskList(sectionIds, semester, academicYear) {
    const sections = state.sections.filter(s => sectionIds.includes(s.id) && s.active !== false && s.semester === semester && (s.academicYear || state.settings.academicYear) === academicYear);
    const tasks = [];
    const notes = [];
    for (const section of sections) {
      const subjectIds = getCurriculumSubjectIds(section);
      if (!subjectIds.length) notes.push({ sectionCode: section.code, subjectCode: 'CURRICULUM', meetingLabel: 'All meetings', reason: 'No curriculum subjects assigned. Add a curriculum mapping or customize the section.' });
      const labBatchSizes = getSectionBatchSizes(section);
      const labBatchCount = labBatchSizes.length;
      for (const subjectId of subjectIds) {
        const subject = byId(state.subjects, subjectId);
        if (!subject || subject.active === false) continue;
        if (subject.classification === 'major') {
          tasks.push({ id: uid('task'), sectionId: section.id, sectionCode: section.code, subjectId, subjectCode: subject.code, duration: Number(subject.lectureHours || 2), meetingType: 'lecture', batchIndex: null, batchLabel: '', roomType: subject.lectureRoomType || 'lecture', meetingLabel: 'Lecture' });
          for (let batch = 0; batch < labBatchCount; batch++) {
            const startStudent = labBatchSizes.slice(0, batch).reduce((total, size) => total + size, 0) + 1;
            const endStudent = startStudent + labBatchSizes[batch] - 1;
            const label = labBatchCount > 1 ? `Batch ${batch + 1} · Students ${startStudent}–${endStudent}` : '';
            tasks.push({ id: uid('task'), sectionId: section.id, sectionCode: section.code, subjectId, subjectCode: subject.code, duration: Number(subject.labHours || 3), meetingType: 'lab', batchIndex: batch, batchSize: labBatchSizes[batch], batchLabel: label, roomType: 'lab', meetingLabel: label ? `Laboratory · Batch ${batch + 1}` : 'Laboratory' });
          }
        } else {
          const roomType = subject.roomType || 'lecture';
          const meetingType = roomType === 'online' ? 'online' : roomType === 'gym' ? 'gym' : 'lecture';
          tasks.push({ id: uid('task'), sectionId: section.id, sectionCode: section.code, subjectId, subjectCode: subject.code, duration: Number(subject.weeklyHours || subject.units || 2), meetingType, batchIndex: null, batchLabel: '', roomType, meetingLabel: 'Weekly class' });
        }
      }
    }
    return { tasks, notes, sections };
  }

  function generateSchedule({ retry = false } = {}) {
    const academicYear = $('#generatorYear')?.value.trim() || state.settings.academicYear;
    const semester = $('#generatorSemester')?.value || state.settings.semester;
    const sectionIds = $$('input[name="generatorSections"]:checked').map(input => input.value);
    if (!sectionIds.length) { showToast('Select at least one section to generate.', 'error'); return; }
    state.settings.academicYear = academicYear;
    state.settings.semester = semester;
    state.settings.preferences.reduceGaps = $('#prefGaps')?.checked ?? true;
    state.settings.preferences.distributeSubjects = $('#prefSpread')?.checked ?? true;
    state.settings.preferences.respectPreferredTimes = $('#prefTime')?.checked ?? true;
    state.settings.preferences.avoidLongConsecutive = $('#prefConsecutive')?.checked ?? true;
    const { tasks, notes } = generateTaskList(sectionIds, semester, academicYear);
    if (!tasks.length) { showToast('No meetings were generated. Check the selected sections and curriculum.', 'error'); return; }

    const sectionSet = new Set(sectionIds);
    // Schedules from other academic periods do not block this period. Locked entries in the same period are preserved.
    const baseSchedules = state.schedules.filter(s => {
      const samePeriod = (s.academicYear || state.settings.academicYear) === academicYear && (s.semester || state.settings.semester) === semester;
      return samePeriod && (s.locked || !sectionSet.has(s.sectionId));
    });
    const taskCandidates = new Map();
    const candidateReasons = new Map();
    for (const task of tasks) {
      const teachers = state.teachers.filter(t => t.active !== false && (t.qualifiedSubjectIds || []).includes(task.subjectId));
      const rooms = state.rooms.filter(r => r.status === 'Available' && r.type === task.roomType && r.availableDays?.length && (task.roomType !== 'lab' || Number(r.capacity) >= Number(task.batchSize || 0)));
      if (!teachers.length) candidateReasons.set(task.id, 'No active teacher is qualified for this subject. Assign a qualified teacher before retrying.');
      else if (!rooms.length) candidateReasons.set(task.id, `No available venue of type “${task.roomType}”. Add or activate a suitable venue.`);
      const candidates = [];
      for (const teacher of teachers) {
        for (const room of rooms) {
          for (const day of state.settings.days) {
            if (!(teacher.availableDays || []).includes(day) || !(room.availableDays || []).includes(day)) continue;
            const first = Math.max(state.settings.startTime, Number(teacher.availableStart ?? state.settings.startTime));
            const last = Math.min(state.settings.endTime, Number(teacher.availableEnd ?? state.settings.endTime));
            for (let start = first; start + task.duration * 60 <= last; start += state.settings.interval) {
              const end = start + task.duration * 60;
              const candidate = { day, start, end, teacherId: teacher.id, roomId: room.id, sectionId: task.sectionId, subjectId: task.subjectId, batchIndex: task.batchIndex, meetingType: task.meetingType };
              if (hasHardConflict(candidate, [...baseSchedules])) continue;
              if (state.consultationPeriods.some(c => c.teacherId === teacher.id && c.day === day && timeOverlaps(start, end, c.start, c.end))) continue;
              let score = 0;
              const prefStart = Number(teacher.preferredStart ?? 480), prefEnd = Number(teacher.preferredEnd ?? 1080);
              if (state.settings.preferences.respectPreferredTimes && (start < prefStart || end > prefEnd)) score += 18;
              const teacherDay = baseSchedules.filter(s => s.teacherId === teacher.id && s.day === day);
              const sectionDay = baseSchedules.filter(s => s.sectionId === task.sectionId && s.day === day);
              if (state.settings.preferences.reduceGaps && teacherDay.length) {
                const nearest = Math.min(...teacherDay.map(s => Math.min(Math.abs(start - s.end), Math.abs(end - s.start))));
                score += Math.min(12, nearest / 60);
              }
              if (state.settings.preferences.distributeSubjects && sectionDay.some(s => s.subjectId === task.subjectId)) score += 8;
              if (state.settings.preferences.avoidLongConsecutive && teacherDay.some(s => (Math.max(end, s.end) - Math.min(start, s.start)) / 60 > state.settings.preferences.maxConsecutiveHours)) score += 10;
              // A small tie-breaker creates different proposals when the administrator retries.
              score += retry ? Math.random() * 1.2 : Math.random() * 0.15;
              candidates.push({ ...candidate, score });
            }
          }
        }
      }
      candidates.sort((a,b) => a.score - b.score);
      taskCandidates.set(task.id, candidates.slice(0, 50));
      if (!candidates.length && !candidateReasons.has(task.id)) candidateReasons.set(task.id, 'No valid combination of teacher, venue, day, and time is available. Review availability, loads, and existing locked meetings.');
    }

    // Most constrained tasks are assigned first to reduce the search space.
    tasks.sort((a,b) => (taskCandidates.get(a.id).length - taskCandidates.get(b.id).length) || b.duration - a.duration);
    const chosen = [];
    const skipped = [];
    let attempts = 0;
    const maxAttempts = 120000;
    let best = [];
    let finished = false;

    function search(index) {
      if (attempts >= maxAttempts) return false;
      attempts++;
      if (chosen.length > best.length) best = [...chosen];
      if (index >= tasks.length) { if (chosen.length === tasks.length) finished = true; return chosen.length === tasks.length; }
      const task = tasks[index];
      const candidates = taskCandidates.get(task.id) || [];
      for (const candidate of candidates) {
        if (attempts >= maxAttempts) break;
        const allCurrent = [...baseSchedules, ...chosen.map(c => c.schedule)];
        if (!canAssignCandidate(candidate, task, allCurrent)) continue;
        const schedule = {
          id: uid('sch'), academicYear, semester, sectionId: task.sectionId, subjectId: task.subjectId,
          teacherId: candidate.teacherId, roomId: candidate.roomId, day: candidate.day, start: candidate.start,
          end: candidate.end, meetingType: task.meetingType, batchIndex: task.batchIndex,
          batchLabel: task.batchLabel, locked: false, source: 'generated'
        };
        chosen.push({ taskId: task.id, schedule });
        if (search(index + 1)) return true;
        chosen.pop();
      }
      // Keep the search moving so a useful partial proposal can still be reviewed.
      if (attempts >= maxAttempts) return false;
      skipped.push(task.id);
      const result = search(index + 1);
      skipped.pop();
      return result;
    }

    search(0);
    const placed = best.map(item => item.schedule);
    const placedTaskIds = new Set(best.map(item => item.taskId));
    const unscheduled = tasks.filter(task => !placedTaskIds.has(task.id)).map(task => ({
      taskId: task.id, sectionCode: task.sectionCode, subjectCode: task.subjectCode, meetingLabel: task.meetingLabel,
      reason: candidateReasons.get(task.id) || 'A valid slot could not be found within the search limit. Try another arrangement or review other assigned meetings and teaching-load limits.'
    }));
    const proposal = [...baseSchedules, ...placed];
    const conflicts = findAllConflicts(proposal);
    const conflictsCount = conflicts.length;
    generatorResult = {
      academicYear, semester, sectionIds, placed, baseSchedules, unscheduled, conflicts,
      complete: unscheduled.length === 0 && conflictsCount === 0,
      placedCount: placed.length, placed: placed.length, generatedSchedules: placed, conflicts: conflictsCount, attempts,
      message: unscheduled.length ? 'The generator placed as many valid meetings as it could. Some meetings need administrator review.' : 'All generated meetings were assigned without detected hard overlaps.',
      proposal, taskNotes: notes, finished
    };
    // Keep last result summary in the exported data for dashboard reporting.
    state.lastGeneration = { unscheduled, generatedAt: nowISO(), complete: generatorResult.complete };
    saveState('Generated a proposed timetable.');
    renderApp();
    showToast(generatorResult.complete ? 'Proposed timetable generated successfully.' : 'Partial timetable generated. Review unscheduled meetings.', generatorResult.complete ? 'success' : 'info');
  }

  function canAssignCandidate(candidate, task, schedules) {
    if (hasHardConflict(candidate, schedules)) return false;
    if (state.consultationPeriods.some(c => c.teacherId === candidate.teacherId && c.day === candidate.day && timeOverlaps(candidate.start, candidate.end, c.start, c.end))) return false;
    const teacher = byId(state.teachers, candidate.teacherId);
    if (!teacher || teacher.active === false) return false;
    const weeklyHours = schedules.filter(s => s.teacherId === teacher.id).reduce((sum,s)=>sum+(s.end-s.start)/60,0) + task.duration;
    if (weeklyHours > Number(teacher.maxWeeklyHours || 999)) return false;
    const dailyHours = schedules.filter(s => s.teacherId === teacher.id && s.day === candidate.day).reduce((sum,s)=>sum+(s.end-s.start)/60,0) + task.duration;
    if (dailyHours > Number(teacher.maxDailyHours || 999)) return false;
    return true;
  }

  function timeOverlaps(aStart, aEnd, bStart, bEnd) { return aStart < bEnd && bStart < aEnd; }

  function sameSectionConflict(a, b) {
    if (a.sectionId !== b.sectionId) return false;
    // Distinct stable batch indexes represent different student groups and may overlap.
    if (a.batchIndex !== null && a.batchIndex !== undefined && b.batchIndex !== null && b.batchIndex !== undefined && Number(a.batchIndex) !== Number(b.batchIndex)) return false;
    return true;
  }

  function hasHardConflict(candidate, schedules, ignoreId = null) {
    for (const existing of schedules) {
      if (existing.id === ignoreId || existing.day !== candidate.day || !timeOverlaps(candidate.start, candidate.end, existing.start, existing.end)) continue;
      if (existing.teacherId === candidate.teacherId) return true;
      if (existing.roomId === candidate.roomId && byId(state.rooms,candidate.roomId)?.type !== 'online') return true;
      if (sameSectionConflict(existing, candidate)) return true;
    }
    return false;
  }

  function validateSchedule(schedule, ignoreId = null, includeCapacity = true) {
    const issues = [];
    const teacher = byId(state.teachers, schedule.teacherId);
    const section = byId(state.sections, schedule.sectionId);
    const subject = byId(state.subjects, schedule.subjectId);
    const room = byId(state.rooms, schedule.roomId);
    if (!section) issues.push('Choose a valid section.');
    if (!subject) issues.push('Choose a valid subject.');
    else if (section && !getCurriculumSubjectIds(section).includes(subject.id)) issues.push(`${subject.code} is not assigned to ${section.code} in the selected curriculum.`);
    if (!teacher) issues.push('Choose an assigned teacher.');
    if (!room) issues.push('Choose a venue.');
    if (!schedule.day || !state.settings.days.includes(schedule.day)) issues.push('Choose an available class day.');
    if (!Number.isFinite(schedule.start) || !Number.isFinite(schedule.end) || schedule.start >= schedule.end) issues.push('Enter a valid start and end time.');
    if (schedule.start < state.settings.startTime || schedule.end > state.settings.endTime) issues.push('Class must fit within the configured school hours.');
    if (schedule.start % state.settings.interval || schedule.end % state.settings.interval) issues.push('Start and end times must follow 30-minute increments.');
    if (schedule.duration && schedule.end - schedule.start !== schedule.duration) { /* duration is optional when editing */ }
    if (teacher && !teacher.qualifiedSubjectIds.includes(schedule.subjectId)) issues.push(`${teacher.name} is not marked as qualified for ${subject?.code || 'this subject'}.`);
    if (subject) {
      const actualHours = (schedule.end - schedule.start) / 60;
      const requiredHours = subject.classification === 'major' ? (schedule.meetingType === 'lab' ? Number(subject.labHours || 3) : Number(subject.lectureHours || 2)) : Number(subject.weeklyHours || subject.units || 2);
      if (Number.isFinite(actualHours) && Math.abs(actualHours - requiredHours) > 0.001) issues.push(`${subject.code} ${schedule.meetingType} meeting must be ${requiredHours} hour(s), not ${actualHours}.`);
    }
    if (teacher && (!(teacher.availableDays || []).includes(schedule.day) || schedule.start < teacher.availableStart || schedule.end > teacher.availableEnd)) issues.push('The selected class is outside the teacher’s availability.');
    if (teacher && state.consultationPeriods.some(c => c.teacherId === teacher.id && c.day === schedule.day && timeOverlaps(schedule.start, schedule.end, c.start, c.end))) issues.push('The selected time overlaps a reserved teacher consultation period.');
    if (teacher) {
      const other = state.schedules.filter(s => s.teacherId === teacher.id && s.id !== ignoreId && (s.academicYear || state.settings.academicYear) === state.settings.academicYear && (s.semester || state.settings.semester) === state.settings.semester);
      const weekly = other.reduce((sum,s)=>sum+durationHours(s),0) + Math.max(0, (schedule.end - schedule.start)/60);
      const daily = other.filter(s=>s.day===schedule.day).reduce((sum,s)=>sum+durationHours(s),0) + Math.max(0, (schedule.end-schedule.start)/60);
      if (weekly > Number(teacher.maxWeeklyHours || 999)) issues.push(`This would exceed ${teacher.name}’s maximum weekly teaching hours.`);
      if (daily > Number(teacher.maxDailyHours || 999)) issues.push(`This would exceed ${teacher.name}’s maximum daily teaching hours.`);
    }
    if (room && (room.status !== 'Available' || !(room.availableDays || []).includes(schedule.day))) issues.push('The selected venue is unavailable on this day.');
    if (room && subject) {
      const requiredType = requiredRoomType(schedule.meetingType, subject);
      if (room.type !== requiredType) issues.push(`This meeting requires a ${requiredType} venue.`);
    }
    if (room && includeCapacity && room.type === 'lab' && section) {
      const batchSizes = getSectionBatchSizes(section);
      const batchSize = schedule.batchIndex === null || schedule.batchIndex === undefined
        ? Number(section.studentCount)
        : Number(batchSizes[Number(schedule.batchIndex)] || section.studentCount);
      if (Number(room.capacity) < batchSize) issues.push(`Laboratory capacity (${room.capacity}) is smaller than the assigned group (${batchSize}).`);
    }
    if (schedule.day && Number.isFinite(schedule.start) && Number.isFinite(schedule.end)) {
      const candidate = { ...schedule };
      const overlaps = state.schedules.filter(s => s.id !== ignoreId && (s.academicYear || state.settings.academicYear) === state.settings.academicYear && (s.semester || state.settings.semester) === state.settings.semester && s.day === candidate.day && timeOverlaps(candidate.start,candidate.end,s.start,s.end));
      for (const existing of overlaps) {
        if (existing.teacherId === candidate.teacherId) issues.push(`Teacher conflict with ${subjectCode(existing.subjectId)} in ${sectionName(existing.sectionId)}.`);
        if (existing.roomId === candidate.roomId && byId(state.rooms,candidate.roomId)?.type !== 'online') issues.push(`Venue conflict in ${roomName(existing.roomId)}.`);
        if (sameSectionConflict(existing,candidate)) issues.push(`Section conflict with ${subjectCode(existing.subjectId)} in ${sectionName(existing.sectionId)}.`);
      }
    }
    return [...new Set(issues)];
  }

  function approveGenerated() {
    if (!generatorResult || !generatorResult.generatedSchedules?.length) return;
    const conflicts = findAllConflicts(generatorResult.proposal);
    if (conflicts.length) { showToast('The proposed timetable has conflicts and cannot be approved.', 'error'); return; }
    const { sectionIds, semester, academicYear, baseSchedules, generatedSchedules } = generatorResult;
    const placed = generatedSchedules;
    const sectionSet = new Set(sectionIds);
    const replaceable = state.schedules.filter(s => !s.locked && sectionSet.has(s.sectionId) && (s.semester || state.settings.semester) === semester && (s.academicYear || state.settings.academicYear) === academicYear);
    state.schedules = state.schedules.filter(s => !replaceable.some(old => old.id === s.id));
    state.schedules.push(...placed);
    state.settings.academicYear = academicYear;
    state.settings.semester = semester;
    saveState(`Approved ${placed.length} generated class meeting(s).`);
    generatorResult = null;
    currentPage = 'schedules';
    showToast(`${placed.length} generated meeting(s) saved.`, 'success');
    renderApp();
  }

  function field(label, name, value = '', type = 'text', options = null, attrs = '') {
    let control = '';
    if (type === 'select') {
      control = `<select name="${name}" id="field_${name}" ${attrs}>${(options || []).map(option => {
        const item = typeof option === 'string' ? { value: option, label: option } : option;
        return `<option value="${escapeHTML(item.value)}" ${String(item.value) === String(value) ? 'selected' : ''}>${escapeHTML(item.label)}</option>`;
      }).join('')}</select>`;
    } else if (type === 'textarea') {
      control = `<textarea name="${name}" id="field_${name}" ${attrs}>${escapeHTML(value)}</textarea>`;
    } else if (type === 'password') {
      control = `<div class="password-input-wrap"><input type="password" name="${name}" id="field_${name}" value="${escapeHTML(value)}" ${attrs}><button class="password-toggle" type="button" data-password-target="field_${name}" aria-label="Show password" aria-pressed="false">Show</button></div>`;
    } else {
      control = `<input type="${type}" name="${name}" id="field_${name}" value="${escapeHTML(value)}" ${attrs}>`;
    }
    return `<div class="form-field"><label for="field_${name}">${label}</label>${control}</div>`;
  }

  function checkboxOptions(label, name, values, selected = [], full = true) {
    const options = values.map(value => typeof value === 'string' ? { value, label: value } : value);
    return `<div class="form-field ${full ? 'full' : ''}"><label>${label}</label><div class="checkbox-grid">${options.map(item => `<label class="check-option"><input type="checkbox" name="${name}" value="${escapeHTML(item.value)}" ${selected.includes(item.value) ? 'checked' : ''}> ${escapeHTML(item.label)}</label>`).join('')}</div></div>`;
  }

  function openModal(title, subtitle, body, submitLabel = 'Save changes', wide = false, formId = 'entityForm') {
    $('#modalRoot').innerHTML = `<div class="modal-backdrop" data-modal-backdrop><section class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modalTitle"><div class="modal-header"><div><h2 id="modalTitle">${escapeHTML(title)}</h2><p>${escapeHTML(subtitle || '')}</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="Close">×</button></div><form id="${formId}" class="modal-body" autocomplete="off"><div class="form-grid">${body}</div><div id="formValidation" class="form-field full" style="margin-top:13px"></div><div class="modal-footer"><button class="btn btn-secondary" type="button" data-action="close-modal">Cancel</button><button class="btn btn-primary" type="submit">${escapeHTML(submitLabel)}</button></div></form></section></div>`;
    const first = $('input,select,textarea,button', $('#modalRoot'));
    first?.focus();
  }

  function openEntityForm(type, id = null) {
    const record = id ? getEntity(type, id) : null;
    const editing = Boolean(record);
    let body = '';
    let title = `${editing ? 'Edit' : 'Add'} ${entityLabel(type)}`;
    const isActive = record?.active !== false;

    if (type === 'teacher') {
      body += field('Teacher ID', 'code', record?.code || nextCode('T', state.teachers), 'text', null, 'required');
      body += field('Full name', 'name', record?.name || '', 'text', null, 'required');
      body += field('Department', 'department', record?.department || 'Computing Studies');
      body += field('Maximum weekly teaching hours', 'maxWeeklyHours', record?.maxWeeklyHours ?? 30, 'number', null, 'min="1" max="60" required');
      body += field('Maximum teaching hours per day', 'maxDailyHours', record?.maxDailyHours ?? 8, 'number', null, 'min="1" max="14" required');
      body += checkboxOptions('Available days', 'availableDays', DAYS, record?.availableDays || [...DAYS]);
      body += field('Available from', 'availableStart', timeInput(record?.availableStart ?? START_OF_DAY), 'time', null, 'step="1800" required');
      body += field('Available until', 'availableEnd', timeInput(record?.availableEnd ?? END_OF_DAY), 'time', null, 'step="1800" required');
      body += field('Preferred start time', 'preferredStart', timeInput(record?.preferredStart ?? 480), 'time', null, 'step="1800"');
      body += field('Preferred end time', 'preferredEnd', timeInput(record?.preferredEnd ?? 1080), 'time', null, 'step="1800"');
      body += checkboxOptions('Qualified subjects', 'qualifiedSubjectIds', state.subjects.map(s => ({ value: s.id, label: `${s.code} · ${s.classification}` })), record?.qualifiedSubjectIds || []);
      body += `<div class="form-field full"><label class="check-option"><input type="checkbox" name="active" value="true" ${isActive ? 'checked' : ''}> Teacher is active</label><span class="form-hint">Inactive teachers are not considered by automatic generation.</span></div>`;
    } else if (type === 'program') {
      body += field('Program code', 'code', record?.code || '', 'text', null, 'required');
      body += field('Program name', 'name', record?.name || '', 'text', null, 'required');
      body += field('Year levels', 'yearLevelsText', (record?.yearLevels || [1,2,3,4]).join(', '), 'text', null, 'required');
      body += `<div class="form-field full"><span class="form-hint">Enter year levels separated by commas, for example: 1, 2, 3, 4.</span></div>`;
      body += `<div class="form-field full"><label class="check-option"><input type="checkbox" name="active" value="true" ${isActive ? 'checked' : ''}> Program is active</label></div>`;
    } else if (type === 'curriculum') {
      body += field('Academic program', 'programId', record?.programId || state.programs[0]?.id, 'select', state.programs.map(p => ({ value:p.id,label:`${p.code} · ${p.name}` })), 'required');
      body += field('Year level', 'yearLevel', record?.yearLevel || 1, 'select', [1,2,3,4].map(v=>({value:v,label:`Year ${v}`})), 'required');
      body += field('Semester', 'semester', record?.semester || state.settings.semester, 'select', ['First Semester','Second Semester','Summer'], 'required');
      body += checkboxOptions('Subjects in this curriculum', 'subjectIds', state.subjects.map(s=>({value:s.id,label:`${s.code} · ${s.classification}`})), record?.subjectIds || []);
      title = `${editing ? 'Edit' : 'Add'} curriculum mapping`;
    } else if (type === 'section') {
      body += field('Section code', 'code', record?.code || '', 'text', null, 'required');
      body += field('Academic year', 'academicYear', record?.academicYear || state.settings.academicYear, 'text', null, 'required');
      body += field('Academic program', 'programId', record?.programId || state.programs[0]?.id, 'select', state.programs.map(p=>({value:p.id,label:p.code})), 'required');
      body += field('Year level', 'yearLevel', record?.yearLevel || 1, 'select', [1,2,3,4].map(v=>({value:v,label:`Year ${v}`})), 'required');
      body += field('Semester', 'semester', record?.semester || state.settings.semester, 'select', ['First Semester','Second Semester','Summer'], 'required');
      body += field('Number of students', 'studentCount', record?.studentCount ?? 30, 'number', null, 'min="1" max="500" required');
      body += field('Custom laboratory batch sizes (optional)', 'labBatchSizesText', (record?.labBatchSizes || []).join(', '), 'text', null, 'placeholder="Leave blank to calculate from room capacity; e.g. 20, 22"');
      body += `<div class="form-field full"><span class="form-hint">Leave blank to calculate batches automatically using the largest available computer laboratory. Or enter comma-separated group sizes that add up to the section enrolment.</span></div>`;
      body += `<div class="form-field full"><label class="check-option"><input id="customCurriculumToggle" type="checkbox" name="customizeCurriculum" value="true" ${Array.isArray(record?.customSubjectIds) ? 'checked' : ''}> Customize subjects for this section instead of inheriting the default curriculum</label></div>`;
      body += `<div id="sectionSubjectChoices" class="form-field full ${Array.isArray(record?.customSubjectIds) ? '' : 'hidden'}"><label>Section-specific subjects</label><div class="checkbox-grid">${state.subjects.map(s=>`<label class="check-option"><input type="checkbox" name="customSubjectIds" value="${s.id}" ${(record?.customSubjectIds || []).includes(s.id) ? 'checked' : ''}> ${escapeHTML(s.code)}</label>`).join('')}</div></div>`;
      body += `<div class="form-field full"><label class="check-option"><input type="checkbox" name="active" value="true" ${isActive ? 'checked' : ''}> Section is active</label></div>`;
    } else if (type === 'subject') {
      body += field('Subject code', 'code', record?.code || '', 'text', null, 'required');
      body += field('Subject name', 'name', record?.name || '', 'text', null, 'required');
      body += field('Classification', 'classification', record?.classification || 'minor', 'select', ['major','minor'], 'required');
      body += field('Units', 'units', record?.units ?? 3, 'number', null, 'min="1" max="10" required');
      body += field('Lecture hours (major)', 'lectureHours', record?.lectureHours ?? 2, 'number', null, 'min="0" max="8" step="0.5"');
      body += field('Laboratory hours (major)', 'labHours', record?.labHours ?? 3, 'number', null, 'min="0" max="8" step="0.5"');
      body += field('Weekly hours (minor)', 'weeklyHours', record?.weeklyHours ?? 3, 'number', null, 'min="1" max="8" step="0.5"');
      body += field('Default venue type (minor)', 'roomType', record?.roomType || 'lecture', 'select', ['lecture','online','gym','other'], 'required');
      body += `<div class="form-field full"><span class="form-hint">Major subjects generate a separate lecture and laboratory meeting. Minor subjects generate one weekly meeting. The values above can be customized for each subject.</span></div>`;
      body += `<div class="form-field full"><label class="check-option"><input type="checkbox" name="active" value="true" ${isActive ? 'checked' : ''}> Subject is active</label></div>`;
    } else if (type === 'room') {
      body += field('Room / venue code', 'code', record?.code || '', 'text', null, 'required');
      body += field('Room name', 'name', record?.name || '', 'text', null, 'required');
      body += field('Venue type', 'type', record?.type || 'lecture', 'select', [{value:'lecture',label:'Lecture classroom'},{value:'lab',label:'Computer laboratory'},{value:'gym',label:'Gym'},{value:'online',label:'Online'},{value:'other',label:'Other special venue'}], 'required');
      body += field('Capacity (required for computer labs)', 'capacity', record?.capacity ?? '', 'number', null, 'min="1" max="1000"');
      body += field('Status', 'status', record?.status || 'Available', 'select', ['Available','Unavailable'], 'required');
      body += checkboxOptions('Available days', 'availableDays', DAYS, record?.availableDays || [...DAYS]);
      body += `<div class="form-field full"><span class="form-hint">Laboratory capacity is strictly checked. Lecture room capacities are recorded but do not block assignments.</span></div>`;
    } else if (type === 'student') {
      body += field('Student number', 'studentNo', record?.studentNo || '', 'text', null, 'required');
      body += field('Full name', 'name', record?.name || '', 'text', null, 'required');
      body += field('Assigned section', 'sectionId', record?.sectionId || state.sections[0]?.id, 'select', state.sections.map(s=>({value:s.id,label:s.code})), 'required');
      body += checkboxOptions('Additional section schedules (for irregular students)', 'additionalSectionIds', state.sections.map(s=>({value:s.id,label:s.code})), record?.additionalSectionIds || []);
      body += `<div class="form-field full"><span class="form-hint">Optional. Select other sections whose class meetings this student attends. This keeps irregular-student access simple without a separate irregular-student module.</span></div>`;
      body += checkboxOptions('Specific subjects (leave empty to follow selected section curricula)', 'enrolledSubjectIds', state.subjects.map(s=>({value:s.id,label:s.code})), record?.enrolledSubjectIds || []);
      const selectedSection = byId(state.sections, record?.sectionId || state.sections[0]?.id);
      const studentBatchCount = selectedSection ? getSectionBatchSizes(selectedSection).length : 1;
      body += field('Laboratory batch (optional)', 'batchIndex', record?.batchIndex ?? '', 'select', [{value:'',label:'Not assigned / show all batches'}, ...getSectionBatchSizes(selectedSection).map((size,i)=>({value:i,label:`Batch ${i+1} · ${size} students`}))]);
      body += `<div class="form-field full"><span class="form-hint">Assign a batch when this student should see only one subgroup’s laboratory meetings. Whole-section lectures remain visible.</span></div>`;
      body += `<div class="form-field full"><label class="check-option"><input type="checkbox" name="active" value="true" ${isActive ? 'checked' : ''}> Student is active</label></div>`;
    } else if (type === 'account') {
      body += field('Display name', 'displayName', record?.displayName || '', 'text', null, 'required');
      if (cloudMode) {
        body += field('Email address', 'email', record?.email || '', 'email', null, 'required');
        body += field(editing ? 'New password (optional)' : 'Initial password', 'password', '', 'password', null, editing ? 'minlength="10" autocomplete="new-password" placeholder="Leave blank to keep the current password"' : 'minlength="10" autocomplete="new-password" required');
      } else {
        body += field('Username', 'username', record?.username || '', 'text', null, 'required');
        body += field('Password', 'password', record?.password || '', 'password', null, 'required');
      }
      body += field('Role', 'role', record?.role || 'student', 'select', [{value:'admin',label:'Administrator'},{value:'teacher',label:'Teacher'},{value:'student',label:'Student'}], 'required');
      body += field('Linked teacher / student record', 'linkedId', record?.linkedId || '', 'select', [{value:'',label:'No linked record'}, ...state.teachers.map(t=>({value:t.id,label:`Teacher · ${t.name}`})), ...state.students.map(s=>({value:s.id,label:`Student · ${s.name}`}))]);
      body += `<div class="form-field full"><label class="check-option"><input type="checkbox" name="active" value="true" ${isActive ? 'checked' : ''}> Account is active</label></div>`;
      body += `<div class="form-field full"><span class="form-hint">${cloudMode ? 'Use a temporary password of at least 10 characters and share it securely with the account owner.' : 'Enter an initial password for this account.'}</span></div>`;
    } else if (type === 'schedule') {
      const section = record ? byId(state.sections, record.sectionId) : state.sections[0];
      const sectionSubjects = section ? getCurriculumSubjectIds(section) : [];
      const sectionBatchCount = section ? getSectionBatchSizes(section).length : 1;
      body += field('Section', 'sectionId', record?.sectionId || section?.id, 'select', state.sections.map(s=>({value:s.id,label:s.code})), 'required');
      body += field('Subject', 'subjectId', record?.subjectId || sectionSubjects[0], 'select', state.subjects.filter(s => sectionSubjects.includes(s.id)).map(s=>({value:s.id,label:`${s.code} · ${s.name}`})), 'required');
      body += field('Meeting type', 'meetingType', record?.meetingType || defaultMeetingType(byId(state.subjects, record?.subjectId || sectionSubjects[0])), 'select', [{value:'lecture',label:'Lecture'},{value:'lab',label:'Laboratory'},{value:'online',label:'Online'},{value:'gym',label:'Gym / physical activity'},{value:'other',label:'Other special venue'}], 'required');
      body += field('Teacher', 'teacherId', record?.teacherId || state.teachers.find(t=>t.qualifiedSubjectIds.includes(record?.subjectId || sectionSubjects[0]))?.id, 'select', state.teachers.map(t=>({value:t.id,label:t.name})), 'required');
      body += field('Venue', 'roomId', record?.roomId || state.rooms.find(r=>r.type==='lecture')?.id, 'select', state.rooms.map(r=>({value:r.id,label:`${r.code} · ${r.type}`})), 'required');
      body += field('Day', 'day', record?.day || state.settings.days[0], 'select', state.settings.days, 'required');
      body += field('Start time', 'startTime', timeInput(record?.start ?? 420), 'time', null, 'step="1800" required');
      body += field('End time', 'endTime', timeInput(record?.end ?? 540), 'time', null, 'step="1800" required');
      body += field('Batch (optional)', 'batchIndex', record?.batchIndex ?? '', 'select', [{value:'',label:'Whole section'}, ...Array.from({length:sectionBatchCount},(_,i)=>({value:i,label:`Batch ${i+1}`}))]);
      body += `<div class="form-field full"><span class="form-hint">Choose a batch only for split-group meetings. Distinct batches can overlap only when different teachers and venues are assigned.</span></div>`;
      body += `<div id="scheduleValidationFeedback" class="form-field full"></div>`;
    }

    const formId = type === 'settings' ? 'settingsForm' : 'entityForm';
    openModal(title, editing ? 'Update this record and validate related scheduling rules.' : 'Complete the details below. Required fields are marked by the browser.', body, editing ? 'Save changes' : `Add ${entityLabel(type).toLowerCase()}`, ['teacher','student','subject','section','schedule','curriculum'].includes(type), formId);
    const form = $('#entityForm');
    if (form) {
      form.dataset.type = type;
      form.dataset.id = id || '';
    }
    if (type === 'section') $('#customCurriculumToggle')?.addEventListener('change', event => $('#sectionSubjectChoices').classList.toggle('hidden', !event.target.checked));
    if (type === 'schedule') { updateScheduleFormOptions(form); updateScheduleValidationFeedback(); }
  }

  function entityLabel(type) {
    return ({ teacher: 'teacher', program: 'program', curriculum: 'curriculum mapping', section: 'section', subject: 'subject', room: 'venue', student: 'student', account: 'user account', schedule: 'class meeting' })[type] || type;
  }

  function getEntity(type, id) {
    const collection = ({teacher:'teachers',program:'programs',curriculum:'curriculum',section:'sections',subject:'subjects',room:'rooms',student:'students',account:'users',schedule:'schedules'})[type];
    return collection ? byId(state[collection], id) : null;
  }

  function nextCode(prefix, collection) {
    const n = collection.length + 1;
    return `${prefix}${String(n).padStart(3,'0')}`;
  }

  function collectChecked(form, name) { return $$(`input[name="${name}"]:checked`, form).map(input => input.value); }

  function handleModalSubmit(event) {
    const consultationForm = event.target.closest('#consultationForm');
    if (consultationForm) { event.preventDefault(); saveConsultationForm(consultationForm); return; }
    const form = event.target.closest('#entityForm, #settingsForm');
    if (!form) return;
    event.preventDefault();
    if (form.id === 'settingsForm') return saveSettingsFromForm(form);
    saveEntityForm(form);
  }

  function saveEntityForm(form) {
    const type = form.dataset.type;
    if (type === 'account') {
      if (!cloudMode || !supabaseClient) {
        showToast('Account management is temporarily unavailable. Please contact the system administrator.', 'error');
        return;
      }
      handleCloudAccountSave(form);
      return;
    }
    const id = form.dataset.id || null;
    const existing = id ? getEntity(type, id) : null;
    const editing = Boolean(existing);
    const data = new FormData(form);
    const checked = name => collectChecked(form, name);
    let record = existing ? clone(existing) : { id: uid(type) };
    const value = name => data.get(name);
    const isChecked = name => form.querySelector(`[name="${name}"]`)?.checked || false;

    if (type === 'teacher') {
      record.code = normalizeCode(value('code'));
      record.name = value('name').trim();
      record.department = value('department').trim();
      record.maxWeeklyHours = Number(value('maxWeeklyHours'));
      record.maxDailyHours = Number(value('maxDailyHours'));
      record.availableDays = checked('availableDays');
      record.availableStart = parseTime(value('availableStart'));
      record.availableEnd = parseTime(value('availableEnd'));
      record.preferredStart = parseTime(value('preferredStart'));
      record.preferredEnd = parseTime(value('preferredEnd'));
      record.qualifiedSubjectIds = checked('qualifiedSubjectIds');
      record.active = isChecked('active');
      if (!record.code || !record.name || !record.availableDays.length || record.availableStart >= record.availableEnd) return showToast('Complete the teacher details and valid availability.', 'error');
      if (state.teachers.some(t => normalizeCode(t.code) === record.code && t.id !== id)) return showToast('Teacher ID already exists.', 'error');
    } else if (type === 'program') {
      record.code = normalizeCode(value('code'));
      record.name = value('name').trim();
      record.yearLevels = [...new Set(String(value('yearLevelsText')).split(',').map(v=>Number(v.trim())).filter(v=>v>=1&&v<=8))].sort();
      record.active = isChecked('active');
      if (!record.code || !record.name || !record.yearLevels.length) return showToast('Enter a program code, name, and valid year levels.', 'error');
      if (state.programs.some(p=>normalizeCode(p.code)===record.code&&p.id!==id)) return showToast('Program code already exists.','error');
    } else if (type === 'curriculum') {
      record.programId = value('programId');
      record.yearLevel = Number(value('yearLevel'));
      record.semester = value('semester');
      record.subjectIds = checked('subjectIds');
      if (!record.programId || !record.subjectIds.length) return showToast('Choose a program and at least one subject.', 'error');
      const duplicate = state.curriculum.find(c=>c.id!==id&&c.programId===record.programId&&Number(c.yearLevel)===record.yearLevel&&c.semester===record.semester);
      if (duplicate) return showToast('A curriculum mapping already exists for that program, year, and semester. Edit it instead.', 'error');
    } else if (type === 'section') {
      record.code = normalizeCode(value('code'));
      record.academicYear = value('academicYear').trim();
      record.programId = value('programId');
      record.yearLevel = Number(value('yearLevel'));
      record.semester = value('semester');
      record.studentCount = Number(value('studentCount'));
      const batchSizeText = String(value('labBatchSizesText') || '').trim();
      record.labBatchSizes = batchSizeText ? batchSizeText.split(',').map(value => Number(value.trim())) : null;
      record.customSubjectIds = isChecked('customizeCurriculum') ? checked('customSubjectIds') : null;
      record.active = isChecked('active');
      if (!record.code || !record.academicYear || !record.programId || !record.studentCount || record.studentCount < 1) return showToast('Complete the section details and student count.', 'error');
      if (Array.isArray(record.customSubjectIds) && !record.customSubjectIds.length) return showToast('Choose at least one subject or disable custom curriculum.', 'error');
      if (record.labBatchSizes && (record.labBatchSizes.some(size => !Number.isInteger(size) || size < 1) || record.labBatchSizes.reduce((sum, size) => sum + size, 0) !== record.studentCount)) return showToast('Custom batch sizes must be positive whole numbers that add up exactly to the section enrolment.', 'error');
      if (record.labBatchSizes && record.labBatchSizes.some(size => size > getLargestLabCapacity())) return showToast(`A custom batch cannot exceed the largest available computer laboratory capacity (${getLargestLabCapacity()}).`, 'error');
      if (state.sections.some(s=>normalizeCode(s.code)===record.code&&s.id!==id)) return showToast('Section code already exists.', 'error');
    } else if (type === 'subject') {
      record.code = normalizeCode(value('code'));
      record.name = value('name').trim();
      record.classification = value('classification');
      record.units = Number(value('units'));
      record.lectureHours = Number(value('lectureHours') || 2);
      record.labHours = Number(value('labHours') || 3);
      record.weeklyHours = Number(value('weeklyHours') || record.units || 2);
      record.roomType = value('roomType');
      record.active = isChecked('active');
      if (!record.code || !record.name || !record.units) return showToast('Complete the subject information.', 'error');
      if (record.classification === 'major' && (record.lectureHours <= 0 || record.labHours <= 0)) return showToast('Major subjects need lecture and laboratory hours.', 'error');
      if (state.subjects.some(s=>normalizeCode(s.code)===record.code&&s.id!==id)) return showToast('Subject code already exists.', 'error');
    } else if (type === 'room') {
      record.code = normalizeCode(value('code'));
      record.name = value('name').trim();
      record.type = value('type');
      record.capacity = value('capacity') === '' ? null : Number(value('capacity'));
      record.status = value('status');
      record.availableDays = checked('availableDays');
      if (!record.code || !record.name || !record.availableDays.length) return showToast('Complete the venue information and availability.', 'error');
      if (record.type === 'lab' && (!record.capacity || record.capacity < 1)) return showToast('Computer laboratories require a capacity.', 'error');
      if (state.rooms.some(r=>normalizeCode(r.code)===record.code&&r.id!==id)) return showToast('Venue code already exists.', 'error');
    } else if (type === 'student') {
      record.studentNo = normalizeCode(value('studentNo'));
      record.name = value('name').trim();
      record.sectionId = value('sectionId');
      record.additionalSectionIds = checked('additionalSectionIds').filter(sectionId => sectionId !== record.sectionId);
      record.enrolledSubjectIds = checked('enrolledSubjectIds');
      record.batchIndex = value('batchIndex') === '' ? null : Number(value('batchIndex'));
      record.active = isChecked('active');
      if (!record.studentNo || !record.name || !record.sectionId) return showToast('Complete the student information.', 'error');
      if (state.students.some(s=>normalizeCode(s.studentNo)===record.studentNo&&s.id!==id)) return showToast('Student number already exists.', 'error');
    } else if (type === 'account') {
      record.displayName = value('displayName').trim();
      record.username = value('username').trim().toLowerCase();
      record.password = value('password');
      record.role = value('role');
      record.linkedId = value('linkedId') || null;
      record.active = isChecked('active');
      if (!record.displayName || !record.username || !record.password) return showToast('Complete all account fields.', 'error');
      if (state.users.some(u=>u.username.toLowerCase()===record.username&&u.id!==id)) return showToast('Username already exists.', 'error');
      if (record.role === 'teacher' && record.linkedId && !byId(state.teachers,record.linkedId)) return showToast('Choose a valid teacher record.', 'error');
      if (record.role === 'student' && record.linkedId && !byId(state.students,record.linkedId)) return showToast('Choose a valid student record.', 'error');
    } else if (type === 'schedule') {
      if (existing?.locked) return showToast('Unlock this meeting before editing it.', 'error');
      const sectionId = value('sectionId');
      const subjectId = value('subjectId');
      const meetingType = value('meetingType');
      const batchIndex = value('batchIndex') === '' ? null : Number(value('batchIndex'));
      const day = value('day');
      const start = parseTime(value('startTime'));
      const end = parseTime(value('endTime'));
      record = {
        ...record, sectionId, subjectId, meetingType, teacherId:value('teacherId'), roomId:value('roomId'), day,
        start, end, batchIndex, batchLabel:batchIndex === null ? '' : `Batch ${batchIndex+1}`,
        academicYear:state.settings.academicYear, semester:state.settings.semester, locked:false, source:'manual'
      };
      const issues = validateSchedule(record, id);
      if (issues.length) return showFormIssues(issues);
    }

    const collection = ({teacher:'teachers',program:'programs',curriculum:'curriculum',section:'sections',subject:'subjects',room:'rooms',student:'students',account:'users',schedule:'schedules'})[type];
    if (!collection) return;
    if (existing) {
      const index = state[collection].findIndex(item=>item.id===id);
      state[collection][index] = record;
    } else state[collection].push(record);

    $('#modalRoot').innerHTML = '';
    saveState(`${editing ? 'Updated' : 'Added'} ${entityLabel(type)}: ${record.code || record.name || record.username || record.studentNo || 'record'}.`);
    showToast(`${entityLabel(type)} ${editing ? 'updated' : 'added'} successfully.`);
    renderApp();
  }

  function showFormIssues(issues) {
    const target = $('#formValidation');
    if (target) target.innerHTML = `<div class="notice danger"><span>!</span><div><strong>Please resolve these issues:</strong><ul style="margin:5px 0 0;padding-left:16px">${issues.map(i=>`<li>${escapeHTML(i)}</li>`).join('')}</ul></div></div>`;
    showToast('The record was not saved because validation failed.', 'error');
  }

  function updateScheduleFormOptions(form, changed = 'open') {
    if (!form) return;
    const section = byId(state.sections, form.querySelector('[name="sectionId"]')?.value);
    const subjectSelect = form.querySelector('[name="subjectId"]');
    const teacherSelect = form.querySelector('[name="teacherId"]');
    const roomSelect = form.querySelector('[name="roomId"]');
    const batchSelect = form.querySelector('[name="batchIndex"]');
    if (!section) return;

    const subjectIds = getCurriculumSubjectIds(section);
    if (subjectSelect && (changed === 'open' || changed === 'sectionId')) {
      const previous = subjectSelect.value;
      const subjects = state.subjects.filter(subject => subjectIds.includes(subject.id));
      subjectSelect.innerHTML = subjects.map(subject => `<option value="${subject.id}">${escapeHTML(subject.code)} · ${escapeHTML(subject.name)}</option>`).join('');
      subjectSelect.value = subjects.some(subject => subject.id === previous) ? previous : (subjects[0]?.id || '');
    }
    const subject = byId(state.subjects, subjectSelect?.value);
    const meetingTypeSelect = form.querySelector('[name="meetingType"]');
    if (meetingTypeSelect && ['sectionId','subjectId'].includes(changed)) meetingTypeSelect.value = defaultMeetingType(subject);
    if (teacherSelect && (changed === 'open' || changed === 'sectionId' || changed === 'subjectId')) {
      const previous = teacherSelect.value;
      const qualified = state.teachers.filter(teacher => (teacher.qualifiedSubjectIds || []).includes(subject?.id));
      teacherSelect.innerHTML = qualified.map(teacher => `<option value="${teacher.id}">${escapeHTML(teacher.name)}</option>`).join('');
      teacherSelect.value = qualified.some(teacher => teacher.id === previous) ? previous : (qualified[0]?.id || '');
    }
    const meetingType = meetingTypeSelect?.value || 'lecture';
    const venueType = requiredRoomType(meetingType, subject);
    if (roomSelect && (changed === 'open' || changed === 'sectionId' || changed === 'subjectId' || changed === 'meetingType')) {
      const previous = roomSelect.value;
      const rooms = state.rooms.filter(room => room.type === venueType);
      roomSelect.innerHTML = rooms.map(room => `<option value="${room.id}">${escapeHTML(room.code)} · ${escapeHTML(room.type)}</option>`).join('');
      roomSelect.value = rooms.some(room => room.id === previous) ? previous : (rooms[0]?.id || '');
    }
    if (batchSelect && (changed === 'open' || changed === 'sectionId' || changed === 'meetingType')) {
      const previous = batchSelect.value;
      const sizes = getSectionBatchSizes(section);
      const options = [{ value: '', label: 'Whole section' }, ...sizes.map((size,index) => ({ value:index, label:`Batch ${index + 1} · ${size} students` }))];
      batchSelect.innerHTML = options.map(option => `<option value="${option.value}">${option.label}</option>`).join('');
      batchSelect.value = options.some(option => String(option.value) === String(previous)) ? previous : '';
      batchSelect.disabled = meetingType !== 'lab';
      if (meetingType !== 'lab') batchSelect.value = '';
    }
  }

  function updateScheduleValidationFeedback() {
    const form = $('#entityForm[data-type="schedule"]');
    const target = $('#scheduleValidationFeedback');
    if (!form || !target) return;
    const data = new FormData(form);
    const schedule = {
      sectionId:data.get('sectionId'), subjectId:data.get('subjectId'), teacherId:data.get('teacherId'), roomId:data.get('roomId'),
      day:data.get('day'), start:parseTime(data.get('startTime')), end:parseTime(data.get('endTime')),
      meetingType:data.get('meetingType'), batchIndex:data.get('batchIndex')===''?null:Number(data.get('batchIndex'))
    };
    if (!schedule.sectionId || !schedule.subjectId || !schedule.teacherId || !schedule.roomId || !schedule.day || schedule.start >= schedule.end) {
      target.innerHTML = '<span class="form-hint">Choose the section, subject, teacher, venue, day, and valid times to check for conflicts.</span>';
      return;
    }
    const issues = validateSchedule(schedule, form.dataset.id || null);
    target.innerHTML = issues.length ? `<div class="notice danger"><span>!</span><div><strong>${issues.length} issue(s) detected</strong>${issues.map(i=>`<div>• ${escapeHTML(i)}</div>`).join('')}</div></div>` : '<div class="notice success"><span>✓</span><div><strong>No immediate conflicts detected.</strong>This meeting currently passes the saved schedule checks.</div></div>';
  }

  function handleModalChange(event) {
    const form = event.target.closest('#entityForm');
    if (form?.dataset.type === 'schedule') {
      if (['sectionId','subjectId','meetingType'].includes(event.target.name)) updateScheduleFormOptions(form, event.target.name);
      updateScheduleValidationFeedback();
    }
    if (form?.dataset.type === 'student' && event.target.name === 'sectionId') {
      const section = byId(state.sections, event.target.value);
      const batchSelect = form.querySelector('[name="batchIndex"]');
      if (batchSelect && section) {
        const previous = batchSelect.value;
        const options = [{ value:'', label:'Not assigned / show all batches' }, ...getSectionBatchSizes(section).map((size,index)=>({value:index,label:`Batch ${index+1} · ${size} students`}))];
        batchSelect.innerHTML = options.map(option=>`<option value="${option.value}">${option.label}</option>`).join('');
        batchSelect.value = options.some(option=>String(option.value)===String(previous)) ? previous : '';
      }
    }
    if (form?.dataset.type === 'section' && event.target.id === 'customCurriculumToggle') $('#sectionSubjectChoices').classList.toggle('hidden', !event.target.checked);
    if (form?.dataset.type === 'subject' && ['field_units','field_classification'].includes(event.target.id)) {
      const classification = form.querySelector('[name="classification"]').value;
      if (classification === 'minor') form.querySelector('[name="weeklyHours"]').value = form.querySelector('[name="units"]').value;
      if (classification === 'major') {
        if (!Number(form.querySelector('[name="lectureHours"]').value)) form.querySelector('[name="lectureHours"]').value = 2;
        if (!Number(form.querySelector('[name="labHours"]').value)) form.querySelector('[name="labHours"]').value = 3;
      }
    }
  }

  function handleModalClick(event) {
    if (event.target.matches('[data-modal-backdrop]')) $('#modalRoot').innerHTML = '';
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'close-modal') $('#modalRoot').innerHTML = '';
  }

  function deleteEntity(type, id) {
    const record = getEntity(type, id);
    if (!record) return;
    if (type === 'account' && cloudMode) { deleteCloudAccount(id); return; }
    const references = {
      teacher: state.schedules.some(s=>s.teacherId===id) || state.users.some(u=>u.role==='teacher'&&u.linkedId===id),
      program: state.sections.some(s=>s.programId===id) || state.curriculum.some(c=>c.programId===id),
      curriculum: false,
      section: state.schedules.some(s=>s.sectionId===id) || state.students.some(s=>s.sectionId===id || (s.additionalSectionIds||[]).includes(id)),
      subject: state.schedules.some(s=>s.subjectId===id) || state.teachers.some(t=>(t.qualifiedSubjectIds||[]).includes(id)) || state.curriculum.some(c=>(c.subjectIds||[]).includes(id)) || state.sections.some(s=>(s.customSubjectIds||[]).includes(id)) || state.students.some(s=>(s.enrolledSubjectIds||[]).includes(id)),
      room: state.schedules.some(s=>s.roomId===id),
      student: state.users.some(u=>u.role==='student'&&u.linkedId===id), account:false, schedule:false
    };
    if (type === 'schedule' && record.locked) return showToast('Unlock the meeting before deleting it.', 'error');
    if (references[type]) return showToast(`Cannot delete this ${entityLabel(type)} while it is referenced by other records. Deactivate it or remove its assignments first.`, 'error');
    if (!window.confirm(`Delete ${entityLabel(type)} “${record.name || record.code || record.username || record.studentNo || 'record'}”? This cannot be undone.`)) return;
    const collection = ({teacher:'teachers',program:'programs',curriculum:'curriculum',section:'sections',subject:'subjects',room:'rooms',student:'students',account:'users',schedule:'schedules'})[type];
    state[collection] = state[collection].filter(item=>item.id!==id);
    if (type === 'teacher') state.users = state.users.filter(u=>!(u.role==='teacher'&&u.linkedId===id));
    if (type === 'student') state.users = state.users.filter(u=>!(u.role==='student'&&u.linkedId===id));
    saveState(`Deleted ${entityLabel(type)}: ${record.name || record.code || record.username || 'record'}.`);
    showToast(`${entityLabel(type)} deleted.`);
    renderApp();
  }

  function buttonOrTarget(event, action) { return Boolean(event.target.closest(`[data-action="${action}"]`)); }

  function handleViewClick(event) {
    const pageButton = event.target.closest('[data-page]');
    if (pageButton) {
      currentPage = pageButton.dataset.page;
      generatorResult = null;
      renderApp();
      return;
    }
    if (buttonOrTarget(event, 'community-refresh')) { void loadCommunityPosts(); return; }
    const communityAction = event.target.closest('[data-action]');
    if (communityAction?.dataset.action === 'community-delete-post') { void deleteCommunityPost(communityAction.dataset.id); return; }
    if (communityAction?.dataset.action === 'community-delete-comment') { void deleteCommunityComment(communityAction.dataset.id); return; }
    if (communityAction?.dataset.action === 'community-status') { void updateCommunityPostStatus(communityAction.dataset.id, communityAction.dataset.status); return; }
    if (event.target.closest('#runGenerator')) { generateSchedule(); return; }
    if (event.target.closest('#retryGenerator')) { generateSchedule({ retry: true }); return; }
    if (event.target.closest('#approveGenerated')) { approveGenerated(); return; }
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const { action, type, id } = button.dataset;
    if (action === 'add') openEntityForm(type);
    else if (action === 'add-consultation') openConsultationForm();
    else if (action === 'delete-consultation') handleConsultationAction(action, id);
    else if (action === 'edit') openEntityForm(type,id);
    else if (action === 'delete') deleteEntity(type,id);
    else if (action === 'view-schedule') showScheduleDetails(id);
    else if (action === 'duplicate-schedule') duplicateSchedule(id);
    else if (action === 'lock-schedule') toggleScheduleLock(id);
    else if (action === 'export-json') exportJSON();
    else if (action === 'import-json') $('#jsonImportInput').click();
    else if (action === 'export-csv') openCSVExportOptions();
    else if (action === 'export-schedules-csv') exportCSV('schedules');
    else if (action === 'import-csv') $('#csvImportInput').click();
    else if (action === 'print-schedules') window.print();
    else if (action === 'run-conflict-check') $('#reportConflictOutput').innerHTML = renderConflictSummary();
    else if (action === 'clear-unlocked') clearUnlockedSchedules();
    else if (action === 'close-modal') $('#modalRoot').innerHTML = '';
  }

  function handleViewInput(event) {
    const searches = { teacherSearch:'teachersTable', sectionSearch:'sectionsTable', subjectSearch:'subjectsTable', roomSearch:'roomsTable', studentSearch:'studentsTable' };
    if (searches[event.target.id]) filterTable(searches[event.target.id], event.target.value);
  }

  function handleViewSubmit(event) {
    if (event.target.id === 'settingsForm') {
      event.preventDefault();
      saveSettingsFromForm(event.target);
      return;
    }
    if (event.target.id === 'communityPostForm') {
      event.preventDefault();
      void submitCommunityPost(event.target);
      return;
    }
    if (event.target.matches('.community-comment-form')) {
      event.preventDefault();
      void submitCommunityComment(event.target);
    }
  }

  function handleViewChange(event) {
    const target = event.target;
    if (target.id === 'settingsForm') return;
    const searches = { teacherSearch:'teachersTable', sectionSearch:'sectionsTable', subjectSearch:'subjectsTable', roomSearch:'roomsTable', studentSearch:'studentsTable' };
    if (searches[target.id]) filterTable(searches[target.id], target.value, target.id);
    if (target.id === 'teacherStatusFilter') filterByCell('teachersTable', target.value, 4);
    if (target.id === 'sectionProgramFilter') filterByCell('sectionsTable', target.value, 0, true);
    if (target.id === 'subjectTypeFilter') filterByCell('subjectsTable', target.value, 1, true);
    if (target.id === 'roomTypeFilter') filterByCell('roomsTable', target.value, 1, true);
    if (target.id === 'studentSectionFilter') filterByCell('studentsTable', target.value, 1, true);
    if (target.id === 'communityCategoryFilter') { communityCategoryFilter = target.value; renderCommunityFeed(); }
    if (target.id === 'communityStatusFilter') { communityStatusFilter = target.value; renderCommunityFeed(); }
    if (target.id === 'scheduleView' || target.id.startsWith('schedule') && target.tagName === 'SELECT') updateScheduleFilters();
  }

  function filterTable(tableId, query) {
    const table = $(`#${tableId}`);
    if (!table) return;
    const q = query.toLowerCase();
    $$('tbody tr', table).forEach(row => row.classList.toggle('hidden', !row.textContent.toLowerCase().includes(q)));
  }

  function filterByCell(tableId, value, cellIndex, dataSearch = false) {
    const table = $(`#${tableId}`);
    if (!table) return;
    $$('tbody tr', table).forEach(row => {
      if (value === 'all') { row.classList.remove('hidden'); return; }
      const text = row.cells[cellIndex]?.textContent || '';
      const match = dataSearch ? row.innerHTML.includes(value) || text.includes(value) : text.toLowerCase().includes(value);
      row.classList.toggle('hidden', !match);
    });
  }

  function duplicateSchedule(id) {
    const source = byId(state.schedules, id);
    if (!source) return;
    openEntityForm('schedule');
    const form = $('#entityForm');
    if (!form) return;
    form.querySelector('[name="sectionId"]').value = source.sectionId;
    updateScheduleFormOptions(form, 'sectionId');
    form.querySelector('[name="subjectId"]').value = source.subjectId;
    updateScheduleFormOptions(form, 'subjectId');
    form.querySelector('[name="meetingType"]').value = source.meetingType;
    updateScheduleFormOptions(form, 'meetingType');
    form.querySelector('[name="teacherId"]').value = source.teacherId;
    form.querySelector('[name="roomId"]').value = source.roomId;
    form.querySelector('[name="day"]').value = source.day;
    form.querySelector('[name="startTime"]').value = timeInput(source.start);
    form.querySelector('[name="endTime"]').value = timeInput(source.end);
    form.querySelector('[name="batchIndex"]').value = source.batchIndex ?? '';
    updateScheduleValidationFeedback();
    $('#modalTitle').textContent = 'Duplicate class meeting';
    $('#modalRoot .modal-header p').textContent = 'A new draft has been prefilled from the selected meeting. Change its day or time to avoid conflicts.';
  }

  function toggleScheduleLock(id) {
    const schedule = byId(state.schedules,id);
    if (!schedule) return;
    schedule.locked = !schedule.locked;
    saveState(`${schedule.locked ? 'Locked' : 'Unlocked'} ${subjectCode(schedule.subjectId)} for ${sectionName(schedule.sectionId)}.`);
    showToast(schedule.locked ? 'Meeting locked against accidental changes.' : 'Meeting unlocked.');
    renderApp();
  }

  function showScheduleDetails(id) {
    const s = byId(state.schedules,id);
    if (!s) return;
    const subject = byId(state.subjects,s.subjectId);
    const section = byId(state.sections,s.sectionId);
    const teacher = byId(state.teachers,s.teacherId);
    const room = byId(state.rooms,s.roomId);
    const body = `<div class="form-grid">
      <div class="form-field"><label>Subject</label><strong>${escapeHTML(subject?.code || '')}</strong><span class="form-hint">${escapeHTML(subject?.name || '')}</span></div>
      <div class="form-field"><label>Section</label><strong>${escapeHTML(section?.code || '')}</strong></div>
      <div class="form-field"><label>Day and time</label><strong>${s.day} · ${fmtTime(s.start)}–${fmtTime(s.end)}</strong></div>
      <div class="form-field"><label>Duration</label><strong>${durationHours(s)} hour(s)</strong></div>
      <div class="form-field"><label>Instructor</label><strong>${escapeHTML(teacher?.name || 'Unassigned')}</strong></div>
      <div class="form-field"><label>Venue</label><strong>${escapeHTML(room?.code || 'Unassigned')}</strong><span class="form-hint">${escapeHTML(room?.name || '')}</span></div>
      <div class="form-field"><label>Meeting type</label><strong>${escapeHTML(s.meetingType)}</strong></div>
      <div class="form-field"><label>Group</label><strong>${escapeHTML(s.batchLabel || 'Whole section')}</strong></div>
      <div class="form-field"><label>Approval status</label><strong>${s.locked ? 'Locked / approved' : 'Draft / editable'}</strong></div>
    </div>`;
    openModal('Class meeting details', 'Review the selected timetable entry.', body, 'Close', false, 'detailForm');
    $('#detailForm .modal-footer')?.classList.add('hidden');
    $('#detailForm')?.insertAdjacentHTML('beforeend', '<div class="modal-footer"><button class="btn btn-secondary" type="button" data-action="close-modal">Close</button></div>');
  }

  function clearUnlockedSchedules() {
    const count = state.schedules.filter(s=>!s.locked).length;
    if (!count) return showToast('There are no unlocked meetings to clear.', 'info');
    if (!window.confirm(`Delete ${count} unlocked meeting(s)? Locked meetings will be preserved.`)) return;
    state.schedules = state.schedules.filter(s=>s.locked);
    saveState(`Cleared ${count} unlocked timetable meeting(s).`);
    showToast(`${count} unlocked meeting(s) cleared.`);
    renderApp();
  }



  function openAccountDetails() {
    const account = currentUser;
    if (!account) return;
    const linked = account.role === 'teacher' ? byId(state.teachers, account.linkedId) : account.role === 'student' ? byId(state.students, account.linkedId) : null;
    const body = `<div class="form-grid"><div class="form-field"><label>Display name</label><strong>${escapeHTML(account.displayName)}</strong></div><div class="form-field"><label>${cloudMode ? 'Email address' : 'Username'}</label><strong>${escapeHTML(account.email || account.username)}</strong></div><div class="form-field"><label>Role</label><strong>${escapeHTML(roleLabel(account.role))}</strong></div><div class="form-field"><label>Linked profile</label><strong>${escapeHTML(linked?.name || 'Administrator account')}</strong></div></div>${cloudMode ? '<div class="notice success" style="margin-top:15px"><span>✓</span><div><strong>Account security</strong>Authentication is handled by the connected sign-in service. Contact the administrator to update your role or linked school record.</div></div>' : ''}`;
    openModal('Account details', 'Information linked to the account currently signed in.', body, 'Close', false, 'accountDetailsForm');
    $('#accountDetailsForm .modal-footer')?.classList.add('hidden');
    $('#accountDetailsForm')?.insertAdjacentHTML('beforeend','<div class="modal-footer"><button class="btn btn-secondary" type="button" data-action="close-modal">Close</button></div>');
  }


  function renderConsultationAdmin() {
    const rows = state.consultationPeriods.map(c=>`<tr><td>${escapeHTML(teacherName(c.teacherId))}</td><td>${escapeHTML(c.day)}</td><td>${fmtTime(c.start)}–${fmtTime(c.end)}</td><td>${escapeHTML(c.note || 'Consultation period')}</td><td><button class="action-button danger" data-action="delete-consultation" data-id="${c.id}">Remove</button></td></tr>`).join('');
    return `${pageHeader('Consultation hours', 'Reserve teacher consultation periods so the generator will not schedule classes during them.', '<button class="btn btn-primary" data-action="add-consultation">＋ Reserve consultation</button>')}
      <div class="notice info" style="margin-bottom:15px"><span>ⓘ</span><div><strong>Vacant-period suggestions</strong>Teachers can see possible vacant one-hour windows in their own portal. Reserved periods here are treated as unavailable during schedule generation and manual validation.</div></div>
      <section class="card"><div class="card-header"><div><h2>Reserved consultation periods</h2><p>${state.consultationPeriods.length} period(s) currently reserved.</p></div></div><div class="table-wrap"><table><thead><tr><th>Teacher</th><th>Day</th><th>Time</th><th>Note</th><th>Action</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No consultation periods have been reserved.</td></tr>'}</tbody></table></div></section>`;
  }

  function openConsultationForm() {
    const body = field('Teacher','teacherId',state.teachers[0]?.id,'select',state.teachers.map(t=>({value:t.id,label:t.name})),'required') +
      field('Day','day',state.settings.days[0],'select',state.settings.days,'required') +
      field('Start time','startTime','10:00','time',null,'step="1800" required') +
      field('End time','endTime','11:00','time',null,'step="1800" required') +
      field('Note (optional)','note','','text');
    openModal('Reserve consultation period','This time will be blocked from class scheduling.',body,'Reserve period',false,'consultationForm');
    $('#consultationForm').dataset.type = 'consultation';
  }

  function saveConsultationForm(form) {
    const data = new FormData(form);
    const period = { id:uid('consult'), teacherId:data.get('teacherId'), day:data.get('day'), start:parseTime(data.get('startTime')), end:parseTime(data.get('endTime')), note:(data.get('note')||'').trim() };
    if (!period.teacherId || period.start >= period.end || period.start % 30 || period.end % 30 || period.start < state.settings.startTime || period.end > state.settings.endTime) return showToast('Enter a valid consultation period using 30-minute increments within school hours.','error');
    const conflicts = state.schedules.some(s=>s.teacherId===period.teacherId&&s.day===period.day&&timeOverlaps(s.start,s.end,period.start,period.end));
    const duplicate = state.consultationPeriods.some(c=>c.teacherId===period.teacherId&&c.day===period.day&&timeOverlaps(c.start,c.end,period.start,period.end));
    if (conflicts || duplicate) return showToast('This consultation period overlaps an existing class or reserved period.','error');
    state.consultationPeriods.push(period);
    $('#modalRoot').innerHTML = '';
    saveState(`Reserved consultation time for ${teacherName(period.teacherId)} on ${period.day}.`);
    showToast('Consultation period reserved.');
    renderApp();
  }

  function exportJSON() {
    const backup = clone(state);
    if (cloudMode) delete backup.users; // Auth identities and passwords are never exported from the browser.
    backup.exportedAt = nowISO();
    backup.application = 'Class Scheduler';
    backup.exportVersion = 2;
    downloadFile(`class-scheduler-workspace-${new Date().toISOString().slice(0,10)}.json`, JSON.stringify(backup,null,2), 'application/json');
    showToast('Workspace backup exported successfully.');
  }

  function importJSONFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        const required = ['programs','curriculum','sections','subjects','teachers','rooms','students','schedules'];
        if (!required.every(key=>Array.isArray(parsed[key])) || typeof parsed.settings !== 'object') throw new Error('The selected file does not look like a Class Scheduler workspace backup.');
        if (!window.confirm(cloudMode ? 'Import this workspace backup and replace all shared academic records in the cloud? Account credentials will not be changed.' : 'Import this backup and replace all data currently saved in this browser?')) return;
        const preservedUsers = cloudMode ? state.users : (Array.isArray(parsed.users) ? parsed.users : []);
        state = { ...makeEmptyWorkspace(), ...parsed };
        state.users = preservedUsers;
        state.consultationPeriods ||= [];
        state.activityLog ||= [];
        saveState('Restored data from a JSON backup.');
        generatorResult = null;
        showToast('Backup restored successfully.');
        renderApp();
      } catch (error) { showToast(error.message || 'Could not import this JSON file.','error'); }
      finally { event.target.value = ''; }
    };
    reader.readAsText(file);
  }

  function csvEscape(value) {
    const text = Array.isArray(value) ? value.join('|') : value == null ? '' : String(value);
    return `"${text.replace(/"/g,'""')}"`;
  }

  function exportCSV(type) {
    const configs = {
      teachers: { name:'teachers', headers:['code','name','department','qualifiedSubjectCodes','maxWeeklyHours','maxDailyHours','availableDays','availableStart','availableEnd','preferredStart','preferredEnd','active'], rows:state.teachers.map(t=>[t.code,t.name,t.department,t.qualifiedSubjectIds.map(subjectCode).join('|'),t.maxWeeklyHours,t.maxDailyHours,t.availableDays.join('|'),timeInput(t.availableStart),timeInput(t.availableEnd),timeInput(t.preferredStart),timeInput(t.preferredEnd),t.active!==false]) },
      subjects: { name:'subjects', headers:['code','name','classification','units','lectureHours','labHours','weeklyHours','roomType','active'], rows:state.subjects.map(s=>[s.code,s.name,s.classification,s.units,s.lectureHours,s.labHours,s.weeklyHours,s.roomType,s.active!==false]) },
      sections: { name:'sections', headers:['code','academicYear','programCode','yearLevel','semester','studentCount','customSubjectCodes','labBatchSizes','active'], rows:state.sections.map(s=>[s.code,s.academicYear||state.settings.academicYear,programName(s.programId),s.yearLevel,s.semester,s.studentCount,Array.isArray(s.customSubjectIds)?s.customSubjectIds.map(subjectCode).join('|'):'',Array.isArray(s.labBatchSizes)?s.labBatchSizes.join('|'):'',s.active!==false]) },
      rooms: { name:'rooms', headers:['code','name','type','capacity','availableDays','status'], rows:state.rooms.map(r=>[r.code,r.name,r.type,r.capacity,r.availableDays.join('|'),r.status]) },
      students: { name:'students', headers:['studentNo','name','sectionCode','additionalSectionCodes','enrolledSubjectCodes','batchIndex','active'], rows:state.students.map(s=>[s.studentNo,s.name,sectionName(s.sectionId),(s.additionalSectionIds||[]).map(sectionName).join('|'),(s.enrolledSubjectIds||[]).map(subjectCode).join('|'),s.batchIndex ?? '',s.active!==false]) },
      schedules: { name:'schedules', headers:['academicYear','semester','day','start','end','subjectCode','sectionCode','batchLabel','teacherName','roomCode','meetingType','locked'], rows:state.schedules.map(s=>[s.academicYear||state.settings.academicYear,s.semester||state.settings.semester,s.day,timeInput(s.start),timeInput(s.end),subjectCode(s.subjectId),sectionName(s.sectionId),s.batchLabel,teacherName(s.teacherId),roomName(s.roomId),s.meetingType,s.locked]) }
    };
    const config = configs[type];
    if (!config) return;
    const csv = [config.headers.map(csvEscape).join(','), ...config.rows.map(row=>row.map(csvEscape).join(','))].join('\r\n');
    downloadFile(`${config.name}-${new Date().toISOString().slice(0,10)}.csv`,csv,'text/csv;charset=utf-8');
    showToast(`${config.name} CSV exported.`);
  }

  function openCSVExportOptions() {
    const options = ['teachers','subjects','sections','rooms','students','schedules'];
    const body = field('Record type','csvType','teachers','select',options.map(v=>({value:v,label:v[0].toUpperCase()+v.slice(1)})));
    openModal('Export records to CSV','Choose which records to download as a CSV file.',body,'Export CSV',false,'csvExportForm');
    $('#csvExportForm').addEventListener('submit',event=>{event.preventDefault();const type=new FormData(event.target).get('csvType');$('#modalRoot').innerHTML='';exportCSV(type);},{once:true});
  }

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type:mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function parseCSV(text) {
    const rows = [];
    let row = [], value = '', quoted = false;
    for (let i=0; i<text.length; i++) {
      const char = text[i];
      if (char === '"' && quoted && text[i+1] === '"') { value += '"'; i++; }
      else if (char === '"') quoted = !quoted;
      else if (char === ',' && !quoted) { row.push(value); value=''; }
      else if ((char === '\n' || char === '\r') && !quoted) {
        if (char === '\r' && text[i+1] === '\n') i++;
        row.push(value); value='';
        if (row.some(cell=>cell.trim()!=='')) rows.push(row);
        row=[];
      } else value += char;
    }
    row.push(value);
    if (row.some(cell=>cell.trim()!=='')) rows.push(row);
    if (!rows.length) return [];
    const headers = rows.shift().map(h=>h.trim());
    return rows.map(values=>Object.fromEntries(headers.map((header,index)=>[header,(values[index]||'').trim()])));
  }

  function importCSVFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const rows = parseCSV(String(reader.result));
        if (!rows.length) throw new Error('The CSV file is empty.');
        const headers = Object.keys(rows[0]);
        let type = '';
        if (['code','name','department','maxWeeklyHours'].every(h=>headers.includes(h))) type = 'teachers';
        else if (['code','name','classification','units'].every(h=>headers.includes(h))) type = 'subjects';
        else if (['code','programCode','yearLevel','semester','studentCount'].every(h=>headers.includes(h))) type = 'sections';
        else if (['code','name','type','status'].every(h=>headers.includes(h))) type = 'rooms';
        else if (['studentNo','name','sectionCode'].every(h=>headers.includes(h))) type = 'students';
        else throw new Error('Unsupported CSV format. Use an exported Teachers, Subjects, Sections, Rooms, or Students template.');
        if (!window.confirm(`Import ${rows.length} ${type} row(s)? Existing records with matching codes or numbers will be updated.`)) return;
        let created = 0, updated = 0;
        for (const row of rows) {
          if (type === 'teachers') {
            const record = state.teachers.find(t=>normalizeCode(t.code)===normalizeCode(row.code));
            const data = { id:record?.id||uid('tea'), code:normalizeCode(row.code), name:row.name, department:row.department||'', qualifiedSubjectIds:(row.qualifiedSubjectCodes||'').split('|').map(code=>state.subjects.find(s=>s.code===normalizeCode(code))?.id).filter(Boolean), maxWeeklyHours:Number(row.maxWeeklyHours)||30, maxDailyHours:Number(row.maxDailyHours)||8, availableDays:(row.availableDays||DAYS.join('|')).split('|').filter(d=>DAYS.includes(d)), availableStart:row.availableStart?parseTime(row.availableStart):START_OF_DAY, availableEnd:row.availableEnd?parseTime(row.availableEnd):END_OF_DAY, preferredStart:row.preferredStart?parseTime(row.preferredStart):480, preferredEnd:row.preferredEnd?parseTime(row.preferredEnd):1080, active:String(row.active).toLowerCase()!=='false' };
            record ? Object.assign(record,data) : state.teachers.push(data);
          } else if (type === 'subjects') {
            const record = state.subjects.find(s=>normalizeCode(s.code)===normalizeCode(row.code));
            const data = { id:record?.id||uid('sub'), code:normalizeCode(row.code), name:row.name, classification:row.classification||'minor', units:Number(row.units)||2, lectureHours:Number(row.lectureHours)||2, labHours:Number(row.labHours)||3, weeklyHours:Number(row.weeklyHours)||Number(row.units)||2, roomType:row.roomType||'lecture', active:String(row.active).toLowerCase()!=='false' };
            record ? Object.assign(record,data) : state.subjects.push(data);
          } else if (type === 'sections') {
            const program = state.programs.find(p=>normalizeCode(p.code)===normalizeCode(row.programCode));
            if (!program) continue;
            const record = state.sections.find(s=>normalizeCode(s.code)===normalizeCode(row.code));
            const studentCount = Number(row.studentCount)||1;
            const labBatchSizes = (row.labBatchSizes||'').split('|').filter(Boolean).map(Number);
            if (labBatchSizes.length && (labBatchSizes.some(size=>!Number.isInteger(size)||size<1||size>getLargestLabCapacity()) || labBatchSizes.reduce((sum,size)=>sum+size,0)!==studentCount)) throw new Error(`Invalid lab batch sizes in section ${row.code}. Check that sizes are positive, fit a lab, and add up to ${studentCount}.`);
            const customSubjects = (row.customSubjectCodes||'').split('|').filter(Boolean).map(code=>state.subjects.find(s=>s.code===normalizeCode(code))?.id).filter(Boolean);
            const data = { id:record?.id||uid('sec'), code:normalizeCode(row.code), academicYear:row.academicYear||state.settings.academicYear, programId:program.id, yearLevel:Number(row.yearLevel)||1, semester:row.semester||'First Semester', studentCount, customSubjectIds:customSubjects.length?customSubjects:null, labBatchSizes:labBatchSizes.length?labBatchSizes:null, active:String(row.active).toLowerCase()!=='false' };
            record ? Object.assign(record,data) : state.sections.push(data);
          } else if (type === 'rooms') {
            const record = state.rooms.find(r=>normalizeCode(r.code)===normalizeCode(row.code));
            const data = { id:record?.id||uid('room'), code:normalizeCode(row.code), name:row.name, type:row.type||'lecture', capacity:row.capacity?Number(row.capacity):null, availableDays:(row.availableDays||DAYS.join('|')).split('|').filter(d=>DAYS.includes(d)), status:row.status||'Available' };
            if(data.type==='lab'&&!data.capacity) continue;
            record ? Object.assign(record,data) : state.rooms.push(data);
          } else if (type === 'students') {
            const section = state.sections.find(s=>normalizeCode(s.code)===normalizeCode(row.sectionCode));
            if (!section) continue;
            const record = state.students.find(s=>normalizeCode(s.studentNo)===normalizeCode(row.studentNo));
            const data = { id:record?.id||uid('stu'), studentNo:normalizeCode(row.studentNo), name:row.name, sectionId:section.id, additionalSectionIds:(row.additionalSectionCodes||'').split('|').map(code=>state.sections.find(s=>normalizeCode(s.code)===normalizeCode(code))?.id).filter(id=>id&&id!==section.id), enrolledSubjectIds:(row.enrolledSubjectCodes||'').split('|').map(code=>state.subjects.find(s=>s.code===normalizeCode(code))?.id).filter(Boolean), batchIndex:row.batchIndex===''||row.batchIndex==null?null:Number(row.batchIndex), active:String(row.active).toLowerCase()!=='false' };
            record ? Object.assign(record,data) : state.students.push(data);
          }
          if (rows.indexOf(row) >= 0) { /* counted below using final record totals */ }
          // The totals are estimated from the matched record's initial presence on each branch.
          if (row) created++;
        }
        saveState(`Imported CSV records into ${type}.`);
        showToast(`CSV import processed ${rows.length} row(s). Review the updated records.`, 'success');
        renderApp();
      } catch (error) { showToast(error.message || 'Could not import the CSV file.','error'); }
      finally { event.target.value = ''; }
    };
    reader.readAsText(file);
  }

  function handleConsultationAction(action, id) {
    if (action === 'add-consultation') openConsultationForm();
    if (action === 'delete-consultation') {
      const item = state.consultationPeriods.find(c=>c.id===id);
      if (!item) return;
      if (!window.confirm('Remove this reserved consultation period?')) return;
      state.consultationPeriods = state.consultationPeriods.filter(c=>c.id!==id);
      saveState(`Removed a consultation period for ${teacherName(item.teacherId)}.`);
      showToast('Consultation period removed.');
      renderApp();
    }
  }

  // Expose the core render functions for compatibility with any page-level
  // callbacks and to make the active build easy to verify during deployment.
  // Internal application code continues to use the lexical function references.
  window.renderApp = renderApp;
  window.roleLabel = roleLabel;
  window.CLASS_SCHEDULER_BUILD = '4.1.2';

  // Start the application after all page and interaction functions are defined.
  // Catch startup failures so they are visible in the console instead of leaving
  // the workspace blank without a useful diagnostic.
  init().catch(error => {
    console.error('Class Scheduler initialization failed:', error);
    showToast(error?.message || 'The portal could not finish loading. Please refresh the page.', 'error');
  });
})();
