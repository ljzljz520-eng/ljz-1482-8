// 排练引擎（纯内存计算 + 持久化由调用方负责）。
// 核心原则：
//  1) 时钟到达/超时只产生“预设提醒”，绝不自动放行、绝不自动确认人工项；
//  2) 阶段进入必须满足条件并由在线主持人“人工放行”；
//  3) events 只追加：现场已执行动作是事实，迟到的离线确认仍被接收（标记 late）；
//  4) 新版本只能在已批准的切换点（阶段边界）生效，已执行事实不被改写。
import { uid } from './store.js';

export const LEASE_MS = 30_000;

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status; this.code = code; Object.assign(this, extra);
  }
}

export const getScript = (db, id) => db.scripts.find(s => s.id === id)
  || (() => { throw new ApiError(404, 'not_found', '脚本不存在'); })();

export const getVersion = (script, vid) =>
  script.versions.find(v => v.id === vid)
  || (() => { throw new ApiError(404, 'not_found', '版本不存在'); })();

export const roleMap = (db) => Object.fromEntries(db.roles.map(r => [r.id, r]));

export function createRun(db, { scriptId, versionId, mode = 'clock', name = '', clientId = null, hostName = '' }) {
  const script = getScript(db, scriptId);
  const ver = versionId ? getVersion(script, versionId)
    : getVersion(script, script.currentVersionId);
  if (ver.status !== 'approved')
    throw new ApiError(409, 'version_not_approved', '只有已批准版本才能开排，草稿请先提交并批准');
  if (!['clock', 'host'].includes(mode)) throw new ApiError(400, 'bad_mode', 'mode 只能是 clock/host');

  const now = new Date().toISOString();
  const run = {
    id: uid('run'),
    name: name || `${script.name} · ${new Date().toLocaleString('zh-CN')}`,
    scriptId,
    baselineVersionId: ver.id, // 开排时的版本：计划修订始终以它为基线
    versionId: ver.id,
    mode,
    status: 'created', // created | running | paused | completed
    createdAt: now,
    createdBy: hostName || '未署名',
    timeline: { startedAt: null, pausedAt: null, completedAt: null, elapsedMs: 0, pauses: [] },
    host: null, // {clientId,name,leaseUntil}
    phases: {},
    steps: {},  // stepId -> 事实状态（confirmed 等），切换版本后保留
    fired: {},  // 已触发提醒去重
    events: [], // 只追加
  };
  for (const p of ver.phases) run.phases[p.id] = { status: 'pending', releasedAt: null, releasedBy: null };
  for (const p of ver.phases) for (const s of p.steps)
    run.steps[s.id] = { status: 'pending' };

  append(run, 'run_created', hostName || 'system', clientId,
    { mode, versionId: ver.id, version: ver.version });
  // 创建即申领主持租约
  if (clientId) claimHost(db, run, { clientId, name: hostName || '主持人', force: false }, new Date());
  db.runs.unshift(run);
  return run;
}

export function append(run, type, by, clientId, detail = {}, extra = {}) {
  const ev = { id: uid('ev'), at: new Date().toISOString(), type, by: by || 'system', clientId: clientId || null, detail, ...extra };
  run.events.push(ev);
  return ev;
}

export function elapsedMs(run, nowMs) {
  const t = run.timeline;
  if (run.status === 'completed') return t.elapsedMs;
  if (!t.startedAt) return 0;
  const startMs = Date.parse(t.startedAt);
  const pausedTotal = t.pauses.reduce((a, p) => a + (Date.parse(p.to ?? t.pausedAt ?? nowMs) - Date.parse(p.from)), 0);
  const end = run.status === 'paused' ? Date.parse(t.pausedAt) : nowMs;
  return Math.max(0, end - startMs - pausedTotal);
}

// ---------- 主持租约 ----------
export function hostValid(run, now) {
  return !!(run.host && Date.parse(run.host.leaseUntil) > now.getTime());
}

