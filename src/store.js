// JSON 文件持久化：单次读入内存 + 原子写盘。
// 关键不变量：runs[].events 是只追加日志（append-only），任何接口都不提供删除事件的能力。
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = new URL('../data/db.json', import.meta.url).pathname;

const EMPTY = {
  meta: { createdAt: new Date().toISOString() },
  roles: [],          // 演练角色 {id,name,owner,contact}
  scripts: [],        // 脚本（含 versions[]，版本快照不可变）
  runs: [],           // 排练场次（events 只追加）
  resources: []       // 资源依赖登记 {id,name,kind,url,present,note}
};

let db;

export function load() {
  if (!existsSync(dirname(DB_PATH))) mkdirSync(dirname(DB_PATH), { recursive: true });
  if (existsSync(DB_PATH)) {
    db = JSON.parse(readFileSync(DB_PATH, 'utf8'));
  } else {
    db = structuredClone(EMPTY);
    save();
  }
  return db;
}

export function get() {
  if (!db) load();
  return db;
}

let saveChain = Promise.resolve();
export function save() {
  const snapshot = JSON.stringify(db, null, 2);
  saveChain = saveChain.then(() =>
    new Promise((resolve, reject) => {
      const tmp = `${DB_PATH}.${process.pid}.${Date.now()}.tmp`;
      try {
        writeFileSync(tmp, snapshot);
        renameSync(tmp, DB_PATH);
        resolve();
      } catch (e) { reject(e); }
    })
  );
  return saveChain;
}

export const uid = (p = 'id') =>
  `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
