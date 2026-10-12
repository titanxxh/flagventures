import Ajv from "ajv";
import { clone, normalizeName, uid, validatePlay } from "./coach-model.js";

import backupSchema from "../content-format/coach-backup.schema.json" with { type: "json" };

export const playSchema = backupSchema.$defs.play;
const ajv = new Ajv({ strict: false, allowUnionTypes: true });
const checkPlay = ajv.compile(playSchema);
const checkBackup = ajv.compile(backupSchema);
export function assertPlay(play) {
  if (!checkPlay(play))
    throw new Error(
      `备份结构不支持 / Unsupported backup structure: ${ajv.errorsText(checkPlay.errors)}`,
    );
  for (const player of play.players)
    for (const m of [
      player.motion,
      ...play.scenarios.map((s) => s.overrides[player.id]).filter(Boolean),
    ]) {
      if (m.type === "path" && !Array.isArray(m.steps))
        throw new Error("路线动作缺失 / Missing route actions");
      if (
        m.type === "choice" &&
        (!m.options?.length || m.options.some((o) => !Array.isArray(o.steps)))
      )
        throw new Error("备用跑法结构损坏 / Invalid route choices");
      for (const steps of m.type === "choice"
        ? m.options.map((o) => o.steps)
        : [m.steps || []])
        for (const s of steps) {
          if (
            (s.type !== "pause" && !s.to) ||
            (s.type === "quadratic" && !s.control) ||
            (s.type === "cubic" && (!s.control1 || !s.control2))
          )
            throw new Error("路线几何结构损坏 / Invalid route geometry");
        }
    }
  for (const z of play.zones)
    if (
      z.type === "polygon"
        ? !Array.isArray(z.points)
        : !z.center ||
          !Object.hasOwn(z, "radiusX") ||
          !Object.hasOwn(z, "radiusY")
    )
      throw new Error("区域结构损坏 / Invalid zone structure");
}
export function assertRecord(record) {
  if (
    !record ||
    typeof record.id !== "string" ||
    !Number.isInteger(record.revision) ||
    !Array.isArray(record.history) ||
    record.history.length > 10
  )
    throw new Error("战术库记录损坏 / Invalid library record");
  assertPlay(record.draft);
  if (record.id !== record.draft.id)
    throw new Error("战术身份不一致 / Identity mismatch");
  for (const snapshot of [
    record.saved,
    ...record.history.map((version) => version.play),
  ].filter(Boolean)) {
    assertPlay(snapshot);
    if (snapshot.id !== record.id || validatePlay(snapshot).errors.length)
      throw new Error("保存版无法演示 / Invalid saved teaching version");
  }
}
export function backup(records) {
  return {
    format: "flagventures.backup",
    version: 2,
    createdAt: new Date().toISOString(),
    records: clone(records),
  };
}
export function parseBackup(text) {
  if (text.length > 25 * 1024 * 1024)
    throw new Error("备份超过 25 MB / Backup exceeds 25 MB");
  const data = JSON.parse(text);
  if (!checkBackup(data))
    throw new Error(
      "仅支持新版完整编辑备份 / Only the new complete editor backup is supported",
    );
  const ids = new Set();
  for (const record of data.records) {
    assertRecord(record);
    if (ids.has(record.id))
      throw new Error("备份含重复身份 / Duplicate backup identity");
    ids.add(record.id);
  }
  return data.records;
}
export const equivalent = (a, b) =>
  JSON.stringify({ draft: a.draft, saved: a.saved, history: a.history }) ===
  JSON.stringify({ draft: b.draft, saved: b.saved, history: b.history });
