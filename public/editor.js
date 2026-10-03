import { api, $, esc, clientId, getIdentity, datetime, toast } from '/app.js';

const params = new URLSearchParams(location.search);
let SCRIPT_ID = params.get('script');
let VERSION_ID = params.get('version');
let ctx = null; // {script, version, roles, resources}

$('#who').textContent = (getIdentity()?.name || '未署名') + ' · ' + clientId.slice(0, 8);

async function loadScriptList() {
  const { scripts } = await api('/api/scripts');
  $('#scriptList').innerHTML = scripts.map(s =>
    `<div class="row" style="padding:6px 0;${s.id === SCRIPT_ID ? 'font-weight:700' : ''}">
      <a href="?script=${s.id}">${esc(s.name)}</a>${s.archived ? ' <span class="muted">(已归档)</span>' : ''}
    </div>`).join('') || '<span class="muted">无</span>';
  if (!SCRIPT_ID && scripts[0]) { SCRIPT_ID = scripts[0].id; }
  return scripts;
}

async function loadVersionList(scripts) {
  if (!SCRIPT_ID) { $('#versionList').innerHTML = ''; return; }
  const data = await api('/api/scripts/' + SCRIPT_ID);
  $('#versionList').innerHTML = data.script.versions.map(v => `
    <div class="row" style="padding:5px 0">
      <a href="?script=${SCRIPT_ID}&version=${v.id}" style="${v.id === VERSION_ID ? 'font-weight:700' : ''}">v${v.version}</a>
      <span class="tag ${v.status}">${({ draft: '草稿', submitted: '待审核', approved: '已批准' })[v.status]}</span>
    </div>
    ${v.id === VERSION_ID ? `<div class="muted" style="padding-left:8px">${esc(v.note || '')}</div>` : ''}
  `).join('');
  if (!VERSION_ID && data.script.versions.length) {
    const latest = [...data.script.versions].sort((a, b) => b.version - a.version)[0];
    VERSION_ID = latest.id; location.search = `?script=${SCRIPT_ID}&version=${VERSION_ID}`; return;
  }
  return data;
}

async function load() {
  const scripts = await loadScriptList();
  if (!SCRIPT_ID) { $('#verHead').innerHTML = '<span class="muted">请选择或新建脚本</span>'; $('#editor').innerHTML = ''; return; }
  const data = await loadVersionList(scripts);
  if (!data) return;
  ctx = data;
  const v = data.version;
  renderHead(v);
  renderEditor(v, data.roles, data.resources);
  renderActions(v);
}

function renderHead(v) {
  $('#verHead').innerHTML = `
    <h2 style="margin:0">${esc(ctx.script.name)} · v${v.version}
      <span class="tag ${v.status}">${({ draft: '草稿', submitted: '待审核', approved: '已批准（不可变）' })[v.status]}</span>
    </h2>
    <span class="spacer" style="flex:1"></span>
    <span class="kv">创建 ${datetime(v.createdAt)}${v.approvedAt ? ` · 批准 ${datetime(v.approvedAt)} · ${esc(v.approvedBy || '')}` : ''}${v.submittedAt ? ` · 提交 ${datetime(v.submittedAt)}` : ''}</span>`;
}

function roleOptions(selected) {
  return ctx.roles.map(r => `<option value="${r.id}" ${r.id === selected ? 'selected' : ''}>${esc(r.name)}（${esc(r.owner || '')}）</option>`).join('');
}
function resName(id) { return ctx.resources.find(r => r.id === id)?.name || '?'; }

