'use strict';
/*
 * 消防演练脚本排练工具 —— 后端 API + 静态资源
 *
 * 设计红线（与业务需求对应）：
 *  - 仅用于组织排练与内容呈现，不连接/控制任何真实消防设施。
 *  - 阶段门（gate）必须由被授权角色人工放行；统一时钟只会自动"进入"计划阶段，
 *    不会自动确认/放行，更不会因为视频/提示音播放时间到达而视为人员已完成疏散。
 *  - 超时只产生提醒（reminder），不自动推进、不替代现场负责人判断。
 *  - 事件（event log）是只追加事实记录：撤销/修改编排不删除任何执行记录。
 *  - 新脚本版本只能在批准的切换点（switchPoints）生效；运行中不能直接换脚本。
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const HOST_STALE_MS = Number(process.env.HOST_STALE_MS || 15000); // 主持端心跳超时
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();
app.use(express.json({ limit: '4mb' }));

/* ---------------- 工具 ---------------- */
const now = () => new Date().toISOString();
const uid = (p) => p + '_' + crypto.randomBytes(6).toString('hex');
const esc = (s) => String(s == null ? '' : s);
function notFound(res, msg) { return res.status(404).json({ error: msg || '不存在' }); }
function bad(res, msg) { return res.status(400).json({ error: msg }); }
function conflict(res, msg) { return res.status(409).json({ error: msg }); }

/* ---------------- JSON 持久化（原子写） ---------------- */
function seed() {
  const mkStage = (key, name, durationSec, actions, gates, timeoutSec, media, briefing) => ({
    key, name, durationSec, actions, gates, timeoutSec: timeoutSec ?? null, media: media || [], briefing: briefing || ''
  });
  const demo = {
    id: 'script_demo',
    name: '办公楼年度消防疏散演练（示例）',
    description: '报警 → 疏散 → 集合 → 复盘 四阶段排练脚本。仅用于演练组织，不控制真实消防设施。',
    createdAt: now(),
    updatedAt: now(),
    roles: [
      { key: 'commander', name: '现场总指挥', persons: ['王安全'] },
      { key: 'host', name: '主持人/导调', persons: ['李主持'] },
      { key: 'alarm', name: '报警联络组', persons: ['张三'] },
      { key: 'floor2', name: '二层疏散引导员', persons: ['赵引导'] },
      { key: 'floor3', name: '三层疏散引导员', persons: ['钱引导'] },
      { key: 'muster', name: '集合点清点组', persons: ['孙清点'] }
    ],
    resources: [
      { id: 'res_alert', name: '演练提示音（短促蜂鸣）', url: '/assets/alert.wav', kind: 'audio', required: true, embed: true },
      { id: 'res_video_missing', name: '疏散教学视频（示例：资源缺失，用于验收）', url: '/assets/evac-video-does-not-exist.mp4', kind: 'video', required: false, embed: true },
      { id: 'res_plan', name: '疏散路线平面图', url: 'https://example.invalid/route-plan.png', kind: 'doc', required: true, embed: false }
    ],
    switchPoints: ['s_alarm', 's_muster'],
    manualChecklist: [
      '现场安全交底已完成，参演人员已知悉这是演练',
      '集合点标识、反光锥已布置',
      '提示音设备音量已现场试播确认',
      '与真实火警报警渠道隔离（演练标识牌就位）'
    ],
    versions: [],
    runs: []
  };

  const v1 = {
    id: 'ver_v1', version: 1, status: 'approved', note: '初版：已审核批准',
    createdAt: now(), approvedAt: now(), approver: '安全经理-周审批',
    snapshot: {
      name: demo.name, description: demo.description, roles: demo.roles, resources: demo.resources,
      switchPoints: demo.switchPoints, manualChecklist: demo.manualChecklist,
      stages: [
        mkStage('s_alarm', '① 报警与确认', 120,
          [
            { id: 'a1', ownerRoleKey: 'alarm', text: '发现模拟火情，拨打内部演练电话报告位置与燃烧物', durationSec: 60 },
            { id: 'a2', ownerRoleKey: 'commander', text: '确认启动演练广播（明确口播"这是消防演练"）', durationSec: 60 }
          ],
          [{ id: 'g_alarm_confirm', label: '总指挥确认：报警信息真实有效（人工）', authorizedRoleKey: 'commander', note: '口头确认，禁止由计时自动代替' }],
          90,
          [{ resourceId: 'res_alert', label: '演练提示音' }],
          '强调：提示音仅为排练信号，不联动真实报警系统。'),
        mkStage('s_evac', '② 疏散', 300,
          [
            { id: 'e1', ownerRoleKey: 'floor2', text: '二层东侧楼梯引导，提醒低姿、捂口鼻、不乘电梯', durationSec: 180 },
            { id: 'e2', ownerRoleKey: 'floor3', text: '三层西侧楼梯引导，清点本层房间并标记', durationSec: 240 }
          ],
          [
            { id: 'g_evac_f2', label: '二层引导员确认：本层人员全部撤离', authorizedRoleKey: 'floor2', note: '以人工清点为准' },
            { id: 'g_evac_f3', label: '三层引导员确认：本层人员全部撤离', authorizedRoleKey: 'floor3', note: '以人工清点为准' }
          ],
          240,
          [{ resourceId: 'res_video_missing', label: '教学视频（可缺失，缺失须登记）' }],
          '关键安全语义：视频播放结束 ≠ 人员完成疏散。完成以各层引导员人工放行为准。'),
        mkStage('s_muster', '③ 集合与清点', 240,
          [
            { id: 'm1', ownerRoleKey: 'muster', text: '在操场集合点按部门清点人数，登记失联/请假人员', durationSec: 180 },
            { id: 'm2', ownerRoleKey: 'commander', text: '听取清点结果，宣布是否需要模拟搜救', durationSec: 60 }
          ],
          [{ id: 'g_muster_count', label: '清点组确认：人数核对完成（人工签字）', authorizedRoleKey: 'muster' }],
          180, [], ''),
        mkStage('s_review', '④ 复盘', 600,
          [{ id: 'r1', ownerRoleKey: 'host', text: '记录各阶段时间、问题与改进项，形成演练记录', durationSec: 600 }],
          [{ id: 'g_review_close', label: '总指挥宣布演练结束（人工放行）', authorizedRoleKey: 'commander' }],
          null, [], '')
      ]
    }
  };

  // v2 草案：责任人变更（验收项"新版本改变责任人"）
  const v2snap = JSON.parse(JSON.stringify(v1.snapshot));
  v2snap.stages[1].actions[0].ownerRoleKey = 'muster'; // 二层疏散动作改由清点组承担（示例变更）
  v2snap.stages[1].gates[0].authorizedRoleKey = 'muster';
  v2snap.stages[1].name = '② 疏散（v2：责任人调整）';
  v2snap.roles.push({ key: 'observer', name: '观摩记录员', persons: ['新同事-吴记录'] });
  const v2 = {
    id: 'ver_v2', version: 2, status: 'draft', note: '修订：二层疏散引导责任人由 floor2 调整为 muster，新增观摩记录员',
    createdAt: now(), approvedAt: null, approver: null, snapshot: v2snap
  };

  demo.versions = [v1, v2];
  return { scripts: [demo], meta: { seq: 0 } };
}

