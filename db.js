const { getStore } = require('@netlify/blobs');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'adMiNa    ';
const PACKAGES = { free: 3, medium: 10, vip: 15, pro: 25, advanced: 35 };
const PACKAGE_NAMES = { free: 'تجربة', medium: 'أساسي', vip: 'VIP', pro: 'احترافي', advanced: 'العلوم المتطورة' };

// ---------- KV wrapper around Netlify Blobs (compatible API: get/set/del/keys) ----------
function getKV() {
  const store = getStore({ name: 'safe-db', consistency: 'strong' });
  return {
    async get(key) {
      const val = await store.get(key);
      if (val === null || val === undefined) return null;
      try { return JSON.parse(val); } catch { return val; }
    },
    async set(key, value) {
      const data = typeof value === 'string' ? value : JSON.stringify(value);
      await store.set(key, data);
    },
    async del(key) {
      await store.delete(key);
    },
    async keys(pattern) {
      // pattern looks like 'user:*' or 'code:*' — use prefix listing
      const prefix = pattern.replace(/\*$/, '');
      const out = [];
      let cursor;
      do {
        const page = await store.list({ prefix, cursor });
        for (const b of (page.blobs || [])) out.push(b.key);
        cursor = page.cursor;
      } while (cursor);
      return out;
    }
  };
}

// ---------- Handler ----------
exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return resp(405, { error: 'Method not allowed' });
  }

  const qs = event.queryStringParameters || {};
  // endpoint comes from netlify.toml redirect: /api/db/*  ->  /.netlify/functions/db?endpoint=*
  const endpoint = (qs.endpoint || '').replace(/^\/+|\/+$/g, '').split('/')[0] || '';
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

  try {
    const kv = getKV();
    const result = await handleDB(endpoint, body, kv);
    return resp(200, result);
  } catch (e) {
    return resp(500, { success: false, error: e.message });
  }
};

function resp(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body)
  };
}

