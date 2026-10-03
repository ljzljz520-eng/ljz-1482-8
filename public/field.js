import { api, $, esc, clientId, getIdentity, setIdentity, mmss, time,
  bindConnectivity, loadQueue, saveQueue, queueConfirm, flushQueue, toast } from '/app.js';

let RUN_ID = new URLSearchParams(location.search).get('run');
let view = null, roles = [], queue = loadQueue();
let simulatedOffline = localStorage.getItem('fdr_sim_offline') === '1';
$('#simOffline').checked = simulatedOffline;

const isOn = () => navigator.onLine && !simulatedOffline;

async function init() {
  const { roles: rs } = await api('/api/roles');
  roles = rs;
  $('#pRole').innerHTML = roles.map(r => `<option value="${r.id}">${esc(r.name)}（${esc(r.owner || '')}）</option>`).join('');
  const idn = getIdentity();
  if (idn) { $('#pName').value = idn.name; $('#pRole').value = idn.roleId || ''; }
  $('#saveMe').onclick = () => {
    setIdentity({ name: $('#pName').value.trim() || '未署名', roleId: $('#pRole').value });
    toast('身份已保存', 'green'); paint();
  };
  $('#pRole').onchange = () => { if ($('#pName').value) $('#saveMe').click(); };
  $('#simOffline').onchange = () => {
    simulatedOffline = $('#simOffline').checked;
    localStorage.setItem('fdr_sim_offline', simulatedOffline ? '1' : '0');
    updateNet(); refresh();
  };

  const { runs } = await api('/api/runs');
  $('#runSelect').innerHTML = runs.map(r => `<option value="${r.id}" ${r.id === RUN_ID ? 'selected' : ''}>
    ${esc(r.name)} [${{ created: '未开始', running: '进行中', paused: '暂停', completed: '结束', cancelled: '作废' }[r.status]}]</option>`).join('');
  $('#runSelect').onchange = () => { RUN_ID = $('#runSelect').value; history.replaceState(null, '', '?run=' + RUN_ID); queue = loadQueue(); refresh(); };
  if (!RUN_ID && runs[0]) { RUN_ID = runs[0].id; history.replaceState(null, '', '?run=' + RUN_ID); }

  updateNet();
  await refresh();
  setInterval(refresh, 5000);
  setInterval(() => { queue = loadQueue(); $('#queueInfo').textContent = `离线队列 ${queue.length} 条`; }, 1000);
}

function updateNet() {
  const on = isOn();
  $('#net').innerHTML = `<span class="offline-dot ${on ? 'on' : 'off'}"></span>${on ? '在线' : '离线（暂定视图+本地排队）'} · ${esc(clientId.slice(0, 10))}`;
  $('#offBanner').classList.toggle('hidden', on);
}
bindConnectivity(() => {
  updateNet();
  if (isOn()) flushQueue((item, out, err) => {
    if (err) toast('重复的离线确认已去重', 'amber');
    else if (out?.late) toast(`「${out.event.detail.title}」离线确认已上传（迟到，已作为事实保留）`, 'amber');
    else toast(`「${out.event.detail.title}」离线确认已同步`, 'green');
  }).then(refresh);
});

async function refresh() {
  if (!RUN_ID) { $('#content').innerHTML = '<div class="card">暂无排练场次。</div>'; return; }
  try {
    if (!isOn()) throw new Error('offline');
    const { run } = await api(`/api/runs/${RUN_ID}`);
    view = run;
    localStorage.setItem('fdr_field_cache_' + RUN_ID, JSON.stringify(run));
    paint();
  } catch {
    try { view = JSON.parse(localStorage.getItem('fdr_field_cache_' + RUN_ID) || 'null'); } catch { view = null; }
    paint(true);
  }
}

function doConfirm(stepId) {
  const idn = getIdentity();
  if (!idn?.name) return toast('请先填写姓名并保存身份', 'red');
  const note = prompt('确认备注（可选，如：一区 32 人全部撤离）') ?? '';
  const payload = { stepId, by: idn.name, roleId: idn.roleId, clientId, note };
  if (!isOn()) {
    queueConfirm(RUN_ID, payload);
    queue = loadQueue();
    toast('已离线排队，将在重连后上传（即使迟到也保留为事实）', 'amber');
    paint(true);
    return;
  }
  api(`/api/runs/${RUN_ID}/confirm`, { method: 'POST', body: payload }).then(out => {
    if (out.late) toast('确认已记录，但属于迟到确认（已标记）', 'amber');
    else toast('确认成功', 'green');
    refresh();
  }).catch(e => {
    if (e.status === 409 && e.code === 'already_confirmed') toast('该步骤已有确认（事实不可覆盖）', 'amber');
    else toast(e.message, 'red');
  });
}