let db;
function loadDb() {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    db = seed();
    saveDb();
  }
}
let saveChain = Promise.resolve();
function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
const persist = () => { saveDb(); };
const nextSeq = () => { db.meta.seq += 1; return db.meta.seq; };
loadDb();

/* ---------------- 领域查询 ---------------- */
const getScript = (id) => db.scripts.find((s) => s.id === id);
const getVersion = (script, verId) => (script.versions || []).find((v) => v.id === verId);
const findGate = (stage, gateId) => (stage.gates || []).find((g) => g.id === gateId);
function stageAt(content, key) { return (content.stages || []).find((s) => s.key === key); }

/*
 * 基于事件日志（只追加事实）重放一次运行。
 * events 类型：
 *  run.start / stage.enter / gate.pass / pause / resume / note / host.claim / host.takeover /
 *  host.heartbeat / run.end / switch.plan / switch.apply / audio.missing / timeout.reminder /
 *  confirm.offline.import
 */
function replay(run, scriptParam) {
  const script = scriptParam || getScript(run.scriptId);
  const events = (run.events || []).slice().sort((a, b) =>
    a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : (a.seq - b.seq));

  // 生效版本：从 start 事件取值，运行期只能在切换点变化
  let versionId = run.versionId;
  const started = events.find((e) => e.type === 'run.start');
  if (started && started.data && started.data.versionId) versionId = started.data.versionId;
  for (const e of events) if (e.type === 'switch.apply' && e.data && e.data.toVersionId) versionId = e.data.toVersionId;

  const ver = getVersion(script, versionId) || script.versions.find((v) => v.status === 'approved');
  const content = ver.snapshot;

  // 暂停统计
  let pausedMs = 0, pauseStart = null;
  for (const e of events) {
    if (e.type === 'pause') pauseStart = Date.parse(e.ts);
    else if (e.type === 'resume' && pauseStart) { pausedMs += Date.parse(e.ts) - pauseStart; pauseStart = null; }
  }
  const ended = events.find((e) => e.type === 'run.end');
  const atMs = ended ? Date.parse(ended.ts) : Date.now();
  const startMs = started ? Date.parse(started.ts) : atMs;
  if (pauseStart && !ended) pausedMs += atMs - pauseStart;
  const elapsedMs = Math.max(0, atMs - startMs - pausedMs);
  const isPaused = !!pauseStart && !ended;

  // 已进入阶段链（人工进入或时钟计划进入，含 force 标记）
  const entered = events.filter((e) => e.type === 'stage.enter').map((e) => ({
    key: e.data.stageKey, ts: e.ts, forced: !!e.data.forced, reason: e.data.reason || '', source: e.data.source || 'host'
  }));
  const currentKey = entered.length ? entered[entered.length - 1].key : null;
  const stages = content.stages || [];
  // 切换版本后当前 key 可能不存在于新版本（执行事实保留），此时定位最后一个仍存在的已进入阶段
  let currentIdx = stages.findIndex((s) => s.key === currentKey);
  if (currentIdx < 0) {
    for (let k = entered.length - 1; k >= 0; k--) {
      const idx = stages.findIndex((s) => s.key === entered[k].key);
      if (idx >= 0) { currentIdx = idx; break; }
    }
  }

  // 时钟模式：按计划时长推导应进入的阶段（用于在物化前/只读场景的呈现；绝不放行 gate）
  const autoKeys = [];
  if (started && run.mode === 'clock' && !ended) {
    // 计划基准 = 第一阶段实际进入时间（而非 run.start）；暂停时长扣除
    const first = entered[0];
    if (first) {
      const firstMs = Date.parse(first.ts);
      let psMs = 0, psStart = null;
      for (const e of events) {
        if (e.type === 'pause' && Date.parse(e.ts) >= firstMs) psStart = Date.parse(e.ts);
        else if (e.type === 'resume' && psStart) { psMs += Date.parse(e.ts) - psStart; psStart = null; }
      }
      if (psStart) psMs += atMs - psStart;
      const clockMs = Math.max(0, atMs - firstMs - psMs);
      let acc = 0;
      for (let i = 0; i < stages.length; i++) {
        if (i > 0 && clockMs >= acc * 1000 && !entered.some((en) => en.key === stages[i].key)) autoKeys.push(stages[i].key);
        acc += stages[i].durationSec || 0;
      }
    }
  }
  const effectiveEntered = entered.slice();
  for (const k of autoKeys) if (!effectiveEntered.some((en) => en.key === k))
    effectiveEntered.push({ key: k, ts: null, forced: false, source: 'clock' });

  // 已放行 gate
  const gatePasses = {}; // gateId -> event
  for (const e of events) if (e.type === 'gate.pass') gatePasses[e.data.gateId] = e;

  const stageStates = stages.map((st, i) => {
    const en = effectiveEntered.find((x) => x.key === st.key);
    const gates = (st.gates || []).map((g) => ({ ...g, passed: !!gatePasses[g.id], passedAt: gatePasses[g.id] ? gatePasses[g.id].ts : null, passedBy: gatePasses[g.id] ? gatePasses[g.id].data.by : null, late: gatePasses[g.id] ? !!gatePasses[g.id].data.late : false, offline: gatePasses[g.id] ? !!gatePasses[g.id].data.offline : false }));
    const open = gates.every((g) => g.passed);
    return { key: st.key, name: st.name, index: i, entered: !!en, enteredAt: en ? en.ts : null, enteredBy: en ? en.source : null, forced: en ? en.forced : false, gates, open, isCurrent: st.key === currentKey };
  });

  // 超时提醒（当前阶段，依据 timeoutSec 与已用时间；只提醒，不推进）
  const reminders = [];
  if (currentKey && !ended) {
    const cur = stages.find((s) => s.key === currentKey);
    const st_idx_ok = stages.some((s) => s.key === currentKey);
    const curEnter = entered.filter((en) => en.key === currentKey).pop();
    if (cur && st_idx_ok && cur.timeoutSec != null && curEnter && curEnter.ts) {
      const curEnterMs = Date.parse(curEnter.ts);
      // 当前阶段内暂停量
      let stagePaused = 0, ps = null;
      for (const e of events) {
        if (e.type === 'pause' && Date.parse(e.ts) >= curEnterMs) ps = Date.parse(e.ts);
        else if (e.type === 'resume' && ps) { stagePaused += Date.parse(e.ts) - ps; ps = null; }
      }
      if (ps) stagePaused += atMs - ps;
      const curElapsed = Math.max(0, atMs - curEnterMs - stagePaused);
      const fired = events.some((e) => e.type === 'timeout.reminder' && e.data && e.data.stageKey === currentKey);
      if (curElapsed > cur.timeoutSec * 1000) {
        reminders.push({ stageKey: currentKey, timeoutSec: cur.timeoutSec, elapsedSec: Math.round(curElapsed / 1000), fired, overdue: true });
      }
    }
  }

  // 主持人锁
  const claimEv = events.filter((e) => e.type === 'host.claim' || e.type === 'host.takeover').pop();
  const lastHb = events.filter((e) => e.type === 'host.heartbeat').pop();
  let host = null, hostStale = false;
  if (claimEv) {
    host = { userId: claimEv.data.userId, userName: claimEv.data.userName, roleKey: claimEv.data.roleKey, claimedAt: claimEv.ts, takeover: claimEv.type === 'host.takeover' };
    const hbMs = lastHb ? Date.parse(lastHb.ts) : Date.parse(claimEv.ts);
    hostStale = !ended && (atMs - hbMs) > HOST_STALE_MS;
    host.lastHeartbeat = lastHb ? lastHb.ts : claimEv.ts;
    host.stale = hostStale;
  }

  const pendingSwitch = events.filter((e) => e.type === 'switch.plan').pop();
  const activeSwitch = pendingSwitch && !events.some((e) => (e.type === 'switch.apply' || e.type === 'switch.cancel') &&
    Date.parse(e.ts) >= Date.parse(pendingSwitch.ts)) ? pendingSwitch : null;

  return {
    run, scriptId: run.scriptId, runId: run.id, mode: run.mode, status: ended ? 'ended' : (isPaused ? 'paused' : 'running'),
    versionId: ver.id, versionLabel: 'v' + ver.version, content,
    startedAt: started ? started.ts : null, endedAt: ended ? ended.ts : null,
    elapsedSec: Math.round(elapsedMs / 1000), isPaused,
    currentStageKey: currentKey, currentIdx, currentIndex: currentIdx,
    stages: stageStates, allEntered: effectiveEntered, autoKeys,
    reminders, host,
    pendingSwitch: activeSwitch ? activeSwitch.data : null,
    audioMissing: events.filter((e) => e.type === 'audio.missing').map((e) => e.data),
    notes: events.filter((e) => e.type === 'note').map((e) => ({ ts: e.ts, text: e.data.text, by: e.data.userName })),
    events
  };
}