// ---------- Business logic (unchanged from original) ----------
async function handleDB(endpoint, body, kv) {

  if (endpoint === 'register') {
    const email = (body.email || '').toLowerCase().trim();
    if (!email || !body.password || !body.name) return { success: false, message: 'بيانات ناقصة' };
    const existing = await kv.get('user:' + email);
    if (existing) return { success: false, message: 'البريد مسجل مسبقاً' };
    const user = {
      id: 'u_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      name: body.name, email, password: body.password,
      package: 'free', sessions: 3, createdAt: Date.now(),
      totalSessionsUsed: 0, sectionUsage: {}, qualifiedSections: [],
      avatarEmoji: null, avatarUrl: null, courses: [], banned: false,
      packageSuspended: false, subscriptionEnd: null, hideDays: false
    };
    await kv.set('user:' + email, user);
    return { success: true, user };
  }

  if (endpoint === 'login') {
    const email = (body.email || '').toLowerCase().trim();
    if (!email || !body.password) return { success: false, message: 'أدخل البيانات' };
    const user = await kv.get('user:' + email);
    if (!user) return { success: false, message: 'بيانات خاطئة' };
    if (user.password !== body.password) return { success: false, message: 'بيانات خاطئة' };
    if (user.banned) return { success: false, message: 'الحساب محظور' };
    if (user.subscriptionEnd && user.subscriptionEnd < Date.now() && user.package !== 'free') {
      user.package = 'free'; user.sessions = 0; user.subscriptionEnd = null;
      await kv.set('user:' + email, user);
    }
    if (user.packageSuspended && user.package !== 'free') user._effectivePackage = 'free';
    return { success: true, user };
  }

  if (endpoint === 'update-user') {
    if (!body.email) return { success: false };
    await kv.set('user:' + body.email.toLowerCase().trim(), body);
    return { success: true };
  }

  if (endpoint === 'decrement-session') {
    const email = (body.email || '').toLowerCase().trim();
    if (!email) return { success: false, message: 'بريد مطلوب' };
    const user = await kv.get('user:' + email);
    if (!user) return { success: false, message: 'مستخدم غير موجود' };
    if (user.banned) return { success: false, message: 'الحساب محظور' };
    if (user.sessions <= 0) return { success: false, message: 'لا توجد جلسات' };
    user.sessions--;
    user.totalSessionsUsed = (user.totalSessionsUsed || 0) + 1;
    await kv.set('user:' + email, user);
    return { success: true, sessions: user.sessions };
  }

  if (endpoint === 'get-users') {
    if (body.adminPassword !== ADMIN_PASSWORD) return { success: false, message: 'غير مصرح' };
    const keys = await kv.keys('user:*');
    const users = [];
    for (const key of keys) { const u = await kv.get(key); if (u) users.push(u); }
    return { users };
  }

  if (endpoint === 'toggle-ban') {
    const email = (body.email || '').toLowerCase();
    const user = await kv.get('user:' + email);
    if (!user) return { success: false };
    user.banned = !user.banned;
    await kv.set('user:' + email, user);
    return { success: true };
  }

  if (endpoint === 'adjust-sessions') {
    const email = (body.email || '').toLowerCase();
    const user = await kv.get('user:' + email);
    if (!user) return { success: false };
    user.sessions = Math.max(0, (user.sessions || 0) + (body.delta || 0));
    await kv.set('user:' + email, user);
    return { success: true };
  }

  if (endpoint === 'adjust-days') {
    const email = (body.email || '').toLowerCase();
    const user = await kv.get('user:' + email);
    if (!user) return { success: false };
    const base = user.subscriptionEnd && user.subscriptionEnd > Date.now() ? user.subscriptionEnd : Date.now();
    user.subscriptionEnd = Math.max(Date.now(), base + (body.delta || 0) * 86400000);
    await kv.set('user:' + email, user);
    return { success: true };
  }

  if (endpoint === 'set-days-visibility') {
    const email = (body.email || '').toLowerCase();
    const user = await kv.get('user:' + email);
    if (!user) return { success: false };
    user.hideDays = !!body.hide;
    await kv.set('user:' + email, user);
    return { success: true };
  }

  if (endpoint === 'toggle-package') {
    const email = (body.email || '').toLowerCase();
    const user = await kv.get('user:' + email);
    if (!user) return { success: false };
    user.packageSuspended = !user.packageSuspended;
    await kv.set('user:' + email, user);
    return { success: true };
  }

  if (endpoint === 'set-package') {
    const email = (body.email || '').toLowerCase();
    const user = await kv.get('user:' + email);
    if (!user) return { success: false };
    user.package = body.package;
    user.sessions = (user.sessions || 0) + (PACKAGES[body.package] || 0);
    if (body.days) {
      const base = user.subscriptionEnd && user.subscriptionEnd > Date.now() ? user.subscriptionEnd : Date.now();
      user.subscriptionEnd = base + body.days * 86400000;
    }
    await kv.set('user:' + email, user);
    return { success: true, user };
  }

  if (endpoint === 'delete-user') {
    await kv.del('user:' + (body.email || '').toLowerCase());
    return { success: true };
  }

  if (endpoint === 'get-codes') {
    const keys = await kv.keys('code:*');
    const codes = [];
    for (const key of keys) { const c = await kv.get(key); if (c) codes.push(c); }
    return { codes };
  }

  if (endpoint === 'gen-codes') {
    const count = Math.min(body.count || 1, 50);
    const prefix = body.isCourse ? 'CRS' : 'SAFE';
    const generated = [];
    for (let i = 0; i < count; i++) {
      const code = prefix + '-' + Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      const codeData = { code, package: body.package || 'medium', days: body.days || 30, used: false, usedBy: null, createdAt: Date.now(), isCourse: !!body.isCourse, courseId: body.courseId || null };
      await kv.set('code:' + code, codeData);
      generated.push(codeData);
    }
    return { success: true, codes: generated };
  }

  if (endpoint === 'activate-code') {
    const code = (body.code || '').toUpperCase().trim();
    const codeData = await kv.get('code:' + code);
    if (!codeData) return { success: false, message: 'كود غير صالح' };
    if (codeData.used) return { success: false, message: 'الكود مستخدم مسبقاً' };
    const allKeys = await kv.keys('user:*');
    let user = null;
    for (const key of allKeys) { const u = await kv.get(key); if (u && u.id === body.userId) { user = u; break; } }
    if (!user) return { success: false, message: 'مستخدم غير موجود' };
    if (codeData.isCourse && codeData.courseId) {
      if (!user.courses) user.courses = [];
      if (!user.courses.includes(codeData.courseId)) user.courses.push(codeData.courseId);
    } else {
      user.package = codeData.package;
      user.sessions = (user.sessions || 0) + (PACKAGES[codeData.package] || 0);
      if (codeData.days) {
        const base = user.subscriptionEnd && user.subscriptionEnd > Date.now() ? user.subscriptionEnd : Date.now();
        user.subscriptionEnd = base + codeData.days * 86400000;
      }
    }
    codeData.used = true; codeData.usedBy = user.email; codeData.usedAt = Date.now();
    await kv.set('code:' + code, codeData);
    await kv.set('user:' + user.email, user);
    return { success: true, user, packageName: PACKAGE_NAMES[codeData.package] || codeData.package };
  }

  if (endpoint === 'delete-codes') {
    let deleted = 0;
    if (body.deleteUsed) {
      const keys = await kv.keys('code:*');
      for (const key of keys) { const c = await kv.get(key); if (c && c.used) { await kv.del(key); deleted++; } }
    } else if (body.codes && body.codes.length) {
      for (const code of body.codes) { await kv.del('code:' + code.toUpperCase()); deleted++; }
    }
    return { success: true, deleted };
  }

  if (endpoint === 'get-courses') { return { courses: (await kv.get('courses')) || [] }; }
  if (endpoint === 'add-course') {
    const courses = (await kv.get('courses')) || [];
    courses.push({ id: 'c_' + Date.now(), name: body.name, icon: body.icon, desc: body.desc || '', egp: body.egp || 0, usd: Math.round((body.egp || 0) / 50), requiredPackage: body.requiredPackage || '', createdAt: Date.now() });
    await kv.set('courses', courses);
    return { success: true };
  }
  if (endpoint === 'delete-course') {
    const courses = ((await kv.get('courses')) || []).filter(function (c) { return c.id !== body.id; });
    await kv.set('courses', courses);
    return { success: true };
  }

  if (endpoint === 'get-sections') { return { sections: (await kv.get('app_sections')) || null }; }
  if (endpoint === 'save-sections') {
    if (!body.sections || !Array.isArray(body.sections)) return { success: false, message: 'أقسام غير صالحة' };
    await kv.set('app_sections', body.sections);
    return { success: true };
  }

  if (endpoint === 'get-lessons') {
    return { lessons: (await kv.get('lessons')) || [], categories: (await kv.get('lesson_categories')) || ['عام'] };
  }
  if (endpoint === 'get-lesson') {
    return { lesson: ((await kv.get('lessons')) || []).find(function (l) { return l.id === body.id; }) };
  }
  if (endpoint === 'add-lesson') {
    const lessons = (await kv.get('lessons')) || [];
    let cats = (await kv.get('lesson_categories')) || ['عام'];
    if (body.category && !cats.includes(body.category)) { cats.push(body.category); await kv.set('lesson_categories', cats); }
    lessons.push({ id: 'l_' + Date.now(), title: body.title, category: body.category || 'عام', description: body.description || '', content: body.content, forPackages: body.forPackages || ['free', 'medium', 'vip', 'pro', 'advanced'], releaseAt: body.releaseAt || null, hidden: false, createdAt: Date.now() });
    await kv.set('lessons', lessons);
    return { success: true };
  }
  if (endpoint === 'edit-lesson') {
    const lessons = (await kv.get('lessons')) || [];
    const idx = lessons.findIndex(function (l) { return l.id === body.id; });
    if (idx < 0) return { success: false, message: 'درس غير موجود' };
    let cats = (await kv.get('lesson_categories')) || ['عام'];
    if (body.category && !cats.includes(body.category)) { cats.push(body.category); await kv.set('lesson_categories', cats); }
    Object.assign(lessons[idx], { title: body.title, category: body.category, description: body.description || '', content: body.content, forPackages: body.forPackages || lessons[idx].forPackages });
    await kv.set('lessons', lessons);
    return { success: true };
  }
  if (endpoint === 'toggle-lesson') {
    const lessons = (await kv.get('lessons')) || [];
    const lesson = lessons.find(function (l) { return l.id === body.id; });
    if (!lesson) return { success: false };
    lesson.hidden = !lesson.hidden;
    await kv.set('lessons', lessons);
    return { success: true };
  }
  if (endpoint === 'delete-lesson') {
    await kv.set('lessons', ((await kv.get('lessons')) || []).filter(function (l) { return l.id !== body.id; }));
    return { success: true };
  }

  return { success: false, message: 'endpoint غير معروف: ' + endpoint };
}
