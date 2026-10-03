import { api, $, $$, esc, clientId, getIdentity, setIdentity, mmss, datetime, time,
  online as isOnline, bindConnectivity, loadQueue, flushQueue, toast } from '/app.js';

let RUN_ID = new URLSearchParams(location.search).get('run');
let view = null;      // 服务端实时视图
let roles = [];
let versions = [];    // 当前脚本版本列表
let lastOkAt = 0;
let cacheKey = null;
let tickerInt = null;
let onlineNow = navigator.onLine;

// ---------- 身份 ----------
async function ensureIdentity() {
  let idn = getIdentity();
  const { roles: rs } = await api('/api/roles'); roles = rs;
  $('#hostRole').innerHTML = roles.map(r => `<option value="${r.id}">${esc(r.name)}（${esc(r.owner || '')}）</option>`).join('');
  if (idn) { $('#hostName').value = idn.name; $('#hostRole').value = idn.roleId || roles[1]?.id || ''; }
  $('#saveIdentity').onclick = () => {
    setIdentity({ name: $('#hostName').value.trim() || '未署名', roleId: $('#hostRole').value });
    toast('身份已保存', 'green');
  };
  if (!idn) $('#hostName').focus();
  return idn;
}

// ---------- 场次选择 ----------
async function loadRunSelect() {
  const { runs } = await api('/api/runs');
  const sel = $('#runSelect');
  sel.innerHTML = runs.map(r => `<option value="${r.id}" ${r.id === RUN_ID ? 'selected' : ''}>
    [${({ created: '未开始', running: '进行中', paused: '暂停', completed: '结束', cancelled: '作废' })[r.status]}]
    ${esc(r.name)}（${r.mode === 'clock' ? '统一时钟' : '主持人事件'}）</option>`).join('')
    || '<option value="">暂无场次，请到控制台开排</option>';
  sel.onchange = () => { RUN_ID = sel.value; location.search = '?run=' + RUN_ID; };
}

function meName() { return getIdentity()?.name || $('#hostName').value.trim() || '未署名'; }
function meRole() { return getIdentity()?.roleId || $('#hostRole').value; }

// ---------- 主持租约 ----------
async function claim(force = false) {
  try {
    await api(`/api/runs/${RUN_ID}/host`, { method: 'POST',
      body: { clientId, name: meName(), force } });
    toast(force ? '已强制接管推进权限（已记录）' : '已取得推进权限', 'green');
    await refresh();
  } catch (e) {
    if (e.status === 409 && e.code === 'host_contended') {
      const h = e.data.holder;
      if (confirm(`⚠ 推进权限已被【${h.name}】持有（设备 ${h.clientId.slice(0, 10)}，租约至 ${time(h.leaseUntil)}）。\n\n`
        + '两人不能同时推进。若确认对方已崩溃/失联，可“强制接管”；租约过期后接管不会影响其设备恢复时的识别。\n\n是否强制接管？')) {
        await claim(true);
      }
    } else toast('申领失败：' + e.message, 'red');
  }
}

async function postAction(path, body) {
  try {
    const d = await api(path, { method: 'POST', body: { clientId, by: meName(), roleId: meRole(), ...body } });
    if (d.late) toast('该确认已被服务端接收，但属于“迟到确认”（阶段已越过或排练已结束），已标记并保留为事实', 'amber');
    await refresh(); return d;
  } catch (e) {
    handleActionError(e);
  }
}

function handleActionError(e) {
  if (e.status === 423) toast('主持租约已失效（可能崩溃后被他人接管）——请点击“接管推进”', 'red');
  else if (e.status === 412) {
    const missing = (e.data.missing || []).map(x => x.title || x.stepId).join('、');
    toast(`阶段条件未满足，禁止放行。缺少确认：${missing}（时钟到点也不能替代）`, 'red');
  } else if (e.status === 409 && e.code === 'not_switch_point') toast(e.message, 'red');
  else toast(e.message || '操作失败', 'red');
}