/* 统一时钟模式：把计划到时的 stage.enter 具体化为事实事件（不触发任何 gate 放行） */
function materializeClock(script, run) {
  let changed = false;
  // 最多迭代到稳定（跨版本 key 对齐时避免循环）
  for (let guard = 0; guard < 64; guard++) {
    const st = replay(run);
    if (st.status !== 'running' || st.isPaused || run.mode !== 'clock' || !st.autoKeys.length) break;
    const targetKey = st.autoKeys[0];
    const cur = st.currentIdx >= 0 ? st.stages[st.currentIdx] : null;
    // 与主持人工进入一致：在切换点应用已批准的计划切换
    if (cur && st.pendingSwitch && (st.content.switchPoints || []).includes(cur.key)) {
      const tv = getVersion(script, st.pendingSwitch.toVersionId);
      if (tv && tv.status === 'approved') { addEvent(run, 'switch.apply', { atStageKey: cur.key, toVersionId: tv.id, by: '统一时钟' }); changed = true; }
    }
    addEvent(run, 'stage.enter', { stageKey: targetKey, by: '统一时钟', force: false, reason: '计划时长到达，自动进入（放行条件仍需人工确认）', source: 'clock' });
    changed = true;
  }
  if (changed) persist();
  return changed;
}

function addEvent(run, type, data) {
  const ev = { id: uid('evt'), seq: nextSeq(), ts: now(), type, data: data || {} };
  run.events.push(ev);
  return ev;
}
const findRun = (script, runId) => (script.runs || []).find((r) => r.id === runId);

/* 校验 gate 放行授权：角色必须匹配（或 commander 强制并写明理由） */
function authorizeGate(roleKey, gate, asForce) {
  if (asForce) return roleKey === 'commander';
  return roleKey === gate.authorizedRoleKey || roleKey === 'commander';
}

/* ---------------- API: 脚本元数据 / 角色 / 资源 ---------------- */
app.get('/api/scripts', (req, res) => {
  res.json(db.scripts.map((s) => ({ id: s.id, name: s.name, description: s.description, updatedAt: s.updatedAt,
    roles: s.roles, resources: s.resources, switchPoints: s.switchPoints, manualChecklist: s.manualChecklist,
    versions: s.versions.map((v) => ({ id: v.id, version: v.version, status: v.status, note: v.note, createdAt: v.createdAt, approvedAt: v.approvedAt, approver: v.approver })),
    runCount: (s.runs || []).length })));
});

app.post('/api/scripts', (req, res) => {
  const name = esc(req.body.name).trim() || '未命名演练脚本';
  const s = {
    id: uid('script'), name, description: esc(req.body.description || ''),
    createdAt: now(), updatedAt: now(),
    roles: Array.isArray(req.body.roles) ? req.body.roles : [
      { key: 'commander', name: '现场总指挥', persons: [] },
      { key: 'host', name: '主持人/导调', persons: [] }
    ],
    resources: [], switchPoints: [], manualChecklist: [],
    versions: [{
      id: uid('ver'), version: 1, status: 'draft', note: '初始草案', createdAt: now(), approvedAt: null, approver: null,
      snapshot: { name, description: '', roles: [], resources: [], switchPoints: [], manualChecklist: [],
        stages: [
          { key: 's_alarm', name: '① 报警与确认', durationSec: 120, actions: [], gates: [], timeoutSec: null, media: [], briefing: '' },
          { key: 's_evac', name: '② 疏散', durationSec: 300, actions: [], gates: [], timeoutSec: null, media: [], briefing: '' },
          { key: 's_muster', name: '③ 集合与清点', durationSec: 240, actions: [], gates: [], timeoutSec: null, media: [], briefing: '' },
          { key: 's_review', name: '④ 复盘', durationSec: 600, actions: [], gates: [], timeoutSec: null, media: [], briefing: '' }
        ] }
    }],
    runs: []
  };
  s.versions[0].snapshot.roles = JSON.parse(JSON.stringify(s.roles));
  db.scripts.push(s); persist();
  res.status(201).json({ id: s.id });
});