function markExpired(run) {
  if (run.host && !hostValid(run, new Date())) {
    append(run, 'host_expired', run.host.name, run.host.clientId,
      { leaseUntil: run.host.leaseUntil, note: '主持租约超时（可能主持端崩溃/断网）' });
    run.host = null;
  }
}

export function claimHost(db, run, { clientId, name, force = false }, now) {
  if (!clientId) throw new ApiError(400, 'bad_client', '缺少设备标识 clientId');
  const incumbent = run.host;
  if (incumbent && incumbent.clientId !== clientId && hostValid(run, now)) {
    if (!force)
      throw new ApiError(409, 'host_contended', '已有主持人持有推进权限', {
        holder: { name: incumbent.name, clientId: incumbent.clientId, leaseUntil: incumbent.leaseUntil },
      });
    append(run, 'host_taken_over', name, clientId,
      { from: incumbent.name, fromClientId: incumbent.clientId, reason: '强制接管' });
  } else if (incumbent && incumbent.clientId !== clientId && !hostValid(run, now)) {
    // 旧主持租约已过期：记录失效事实后由新设备接管
    markExpired(run);
  }
  const first = !run.host || run.host.clientId !== clientId;
  run.host = { clientId, name: name || incumbent?.name || '主持人', leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString() };
  if (first || force) append(run, 'host_claimed', run.host.name, clientId, { force });
  return run.host;
}

export function heartbeat(run, clientId, now) {
  if (!run.host || run.host.clientId !== clientId || !hostValid(run, now)) {
    markExpired(run);
    throw new ApiError(423, 'host_lost', '主持租约不存在或已过期（可能崩溃后被接管）');
  }
  run.host.leaseUntil = new Date(now.getTime() + LEASE_MS).toISOString();
  return run.host;
}

export function releaseHost(run, clientId) {
  if (run.host?.clientId === clientId) {
    append(run, 'host_released', run.host.name, clientId, {});
    run.host = null;
  }
}

function ensureHost(run, clientId, now) {
  if (!hostValid(run, now)) {
    if (run.host) append(run, 'host_expired', run.host.name, run.host.clientId,
      { leaseUntil: run.host.leaseUntil });
    run.host = null;
    throw new ApiError(423, 'host_lost', '主持人已离线超时，租约失效，请由他人接管');
  }
  if (run.host.clientId !== clientId) throw new ApiError(409, 'host_other', '推进权限在另一台设备上');
}

// ---------- 阶段/步骤查询 ----------
export function phaseIndex(ver, phid) { return ver.phases.findIndex(p => p.id === phid); }
export function stepLocation(ver, stepId) {
  for (let i = 0; i < ver.phases.length; i++) {
    const j = ver.phases[i].steps.findIndex(s => s.id === stepId);
    if (j >= 0) return { phase: ver.phases[i], phaseIdx: i, step: ver.phases[i].steps[j], stepIdx: j };
  }
  return null;
}

export function conditionsMet(run, ver, phase) {
  const missing = [];
  for (const sid of phase.condition?.requireConfirmedSteps || []) {
    if (run.steps[sid]?.status !== 'confirmed') {
      const loc = stepLocation(ver, sid);
      missing.push({ stepId: sid, title: loc?.step.title || sid });
    }
  }
  return { ok: missing.length === 0, missing };
}

// ---------- 主持动作 ----------
export function startRun(db, run, clientId, now) {
  const nowD = now ?? new Date();
  ensureHost(run, clientId, nowD);
  if (run.status !== 'created') throw new ApiError(409, 'bad_state', `当前状态 ${run.status}，不能开始`);
  const ver = getVersion(getScript(db, run.scriptId), run.versionId);
  run.status = 'running';
  run.timeline.startedAt = nowD.toISOString();
  append(run, 'run_started', run.host.name, clientId,
    { clockMode: run.mode, note: run.mode === 'clock'
      ? '统一时钟模式：时间线驱动“到期/超时提醒”，但阶段仍须人工放行'
      : '主持人事件模式：以主持人放行/确认事件推进，计划时间仅作参照' });
  // 首阶段在开排时由主持人放行（事实记录）
  const first = ver.phases[0];
  run.phases[first.id] = { status: 'active', releasedAt: nowD.toISOString(), releasedBy: run.host.name };
  append(run, 'phase_released', run.host.name, clientId,
    { phaseId: first.id, phaseName: first.name, automatic: '开排即放行首阶段' });
  tick(db, run, nowD);
}

