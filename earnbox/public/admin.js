'use strict';
const $ = id => document.getElementById(id);
let csrf = '';
async function request(url, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.method && options.method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}), ...(options.headers || {}) };
  const r = await fetch(url, { credentials: 'same-origin', ...options, headers });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
function cell(row, value) { const td = document.createElement('td'); td.textContent = value == null ? '' : String(value); row.append(td); return td; }
function button(text, fn, cls = '') { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; if (cls) b.className = cls; b.addEventListener('click', fn); return b; }
function err(text) { $('admin-error').textContent = text; }
async function checkAdmin() { try { await request('/api/admin/overview'); $('admin-login').hidden = true; $('admin-view').hidden = false; $('admin-logout').hidden = false; await refresh(); } catch { $('admin-login').hidden = false; $('admin-view').hidden = true; $('admin-logout').hidden = true; } }
async function refresh() { await Promise.all([overview(), users(), withdrawals(), tasks()]); }
async function overview() {
 const d = await request('/api/admin/overview'), box = $('overview'); box.replaceChildren();
 for (const [label, value] of [['Users',d.users],['Points owed',d.points_owed],['Pending payouts',d.pending_count],['Pending value',`R${Number(d.pending_amount).toFixed(2)}`],['Paid value',`R${Number(d.paid_amount).toFixed(2)}`]]) { const c = document.createElement('article'); c.className = 'card stat'; const s = document.createElement('span'); s.textContent = label; const v = document.createElement('strong'); v.textContent = value; c.append(s,v); box.append(c); }
}
async function users() {
 const { items } = await request('/api/admin/users'), table = document.createElement('table'), head = document.createElement('tr');
 for (const t of ['ID','Username','Balance','Lifetime','Created','Action']) { const th = document.createElement('th'); th.textContent=t; head.append(th); }
 const thead = document.createElement('thead'); thead.append(head); table.append(thead); const body = document.createElement('tbody');
 for (const u of items) { const tr=document.createElement('tr'); cell(tr,u.id); cell(tr,u.username); cell(tr,u.balance); cell(tr,u.lifetime); cell(tr,new Date(u.createdAt).toLocaleDateString()); const td=document.createElement('td'); td.append(button(u.banned?'Unban':'Ban',async()=>{await request(`/api/admin/users/${u.id}/ban`,{method:'POST',body:'{}'});await refresh();})); tr.append(td); body.append(tr); }
 table.append(body); $('users').replaceChildren(table);
}
async function withdrawals() {
 const { items } = await request('/api/admin/withdrawals'), table=document.createElement('table'), head=document.createElement('tr');
 for(const t of ['ID','User','Points','Amount','Method / payout details','Status','Actions']){const th=document.createElement('th');th.textContent=t;head.append(th)} const thead=document.createElement('thead');thead.append(head);table.append(thead);const body=document.createElement('tbody');
 for(const w of items){const tr=document.createElement('tr');cell(tr,w.id);cell(tr,`${w.username} (#${w.userId})`);cell(tr,w.points);cell(tr,`R${Number(w.amount).toFixed(2)}`);const detail=cell(tr,`${w.method}: ${w.account}`);detail.className='withdraw-detail';const st=cell(tr,w.status);st.innerHTML='';const badge=document.createElement('span');badge.className=`status ${w.status}`;badge.textContent=w.status;st.append(badge);const actions=document.createElement('td');if(w.status==='pending'){actions.append(button('Mark paid',async()=>{await request(`/api/admin/withdrawals/${w.id}/paid`,{method:'POST',body:'{}'});await refresh();}),button('Reject + refund',async()=>{if(confirm('Reject this payout and refund points?')){await request(`/api/admin/withdrawals/${w.id}/rejected`,{method:'POST',body:'{}'});await refresh();}},'danger'));}tr.append(actions);body.append(tr)}table.append(body);$('withdrawals').replaceChildren(table);
}
async function tasks(){const {items}=await request('/api/admin/tasks'),box=$('tasks');box.replaceChildren();for(const t of items){const row=document.createElement('div');row.className='admin-task';const title=document.createElement('strong');title.textContent=`${t.title} · ${t.points} pts · ${t.active?'Active':'Paused'}`;const desc=document.createElement('span');desc.textContent=t.description;row.append(title,desc,button(t.active?'Pause':'Activate',async()=>{await request(`/api/admin/tasks/${t.id}/toggle`,{method:'POST',body:'{}'});await tasks()}),button('Delete',async()=>{if(confirm('Delete this task?')){await request(`/api/admin/tasks/${t.id}`,{method:'DELETE'});await tasks()}},'danger'));box.append(row)}}
$('admin-login-form').addEventListener('submit',async e=>{e.preventDefault();err('');try{await request('/api/admin/login',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.currentTarget)))});await checkAdmin()}catch(x){err(x.message)}});
$('admin-logout').addEventListener('click',async()=>{await request('/api/logout',{method:'POST',body:'{}'});location.reload()});
$('credit-form').addEventListener('submit',async e=>{e.preventDefault();try{await request('/api/admin/credit',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.currentTarget)))});e.currentTarget.reset();await refresh()}catch(x){alert(x.message)}});
$('task-form').addEventListener('submit',async e=>{e.preventDefault();try{await request('/api/admin/tasks',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.currentTarget)))});e.currentTarget.reset();await tasks()}catch(x){alert(x.message)}});
(async()=>{csrf=(await request('/api/csrf')).token;await checkAdmin()})().catch(e=>err(e.message));