/* 草案编辑（整体保存；仅 draft 可改） */
app.put('/api/scripts/:id/versions/:vid/content', (req, res) => {
  const s = getScript(req.params.id); if (!s) return notFound(res);
  const v = getVersion(s, req.params.vid); if (!v) return notFound(res);
  if (v.status !== 'draft') return conflict(res, '只有草案可以编辑。已批准版本为不可变快照，请"基于新版本修订"。');
  const c = req.body.snapshot || req.body;
  if (!c || !Array.isArray(c.stages)) return bad(res, 'snapshot.stages 缺失');
  // 规范化：补齐字段，防止前端漏字段
  const roles = Array.isArray(c.roles) ? c.roles : v.snapshot.roles;
  const resources = Array.isArray(c.resources) ? c.resources : v.snapshot.resources;
  const stages = c.stages.map((st, i) => ({
    key: esc(st.key || ('s_' + i)),
    name: esc(st.name || ('阶段' + (i + 1))),
    durationSec: Math.max(0, Number(st.durationSec) || 0),
    timeoutSec: st.timeoutSec == null || st.timeoutSec === '' ? null : Math.max(0, Number(st.timeoutSec) || 0),
    briefing: esc(st.briefing || ''),
    actions: (st.actions || []).map((a, j) => ({ id: esc(a.id || ('a_' + i + '_' + j)), ownerRoleKey: esc(a.ownerRoleKey || ''), text: esc(a.text || ''), durationSec: Math.max(0, Number(a.durationSec) || 0) })),
    gates: (st.gates || []).map((g, j) => ({ id: esc(g.id || ('g_' + i + '_' + j)), label: esc(g.label || '人工放行'), authorizedRoleKey: esc(g.authorizedRoleKey || ''), note: esc(g.note || '') })),
    media: (st.media || []).map((m) => ({ resourceId: esc(m.resourceId || ''), label: esc(m.label || '') }))
  }));
  v.snapshot = {
    name: esc(c.name || s.name), description: esc(c.description || s.description || ''),
    roles, resources,
    switchPoints: (Array.isArray(c.switchPoints) ? c.switchPoints : []).map(esc),
    manualChecklist: Array.isArray(c.manualChecklist) ? c.manualChecklist.map(esc) : [],
    stages
  };
  s.updatedAt = now(); persist();
  res.json({ ok: true, versionId: v.id });
});

/* 基于现有版本创建新草案（责任人/依赖可在此修订） */
app.post('/api/scripts/:id/revise', (req, res) => {
  const s = getScript(req.params.id); if (!s) return notFound(res);
  const baseId = req.body.baseVersionId || (s.versions.filter((v) => v.status === 'approved').slice(-1)[0] || {}).id;
  const base = getVersion(s, baseId); if (!base) return notFound(res, '基准版本不存在');
  if (s.versions.some((v) => v.status === 'draft')) return conflict(res, '已存在草案版本，请先提交审核/驳回或删除该草案。');
  const nv = { id: uid('ver'), version: Math.max.apply(null, s.versions.map((v) => v.version)) + 1,
    status: 'draft', note: esc(req.body.note || '新版本草案'), createdAt: now(), approvedAt: null, approver: null,
    snapshot: JSON.parse(JSON.stringify(base.snapshot)) };
  s.versions.push(nv); s.updatedAt = now(); persist();
  res.status(201).json({ id: nv.id, version: nv.version });
});

/* 删除草案 = "撤销编排"：只删除尚未生效的草案，绝不触碰事件/执行记录 */
app.delete('/api/scripts/:id/versions/:vid', (req, res) => {
  const s = getScript(req.params.id); if (!s) return notFound(res);
  const v = getVersion(s, req.params.vid); if (!v) return notFound(res);
  if (v.status !== 'draft') return conflict(res, '只能删除草案。已批准版本及任何执行记录不可删除。');
  const used = (s.runs || []).some((r) => (r.events || []).some((e) =>
    (e.type === 'run.start' && e.data.versionId === v.id) || (e.type === 'switch.apply' && e.data.toVersionId === v.id)));
  if (used) return conflict(res, '该版本已被某次运行引用，执行事实不可删除。');
  s.versions = s.versions.filter((x) => x.id !== v.id); s.updatedAt = now(); persist();
  res.json({ ok: true, preserved: '历史事件与运行记录保持不变' });
});

/* 提交审核 -> 批准 / 驳回（用户审核流程） */
app.post('/api/scripts/:id/versions/:vid/submit', (req, res) => {
  const s = getScript(req.params.id); if (!s) return notFound(res);
  const v = getVersion(s, req.params.vid); if (!v) return notFound(res);
  if (v.status !== 'draft') return conflict(res, '只有草案可提交审核');
  v.status = 'in_review'; persist(); res.json({ ok: true });
});
app.post('/api/scripts/:id/versions/:vid/approve', (req, res) => {
  const s = getScript(req.params.id); if (!s) return notFound(res);
  const v = getVersion(s, req.params.vid); if (!v) return notFound(res);
  if (v.status !== 'in_review') return conflict(res, '需要先提交审核（in_review）才能批准');
  // 结构校验：每个放行条件都必须指定授权角色，且该角色必须存在
  const roleKeys = new Set((v.snapshot.roles || []).map((r) => r.key));
  for (const st of v.snapshot.stages) for (const g of st.gates || []) {
    if (!g.authorizedRoleKey) return bad(res, `阶段「${st.name}」存在未指定责任人的放行条件`);
    if (!roleKeys.has(g.authorizedRoleKey)) return bad(res, `阶段「${st.name}」的放行条件「${g.label}」责任人 ${g.authorizedRoleKey} 不存在，请先在角色中定义`);
  }
  for (const st of v.snapshot.stages) for (const a of st.actions || []) {
    if (a.ownerRoleKey && !roleKeys.has(a.ownerRoleKey)) return bad(res, `阶段「${st.name}」的动作「${(a.text || '').slice(0, 20)}」责任角色 ${a.ownerRoleKey} 不存在`);
  }
  v.status = 'approved'; v.approvedAt = now(); v.approver = esc(req.body.approver || '匿名审核人'); persist();
  res.json({ ok: true, approver: v.approver });
});
app.post('/api/scripts/:id/versions/:vid/reject', (req, res) => {
  const s = getScript(req.params.id); if (!s) return notFound(res);
  const v = getVersion(s, req.params.vid); if (!v) return notFound(res);
  if (v.status !== 'in_review') return conflict(res, '当前状态不可驳回');
  v.status = 'draft'; persist(); res.json({ ok: true });
});