// ---------- 渲染：控制条 ----------
function renderControl() {
  const r = view;
  $('#runTitle').textContent = `${r.scriptName} · v${r.version.version} · ${r.mode === 'clock' ? '统一时钟推进' : '主持人事件推进'}`;
  $('#modeLine').textContent = r.mode === 'clock'
    ? '统一时钟：时间线驱动到期/超时“提醒”，阶段仍需人工放行；人工确认项不自动完成'
    : '主持人事件：以放行/确认事件推进，计划时间仅作参照（超时仍产生提醒）';

  const host = r.host;
  const isHost = host?.clientId === clientId && r.hostLive;
  $('#hostBox').innerHTML = host
    ? `主持人：<b>${esc(host.name)}</b> <span class="tag ${r.hostLive ? 'running' : 'paused'}">${r.hostLive ? '租约有效' : '租约失效'}</span>
       <span class="muted">${esc(host.clientId.slice(0, 10))}</span>
       ${isHost ? '<button id="relHost" class="ghost">释放主持</button>' : '<button id="takeHost" class="warn">接管推进</button>'}`
    : '<button id="takeHost" class="green">申领推进权限</button>';
  $('#takeHost')?.addEventListener('click', () => claim(false));
  $('#relHost')?.addEventListener('click', () => postAction(`/api/runs/${RUN_ID}/release-host`, {}).then(() => refresh()));

  const st = r.status;
  const btns = [];
  if (st === 'created') btns.push('<button id="bStart" class="green">▶ 开始演练（自动放行首阶段）</button>');
  if (st === 'running') btns.push('<button id="bPause" class="warn">⏸ 暂停（保留时钟）</button>');
  if (st === 'paused') btns.push('<button id="bResume">▶ 继续</button>');
  if (st === 'running' || st === 'paused') btns.push('<button id="bComplete">■ 结束演练（复盘收尾）</button>');
  btns.push(`<span class="tag ${st}">${{ created: '未开始', running: '进行中', paused: '已暂停', completed: '已结束', cancelled: '已作废' }[st]}</span>`);
  if (r.status === 'paused') btns.push('<span class="pill overdue">已暂停：不放行、不计时、不确认（已排队的离线确认除外）</span>');
  $('#controlBtns').innerHTML = btns.join(' ');
  $('#bStart')?.addEventListener('click', () => postAction(`/api/runs/${RUN_ID}/start`, {}));
  $('#bPause')?.addEventListener('click', async () => {
    const reason = prompt('暂停原因（现场情况由负责人判断）') || '';
    if (reason !== null) postAction(`/api/runs/${RUN_ID}/pause`, { reason });
  });
  $('#bResume')?.addEventListener('click', () => postAction(`/api/runs/${RUN_ID}/resume`, {}));
  $('#bComplete')?.addEventListener('click', () => {
    if (confirm('结束演练？全部已确认事实与日志将保留用于复盘。')) postAction(`/api/runs/${RUN_ID}/complete`, {});
  });

  $('#hostHint').innerHTML = isHost
    ? '本设备持有推进权限；正在每 5 秒发送心跳，停止心跳 30 秒后租约失效（主持端崩溃场景）。'
    : '<b>本设备当前不是主持人</b>：可查看时间线与差异，放行/暂停等推进操作需先取得权限。';
}