export function pauseRun(db, run, clientId, reason, now = new Date()) {
  ensureHost(run, clientId, now);
  if (run.status !== 'running') throw new ApiError(409, 'bad_state', '只有进行中才能暂停');
  run.status = 'paused';
  run.timeline.pausedAt = now.toISOString();
  append(run, 'run_paused', run.host.name, clientId, { reason: reason || '主持人暂停' });
}

export function resumeRun(db, run, clientId, now = new Date()) {
  ensureHost(run, clientId, now);
  if (run.status !== 'paused') throw new ApiError(409, 'bad_state', '只有暂停态才能继续');
  run.timeline.pauses.push({ from: run.timeline.pausedAt, to: now.toISOString() });
  run.timeline.pausedAt = null;
  run.status = 'running';
  append(run, 'run_resumed', run.host.name, clientId, {});
  tick(db, run, now);
}

export function completeRun(db, run, clientId, now = new Date()) {
  ensureHost(run, clientId, now);
  if (run.status === 'completed') throw new ApiError(409, 'bad_state', '排练已结束');
  if (run.status === 'created') throw new ApiError(409, 'bad_state', '尚未开始');
  run.timeline.elapsedMs = elapsedMs(run, now.getTime());
  if (run.status === 'paused') run.timeline.pauses.push({ from: run.timeline.pausedAt, to: now.toISOString() });
  run.status = 'completed';
  run.timeline.completedAt = now.toISOString();
  append(run, 'run_completed', run.host.name, clientId, { elapsedMs: run.timeline.elapsedMs });
}

export function releasePhase(db, run, phaseId, clientId, now = new Date()) {
  ensureHost(run, clientId, now);
  if (run.status !== 'running') throw new ApiError(409, 'bad_state', '只有进行中才能放行阶段');
  const ver = getVersion(getScript(db, run.scriptId), run.versionId);
  const idx = ver.phases.findIndex(p => p.id === phaseId);
  if (idx < 0) throw new ApiError(404, 'no_phase', '阶段不存在');
  const phase = ver.phases[idx];
  const st = run.phases[phaseId];
  if (st?.status === 'active') throw new ApiError(409, 'already_active', '该阶段已放行');
  if (st?.status === 'completed') throw new ApiError(409, 'already_done', '该阶段已完成');
  // 必须按顺序放行
  for (let i = 0; i < idx; i++) {
    if (run.phases[ver.phases[i].id]?.status !== 'completed')
      throw new ApiError(409, 'order', `须先完成并越过前序阶段：${ver.phases[i].name}`);
  }
  // 阶段条件
  if (phase.condition?.requireGate) {
    const c = conditionsMet(run, ver, phase);
    if (!c.ok) throw new ApiError(412, 'condition_unmet',
      '阶段条件未满足，禁止放行（时钟到点也不能替代）', { missing: c.missing });
  }
  run.phases[phaseId] = { status: 'active', releasedAt: now.toISOString(), releasedBy: run.host.name };
  append(run, 'phase_released', run.host.name, clientId,
    { phaseId, phaseName: phase.name, condition: phase.condition?.note || '' });
  tick(db, run, now);
}