app.get('/api/scripts/:id/versions/:vid', (req, res) => {
  const s = getScript(req.params.id); if (!s) return notFound(res);
  const v = getVersion(s, req.params.vid); if (!v) return notFound(res);
  res.json(v);
});

/* 版本差异（责任人/依赖/阶段条件变化） */
app.get('/api/scripts/:id/diff', (req, res) => {
  const s = getScript(req.params.id); if (!s) return notFound(res);
  const a = getVersion(s, req.query.from); const b = getVersion(s, req.query.to);
  if (!a || !b) return bad(res, '需要 from、to 版本 id');
  const changes = [];
  const rolesA = new Map(a.snapshot.roles.map((r) => [r.key, r]));
  for (const r of b.snapshot.roles) {
    const old = rolesA.get(r.key);
    if (!old) changes.push({ kind: 'role.add', path: `角色 ${r.name}`, from: null, to: `${r.name}（${(r.persons || []).join('、') || '未指派'}）` });
    else if (JSON.stringify(old.persons) !== JSON.stringify(r.persons))
      changes.push({ kind: 'role.person', path: `角色 ${r.name} 的人员`, from: (old.persons || []).join('、'), to: (r.persons || []).join('、') });
  }
  for (const r of a.snapshot.roles) if (!b.snapshot.roles.some((x) => x.key === r.key))
    changes.push({ kind: 'role.remove', path: `角色 ${r.name}`, from: r.name, to: null });
  const resA = new Set(a.snapshot.resources.map((r) => r.id));
  for (const r of b.snapshot.resources) if (!resA.has(r.id))
    changes.push({ kind: 'resource.add', path: `依赖资源 ${r.name}`, from: null, to: r.url });
  for (const r of a.snapshot.resources) if (!b.snapshot.resources.some((x) => x.id === r.id))
    changes.push({ kind: 'resource.remove', path: `依赖资源 ${r.name}`, from: r.url, to: null });

  const mapB = new Map(b.snapshot.stages.map((st) => [st.key, st]));
  for (const sa of a.snapshot.stages) {
    const sb = mapB.get(sa.key);
    if (!sb) { changes.push({ kind: 'stage.remove', path: `阶段 ${sa.name}`, from: sa.name, to: null }); continue; }
    if (sa.name !== sb.name) changes.push({ kind: 'stage.name', path: `阶段 ${sa.key} 名称`, from: sa.name, to: sb.name });
    if ((sa.durationSec || 0) !== (sb.durationSec || 0)) changes.push({ kind: 'stage.duration', path: `${sb.name} 计划时长`, from: sa.durationSec + 's', to: sb.durationSec + 's' });
    const ga = new Map((sa.gates || []).map((g) => [g.id, g]));
    for (const g of sb.gates || []) {
      const go = ga.get(g.id);
      if (!go) changes.push({ kind: 'gate.add', path: `${sb.name} 新增放行条件`, from: null, to: `${g.label}（责任人 ${g.authorizedRoleKey}）` });
      else if (go.authorizedRoleKey !== g.authorizedRoleKey)
        changes.push({ kind: 'gate.owner', path: `${sb.name}：${g.label} 的责任人`, from: go.authorizedRoleKey, to: g.authorizedRoleKey });
    }
    for (const g of sa.gates || []) if (!(sb.gates || []).some((x) => x.id === g.id))
      changes.push({ kind: 'gate.remove', path: `${sb.name} 删除放行条件`, from: g.label, to: null });
    const aa = new Map((sa.actions || []).map((x) => [x.id, x]));
    for (const x of sb.actions || []) {
      const xo = aa.get(x.id);
      if (xo && xo.ownerRoleKey !== x.ownerRoleKey)
        changes.push({ kind: 'action.owner', path: `${sb.name}：动作「${x.text.slice(0, 20)}」责任人`, from: xo.ownerRoleKey, to: x.ownerRoleKey });
    }
  }
  for (const sb of b.snapshot.stages) if (!a.snapshot.stages.some((x) => x.key === sb.key))
    changes.push({ kind: 'stage.add', path: `新增阶段 ${sb.name}`, from: null, to: sb.name });
  res.json({ from: { id: a.id, version: a.version }, to: { id: b.id, version: b.version }, changes });
});

/* ---------------- API: 运行（排练场次） ---------------- */
app.post('/api/scripts/:id/runs', (req, res) => {
  const s = getScript(req.params.id); if (!s) return notFound(res);
  const mode = req.body.mode === 'clock' ? 'clock' : 'host';
  const ver = req.body.versionId ? getVersion(s, req.body.versionId) : s.versions.filter((v) => v.status === 'approved').slice(-1)[0];
  if (!ver) return bad(res, '没有可用的已批准版本');
  if (ver.status !== 'approved') return conflict(res, '只能启动已批准版本。草案请先完成审核批准。');
  const run = { id: uid('run'), scriptId: s.id, createdAt: now(), mode, versionId: ver.id, events: [] };
  s.runs.push(run);
  addEvent(run, 'run.start', { mode, versionId: ver.id, by: req.body.userName || '系统' });
  persist();
  res.status(201).json({ runId: run.id, mode, versionId: ver.id });
});

app.get('/api/scripts/:id/runs', (req, res) => {
  const s = getScript(req.params.id); if (!s) return notFound(res);
  res.json((s.runs || []).map((r) => {
    const st = replay(r);
    return { id: r.id, mode: r.mode, status: st.status, versionId: st.versionId, versionLabel: st.versionLabel,
      currentStageKey: st.currentStageKey, startedAt: st.startedAt, endedAt: st.endedAt, host: st.host, eventCount: r.events.length };
  }));
});

app.get('/api/runs/:runId', (req, res) => {
  const loc = locateRun(req.params.runId);
  if (!loc) return notFound(res, '运行不存在');
  materializeClock(loc.script, loc.run);
  res.json(buildState(loc.script, loc.run));
});
function locateRun(runId) {
  for (const s of db.scripts) { const r = findRun(s, runId); if (r) return { script: s, run: r }; }
  return null;
}
function buildState(script, run) {
  const st = replay(run);
  return {
    scriptId: script.id, scriptName: script.name, runId: run.id, mode: st.mode, status: st.status,
    versionId: st.versionId, versionLabel: st.versionLabel, startedAt: st.startedAt, endedAt: st.endedAt,
    elapsedSec: st.elapsedSec, isPaused: st.isPaused, currentStageKey: st.currentStageKey, currentIndex: st.currentIdx,
    stages: st.stages, reminders: st.reminders, host: st.host, pendingSwitch: st.pendingSwitch,
    audioMissing: st.audioMissing, notes: st.notes,
    content: { stages: st.content.stages },
    _embeds: {},
    roles: st.content.roles, resources: st.content.resources, manualChecklist: st.content.manualChecklist,
    switchPoints: st.content.switchPoints,
    events: st.events.map((e) => ({ seq: e.seq, ts: e.ts, type: e.type, data: e.data }))
  };
}