function renderEditor(v, roles, resources) {
  const locked = v.status !== 'draft';
  $('#verLock').innerHTML = locked
    ? `<div class="banner amber" style="margin-top:10px">🔒 该版本为“${{ submitted: '待审核', approved: '已批准' }[v.status]}”，不可编辑。
        ${v.status === 'approved' ? '基于它“新建修订草稿”即可编排 v' + (v.version + 1) + '。' : '可驳回回草稿或等待批准。'}</div>`
    : `<div class="banner gray" style="margin-top:10px">草稿可自由修改。保存时校验步骤依赖与切换点合法性。
        <b>人工放行门(gate)</b>与<b>需人工确认</b>步骤在现场必须由责任人确认，系统绝不自动完成。
        “超时(秒)”仅用于现场产生预设提醒。</div>`;

  const allStepIds = v.phases.flatMap(p => p.steps.map(s => s.id));
  $('#editor').innerHTML = v.phases.map((p, pi) => `
    <div class="card">
      <h2>${p.kind === 'alarm' ? '🚨' : p.kind === 'evacuation' ? '🏃' : p.kind === 'assembly' ? '🧺' : '📝'}
        ${locked ? esc(p.name) : `<input value="${esc(p.name)}" data-k="name" data-pi="${pi}">`}
        <span class="muted">${({ alarm: '报警阶段', evacuation: '疏散阶段', assembly: '集合阶段', review: '复盘阶段' })[p.kind]}</span>
        <span class="pill gate">切换点</span>
      </h2>
      <div class="row muted" style="font-size:12px">
        计划开始 <input type="number" value="${p.plannedStartSec}" data-k="plannedStartSec" data-pi="${pi}" ${locked ? 'disabled' : ''}>s
        时长 <input type="number" value="${p.plannedDurationSec}" data-k="plannedStartSec" disabled class="hidden">
        计划时长 <input type="number" value="${p.plannedDurationSec}" data-k="plannedDurationSec" data-pi="${pi}" ${locked ? 'disabled' : ''}>s
      </div>
      <div class="banner blue" style="margin-top:8px">
        🚦 阶段条件：进入本阶段要求
        <label><input type="checkbox" data-k="gate" data-pi="${pi}" ${p.condition.requireGate ? 'checked' : ''} ${locked ? 'disabled' : ''}>
        必须由主持人/负责人人工放行</label><br>
        <span class="muted">且以下步骤已确认（依赖）：</span>
        <div class="row" style="margin-top:6px">
          ${allStepIds.filter(sid => !p.steps.some(s => s.id === sid)).map(sid => {
            const loc = v.phases.flatMap(pp => pp.steps).find(s => s.id === sid);
            return `<label style="font-size:12px"><input type="checkbox" class="dep" data-pi="${pi}" value="${sid}"
              ${p.condition.requireConfirmedSteps.includes(sid) ? 'checked' : ''} ${locked ? 'disabled' : ''}>
              ${esc(loc.title)} <span class="muted">(${sid})</span></label>`;
          }).join('') || '<span class="muted">（无前序步骤）</span>'}
        </div>
        ${locked ? '' : `<input style="width:100%;margin-top:6px" data-k="condNote" data-pi="${pi}" value="${esc(p.condition.note || '')}" placeholder="条件说明，例如：须确认属演练性质">`}
      </div>
      <table style="margin-top:10px">
        <thead><tr><th style="width:60px">t(秒)</th><th style="width:80px">类型</th><th>内容</th><th style="width:150px">责任人</th>
          <th style="width:170px">确认/超时/资源</th><th style="width:60px"></th></tr></thead>
        <tbody>
        ${p.steps.map((s, si) => `
          <tr>
            <td><input type="number" value="${s.tSec}" data-pi="${pi}" data-si="${si}" data-k="tSec" ${locked ? 'disabled' : ''}></td>
            <td><select data-pi="${pi}" data-si="${si}" data-k="kind" ${locked ? 'disabled' : ''}>
              ${['gate', 'broadcast', 'instruction', 'check', 'review'].map(k =>
                `<option value="${k}" ${s.kind === k ? 'selected' : ''}>${({ gate: '放行门', broadcast: '广播', instruction: '指令', check: '清点核实', review: '复盘' })[k]}</option>`).join('')}
            </select></td>
            <td>
              ${locked ? `<b>${esc(s.title)}</b>${s.detail ? `<div class="muted">${esc(s.detail)}</div>` : ''}`
                : `<input style="width:100%" value="${esc(s.title)}" data-pi="${pi}" data-si="${si}" data-k="title"
                    placeholder="步骤标题"><br>
                   <textarea style="width:100%;margin-top:4px" rows="2" data-pi="${pi}" data-si="${si}" data-k="detail"
                    placeholder="详细说明（如：逐房间清点，视频到点不代表疏散完成）">${esc(s.detail || '')}</textarea>`}
            </td>
            <td><select data-pi="${pi}" data-si="${si}" data-k="roleId" ${locked ? 'disabled' : ''}>${roleOptions(s.roleId)}</select></td>
            <td style="font-size:12px">
              <label><input type="checkbox" data-pi="${pi}" data-si="${si}" data-k="req" ${s.requiresConfirmation ? 'checked' : ''} ${locked ? 'disabled' : ''}> 需人工确认</label><br>
              <label>超时 <input type="number" style="width:60px" value="${s.timeoutSec ?? ''}" data-pi="${pi}" data-si="${si}" data-k="timeoutSec" ${locked ? 'disabled' : ''}>s（仅提醒）</label><br>
              <details><summary>资源(${s.resources.length}) · 核对项(${s.manualChecks.length})</summary>
                <div class="checks">
                  ${resources.map(r => `<label><input type="checkbox" class="res" data-pi="${pi}" data-si="${si}" value="${r.id}"
                    ${s.resources.includes(r.id) ? 'checked' : ''} ${locked ? 'disabled' : ''}> ${esc(r.name)}${r.present ? '' : ' ⚠缺失'}</label>`).join('')}
                  <div class="muted">人工核对项（每行一条，导出包含）：</div>
                  ${locked ? (s.manualChecks || []).map(c => `<div>☐ ${esc(c)}</div>`).join('') :
                    `<textarea class="manual" rows="3" style="width:100%" data-pi="${pi}" data-si="${si}"
                      placeholder="每行一条人工核对项">${esc((s.manualChecks || []).join('\n'))}</textarea>`}
                </div>
              </details>
            </td>
            <td>${locked ? '' : `<button class="ghost delStep" data-pi="${pi}" data-si="${si}">删</button>`}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      ${locked ? '' : `<button class="ghost" style="margin-top:8px" id="addStep_${pi}">＋ 添加步骤</button>`}
    </div>
  `).join('');

  if (!locked) bindEditor(v);
}

function bindEditor(v) {
  const collect = () => {
    v.phases.forEach((p, pi) => {
      $$(`[data-pi="${pi}"][data-k]`).forEach(el => {
        const k = el.dataset.k, si = el.dataset.si;
        if (si !== undefined) {
          const step = p.steps[si];
          if (k === 'req') step.requiresConfirmation = el.checked;
          else if (k === 'timeoutSec') step.timeoutSec = el.value === '' ? null : Number(el.value);
          else if (k === 'kind' || k === 'roleId') step[k] = el.value;
          else step[k] = k === 'tSec' ? Number(el.value) : el.value;
        } else if (k === 'plannedStartSec' || k === 'plannedDurationSec') p[k] = Number(el.value);
        else if (k === 'name') p.name = el.value;
        else if (k === 'gate') p.condition.requireGate = el.checked;
        else if (k === 'condNote') p.condition.note = el.value;
      });
      p.condition.requireConfirmedSteps = $$(`.dep[data-pi="${pi}"]:checked`).map(x => x.value);
      $$('tr').forEach(() => {});
      p.steps.forEach((s, si) => {
        s.resources = $$(`.res[data-pi="${pi}"][data-si="${si}"]:checked`).map(x => x.value);
        const ta = $(`.manual[data-pi="${pi}"][data-si="${si}"]`);
        if (ta) s.manualChecks = ta.value.split('\n').map(x => x.trim()).filter(Boolean);
      });
    });
    return v;
  };

  $$('.delStep').forEach(b => b.onclick = () => {
    const v2 = collect();
    v2.phases[+b.dataset.pi].steps.splice(+b.dataset.si, 1);
    save(v2);
  });
  v.phases.forEach((p, pi) => {
    const b = $(`#addStep_${pi}`);
    if (b) b.onclick = () => {
      const v2 = collect();
      const ids = v2.phases.flatMap(pp => pp.steps).map(s => s.id);
      let nid = 's' + (ids.length + 1);
      while (ids.includes(nid)) nid += '_';
      v2.phases[pi].steps.push({
        id: nid, tSec: p.plannedStartSec, kind: 'instruction', title: '新步骤', detail: '',
        roleId: ctx.roles[0]?.id || null, requiresConfirmation: true, timeoutSec: null,
        resources: [], manualChecks: [], media: null,
      });
      save(v2);
    };
  });
  window.__collectDraft = collect;
}