// ---------- 阶段完成物化 ----------
// 阶段完成的含义：该阶段全部步骤都有事实确认（人工确认或脚本预设无需确认项的自动标记）。
// 这是“事实齐备”的结果，不是时间到点的自动跳转；进入下一阶段仍需人工放行。
export function materializePhases(db, run, ver, now) {
  for (const p of ver.phases) {
    const st = run.phases[p.id];
    if (st?.status === 'active' && p.steps.length && p.steps.every(s => run.steps[s.id]?.status === 'confirmed')) {
      st.status = 'completed';
      st.completedAt = now.toISOString();
      append(run, 'phase_completed', run.host?.name || 'system', run.host?.clientId || null,
        { phaseId: p.id, phaseName: p.name,
          note: '该阶段全部步骤已有人工/事实确认——阶段完成；进入下一阶段仍须人工放行' });
    }
  }
}

// ---------- 确认（事实） ----------
export function confirmStep(db, run, { stepId, by, roleId, clientId, note = '', offline = false, localAt = null }, now = new Date()) {
  if (!stepId || !by) throw new ApiError(400, 'bad_args', '缺少 stepId/by');
  if (run.status === 'created') throw new ApiError(409, 'not_started', '排练尚未开始');
  if (run.status === 'paused') throw new ApiError(409, 'paused', '排练已暂停：暂停期间不接受新确认（现场继续后再报；离线可在设备本地排队）');
  const script = getScript(db, run.scriptId);
  const ver = getVersion(script, run.versionId);
  const loc = stepLocation(ver, stepId);
  // 事实可能来自旧版本已移除的步骤：仍接收（append-only），标记 unknownToPlan
  const allVersions = script.versions;
  const historic = !loc ? allVersions.map(v => stepLocation(v, stepId)).find(Boolean) : null;
  if (!loc && !historic) throw new ApiError(404, 'no_step', '步骤在任何版本中都不存在');
  const ref = loc || historic;

  // 幂等：同一设备同一本地时间戳的重复提交（离线重发优先于“已确认”冲突）
  const dedupeKey = `${clientId}|${localAt || ''}|${stepId}`;
  const existed = localAt
    ? run.events.find(e => e.type === 'step_confirmed' && e.detail?.dedupeKey === dedupeKey)
    : null;
  if (existed) return { duplicated: true, event: existed };
  if (run.steps[stepId]?.status === 'confirmed')
    throw new ApiError(409, 'already_confirmed', '该步骤已有确认记录（事实不可覆盖）');

  const activeIdx = ver.phases.findIndex(p => run.phases[p.id]?.status === 'active');
  // “迟到”：确认的事实属于已越过的阶段，或排练已结束（典型：离线设备重连后才上传）。
  // “提前”：事实指向尚未放行的阶段（系统仍作为事实接收，但明确标注，供主持人甄别）。
  const late = run.status === 'completed' || (activeIdx >= 0 && ref.phaseIdx < activeIdx);
  const early = !late && (ref.phaseIdx > activeIdx || run.phases[ref.phase.id]?.status === 'pending');

  run.steps[stepId] = {
    status: 'confirmed', confirmedAt: now.toISOString(), by, roleId: roleId || ref.step.roleId,
    clientId, note, offline: !!offline, localAt, late, early,
  };
  const ev = append(run, 'step_confirmed', by, clientId, {
    stepId, title: ref.step.title, tSec: ref.step.tSec,
    roleId: roleId || ref.step.roleId, roleName: db.roles.find(r => r.id === (roleId || ref.step.roleId))?.name || '',
    phaseId: ref.phase.id, versionId: ver.id, version: ver.version,
    gate: ref.step.kind === 'gate', note, dedupeKey,
    knownToPlan: !!loc, early,
  }, { offline: !!offline, localAt: localAt || null, late, early });
  tick(db, run, now);
  return { duplicated: false, event: ev, late };
}

