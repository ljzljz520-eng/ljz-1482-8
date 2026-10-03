'use strict';
/* 消防演练排练工具 —— 主持/现场/编排前端（在线模式） */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const h = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTs = (ts) => ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—';
const fmtClock = (sec) => { sec = Math.max(0, sec | 0); const m = (sec / 60) | 0, s2 = sec % 60; return `${m}分${String(s2).padStart(2, '0')}秒`; };
const cid = () => 'ce_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function toast(msg, kind = 'info', ms = 3600) {
  const box = $('#toast'); const t = document.createElement('div');
  t.className = 't ' + kind; t.textContent = msg; box.appendChild(t);
  setTimeout(() => t.remove(), ms);
}
async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  let data = null;
  try { data = await r.json(); } catch (e) {}
  if (!r.ok) { const msg = (data && data.error) || ('请求失败 ' + r.status); const err = new Error(msg); err.status = r.status; err.data = data; throw err; }
  return data;
}

/* ---------------- 全局状态 ---------------- */
const state = {
  tab: 'scripts',
  scripts: [],
  curScriptId: localStorage.getItem('fd.scriptId') || null,
  draft: null,
  editorScriptId: null,
  editorVersionId: null,
  reviewVersionId: null,
  diffFrom: null, diffTo: null, diff: null,
  curRunId: localStorage.getItem('fd.runId') || null,
  st: null,
  stTs: 0,
  fieldScriptId: localStorage.getItem('fd.fieldScriptId') || null,
  identity: JSON.parse(localStorage.getItem('fd.identity') || '{"userId":"u_demo","userName":"","roleKey":"host"}')
};
function saveIdentity() { localStorage.setItem('fd.identity', JSON.stringify(state.identity)); }

/* 轮询重绘时保护正在编辑的表单值：以 data-fid 为键 */
function snapshotForms() {
  const m = new Map();
  $$('#view input, #view textarea, #view select').forEach((el) => {
    if (!el.dataset.fid) el.dataset.fid = 'f' + Math.random().toString(36).slice(2, 9);
    m.set(el.dataset.fid, el.value);
  });
  return m;
}
function restoreForms(m) {
  $$('#view input, #view textarea, #view select').forEach((el) => {
    if (el.dataset.fid && m.has(el.dataset.fid)) el.value = m.get(el.dataset.fid);
  });
}
function rerender(snap = true) {
  const m = snap ? snapshotForms() : null;
  render();
  if (m) restoreForms(m);
}

/* ---------------- 视图入口 ---------------- */
async function init() {
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]'); if (!b) return;
    state.tab = b.dataset.tab; render();
  });
  window.addEventListener('online', () => { toast('网络已恢复，正在同步离线确认…', 'ok'); flushOfflineQueue(); rerender(false); });
  window.addEventListener('offline', () => { toast('已断网：现场页进入暂定阶段显示', 'warn', 5000); rerender(false); });
  await refreshScripts();
  if (!state.curScriptId && state.scripts[0]) state.curScriptId = state.scripts[0].id;
  render();
  if (state.curRunId) loadRun(true).catch(() => {});
  setInterval(async () => {
    if (['host', 'field', 'ledger'].includes(state.tab)) {
      if (state.tab !== 'field' || navigator.onLine) { try { await loadRun(); } catch (e) {} }
      rerender(true);
    }
  }, 3000);
  setInterval(() => { if (navigator.onLine) flushOfflineQueue(); }, 4000);
}
async function refreshScripts() { state.scripts = await api('GET', '/api/scripts'); }

function render() {
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  renderIdentity();
  const v = $('#view');
  if (state.tab === 'scripts') renderScripts(v);
  else if (state.tab === 'review') renderReview(v);
  else if (state.tab === 'host') renderHost(v);
  else if (state.tab === 'field') renderField(v);
  else if (state.tab === 'ledger') renderLedger(v);
  else renderHelp(v);
}
function renderIdentity() {
  const r = state.identity;
  $('#identity').innerHTML =
    `身份：<input type="text" id="idName" placeholder="姓名" value="${h(r.userName)}" style="width:90px">
     <select id="idRole">
       <option value="commander">现场总指挥</option><option value="host">主持人/导调</option>
       <option value="alarm">报警联络组</option><option value="floor2">二层引导员</option>
       <option value="floor3">三层引导员</option><option value="muster">集合清点组</option>
       <option value="observer">观摩记录员</option>
     </select>
     <button class="btn" id="idSave">保存身份</button>`;
  $('#idRole').value = r.roleKey;
  $('#idSave').onclick = () => {
    state.identity.userName = $('#idName').value.trim();
    state.identity.roleKey = $('#idRole').value;
    saveIdentity(); toast('身份已保存：你的确认/放行将以此身份留痕', 'ok'); rerender(false);
  };
}

/* ================= 脚本编排 ================= */
function renderScripts(v) {
  const s = state.scripts.find((x) => x.id === state.editorScriptId) || state.scripts.find((x) => x.id === state.curScriptId);
  if (!s) {
    v.innerHTML = `<div class="card"><h2>脚本</h2><p class="muted">还没有脚本。</p><button class="btn pri" id="newScriptA">新建空白脚本（四阶段模板）</button></div>`;
    $('#newScriptA').onclick = createScript;
    return;
  }
  state.editorScriptId = s.id; state.curScriptId = s.id; localStorage.setItem('fd.scriptId', s.id);
  const draft = s.versions.find((x) => x.id === state.editorVersionId) || s.versions.find((x) => x.status === 'draft');
  state.editorVersionId = draft ? draft.id : null;

  v.innerHTML = `
  <div class="card">
    <div class="row" style="justify-content:space-between">
      <h2 style="margin:0">脚本编排</h2>
      <div class="row">
        <select id="scriptSel">${state.scripts.map((x) => `<option value="${x.id}" ${x.id === s.id ? 'selected' : ''}>${h(x.name)}</option>`).join('')}</select>
        <button class="btn" id="newScriptB">＋新建脚本</button>
      </div>
    </div>
  </div>
  <div class="card">
    <h2>版本（角色/阶段条件/资源依赖的变更都以版本管理）</h2>
    <table><thead><tr><th>版本</th><th>状态</th><th>说明</th><th>审核</th><th style="width:230px">操作</th></tr></thead><tbody>
    ${s.versions.map((ver) => `<tr ${ver.id === state.editorVersionId ? 'style="background:var(--soft)"' : ''}>
      <td class="mono">v${ver.version}</td>
      <td><span class="badge ${ver.status}">${{ draft: '草案', in_review: '待审核', approved: '已批准' }[ver.status]}</span></td>
      <td>${h(ver.note)}</td>
      <td class="small muted">${ver.approvedAt ? h(ver.approver) + '<br>' + fmtTs(ver.approvedAt) : '—'}</td>
      <td>
        ${ver.status === 'draft' ? `<button class="btn pri" data-edit="${ver.id}">编辑草案</button> <button class="btn danger" data-delver="${ver.id}">删除草案</button>` : `<button class="btn ghost" data-view="${ver.id}">查看（只读）</button>`}
      </td></tr>`).join('')}
    </tbody></table>
    <div class="row" style="margin-top:10px">
      <button class="btn" id="reviseBtn">基于已批准版本修订出新版本…</button>
      <span class="muted small">撤销编排只能删除尚未生效的草案；任何已执行记录不受影响。</span>
    </div>
  </div>
  <div id="editorArea"></div>`;
  $('#scriptSel').onchange = (e) => { state.editorScriptId = e.target.value; state.editorVersionId = null; state.draft = null; rerender(false); };
  $('#newScriptB').onclick = createScript;
  $('#reviseBtn').onclick = async () => {
    try {
      const r = await api('POST', `/api/scripts/${s.id}/revise`, { note: '页面发起修订' });
      await refreshScripts(); state.editorVersionId = r.id; state.draft = null;
      toast('已创建 v' + r.version + ' 草案，可在其中改变责任人/依赖', 'ok'); rerender(false);
    } catch (e) { toast(e.message, 'err'); }
  };
  $$('[data-edit]', v).forEach((b) => b.onclick = async () => {
    state.editorVersionId = b.dataset.edit;
    state.draft = await api('GET', `/api/scripts/${s.id}/versions/${state.editorVersionId}`);
    rerender(false);
  });
  $$('[data-view]', v).forEach((b) => b.onclick = async () => {
    state.editorVersionId = b.dataset.view;
    state.draft = await api('GET', `/api/scripts/${s.id}/versions/${state.editorVersionId}`);
    rerender(false);
  });
  $$('[data-delver]', v).forEach((b) => b.onclick = async () => {
    if (!confirm('删除该草案？已批准版本与全部执行记录永远保留。')) return;
    try { await api('DELETE', `/api/scripts/${s.id}/versions/${b.dataset.delver}`); state.editorVersionId = null; state.draft = null; await refreshScripts(); toast('草案已删除，执行记录未受影响', 'ok'); rerender(false); }
    catch (e) { toast(e.message, 'err'); }
  });
  renderEditor(v, s);
}
async function createScript() {
  const name = prompt('脚本名称', '新消防演练脚本'); if (name === null) return;
  const r = await api('POST', '/api/scripts', { name });
  await refreshScripts(); state.editorScriptId = r.id; state.editorVersionId = null; state.draft = null; rerender(false);
}