async function save(vArg) {
  const v = vArg || window.__collectDraft();
  v.switchPoints = v.phases.map(p => p.id); // 本工具把每个阶段门都作为批准的切换点
  try {
    const { version } = await api(`/api/scripts/${SCRIPT_ID}/versions/${VERSION_ID}`, {
      method: 'PUT', body: { phases: v.phases, roles: v.roles, switchPoints: v.switchPoints, note: v.note, by: who() } });
    toast('草稿已保存');
    await load();
  } catch (e) { alert('保存失败：' + e.message); }
}

function who() { return getIdentity()?.name || prompt('请输入编排/审核人姓名') || '编排员'; }

function renderActions(v) {
  const approve = () => `<a class="btn" href="/api/scripts/${SCRIPT_ID}/export?versionId=${v.id}&standalone=1">⬇ 离线播放器</a>
    <a class="btn ghost" href="/api/scripts/${SCRIPT_ID}/export?versionId=${v.id}">⬇ JSON脚本包</a>`;
  if (v.status === 'draft') {
    $('#verActions').innerHTML = `
      <button id="saveDraft" class="green">💾 保存草稿</button>
      <button id="submitDraft">提交审核</button>
      <span class="spacer" style="flex:1"></span>
      <button id="newDraft" class="ghost">基于最新批准版新建修订草稿</button>
      <button id="discard" class="danger">丢弃本草稿</button>`;
    $('#saveDraft').onclick = () => save();
    $('#submitDraft').onclick = async () => {
      await save();
      try {
        await api(`/api/scripts/${SCRIPT_ID}/versions/${VERSION_ID}/submit`, { method: 'POST', body: { by: who() } });
        toast('已提交审核', 'green'); await load();
      } catch (e) { alert(e.message); }
    };
    $('#newDraft').onclick = async () => {
      const { version } = await api(`/api/scripts/${SCRIPT_ID}/draft`, { method: 'POST', body: { by: who() } });
      location.search = `?script=${SCRIPT_ID}&version=${version.id}`;
    };
    $('#discard').onclick = async () => {
      if (!confirm('丢弃草稿？（已批准版本与任何现场记录都不受影响）')) return;
      try { await api(`/api/scripts/${SCRIPT_ID}/versions/${VERSION_ID}/discard`, { method: 'POST' }); location.reload(); }
      catch (e) { alert(e.message); }
    };
  } else if (v.status === 'submitted') {
    $('#verActions').innerHTML = `
      <input id="approver" placeholder="审核人姓名" value="${esc(getIdentity()?.name || '')}" style="width:160px">
      <button id="approve" class="green">✔ 批准（成为不可变当前版本）</button>
      <button id="reject" class="warn">✘ 驳回回草稿</button>`;
    $('#approve').onclick = async () => {
      try {
        await api(`/api/scripts/${SCRIPT_ID}/versions/${VERSION_ID}/approve`,
          { method: 'POST', body: { by: $('#approver').value.trim() || '审核人' } });
        toast('已批准。进行中的排练不会被自动改变——只能在切换点切换', 'green'); await load();
      } catch (e) { alert(e.message); }
    };
    $('#reject').onclick = async () => {
      const reason = prompt('驳回原因') || '';
      await api(`/api/scripts/${SCRIPT_ID}/versions/${VERSION_ID}/reject`, { method: 'POST', body: { by: who(), reason } });
      await load();
    };
  } else {
    $('#verActions').innerHTML = `
      ${approve()}
      <button id="newDraft2" class="ghost">基于 v${v.version} 新建修订草稿</button>
      <span class="spacer" style="flex:1"></span>
      <span class="muted">已批准版本不可变；新版本经审核后，主持端在“阶段切换点”选择切换。</span>`;
    $('#newDraft2').onclick = async () => {
      const { version } = await api(`/api/scripts/${SCRIPT_ID}/draft`,
        { method: 'POST', body: { fromVersionId: v.id, by: who() } });
      location.search = `?script=${SCRIPT_ID}&version=${version.id}`;
    };
  }
}

load();