// ---------- 版本切换（仅切换点） ----------
export function switchVersion(db, run, versionId, clientId, now = new Date()) {
  ensureHost(run, clientId, now);
  const script = getScript(db, run.scriptId);
  const target = getVersion(script, versionId);
  if (target.status !== 'approved')
    throw new ApiError(409, 'version_not_approved', '新版本必须已批准才能生效');
  const cur = getVersion(script, run.versionId);
  if (target.id === cur.id) throw new ApiError(409, 'same_version', '已在使用该版本');

  // 找“下一个尚未完成”的阶段
  let next = null;
  for (const p of cur.phases) {
    const st = run.phases[p.id]?.status;
    if (st !== 'completed') { next = p; break; }
  }
  const atStart = run.status === 'created';
  const atBoundary = next && run.phases[next.id]?.status === 'pending' &&
    (target.switchPoints || []).includes(next.id);
  if (!atStart && !atBoundary)
    throw new ApiError(409, 'not_switch_point',
      '新脚本只能在批准的切换点（阶段放行门之前）生效；当前阶段已放行或该边界不是切换点',
      { nextPhase: next ? { id: next.id, name: next.name, status: run.phases[next.id]?.status } : null,
        switchPoints: target.switchPoints || [] });

  const fromId = run.versionId;
  run.versionId = target.id;
  for (const p of target.phases) {
    if (!run.phases[p.id]) run.phases[p.id] = { status: 'pending', releasedAt: null, releasedBy: null };
    for (const s of p.steps) if (!run.steps[s.id]) run.steps[s.id] = { status: 'pending' };
  }
  append(run, 'version_switched', run.host.name, clientId, {
    fromVersionId: fromId, fromVersion: cur.version,
    toVersionId: target.id, toVersion: target.version,
    switchPoint: atStart ? 'before_start' : next.id,
    note: '已执行事实保留；差异见“已执行/待确认/计划修订”',
  });
  tick(db, run, now);
}

// ---------- 时钟滴答：只做“自动标记无需确认项”与“提醒”，不放行、不确认人工项 ----------
export function tick(db, run, now = new Date()) {
  if (run.status !== 'running') return;
  const script = getScript(db, run.scriptId);
  const ver = getVersion(script, run.versionId);
  const sec = Math.floor(elapsedMs(run, now.getTime()) / 1000);

  for (const p of ver.phases) {
    const pst = run.phases[p.id];
    if (pst?.status === 'active') {
      for (const s of p.steps) {
        const st = run.steps[s.id];
        // 仅作者明确标注“无需确认”的步骤，时间到了才自动标记；人工项永不自动确认
        if (!s.requiresConfirmation && !st?.confirmedAt && sec >= s.tSec) {
          run.steps[s.id] = { status: 'confirmed', confirmedAt: now.toISOString(), by: 'system', roleId: s.roleId, auto: true };
          append(run, 'step_confirmed', 'system', null, {
            stepId: s.id, title: s.title, tSec: s.tSec, roleId: s.roleId,
            roleName: db.roles.find(r => r.id === s.roleId)?.name || '',
            phaseId: p.id, versionId: ver.id, auto: true,
            note: '脚本预设无需人工确认；时间线仅对该类条目自动标记',
          });
        }
      }
    }
  }
  materializePhases(db, run, ver, now);
}