/* 主持端：获取推进权（两人争用 -> 409；崩溃后可接管） */
app.post('/api/runs/:runId/claim', (req, res) => {
  const loc = locateRun(req.params.runId); if (!loc) return notFound(res);
  const { run } = loc; const st = replay(run);
  if (st.status === 'ended') return conflict(res, '本场已结束');
  const body = { userId: esc(req.body.userId || 'user'), userName: esc(req.body.userName || '主持人'), roleKey: esc(req.body.roleKey || 'host') };
  if (body.roleKey !== 'host' && body.roleKey !== 'commander') return conflict(res, '只有主持人/导调角色可获取推进权');
  if (st.host && st.host.userId !== body.userId) {
    if (!st.host.stale) return conflict(res, `推进权当前由 ${st.host.userName} 持有（心跳正常）。如对方已崩溃，请在其心跳超时后接管。`);
    addEvent(run, 'host.takeover', { ...body, fromUserId: st.host.userId, reason: esc(req.body.reason || '原主持端心跳超时，接管') });
    addEvent(run, 'host.heartbeat', { userId: body.userId });
    persist();
    return res.json({ ok: true, takeover: true, host: replay(run).host });
  }
  addEvent(run, 'host.claim', body);
  addEvent(run, 'host.heartbeat', { userId: body.userId });
  persist();
  res.json({ ok: true, takeover: false, host: replay(run).host });
});
app.post('/api/runs/:runId/heartbeat', (req, res) => {
  const loc = locateRun(req.params.runId); if (!loc) return notFound(res);
  const st = replay(loc.run);
  if (!st.host) return conflict(res, '尚未获取推进权');
  if (st.host.userId !== esc(req.body.userId)) return conflict(res, '推进权已被他人持有');
  addEvent(loc.run, 'host.heartbeat', { userId: st.host.userId }); persist();
  res.json({ ok: true });
});

/* 演示：模拟主持端崩溃（停止心跳），无需真正杀死浏览器 */
app.post('/api/runs/:runId/simulate-crash', (req, res) => {
  const loc = locateRun(req.params.runId); if (!loc) return notFound(res);
  addEvent(loc.run, 'note', { text: '【演示】主持端进程崩溃/断网，停止发送心跳', userName: '系统', kind: 'sim-crash' });
  persist(); res.json({ ok: true, staleAfterMs: HOST_STALE_MS });
});

/* 主持人命令：进入下一阶段（可 force，但 force 必须填理由且记为事实） */
app.post('/api/runs/:runId/command', (req, res) => {
  const loc = locateRun(req.params.runId); if (!loc) return notFound(res);
  const { run } = loc;
  materializeClock(loc.script, run);
  const st = replay(run);
  const userId = esc(req.body.userId || '');
  if (!st.host || st.host.userId !== userId) return conflict(res, '你没有推进权（可能已被接管）');
  if (st.status === 'ended') return conflict(res, '本场已结束');
  const cmd = esc(req.body.command || '');
  const apply = (type, data) => { addEvent(run, type, data); persist(); };

  if (cmd === 'pause') {
    if (st.isPaused) return conflict(res, '已处于暂停');
    apply('pause', { by: st.host.userName, reason: esc(req.body.reason || '') });
    return res.json({ ok: true });
  }
  if (cmd === 'resume') {
    if (!st.isPaused) return conflict(res, '当前未暂停');
    apply('resume', { by: st.host.userName });
    return res.json({ ok: true });
  }
  if (cmd === 'enter-stage') {
    if (st.isPaused) return conflict(res, '暂停中不能推进，请先人工放行恢复');
    const targetKey = esc(req.body.stageKey || '');
    const stages = st.content.stages;
    const targetIdx = stages.findIndex((x) => x.key === targetKey);
    if (targetIdx < 0) return bad(res, '目标阶段不存在');
    const cur = st.currentIdx >= 0 ? stages[st.currentIdx] : null;
    const force = !!req.body.force;
    if (st.currentStageKey !== null && cur) {
      const curState = st.stages[st.currentIdx];
      if (targetIdx <= st.currentIdx) return conflict(res, '不能回退到已执行阶段（执行事实不可撤销）');
      if (targetKey === st.currentStageKey) return conflict(res, '该阶段已经是当前阶段（不可重复进入）');
      if (!curState.open) {
        if (!force) return conflict(res, `阶段「${cur.name}」尚有放行条件未人工确认，不能进入下一阶段。可强制推进（写明理由），但未完成项将保留为待确认。`);
        if (!esc(req.body.reason || '').trim()) return bad(res, '强制推进必须填写理由（现场负责人决策留痕）');
        if (st.host.roleKey !== 'commander' && st.host.roleKey !== 'host') return bad(res, '');
      }
      // 切换点检查：若计划了版本切换，仅在批准的切换点生效
      if (st.pendingSwitch) {
        if ((st.content.switchPoints || []).includes(cur.key)) {
          const tv = getVersion(loc.script, st.pendingSwitch.toVersionId);
          if (tv && tv.status === 'approved') {
            apply('switch.apply', { atStageKey: cur.key, toVersionId: tv.id, by: st.host.userName });
          }
        }
      }
    }
    apply('stage.enter', { stageKey: targetKey, by: st.host.userName, force, reason: esc(req.body.reason || ''), source: 'host' });
    return res.json({ ok: true });
  }
  if (cmd === 'end') {
    if (st.isPaused) return conflict(res, '请先恢复再结束');
    const last = st.stages[st.stages.length - 1];
    if (last && !last.open && !req.body.force) return conflict(res, '最后阶段放行条件尚未全部确认。如需结束请强制并写明理由。');
    apply('run.end', { by: st.host.userName, force: !!req.body.force, reason: esc(req.body.reason || '') });
    return res.json({ ok: true });
  }
  return bad(res, '未知命令：' + cmd);
});