// ---------- 渲染：时间线 ----------
function renderTimeline() {
  const r = view;
  const host = r.host;
  const isHost = host?.clientId === clientId && r.hostLive;
  const canAct = isHost && r.status === 'running';

  $('#reminders').innerHTML = r.reminders.length
    ? r.reminders.map(x => `<div class="reminder ${x.level}">
        <b>${x.kind === 'overdue' ? '⏰ ' : x.kind === 'phase_ready' ? '🚦 ' : '⛔ '}${esc(x.text)}</b>
        ${x.missing ? `<div class="muted">未满足依赖：${x.missing.map(m => esc(m.title)).join('、')}</div>` : ''}
        <div class="muted" style="font-size:11px">${time(x.firedAt)} 触发 · 预设提醒，仅通知，不自动执行</div>
      </div>`).join('')
    : (r.status === 'running' ? '<div class="muted" style="margin:6px 0">暂无到点/超时提醒</div>' : '');

  $('#phases').innerHTML = r.phases.map((p, pi) => {
    const stMap = { pending: '暂定', active: '进行中', completed: '已完成' };
    const stPill = { pending: 'tentative', active: 'due', completed: 'confirmed' }[p.status];
    const next = p.status === 'pending' && r.phases.slice(0, pi).every(q => q.status === 'completed');
    const releasedAt = p.releasedAt ? ` · 放行于 ${time(p.releasedAt)}（${esc(p.releasedBy || '')}）` : '';
    let releaseBtn = '';
    if (p.status === 'pending' && next && r.status === 'running') {
      releaseBtn = p.conditionMet
        ? `<button class="green" data-release="${p.id}" ${canAct ? '' : 'disabled'}>🚦 人工放行进入</button>`
        : `<button class="danger" disabled>条件未满足，禁止放行</button>`;
    }
    return `<div class="phase kind-${p.kind} ${p.status}">
      <header>
        <h2>${p.kind === 'alarm' ? '🚨' : p.kind === 'evacuation' ? '🏃' : p.kind === 'assembly' ? '🧺' : '📝'} ${esc(p.name)}</h2>
        <span class="pill ${stPill}">${stMap[p.status]}${releasedAt}</span>
        <span class="muted">计划 ${mmss(p.plannedStartSec)} 起 · ${p.plannedDurationSec}s</span>
        <span class="spacer" style="flex:1"></span>
        ${releaseBtn}
      </header>
      <div class="banner ${p.conditionMet ? 'gray' : 'amber'}" style="margin:0;border-radius:0;border-left:0;border-right:0">
        进入条件：${p.conditionMet ? '<span class="pill confirmed">已满足</span>' : '<span class="pill overdue">未满足</span>'}
        ${esc(p.condition?.note || '')}
        ${p.conditionMissing.length ? `<div class="muted">等待确认：${p.conditionMissing.map(m => esc(m.title)).join('、')}</div>` : ''}
        <div class="muted" style="font-size:11px">统一时钟到点仅产生提醒；阶段进入以<b>人工放行</b>为准。</div>
      </div>
      ${p.steps.map(s => stepRow(s, p, canAct, isHost, r)).join('')}
    </div>`;
  }).join('');

  $$('[data-release]').forEach(b => b.onclick = () => postAction(`/api/runs/${RUN_ID}/release-phase`, { phaseId: b.dataset.release }));
  $$('[data-confirm]').forEach(b => b.onclick = () => {
    // 主持端也可代录（演示验收），真实场景建议现场端责任人确认
    postAction(`/api/runs/${RUN_ID}/confirm`, { stepId: b.dataset.confirm, note: '主持端代录' });
  });
}

function stepRow(s, p, canAct, isHost, r) {
  const fact = s.fact;
  const statusText = s.status === 'confirmed'
    ? (fact?.late ? '已确认（迟到）' : fact?.offline ? '已确认（离线迟到）' : '已确认')
    : s.status === 'overdue' ? '超时未确认（提醒已发出）'
    : s.status === 'due' ? '已到点 · 待确认' : '未到点（暂定）';
  const pill = s.status === 'confirmed' ? 'confirmed' : s.status === 'overdue' ? 'overdue' : s.status === 'due' ? 'due' : 'pending';
  return `<div class="step ${s.status}">
    <span class="t">${mmss(s.tSec)}</span>
    <div>
      ${s.kind === 'gate' ? '<span class="pill gate">🚦 人工放行门</span> ' : ''}
      <b>${esc(s.title)}</b>
      <div class="detail">${esc(s.detail || '')}</div>
      <div class="checks">
        <span class="pill role">${esc(s.roleName)}</span>
        ${s.timeoutSec != null ? `<span class="muted"> · 超时阈值 ${s.timeoutSec}s（仅提醒）</span>` : ''}
        ${s.requiresConfirmation ? '<span class="muted"> · 需人工确认</span>' : '<span class="muted"> · 脚本预设无需确认（时间到自动标记）</span>'}
        ${fact ? `<div class="muted">确认人：${esc(fact.by)} · ${time(fact.confirmedAt)}${fact.note ? ' · ' + esc(fact.note) : ''}</div>` : ''}
        ${(s.manualChecks || []).length ? `<ul class="checks">${s.manualChecks.map(c => `<li>☐ ${esc(c)}</li>`).join('')}</ul>` : ''}
      </div>
    </div>
    <span class="pill ${pill}">${statusText}</span>
    <span>${s.status === 'confirmed' ? '' :
      (isHost && r.status === 'running' ? `<button class="ghost" data-confirm="${s.id}">主持代录确认</button>` :
      '<span class="muted">由现场责任人确认</span>')}</span>
  </div>`;
}

