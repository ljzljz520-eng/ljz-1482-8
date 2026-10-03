// 初始化演示数据：角色、资源依赖（含一个“缺失提示音”）、
// v1 已批准脚本（报警/疏散/集合/复盘四阶段，阶段条件+人工放行门）、
// v2 草稿（责任人变更），用于验收“新版本改变责任人”。
import { get, save, uid } from './store.js';

export function seed(force = false) {
  const db = get();
  if (db.roles.length && !force) return db;
  if (force) { db.roles = []; db.scripts = []; db.runs = []; db.resources = []; }

  const R = (name, owner, contact) => ({ id: uid('r'), name, owner, contact });
  const roles = [
    R('现场总指挥', '张磊', '内线 8001'),
    R('主持人/安全官', '王敏', '内线 8002'),
    R('门卫·报警核实', '周涛', '门卫室'),
    R('一层疏散引导员', '李强', '一区'),
    R('二层疏散引导员', '赵丽', '二区'),
    R('集合点清点员', '陈晨', '操场集合点'),
    R('评估复盘员', '孙毅', '观摩席'),
  ];
  db.roles = roles;
  const [rFire, rHost, rGuard, rF1, rF2, rAsm, rObs] = roles.map(r => r.id);

  db.resources = [
    { id: uid('res'), name: '演练警报提示音(10s).mp3', kind: 'audio', url: '', present: false,
      note: '设备未就绪——验收场景：提示音缺失，需以口头口令替代' },
    { id: uid('res'), name: '疏散广播词.pdf', kind: 'doc', url: '', present: true, note: '' },
    { id: uid('res'), name: '手摇报警器/哨子', kind: 'tool', url: '', present: true, note: '' },
    { id: uid('res'), name: '人员清点表.xlsx', kind: 'doc', url: '', present: true, note: '' },
  ];
  const [resAlarm, resBcast, resWhistle, resSheet] = db.resources.map(r => r.id);

  const step = (id, tSec, kind, title, roleId, extra = {}) => ({
    id, tSec, kind, title, detail: '', roleId,
    requiresConfirmation: true, timeoutSec: null,
    resources: [], manualChecks: [], media: null, ...extra,
  });

  const phases = [
    {
      id: 'ph_alarm', kind: 'alarm', name: '① 报警',
      plannedStartSec: 0, plannedDurationSec: 120,
      condition: { requireGate: true, requireConfirmedSteps: [],
        note: '演练开始即人工放行；须先确认属演练性质，严禁误触真实报警系统' },
      steps: [
        step('s1', 0, 'gate', '授权发出演练警报（人工放行）', rGuard, {
          detail: '本工具只呈现脚本，不连接、不触发任何真实消防设施。',
          timeoutSec: 60, media: { type: 'audio', resourceId: resAlarm },
          resources: [resAlarm, resWhistle],
          manualChecks: ['确认警报为演练性质，现场无真实火情', '提示音缺失时改用哨音+口头口令'],
        }),
        step('s2', 30, 'broadcast', '播放疏散广播', rHost, {
          detail: '广播词：请注意，现在进行消防疏散演练，请沿最近安全出口有序撤离。',
          resources: [resBcast], timeoutSec: 60,
        }),
        step('s3', 60, 'check', '核实模拟报警按钮已按下并记录', rGuard, {
          manualChecks: ['仅为模拟登记，不得操作真实火灾报警按钮'],
        }),
      ],
    },
    {
      id: 'ph_evac', kind: 'evacuation', name: '② 疏散',
      plannedStartSec: 120, plannedDurationSec: 300,
      condition: { requireGate: true, requireConfirmedSteps: ['s3'],
        note: '放行条件：报警阶段 s3 已确认；未确认时主持人不得放行' },
      steps: [
        step('s4', 120, 'instruction', '一层引导员就位、开启疏散通道', rF1),
        step('s5', 150, 'instruction', '二层引导员就位、控制下楼秩序', rF2),
        step('s6', 300, 'check', '确认全部人员已离开办公区', rF1, {
          detail: '必须逐房间人工清点。监控视频/录像播放到某个时间点，不代表人员已完成疏散。',
          timeoutSec: 120,
          manualChecks: ['逐房间清点并签字', '不得以视频播放进度或监控画面替代人工确认'],
        }),
        step('s7', 360, 'instruction', '协助行动不便人员撤离', rF2, { timeoutSec: 90 }),
      ],
    },
    {
      id: 'ph_asm', kind: 'assembly', name: '③ 集合',
      plannedStartSec: 420, plannedDurationSec: 180,
      condition: { requireGate: true, requireConfirmedSteps: ['s6'],
        note: '放行条件：s6“人员已离开办公区”经人工确认' },
      steps: [
        step('s8', 420, 'instruction', '集合点列队、按部门整队', rAsm),
        step('s9', 480, 'check', '清点人数并向总指挥上报', rAsm, {
          timeoutSec: 90, resources: [resSheet],
          manualChecks: ['清点表签字：应到/实到/未到人数及处置'],
        }),
        step('s10', 540, 'gate', '总指挥确认疏散完成（人工放行）', rFire, {
          manualChecks: ['人数齐全或失联人员已有明确搜救安排'],
        }),
      ],
    },
    {
      id: 'ph_review', kind: 'review', name: '④ 复盘',
      plannedStartSec: 600, plannedDurationSec: 300,
      condition: { requireGate: true, requireConfirmedSteps: ['s10'],
        note: '放行条件：总指挥已确认疏散完成' },
      steps: [
        step('s11', 600, 'review', '收集各阶段实际用时与偏差', rObs),
        step('s12', 660, 'review', '问题登记（提示音缺失、迟到确认等）', rObs, {
          manualChecks: ['逐条记录资源缺失与人工替代措施'],
        }),
        step('s13', 720, 'review', '主持人总结并宣布演练结束', rHost, {
          requiresConfirmation: false,
        }),
      ],
    },
  ];

  const now = new Date();
  const v1 = {
    id: uid('v'), version: 1, status: 'approved',
    createdAt: now.toISOString(), createdBy: '系统',
    submittedAt: now.toISOString(), approvedAt: now.toISOString(), approvedBy: '安全员·王敏',
    note: '首次批准版本', roles: roles.map(r => r.id), phases,
    switchPoints: ['ph_evac', 'ph_asm', 'ph_review'], // 批准的切换点：阶段放行门
  };

  // v2 草稿：s9 责任人变更（集合点清点员 → 总指挥），新增一条步骤，s12 修订。
  const phases2 = structuredClone(phases);
  phases2.find(p => p.id === 'ph_asm').steps.find(s => s.id === 's9').roleId = rFire;
  phases2.find(p => p.id === 'ph_asm').steps.find(s => s.id === 's9').detail =
    'v2 修订：改由现场总指挥亲自清点上报（原责任人为集合点清点员）。';
  phases2.find(p => p.id === 'ph_review').steps.push(
    step('s14', 750, 'review', '新增：疏散路线瓶颈讨论', rObs, {
      manualChecks: ['记录至少两处拥堵点'],
    })
  );
  const v2 = {
    id: uid('v'), version: 2, status: 'draft',
    createdAt: now.toISOString(), createdBy: '编排员',
    note: '责任人变更：s9 清点上报改由总指挥承担；新增复盘议题 s14。尚未提交批准。',
    roles: roles.map(r => r.id), phases: phases2,
    switchPoints: ['ph_evac', 'ph_asm', 'ph_review'],
  };

  db.scripts.push({
    id: uid('scr'), name: '年度消防疏散演练（办公楼）',
    description: '报警 → 疏散 → 集合 → 复盘。仅用于组织排练与内容呈现，不控制真实消防设施。',
    currentVersionId: v1.id, versions: [v1, v2],
  });

  save();
  console.log('seeded:', db.scripts[0].id, db.scripts[0].versions[0].id);
  return db;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed(true);
}