// ---------- 实时视图 ----------
export function view(db, run, now = new Date()) {
  const script = getScript(db, run.scriptId);
  const ver = getVersion(script, run.versionId);
  const ms = elapsedMs(run, now.getTime());
  const sec = Math.floor(ms / 1000);
  const reminders = [];
  const fire = (key, r) => {
    if (!run.fired[key]) run.fired[key] = now.toISOString();
    reminders.push({ key, firedAt: run.fired[key], ...r });
  };

  const phases = ver.phases.map((p, pi) => {
    let status = run.phases[p.id]?.status || 'pending';
    const steps = p.steps.map(s => {
      const fact = run.steps[s.id];
      const confirmed = fact?.status === 'confirmed';
      const active = status === 'active';
      const due = active && run.status === 'running' && sec >= s.tSec;
      const overdue = !!(due && !confirmed && s.timeoutSec != null && sec > s.tSec + s.timeoutSec);
      return { ...s, phaseId: p.id, phaseIdx: pi,
        status: confirmed ? 'confirmed' : (overdue ? 'overdue' : (due ? 'due' : 'pending')),
        fact: fact || null, due, overdue,
        roleName: db.roles.find(r => r.id === s.roleId)?.name || '未指派' };
    });
    if (status === 'active' && steps.length && steps.every(s => s.status === 'confirmed')) {
      status = 'completed'; // 派生：每个步骤都有人工/事实确认才算完成
    }
    const cond = conditionsMet(run, ver, p);
    return { ...p, status, steps, conditionMet: cond.ok, conditionMissing: cond.missing,
      releasedAt: run.phases[p.id]?.releasedAt || null, releasedBy: run.phases[p.id]?.releasedBy || null,
      tentative: status === 'pending' };
  });

  // 提醒（预设，不替代判断）
  if (run.status === 'running') {
    for (const p of phases) {
      if (p.status === 'pending' && sec >= p.plannedStartSec) {
        if (p.conditionMet)
          fire(`phaseReady:${p.id}`, { level: 'info', kind: 'phase_ready',
            text: `已到【${p.name}】计划开始时间，阶段条件已满足 —— 等待在线主持人人工放行`, phaseId: p.id });
        else
          fire(`phaseBlocked:${p.id}`, { level: 'warning', kind: 'phase_blocked',
            text: `已到【${p.name}】计划开始时间，但条件未满足，不得按时间自动放行`, phaseId: p.id,
            missing: p.conditionMissing });
      }
      if (p.status === 'active') {
        for (const s of p.steps) {
          if (s.overdue)
            fire(`overdue:${s.id}`, { level: 'danger', kind: 'overdue',
              text: `超时提醒：【${s.title}】超过预设 ${s.timeoutSec}s 仍未确认。仅提醒，不自动推进、不自动替代现场负责人判断。`,
              phaseId: p.id, stepId: s.id });
        }
      }
    }
  }

  const counts = { confirmed: 0, pending: 0, overdue: 0, due: 0 };
  for (const p of phases) for (const s of p.steps) {
    if (s.status === 'confirmed') counts.confirmed++;
    else if (s.status === 'overdue') { counts.overdue++; counts.pending++; }
    else if (s.status === 'due') { counts.due++; counts.pending++; }
    else counts.pending++;
  }

  return {
    ...run,
    scriptName: script.name,
    version: { id: ver.id, version: ver.version, status: ver.status, note: ver.note },
    clock: { ms, sec, status: run.status },
    phases, counts, reminders,
    hostLive: hostValid(run, now),
    now: now.toISOString(),
  };
}