// ---------- 版本切换 ----------
async function renderVersions() {
  const sid = view.scriptId;
  const { script } = await api(`/api/scripts/${sid}`);
  versions = script.versions;
  const cur = versions.find(v => v.id === view.versionId);
  const box = $('#versionBox');
  box.classList.remove('muted');
  box.innerHTML = `
    <div>当前执行版本：<b>v${view.version.version}</b> <span class="tag ${view.version.status}">${view.version.status}</span></div>
    <div class="muted" style="margin:6px 0">${esc(view.version.note || '')}</div>
    <select id="switchSel">
      ${versions.map(v => `<option value="${v.id}" ${v.id === view.versionId ? 'disabled' : ''}>
        v${v.version} · ${({ draft: '草稿', submitted: '待审核', approved: '已批准' })[v.status]}${v.id === view.versionId ? '（当前）' : ''}</option>`).join('')}
    </select>
    <button id="switchBtn">在切换点生效新版本</button>
    <div class="banner amber" style="margin-top:8px;font-size:12px">
      新脚本<b>只能在批准的切换点</b>（下一阶段尚未放行的阶段门）生效；当前阶段进行中会被服务端拒绝。
      已执行事实保留，差异在右侧页签查看。
    </div>`;
  $('#switchBtn').onclick = async () => {
    const vid = $('#switchSel').value;
    const target = versions.find(v => v.id === vid);
    if (target.status !== 'approved') return toast('只有已批准版本才能生效；请先到编排页批准', 'red');
    try {
      await api(`/api/runs/${RUN_ID}/switch-version`, { method: 'POST', body: { clientId, versionId: vid } });
      toast('版本已在切换点生效', 'green'); await refresh(true);
    } catch (e) { handleActionError(e); }
  };
}

// ---------- 差异页 ----------
async function renderDiff() {
  const cmpSel = versions.filter(v => v.id !== view.versionId).map(v => v.id)[0] || '';
  const url = `/api/runs/${RUN_ID}/diff${cmpSel ? '?compareVersionId=' + cmpSel : ''}`;
  const { diff } = await api(url);
  const cmp = diff.compareVersion;
  $('#tab-diff').innerHTML = `
    <div class="card"><h2>对比计划修订
      <span class="muted">当前执行 v${diff.planVersion.version} → 对比 v${cmp.version}（${({draft:'草稿',submitted:'待审核',approved:'已批准'})[cmp.status]}）</span></h2>
      <div class="muted">三类差异分开呈现：现场已执行是事实（不会被撤销删除）、待确认项（含断网暂定）、计划修订（责任人/时间/增删）。</div>
    </div>
    <div class="grid3">
      <div class="card"><h2>✅ 已执行事实（${diff.executed.length}）</h2>
        <table>${diff.executed.map(f => `<tr>
          <td><b>${esc(f.title)}</b><div class="muted">${esc(f.phaseId)} · ${esc(f.roleNameAtExec)} · ${time(f.at)}</div>
          ${f.offline ? `<span class="pill overdue">离线确认</span>` : ''}${f.late ? '<span class="pill overdue">迟到</span>' : ''}
          ${f.gate ? '<span class="pill gate">放行门</span>' : ''}
          ${!f.knownToPlan ? '<div class="banner red" style="margin-top:4px;padding:4px 8px">该步骤在当前版本已被撤销编排，但执行记录作为事实保留</div>' : ''}
          </td></tr>`).join('') || '<tr><td class="muted">暂无</td></tr>'}</table>
        ${diff.factsWithoutPlan.length ? `<div class="banner red" style="margin-top:8px">有 ${diff.factsWithoutPlan.length}
          条事实对应步骤已不在新版本中——仅在计划里移除，<b>执行记录不可删除</b>。</div>` : ''}
      </div>
      <div class="card"><h2>🕓 待确认（${diff.pending.length}）</h2>
        <table>${diff.pending.map(p => `<tr><td>
          ${p.gate ? '<span class="pill gate">放行门</span> ' : ''}<b>${esc(p.title)}</b>
          <div class="muted">${esc(p.phaseName)} · ${mmss(p.tSec)} · ${esc(p.roleName)}</div>
          <span class="pill ${p.liveStatus}">${{ confirmed: '已确认', overdue: '超时', due: '待确认', pending: '未到点', tentative: '暂定（未放行/未到版本）' }[p.liveStatus] || p.liveStatus}</span>
        </td></tr>`).join('') || '<tr><td class="muted">全部确认完毕</td></tr>'}</table>
      </div>
      <div class="card"><h2>📝 计划修订（${diff.planChanges.length}）</h2>
        <table>${diff.planChanges.map(c => `<tr style="${c.executed ? 'background:var(--amber-bg)' : ''}"><td>
          <span class="diff-${c.kind}">${c.kind === 'added' ? '＋新增' : c.kind === 'removed' ? '－移除' : '改'}</span>
          <b>${esc(c.title)}</b> <span class="muted">${esc(c.phaseName)}</span>
          ${c.kind === 'modified' ? `<div>【${esc(c.field)}】<span class="diff-removed">${esc(c.from)}</span> → <span class="diff-added">${esc(c.to)}</span></div>` : ''}
          ${c.kind === 'removed' ? `<div class="muted">${esc(c.note || '')}</div>` : ''}
          ${c.executed ? '<div class="muted">⚠ 该步骤已有现场执行，修订仅影响后续计划，不追溯改写事实</div>' : ''}
        </td></tr>`).join('') || '<tr><td class="muted">两个版本无差异</td></tr>'}</table>
      </div>
    </div>`;
}