function paint(stale = false) {
  updateNet();
  queue = loadQueue();
  $('#queueInfo').textContent = `离线队列 ${queue.length} 条`;
  const idn = getIdentity();
  if (!view) { $('#content').innerHTML = '<div class="card">断网且本机无缓存——请在联网时打开过本场排练后再离线使用。</div>'; return; }

  const myQueued = new Set(queue.filter(q => q.runId === RUN_ID).map(q => q.payload.stepId));
  const rows = view.phases.map(p => {
    const mySteps = p.steps.filter(s => idn?.roleId && s.roleId === idn.roleId);
    const stLabel = { pending: '暂定', active: '进行中', completed: '已完成' }[p.status];
    return `<div class="phase kind-${p.kind} ${p.status}">
      <header><h2>${p.kind === 'alarm' ? '🚨' : p.kind === 'evacuation' ? '🏃' : p.kind === 'assembly' ? '🧺' : '📝'} ${esc(p.name)}</h2>
        <span class="pill ${p.status === 'active' ? 'due' : p.status === 'completed' ? 'confirmed' : 'tentative'}">${stLabel}</span>
        ${p.status === 'pending' ? '<span class="muted">（未放行：条件满足前为暂定，断网时状态不再变化）</span>' : ''}
      </header>
      <div class="banner ${p.conditionMet ? 'gray' : 'amber'}" style="margin:0;border-radius:0;border-width:1px 0">
        进入条件：${p.conditionMet ? '已满足' : '<b>未满足</b>'} · ${esc(p.condition?.note || '')}
        ${p.conditionMissing.length ? `<div class="muted">等待：${p.conditionMissing.map(m => esc(m.title)).join('、')}</div>` : ''}
      </div>
      ${mySteps.length ? `<table><tbody>${mySteps.map(s => myStepRow(s, myQueued, stale)).join('')}</tbody></table>`
        : '<div class="muted" style="padding:10px 16px">本阶段无分配给你角色的步骤。</div>'}
      <details style="padding:8px 16px"><summary class="muted">查看本阶段全部步骤（${p.steps.length}）</summary>
        <table><tbody>${p.steps.map(s => otherStepRow(s)).join('')}</tbody></table></details>
    </div>`;
  }).join('');

  $('#content').innerHTML = (stale ? `<div class="banner gray">📴 以下为断网前缓存（${time(view.now)}），
      后续阶段为暂定；你的确认已本地排队。</div>` : '') +
    `<div class="card row"><b>${esc(view.scriptName)} · v${view.version.version}</b>
      <span class="tag ${view.status}">${{ created: '未开始', running: '进行中', paused: '已暂停', completed: '已结束' }[view.status]}</span>
      <span class="muted">${view.mode === 'clock' ? '统一时钟' : '主持人事件'} · 排练时钟 ${mmss(view.clock.sec)}</span>
      <span class="spacer" style="flex:1"></span>
      ${view.host ? `<span class="muted">主持人：${esc(view.host.name)}</span>` : '<span class="pill overdue">主持人离线</span>'}
    </div>` + rows;

  $$('[data-confirm]').forEach(b => b.onclick = () => doConfirm(b.dataset.confirm));
}

function myStepRow(s, queued, stale) {
  const done = s.status === 'confirmed';
  const f = s.fact;
  const q = queued.has(s.id);
  return `<tr class="${s.status}">
    <td style="width:70px" class="mono">${mmss(s.tSec)}</td>
    <td>${s.kind === 'gate' ? '<span class="pill gate">🚦 放行门（确认事实）</span> ' : ''}<b>${esc(s.title)}</b>
      <div class="detail">${esc(s.detail || '')}</div>
      ${(s.manualChecks || []).length ? `<ul class="checks">${s.manualChecks.map(c => `<li>☐ ${esc(c)}</li>`).join('')}</ul>` : ''}
      ${s.status === 'overdue' ? '<span class="pill overdue">⏰ 超时预设提醒——请现场负责人判断，系统不自动处理</span>' : ''}
    </td>
    <td style="width:170px;text-align:right">
      ${done ? `<span class="pill confirmed">${f?.offline ? '已确认(离线)' : f?.late ? '已确认(迟到)' : '已确认'}</span>
        <div class="muted">${esc(f.by)} · ${time(f.confirmedAt)}</div>`
        : q ? '<span class="pill overdue">⏳ 已排队待上传</span>'
        : s.kind === 'gate'
          ? `<div><button data-confirm="${s.id}" class="warn">记录：门控事实已核实</button>
             <div class="muted" style="font-size:11px">放行阶段仍需在线主持人操作</div></div>`
          : `<button data-confirm="${s.id}" class="green">✓ 确认完成</button>`}
    </td></tr>`;
}
function otherStepRow(s) {
  return `<tr><td style="width:70px" class="mono">${mmss(s.tSec)}</td>
    <td>${s.kind === 'gate' ? '<span class="pill gate">门</span> ' : ''}${esc(s.title)}</td>
    <td class="muted" style="width:140px">${esc(s.roleName)}</td>
    <td style="width:110px"><span class="pill ${s.status === 'confirmed' ? 'confirmed' : s.status === 'overdue' ? 'overdue' : s.status === 'due' ? 'due' : 'pending'}">
      ${{ confirmed: '已确认', overdue: '超时', due: '待确认', pending: '未到点' }[s.status]}</span></td></tr>`;
}

init();
