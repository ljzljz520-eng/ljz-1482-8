// 离线脚本包：
//  - JSON 包：脚本版本快照 + 资源依赖（标注缺失）+ 人工核对项 + 免责声明
//  - 单文件 HTML 播放器：内嵌数据，现场设备下载后断网可看，不写回服务器，不控制任何设施。
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function buildExportPackage(db, script, ver) {
  const resById = Object.fromEntries(db.resources.map(r => [r.id, r]));
  const roles = ver.roles.map(rid => db.roles.find(r => r.id === rid)).filter(Boolean);
  const resourceDeps = new Map();
  const manualChecks = [];
  for (const p of ver.phases) for (const s of p.steps) {
    for (const resId of s.resources || []) {
      if (!resourceDeps.has(resId)) resourceDeps.set(resId, { resource: resById[resId] || { id: resId, name: '(已删除资源)', present: false }, usedBy: [] });
      resourceDeps.get(resId).usedBy.push(s.title);
    }
    for (const c of s.manualChecks || [])
      manualChecks.push({ phase: p.name, step: s.title, gate: s.kind === 'gate', check: c });
  }
  return {
    packageKind: 'fire-drill-script-package',
    packageVersion: 1,
    exportedAt: new Date().toISOString(),
    disclaimer: [
      '本包仅用于消防演练的组织排练与内容呈现，不连接、不控制任何真实消防设施。',
      '阶段进入需要满足条件并由主持人/负责人人工放行；视频或时间线到点不等于人员已完成疏散。',
      '超时仅产生预设提醒，不自动推进、不替代现场负责人判断。',
    ],
    script: { id: script.id, name: script.name, description: script.description },
    version: { id: ver.id, version: ver.version, approvedAt: ver.approvedAt, approvedBy: ver.approvedBy,
      note: ver.note, switchPoints: ver.switchPoints },
    roles,
    phases: ver.phases,
    resourceDependencies: [...resourceDeps.values()],
    missingResources: [...resourceDeps.values()].filter(d => d.resource && d.resource.present === false),
    manualChecks,
    offline: { playable: true, syncRequired: false,
      note: '离线可阅读/排练；现场确认在恢复网络后由设备上传，迟到确认会被标记 late 但不会丢弃。' },
  };
}