/* 计划切换到新版本（只在批准的 switchPoints 生效） */
app.post('/api/runs/:runId/plan-switch', (req, res) => {
  const loc = locateRun(req.params.runId); if (!loc) return notFound(res);
  const st = replay(loc.run);
  if (st.status === 'ended') return conflict(res, '本场已结束');
  const tv = getVersion(loc.script, esc(req.body.toVersionId || ''));
  if (!tv) return notFound(res, '目标版本不存在');
  if (tv.status !== 'approved') return conflict(res, '只能切换到已批准版本');
  if (tv.id === st.versionId) return bad(res, '目标版本与当前版本相同');
  const nextSwitch = (st.content.switchPoints || []).find((k) => {
    const idx = st.content.stages.findIndex((x) => x.key === k);
    return idx > (st.currentIdx < 0 ? -1 : st.currentIdx);
  });
  addEvent(loc.run, 'switch.plan', { toVersionId: tv.id, by: esc(req.body.userName || ''), nextSwitchPoint: nextSwitch || null });
  persist();
  res.json({ ok: true, nextSwitchPoint: nextSwitch || null, warning: nextSwitch ? null : '后续没有批准的切换点：该切换不会在本场自动生效，需新场次使用新版本。' });
});
app.post('/api/runs/:runId/cancel-switch', (req, res) => {
  const loc = locateRun(req.params.runId); if (!loc) return notFound(res);
  addEvent(loc.run, 'switch.cancel', { by: esc(req.body.userName || '') }); persist();
  res.json({ ok: true });
});

/* 人工放行（确认）。这是唯一表示"人员完成疏散"等事实的入口。 */
app.post('/api/runs/:runId/confirm', (req, res) => {
  const loc = locateRun(req.params.runId); if (!loc) return notFound(res);
  const { run } = loc;
  materializeClock(loc.script, run);
  const st = replay(run);
  if (st.status === 'ended') return conflict(res, '本场已结束，不能补记（请用离线导入，将标记为迟到）');
  if (st.isPaused) return conflict(res, '暂停中：等待主持人人工放行恢复后再确认');
  const stageKey = esc(req.body.stageKey || ''); const gateId = esc(req.body.gateId || '');
  const stage = st.content.stages.find((x) => x.key === stageKey);
  if (!stage) return bad(res, '阶段不存在');
  const gate = findGate(stage, gateId); if (!gate) return bad(res, '放行条件不存在');
  const stageState = st.stages.find((x) => x.key === stageKey);
  if (stageState.gates.find((g) => g.id === gateId).passed) return conflict(res, '该条件已放行（事实不可重复/撤销）');
  if (!stageState.entered) return conflict(res, '该阶段尚未进入，不能提前确认');
  if (st.currentStageKey !== stageKey) return conflict(res, '只能确认当前进行中的阶段（历史阶段如确需补记请用离线导入，会标记迟到）');
  const roleKey = esc(req.body.roleKey || ''); const userName = esc(req.body.userName || '');
  const force = !!req.body.force;
  if (!authorizeGate(roleKey, gate, force)) return conflict(res, `该条件责任人是 ${gate.authorizedRoleKey}，当前身份 ${roleKey} 无权放行`);
  if (force && !esc(req.body.reason || '').trim()) return bad(res, '代为放行必须填写理由');
  addEvent(run, 'gate.pass', { stageKey, gateId, roleKey, by: userName, userId: esc(req.body.userId || ''), force, reason: esc(req.body.reason || ''), late: false, offline: false, clientEventId: esc(req.body.clientEventId || '') });
  persist();
  res.json({ ok: true });
});

/* 离线确认导入（断网设备重连后；迟到=阶段已推进/结束，事实保留并标记） */
app.post('/api/runs/:runId/offline-events', (req, res) => {
  const loc = locateRun(req.params.runId); if (!loc) return notFound(res);
  const { run } = loc; const st = replay(run);
  const items = Array.isArray(req.body.events) ? req.body.events : [];
  const accepted = [], duplicates = [], rejected = [];
  for (const it of items) {
    const cid = esc(it.clientEventId || '');
    if (cid && run.events.some((e) => (e.data || {}).clientEventId === cid)) { duplicates.push(cid); continue; }
    if ((it.type || '') !== 'gate.pass') { rejected.push({ clientEventId: cid, reason: '离线导入目前仅支持放行确认' }); continue; }
    const stage = st.content.stages.find((x) => x.key === it.stageKey);
    const gate = stage && findGate(stage, it.gateId);
    if (!gate) { rejected.push({ clientEventId: cid, reason: '当前生效版本中找不到该阶段/放行条件（可能版本已切换）' }); continue; }
    if (st.stages.find((x) => x.key === stage.key).gates.find((g) => g.id === gate.id).passed) { duplicates.push(cid); continue; }
    const observedAt = it.observedAt ? new Date(it.observedAt).toISOString() : null;
    const late = st.status === 'ended' || st.currentStageKey !== stage.key;
    addEvent(run, 'gate.pass', {
      stageKey: stage.key, gateId: gate.id, roleKey: esc(it.roleKey || ''), by: esc(it.userName || '离线设备'),
      userId: esc(it.userId || 'offline'), force: false, reason: late ? '离线确认，重连后导入（迟到，保留事实，不回溯状态）' : '离线确认，重连后导入',
      late, offline: true, observedAt, importedAt: now(), clientEventId: cid
    });
    accepted.push({ clientEventId: cid, late });
  }
  persist();
  res.json({ accepted, duplicates, rejected, note: '离线确认仅登记事实；迟到标记不会回改当时的阶段状态。' });
});

/* 提示音缺失登记（验收：提示音缺失必须显式提示并留痕，不能静默） */
app.post('/api/runs/:runId/audio-missing', (req, res) => {
  const loc = locateRun(req.params.runId); if (!loc) return notFound(res);
  addEvent(loc.run, 'audio.missing', { resourceId: esc(req.body.resourceId || ''), url: esc(req.body.url || ''),
    stageKey: esc(req.body.stageKey || ''), by: esc(req.body.userName || '设备'), acknowledgedAt: now() });
  persist();
  res.json({ ok: true, fallback: '已登记：改用人工口令/哨音（现场决定），系统不会自动替代' });
});

/* 主持人/现场备注 */
app.post('/api/runs/:runId/notes', (req, res) => {
  const loc = locateRun(req.params.runId); if (!loc) return notFound(res);
  addEvent(loc.run, 'note', { text: esc(req.body.text || ''), userName: esc(req.body.userName || '') });
  persist(); res.json({ ok: true });
});

/* ---------------- 导出：可离线播放脚本包 ---------------- */
async function fetchAsDataUrl(url, kind, timeoutMs = 4000) {
  // 仅尝试 http(s)；失败返回 null（manifest 标记为需人工核对）
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    const resp = await fetch(url, { signal: ctl.signal, redirect: 'follow' });
    clearTimeout(t);
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    const mime = resp.headers.get('content-type') || (kind === 'audio' ? 'audio/mpeg' : kind === 'video' ? 'video/mp4' : 'application/octet-stream');
    return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, bytes: buf.length };
  } catch (e) { return null; }
}