// ---------- 导出页 ----------
async function renderExport() {
  const sid = view.scriptId, vid = view.versionId;
  const { diff } = await api(`/api/runs/${RUN_ID}/diff`);
  $('#tab-export').innerHTML = `
    <div class="card">
      <h2>离线脚本包（现场浏览器下载后可断网播放）</h2>
      <div class="row">
        <a class="btn" href="/api/scripts/${sid}/export?versionId=${vid}&standalone=1">⬇ 单文件离线播放器 HTML（内嵌脚本）</a>
        <a class="btn ghost" href="/api/scripts/${sid}/export?versionId=${vid}">⬇ JSON 脚本包（清单）</a>
      </div>
      <div class="muted" style="margin-top:8px">播放器只做内容呈现与本地计时：阶段仍需现场人工放行，超时仅本地提醒；不回传、不控制设施。</div>
    </div>
    <div class="card">
      <h2>资源依赖（${diff.resources.length}）
        ${diff.missingResources.length ? `<span class="pill overdue">⚠ ${diff.missingResources.length} 项缺失，须人工替代</span>` : '<span class="pill confirmed">齐备</span>'}</h2>
      <table><thead><tr><th>资源</th><th>状态</th><th>备注</th><th>用于步骤</th></tr></thead>
        <tbody>${diff.resources.map(r => `<tr style="${r.present ? '' : 'background:var(--red-bg)'}">
          <td>${esc(r.name)}</td>
          <td>${r.present ? '<span class="pill confirmed">已就绪</span>' : '<span class="pill overdue">缺失</span>'}</td>
          <td class="muted">${esc(r.note || '')}</td><td class="muted">${esc((r.usedBy || []).join('、'))}</td></tr>`).join('')}</tbody></table>
    </div>
    <div class="card">
      <h2>人工核对项（${diff.manualChecks.length}）</h2>
      <table><thead><tr><th></th><th>阶段</th><th>步骤</th><th>核对内容</th></tr></thead><tbody>
      ${diff.manualChecks.map(c => `<tr><td>${c.done ? '✅' : '☐'}</td><td>${esc(c.phaseName)}</td>
        <td>${c.gate ? '<span class="pill gate">门</span> ' : ''}${esc(c.title)}</td><td>${esc(c.check)}</td></tr>`).join('')}
      </tbody></table>
    </div>`;
}

// ---------- 事件日志 ----------
function renderLog() {
  const labels = {
    run_created: '创建场次', host_claimed: '取得主持权限', host_taken_over: '强制接管主持',
    host_expired: '主持租约过期', host_released: '释放主持', run_started: '开始演练',
    run_paused: '暂停', run_resumed: '继续', run_completed: '结束演练', run_cancelled: '作废',
    phase_released: '人工放行阶段', step_confirmed: '确认步骤', version_switched: '版本在切换点生效',
  };
  $('#eventLog').innerHTML = [...view.events].reverse().map(e => `
    <div class="ev"><span class="at mono">${time(e.at)}</span>
      <b>${labels[e.type] || e.type}</b> <span class="muted">${esc(e.by || '')}${e.clientId ? ' · ' + esc(e.clientId.slice(0, 8)) : ''}</span>
      ${e.offline ? '<span class="pill overdue">离线</span>' : ''}${e.late ? '<span class="pill overdue">迟到</span>' : ''}
      <div class="muted">${esc(formatDetail(e))}</div>
    </div>`).join('');
}
function formatDetail(e) {
  const d = e.detail || {};
  switch (e.type) {
    case 'phase_released': return `${d.phaseName || d.phaseId}${d.automatic ? '（' + d.automatic + '）' : ''}`;
    case 'step_confirmed': return `${d.title}（${d.roleName || ''}）${d.note ? ' · ' + d.note : ''}${d.auto ? ' · 预设无需确认自动标记' : ''}`;
    case 'run_paused': return d.reason || '';
    case 'version_switched': return `v${d.fromVersion} → v${d.toVersion} @ ${d.switchPoint}`;
    case 'host_taken_over': return `${d.from} → ${e.by}`;
    default: return d.note || '';
  }
}

