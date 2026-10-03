// 脚本编排与审核：草稿可改、提交后锁定、批准后成为不可变快照。
// “撤销编排”= 新建/回退草稿，绝不触碰 runs[].events（现场执行事实）。
import { uid } from './store.js';
import { ApiError, getScript, getVersion } from './engine.js';

const deepClone = (x) => JSON.parse(JSON.stringify(x));

export function createScript(db, body) {
  if (!body.name) throw new ApiError(400, 'bad_args', '脚本名称必填');
  const now = new Date().toISOString();
  const first = {
    id: uid('v'), version: 1, status: 'draft',
    createdAt: now, createdBy: body.createdBy || '编排员',
    note: body.note || '初稿',
    roles: body.roles || [],
    phases: body.phases?.length ? body.phases : [{
      id: uid('ph'), kind: 'alarm', name: '新阶段', plannedStartSec: 0, plannedDurationSec: 0,
      condition: { requireGate: true, requireConfirmedSteps: [], note: '' }, steps: [],
    }],
    switchPoints: body.switchPoints || [],
  };
  const scr = {
    id: uid('scr'), name: body.name, description: body.description || '',
    currentVersionId: null, versions: [first],
  };
  db.scripts.unshift(scr);
  return scr;
}

export function newDraft(db, scriptId, fromVersionId = null, by = '编排员', note = '') {
  const scr = getScript(db, scriptId);
  const base = fromVersionId ? getVersion(scr, fromVersionId) : [...scr.versions].sort((a, b) => b.version - a.version)[0];
  // 若已有草稿，直接返回（同脚本只保留一份草稿，避免混乱）
  const existing = scr.versions.find(v => v.status === 'draft');
  if (existing) return existing;
  const draft = deepClone(base);
  draft.id = uid('v');
  draft.version = Math.max(...scr.versions.map(v => v.version)) + 1;
  draft.status = 'draft';
  draft.createdAt = new Date().toISOString();
  draft.createdBy = by;
  draft.note = note || `基于 v${base.version} 的修订草稿`;
  delete draft.submittedAt; delete draft.approvedAt; delete draft.approvedBy;
  // 复制后重新生成步骤/阶段 id？——保留 id 以便 diff 对齐步骤
  scr.versions.push(draft);
  return draft;
}

export function updateDraft(db, scriptId, versionId, body, by = '编排员') {
  const scr = getScript(db, scriptId);
  const v = getVersion(scr, versionId);
  if (v.status !== 'draft') throw new ApiError(409, 'locked', '已提交/已批准版本不可修改（不可变快照）；请基于它新建草稿');
  if (body.phases) v.phases = sanitizePhases(body.phases);
  if (body.roles) v.roles = body.roles;
  if (body.switchPoints) v.switchPoints = body.switchPoints;
  if (typeof body.note === 'string') v.note = body.note;
  v.updatedBy = by; v.updatedAt = new Date().toISOString();
  validateVersion(v);
  return v;
}

function sanitizePhases(phases) {
  return phases.map(p => ({
    id: p.id || uid('ph'),
    kind: ['alarm', 'evacuation', 'assembly', 'review'].includes(p.kind) ? p.kind : 'alarm',
    name: p.name || '未命名阶段',
    plannedStartSec: Number(p.plannedStartSec) || 0,
    plannedDurationSec: Number(p.plannedDurationSec) || 0,
    condition: {
      requireGate: p.condition?.requireGate !== false,
      requireConfirmedSteps: p.condition?.requireConfirmedSteps || [],
      note: p.condition?.note || '',
    },
    steps: (p.steps || []).map(s => ({
      id: s.id || uid('s'),
      tSec: Number(s.tSec) || 0,
      kind: ['gate', 'broadcast', 'instruction', 'check', 'review'].includes(s.kind) ? s.kind : 'instruction',
      title: s.title || '未命名步骤',
      detail: s.detail || '',
      roleId: s.roleId || null,
      requiresConfirmation: s.requiresConfirmation !== false,
      timeoutSec: s.timeoutSec == null || s.timeoutSec === '' ? null : Number(s.timeoutSec),
      resources: s.resources || [],
      manualChecks: s.manualChecks || [],
      media: s.media || null,
    })),
  }));
}

function validateVersion(v) {
  const ids = new Set();
  for (const p of v.phases) {
    for (const s of p.steps) {
      if (ids.has(s.id)) throw new ApiError(400, 'dup_id', `步骤 id 重复：${s.id}`);
      ids.add(s.id);
    }
  }
  for (const p of v.phases) {
    for (const sid of p.condition?.requireConfirmedSteps || [])
      if (!ids.has(sid)) throw new ApiError(400, 'bad_dep', `阶段【${p.name}】依赖了不存在的步骤 ${sid}`);
  }
  for (const sp of v.switchPoints || [])
    if (!v.phases.some(p => p.id === sp)) throw new ApiError(400, 'bad_switchpoint', `切换点不存在：${sp}`);
}

export function submitDraft(db, scriptId, versionId, by) {
  const scr = getScript(db, scriptId);
  const v = getVersion(scr, versionId);
  if (v.status !== 'draft') throw new ApiError(409, 'locked', '只有草稿可以提交审核');
  validateVersion(v);
  v.status = 'submitted';
  v.submittedAt = new Date().toISOString();
  v.submittedBy = by || v.createdBy;
  return v;
}

export function approveVersion(db, scriptId, versionId, by, { setCurrent = true } = {}) {
  const scr = getScript(db, scriptId);
  const v = getVersion(scr, versionId);
  if (v.status !== 'submitted') throw new ApiError(409, 'bad_state', `只有“待审核”版本可批准（当前 ${v.status}）`);
  validateVersion(v);
  v.status = 'approved';
  v.approvedAt = new Date().toISOString();
  v.approvedBy = by || '审核人';
  if (setCurrent) scr.currentVersionId = v.id;
  // 注意：不改变任何进行中 run 的 versionId —— 新脚本只能在切换点生效
  return v;
}

export function rejectVersion(db, scriptId, versionId, by, reason = '') {
  const scr = getScript(db, scriptId);
  const v = getVersion(scr, versionId);
  if (v.status !== 'submitted') throw new ApiError(409, 'bad_state', '只有待审核版本可驳回');
  v.status = 'draft';
  v.rejectedAt = new Date().toISOString();
  v.rejectedBy = by; v.rejectReason = reason;
  return v;
}

// “撤销编排”：把最新已批准版本之外的草稿丢弃（或显式回退 currentVersionId）。
// 无论哪种撤销，都不删除任何 run/events；如果版本已被 run 引用，只允许废弃不允许删除。
export function discardDraft(db, scriptId, versionId) {
  const scr = getScript(db, scriptId);
  const v = getVersion(scr, versionId);
  if (v.status !== 'draft') throw new ApiError(409, 'locked', '只能丢弃草稿（已批准版本为不可变快照）');
  const usedByRuns = db.runs.some(r => r.scriptId === scriptId && r.events.some(e => e.detail?.versionId === v.id));
  if (usedByRuns) throw new ApiError(409, 'referenced', '该版本已有现场记录关联，不可删除（事实保留）');
  scr.versions = scr.versions.filter(x => x.id !== v.id);
  return { discarded: true };
}

export function archiveScript(db, scriptId) {
  const scr = getScript(db, scriptId);
  if (db.runs.some(r => r.scriptId === scriptId && r.status !== 'completed'))
    throw new ApiError(409, 'active_run', '存在进行中的排练，不能归档脚本（执行记录仍保留）');
  scr.archived = true;
  scr.archivedAt = new Date().toISOString();
  return scr;
}