app.get('/api/scripts/:id/export', async (req, res) => {
  const s = getScript(req.params.id); if (!s) return notFound(res);
  const ver = req.query.versionId ? getVersion(s, req.query.versionId) : s.versions.filter((v) => v.status === 'approved').slice(-1)[0];
  if (!ver) return bad(res, '没有可导出的版本');
  const embedResources = req.query.embedResources !== '0';

  // 本地 /assets 资源直接内嵌；外链尽力抓取，失败则列入人工核对
  const embedded = {};
  const manualResources = [];
  for (const r of ver.snapshot.resources || []) {
    let got = null;
    if (r.url && r.url.startsWith('/assets/')) {
      const fp = path.join(PUBLIC_DIR, r.url);
      if (fs.existsSync(fp)) {
        const buf = fs.readFileSync(fp);
        const ext = path.extname(fp).toLowerCase();
        const mime = ext === '.wav' ? 'audio/wav' : ext === '.mp3' ? 'audio/mpeg' : ext === '.mp4' ? 'video/mp4' : ext === '.png' ? 'image/png' : ext === '.jpg' ? 'image/jpeg' : 'application/octet-stream';
        got = { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, bytes: buf.length };
      }
    } else if (embedResources && r.embed !== false) {
      got = await fetchAsDataUrl(r.url, r.kind);
    }
    if (got) embedded[r.id] = got.dataUrl;
    else manualResources.push({ resourceId: r.id, name: r.name, url: r.url, kind: r.kind,
      reason: r.url && r.url.startsWith('/assets/') ? '本地资源缺失（导出时文件不存在）' : (r.embed === false ? '标记为不内嵌' : '外链无法在导出时获取（网络受限/无效地址）'),
      action: '现场开始前人工核对该资源可用，或准备替代手段（如人工口令）' });
  }

  const payload = {
    packageType: 'fire-drill-rehearsal-package',
    specVersion: 1,
    exportedAt: now(),
    script: { id: s.id, name: s.name, description: s.description },
    version: { id: ver.id, version: ver.version, status: ver.status, note: ver.note, approver: ver.approver, approvedAt: ver.approvedAt },
    content: ver.snapshot,
    embeddedResources: embedded,
    safetyNotice: '本包仅用于消防演练的组织、排练与内容呈现；不连接、不控制任何真实火灾报警、喷淋、广播等消防设施。视频/音频时间轴不代表人员疏散完成；阶段推进以被授权责任人的人工放行确认为准。超时仅产生提醒。',
    offlineConfirmHelp: '断网时确认动作保存在本机文件中；恢复网络后在主持端/现场页导入，迟到的确认会被标记为“迟到”，事实保留但不回改阶段状态。'
  };

  if (req.query.manifest === '1') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="drill-${s.id}-v${ver.version}-manifest.json"`);
    return res.json(buildManifest(s, ver, manualResources));
  }

  let html = fs.readFileSync(path.join(PUBLIC_DIR, 'player.html'), 'utf8');
  const marker = '/*__PACKAGE_JSON__*/null';
  if (!html.includes(marker)) return res.status(500).json({ error: 'player.html 缺少数据占位符' });
  html = html.replace(marker, '/*__PACKAGE_JSON__*/' + JSON.stringify(payload).replace(/<\/script/gi, '<\\/script'));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="fire-drill-v${ver.version}.html"`);
  res.send(html);
});

function buildManifest(s, ver, manualResources) {
  const mediaRefs = [];
  for (const st of ver.snapshot.stages || []) for (const m of st.media || []) {
    const r = (ver.snapshot.resources || []).find((x) => x.id === m.resourceId);
    mediaRefs.push({ stage: st.name, label: m.label, resourceId: m.resourceId, url: r ? r.url : null, required: r ? !!r.required : false, status: manualResources.some((x) => x.resourceId === m.resourceId) ? '需要人工核对' : '已内嵌' });
  }
  return {
    packageType: 'fire-drill-rehearsal-manifest',
    exportedAt: now(),
    script: { id: s.id, name: s.name },
    version: { version: ver.version, status: ver.status, approver: ver.approver, approvedAt: ver.approvedAt },
    stages: ver.snapshot.stages.map((st) => ({ key: st.key, name: st.name, durationSec: st.durationSec, timeoutSec: st.timeoutSec,
      gates: st.gates.map((g) => ({ label: g.label, authorizedRoleKey: g.authorizedRoleKey, note: g.note })),
      actions: st.actions.map((a) => ({ text: a.text, ownerRoleKey: a.ownerRoleKey })) })),
    resourceDependencies: (ver.snapshot.resources || []).map((r) => ({ resourceId: r.id, name: r.name, url: r.url, kind: r.kind, required: !!r.required,
      embedded: !manualResources.some((x) => x.resourceId === r.id) })),
    mediaReferences: mediaRefs,
    manualChecks: [
      ...(ver.snapshot.manualChecklist || []).map((text) => ({ text, source: '脚本人工核对项' })),
      ...manualResources.map((m) => ({ text: `核对资源「${m.name}」(${m.url}) — ${m.action}`, source: m.reason })),
      { text: '确认所有被授权责任人到场并知晓其放行条件', source: '系统项' },
      { text: '确认提示音等信号设备已试播；若缺失，现场指定替代口令并登记', source: '系统项' },
      { text: '确认演练与真实火警渠道隔离', source: '系统项' }
    ],
    switchPoints: ver.snapshot.switchPoints || [],
    safetyNotice: '不控制真实消防设施；时间轴不等于疏散完成；超时仅提醒，现场负责人判断不被自动替代。'
  };
}

/* 示例提示音（合成 wav） */
app.get('/assets/alert.wav', (req, res) => {
  const sampleRate = 22050, dur = 1.2, n = Math.floor(sampleRate * dur);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const beep = (t % 0.4) < 0.18 ? 1 : 0.2;
    const v = Math.sin(2 * Math.PI * 880 * t) * 0.35 * beep;
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  res.setHeader('Content-Type', 'audio/wav');
  res.send(buf);
});

app.use(express.static(PUBLIC_DIR));
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: '服务器内部错误' }); });

app.listen(PORT, () => {
  console.log(`消防演练排练工具已启动: http://localhost:${PORT}`);
  console.log(`主持端心跳超时阈值: ${HOST_STALE_MS}ms（可用 HOST_STALE_MS 环境变量调整）`);
});
