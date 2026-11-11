'use strict';
const $ = id => document.getElementById(id);
let csrf = '';
const money = points => (Number(points || 0) / 100).toFixed(2);
async function request(url, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.method && options.method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}), ...(options.headers || {}) };
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
function msg(text, error = false) { $('app-message').textContent = text; $('app-message').classList.toggle('error', error); }
function authError(text) { $('auth-error').textContent = text; }
async function boot() {
  csrf = (await request('/api/csrf')).token;
  const params = new URLSearchParams(location.search);
  if (params.get('ref')) $('ref-code').value = params.get('ref').slice(0, 20);
  const config = await request('/api/config');
  $('payout-method').replaceChildren(...config.payoutMethods.map(method => { const o = document.createElement('option'); o.value = method; o.textContent = method; return o; }));
  try { await loadDashboard(); } catch { showAuth(); }
}
function showAuth() { $('auth-view').hidden = false; $('app-view').hidden = true; $('logout').hidden = true; $('header-user').textContent = ''; }
async function loadDashboard() {
  const [{ user }, { tasks }, { items }] = await Promise.all([request('/api/me'), request('/api/tasks'), request('/api/history')]);
  $('auth-view').hidden = true; $('app-view').hidden = false; $('logout').hidden = false;
  $('username').textContent = user.username; $('header-user').textContent = user.username;
  $('balance').textContent = money(user.balance); $('points-balance').textContent = `${user.balance} points`;
  $('lifetime').textContent = money(user.lifetime); $('lifetime-points').textContent = `${user.lifetime} points total`;
  $('referrals').textContent = user.referrals; $('refcode').textContent = user.refCode;
  $('daily').disabled = Date.now() < user.nextDailyAt;
  $('daily').textContent = $('daily').disabled ? 'Daily bonus claimed' : 'Claim daily +10';
  const taskBox = $('tasks'); taskBox.replaceChildren();
  if (!tasks.length) taskBox.append(makeEmpty('New offers are being added soon.'));
  for (const task of tasks) {
    const row = document.createElement('article'); row.className = 'task';
    const text = document.createElement('div'), title = document.createElement('h3'), desc = document.createElement('p'), pts = document.createElement('span');
    title.textContent = task.title; desc.textContent = task.description; text.append(title, desc);
    pts.className = 'points'; pts.textContent = `+${task.points} pts`;
    if (task.url) { const a = document.createElement('a'); a.className = 'button'; a.href = task.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = 'Open offer'; row.append(text, pts, a); }
    else row.append(text, pts);
    taskBox.append(row);
  }
  const history = $('history'); history.replaceChildren();
  if (!items.length) history.append(makeEmpty('Your activity will appear here.'));
  for (const item of items.slice(0, 20)) {
    const row = document.createElement('div'); row.className = 'history-item';
    const desc = document.createElement('span'), points = document.createElement('strong');
    desc.textContent = `${item.note || item.type} · ${new Date(item.createdAt).toLocaleDateString()}`;
    points.textContent = `${item.points > 0 ? '+' : ''}${item.points}`; points.className = item.points >= 0 ? 'positive' : 'negative';
    row.append(desc, points); history.append(row);
  }
}
function makeEmpty(text) { const p = document.createElement('p'); p.className = 'muted fine'; p.textContent = text; return p; }
$('show-login').addEventListener('click', () => { $('login-form').hidden = false; $('signup-form').hidden = true; $('show-login').classList.add('active'); $('show-signup').classList.remove('active'); authError(''); });
$('show-signup').addEventListener('click', () => { $('login-form').hidden = true; $('signup-form').hidden = false; $('show-signup').classList.add('active'); $('show-login').classList.remove('active'); authError(''); });
for (const [formId, endpoint] of [['login-form', '/api/login'], ['signup-form', '/api/signup']]) $(formId).addEventListener('submit', async e => {
  e.preventDefault(); authError(''); const b = Object.fromEntries(new FormData(e.currentTarget));
  try { await request(endpoint, { method: 'POST', body: JSON.stringify(b) }); await loadDashboard(); } catch (err) { authError(err.message); }
});
$('daily').addEventListener('click', async () => { try { await request('/api/daily', { method: 'POST', body: '{}' }); msg('Daily bonus added to your balance!'); await loadDashboard(); } catch (e) { msg(e.message, true); } });
$('withdraw-form').addEventListener('submit', async e => { e.preventDefault(); try { await request('/api/withdraw', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.currentTarget))) }); e.currentTarget.reset(); msg('Payout request submitted.'); await loadDashboard(); } catch (err) { msg(err.message, true); } });
$('copy-ref').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('refcode').textContent); msg('Referral code copied.'); } catch { msg('Select and copy your referral code.'); } });
$('logout').addEventListener('click', async () => { try { await request('/api/logout', { method: 'POST', body: '{}' }); showAuth(); } catch (e) { msg(e.message, true); } });
boot().catch(e => { authError(e.message); });