function roleOptions(selected) {
  const roles = (state.draft && state.draft.snapshot.roles) || [];
  return roles.map((r) => `<option value="${h(r.key)}" ${r.key === selected ? 'selected' : ''}>${h(r.name)}(${h(r.key)})</option>`).join('');
}
function resName(id, roles) { const r = (state.draft.snapshot.resources || []).find((x) => x.id === id); return r ? r.name : id; }

function renderEditor(v, s) {
  const area = $('#editorArea');
  if (!state.draft || state.draft.id !== state.editorVersionId) { area.innerHTML = ''; return; }
  const d = state.draft; const c = d.snapshot;
  const editable = d.status === 'draft';
  const ctrl = (ed) => ed ? '' : 'disabled';
  area.innerHTML = `
  <div class="card">
    <div class="row" style="justify-content:space-between">
      <h2 style="margin:0">${editable ? '编辑草案' : '只读查看'} <span class="mono">v${d.version}</span> <span class="badge ${d.status}">${{ draft: '草案', in_review: '待审核', approved: '已批准' }[d.status]}</span></h2>
      ${editable ? `<div class="row"><button class="btn ok" id="saveDraft">保存草案</button><button class="btn pri" id="submitDraft">保存并提交审核</button></div>` : ''}
    </div>
    <p class="muted small">已批准版本是不可变快照；修订请创建新版本。运行中的场次不受编辑影响，新版本只能在批准的切换点生效。</p>
  </div>
  <div class="card">
    <h2>基本信息</h2>
    <div class="editor-line"><span style="width:80px">名称</span><input type="text" data-f="name" value="${h(c.name)}" style="flex:1" ${ctrl(editable)}></div>
    <div class="editor-line" style="align-items:flex-start"><span style="width:80px;padding-top:6px">说明</span><textarea data-f="description" ${ctrl(editable)}>${h(c.description)}</textarea></div>
  </div>
  <div class="card">
    <h2>角色与责任人</h2>
    <table><thead><tr><th>角色键</th><th>角色名</th><th>承担人员（逗号分隔）</th>${editable ? '<th></th>' : ''}</tr></thead><tbody id="rolesBody">
    ${c.roles.map((r, i) => `<tr><td><input type="text" data-f="rolekey" data-i="${i}" value="${h(r.key)}" ${ctrl(editable)}></td>
      <td><input type="text" data-f="rolename" data-i="${i}" value="${h(r.name)}" ${ctrl(editable)}></td>
      <td><input type="text" data-f="rolepersons" data-i="${i}" value="${h((r.persons || []).join(','))}" style="width:260px" ${ctrl(editable)}></td>
      ${editable ? `<td><button class="btn danger" data-delrole="${i}">删</button></td>` : ''}</tr>`).join('')}
    </tbody></table>
    ${editable ? '<button class="btn" id="addRole">＋角色</button>' : ''}
  </div>
  <div class="card">
    <h2>资源依赖（导出时可内嵌；不可达的外链会进入人工核对清单）</h2>
    <table><thead><tr><th>名称</th><th>URL</th><th>类型</th><th>必需</th><th>内嵌</th>${editable ? '<th></th>' : ''}</tr></thead><tbody id="resBody">
    ${c.resources.map((r, i) => `<tr>
      <td><input type="text" data-f="rname" data-i="${i}" value="${h(r.name)}" style="width:150px" ${ctrl(editable)}></td>
      <td><input type="text" data-f="rurl" data-i="${i}" value="${h(r.url)}" style="width:240px" ${ctrl(editable)}></td>
      <td><select data-f="rkind" data-i="${i}" ${ctrl(editable)}>${['audio', 'video', 'doc', 'image'].map((k) => `<option value="${k}" ${r.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select></td>
      <td><input type="checkbox" data-f="rreq" data-i="${i}" ${r.required ? 'checked' : ''} ${ctrl(editable)}></td>
      <td><input type="checkbox" data-f="rembed" data-i="${i}" ${r.embed !== false ? 'checked' : ''} ${ctrl(editable)}></td>
      ${editable ? `<td><button class="btn danger" data-delres="${i}">删</button></td>` : ''}</tr>`).join('')}
    </tbody></table>
    ${editable ? '<button class="btn" id="addRes">＋资源</button>' : ''}
  </div>
  <div class="card">
    <h2>批准的版本切换点（新版本只允许在这些阶段边界生效）</h2>
    <div>${(c.switchPoints || []).map((k) => `<span class="chip">${h(k)} ${editable ? `<a href="#" data-delsp="${h(k)}">✕</a>` : ''}</span>`).join('') || '<span class="muted small">未设置：运行中将无法切换版本，只能新开场次</span>'}</div>
    ${editable ? `<div class="editor-line" style="margin-top:8px"><input type="text" id="newSp" placeholder="阶段 key，如 s_muster" style="width:200px"><button class="btn" id="addSp">＋切换点</button></div>` : ''}
  </div>
  <div class="card">
    <h2>人工核对项（随导出包提供）</h2>
    ${c.manualChecklist.map((t, i) => `<div class="checkitem">${editable ? `<button class="btn danger" data-delcheck="${i}">删</button>` : ''}<textarea data-f="check" data-i="${i}" ${ctrl(editable)}>${h(t)}</textarea></div>`).join('')}
    ${editable ? '<button class="btn" id="addCheck">＋核对项</button>' : ''}
  </div>
  <div class="card">
    <h2>阶段时间线（报警 / 疏散 / 集合 / 复盘）</h2>
    <div class="timeline">${c.stages.map((st, i) => `<div class="tl" style="z-index:0"><div class="bar"></div><div class="dot">${i + 1}</div><div>${h(st.name)}</div><div class="small muted">${st.durationSec}s${st.timeoutSec != null ? ' / 超时' + st.timeoutSec + 's' : ''}</div></div>`).join('')}</div>
    <div id="stageEditors"></div>
    ${editable ? '<button class="btn" id="addStage">＋追加阶段</button>' : ''}
  </div>`;
  $('#stageEditors').innerHTML = c.stages.map((st, i) => stageEditorHtml(st, i, editable)).join('');
  if (!editable) return;
  bindEditor(s, d);
}
function stageEditorHtml(st, i, editable) {
  const ctrl = editable ? '' : 'disabled';
  return `<div class="stage" style="border-color:#cdbfbd">
    <div class="sh"><b>阶段 ${i + 1}</b>
      <input type="text" data-f="skey" data-i="${i}" value="${h(st.key)}" style="width:110px" ${ctrl}>
      <input type="text" data-f="sname" data-i="${i}" value="${h(st.name)}" style="flex:1;min-width:200px" ${ctrl}>
      <span class="small muted">计划时长(s)</span><input type="number" data-f="sdur" data-i="${i}" value="${st.durationSec}" style="width:80px" ${ctrl}>
      <span class="small muted">超时提醒(s,可空)</span><input type="number" data-f="stimeout" data-i="${i}" value="${st.timeoutSec == null ? '' : st.timeoutSec}" style="width:80px" ${ctrl}>
      ${editable ? `<button class="btn danger" data-delstage="${i}">删除阶段</button>` : ''}
    </div>
    <div class="sb">
      <h3>动作与责任人（时间线）</h3>
      <table><thead><tr><th>动作内容</th><th>责任角色</th><th>计划用时(s)</th>${editable ? '<th></th>' : ''}</tr></thead><tbody>
      ${st.actions.map((a, j) => `<tr><td><input type="text" data-f="atext" data-i="${i}" data-j="${j}" value="${h(a.text)}" style="width:380px" ${ctrl}></td>
        <td><select data-f="aowner" data-i="${i}" data-j="${j}" ${ctrl}>${roleOptions(a.ownerRoleKey)}</select></td>
        <td><input type="number" data-f="adur" data-i="${i}" data-j="${j}" value="${a.durationSec}" style="width:80px" ${ctrl}></td>
        ${editable ? `<td><button class="btn danger" data-delact="${i}-${j}">删</button></td>` : ''}</tr>`).join('')}
      </tbody></table>
      ${editable ? `<button class="btn" data-addact="${i}">＋动作</button>` : ''}
      <h3>阶段条件：人工放行（gate）<span class="muted small">—— 必须满足才能进入下一阶段；只有被授权责任人可以确认。系统/时钟/视频时间均不能代替。</span></h3>
      ${st.gates.map((g, j) => `<div class="gate ${g.id ? '' : ''}">
        <div class="gmain">
          <input type="text" data-f="gtext" data-i="${i}" data-j="${j}" value="${h(g.label)}" style="width:60%" ${ctrl}>
          <span class="small muted">责任人</span>
          <select data-f="gowner" data-i="${i}" data-j="${j}" ${ctrl}>${roleOptions(g.authorizedRoleKey)}</select>
          <input type="text" data-f="gnote" data-i="${i}" data-j="${j}" value="${h(g.note)}" placeholder="备注（如：以人工清点为准）" style="width:230px" ${ctrl}>
        </div>${editable ? `<button class="btn danger" data-delgate="${i}-${j}">删</button>` : ''}</div>`).join('')}
      ${editable ? `<button class="btn warn" data-addgate="${i}">＋人工放行条件</button>` : ''}
      <h3>呈现资源</h3>
      ${st.media.map((m, j) => `<div class="editor-line">
        <select data-f="mres" data-i="${i}" data-j="${j}" ${ctrl}>${(state.draft.snapshot.resources || []).map((r) => `<option value="${h(r.id)}" ${r.id === m.resourceId ? 'selected' : ''}>${h(r.name)}</option>`).join('')}</select>
        <input type="text" data-f="mlabel" data-i="${i}" data-j="${j}" value="${h(m.label)}" placeholder="播放时的标签" style="width:220px" ${ctrl}>
        ${editable ? `<button class="btn danger" data-delmedia="${i}-${j}">删</button>` : ''}</div>`).join('')}
      ${editable ? `<button class="btn" data-addmedia="${i}">＋资源引用</button>` : ''}
      <h3>阶段口播/提示</h3>
      <textarea data-f="sbrief" data-i="${i}" ${ctrl}>${h(st.briefing)}</textarea>
    </div>
  </div>`;
}
function val(f) { return `[data-f="${f}"]`; }
function bindEditor(s, d) {
  const area = $('#editorArea');
  area.onclick = async (e) => {
    const t = e.target;
    const gather = () => collectDraft();
    if (t.id === 'addRole') { gather(); d.snapshot.roles.push({ key: 'role' + (d.snapshot.roles.length + 1), name: '新角色', persons: [] }); rerender(true); }
    else if (t.id === 'addRes') { gather(); d.snapshot.resources.push({ id: 'res_' + cid(), name: '新资源', url: '', kind: 'doc', required: false, embed: true }); rerender(true); }
    else if (t.id === 'addCheck') { gather(); d.snapshot.manualChecklist.push('新核对项'); rerender(true); }
    else if (t.id === 'addStage') { gather(); const n = d.snapshot.stages.length; d.snapshot.stages.push({ key: 's_new' + n, name: '新阶段', durationSec: 120, actions: [], gates: [], timeoutSec: null, media: [], briefing: '' }); rerender(true); }
    const dd = t.dataset.delrole, dr = t.dataset.delres, dc = t.dataset.delcheck, ds = t.dataset.delstage;
    if (dd !== undefined) { gather(); d.snapshot.roles.splice(+dd, 1); rerender(true); }
    if (dr !== undefined) { gather(); d.snapshot.resources.splice(+dr, 1); rerender(true); }
    if (dc !== undefined) { gather(); d.snapshot.manualChecklist.splice(+dc, 1); rerender(true); }
    if (ds !== undefined) { gather(); d.snapshot.stages.splice(+ds, 1); rerender(true); }
    if (t.dataset.addact !== undefined) { gather(); const i = +t.dataset.addact; d.snapshot.stages[i].actions.push({ id: 'a_' + cid(), ownerRoleKey: (d.snapshot.roles[0] || {}).key || '', text: '新动作', durationSec: 30 }); rerender(true); }
    if (t.dataset.addgate !== undefined) { gather(); const i = +t.dataset.addgate; d.snapshot.stages[i].gates.push({ id: 'g_' + cid(), label: '人工放行条件', authorizedRoleKey: (d.snapshot.roles[0] || {}).key || '', note: '' }); rerender(true); }
    if (t.dataset.addmedia !== undefined) { gather(); const i = +t.dataset.addmedia; const first = d.snapshot.resources[0]; d.snapshot.stages[i].media.push({ resourceId: first ? first.id : '', label: '' }); rerender(true); }
    if (t.dataset.delact) { gather(); const [i, j] = t.dataset.delact.split('-').map(Number); d.snapshot.stages[i].actions.splice(j, 1); rerender(true); }
    if (t.dataset.delgate) { gather(); const [i, j] = t.dataset.delgate.split('-').map(Number); d.snapshot.stages[i].gates.splice(j, 1); rerender(true); }
    if (t.dataset.delmedia) { gather(); const [i, j] = t.dataset.delmedia.split('-').map(Number); d.snapshot.stages[i].media.splice(j, 1); rerender(true); }
    if (t.dataset.delsp !== undefined) { e.preventDefault(); gather(); d.snapshot.switchPoints = d.snapshot.switchPoints.filter((x) => x !== t.dataset.delsp); rerender(true); }
    if (t.id === 'addSp') { gather(); const k = $('#newSp').value.trim(); if (k) { d.snapshot.switchPoints.push(k); rerender(true); } }
    if (t.id === 'saveDraft') { gather(); await saveDraft(s, d, false); }
    if (t.id === 'submitDraft') { gather(); await saveDraft(s, d, true); }
  };
}
function collectDraft() {
  const d = state.draft, c = d.snapshot;
  c.name = $(val('name')).value; c.description = $(val('description')).value;
  c.roles = $$('#rolesBody tr').map((tr) => ({
    key: tr.querySelector(val('rolekey')).value.trim(),
    name: tr.querySelector(val('rolename')).value.trim(),
    persons: tr.querySelector(val('rolepersons')).value.split(/[,，]/).map((x) => x.trim()).filter(Boolean)
  }));
  c.resources = $$('#resBody tr').map((tr, i) => ({
    id: state.draft.snapshot.resources[i] ? state.draft.snapshot.resources[i].id : ('res_' + cid()),
    name: tr.querySelector(val('rname')).value.trim(),
    url: tr.querySelector(val('rurl')).value.trim(),
    kind: tr.querySelector(val('rkind')).value,
    required: tr.querySelector(val('rreq')).checked,
    embed: tr.querySelector(val('rembed')).checked
  }));
  c.manualChecklist = $$(val('check')).map((el) => el.value);
  c.stages = $$('#stageEditors .stage').map((wrap, i) => ({
    key: wrap.querySelector(val('skey')).value.trim(),
    name: wrap.querySelector(val('sname')).value.trim(),
    durationSec: +wrap.querySelector(val('sdur')).value || 0,
    timeoutSec: wrap.querySelector(val('stimeout')).value === '' ? null : +wrap.querySelector(val('stimeout')).value || 0,
    briefing: wrap.querySelector(val('sbrief')).value,
    actions: $$(val('atext'), wrap).map((el, j) => ({
      id: state.draft.snapshot.stages[i].actions[j] ? state.draft.snapshot.stages[i].actions[j].id : 'a_' + cid(),
      text: el.value, ownerRoleKey: $$(val('aowner'), wrap)[j].value, durationSec: +$$(val('adur'), wrap)[j].value || 0
    })),
    gates: $$(val('gtext'), wrap).map((el, j) => ({
      id: state.draft.snapshot.stages[i].gates[j] ? state.draft.snapshot.stages[i].gates[j].id : 'g_' + cid(),
      label: el.value, authorizedRoleKey: $$(val('gowner'), wrap)[j].value, note: $$(val('gnote'), wrap)[j].value
    })),
    media: $$(val('mres'), wrap).map((el, j) => ({ resourceId: el.value, label: $$(val('mlabel'), wrap)[j].value }))
  }));
  return d;
}
async function saveDraft(s, d, submit) {
  try {
    await api('PUT', `/api/scripts/${s.id}/versions/${d.id}/content`, { snapshot: d.snapshot });
    toast('草案已保存', 'ok');
    if (submit) { await api('POST', `/api/scripts/${s.id}/versions/${d.id}/submit`, {}); toast('已提交审核，请到「审核版本」页批准', 'ok'); }
    await refreshScripts(); state.draft = await api('GET', `/api/scripts/${s.id}/versions/${d.id}`);
    rerender(false);
  } catch (e) { toast(e.message, 'err'); }
}

/* ================= 审核版本 ================= */
function renderReview(v) {
  const s = state.scripts.find((x) => x.id === state.curScriptId);
  v.innerHTML = `<div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">用户审核</h2>
    <select id="revScriptSel">${state.scripts.map((x) => `<option value="${x.id}" ${s && x.id === s.id ? 'selected' : ''}>${h(x.name)}</option>`).join('')}</select></div></div>
  <div id="revBody"></div>
  <div class="card"><h2>版本差异（责任人 / 资源依赖 / 阶段条件）</h2><div id="diffBox" class="small muted">选择两个版本后对比</div></div>`;
  $('#revScriptSel').onchange = async (e) => { state.curScriptId = e.target.value; localStorage.setItem('fd.scriptId', state.curScriptId); state.diff = null; rerender(false); };
  if (!s) return;
  $('#revBody').innerHTML = `
  <div class="card"><table><thead><tr><th>版本</th><th>状态</th><th>说明</th><th>审核信息</th><th style="width:260px">审核操作</th></tr></thead><tbody>
  ${s.versions.map((ver) => `<tr>
    <td class="mono">v${ver.version}</td><td><span class="badge ${ver.status}">${{ draft: '草案', in_review: '待审核', approved: '已批准' }[ver.status]}</span></td>
    <td>${h(ver.note)}</td><td class="small muted">${ver.approvedAt ? h(ver.approver) + '<br>' + fmtTs(ver.approvedAt) : '—'}</td>
    <td>${ver.status === 'draft' ? `<button class="btn" data-submit="${ver.id}">提交审核</button>`
      : ver.status === 'in_review' ? `<button class="btn ok" data-approve="${ver.id}">签字批准</button> <button class="btn danger" data-reject="${ver.id}">驳回</button>`
      : '<span class="muted small">不可变</span>'}</td></tr>`).join('')}
  </tbody></table>
  <p class="muted small">只有「已批准」版本可以启动排练或导出离线包；新版本对运行中的场次只在其声明的切换点生效。</p></div>
  <div class="card"><h2>导出离线脚本包</h2>
    <p class="small muted">单文件 HTML，资源尽量内嵌；不可用资源进入 manifest 的人工核对项。现场浏览器下载后可完全断网播放。</p>
    <div class="row">${s.versions.filter((x) => x.status === 'approved').map((ver) =>
      `<a class="btn pri" href="/api/scripts/${s.id}/export?versionId=${ver.id}" download>下载 v${ver.version} 播放包(.html)</a>
       <a class="btn" href="/api/scripts/${s.id}/export?versionId=${ver.id}&manifest=1" download>下载 v${ver.version} 清单(.json)</a>`).join('') || '<span class="muted">暂无已批准版本</span>'}
    </div></div>`;
  $$('[data-submit]', v).forEach((b) => b.onclick = async () => { await api('POST', `/api/scripts/${s.id}/versions/${b.dataset.submit}/submit`, {}); await refreshScripts(); toast('已提交审核', 'ok'); rerender(false); });
  $$('[data-approve]', v).forEach((b) => b.onclick = async () => {
    const approver = prompt('批准人签名（姓名）', state.identity.userName || ''); if (approver === null) return;
    try { await api('POST', `/api/scripts/${s.id}/versions/${b.dataset.approve}/approve`, { approver }); await refreshScripts(); toast('版本已批准，可启动排练/导出', 'ok'); rerender(false); }
    catch (e) { toast(e.message, 'err'); }
  });
  $$('[data-reject]', v).forEach((b) => b.onclick = async () => { await api('POST', `/api/scripts/${s.id}/versions/${b.dataset.reject}/reject`, {}); await refreshScripts(); toast('已驳回为草案', 'warn'); rerender(false); });

  const vers = s.versions;
  if (!state.diffFrom) state.diffFrom = vers.filter((x) => x.status === 'approved').slice(-1)[0]?.id;
  if (!state.diffTo) state.diffTo = vers.find((x) => x.status === 'draft')?.id;
  $('#diffBox').innerHTML = `<div class="row">从 <select id="diffA">${vers.map((x) => `<option value="${x.id}" ${x.id === state.diffFrom ? 'selected' : ''}>v${x.version}</option>`).join('')}</select>
    到 <select id="diffB">${vers.map((x) => `<option value="${x.id}" ${x.id === state.diffTo ? 'selected' : ''}>v${x.version}</option>`).join('')}</select>
    <button class="btn" id="diffGo">对比</button></div><div id="diffResult" style="margin-top:10px"></div>`;
  $('#diffGo').onclick = async () => {
    try {
      state.diffFrom = $('#diffA').value; state.diffTo = $('#diffB').value;
      const d = await api('GET', `/api/scripts/${s.id}/diff?from=${state.diffFrom}&to=${state.diffTo}`);
      state.diff = d; renderDiff();
    } catch (e) { toast(e.message, 'err'); }
  };
  if (state.diff && state.diff.from.id === state.diffFrom && state.diff.to.id === state.diffTo) renderDiff();
}
function renderDiff() {
  const d = state.diff;
  const label = { 'role.add': '角色新增', 'role.remove': '角色删除', 'role.person': '责任人变更', 'resource.add': '依赖新增', 'resource.remove': '依赖删除',
    'stage.add': '阶段新增', 'stage.remove': '阶段删除', 'stage.name': '阶段改名', 'stage.duration': '时长变更',
    'gate.add': '放行条件新增', 'gate.remove': '放行条件删除', 'gate.owner': '★放行责任人变更', 'action.owner': '★动作责任人变更' };
  $('#diffResult').innerHTML = d.changes.length === 0 ? '<span class="muted">无差异</span>' :
    `<table><thead><tr><th>类型</th><th>位置</th><th>原</th><th>新</th></tr></thead><tbody>
    ${d.changes.map((c) => `<tr><td class="small">${label[c.kind] || c.kind}</td><td>${h(c.path)}</td>
      <td class="diff-del">${h(c.from ?? '—')}</td><td class="diff-add">${h(c.to ?? '—')}</td></tr>`).join('')}</tbody></table>`;
}

/* ================= 公共：运行视图渲染 ================= */
function renderTimeline(st) {
  return `<div class="timeline">${st.stages.map((s, i) => {
    const cls = s.isCurrent ? 'tl cur' : (st.status === 'ended' || i < st.currentIndex || s.open ? (s.entered && i < st.currentIndex ? 'tl done' : '') : '');
    const done = i < st.currentIndex || (s.open && s.entered);
    return `<div class="tl ${s.isCurrent ? 'cur' : done ? 'done' : ''}"><div class="bar"></div><div class="dot">${done ? '✓' : i + 1}</div>
      <div>${h(s.name)}</div><div class="small muted">${s.entered ? '已进入' : '未进入'}${s.open ? ' · 已放行' : ''}</div></div>`;
  }).join('')}</div>`;
}
function roleName(st, key) { const r = (st.roles || []).find((x) => x.key === key); return r ? `${r.name}(${r.key})` : key; }
function gateHtml(g, st, canAct, stageKey) {
  const mine = state.identity.roleKey === g.authorizedRoleKey || state.identity.roleKey === 'commander';
  return `<div class="gate ${g.passed ? 'done' : ''}">
    <div class="gmain">
      <b>${g.passed ? '✅' : '⛔'} ${h(g.label)}</b>
      <div class="small muted">责任人：${h(roleName(st, g.authorizedRoleKey))}${g.note ? '；' + h(g.note) : ''}</div>
      ${g.passed ? `<div class="small">放行：${h(g.passedBy || '')} · ${fmtTs(g.passedAt)}
        ${g.late ? '<span class="badge late">迟到</span>' : ''}${g.offline ? '<span class="badge offline">离线确认</span>' : ''}${g.force ? '<span class="badge draft">强制</span>' : ''}</div>` : ''}
    </div>
    ${!g.passed && canAct && mine ? `<button class="btn ok" data-pass="${stageKey}|${g.id}">人工放行确认</button>
       <button class="btn ghost" data-forcepass="${stageKey}|${g.id}">总指挥代为放行</button>` : ''}
    ${!g.passed && canAct && !mine ? `<span class="small muted">等待 ${h(roleName(st, g.authorizedRoleKey))} 确认</span>` : ''}
  </div>`;
}
function stageHtml(s, st, mode, canAct) {
  const cls = ['stage', s.isCurrent ? 'current' : '', s.open && s.entered ? 'done-stage' : '', s.entered && !s.isCurrent ? 'entered-not-current' : ''].join(' ');
  const contentStage = st.content.stages.find((x) => x.key === s.key) || {};
  const enteredInfo = s.entered ? `<span class="pill">进入: ${fmtTs(s.enteredAt)}</span>${s.forced ? '<span class="badge late">强制进入</span>' : ''}${s.enteredBy === 'clock' ? '<span class="pill">时钟自动进入（仍需人工放行）</span>' : ''}` : '<span class="pill">未进入</span>';
  return `<div class="${cls}">
    <div class="sh"><b>${h(s.name)}</b> ${enteredInfo}
      <span class="pill">计划 ${contentStage.durationSec || 0}s</span>${contentStage.timeoutSec != null ? `<span class="pill">超时提醒 ${contentStage.timeoutSec}s</span>` : ''}
      ${s.open ? '<span class="badge approved">条件全部放行</span>' : (s.isCurrent ? '<span class="badge late pulse">待人工确认</span>' : '')}</div>
    <div class="sb">
      ${contentStage.briefing ? `<div class="banner info small">📢 ${h(contentStage.briefing)}</div>` : ''}
      <h3>动作分工</h3>
      <table><thead><tr><th>动作</th><th>责任角色</th><th>用时</th></tr></thead><tbody>
      ${(contentStage.actions || []).map((a) => `<tr><td>${h(a.text)}</td><td>${h(roleName(st, a.ownerRoleKey))}</td><td class="small muted">${a.durationSec}s</td></tr>`).join('')}</tbody></table>
      <h3>阶段条件（人工放行）</h3>
      ${s.gates.length ? s.gates.map((g) => gateHtml(g, st, canAct && s.isCurrent, s.key)).join('') : '<span class="muted small">本阶段无放行条件</span>'}
      ${renderMedia(contentStage, st, s.isCurrent, canAct)}
    </div>
  </div>`;
}
function renderMedia(contentStage, st, isCurrent, canAct) {
  if (!contentStage.media || !contentStage.media.length) return '';
  const resById = Object.fromEntries((st.resources || []).map((r) => [r.id, r]));
  const embedMap = st._embeds || {};
  return `<h3>呈现资源</h3>${contentStage.media.map((m) => {
    const r = resById[m.resourceId] || {};
    const src = embedMap[m.resourceId] || r.url;
    const missing = (st.audioMissing || []).some((x) => x.resourceId === m.resourceId && x.stageKey === contentStage.key);
    return `<div class="editor-line"><span class="chip">${h(r.kind || '资源')}</span><b>${h(m.label || r.name)}</b>
      ${r.kind === 'audio' ? `<audio controls src="${h(src)}"></audio>` : r.kind === 'video' ? `<video controls src="${h(src)}" style="max-width:320px"></video>` : `<a class="btn" target="_blank" href="${h(src)}">打开</a>`}
      ${canAct && isCurrent ? `<button class="btn warn" data-audiomissing="${contentStage.key}|${h(m.resourceId)}|${encodeURIComponent(r.url || '')}">🔇 播放不到/缺失，登记</button>` : ''}
      ${missing ? '<span class="badge late">已登记缺失：改用人工口令</span>' : ''}
      <span class="small muted">⚠ 播放进度仅作呈现，不代表任何动作完成</span></div>`;
  }).join('')}`;
}

/* ================= 主持端 ================= */
async function loadRun(force) {
  if (!state.curRunId) { state.st = null; return; }
  const r = await api('GET', '/api/runs/' + state.curRunId);
  r._embeds = r._embeds || {}; // 在线模式直接使用原始 url
  state.st = r; state.stTs = Date.now();
  localStorage.setItem('fd.runId', state.curRunId);
}
function renderHost(v) {
  const s = state.scripts.find((x) => x.id === state.curScriptId);
  v.innerHTML = `
  <div class="card"><div class="row" style="justify-content:space-between">
    <h2 style="margin:0">主持端 · 排练控制</h2>
    <div class="row">
      <select id="hScriptSel">${state.scripts.map((x) => `<option value="${x.id}" ${s && x.id === s.id ? 'selected' : ''}>${h(x.name)}</option>`).join('')}</select>
      <select id="hRunSel" style="max-width:300px"><option value="">— 选择场次 —</option></select>
    </div></div></div>
  <div id="hostBody"></div>`;
  $('#hScriptSel').onchange = async (e) => { state.curScriptId = e.target.value; localStorage.setItem('fd.scriptId', state.curScriptId); state.curRunId = null; localStorage.removeItem('fd.runId'); state.st = null; clearInterval(window.__hb); rerender(false); };
  (async () => {
    if (!s) { $('#hostBody').innerHTML = '<div class="card muted">请先选择脚本</div>'; return; }
    const runs = await api('GET', `/api/scripts/${s.id}/runs`);
    const sel = $('#hRunSel');
    runs.forEach((r) => { const o = document.createElement('option'); o.value = r.id; o.textContent = `${r.mode === 'clock' ? '统一时钟' : '主持人事件'} · ${r.versionLabel} · ${r.status} · ${fmtTs(r.startedAt)}`; if (r.id === state.curRunId) o.selected = true; sel.appendChild(o); });
    sel.onchange = async () => { state.curRunId = sel.value || null; if (state.curRunId) localStorage.setItem('fd.runId', state.curRunId); clearInterval(window.__hb); state.st = null; try { await loadRun(true); } catch (e) {} rerender(false); };
    paintHost(s);
  })();
}
function paintHost(s) {
  const v = $('#hostBody');
  if (!state.st) {
    const approved = s.versions.filter((x) => x.status === 'approved');
    v.innerHTML = `<div class="card"><h2>开始一场新排练</h2>
      <p class="small muted">选择推进方式：</p>
      <div class="grid2">
        <div class="banner info"><b>模式 A：主持人事件推进</b><br>所有阶段进入都由主持人手动发令。适合节奏需要临场把握的排练。</div>
        <div class="banner info"><b>模式 B：统一时钟推进</b><br>按脚本计划时长，到时自动“进入”下一阶段（时间线自动滚动）；<b>但放行确认仍然必须人工完成</b>，门不自动开、疏散不自动算完成。</div>
      </div>
      <div class="editor-line"><span>使用版本</span><select id="startVer">${approved.map((x) => `<option value="${x.id}">v${x.version}（已批准）</option>`).join('')}</select>
        <button class="btn pri" data-start="host">用模式A开始</button>
        <button class="btn pri" data-start="clock">用模式B开始</button></div>
      ${approved.length === 0 ? '<div class="banner err">没有已批准版本，请先在审核页批准</div>' : ''}
      <div class="banner safe small">安全红线：本工具不连接真实消防设施；视频时间到达 ≠ 人员完成疏散；超时仅提醒，不自动代替现场负责人判断。</div></div>`;
    $$('[data-start]', v).forEach((b) => b.onclick = async () => {
      try {
        const r = await api('POST', `/api/scripts/${s.id}/runs`, { mode: b.dataset.start, versionId: $('#startVer').value, userName: state.identity.userName });
        state.curRunId = r.runId; localStorage.setItem('fd.runId', r.runId); await loadRun(true); toast(`场次已开始（${r.mode === 'clock' ? '统一时钟' : '主持人事件'}）`, 'ok'); rerender(false);
      } catch (e) { toast(e.message, 'err'); }
    });
    return;
  }
  const st = state.st;
  const canHost = st.host && st.host.userId === state.identity.userId;
  const curStage = st.stages.find((x) => x.key === st.currentStageKey);
  const idx = st.currentIndex; const nextStage = st.stages[idx + 1];
  v.innerHTML = `
  <div class="banner safe small">🛑 本系统仅用于消防演练组织与呈现，不控制任何真实消防设施。任何阶段的“完成”都以授权责任人人工放行确认为准。</div>
  <div class="card">
    <div class="row" style="justify-content:space-between">
      <div><b>${h(s.name)}</b> · <span class="mono">${h(st.versionLabel)}</span> ·
        ${st.mode === 'clock' ? '<span class="badge in_review">统一时钟推进</span>' : '<span class="badge draft">主持人事件推进</span>'}
        <span class="badge ${st.status === 'ended' ? 'ended' : st.isPaused ? 'in_review' : 'approved'}">${st.status === 'ended' ? '已结束' : st.isPaused ? '已暂停（人工放行后恢复）' : '进行中'}</span></div>
      <div class="small muted">已用 ${fmtClock(st.elapsedSec)}</div>
    </div>
    ${renderTimeline(st)}
    <div id="hostPanel"></div>
  </div>
  <div class="card"><h2>阶段与放行条件（已执行 / 待确认）</h2><div id="stageBox"></div></div>
  <div class="card"><h2>计划修订（新版本切换）</h2><div id="switchBox"></div></div>
  <div class="card"><h2>主持备注（记入事实日志）</h2>
    <textarea id="noteText" name="noteText" placeholder="例：二层拐角有真实堆物，临时改道（现场判断）"></textarea>
    <div class="row" style="margin-top:6px"><button class="btn" id="addNote">记录备注</button>
    <label class="btn ghost"><input type="file" id="offlineFile" accept="application/json" hidden>导入离线确认文件</label></div></div>`;
  $('#stageBox').innerHTML = st.stages.map((x) => stageHtml(x, st, 'host', canHost)).join('');

  // 控制区
  const hp = $('#hostPanel');
  if (st.status === 'ended') {
    hp.innerHTML = '<div class="banner ok">本场已结束。执行记录为事实，不可删除/回退；迟到的离线确认仍可导入并标记。</div>';
  } else if (!st.host) {
    hp.innerHTML = `<div class="banner warn"><b>当前没有人持有推进权。</b>
      你的身份：${h(state.identity.userName || '未命名')}（${h(roleName(st, state.identity.roleKey))}）
      <div style="margin-top:8px"><button class="btn pri" id="claimBtn">获取唯一推进权</button></div></div>`;
  } else if (!canHost) {
    hp.innerHTML = `<div class="banner ${st.host.stale ? 'err' : 'warn'}"><b>推进权由 ${h(st.host.userName)} 持有</b>（${h(roleName(st, st.host.roleKey))}）
      心跳：${fmtTs(st.host.lastHeartbeat)} ${st.host.stale ? '— <b>已超时（疑似崩溃）</b>' : '正常'}
      <div style="margin-top:8px">${st.host.stale ? `<button class="btn danger" id="takeBtn">接管推进权（留痕）</button>` : '<span class="small">两人不能同时推进；若对方崩溃，等心跳超时后可接管。</span>'}</div></div>`;
  } else {
    hp.innerHTML = `
    <div class="banner ok">你持有推进权：${h(st.host.userName)}（心跳每5秒）
      <button class="btn ghost" id="crashBtn" style="margin-left:10px">💥 模拟主持端崩溃（停心跳，验收用）</button></div>
    ${st.isPaused ? `<div class="banner err">⏸ 已暂停：时间线停止，现场确认也被挂起；必须由主持人人工放行恢复。<div style="margin-top:6px"><button class="btn pri" id="resumeBtn">▶ 人工放行恢复</button></div></div>`
      : `<div class="row" style="margin:6px 0"><button class="btn warn" id="pauseBtn">⏸ 暂停（等待人工放行）</button><input type="text" id="pauseReason" name="pauseReason" placeholder="暂停原因（如：现场安全问题）" style="width:260px"></div>`}
    ${curStage ? `<div class="banner ${curStage.open ? 'ok' : 'err'}">
      当前阶段：<b>${h(curStage.name)}</b> — ${curStage.open ? '全部放行条件已满足' : `还有 ${curStage.gates.filter((g) => !g.passed).length} 项待人工确认：${curStage.gates.filter((g) => !g.passed).map((g) => h(g.label)).join('；')}`}
      ${nextStage ? `<div style="margin-top:8px"><button class="btn pri" id="nextBtn" ${st.isPaused ? 'disabled' : ''}>进入下一阶段：${h(nextStage.name)}</button>
        <label class="small"><input type="checkbox" id="forceNext"> 条件未齐也强制进入（现场负责人决策）</label>
        <input type="text" id="forceReason" name="forceReason" placeholder="强制理由（必填，留痕）" style="width:260px"></div>` :
        `<div style="margin-top:8px"><button class="btn pri" id="endBtn" ${st.isPaused ? 'disabled' : ''}>结束本场排练</button>
        <label class="small"><input type="checkbox" id="forceEnd"> 条件未齐强制结束</label><input type="text" id="endReason" name="endReason" placeholder="强制结束理由" style="width:240px"></div>`}
    </div>` : `<div class="banner info">尚未进入第一阶段。<button class="btn pri" id="nextBtn">进入「${h(st.stages[0].name)}」</button></div>`}
    ${(st.reminders || []).map((rm) => `<div class="banner warn pulse">⏰ 超时提醒：${h(st.stages.find((x) => x.key === rm.stageKey).name)} 已用 ${rm.elapsedSec}s / 阈值 ${rm.timeoutSec}s。<b>仅提醒：不自动推进、不自动放行，请现场负责人决策。</b></div>`).join('')}
    ${st.pendingSwitch ? `<div class="banner info">🔁 已计划在切换点切换到新版本（下一批准切换点：${h(st.pendingSwitch.nextSwitchPoint || '无（本场不生效）')}）<button class="btn ghost" id="cancelSwitch">取消计划</button></div>` : ''}`;
  }

  // 版本切换区
  const otherApproved = s.versions.filter((x) => x.status === 'approved' && x.id !== st.versionId);
  $('#switchBox').innerHTML = `
    <p class="small muted">运行中不能直接换脚本。切换只会在<b>脚本声明的批准切换点</b>（当前版本：${h((st.switchPoints || []).join('、') || '无')}）随“进入下一阶段”生效；已执行阶段保持旧版本事实。</p>
    ${st.pendingSwitch ? `<div class="banner ok">计划：→ ${h((s.versions.find((x) => x.id === st.pendingSwitch.toVersionId) || {}).version != null ? 'v' + s.versions.find((x) => x.id === st.pendingSwitch.toVersionId).version : '?')}，等待切换点</div>` : ''}
    <div class="row">${otherApproved.length ? `<select id="switchVer">${otherApproved.map((x) => `<option value="${x.id}">v${x.version}</option>`).join('')}</select>
      <button class="btn" id="planSwitch" ${canHost && st.status !== 'ended' ? '' : 'disabled'}>计划在切换点切换</button>` : '<span class="muted small">没有其他已批准版本</span>'}</div>`;

  bindHostPanel(st);
}
function bindHostPanel(st) {
  const v = $('#hostBody');
  const claim = async (takeover) => {
    try {
      await api('POST', `/api/runs/${st.runId}/claim`, { userId: state.identity.userId, userName: state.identity.userName || ('用户' + state.identity.userId.slice(-4)), roleKey: state.identity.roleKey, reason: takeover ? '原主持端心跳超时' : '' });
      localStorage.removeItem('fd.crashRun');
      toast(takeover ? '已接管推进权（事件已留痕）' : '已获取推进权', 'ok');
      await loadRun(true); startHeartbeat(); rerender(false);
    } catch (e) { toast(e.message, 'err', 6000); }
  };
  const cb = $('#claimBtn', v); if (cb) cb.onclick = () => claim(false);
  const tb = $('#takeBtn', v); if (tb) tb.onclick = () => claim(true);
  const crash = $('#crashBtn', v);
  if (crash) crash.onclick = async () => {
    localStorage.setItem('fd.crashRun', st.runId); clearInterval(window.__hb);
    await api('POST', `/api/runs/${st.runId}/simulate-crash`, {});
    toast('已模拟崩溃：本端停止心跳，约15秒后他人可接管', 'warn', 6000);
    await loadRun(true); rerender(false);
  };
  startHeartbeat(st);
  const cmd = async (command, extra) => {
    try { await api('POST', `/api/runs/${st.runId}/command`, { userId: state.identity.userId, command, ...extra }); await loadRun(true); toast('命令已执行并留痕', 'ok'); rerender(false); }
    catch (e) { toast(e.message, 'err', 6000); await loadRun(true); rerender(false); }
  };
  const pb = $('#pauseBtn', v); if (pb) pb.onclick = () => cmd('pause', { reason: $('#pauseReason', v).value });
  const rb = $('#resumeBtn', v); if (rb) rb.onclick = () => cmd('resume');
  const nb = $('#nextBtn', v);
  if (nb) nb.onclick = () => {
    const stages = state.st.stages;
    const target = stages[state.st.currentIndex + 1] || stages[0];
    const force = $('#forceNext', v)?.checked;
    cmd('enter-stage', { stageKey: target.key, force, reason: $('#forceReason', v)?.value || '' });
  };
  const eb = $('#endBtn', v); if (eb) eb.onclick = () => cmd('end', { force: $('#forceEnd', v).checked, reason: $('#endReason', v)?.value || '' });
  const ps = $('#planSwitch', v);
  if (ps) ps.onclick = async () => {
    try { const r = await api('POST', `/api/runs/${st.runId}/plan-switch`, { toVersionId: $('#switchVer', v).value, userName: state.identity.userName });
      toast(r.warning || '已计划切换，将在批准的切换点生效', r.warning ? 'warn' : 'ok', 6000); await loadRun(true); rerender(false); }
    catch (e) { toast(e.message, 'err'); }
  };
  const cs = $('#cancelSwitch', v); if (cs) cs.onclick = async () => { await api('POST', `/api/runs/${st.runId}/cancel-switch`, { userName: state.identity.userName }); await loadRun(true); rerender(false); };
  const nt = $('#addNote', v);
  if (nt) nt.onclick = async () => {
    const text = $('#noteText', v).value.trim(); if (!text) return toast('备注为空', 'warn');
    await api('POST', `/api/runs/${st.runId}/notes`, { text, userName: state.identity.userName });
    $('#noteText', v).value = ''; await loadRun(true); rerender(true);
  };
  const of = $('#offlineFile', v);
  if (of) of.onchange = () => importOfflineFile(of.files[0]);

  // 放行按钮（主持端也可确认，取决于身份角色）
  $$('[data-pass]', v).forEach((b) => b.onclick = () => doPass(b.dataset.pass, false));
  $$('[data-forcepass]', v).forEach((b) => b.onclick = () => {
    const reason = prompt('总指挥代为放行：填写理由（留痕）', '现场指定代行');
    if (reason) doPass(b.dataset.forcepass, true, reason);
  });
  $$('[data-audiomissing]', v).forEach((b) => b.onclick = async () => {
    const [stageKey, resId, urlEnc] = b.dataset.audiomissing.split('|');
    await api('POST', `/api/runs/${st.runId}/audio-missing`, { stageKey, resourceId: resId, url: decodeURIComponent(urlEnc), userName: state.identity.userName });
    toast('已登记缺失：请现场改用人工口令/哨音，系统不会自动替代', 'warn', 6000);
    await loadRun(true); rerender(false);
  });
}
function startHeartbeat(stParam) {
  clearInterval(window.__hb);
  const st0 = stParam || state.st;
  if (!st0 || !st0.host || st0.host.userId !== state.identity.userId) return;
  window.__hb = setInterval(async () => {
    if (localStorage.getItem('fd.crashRun') === state.curRunId) { clearInterval(window.__hb); return; }
    try { await api('POST', `/api/runs/${state.curRunId}/heartbeat`, { userId: state.identity.userId }); }
    catch (e) { clearInterval(window.__hb); }
  }, 5000);
}
async function importOfflineFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (data.packageType !== 'fire-drill-offline-confirmations') throw new Error('文件不是离线确认包');
    const events = (data.events || []).map((ev) => ({
      clientEventId: ev.clientEventId, type: 'gate.pass', runId: state.curRunId,
      stageKey: ev.stageKey, gateId: ev.gateId,
      roleKey: ev.roleKey, userName: ev.userName ? (ev.userName + '(离线设备)') : '离线设备',
      userId: 'offline-' + (data.device ? data.device.userName : 'dev'),
      observedAt: ev.observedAt
    }));
    if (!events.length) return toast('文件中没有确认事件', 'warn');
    const r = await api('POST', `/api/runs/${state.curRunId}/offline-events`, { events });
    // 提示音缺失也补登记
    for (const am of data.audioMissing || []) {
      await api('POST', `/api/runs/${state.curRunId}/audio-missing`, { resourceId: am.resourceId, stageKey: am.stageKey, url: '', userName: (am.by || '离线设备') + '(离线包)' }).catch(() => {});
    }
    toast(`导入完成：接受 ${r.accepted.length}，重复 ${r.duplicates.length}，拒绝 ${r.rejected.length}；迟到 ${r.accepted.filter((x) => x.late).length}`, r.rejected.length ? 'err' : 'ok', 8000);
    await loadRun(true); rerender(false);
  } catch (e) { toast('导入失败：' + (e.message || e), 'err', 7000); }
}
async function doPass(token, force, reason) {
  const [stageKey, gateId] = token.split('|');
  if (!navigator.onLine) return queueOffline(stageKey, gateId);
  try {
    await api('POST', `/api/runs/${state.curRunId}/confirm`, { stageKey, gateId, roleKey: state.identity.roleKey, userName: state.identity.userName || '未命名', userId: state.identity.userId, force, reason: reason || '' });
    toast('已人工放行并记为事实（不可撤销）', 'ok'); await loadRun(true); rerender(false);
  } catch (e) { toast(e.message, 'err', 6000); }
}

/* ================= 现场设备 ================= */
function offlineQueue() { return JSON.parse(localStorage.getItem('fd.offlineQueue') || '[]'); }
function setOfflineQueue(q) { localStorage.setItem('fd.offlineQueue', JSON.stringify(q)); }
function queueOffline(stageKey, gateId) {
  const q = offlineQueue();
  q.push({ clientEventId: cid(), runId: state.curRunId, type: 'gate.pass', stageKey, gateId,
    roleKey: state.identity.roleKey, userName: state.identity.userName || '未命名', userId: state.identity.userId, observedAt: new Date().toISOString() });
  setOfflineQueue(q);
  toast('当前断网：确认已暂存本机，重连后自动上报（可能标记迟到）', 'warn', 7000);
  rerender(false);
}
async function flushOfflineQueue() {
  if (!navigator.onLine) return;
  let q = offlineQueue(); if (!q.length) return;
  const byRun = {};
  q.forEach((e) => { (byRun[e.runId] = byRun[e.runId] || []).push(e); });
  const remain = [];
  for (const [runId, events] of Object.entries(byRun)) {
    try {
      const r = await api('POST', `/api/runs/${runId}/offline-events`, { events });
      const okIds = new Set(r.accepted.map((x) => x.clientEventId).concat(r.duplicates));
      events.forEach((e) => { if (!okIds.has(e.clientEventId)) remain.push(e); });
      if (r.accepted.length) toast(`离线确认已同步 ${r.accepted.length} 条（其中迟到 ${r.accepted.filter((x) => x.late).length} 条）`, r.accepted.some((x) => x.late) ? 'warn' : 'ok', 7000);
      if (r.rejected.length) toast(`${r.rejected.length} 条被拒：${r.rejected.map((x) => x.reason).join('；')}`, 'err', 8000);
    } catch (e) { remain.push(...events); }
  }
  setOfflineQueue(remain);
  if (state.curRunId) try { await loadRun(true); } catch (e) {}
  if (['field', 'host', 'ledger'].includes(state.tab)) rerender(true);
}
function renderField(v) {
  const s = state.scripts.find((x) => x.id === state.fieldScriptId) || state.scripts[0];
  v.innerHTML = `
  <div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">现场设备（引导员/清点组）</h2>
    <div class="row">
      <select id="fScriptSel">${state.scripts.map((x) => `<option value="${x.id}" ${s && x.id === s.id ? 'selected' : ''}>${h(x.name)}</option>`).join('')}</select>
      <select id="fRunSel"><option value="">— 选择场次 —</option></select>
      <a class="btn pri" href="${s ? `/api/scripts/${s.id}/export` : '#'}" download>⬇ 下载离线播放包</a>
    </div></div>
    <p class="small muted">在线时与主持端同步；断网后显示“暂定阶段”，确认先存本机，重连自动补报。完全离线请直接打开下载的播放包 HTML。</p>
  </div><div id="fieldBody"></div>
  <div class="card"><h2>本机待上报的离线确认</h2><div id="queueBox"></div></div>`;
  $('#fScriptSel').onchange = (e) => { state.fieldScriptId = e.target.value; localStorage.setItem('fd.fieldScriptId', state.fieldScriptId); state.curRunId = null; state.st = null; rerender(false); };
  if (!s) { $('#fieldBody').innerHTML = '<div class="card muted">无脚本</div>'; return; }
  (async () => {
    const runs = await api('GET', `/api/scripts/${s.id}/runs`).catch(() => []);
    const sel = $('#fRunSel');
    runs.forEach((r) => { const o = document.createElement('option'); o.value = r.id; o.textContent = `${r.mode === 'clock' ? '时钟' : '主持'} · ${r.versionLabel} · ${r.status} · ${fmtTs(r.startedAt)}`; if (r.id === state.curRunId) o.selected = true; sel.appendChild(o); });
    sel.onchange = async () => { state.curRunId = sel.value || null; if (state.curRunId) localStorage.setItem('fd.runId', state.curRunId); else localStorage.removeItem('fd.runId'); state.st = null; try { await loadRun(true); } catch (e) { state.st = null; } rerender(false); };
    paintField();
  })();
  const qb = $('#queueBox');
  const q = offlineQueue();
  qb.innerHTML = q.length ? `<ul>${q.map((e) => `<li class="small">${fmtTs(e.observedAt)} ${h(e.userName)} 确认 ${h(e.stageKey)}/${h(e.gateId)} <span class="badge offline">待上报</span></li>`).join('')}</ul>`
    : '<span class="muted small">无</span>';
}
function paintField() {
  const box = $('#fieldBody');
  const online = navigator.onLine;
  const st = state.st && state.curRunId ? state.st : JSON.parse(localStorage.getItem('fd.cache.' + state.curRunId) || 'null');
  if (state.st && state.curRunId && online) localStorage.setItem('fd.cache.' + state.curRunId, JSON.stringify({ ...state.st, ts: Date.now() }));
  box.innerHTML = `<div id="fieldBanner"></div><div id="fieldContent"></div>`;
  const banner = $('#fieldBanner');
  const cacheRaw = JSON.parse(localStorage.getItem('fd.cache.' + state.curRunId) || 'null');
  const cacheTime = cacheRaw ? new Date(cacheRaw.ts).toLocaleString('zh-CN', { hour12: false }) : '无缓存';
  banner.innerHTML = online
    ? '<div class="banner ok small">🟢 在线：阶段与放行状态实时同步</div>'
    : `<div class="disc small">📵 断网：以下为<b>暂定阶段</b>（基于本机最近缓存：${h(cacheTime)}），可能已落后于现场。你的放行确认先存入本机，重连后自动上报；若届时阶段已推进，将被标记为“迟到确认”，事实保留但不回改状态。</div>`;
  if (!st) { $('#fieldContent').innerHTML = '<div class="card muted">请选择一个场次；或下载离线播放包完全离线使用。</div>'; return; }
  const cur = st.stages.find((x) => x.key === st.currentStageKey) || st.stages[0];
  const contentStages = st.content ? st.content.stages : [];
  $('#fieldContent').innerHTML = `
  <div class="card">
    <div class="banner safe small">🧯 消防演练中。本设备不控制任何真实设施；听到/看到的信号仅为排练呈现。</div>
    ${renderTimeline(st)}
    <h2>当前${online ? '' : '（暂定）'}阶段：${h(cur.name)}</h2>
    <div class="small muted">${st.mode === 'clock' ? '统一时钟模式：时间线到时自动滚动，但下面的放行仍只能人工确认。' : '主持人事件模式：阶段进入以主持人发令为准。'}</div>
    ${stageHtml(cur, st, 'field', online)}
    ${(st.reminders || []).map((rm) => `<div class="banner warn small">⏰ 超时提醒（仅提醒）</div>`).join('')}
    <h3>你的待确认项</h3>
    ${cur.gates.filter((g) => !g.passed && (g.authorizedRoleKey === state.identity.roleKey || state.identity.roleKey === 'commander')).length
      ? cur.gates.filter((g) => !g.passed && (g.authorizedRoleKey === state.identity.roleKey || state.identity.roleKey === 'commander')).map((g) => gateHtml(g, st, online, cur.key)).join('')
      : '<span class="muted small">当前阶段没有分配给你的待确认项</span>'}
  </div>`;
  $$('[data-pass]', box).forEach((b) => b.onclick = () => doPass(b.dataset.pass, false));
  $$('[data-audiomissing]', box).forEach((b) => b.onclick = async () => {
    if (!navigator.onLine) return toast('断网：请按现场口令执行，恢复后可在主持端补登记', 'warn');
    const [stageKey, resId, urlEnc] = b.dataset.audiomissing.split('|');
    await api('POST', `/api/runs/${state.curRunId}/audio-missing`, { stageKey, resourceId: resId, url: decodeURIComponent(urlEnc), userName: state.identity.userName });
    await loadRun(true); rerender(false);
  });
}

/* ================= 台账 ================= */
function renderLedger(v) {
  const s = state.scripts.find((x) => x.id === state.curScriptId);
  v.innerHTML = `<div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">执行台账（只追加事实）</h2>
    <div class="row"><select id="lScriptSel">${state.scripts.map((x) => `<option value="${x.id}" ${s && x.id === s.id ? 'selected' : ''}>${h(x.name)}</option>`).join('')}</select>
    <select id="lRunSel"></select></div></div></div><div id="ledgerBody"></div>`;
  $('#lScriptSel').onchange = (e) => { state.curScriptId = e.target.value; localStorage.setItem('fd.scriptId', state.curScriptId); rerender(false); };
  if (!s) return;
  (async () => {
    const runs = await api('GET', `/api/scripts/${s.id}/runs`);
    const sel = $('#lRunSel');
    runs.forEach((r) => { const o = document.createElement('option'); o.value = r.id; o.textContent = `${r.mode === 'clock' ? '时钟' : '主持'} · v${String(r.versionLabel).replace('v','')} · ${r.status} · ${fmtTs(r.startedAt)}`; if (r.id === state.curRunId) o.selected = true; sel.appendChild(o); });
    if (!state.curRunId && runs[0]) { state.curRunId = runs[0].id; }
    sel.onchange = async () => { state.curRunId = sel.value; await loadRun(true); rerender(false); };
    if (state.curRunId) await loadRun(true).catch(() => {});
    paintLedger(s);
  })();
}
function paintLedger(s) {
  const box = $('#ledgerBody');
  if (!state.st) { box.innerHTML = '<div class="card muted">暂无场次</div>'; return; }
  const st = state.st;
  const passes = st.events.filter((e) => e.type === 'gate.pass');
  const pending = [];
  st.stages.forEach((sg) => sg.gates.filter((g) => !g.passed).forEach((g) => pending.push({ stage: sg, gate: g })));
  const plannedRev = s.versions.find((x) => x.status === 'draft') || s.versions.find((x) => x.status === 'in_review');
  const typeLabel = { 'run.start': '场次开始', 'stage.enter': '进入阶段', 'gate.pass': '人工放行', 'pause': '暂停', 'resume': '恢复', 'note': '备注',
    'host.claim': '获取推进权', 'host.takeover': '★接管推进权', 'host.heartbeat': '心跳', 'run.end': '结束场次',
    'switch.plan': '计划版本切换', 'switch.apply': '版本切换生效', 'switch.cancel': '取消切换', 'audio.missing': '提示音缺失登记',
    'timeout.reminder': '超时提醒', 'confirm.offline.import': '离线导入' };
  box.innerHTML = `
  <div class="grid2">
    <div class="card"><h2>✅ 已执行（事实，不可删除/撤销）</h2>
      <table><thead><tr><th>时间</th><th>阶段/条件</th><th>确认人</th><th>标记</th></tr></thead><tbody>
      ${passes.map((e) => `<tr><td class="small">${fmtTs(e.ts)}${e.data.observedAt ? '<br><span class="muted">实际观察:' + fmtTs(e.data.observedAt) + '</span>' : ''}</td>
        <td class="small">${h(e.data.stageKey)}<br>${h(e.data.gateId)}</td><td>${h(e.data.by)}<br><span class="muted small">${h(roleName(st, e.data.roleKey))}</span></td>
        <td>${e.data.late ? '<span class="badge late">迟到</span>' : ''}${e.data.offline ? '<span class="badge offline">离线</span>' : ''}${e.data.force ? '<span class="badge draft">代行</span>' : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">暂无</td></tr>'}
      </tbody></table>
      <h3>其他事实事件</h3>
      <table class="small"><thead><tr><th>时间</th><th>事件</th><th>内容</th></tr></thead><tbody>
      ${st.events.filter((e) => e.type !== 'gate.pass' && e.type !== 'host.heartbeat').map((e) => `<tr><td class="small">${fmtTs(e.ts)}</td><td>${typeLabel[e.type] || e.type}</td><td class="small">${h((e.data && (e.data.reason || e.data.text || e.data.stageKey || e.data.toVersionId || e.data.by)) || '')}</td></tr>`).join('')}
      </tbody></table></div>
    <div>
      <div class="card"><h2>⏳ 待确认</h2>
        ${pending.length ? `<ul>${pending.map((p) => `<li>${h(p.stage.name)}：${h(p.gate.label)} <span class="small muted">（责任人 ${h(roleName(st, p.gate.authorizedRoleKey))}）</span></li>`).join('')}</ul>` : '<div class="banner ok small">全部放行条件均已确认</div>'}
        ${st.status === 'ended' && pending.length ? '<div class="banner err small">场次已结束但仍有待确认项：如离线设备迟到导入，将保留事实并标“迟到”，不回改本场状态。</div>' : ''}
      </div>
      <div class="card"><h2>📝 计划修订（尚未生效）</h2>
        ${plannedRev ? `<p>存在 <span class="badge ${plannedRev.status}">${{ draft: '草案', in_review: '待审核', approved: '已批准' }[plannedRev.status]}</span> 版本 v${plannedRev.version}：${h(plannedRev.note)}</p>
        <p class="small muted">只能在批准的切换点（${h((st.switchPoints || []).join('、') || '无')}）对后续阶段生效；已执行记录不会被改写。可到「审核版本」对比差异。</p>`
        : '<span class="muted small">当前没有未生效的修订</span>'}
        <h3>提示音缺失登记</h3>${st.audioMissing.length ? st.audioMissing.map((a) => `<div class="banner warn small">${fmtTs(a.acknowledgedAt)} ${h(a.stageKey)} / ${h(a.resourceId)} — ${h(a.by)} 已确认改用人工手段</div>`).join('') : '<span class="muted small">无</span>'}
      </div>
    </div>
  </div>`;
}

/* ================= 帮助/验收说明 ================= */
function renderHelp(v) {
  v.innerHTML = `
  <div class="card"><h2>验收演练路径（建议顺序）</h2>
  <ol>
    <li><b>报警→疏散→集合→复盘</b>：在「主持端」用“模式 A（主持人事件）”开始示例脚本 v1；按顺序人工放行各阶段条件。注意疏散阶段明确提示：<b>视频播放结束不等于疏散完成</b>，必须两名引导员各自确认。</li>
    <li><b>两种推进模式对比</b>：再开一场“模式 B（统一时钟）”，观察时间线到时自动进入下一阶段，但 gate 仍全部待人工确认，阶段不会自动完成。</li>
    <li><b>暂停与人工放行</b>：主持端点“暂停”，现场确认被挂起；必须主持人“人工放行恢复”。</li>
    <li><b>主持端崩溃</b>：主持人点“💥 模拟崩溃”（本端心跳停止）；用另一个身份（右上角切换）尝试获取推进权 → 先收到 409 拒绝；等约 15 秒心跳超时后出现“接管”按钮，接管事件写入台账。也可用 <code>HOST_STALE_MS=3000 npm start</code> 缩短等待。</li>
    <li><b>两人争用推进权限</b>：A 持有推进权时 B 点击获取，被明确拒绝且不发生双控。</li>
    <li><b>离线确认迟到</b>：现场页（浏览器 DevTools 切 Offline 或直接断网）会显示“暂定阶段”横幅和缓存时间；执行一项放行 → 进入本机待上报队列；把主持端推进到下一阶段后再联网，队列自动同步，台账中该条带“离线/迟到”标记，事实保留但不回改阶段。也可以用下载的离线播放包生成确认文件再导入。</li>
    <li><b>提示音缺失</b>：疏散阶段引用了一个不存在的视频资源（报警阶段的提示音 /assets/alert.wav 正常）。点击“播放不到/缺失，登记”，出现持续警示与台账记录，系统只提示改用人工口令，不自动替代。</li>
    <li><b>新版本改变责任人</b>：「审核版本」页对比 v1 → v2（草案），可见二层疏散 gate/动作责任人从 floor2 变为 muster、新增观摩记录员；批准 v2 后在运行中的场次用“计划在切换点切换”，只有跨过批准切换点（s_alarm / s_muster）才生效；已执行阶段保持 v1 事实。</li>
    <li><b>已执行 / 待确认 / 计划修订差异</b>：「台账」页同时呈现三类信息。撤销编排（删除草案）不影响任何执行记录。</li>
    <li><b>导出</b>：审核页下载播放包 HTML（alert.wav 内嵌、无效外链进入人工核对）与 manifest.json（含资源依赖、嵌入状态与全部人工核对项）。</li>
    <li><b>超时</b>：示例阶段设置了 timeoutSec；超时后只出现脉冲提醒条，不产生任何自动推进或放行。</li>
  </ol></div>
  <div class="card"><h2>安全边界（产品红线）</h2>
  <ul>
    <li>本工具只做演练的组织、排练与内容呈现，<b>不连接、不控制任何真实火灾报警、喷淋、排烟、应急广播等设施</b>。</li>
    <li>时间线/视频/音频进度不是完成判据；完成 = 被授权责任人的人工放行确认。</li>
    <li>超时只触发预设提醒；任何强制推进/代行放行都要求填写理由并永久留痕。</li>
    <li>事件日志只追加：编辑、撤销、删草案都不会删除执行事实。</li>
  </ul></div>
  <div class="card"><h2>数据与运行</h2>
  <p class="small muted">后端数据持久化在 <code>data/db.json</code>（原子写入）。删除该文件并重启会重新生成示例脚本。主持端心跳阈值默认 15 秒，可用环境变量调整。</p></div>`;
}

init();