// ---------- 差异：已执行 / 待确认 / 计划修订 ----------
export function buildDiff(db, run, compareVersionId) {
  const script = getScript(db, run.scriptId);
  const plan = getVersion(script, run.baselineVersionId || run.versionId); // 基线=开排版本
  const compare = compareVersionId ? getVersion(script, compareVersionId)
    : getVersion(script, run.versionId); // 默认对比当前执行版本（可能已切换）
  const rm = roleMap(db);

  const facts = run.events.filter(e => e.type === 'step_confirmed')
    .map(e => ({ ...e.detail, at: e.at, by: e.by, offline: e.offline, late: e.late, localAt: e.localAt }));

  const cmpSteps = new Map();
  for (const p of compare.phases) for (const s of p.steps) cmpSteps.set(s.id, { ...s, phaseId: p.id, phaseName: p.name });
  const planSteps = new Map();
  for (const p of plan.phases) for (const s of p.steps) planSteps.set(s.id, { ...s, phaseId: p.id, phaseName: p.name });

  const executed = facts.map(f => {
    const inCompare = cmpSteps.get(f.stepId);
    return { ...f, roleNameAtExec: f.roleName || rm[f.roleId]?.name || '',
      changedInCompare: inCompare && inCompare.roleId !== f.roleId
        ? { field: '责任人', from: rm[f.roleId]?.name, to: rm[inCompare.roleId]?.name } : null };
  });

  const pending = [];
  // 待确认：按“当前执行版本”（run.versionId）的计划计算
  const curSteps = new Map();
  for (const p of getVersion(script, run.versionId).phases)
    for (const s of p.steps) curSteps.set(s.id, { ...s, phaseId: p.id, phaseName: p.name });
  const v = view(db, run);
  for (const [sid, s] of curSteps) {
    if (!run.steps[sid]?.confirmedAt) {
      const live = v.phases.find(p => p.id === s.phaseId)?.steps.find(x => x.id === sid);
      pending.push({ stepId: sid, title: s.title, phaseId: s.phaseId, phaseName: s.phaseName,
        tSec: s.tSec, kind: s.kind, gate: s.kind === 'gate',
        requiresConfirmation: s.requiresConfirmation, timeoutSec: s.timeoutSec,
        roleId: s.roleId, roleName: rm[s.roleId]?.name || '未指派',
        liveStatus: live?.status || 'tentative', tentative: !live });
    }
  }

  const planChanges = [];
  const fieldLabels = { roleId: '责任人', tSec: '计划时间', title: '内容', timeoutSec: '超时时限', requiresConfirmation: '是否需确认' };
  for (const [sid, ns] of cmpSteps) {
    const os = planSteps.get(sid);
    if (!os) { planChanges.push({ stepId: sid, kind: 'added', title: ns.title, phaseName: ns.phaseName,
      roleName: rm[ns.roleId]?.name, executed: !!run.steps[sid]?.confirmedAt }); continue; }
    for (const f of Object.keys(fieldLabels)) {
      if (JSON.stringify(ns[f]) !== JSON.stringify(os[f])) {
        const fmt = (v) => f === 'roleId' ? (rm[v]?.name || '未指派')
          : f === 'tSec' ? `${v}s` : f === 'timeoutSec' ? (v == null ? '无' : `${v}s`)
          : f === 'requiresConfirmation' ? (v ? '需人工确认' : '无需确认') : String(v);
        planChanges.push({ stepId: sid, kind: 'modified', field: fieldLabels[f],
          title: ns.title, phaseName: ns.phaseName, from: fmt(os[f]), to: fmt(ns[f]),
          executed: !!run.steps[sid]?.confirmedAt });
      }
    }
  }
  for (const [sid, os] of planSteps) {
    if (!cmpSteps.has(sid))
      planChanges.push({ stepId: sid, kind: 'removed', title: os.title, phaseName: os.phaseName,
        executed: !!run.steps[sid]?.confirmedAt,
        note: run.steps[sid]?.confirmedAt ? '已有现场执行事实：撤销编排不会删除执行记录，仅在新计划中移除' : '' });
  }

  const factsWithoutPlan = facts.filter(f => !cmpSteps.has(f.stepId));

  // 资源依赖 & 人工核对项（按对比版本汇总）
  const resById = Object.fromEntries(db.resources.map(r => [r.id, r]));
  const resources = new Map();
  const manualChecks = [];
  for (const p of compare.phases) for (const s of p.steps) {
    for (const rid of s.resources || []) {
      const r = resById[rid];
      if (r && !resources.has(rid)) resources.set(rid, { ...r, usedBy: [] });
      if (r) resources.get(rid).usedBy.push(s.title);
    }
    for (const c of s.manualChecks || [])
      manualChecks.push({ stepId: s.id, title: s.title, phaseName: p.name, check: c,
        done: !!run.steps[s.id]?.confirmedAt, gate: s.kind === 'gate' });
  }

  return {
    planVersion: { id: plan.id, version: plan.version, status: plan.status },
    compareVersion: { id: compare.id, version: compare.version, status: compare.status },
    executed, pending, planChanges, factsWithoutPlan,
    resources: [...resources.values()],
    missingResources: [...resources.values()].filter(r => !r.present),
    manualChecks,
  };
}