export function standalonePlayer(db, script, ver) {
  const pkg = buildExportPackage(db, script, ver);
  const data = JSON.stringify(pkg).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>离线脚本 · ${esc(script.name)} v${ver.version}</title>
<style>${PLAYER_CSS}</style></head>
<body>
<header class="top"><div>
  <h1>🔥 ${esc(script.name)} <span class="tag">v${ver.version} · 已批准 · 离线包</span></h1>
  <p class="sub">${esc(script.description || '')}</p>
</div>
<div class="clock"><div id="clock">00:00</div>
  <button id="play">▶ 演练计时</button>
  <p class="hint">计时仅对照计划，<b>不会</b>自动放行任何阶段</p>
</div></header>

<div class="banner" id="discBanner"></div>
<section id="missing"></section>
<main id="phases"></main>
<section><h2>人工核对项（导出清单）</h2><ul id="checks"></ul></section>
<footer>导出时间 ${esc(pkg.exportedAt)} · 审核人 ${esc(ver.approvedBy || '-')} · 本文件完全离线可用，不回传数据</footer>
<script>const PACKAGE = ${data}; ${PLAYER_JS}<\/script>
</body></html>`;
}

const PLAYER_CSS = `
:root{--bg:#f6f7f9;--ink:#1f2933;--line:#d9dee5;--red:#b42318;--amber:#b54708;--green:#067647;--blue:#175cd3}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--ink)}
.top{display:flex;justify-content:space-between;gap:16px;padding:18px 24px;background:#101828;color:#fff;flex-wrap:wrap}
h1{font-size:20px;margin:0}.sub{opacity:.8;font-size:13px;margin:6px 0 0}.tag{font-size:12px;background:#344054;border-radius:10px;padding:2px 10px;margin-left:8px}
.clock{text-align:right}#clock{font-size:30px;font-variant-numeric:tabular-nums;letter-spacing:2px}
button{background:var(--blue);color:#fff;border:0;border-radius:8px;padding:8px 16px;font-size:14px;cursor:pointer}
.hint{font-size:11px;opacity:.75;margin:4px 0 0}
.banner{background:#fef3f2;border:1px solid #fecdca;color:var(--red);padding:10px 24px;font-size:13px}
.banner ul{margin:6px 0 0;padding-left:18px}
main{padding:8px 24px}
.card{background:#fff;border:1px solid var(--line);border-radius:12px;margin:14px 0;overflow:hidden}
.card>h2{margin:0;padding:14px 18px;font-size:16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.card.alarm h2{border-left:6px solid var(--red)} .card.evacuation h2{border-left:6px solid #d97706}
.card.assembly h2{border-left:6px solid var(--blue)} .card.review h2{border-left:6px solid var(--green)}
.cond{font-size:12px;background:#f9fafb;border-top:1px dashed var(--line);padding:8px 18px;color:#475467}
.gate{background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:2px 8px;font-size:11px;color:#92400e}
.st{font-size:11px;border-radius:10px;padding:2px 8px;margin-left:auto}
.st.pending{background:#eef2f6;color:#667085}.st.ready{background:#ecfdf3;color:var(--green)}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:9px 18px;border-top:1px solid var(--line);text-align:left;vertical-align:top}
th{background:#fafbfc;color:#667085;font-weight:600}.t{font-variant-numeric:tabular-nums;color:#667085;width:64px}
.over{color:var(--red);font-weight:700}.due{color:var(--amber);font-weight:700}
section{padding:0 24px}section h2{font-size:15px}
#checks{font-size:13px;background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 30px}
#checks li{margin:5px 0}.miss{background:#fff;border:1px solid var(--red);border-radius:10px;padding:10px 16px;margin:12px 0;font-size:13px}
footer{padding:18px 24px;color:#98a2b3;font-size:12px}
.rolechip{font-size:11px;background:#eff8ff;color:var(--blue);border-radius:10px;padding:1px 8px}`;

const PLAYER_JS = `
const $ = s => document.querySelector(s);
const P = PACKAGE;
let startTs = null, timer = null, pausedAcc = 0, runStart = null;
const mmss = s => String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
$('#discBanner').innerHTML = '<b>安全边界：</b><ul>'+P.disclaimer.map(d=>'<li>'+d+'</li>').join('')+'</ul>';

const miss = P.missingResources || [];
$('#missing').innerHTML = miss.length ? '<div class="miss">⚠ <b>缺失资源依赖（'+miss.length+'），请现场人工替代：</b><ul>'+
  miss.map(d=>'<li>'+d.resource.name+' — '+(d.resource.note||'未就绪')+'（用于：'+(d.usedBy||[]).join('、')+'）</li>').join('')+'</ul></div>' : '';

let prevDone = true;
$('#phases').innerHTML = P.phases.map((p, pi) => {
  const rows = p.steps.map(s => '<tr><td class="t">'+mmss(s.tSec)+'</td>'+
    '<td>'+(s.kind==='gate'?'<span class="gate">🚦 人工放行门</span> ':'')+'<b>'+s.title+'</b>'+
    (s.detail?'<div style="color:#667085;font-size:12px;margin-top:3px">'+s.detail+'</div>':'')+'</td>'+
    '<td><span class="rolechip">'+(P.roles.find(r=>r.id===s.roleId)?.name||'未指派')+'</span></td>'+
    '<td id="st_'+s.id+'" class="st pending">未到点</td></tr>').join('');
  return '<div class="card '+p.kind+'" data-phase="'+p.id+'"><h2>'+p.name+
    ' <span style="font-size:12px;color:#667085;font-weight:400">计划 '+mmss(p.plannedStartSec)+' · '+p.plannedDurationSec+'s</span>'+
    '<span class="st pending" id="phst_'+p.id+'">'+(pi===0?'待主持放行':'暂定（需条件+人工放行）')+'</span></h2>'+
    '<table><tr><th>时间</th><th>内容</th><th>责任人</th><th>状态</th></tr>'+rows+'</table>'+
    '<div class="cond">🚦 阶段条件：'+(p.condition?.note||'无')+
    (p.condition?.requireGate?'<br>→ 该阶段必须由现场主持人/负责人人工放行；时间到点仅显示“已到计划时间”。':'')+'</div>'+
  '</div>';
}).join('');

$('#checks').innerHTML = P.manualChecks.map(c => '<li>['+c.phase+'] '+(c.gate?'<span class="gate">放行门</span> ':'')+
  '<b>'+c.step+'</b>：'+c.check+'</li>').join('') || '<li>（无）</li>';

function curSec(){ return runStart ? Math.floor((Date.now()-runStart)/1000) : 0; }
function refresh(){
  const sec = curSec(); $('#clock').textContent = mmss(sec);
  P.phases.forEach((p, pi) => {
    let opened = pi === 0;
    if (!opened) {
      const need = p.condition?.requireConfirmedSteps||[];
      opened = sec >= p.plannedStartSec; // 到点只影响展示
    }
    let allDone = true, anyDue = false;
    p.steps.forEach(s => {
      const el = document.getElementById('st_'+s.id);
      if (sec >= s.tSec) {
        anyDue = true;
        if (s.timeoutSec != null && sec > s.tSec + s.timeoutSec) {
          el.className='st pending over'; el.textContent='超时（预设提醒，需人工确认）';
        } else { el.className='st pending due'; el.textContent='已到点 · 等待现场确认'; }
      }
      if (sec < s.tSec) allDone = false;
    });
    const ph = document.getElementById('phst_'+p.id);
    if (sec >= p.plannedStartSec && pi > 0) {
      ph.className='st ready'; ph.textContent='已到计划时间 —— 仍需人工放行（不自动进入）';
    }
  });
}
$('#play').onclick = () => {
  if (!runStart) { runStart = Date.now(); timer = setInterval(refresh, 500); $('#play').textContent = '⏸ 暂停计时'; }
  else { clearInterval(timer); timer=null; const frozen = curSec(); runStart=null;
    $('#play').textContent = '▶ 继续计时';
    $('#play').onclick = () => { runStart = Date.now()-frozen*1000; timer=setInterval(refresh,500);
      $('#play').textContent='⏸ 暂停计时'; $('#play').onclick=arguments.callee; }; }
};
`;
