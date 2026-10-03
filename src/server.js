// 零依赖 HTTP API + 静态文件服务
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { get, save, uid } from './store.js';
import { seed } from './seed.js';
import * as E from './engine.js';
import * as S from './scripts.js';
import { buildExportPackage, standalonePlayer } from './export.js';

const PORT = process.env.PORT || 3000;
const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
const ok = (res, obj = {}) => json(res, 200, obj);

const body = async (req) => {
  let raw = '';
  for await (const c of req) raw += c;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new E.ApiError(400, 'bad_json', '请求体不是合法 JSON'); }
};

const findRun = (db, id) => db.runs.find(r => r.id === id)
  || (() => { throw new E.ApiError(404, 'not_found', '排练场次不存在'); })();

export async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const db = get();
  const m = req.method;
  const now = new Date();

  const wrap = async (fn) => {
    try { await fn(); await save(); }
    catch (e) {
      if (e instanceof E.ApiError) json(res, e.status, { error: e.code, message: e.message, ...e });
      else { console.error(e); json(res, 500, { error: 'internal', message: e.message }); }
    }
  };

  // ---------- 基础资源 ----------
  if (m === 'GET' && p === '/api/health') return ok(res, { ok: true, at: now.toISOString() });

  if (m === 'GET' && p === '/api/roles') return ok(res, { roles: db.roles });
  if (m === 'POST' && p === '/api/roles') return wrap(async () => {
    const b = await body(req);
    if (!b.name) throw new E.ApiError(400, 'bad_args', '角色名称必填');
    const role = { id: uid('r'), name: b.name, owner: b.owner || '', contact: b.contact || '' };
    db.roles.push(role); ok(res, { role });
  });
  if (m === 'PUT' && p.startsWith('/api/roles/')) {
    const id = p.split('/').pop();
    return wrap(async () => {
      const role = db.roles.find(r => r.id === id) || (() => { throw new E.ApiError(404, 'not_found', '角色不存在'); })();
      const b = await body(req);
      for (const k of ['name', 'owner', 'contact']) if (k in b) role[k] = b[k];
      ok(res, { role });
    });
  }

  if (m === 'GET' && p === '/api/resources') return ok(res, { resources: db.resources });
  if (m === 'POST' && p === '/api/resources') return wrap(async () => {
    const b = await body(req);
    const r = { id: uid('res'), name: b.name || '未命名资源', kind: b.kind || 'other',
      url: b.url || '', present: b.present !== false, note: b.note || '' };
    db.resources.push(r); ok(res, { resource: r });
  });
  if (m === 'PUT' && p.startsWith('/api/resources/')) {
    const id = p.split('/').pop();
    return wrap(async () => {
      const r = db.resources.find(x => x.id === id) || (() => { throw new E.ApiError(404, 'not_found', '资源不存在'); })();
      const b = await body(req);
      for (const k of ['name', 'kind', 'url', 'present', 'note']) if (k in b) r[k] = b[k];
      ok(res, { resource: r });
    });
  }

  // ---------- 脚本 ----------
  if (m === 'GET' && p === '/api/scripts')
    return ok(res, { scripts: db.scripts.map(s => ({
      id: s.id, name: s.name, description: s.description, archived: !!s.archived,
      currentVersionId: s.currentVersionId,
      versions: s.versions.map(v => ({ id: v.id, version: v.version, status: v.status,
        note: v.note, approvedAt: v.approvedAt || null, approvedBy: v.approvedBy || null,
        createdAt: v.createdAt })),
    })) });

  if (m === 'POST' && p === '/api/scripts') return wrap(async () => {
    const b = await body(req); ok(res, { script: S.createScript(db, b) });
  });

  let mm;
  if ((mm = p.match(/^\/api\/scripts\/([^/]+)\/versions\/([^/]+)\/(submit|approve|reject|discard)$/))) {
    if (m !== 'POST') return json(res, 405, { error: 'method' });
    return wrap(async () => {
      const [, sid, vid, act] = mm;
      const b = await body(req);
      const fn = { submit: () => S.submitDraft(db, sid, vid, b.by),
        approve: () => S.approveVersion(db, sid, vid, b.by, { setCurrent: b.setCurrent !== false }),
        reject: () => S.rejectVersion(db, sid, vid, b.by, b.reason || ''),
        discard: () => S.discardDraft(db, sid, vid) }[act];
      const result = await fn();
      ok(res, { result });
    });
  }

  if ((mm = p.match(/^\/api\/scripts\/([^/]+)\/draft$/))) {
    if (m !== 'POST') return json(res, 405, { error: 'method' });
    return wrap(async () => {
      const b = await body(req);
      ok(res, { version: S.newDraft(db, mm[1], b.fromVersionId || null, b.by || '编排员', b.note || '') });
    });
  }
  if ((mm = p.match(/^\/api\/scripts\/([^/]+)\/archive$/)) && m === 'POST')
    return wrap(async () => ok(res, { script: S.archiveScript(db, mm[1]) }));

  if ((mm = p.match(/^\/api\/scripts\/([^/]+)\/versions\/([^/]+)$/))) {
    const [, sid, vid] = mm;
    if (m === 'GET') return wrap(async () => {
      const scr = E.getScript(db, sid);
      const v = E.getVersion(scr, vid);
      return ok(res, { script: scr, version: v, roles: db.roles, resources: db.resources });
    });
    if (m === 'PUT') return wrap(async () => {
      const b = await body(req);
      ok(res, { version: S.updateDraft(db, sid, vid, b, b.by || '编排员') });
    });
  }

  if ((mm = p.match(/^\/api\/scripts\/([^/]+)$/))) {
    if (m === 'GET') return wrap(async () =>
      ok(res, (() => { const scr = E.getScript(db, mm[1]); return { script: scr, roles: db.roles, resources: db.resources }; })()));
  }

  // ---------- 排练场次 ----------
  if (m === 'GET' && p === '/api/runs')
    return wrap(async () => {
      for (const r of db.runs) if (r.status === 'running') E.tick(db, r, now);
      ok(res, { runs: db.runs.map(r => ({ id: r.id, name: r.name, scriptId: r.scriptId,
      scriptName: db.scripts.find(s => s.id === r.scriptId)?.name || '',
      versionId: r.versionId, mode: r.mode, status: r.status,
      createdAt: r.createdAt, events: r.events.length,
      host: r.host ? { name: r.host.name, clientId: r.host.clientId } : null,
      hostLive: E.hostValid(r, now),
      counts: (() => {
        const vv = E.view(db, r, now); return vv.counts;
      })(),
      })) });
    });

  if (m === 'POST' && p === '/api/runs') return wrap(async () => {
    const b = await body(req);
    const run = E.createRun(db, {
      scriptId: b.scriptId, versionId: b.versionId, mode: b.mode,
      name: b.name, clientId: b.clientId, hostName: b.hostName,
    });
    ok(res, { run: E.view(db, run, now) });
  });

  if ((mm = p.match(/^\/api\/runs\/([^/]+)$/))) {
    if (m === 'GET') return wrap(async () => {
      const run = findRun(db, mm[1]);
      // 统一时钟模式：轮询读取时推进幂等时钟（仅自动标记“无需确认”项+物化阶段）。
      // 绝不放行阶段、绝不自动确认人工项。
      if (run.status === 'running') E.tick(db, run, now);
      ok(res, { run: E.view(db, run, now) });
    });
    if (m === 'DELETE') return wrap(async () => {
      // 不提供删除（事实保留）；仅允许 created 且无任何确认事实的场次标记作废
      const run = findRun(db, mm[1]);
      const facts = run.events.filter(e => e.type === 'step_confirmed' && e.by !== 'system').length;
      if (run.status === 'running' || facts)
        throw new E.ApiError(409, 'has_facts', '场次已开始或存在现场确认事实，不能作废；可正常结束并保留全部记录');
      run.status = 'cancelled';
      E.append(run, 'run_cancelled', 'system', null, {});
      ok(res, { run });
    });
  }

  const runAction = (re, action) => {
    if (!(mm = p.match(re))) return false;
    if (m !== 'POST') { json(res, 405, { error: 'method' }); return true; }
    const [, rid] = mm;
    wrap(async () => {
      const b = await body(req);
      const run = findRun(db, rid);
      switch (action) {
        case 'host': ok(res, { host: E.claimHost(db, run, { clientId: b.clientId, name: b.name, force: !!b.force }, now) }); break;
        case 'heartbeat': ok(res, { host: E.heartbeat(run, b.clientId, now) }); break;
        case 'release-host': E.releaseHost(run, b.clientId); ok(res, { ok: true }); break;
        case 'start': E.startRun(db, run, b.clientId, now); ok(res, { run: E.view(db, run, now) }); break;
        case 'pause': E.pauseRun(db, run, b.clientId, b.reason || '', now); ok(res, { run: E.view(db, run, now) }); break;
        case 'resume': E.resumeRun(db, run, b.clientId, now); ok(res, { run: E.view(db, run, now) }); break;
        case 'complete': E.completeRun(db, run, b.clientId, now); ok(res, { run: E.view(db, run, now) }); break;
        case 'release-phase': E.releasePhase(db, run, b.phaseId, b.clientId, now); ok(res, { run: E.view(db, run, now) }); break;
        case 'confirm': {
          const out = E.confirmStep(db, run, {
            stepId: b.stepId, by: b.by, roleId: b.roleId, clientId: b.clientId,
            note: b.note || '', offline: !!b.offline, localAt: b.localAt || null }, now);
          ok(res, { run: E.view(db, run, now), ...out }); break;
        }
        case 'switch': E.switchVersion(db, run, b.versionId, b.clientId, now); ok(res, { run: E.view(db, run, now) }); break;
        case 'tick': E.tick(db, run, now); ok(res, { run: E.view(db, run, now) }); break;
      }
    });
    return true;
  };
  for (const [re, act] of [
    [/^\/api\/runs\/([^/]+)\/host$/, 'host'],
    [/^\/api\/runs\/([^/]+)\/heartbeat$/, 'heartbeat'],
    [/^\/api\/runs\/([^/]+)\/release-host$/, 'release-host'],
    [/^\/api\/runs\/([^/]+)\/start$/, 'start'],
    [/^\/api\/runs\/([^/]+)\/pause$/, 'pause'],
    [/^\/api\/runs\/([^/]+)\/resume$/, 'resume'],
    [/^\/api\/runs\/([^/]+)\/complete$/, 'complete'],
    [/^\/api\/runs\/([^/]+)\/release-phase$/, 'release-phase'],
    [/^\/api\/runs\/([^/]+)\/confirm$/, 'confirm'],
    [/^\/api\/runs\/([^/]+)\/switch-version$/, 'switch'],
    [/^\/api\/runs\/([^/]+)\/tick$/, 'tick'],
  ]) if (runAction(re, act)) return;

  if ((mm = p.match(/^\/api\/runs\/([^/]+)\/diff$/))) {
    if (m !== 'GET') return json(res, 405, { error: 'method' });
    return wrap(async () => ok(res, { diff: E.buildDiff(db, findRun(db, mm[1]), url.searchParams.get('compareVersionId')) }));
  }

  // ---------- 导出离线脚本包 ----------
  if ((mm = p.match(/^\/api\/scripts\/([^/]+)\/export$/))) {
    if (m !== 'GET') return json(res, 405, { error: 'method' });
    return wrap(async () => {
      const sid = mm[1];
      const vid = url.searchParams.get('versionId');
      const scr = E.getScript(db, sid);
      const ver = vid ? E.getVersion(scr, vid) : E.getVersion(scr, scr.currentVersionId);
      if (ver.status !== 'approved') throw new E.ApiError(409, 'version_not_approved', '只能导出已批准版本');
      if (url.searchParams.get('standalone') === '1') {
        const html = standalonePlayer(db, scr, ver);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8',
          'content-disposition': `attachment; filename="drill-${ver.version}.html"` });
        return res.end(html);
      }
      const pkg = buildExportPackage(db, scr, ver);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="drill-package-v${ver.version}.json"` });
      return res.end(JSON.stringify(pkg, null, 2));
    });
  }

  // ---------- 静态 ----------
  if (m === 'GET') {
    let path = p === '/' ? '/index.html' : p;
    try {
      const data = await readFile(PUBLIC + path.replace(/\.\./g, ''));
      const type = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css'
        : path.endsWith('.html') ? 'text/html' : path.endsWith('.json') ? 'application/json' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': `${type}; charset=utf-8` });
      return res.end(data);
    } catch {
      return json(res, 404, { error: 'not_found', path: p });
    }
  }
  json(res, 404, { error: 'no_route', path: p, method: m });
}

seed();
createServer(handler).listen(PORT, () => console.log(`消防演练排练工具: http://localhost:${PORT}`));