function names(record) {
  return [
    ...Object.values(record.draft.title),
    ...Object.values(record.saved?.title || {}),
  ]
    .map(normalizeName)
    .filter(Boolean);
}
function assertNames(records, changed) {
  const used = new Map();
  for (const record of records)
    for (const name of new Set(names(record))) {
      if (
        used.has(name) &&
        used.get(name) !== record.id &&
        (changed.has(record.id) || changed.has(used.get(name)))
      )
        throw new Error(
          "名称已存在，请改名 / This name already exists; rename the tactic",
        );
      used.set(name, record.id);
    }
}
export function copyRecord(record, records) {
  const result = clone(record);
  const id = uid("play");
  result.id = id;
  result.revision = 0;
  const used = new Set(records.flatMap(names));
  for (const language of ["zh", "en"]) {
    const original = result.draft.title[language];
    if (!original) continue;
    let suffix = 1,
      name;
    do {
      name = `${original}${language === "zh" ? "（副本" : " (copy"}${suffix > 1 ? ` ${suffix}` : ""}${language === "zh" ? "）" : ")"}`;
      suffix++;
    } while (used.has(normalizeName(name)));
    result.draft.title[language] = name;
    if (result.saved) result.saved.title[language] = name;
  }
  for (const play of [
    result.draft,
    result.saved,
    ...result.history.map((item) => item.play),
  ].filter(Boolean))
    play.id = id;
  return result;
}
export function makeRecord(play) {
  return {
    id: play.id,
    revision: 0,
    updatedAt: new Date().toISOString(),
    draft: clone(play),
    saved: null,
    history: [],
  };
}
export function teachingRecord(record, play) {
  const errors = validatePlay(play).errors;
  if (errors.length) throw new Error(errors[0].message);
  const snapshot = clone(play);
  return {
    ...clone(record),
    draft: snapshot,
    saved: clone(snapshot),
    history: [
      {
        id: uid("version"),
        at: new Date().toISOString(),
        play: clone(snapshot),
      },
      ...clone(record.history),
    ].slice(0, 10),
  };
}

/** Atomic revision checks prevent a second page from overwriting newer work. */
export class CoachStore {
  constructor({ temporary = false, indexedDB = globalThis.indexedDB } = {}) {
    this.temporary = temporary;
    this.indexedDB = indexedDB;
    this.memory = new Map();
  }
  async open() {
    if (this.temporary) return;
    if (!this.indexedDB)
      throw new Error(
        "本机存储不可用；可临时编辑并导出 / Local storage unavailable; use temporary editing and export",
      );
    this.db = await new Promise((resolve, reject) => {
      let refused = false;
      const request = this.indexedDB.open("flagventures-coach", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("plays", { keyPath: "id" });
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        refused = true;
        reject(
          new Error(
            "请关闭其他战术页面后重试 / Close other tactic pages and retry",
          ),
        );
      };
      request.onsuccess = () => {
        const db = request.result;
        if (refused) {
          db.close();
          return;
        }
        db.onversionchange = () => {
          db.close();
          this.db = null;
        };
        resolve(db);
      };
    });
  }
  async list() {
    const records = this.temporary
      ? [...this.memory.values()]
      : await new Promise((resolve, reject) => {
          if (!this.db) {
            reject(new Error("存储尚未打开 / Storage is not open"));
            return;
          }
          const tx = this.db.transaction("plays", "readonly"),
            request = tx.objectStore("plays").getAll();
          tx.oncomplete = () => resolve(request.result);
          tx.onerror = tx.onabort = () =>
            reject(tx.error || new Error("读取失败 / Read failed"));
        });
    records.forEach(assertRecord);
    return clone(records);
  }
  async change(changes) {
    const apply = (records) => {
      const map = new Map(records.map((item) => [item.id, item]));
      for (const change of changes) {
        const previous = map.get(change.id);
        if ((previous?.revision ?? 0) !== change.expected) {
          const error = new Error(
            "另一页面已更新，当前修改仍在；请另存副本 / Another page updated this tactic; save your edits as a copy",
          );
          error.code = "CONFLICT";
          throw error;
        }
        if (change.remove) map.delete(change.id);
        else {
          const record = {
            ...clone(change.record),
            revision:
              Math.max(previous?.revision || 0, change.record.revision || 0) +
              1,
            updatedAt: new Date().toISOString(),
          };
          assertRecord(record);
          map.set(change.id, record);
        }
      }
      if (changes.some((change) => change.enforceNames))
        assertNames(
          [...map.values()],
          new Set(changes.filter((c) => c.enforceNames).map((c) => c.id)),
        );
      return map;
    };
    if (this.temporary) {
      this.memory = apply([...this.memory.values()]);
      return clone([...this.memory.values()]);
    }
    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(
          new Error(
            "存储连接已关闭；请重试 / Storage connection closed; retry",
          ),
        );
        return;
      }
      const tx = this.db.transaction("plays", "readwrite"),
        store = tx.objectStore("plays"),
        request = store.getAll();
      let result, failure;
      request.onsuccess = () => {
        try {
          result = apply(request.result);
          for (const change of changes)
            change.remove
              ? store.delete(change.id)
              : store.put(result.get(change.id));
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(clone([...result.values()]));
      tx.onabort = tx.onerror = () =>
        reject(failure || tx.error || new Error("写入失败 / Write failed"));
    });
  }
}