// ---------- 刷新 / 离线 ----------
function renderCacheOffline() {
  $('#staleBanner').classList.remove('hidden');
  const cached = cachedView();
  if (cached) {
    view = cached;
    renderControl(); renderTimeline(); renderLog();
    $('#clock').textContent = mmss(view.clock.sec);
  }
}

const CACHE = 'fdr_host_cache_';
function saveCache(v) { try { localStorage.setItem(CACHE + RUN_ID, JSON.stringify(v)); } catch {} }
function cachedView() { try { return JSON.parse(localStorage.getItem(CACHE + RUN_ID) || 'null'); } catch { return null; } }

async function refresh(hard = false) {
  if (!RUN_ID) return;
  try {
    const d = await api(`/api/runs/${RUN_ID}`);
    view = d.run; lastOkAt = Date.now(); onlineNow = true;
    saveCache(view);
    $('#staleBanner').classList.add('hidden'); $('#offlineBanner').classList.add('hidden');
    paint();
    if (hard) await renderVersions();
  } catch (e) {
    if (!navigator.onLine || e.message.includes('Failed to fetch')) {
      onlineNow = false;
      $('#offlineBanner').classList.remove('hidden');
      $('#offlineBanner').innerHTML = '📴 当前设备<b>断网</b>：可查看已缓存的<b>暂定</b>阶段状态；主持推进/放行/确认全部禁用。'
        + '离线期间的现场确认由“现场确认端”本地排队，重连后自动上传（迟到确认仍保留）。'
        + ` 本地待上传：${loadQueue().length} 条。`;
      renderCacheOffline();
    } else toast(e.message, 'red');
  }
}

function paint() {
  $('#clock').textContent = mmss(view.clock.sec);
  renderControl(); renderTimeline(); renderLog();
  if ($('#tab-diff').classList.contains('hidden') === false) renderDiff();
  if ($('#tab-export').classList.contains('hidden') === false) renderExport();
}

// ---------- 心跳与轮询 ----------
function startTicker() {
  clearInterval(tickerInt);
  tickerInt = setInterval(async () => {
    if (!RUN_ID || !onlineNow) return;
    const idn = getIdentity();
    if (view?.host?.clientId === clientId && view?.hostLive) {
      try {
        await api(`/api/runs/${RUN_ID}/heartbeat`, { method: 'POST', body: { clientId } });
      } catch (e) {
        if (e.status === 423) toast('心跳被拒：推进权限已被其他设备接管', 'red');
      }
    }
    // 重连后先冲离线队列
    if (loadQueue().length) await flushQueue(() => {});
    await refresh();
  }, 5000);
  setInterval(() => { if (view && onlineNow) $('#clock').textContent = mmss(view.clock.sec + (view.status === 'running' ? Math.floor((Date.now() - Date.parse(view.now)) / 1000) : 0)); }, 500);
}

// tabs
$$('.tabs button').forEach(b => b.onclick = () => {
  $$('.tabs button').forEach(x => x.classList.remove('active')); b.classList.add('active');
  ['timeline', 'diff', 'export'].forEach(t => $('#tab-' + t).classList.toggle('hidden', t !== b.dataset.tab));
  if (b.dataset.tab === 'diff') renderDiff();
  if (b.dataset.tab === 'export') renderExport();
});

bindConnectivity((on) => {
  $('#net').innerHTML = `<span class="offline-dot ${on ? 'on' : 'off'}"></span>${on ? '在线' : '离线'} · 设备 ${esc(clientId.slice(0, 10))}`;
  if (on) { flushQueue((item, out, err) => {
    if (err) toast('一条离线确认此前已存在，已去重', 'amber');
    else if (out?.late) toast('离线确认已上传（迟到，已标记保留）', 'amber');
    else toast('离线确认已同步', 'green');
  }).then(refresh); }
});

(async function main() {
  await ensureIdentity();
  await loadRunSelect();
  if (!RUN_ID) { $('#phases').innerHTML = '<div class="card muted">请在上方选择场次，或到控制台开排。</div>'; return; }
  $('#fieldLink').href = '/field.html?run=' + RUN_ID;
  await refresh(true);
  startTicker();
})();
