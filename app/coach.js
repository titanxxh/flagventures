import { getLanguage } from "./i18n.js";
import { getScene, positionAt, pathToSvg } from "./scene.js";
import { getBallState } from "./ball.js";
import {
  newPlay,
  adaptLesson,
  compilePlay,
  validatePlay,
  clone,
  uid,
  explanation,
  teachingText,
  markReview,
  movePlayer,
  motionFor,
  stepsFor,
  retime,
  stepLength,
  zoneCenter,
  copyScenario,
  promotePrefix,
  splitShared,
} from "./coach-model.js";
import {
  CoachStore,
  makeRecord,
  teachingRecord,
  backup,
  parseBackup,
  copyRecord,
  equivalent,
} from "./coach-storage.js";

const palette = ["#80d4ff", "#ffc078", "#c7e8a2", "#fff1d5", "#ff9690"];
const colorOf = (player, index) =>
  /^#[0-9a-f]{6}$/i.test(player.color || "")
    ? player.color
    : palette[index % palette.length];
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const tr = (zh, en) => (getLanguage() === "en" ? en : zh);
const titleOf = (object) =>
  object?.title?.[getLanguage()] ||
  object?.title?.zh ||
  object?.title?.en ||
  object?.name ||
  (typeof object?.label === "string" ? object.label : "") ||
  (object?.createdAt
    ? `${tr("未命名战术", "Untitled tactic")} · ${new Date(object.createdAt).toLocaleString(getLanguage() === "zh" ? "zh-CN" : "en")}`
    : tr("未命名战术", "Untitled tactic"));
const btn = (action, label, attrs = "") =>
  `<button type="button" data-do="${esc(action)}" ${attrs}>${esc(label)}</button>`;
const options = (values, current) =>
  values
    .map(
      ([value, label]) =>
        `<option value="${esc(value)}"${value === current ? " selected" : ""}>${esc(label)}</option>`,
    )
    .join("");
const input = (key, label, value, type = "text") =>
  `<label>${esc(label)}<input data-edit="${esc(key)}" type="${type}" value="${esc(value)}" ${type === "number" ? 'step="0.1"' : ""}></label>`;
const select = (key, label, values, current) =>
  `<label>${esc(label)}<select data-edit="${esc(key)}">${options(values, current)}</select></label>`;
const check = (key, label, value) =>
  `<label><input data-edit="${esc(key)}" type="checkbox" ${value ? "checked" : ""}> ${esc(label)}</label>`;
const types = () => [
  ["offense", tr("进攻传球", "Passing")],
  ["run", tr("跑球", "Running")],
  ["route", tr("基础路线", "Basic route")],
  ["formation", tr("静态阵型", "Formation")],
  ["defense", tr("防守", "Defense")],
];
const eventTypes = () => [
  ["snap", tr("开球", "Snap")],
  ["pass", tr("传球", "Pass")],
  ["handoff", tr("交递", "Handoff")],
  ["fake-handoff", tr("假交递", "Fake handoff")],
  ["pump-fake", tr("假传", "Pump fake")],
];

export function initCoach({ getCurrentLesson, pauseTeaching }) {
  const store = new CoachStore({ temporary: location.protocol === "file:" });
  const root = document.createElement("section");
  root.className = "coach";
  root.hidden = true;
  root.setAttribute("aria-label", "Flagventures Coach");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  document.body.append(root);
  const dialog = document.createElement("dialog");
  dialog.className = "coach-modal";
  document.body.append(dialog);
  let records = [],
    record,
    play,
    step = 1,
    selection = { kind: "play" },
    scenarioId,
    scope = "base",
    optionId,
    tool = "select",
    screen = "library",
    viewOnly = false,
    drawer = true;
  let routesOnly = false;
  let camera = { x: -3, y: -3, w: 36, h: 76 },
    snap = true,
    whole = true,
    time = 0,
    speed = 2,
    playing = false,
    frameId = null,
    lastTick,
    undo = [],
    redo = [],
    generation = 0,
    retained = 0,
    manual = 0,
    timer,
    queue = Promise.resolve(),
    saveError = "",
    loading = true;
  let compileCache, checkCache, coachTick, liveEditKey;
  let pointers = new Map(),
    gesture,
    poly = [],
    undoDeletion,
    undoTimer,
    toastTimer,
    importRows = [];
  const ready = store
    .open()
    .then(() => store.list())
    .then((value) => {
      records = value;
      loading = false;
    })
    .catch((error) => {
      loading = false;
      saveError = error.message;
    });
  function compileCurrent() {
    if (
      !compileCache ||
      compileCache.play !== play ||
      compileCache.generation !== generation ||
      compileCache.id !== scenarioId
    )
      compileCache = {
        play,
        generation,
        id: scenarioId,
        value: compilePlay(play, scenarioId),
      };
    return compileCache.value;
  }
  function checks(name = true) {
    if (
      !checkCache ||
      checkCache.play !== play ||
      checkCache.generation !== generation
    )
      checkCache = { play, generation, values: {} };
    return (checkCache.values[String(name)] ??= validatePlay(play, { name }));
  }
  const plan = () => play?.scenarios.find((item) => item.id === scenarioId);
  const selectedPlayer = () =>
    play.players.find((item) => item.id === selection.id);
  function selectedMotion() {
    const player = selectedPlayer();
    if (!player) return;
    return scope === "plan"
      ? plan()?.overrides[player.id] || player.motion
      : player.motion;
  }
  const motionSteps = () => {
    const p = selectedPlayer();
    return p
      ? stepsFor(selectedMotion(), optionId || plan()?.choices[p.id])
      : [];
  };
  function object() {
    if (!play) return;
    return selection.kind === "play"
      ? play
      : (
          {
            player: play.players,
            zone: play.zones,
            target: play.targets,
            duty: play.assignments,
            frame: play.bookmarks,
            event: [...play.sharedEvents, ...(plan()?.events || [])],
          }[selection.kind] || []
        ).find((item) => item.id === selection.id) || play;
  }
  function status() {
    if (saveError) return saveError;
    if (store.temporary)
      return tr(
        "临时编辑 · 关闭前导出完整备份",
        "Temporary editing · Export before closing",
      );
    if (loading) return tr("正在读取本机战术…", "Loading local tactics…");
    return play
      ? generation > retained
        ? tr("草稿尚未保留", "Draft not retained yet")
        : generation > manual
          ? tr(
              "草稿已保留 · 教学版未更新",
              "Draft retained · Teaching version unchanged",
            )
          : tr("当前内容已手动保存", "Current content saved")
      : tr(
          "本机战术库 · 当前浏览器和来源",
          "Local library · This browser and origin",
        );
  }
  function toast(message) {
    let node = root.querySelector(".coach-toast");
    if (!node) {
      node = document.createElement("div");
      node.className = "coach-toast";
      node.setAttribute("role", "status");
      root.append(node);
    }
    node.textContent = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.remove(), 5000);
  }
  function updateStatus() {
    const node = root.querySelector(".coach-status");
    if (node) {
      node.textContent = status();
      node.classList.toggle("error", Boolean(saveError));
    }
  }
  function enqueue(work) {
    const next = queue.catch(() => {}).then(work);
    queue = next;
    return next;
  }
  function checkpoint() {
    undo.push(clone(play));
    if (undo.length > 60) undo.shift();
    redo = [];
  }
  function changed({ review = false, objects = [] } = {}) {
    if (review) markReview(play, objects);
    generation++;
    playing = false;
    clearTimeout(timer);
    timer = setTimeout(() => retain().catch(() => {}), 450);
    updateStatus();
  }
  function mutate(work, opts = {}) {
    if(!opts.liveKey || liveEditKey!==opts.liveKey)checkpoint();
    liveEditKey=opts.liveKey;
    work();
    changed(opts);
    if(!opts.liveKey)render();
  }
  async function retain() {
    if (!play || viewOnly) return;
    clearTimeout(timer);
    const snapshot = clone(play),
      stamp = generation,
      id = record.id;
    return enqueue(async () => {
      try {
        const value = { ...clone(record), draft: snapshot };
        const all = await store.change([
          { id, expected: record.revision, record: value },
        ]);
        records = all;
        const saved = all.find((item) => item.id === id);
        if (record?.id === id) {
          record = saved;
          retained = Math.max(retained, stamp);
        }
        saveError = "";
        updateStatus();
      } catch (error) {
        saveError = error.message;
        updateStatus();
        throw error;
      }
    });
  }
  async function leave(work) {
    playing = false;
    if (play && !viewOnly) await retain();
    work();
  }
  function openRecord(value, demonstrate = false) {
    record = clone(value);
    play = clone(demonstrate ? value.saved : value.draft);
    screen = "editor";
    viewOnly = demonstrate;
    step = demonstrate ? 4 : 1;
    scenarioId = play.defaultScenario;
    selection = { kind: "play" };
    scope = "base";
    tool = "select";
    time = 0;
    frameId = null;
    routesOnly = false;
    drawer = window.innerWidth > 950;
    playing = false;
    undo = [];
    redo = [];
    generation = 0;
    retained = 0;
    manual =
      JSON.stringify(value.draft) === JSON.stringify(value.saved) ? 0 : -1;
    saveError = "";
    camera = { x: -3, y: -3, w: 36, h: 76 };
    render();
  }
  async function create(type, source) {
    const value = source ? adaptLesson(source) : newPlay(type);
    const fresh = makeRecord(value);
    const copied = source ? copyRecord(fresh, records) : fresh; // Copies reserve a distinct name.
    records = await store.change([
      { id: copied.id, expected: 0, record: copied },
    ]);
    openRecord(records.find((item) => item.id === copied.id));
  }
  async function save(copy = false) {
    const result = checks();
    if (result.errors.length) {
      step = 4;
      render();
      toast(
        tr(
          "先修复阻止保存的问题；草稿会继续保留。",
          "Repair blocking issues; your draft is retained.",
        ),
      );
      return;
    }
    if (copy) {
      try {
        await retain();
      } catch (error) {
        if (error.code !== "CONFLICT") throw error;
      }
      const copied = copyRecord({ ...record, draft: clone(play) }, records);
      const value = teachingRecord(copied, copied.draft);
      records = await store.change([
        { id: value.id, expected: 0, record: value, enforceNames: true },
      ]);
      openRecord(records.find((item) => item.id === value.id));
      toast(tr("已另存副本", "Saved as a copy"));
      return;
    }
    clearTimeout(timer);
    const snapshot = clone(play),
      stamp = generation,
      id = record.id;
    await enqueue(async () => {
      const value = teachingRecord(record, snapshot);
      try {
        records = await store.change([
          { id, expected: record.revision, record: value, enforceNames: true },
        ]);
        record = records.find((item) => item.id === id);
        retained = Math.max(retained, stamp);
        manual = stamp;
        saveError = "";
        toast(
          store.temporary
            ? tr(
                "临时演示版已更新，请导出备份",
                "Temporary teaching version updated; export a backup",
              )
            : tr("教学版已保存", "Teaching version saved"),
        );
        if (generation > stamp)
          timer = setTimeout(() => retain().catch(() => {}), 100);
        updateStatus();
      } catch (error) {
        saveError = error.message;
        updateStatus();
        throw error;
      }
    });
  }
  function exportBackup(single) {
    const current =
      play && !viewOnly ? { ...clone(record), draft: clone(play) } : null;
    const values = single
      ? [current || record]
      : records.map((item) => (current?.id === item.id ? current : item));
    if (!values.length) {
      toast(tr("还没有战术", "No tactics yet"));
      return;
    }
    const blob = new Blob([JSON.stringify(backup(values), null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `Flagventures-${single ? "tactic" : "library"}.backup.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast(
      tr(
        "备份已生成，开始下载；请确认文件保存完成。",
        "Backup generated; download started. Check that the file is saved.",
      ),
    );
  }
  function ask(content, onConfirm) {
    dialog.innerHTML =
      content +
      `<div>${btn("modal-cancel", tr("取消", "Cancel"))}${btn("modal-ok", tr("确认", "Confirm"), 'class="primary"')}</div>`;
    dialog.showModal();
    dialog.querySelector("[data-do=modal-cancel]").onclick = () =>
      dialog.close();
    dialog.querySelector("[data-do=modal-ok]").onclick = async () => {
      try {
        await onConfirm();
        dialog.close();
      } catch (error) {
        let node = dialog.querySelector("[role=alert]");
        if (!node) {
          node = document.createElement("p");
          node.setAttribute("role", "alert");
          dialog.append(node);
        }
        node.textContent = error.message;
      }
    };
  }
  function newDialog() {
    ask(
      `<h2>${esc(tr("新建战术", "Create a tactic"))}</h2><label>${esc(tr("教学类型", "Lesson type"))}<select id="coachNewType">${options(types(), "offense")}</select></label>`,
      () => create(dialog.querySelector("select").value),
    );
  }
  function commonHeader() {
    return `<header class="coach-head"><h1>Flagventures · ${esc(screen === "library" ? tr("我的战术", "My tactics") : titleOf(play))}</h1><select class="coach-language" data-edit="language" aria-label="Language">${options(
      [
        ["zh", "中文"],
        ["en", "English"],
      ],
      getLanguage(),
    )}</select>${btn("library", tr("战术库", "Library"))}${screen === "editor" && !viewOnly ? btn("save", tr("保存战术", "Save tactic"), 'class="primary"') : ""}${btn("close", tr("返回教学", "Back to lessons"))}<span class="coach-status ${saveError ? "error" : ""}" role="status">${esc(status())}</span>${saveError ? btn("retry", tr("重试", "Retry")) + btn("export-all", tr("导出备份", "Export backup")) : ""}</header>`;
  }
  function render() {
    if (root.hidden) return;
    const previousFocus = document.activeElement?.dataset.edit;
    const caret = document.activeElement?.selectionStart;
    const pageScroll = root.scrollTop,
      panelScroll = root.querySelector(".coach-inspector")?.scrollTop || 0;
    root.innerHTML =
      commonHeader() +
      `<div class="coach-content">${screen === "library" ? libraryHtml() : editorHtml()}</div>`;
    root.scrollTop = pageScroll;
    const freshPanel = root.querySelector(".coach-inspector");
    if (freshPanel) freshPanel.scrollTop = panelScroll;
    if (screen === "editor") {
      renderBoard();
      if (previousFocus) {
        const node = root.querySelector(
          `[data-edit="${CSS.escape(previousFocus)}"]`,
        );
        node?.focus({ preventScroll: true });
        if (
          typeof caret === "number" &&
          ["text", "textarea"].includes(node?.type)
        )
          node.setSelectionRange(caret, caret);
      }
    }
    if (undoDeletion) renderUndo();
    if (!root.contains(document.activeElement) && !dialog.open)
      root.querySelector("button")?.focus({ preventScroll: true });
  }
  function libraryHtml() {
    return `<p class="coach-intro">${esc(store.temporary ? tr("单文件版只保留本次会话。关闭前请导出备份；下次导入备份继续。", "The standalone file keeps this session only. Export a backup before closing; import it next time.") : tr("自动保留草稿；点击保存战术才更新上课演示版。本机内容按浏览器和网址分别保存，请定期备份。", "Drafts are retained automatically. Save explicitly to update the teaching version. Data belongs to this browser and origin; back it up regularly."))}</p><div class="coach-bar">${btn("new", tr("＋ 空白新建", "＋ New tactic"), 'class="primary"')}${btn("copy-builtin", tr("复制当前内置战术", "Copy current built-in lesson"))}${btn("export-all", tr("导出全库备份", "Export library"))}${btn("import", tr("导入完整备份", "Import full backup"))}${saveError ? btn("temporary", tr("使用临时画板", "Use temporary editor")) : ""}</div><input id="coachBackupInput" type="file" accept=".json" hidden><div class="coach-cards">${records.map((value) => `<article class="coach-card"><svg viewBox="0 35 30 30" aria-label="${esc(titleOf(value.draft))}">${thumbnail(value.draft)}</svg><h2>${esc(titleOf(value.draft))}</h2><p>${esc(new Date(value.updatedAt).toLocaleString(getLanguage() === "zh" ? "zh-CN" : "en"))} · ${esc(value.saved ? (JSON.stringify(value.draft) === JSON.stringify(value.saved) ? tr("已保存", "Saved") : tr("有草稿修改", "Draft changes")) : tr("尚未保存教学版", "Draft only"))}</p><div class="coach-bar">${btn("edit-record", tr("编辑", "Edit"), `data-id="${esc(value.id)}"`)}${btn("demo-record", tr("演示", "Teach"), `data-id="${esc(value.id)}" ${!value.saved ? "disabled" : ""}`)}${btn("delete-record", tr("删除", "Delete"), `data-id="${esc(value.id)}"`)}</div></article>`).join("")}</div>${!records.length ? `<p class="coach-empty">${esc(tr("画出第一套属于你们的配合。", "Draw your first team play."))}</p>` : ""}`;
  }
  function thumbnail(value) {
    return value.players
      .map((p, i) => {
        let route = "";
        try {
          route = pathToSvg(
            p.at,
            stepsFor(p.motion, value.scenarios[0]?.choices[p.id]),
          );
        } catch {}
        return `<path d="${esc(route)}" fill="none" stroke="${colorOf(p, i)}" stroke-width=".4"/><circle cx="${p.at[0]}" cy="${p.at[1]}" r=".8" fill="${colorOf(p, i)}"/>`;
      })
      .join("");
  }
  function editorHtml() {
    const labels = [
      tr("摆站位", "Lineup"),
      play.type === "defense"
        ? tr("画区域与路线", "Zones & routes")
        : tr("画路线", "Routes"),
      ["offense", "run"].includes(play.type)
        ? tr("安排球路", "Ball actions")
        : play.type === "defense"
          ? tr("职责与讲解", "Duties & stops")
          : tr("安排讲解", "Teaching stops"),
      tr("预览保存", "Preview & save"),
    ];
    return `<nav class="coach-steps" aria-label="${esc(tr("编辑步骤", "Editor steps"))}">${labels.map((label, i) => btn("step", `${i + 1} · ${label}`, `data-step="${i + 1}" aria-pressed="${step === i + 1}" ${viewOnly ? "disabled" : ""}`)).join("")}</nav><div class="coach-bar">${select(
      "scenario",
      tr("当前方案", "Current plan"),
      play.scenarios.map((s) => [s.id, titleOf(s)]),
      scenarioId,
    )}${!viewOnly ? btn("copy-plan", tr("复制方案", "Duplicate plan"), plan() ? "" : "disabled") + btn("new-plan", tr("新方案", "New plan")) + btn("delete-plan", tr("删方案", "Delete plan"), plan() ? "" : "disabled") : ""}${!viewOnly ? btn("undo", tr("撤销", "Undo"), undo.length ? "" : "disabled") + btn("redo", tr("重做", "Redo"), redo.length ? "" : "disabled") : ""}${btn("panel", tr("属性与说明", "Properties & explanation"), 'class="coach-drawer-button"')}</div><div class="coach-work"><div>${toolsHtml()}<div class="coach-board"><svg class="coach-canvas" tabindex="0" aria-label="${esc(tr("可编辑球场", "Editable field"))}"></svg><p>${esc(tr("彩色实线：跑动 · 橙色虚线：球飞 · ○：交递 · FAKE：假动作 · 白线：持球轨迹 · 浅色虚线：静态职责", "Solid color: run · Orange dashes: ball flight · ○: handoff · FAKE: fake · White: carry · Pale dashes: static duty"))}</p><p>${esc(tr("距离、默认速度和动作时序为教学设置；双指缩放／移动。", "Distances, default speed and timing are teaching settings. Pinch to zoom/pan."))}</p></div>${playbackHtml()}${problemsHtml()}</div><aside class="coach-inspector" data-open="${drawer}">${btn("panel", tr("收起", "Collapse"), 'class="coach-close-drawer"')}${inspectorHtml()}</aside></div>`;
  }
  function toolsHtml() {
    const buttons =
      step === 4
        ? []
        : [
            ["select", tr("点选 / 拖动", "Select / drag")],
            ["pan", tr("移动画布", "Pan")],
          ];
    if (step === 2 && play.type !== "formation") {
      buttons.push(
        ["line", tr("点击画直线", "Click route")],
        ["quadratic", tr("弧线", "Curve")],
        ["freehand", tr("手绘", "Freehand")],
      );
      if (play.type === "defense")
        buttons.push(
          ["ellipse", tr("椭圆区域", "Ellipse")],
          ["rectangle", tr("矩形区域", "Rectangle")],
          ["polygon", tr("多边形", "Polygon")],
        );
    }
    if (step === 3 && play.type === "defense")
      buttons.push(
        ["target", tr("目标标记", "Target")],
        ["coverage", tr("覆盖职责", "Coverage")],
        ["matchup", tr("盯人职责", "Matchup")],
        ["rush", tr("冲传方向", "Rush")],
      );
    if (step === 3 && ["offense", "run"].includes(play.type))
      buttons.push(...eventTypes());
    return `<div class="coach-tools">${buttons.length ? `<details ${window.innerWidth > 950 ? "open" : ""}><summary>${esc(tr("工具", "Tools"))} · ${esc(buttons.find((b) => b[0] === tool)?.[1] || tool)}</summary><div class="coach-bar">${buttons.map(([key, label]) => btn("tool", label, `data-tool="${key}" aria-pressed="${tool === key}"`)).join("")}</div></details>` : ""}${poly.length ? btn("finish-polygon", tr("完成多边形", "Finish polygon")) : ""}${btn("zoom-in", "＋", `aria-label="${esc(tr("放大", "Zoom in"))}"`)}${btn("zoom-out", "−", `aria-label="${esc(tr("缩小", "Zoom out"))}"`)}${btn("full", tr("全场", "Full field"))}${btn("near", tr("近景", "Close-up"))}${step < 4 ? check("snap", tr("1 码吸附", "1 yd snap"), snap) : ""}</div>`;
  }
  function playbackHtml() {
    const compiled = compileCurrent(),
      validation = checks(false);
    const eventIds = new Set(
      [...play.sharedEvents, ...(plan()?.events || [])].map((e) => e.id),
    );
    const blocking = validation.errors.filter(
      (error) =>
        (!error.scenario || error.scenario === scenarioId) &&
        !play.bookmarks.some((f) => f.id === error.object) &&
        !(
          routesOnly &&
          error.step === 3 &&
          (eventIds.has(error.object) || error.object === play.id)
        ),
    );
    return `<section class="coach-playback"><div class="coach-bar">${btn("play", compiled.lesson.timeline.duration === 0 ? tr("静态展示", "Static view") : playing ? tr("暂停", "Pause") : tr("播放预览", "Play preview"), blocking.length || compiled.lesson.timeline.duration === 0 ? "disabled" : "")}${btn("reset", tr("回到站位", "Reset"))}<output data-coach-clock>${time.toFixed(1)} / ${compiled.lesson.timeline.duration.toFixed(1)} s</output>${select(
      "speed",
      tr("速度", "Speed"),
      [0.5, 1, 2, 3].map((s) => [String(s), `${s}×`]),
      String(speed),
    )}</div><input data-edit="seek" type="range" min="0" max="${compiled.lesson.timeline.duration}" step=".01" value="${time}" aria-label="${esc(tr("演示进度", "Timeline"))}"><p class="coach-help">${esc(plan()?.mode === "routes" || routesOnly ? tr("仅跑位／静态职责预览；没有虚构的球路。", "Route/static duty preview; no invented ball actions.") : tr("当前方案完整球路预览。", "Full ball preview for this plan."))}</p>${plan()?.mode === "ball" ? check("routesOnly", tr("仅预览跑位（不更改方案）", "Preview routes only (keep plan unchanged)"), routesOnly) : ""}<div class="coach-frames">${compiled.keyframes
      .filter((frame) => !routesOnly || frame.binding.type !== "ball")
      .map((frame) =>
        btn(
          "seek-frame",
          titleOf(frame),
          `data-id="${esc(frame.id)}" aria-pressed="${frameId === frame.id}" ${frame.valid ? "" : "disabled"}`,
        ),
      )
      .join(
        "",
      )}</div><div class="coach-caption">${esc(caption())}</div></section>`;
  }
  function caption() {
    const compiled = compileCurrent();
    const frame =
      compiled.keyframes.find(
        (f) => f.id === frameId && (!routesOnly || f.binding.type !== "ball"),
      ) ||
      compiled.keyframes
        .filter(
          (f) =>
            f.valid &&
            f.at <= time &&
            (!routesOnly || f.binding.type !== "ball"),
        )
        .at(-1);
    const parts = [];
    for (const item of [frame, selectedPlayer(), play])
      if (item) {
        const text = teachingText(item, getLanguage());
        parts.push(
          text.text +
            (text.fallback
              ? ` (${tr("尚无已确认译文", "Confirmed translation unavailable")})`
              : text.pending
                ? tr("讲解待补／待核对", "Explanation missing / needs review")
                : ""),
        );
      }
    return [...new Set(parts)].join("\n");
  }
  function problemsHtml() {
    const value = checks();
    return `<details class="coach-problems" ${step === 4 && value.errors.length ? "open" : ""}><summary>${esc(tr("问题检查", "Checks"))} · ${value.errors.length} ${esc(tr("阻止项", "blocking"))} / ${value.warnings.length} ${esc(tr("讲解提示", "text notes"))}</summary>${value.errors.map((error, index) => btn("problem", error.message, `data-index="${index}"`)).join("")}<p class="coach-help">${esc(tr("草稿可保留未完成内容。保存教学版前修复所有方案的阻止项；讲解和译文可后补。", "Incomplete drafts can be retained. Repair blocking issues in every plan before saving; explanations and translations may follow."))}</p></details>`;
  }
  function bindingHtml(prefix, binding, withBall = false) {
    const b = binding || { type: "time", seconds: 0 };
    const compiled = compileCurrent();
    let out = select(
      `${prefix}.type`,
      tr("时刻绑定", "Time binding"),
      [
        ["time", tr("固定秒数", "Fixed seconds")],
        ["action", tr("跟随路线动作", "Follow route action")],
        ...(withBall ? [["ball", tr("跟随球动作", "Follow ball action")]] : []),
      ],
      b.type,
    );
    if (b.type === "time")
      out += input(
        `${prefix}.seconds`,
        tr("秒", "Seconds"),
        b.seconds ?? 0,
        "number",
      );
    if (b.type === "action") {
      out += select(
        `${prefix}.player`,
        tr("球员", "Player"),
        [
          ["", tr("请选择", "Choose")],
          ...play.players.map((p) => [p.id, p.name || p.id]),
        ],
        b.player || "",
      );
      const ids = [...compiled.actions].filter(
        ([, a]) => a.player === b.player,
      );
      out += select(
        `${prefix}.action`,
        tr("动作", "Action"),
        [
          ["", tr("请重新选择", "Select explicitly")],
          ...ids.map(([id], i) => [id, `${b.player} · ${i + 1}`]),
        ],
        b.action || "",
      );
    }
    if (b.type === "ball")
      out += select(
        `${prefix}.event`,
        tr("球动作", "Ball action"),
        [
          ["", tr("请选择", "Choose")],
          ...[...play.sharedEvents, ...(plan()?.events || [])].map((e) => [
            e.id,
            eventTypes().find((t) => t[0] === e.type)?.[1] || e.type,
          ]),
        ],
        b.event || "",
      );
    if (b.type !== "time")
      out +=
        select(
          `${prefix}.phase`,
          tr("动作时点", "Phase"),
          [
            ["start", tr("开始", "Start")],
            ["end", tr("完成", "End")],
          ],
          b.phase || "end",
        ) +
        input(
          `${prefix}.offset`,
          tr("延后秒数", "Offset seconds"),
          b.offset || 0,
          "number",
        );
    return out;
  }
  function inspectorHtml() {
    const item = object();
    let out = `<h2>${esc(selection.kind === "play" ? tr("整套战术", "Whole tactic") : selection.kind === "duty" ? `${item.player} · ${tr({ coverage: "覆盖职责", matchup: "盯人职责", rush: "冲传职责" }[item.type], { coverage: "Coverage", matchup: "Matchup", rush: "Rush" }[item.type])}` : item.name || item.label?.en || titleOf(item))}</h2>`;
    if (viewOnly)
      return (
        out +
        explanationHtml(item, true) +
        sourcesHtml() +
        btn("edit-current", tr("编辑草稿", "Edit draft"))
      );
    out += btn("select-play", tr("整套战术说明", "Whole tactic properties"));
    if (selection.kind === "play") {
      out +=
        input("title.zh", tr("中文名称", "Chinese name"), play.title.zh) +
        input("title.en", tr("英文名称", "English name"), play.title.en) +
        `<p class="coach-help">${esc(tr("名称唯一；可先填一种语言。", "Names must be unique; one language is enough."))}</p>`;
      if (step === 1)
        out += input(
          "field.lineOfScrimmageY",
          tr("开球线 Y（码）", "Line of scrimmage Y (yd)"),
          play.field.lineOfScrimmageY,
          "number",
        );
      out += select(
        "defaultScenario",
        tr("默认方案", "Default plan"),
        [
          ["", tr("请选择", "Choose")],
          ...play.scenarios.map((s) => [s.id, titleOf(s)]),
        ],
        play.defaultScenario,
      );
      out += input(
        "planTitle",
        tr("当前方案名称", "Current plan name"),
        plan()?.title[getLanguage()] || "",
      );
      if (["offense", "run"].includes(play.type))
        out +=
          select(
            "planMode",
            tr("演示模式", "Preview mode"),
            [
              ["routes", tr("仅跑位", "Routes only")],
              ["ball", tr("跑位＋球路", "Routes + ball")],
            ],
            plan()?.mode,
          ) +
          select(
            "initialOwner",
            tr("初始持球人", "Initial ball holder"),
            play.players.map((p) => [p.id, p.name || p.id]),
            play.initialOwner,
          );
      if (step === 3)
        out +=
          btn("add-frame", tr("＋ 讲解停点", "＋ Teaching stop")) +
          `<p class="coach-help">${esc(tr("选球员再点目标安排配合；或点下方动作编辑。", "Select a player then a target to arrange an action, or edit the actions below."))}</p>`;
      if (step === 4 && play.type !== "formation")
        out += input(
          "referenceDuration",
          tr("最少演示时长（秒）", "Minimum preview duration (s)"),
          play.referenceDuration || 0,
          "number",
        );
      if (step === 4)
        out +=
          btn("save-copy", tr("另存副本", "Save a copy")) +
          btn("history", tr("保存历史", "Version history")) +
          btn("export-one", tr("导出本套完整备份", "Export this tactic"));
      out += sourcesHtml();
    }
    if (selection.kind === "player") out += playerHtml(item);
    if (selection.kind === "zone") out += zoneHtml(item);
    if (selection.kind === "target")
      out +=
        input("name", tr("目标名称", "Target name"), item.name) +
        pointHtml("at", item.at) +
        btn("remove-object", tr("删除目标", "Delete target"));
    if (selection.kind === "duty")
      out +=
        select(
          "player",
          tr("负责球员", "Responsible player"),
          play.players.map((p) => [p.id, p.name || p.id]),
          item.player,
        ) +
        select(
          "type",
          tr("职责", "Duty"),
          [
            ["coverage", tr("覆盖区域", "Coverage")],
            ["matchup", tr("盯人", "Matchup")],
            ["rush", tr("冲传", "Rush")],
          ],
          item.type,
        ) +
        (item.type === "coverage"
          ? select(
              "zone",
              tr("负责区域", "Zone"),
              [
                ["", tr("待选择", "Select")],
                ...play.zones.map((z) => [z.id, z.label]),
              ],
              item.zone,
            )
          : select(
              "target",
              tr("目标标记", "Target marker"),
              [
                ["", tr("自由终点", "Free endpoint")],
                ...play.targets.map((t) => [t.id, t.name]),
              ],
              item.target || "",
            ) + pointHtml("end", item.end || [15, 50])) +
        btn("remove-object", tr("删除职责", "Delete duty"));
    if (selection.kind === "frame")
      out +=
        input(
          "frameTitle",
          tr("停点名称", "Stop name"),
          item.title[getLanguage()],
        ) +
        bindingHtml("binding", item.binding, true) +
        `<h3>${esc(tr("这一帧显示", "Layers for this stop"))}</h3>` +
        play.zones
          .map((z) =>
            check(
              `view.zone.${z.id}`,
              z.label,
              !item.view || item.view.zoneIds.includes(z.id),
            ),
          )
          .join("") +
        play.assignments
          .map((d) =>
            check(
              `view.duty.${d.id}`,
              `${d.player} ${d.type}`,
              !item.view || item.view.assignmentIds.includes(d.id),
            ),
          )
          .join("") +
        btn(
          "reset-layers",
          tr("重新显示全部当前图层", "Reset to current layers"),
        ) +
        btn("remove-object", tr("删除停点", "Delete stop"));
    if (selection.kind === "event") out += eventHtml(item);
    out += explanationHtml(item, false);
    if (step === 3 && ["offense", "run"].includes(play.type))
      out += eventsHtml();
    if (step === 3 && play.type === "defense")
      out +=
        `<h3>${esc(tr("职责清单", "Duties"))}</h3>` +
        play.assignments
          .map((d) =>
            btn(
              "select-duty",
              `${d.player} · ${d.type}`,
              `data-id="${esc(d.id)}"`,
            ),
          )
          .join("");
    if (step === 3)
      out +=
        `<h3>${esc(tr("讲解停点", "Teaching stops"))}</h3>` +
        play.bookmarks
          .filter((f) => !f.scenario || f.scenario === scenarioId)
          .map((f) => btn("select-frame", titleOf(f), `data-id="${esc(f.id)}"`))
          .join("") +
        btn("add-frame", tr("＋ 新停点", "＋ New stop"));
    return out;
  }
  const pointHtml = (key, point) =>
    `<div class="coach-pair">${input(`${key}.0`, "X · yd", point?.[0] ?? "", "number")}${input(`${key}.1`, "Y · yd", point?.[1] ?? "", "number")}</div>`;
  function playerHtml(player) {
    const motion = selectedMotion(),
      steps = motionSteps();
    let out =
      input("name", tr("代号 / 名称", "Label / name"), player.name) +
      pointHtml("at", player.at) +
      check(
        "whole",
        tr("移动起点时连整条路线移动", "Move whole route with start"),
        whole,
      ) +
      select(
        "scope",
        tr("路线编辑范围", "Route edit scope"),
        [
          ["base", tr("所有方案共用", "Shared base")],
          ["plan", tr("仅当前方案", "This plan only")],
        ],
        scope,
      );
    if (player.legacyReview)
      out +=
        `<p class="coach-warning">${esc(tr("改动影响了原有面向队友设置，保存前需检查。", "The edit affects legacy facing settings. Check them before saving."))}</p>` +
        btn(
          "confirm-legacy",
          tr("已检查，保留原设置", "Checked: retain the legacy settings"),
        );
    if (scope === "plan")
      out +=
        `<p class="coach-help">${esc(plan()?.overrides[player.id] ? tr("此人有独立覆盖，不随基础路线变化。", "This player has an override independent of the base.") : tr("仍共用基础路线；开始修改即建立独立覆盖。", "Still shared; editing creates an override."))}</p>` +
        btn("clear-override", tr("恢复共用基础路线", "Use base route"));
    out +=
      select(
        "motionType",
        tr("行动", "Action"),
        [
          ["unspecified", tr("未说明", "Unspecified")],
          ["still", tr("明确原位", "Explicitly still")],
          ...(play.type !== "formation"
            ? [["path", tr("实际跑动", "Run route")]]
            : []),
          ...(motion.type === "choice"
            ? [["choice", tr("原有备用跑法", "Legacy route choice")]]
            : []),
        ],
        motion.type,
      ) +
      input("label.en", tr("跑法术语", "Route term"), player.label.en) +
      input("label.zh", tr("跑法中文", "Chinese route name"), player.label.zh);
    if (motion.type === "choice")
      out += select(
        "option",
        tr("编辑备用跑法", "Edit route choice"),
        motion.options.map((o) => [o.id, o.title]),
        optionId || plan()?.choices[player.id],
      );
    if (["path", "choice"].includes(motion.type)) {
      const rule = motion.start || {
        type: "delay",
        seconds: motion.startAt || 0,
      };
      out += select(
        "start.type",
        tr("什么时候出发", "Start condition"),
        [
          ["delay", tr("开球后延迟", "Delay from start")],
          ["action", tr("等队友动作", "Wait for teammate action")],
        ],
        rule.type,
      );
      if (rule.type === "delay")
        out += input(
          "start.seconds",
          tr("延迟秒数（0＝同时）", "Delay seconds (0 = together)"),
          rule.seconds || 0,
          "number",
        );
      else
        out += bindingHtml("start", { ...rule, type: "action" }).replace(
          /<label>[^<]*<select data-edit="start.type">[\s\S]*?<\/label>/,
          "",
        );
      out += select(
        "template",
        tr("套用模板（会替换当前跑法）", "Template (replaces route)"),
        [
          ["", tr("选择跑法", "Choose route")],
          ...[
            "HITCH",
            "SLANT",
            "OUT",
            "POST",
            "CORNER",
            "FLY",
            "OPTION",
            "STOP AND GO",
            "POST CORNER",
            "CHAIR",
            "IN",
          ].map((x) => [x, x]),
        ],
        "",
      );
      out += btn("pause-action", tr("插入 1 秒停顿", "Add 1 s pause"));
      let from = player.at;
      out += steps
        .map((action, index) => {
          const length = stepLength(from, action);
          if (action.type !== "pause") from = action.to;
          const depth = play.field.lineOfScrimmageY - (action.to || from)[1];
          return `<div class="coach-action ${selection.action === action.id ? "selected" : ""}">${btn("select-action", `${index + 1} · ${action.type} · ${length.toFixed(1)} yd · ${tr("深度", "depth")} ${depth.toFixed(1)}`, `data-id="${esc(action.id)}"`)}${
            selection.action === action.id
              ? input(
                  "action.seconds",
                  tr("手动耗时（秒）", "Manual duration (s)"),
                  action.seconds,
                  "number",
                ) +
                select(
                  "action.timing",
                  tr("耗时方式", "Duration mode"),
                  [
                    ["auto", tr("自动示意", "Automatic teaching speed")],
                    ["fixed", tr("手动固定", "Fixed")],
                  ],
                  action.timing || "fixed",
                ) +
                (action.to ? pointHtml("action.to", action.to) : "") +
                (action.control
                  ? pointHtml("action.control", action.control)
                  : "") +
                (action.control1
                  ? pointHtml("action.control1", action.control1) +
                    pointHtml("action.control2", action.control2)
                  : "") +
                btn("frame-action", tr("绑定讲解停点", "Add bound stop")) +
                btn("delete-action", tr("删除动作", "Delete action")) +
                (action.facePlayer
                  ? `<p class="coach-warning">${esc(tr("保留原有面向设置（只读）：", "Legacy facing (read-only): ") + action.facePlayer)}</p>${btn("remove-facing", tr("明确移除旧朝向", "Remove legacy facing"))}`
                  : "")
              : ""
          }</div>`;
        })
        .join("");
    }
    return out;
  }
  function zoneHtml(zone) {
    return (
      input("label", tr("区域名称", "Zone label"), zone.label) +
      select(
        "type",
        tr("形状", "Shape"),
        [
          ["ellipse", tr("椭圆", "Ellipse")],
          ["rectangle", tr("矩形", "Rectangle")],
          ["polygon", tr("多边形", "Polygon")],
        ],
        zone.type,
      ) +
      (zone.type === "polygon"
        ? zone.points.map((p, i) => pointHtml(`points.${i}`, p)).join("")
        : pointHtml("center", zone.center) +
          input(
            "radiusX",
            tr("半宽（码）", "Half width (yd)"),
            zone.radiusX,
            "number",
          ) +
          input(
            "radiusY",
            tr("半高（码）", "Half height (yd)"),
            zone.radiusY,
            "number",
          )) +
      btn("remove-object", tr("删除区域", "Delete zone"))
    );
  }
  function explanationHtml(item, readonly) {
    const text = teachingText(item, getLanguage());
    if (readonly)
      return `<p class="coach-caption">${esc(text.text || tr("讲解待补／待核对", "Explanation missing / needs review"))}${text.fallback ? ` (${esc(tr("尚无译文", "Translation unavailable"))})` : ""}</p>`;
    const ex = item.explanation?.[getLanguage()] || {
      text: "",
      status: "confirmed",
    };
    return `<h3>${esc(tr("统一说明", "Explanation"))} · ${getLanguage() === "zh" ? "中文" : "English"}</h3><label><textarea aria-label="${esc(tr("统一说明", "Explanation"))}" data-edit="explanation" placeholder="${esc(tr("写下怎么跑、怎样与队友配合…", "Describe the action and teamwork…"))}">${esc(ex.text)}</textarea></label><p class="coach-help" data-coach-text-status>${esc(ex.status === "review" ? tr("旧说明待核对；确认前不用于教学。", "Needs review; hidden from teaching until confirmed.") : tr("已确认的说明用于教学；缺译文时明确提示。", "Confirmed text is used for teaching; missing translations are flagged."))}</p>${btn("confirm-text", tr("确认当前语言说明适用", "Confirm this explanation"))}`;
  }
  function sourcesHtml() {
    const origin = play.origin,
      en = origin.original?.translations?.en || {};
    const references = origin.references || [];
    return `<div class="coach-source"><h3>${esc(origin.kind === "self" ? tr("自编", "Self-authored") : tr("基于原战术改编", "Adapted from a source"))}</h3>${origin.referenceTitle ? `<p>${esc(titleOf({ title: origin.referenceTitle }))}</p>` : ""}${references
      .map((ref, i) => {
        if (!/^https?:\/\//.test(ref.url || "")) return "";
        const title =
          getLanguage() === "en"
            ? en[`source.references.${i}.title`] || ref.title
            : ref.title;
        const scope =
          getLanguage() === "en"
            ? en[`source.references.${i}.scope`] || ref.scope
            : ref.scope;
        return `<p><a href="${esc(ref.url)}" target="_blank" rel="noopener noreferrer">${esc(title || ref.url)} ↗</a><br><small>${esc(ref.role === "primary" ? tr("原始出处", "Primary source") : tr("补充资料", "Supporting source"))}${scope ? " · " + esc(scope) : ""}</small></p>`;
      })
      .join(
        "",
      )}${origin.original ? `<details><summary>${esc(tr("原始数据对照（只读）", "Original data (read-only)"))}</summary><pre class="coach-readonly">${esc(JSON.stringify(origin.original, null, 2))}</pre></details>` : ""}<p class="coach-help">${esc(tr("新增／调整的距离、时序与配合为教练教学设置，不归为官方原版。", "Edited distances, timing and teamwork are coaching choices, not the official original."))}</p></div>`;
  }
  function eventsHtml() {
    return `<h3>${esc(tr("共同动作前序（影响所有方案）", "Common prefix (all plans)"))}</h3>${play.sharedEvents.map((e) => btn("select-event", `${e.type} · ${e.from} → ${e.to || e.from}`, `data-id="${esc(e.id)}"`)).join("")}<h3>${esc(tr("当前方案动作链", "Current plan action chain"))}</h3>${(plan()?.events || []).map((e) => btn("select-event", `${e.type} · ${e.from} → ${e.to || e.from}`, `data-id="${esc(e.id)}"`)).join("")}`;
  }
  function eventHtml(event) {
    const shared = play.sharedEvents.some((e) => e.id === event.id);
    return (
      `<p class="coach-warning">${esc(shared ? tr("共同动作：修改影响所有方案", "Shared action: changes affect every plan") : tr("仅当前方案", "This plan only"))}</p>` +
      select("type", tr("球动作", "Ball action"), eventTypes(), event.type) +
      select(
        "from",
        tr("发起人", "From"),
        play.players.map((p) => [p.id, p.name || p.id]),
        event.from,
      ) +
      (event.type !== "pump-fake"
        ? select(
            "to",
            tr("接球／目标人", "To"),
            play.players.map((p) => [p.id, p.name || p.id]),
            event.to,
          )
        : "") +
      `<h3>${esc(tr("出手／开始", "Release / start"))}</h3>` +
      bindingHtml("start", event.start) +
      (event.end
        ? `<h3>${esc(tr("接球／完成", "Catch / end"))}</h3>` +
          bindingHtml("end", event.end)
        : "") +
      (shared
        ? btn(
            "split-shared",
            tr("从这里拆回各方案", "Split this tail into each plan"),
          )
        : btn(
            "promote",
            tr("到这里设为共同前序", "Share prefix through this action"),
          )) +
      btn("remove-object", tr("删除球动作", "Delete ball action"))
    );
  }

  function renderBoard() {
    const canvas = root.querySelector(".coach-canvas");
    if (!canvas || !play) return;
    canvas.setAttribute(
      "viewBox",
      `${camera.x} ${camera.y} ${camera.w} ${camera.h}`,
    );
    const compiled = compileCurrent(),
      preview = step === 4;
    const scene = getScene(compiled.lesson, time);
    const frame =
      compiled.keyframes.find(
        (f) => f.id === frameId && (!routesOnly || f.binding.type !== "ball"),
      ) ||
      compiled.keyframes
        .filter(
          (f) =>
            f.valid &&
            f.at <= time &&
            (!routesOnly || f.binding.type !== "ball"),
        )
        .at(-1);
    const layers = preview ? frame?.view : undefined;
    const fieldScale = Math.min(
      canvas.clientWidth / camera.w,
      canvas.clientHeight / camera.h,
    );
    const dot = Math.max(0.8, 11 / fieldScale),
      font = Math.max(0.8, 11 / fieldScale);
    let result = `<defs>${play.players.map((player, i) => `<marker id="coach-arrow-${i}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0 0 L10 5 L0 10 Z" fill="${colorOf(player, i)}"/></marker>`).join("")}<marker id="coach-ball-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0 0 L10 5 L0 10 Z" fill="#ffbd76"/></marker><marker id="coach-duty-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0 0 L10 5 L0 10 Z" fill="#ded9a0"/></marker></defs><rect x="0" y="0" width="30" height="70" rx=".6" fill="#315e4e" stroke="#9db6a6" stroke-width=".12"/><rect width="30" height="10" fill="#a8bd9b22"/><rect y="60" width="30" height="10" fill="#a8bd9b22"/><text x="15" y="6" text-anchor="middle" font-size="1.2" fill="#dde8cf">${esc(tr("进攻端区", "End zone"))} ↑</text>`;
    for (let y = 10; y <= 60; y += 5)
      result += `<path d="M0 ${y} H30" stroke="#a5c2a544" stroke-width=".08"/><text x="30.5" y="${y + 0.4}" font-size=".9" fill="#f2d58f">${play.field.lineOfScrimmageY - y}</text>`;
    result += `<path d="M0 ${play.field.lineOfScrimmageY} H30" stroke="#e8d592" stroke-width=".18"/><text x=".5" y="${play.field.lineOfScrimmageY - 0.5}" font-size=".8" fill="#f2d58f">${esc(tr("开球线", "LOS"))}</text><path d="M15 10 V60" stroke="#aac5a333" stroke-dasharray=".5 .8" stroke-width=".1"/>`;
    const hit = (kind, id, extra = "") =>
      `data-hit="${kind}" data-id="${esc(id)}" ${extra} tabindex="0" role="button"`;
    const handle = (point, kind, id, key) =>
      `<circle cx="${point[0]}" cy="${point[1]}" r="${hitRadius()}" fill="transparent" stroke="none" ${hit(kind, id, `data-key="${esc(key)}"`)} aria-label="${esc(tr("拖动控制点", "Drag control point"))}"/><circle pointer-events="none" cx="${point[0]}" cy="${point[1]}" r=".35" fill="#fff1d5" stroke="#e5bb68" stroke-width=".12"/>`;
    for (const zone of play.zones) {
      if (layers && !layers.zoneIds.includes(zone.id)) continue;
      const selected = selection.id === zone.id;
      const attrs = `fill="#c7e8a238" stroke="${selected ? "#f4ca65" : "#c7e8a2"}" stroke-width=".2" ${hit("zone", zone.id)} aria-label="${esc(zone.label)}"`;
      result +=
        zone.type === "polygon"
          ? `<polygon points="${zone.points.map((p) => p.join(",")).join(" ")}" ${attrs}/>`
          : zone.type === "rectangle"
            ? `<rect x="${zone.center[0] - zone.radiusX}" y="${zone.center[1] - zone.radiusY}" width="${2 * zone.radiusX}" height="${2 * zone.radiusY}" ${attrs}/>`
            : `<ellipse cx="${zone.center[0]}" cy="${zone.center[1]}" rx="${zone.radiusX}" ry="${zone.radiusY}" ${attrs}/>`;
      const center = zoneCenter(zone);
      result += `<text pointer-events="none" x="${center[0]}" y="${center[1]}" font-size="1" text-anchor="middle" fill="#eef3d5">${esc(zone.label)}</text>`;
      if (selected && !preview)
        result +=
          zone.type === "polygon"
            ? zone.points
                .map((p, i) => handle(p, "zone", zone.id, `points.${i}`))
                .join("")
            : handle(
                [zone.center[0] + zone.radiusX, zone.center[1]],
                "zone",
                zone.id,
                "radiusX",
              ) +
              handle(
                [zone.center[0], zone.center[1] + zone.radiusY],
                "zone",
                zone.id,
                "radiusY",
              );
    }
    for (const duty of compiled.lesson.assignments) {
      if (!duty.guide || (layers && !layers.assignmentIds.includes(duty.id)))
        continue;
      const d = pathToSvg(duty.guide.from, duty.guide.steps);
      result += `<path d="${esc(d)}" fill="none" stroke="#ded9a0" stroke-dasharray=".3 .4" stroke-width=".2" marker-end="url(#coach-duty-arrow)"/><path d="${esc(d)}" fill="none" stroke="transparent" stroke-width="${hitRadius() * 2}" ${hit("duty", duty.id)} aria-label="${esc(duty.player + " " + duty.type)}"/>`;
      if (selection.id === duty.id && duty.end && !preview)
        result += handle(duty.end, "duty", duty.id, "end");
    }
    for (const target of play.targets)
      result += `<g ${hit("target", target.id)} aria-label="${esc(target.name)}"><circle cx="${target.at[0]}" cy="${target.at[1]}" r="${hitRadius()}" fill="transparent"/><path d="M${target.at[0] - 0.5} ${target.at[1]} H${target.at[0] + 0.5} M${target.at[0]} ${target.at[1] - 0.5} V${target.at[1] + 0.5}" stroke="#f4ca65" stroke-width=".15"/><text x="${target.at[0]}" y="${target.at[1] + 1.5}" font-size=".8" fill="#f4ca65" text-anchor="middle">${esc(target.name)}</text></g>`;
    for (const [i, player] of play.players.entries()) {
      const motion =
          !preview && selection.id === player.id && scope === "base"
            ? player.motion
            : motionFor(play, plan(), player),
        steps = stepsFor(
          motion,
          selection.id === player.id
            ? optionId || plan()?.choices[player.id]
            : plan()?.choices[player.id],
        );
      if (steps.length)
        result += `<path d="${esc(pathToSvg(player.at, steps))}" fill="none" stroke="${colorOf(player, i)}" stroke-width=".25" opacity="${selection.id === player.id ? 1 : 0.6}" marker-end="url(#coach-arrow-${i})"/>`;
      if (selection.id === player.id && !preview) {
        for (const action of steps) {
          if (action.to) result += handle(action.to, "action", action.id, "to");
          for (const key of ["control", "control1", "control2"])
            if (action[key])
              result += handle(action[key], "action", action.id, key);
        }
      }
    }
    if (poly.length)
      result += `<polyline points="${poly.map((p) => p.join(",")).join(" ")}" fill="none" stroke="#f4ca65" stroke-width=".25"/>`;
    const badBall = checks(false).errors.some(
      (e) =>
        (!e.scenario || e.scenario === scenarioId) &&
        e.step === 3 &&
        !play.bookmarks.some((f) => f.id === e.object),
    );
    let ball;
    if (preview && !routesOnly && !badBall && compiled.lesson.ball) {
      ball = getBallState(compiled.lesson, time, {}, compiled.scenario);
      for (const flight of ball.flights)
        result += `<path d="M${flight.start.join(" ")} L${flight.end.join(" ")}" stroke="#ffbd76" stroke-dasharray=".5 .4" stroke-width=".25" fill="none" marker-end="url(#coach-ball-arrow)" ${hit("ball-stop", flight.id, `data-time="${flight.at}"`)} />`;
      for (const event of compiled.scenario.events.filter((e) =>
        ["handoff", "fake-handoff", "pump-fake"].includes(e.type),
      )) {
        const from = compiled.lesson.players.find((p) => p.id === event.from);
        const at = positionAt(from, event.at);
        result += `<g ${hit("ball-stop", event.id, `data-time="${event.at}"`)}><circle cx="${at[0]}" cy="${at[1]}" r="${hitRadius()}" fill="transparent"/><text x="${at[0]}" y="${at[1] - 1.2}" text-anchor="middle" font-size="1" fill="#ffbd76">${event.type === "handoff" ? "○" : "FAKE"}</text></g>`;
      }
      for (const carry of ball.carries) {
        if (time <= carry.at) continue;
        const p = compiled.lesson.players.find((p) => p.id === carry.owner),
          points = [];
        for (let t = carry.at; t <= Math.min(carry.endAt, time); t += 0.05)
          points.push(positionAt(p, t));
        points.push(positionAt(p, Math.min(time, carry.endAt)));
        result += `<polyline points="${points.map((p) => p.join(",")).join(" ")}" fill="none" stroke="#ffffff" stroke-width=".12"/>`;
      }
    }
    for (const [i, player] of scene.players.entries()) {
      let at = preview ? player.position : player.at;
      if (!at.every(Number.isFinite)) at = player.at;
      const selected = selection.id === player.id;
      let direction = player.facing?.direction;
      if (!direction) {
        let earlier = positionAt(player, Math.max(0, time - 0.01)),
          later = positionAt(player, time + 0.01);
        if (earlier.every(Number.isFinite) && later.every(Number.isFinite))
          direction = [later[0] - earlier[0], later[1] - earlier[1]];
        if (!direction || Math.hypot(...direction) < 1e-6) {
          let from = player.at;
          for (const a of player.motion.steps || []) {
            if (a.to) {
              direction = [a.to[0] - from[0], a.to[1] - from[1]];
              from = a.to;
            }
            if (
              time <
              (player.motion.startAt || 0) +
                (player.motion.steps || [])
                  .slice(0, (player.motion.steps || []).indexOf(a) + 1)
                  .reduce((v, s) => v + s.seconds, 0)
            )
              break;
          }
        }
      }
      const angle = direction
        ? (Math.atan2(direction[1], direction[0]) * 180) / Math.PI
        : -90;
      result += `<g ${hit("player", player.id)} aria-label="${esc((player.name || player.id) + " " + player.label.en)}"><title>${esc(player.label.en + " · " + (teachingText(player, getLanguage()).text || tr("讲解待核对", "Explanation needs review")))}</title><circle cx="${at[0]}" cy="${at[1]}" r="${hitRadius()}" fill="transparent"/>${selected ? `<circle pointer-events="none" cx="${at[0]}" cy="${at[1]}" r="${dot + 0.3}" fill="none" stroke="#f4ca65" stroke-width=".15"/>` : ""}<circle pointer-events="none" cx="${at[0]}" cy="${at[1]}" r="${dot}" fill="${colorOf(player, i)}"/>${player.motion.type === "path" || player.facing ? `<path pointer-events="none" d="M .7 -.35 L1.4 0 L.7 .35 Z" transform="translate(${at[0]} ${at[1]}) rotate(${angle})" fill="${colorOf(player, i)}"/>` : ""}<text pointer-events="none" x="${at[0]}" y="${at[1] + 0.3}" text-anchor="middle" font-size="${font}" font-weight="bold" fill="#184639">${esc((player.name || player.id).length > 4 ? player.id : player.name || player.id)}</text></g>`;
    }
    if (ball)
      result += `<ellipse cx="${ball.position[0] + 0.8}" cy="${ball.position[1]}" rx=".5" ry=".3" fill="#eeb269" stroke="#fff1d5" stroke-width=".1"/>`;
    canvas.innerHTML = result;
  }
  function hitRadius() {
    const node = root.querySelector(".coach-canvas");
    const box = node?.getBoundingClientRect();
    const scale = box
      ? Math.min(box.width / camera.w, box.height / camera.h)
      : 10;
    return Math.max(1.2, 22 / scale);
  }
  function getPoint(event) {
    const canvas = root.querySelector(".coach-canvas");
    const point = canvas.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const p = point.matrixTransform(canvas.getScreenCTM().inverse());
    return [p.x, p.y];
  }
  function snapPoint(point) {
    return point.map((value) =>
      snap ? Math.round(value) : Math.round(value * 100) / 100,
    );
  }
  function selectObject(kind, id, action) {
    selection = { kind, id, ...(action ? { action } : {}) };
    const panel = root.querySelector(".coach-inspector");
    if (panel) panel.scrollTop = 0;
    drawer = true;
    optionId = undefined;
    render();
  }
  function ensureMotion() {
    if (scope === "plan" && !plan()) {
      toast(tr("先创建一个方案", "Create a plan first"));
      return;
    }
    const player = selectedPlayer();
    if (!player) {
      toast(tr("先点选一名球员", "Select a player first"));
      return;
    }
    let motion = player.motion;
    if (scope === "plan") {
      if (!plan().overrides[player.id]) {
        const value = clone(player.motion),
          mapping = new Map();
        for (const steps of value.type === "choice"
          ? value.options.map((o) => o.steps)
          : [value.steps || []])
          for (const a of steps) {
            const id = uid("action");
            mapping.set(a.id, id);
            a.id = id;
          }
        plan().overrides[player.id] = value;
        const rebind = (o) => {
          if (!o || typeof o !== "object") return;
          for (const [key, val] of Object.entries(o))
            if (key === "action" && mapping.has(val)) o[key] = mapping.get(val);
            else rebind(val);
        };
        rebind(plan());
        for (const f of play.bookmarks.filter((f) => f.scenario === scenarioId))
          rebind(f);
      }
      motion = plan().overrides[player.id];
    }
    if (!["path", "choice"].includes(motion.type)) {
      motion = {
        type: "path",
        start: { type: "delay", seconds: 0 },
        steps: [],
        note: motion.note,
      };
      if (scope === "plan") plan().overrides[player.id] = motion;
      else player.motion = motion;
    }
    return motion;
  }
  function appendRoute(point, type = "line") {
    const player = selectedPlayer();
    if (!player) return;
    const motion = ensureMotion();
    if (!motion) return;
    const steps = stepsFor(motion, optionId || plan()?.choices[player.id]);
    const from = steps.filter((s) => s.to).at(-1)?.to || player.at;
    const action = {
      id: uid("action"),
      type,
      to: point,
      seconds: 1,
      timing: "auto",
    };
    if (type === "quadratic")
      action.control = [(from[0] + point[0]) / 2 + 1, (from[1] + point[1]) / 2];
    steps.push(action);
    retime(player, motion);
    addActionStop(player, action);
  }
  function addActionStop(player, action) {
    const index = motionSteps().findIndex((a) => a.id === action.id) + 1;
    play.bookmarks.push({
      id: uid("stop"),
      title: {
        zh: `${player.name || player.id} · 动作 ${index}`,
        en: `${player.name || player.id} · Action ${index}`,
      },
      binding: {
        type: "action",
        player: player.id,
        action: action.id,
        phase: "end",
        offset: 0,
      },
      ...(scope === "plan" ? { scenario: scenarioId } : {}),
      explanation: explanation(),
    });
  }
  function applyTemplate(term) {
    const player = selectedPlayer();
    if (!player) return;
    const motion = ensureMotion();
    if (!motion) return;
    const p = player.at,
      inward = p[0] < 15 ? 1 : -1;
    const pt = (dx, dy) => [p[0] + dx, p[1] - dy];
    const paths = {
      HITCH: [pt(0, 7), pt(inward * 2, 5)],
      SLANT: [pt(0, 1), pt(inward * 5, 6)],
      OUT: [pt(0, 5), pt(-inward * 5, 5)],
      IN: [pt(0, 5), pt(inward * 5, 5)],
      POST: [pt(0, 8), pt(inward * 6, 14)],
      CORNER: [pt(0, 8), pt(-inward * 5, 14)],
      FLY: [pt(0, 18)],
      OPTION: [pt(0, 6), pt(inward * 3, 9), pt(-inward * 3, 12)],
      "STOP AND GO": [pt(0, 5), null, pt(0, 15)],
      "POST CORNER": [pt(0, 7), pt(inward * 3, 10), pt(-inward * 4, 15)],
      CHAIR: [pt(0, 5), pt(-inward * 4, 5), pt(-inward * 4, 14)],
    };
    const steps = paths[term].map((to, i) =>
      to
        ? {
            id: uid("action"),
            type: term === "HITCH" && i === 1 ? "quadratic" : "line",
            to,
            seconds: 1,
            timing: "auto",
            ...(term === "HITCH" && i === 1 ? { control: pt(0, 4) } : {}),
          }
        : { id: uid("action"), type: "pause", seconds: 1, timing: "fixed" },
    );
    if (motion.type === "choice") {
      const choice = motion.options.find(
        (o) => o.id === (optionId || plan()?.choices[player.id]),
      );
      if (!choice) {
        toast(tr("先选择备用跑法", "Select a route choice first"));
        return;
      }
      choice.steps = steps;
    } else motion.steps = steps;
    player.label.en = term;
    player.label.basis = "author";
    retime(player, motion);
    for (const a of steps) addActionStop(player, a);
    markReview(play, [player]);
  }
  function addEvent(type, target) {
    if (!plan()) {
      toast(tr("先创建一个方案", "Create a plan first"));
      return;
    }
    const player = selectedPlayer();
    if (!player) {
      toast(
        tr(
          "先选发起人，再点目标球员",
          "Select the initiator, then tap the target",
        ),
      );
      return;
    }
    const compiled = compileCurrent(),
      previous = compiled.scenario?.events.at(-1);
    const start = Math.max(0.5, time, previous?.endAt ?? previous?.at ?? 0);
    const event = {
      id: uid("ball"),
      type,
      from: player.id,
      ...(type !== "pump-fake" ? { to: target } : {}),
      start: { type: "time", seconds: start },
      ...(["snap", "pass"].includes(type)
        ? { end: { type: "time", seconds: start + 0.7 } }
        : {}),
      label: type,
      cue: "",
      explanation: explanation(),
    };
    if (type === "pass") {
      const receiver = play.players.find((p) => p.id === target),
        motion = motionFor(play, plan(), receiver),
        action = stepsFor(motion, plan().choices[target]).at(-1);
      if (action && compiled.actions.get(action.id)?.end > start)
        event.end = {
          type: "action",
          player: target,
          action: action.id,
          phase: "end",
          offset: 0,
        };
    }
    plan().mode = "ball";
    plan().events.push(event);
    markReview(
      play,
      [player, play.players.find((p) => p.id === target)].filter(Boolean),
    );
    for (const phase of event.end ? ["start", "end"] : ["start"])
      play.bookmarks.push({
        id: uid("stop"),
        title: {
          zh: `${eventTypes().find((t) => t[0] === type)?.[1] || type} · ${phase === "start" ? "开始" : "完成"}`,
          en: `${type} · ${phase}`,
        },
        binding: { type: "ball", event: event.id, phase },
        scenario: scenarioId,
        explanation: explanation(),
      });
    selection = { kind: "event", id: event.id };
    drawer = true;
  }
  function addDuty(type, target, point) {
    const player = selectedPlayer();
    if (!player) {
      toast(tr("先选负责的防守者", "Select a defender first"));
      return;
    }
    const duty = {
      id: uid("duty"),
      type,
      player: player.id,
      explanation: explanation(),
      ...(type === "coverage"
        ? { zone: target }
        : target
          ? { target }
          : { end: point }),
    };
    play.assignments.push(duty);
    selection = { kind: "duty", id: duty.id };
    drawer = true;
    tool = "select";
  }

  root.addEventListener("pointerdown", (event) => {
    const canvas = event.target.closest(".coach-canvas");
    if (!canvas) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      if (gesture?.baseline) play = gesture.baseline;
      const values = [...pointers.values()];
      const center = {
        x: (values[0].x + values[1].x) / 2,
        y: (values[0].y + values[1].y) / 2,
      };
      gesture = {
        type: "pinch",
        camera: { ...camera },
        distance: Math.hypot(
          values[1].x - values[0].x,
          values[1].y - values[0].y,
        ),
        center,
        anchor: getPoint({ clientX: center.x, clientY: center.y }),
        scale: Math.min(
          canvas.clientWidth / camera.w,
          canvas.clientHeight / camera.h,
        ),
      };
      renderBoard();
      return;
    }
    if (pointers.size > 1) return;
    const hit = event.target.closest("[data-hit]");
    const point = getPoint(event);
    let draggable =
      step !== 4 &&
      !viewOnly &&
      tool === "select" &&
      hit &&
      (selection.id === hit.dataset.id ||
        (hit.dataset.hit === "action" && selection.kind === "player"));
    gesture = {
      type:
        step === 4 || viewOnly
          ? "preview"
          : tool === "pan"
            ? "pan"
            : draggable
              ? "drag"
              : tool === "freehand"
                ? "freehand"
                : "click",
      hit: hit
        ? {
            kind: hit.dataset.hit,
            id: hit.dataset.id,
            key: hit.dataset.key,
            time: hit.dataset.time,
          }
        : null,
      start: point,
      screen: { x: event.clientX, y: event.clientY },
      camera: { ...camera },
      baseline: clone(play),
      moved: false,
      points: [point],
    };
  });
  root.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId) || !gesture) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.preventDefault();
    const canvas = root.querySelector(".coach-canvas");
    if (gesture.type === "pinch") {
      if (pointers.size < 2) return;
      const values = [...pointers.values()],
        distance = Math.hypot(
          values[1].x - values[0].x,
          values[1].y - values[0].y,
        ),
        ratio = Math.min(
          4,
          Math.max(0.25, gesture.distance / Math.max(1, distance)),
        );
      const center = {
        x: (values[0].x + values[1].x) / 2,
        y: (values[0].y + values[1].y) / 2,
      };
      const c = gesture.camera,
        a = gesture.anchor;
      camera = {
        x:
          a[0] -
          (a[0] - c.x) * ratio -
          ((center.x - gesture.center.x) / gesture.scale) * ratio,
        y:
          a[1] -
          (a[1] - c.y) * ratio -
          ((center.y - gesture.center.y) / gesture.scale) * ratio,
        w: c.w * ratio,
        h: c.h * ratio,
      };
      renderBoard();
      return;
    }
    const point = getPoint(event),
      distance = Math.hypot(
        event.clientX - gesture.screen.x,
        event.clientY - gesture.screen.y,
      );
    if (distance < 5 && !gesture.moved) return;
    gesture.moved = true;
    if (gesture.type === "pan" || gesture.type === "preview") {
      const scale = Math.min(
        canvas.clientWidth / camera.w,
        canvas.clientHeight / camera.h,
      );
      camera = {
        ...gesture.camera,
        x: gesture.camera.x - (event.clientX - gesture.screen.x) / scale,
        y: gesture.camera.y - (event.clientY - gesture.screen.y) / scale,
      };
      renderBoard();
      return;
    }
    if (gesture.type === "freehand") {
      gesture.points.push(point);
      poly = gesture.points;
      renderBoard();
      return;
    }
    if (gesture.type === "drag") {
      play = clone(gesture.baseline);
      const p = snapPoint(point),
        delta = p.map((v, i) => v - gesture.start[i]),
        hit = gesture.hit;
      if (hit.kind === "player") {
        const player = play.players.find((p) => p.id === hit.id);
        movePlayer(
          play,
          player,
          snapPoint(player.at.map((v, i) => v + delta[i])),
          whole,
        );
      }
      if (hit.kind === "target") {
        const target = play.targets.find((p) => p.id === hit.id);
        target.at = snapPoint(target.at.map((v, i) => v + delta[i]));
        markReview(play, [target]);
      }
      if (hit.kind === "zone") {
        const zone = play.zones.find((z) => z.id === hit.id);
        if (hit.key === "radiusX")
          zone.radiusX = Math.abs(p[0] - zone.center[0]);
        else if (hit.key === "radiusY")
          zone.radiusY = Math.abs(p[1] - zone.center[1]);
        else if (hit.key?.startsWith("points."))
          zone.points[Number(hit.key.split(".")[1])] = p;
        else if (zone.center)
          zone.center = snapPoint(zone.center.map((v, i) => v + delta[i]));
        else
          zone.points = zone.points.map((q) =>
            snapPoint(q.map((v, i) => v + delta[i])),
          );
        markReview(play, [zone]);
      }
      if (hit.kind === "duty") {
        const duty = play.assignments.find((d) => d.id === hit.id);
        if (hit.key) duty.end = p;
        markReview(play, [duty]);
      }
      if (hit.kind === "action") {
        const player = selectedPlayer();
        const action = motionSteps().find((a) => a.id === hit.id);
        if (action) {
          action[hit.key] = p;
          retime(player, selectedMotion());
          markReview(play, [player]);
        }
      }
      renderBoard();
    }
  });
  root.addEventListener("pointerup", (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (!gesture) return;
    if (gesture.type === "pinch") {
      if (!pointers.size) gesture = null;
      return;
    }
    if (pointers.size) return;
    const current = gesture;
    gesture = null;
    if (current.type === "drag" && current.moved) {
      undo.push(current.baseline);
      redo = [];
      changed();
      render();
      return;
    }
    if (current.type === "freehand" && current.moved) {
      poly = [];
      mutate(
        () => {
          const points = current.points.filter(
            (p, i, all) => i === all.length - 1 || i % 4 === 0,
          );
          let previous = selectedPlayer()?.at;
          for (const p of points) {
            const next = snapPoint(p);
            if (
              previous &&
              Math.hypot(next[0] - previous[0], next[1] - previous[1]) > 0.5
            ) {
              appendRoute(next);
              previous = next;
            }
          }
        },
        { review: true, objects: [selectedPlayer()].filter(Boolean) },
      );
      return;
    }
    if (current.moved || current.type === "pan") return;
    const point = snapPoint(current.start),
      hit = current.hit;
    if (current.type === "preview") {
      if (hit && ["player", "zone", "target", "duty"].includes(hit.kind))
        selectObject(hit.kind, hit.id);
      else if (hit?.kind === "ball-stop") {
        time = Number(hit.time);
        playing = false;
        frameId = null;
        render();
      }
      return;
    }
    if (["line", "quadratic"].includes(tool)) {
      if (!selectedPlayer()) {
        toast(
          tr(
            "先用点选工具选球员，再画路线。",
            "Select a player before drawing.",
          ),
        );
        return;
      }
      mutate(() => appendRoute(point, tool), {
        review: true,
        objects: [selectedPlayer()],
      });
      return;
    }
    if (["ellipse", "rectangle"].includes(tool)) {
      mutate(() => {
        const zone = {
          id: uid("zone"),
          type: tool,
          label: tr("新区域", "New zone"),
          center: point,
          radiusX: 3,
          radiusY: 4,
          explanation: explanation(),
        };
        play.zones.push(zone);
        selection = { kind: "zone", id: zone.id };
        tool = "select";
        drawer = true;
      });
      return;
    }
    if (tool === "polygon") {
      poly.push(point);
      renderBoard();
      render();
      return;
    }
    if (tool === "target") {
      mutate(() => {
        const target = {
          id: uid("target"),
          name: tr("对方 X", "Opponent X"),
          at: point,
          explanation: explanation(),
        };
        play.targets.push(target);
        selection = { kind: "target", id: target.id };
        tool = "select";
        drawer = true;
      });
      return;
    }
    if (["coverage", "matchup", "rush"].includes(tool)) {
      if (tool === "coverage" && hit?.kind !== "zone") {
        toast(tr("请点负责区域", "Tap the zone"));
        return;
      }
      if (tool === "matchup" && hit?.kind !== "target") {
        toast(tr("请点命名目标", "Tap a named target"));
        return;
      }
      mutate(() =>
        addDuty(
          tool,
          hit?.kind === "zone" || hit?.kind === "target" ? hit.id : null,
          point,
        ),
      );
      return;
    }
    if (eventTypes().some((t) => t[0] === tool)) {
      if (hit?.kind !== "player") {
        toast(tr("请点目标球员", "Tap the target player"));
        return;
      }
      mutate(() => addEvent(tool, hit.id));
      return;
    }
    if (hit) {
      if (hit.kind === "action") {
        selection.action = hit.id;
        drawer = true;
        render();
      } else selectObject(hit.kind, hit.id);
    } else {
      selection = { kind: "play" };
      render();
    }
  });
  root.addEventListener("pointercancel", (event) => {
    pointers.delete(event.pointerId);
    if (gesture?.baseline && gesture.type === "drag") play = gesture.baseline;
    if (!pointers.size) {
      gesture = null;
      poly = [];
      render();
    }
  });
  root.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-do]");
    if (!target) return;
    event.preventDefault();
    const action = target.dataset.do,
      id = target.dataset.id;
    try {
      if (action === "close")
        await leave(() => {
          root.hidden = true;
          document.body.style.overflow = "";
          document.body.classList.remove("coach-open");
          for (const n of document.querySelectorAll(".app-header,.layout,#floatingPlay"))
            n.inert = false;
        });
      if (action === "library")
        await leave(() => {
          screen = "library";
          play = undefined;
          record = undefined;
          viewOnly = false;
          render();
        });
      if (action === "new") await leave(newDialog);
      if (action === "copy-builtin")
        await leave(() => {
          const source = getCurrentLesson();
          ask(
            `<h2>${esc(tr("复制为我的战术", "Copy to my tactics"))}</h2><p>${esc(titleOf(source))}</p>`,
            () => create(source.kind, source),
          );
        });
      if (action === "edit-record" || action === "demo-record") {
        const value = records.find((r) => r.id === id);
        if (value) openRecord(value, action === "demo-record");
      }
      if (action === "edit-current")
        openRecord(records.find((r) => r.id === record.id));
      if (action === "step") {
        step = Number(target.dataset.step);
        tool = "select";
        playing = false;
        time = 0;
        frameId = null;
        poly = [];
        render();
      }
      if (action === "panel") {
        drawer = !drawer;
        const panel = root.querySelector(".coach-inspector");
        panel.dataset.open = String(drawer);
      }
      if (action === "select-play") selectObject("play", play.id);
      if (action === "select-action") {
        selection.action = id;
        render();
      }
      for (const [a, kind] of [
        ["select-event", "event"],
        ["select-duty", "duty"],
        ["select-frame", "frame"],
      ])
        if (action === a) selectObject(kind, id);
      if (action === "tool") {
        tool = target.dataset.tool;
        poly = [];
        if (tool === "pump-fake") mutate(() => addEvent("pump-fake"));
        else render();
      }
      if (action === "full") {
        camera = { x: -3, y: -3, w: 36, h: 76 };
        renderBoard();
      }
      if (action === "near") {
        camera = { x: -2, y: 28, w: 34, h: 34 };
        renderBoard();
      }
      if (action === "zoom-in" || action === "zoom-out") {
        const ratio = action === "zoom-in" ? 0.8 : 1.25;
        const w = camera.w * ratio,
          h = camera.h * ratio;
        camera = {
          x: camera.x + (camera.w - w) / 2,
          y: camera.y + (camera.h - h) / 2,
          w,
          h,
        };
        renderBoard();
      }
      if (action === "undo" && undo.length) {
        redo.push(clone(play));
        play = undo.pop();
        changed();
        render();
      }
      if (action === "redo" && redo.length) {
        undo.push(clone(play));
        play = redo.pop();
        changed();
        render();
      }
      if (action === "save") await save();
      if (action === "save-copy") await save(true);
      if (action === "retry") {
        if (!store.db && !store.temporary) await store.open();
        await retain();
        if (screen === "library") {
          records = await store.list();
          saveError = "";
          render();
        }
      }
      if (action === "temporary") {
        store.temporary = true;
        saveError = "";
        render();
      }
      if (action === "export-one") exportBackup(true);
      if (action === "export-all") exportBackup(false);
      if (action === "play") {
        if (!playing && time >= compileCurrent().lesson.timeline.duration)
          time = 0;
        step = 4;
        tool = "select";
        playing = !playing;
        lastTick = undefined;
        if(playing&&coachTick===undefined)coachTick=requestAnimationFrame(tick);
        render();
      }
      if (action === "reset") {
        playing = false;
        time = 0;
        frameId = null;
        render();
      }
      if (action === "seek-frame") {
        const frame = compileCurrent().keyframes.find((f) => f.id === id);
        if (frame?.valid) {
          step = 4;
          time = frame.at;
          frameId = id;
          playing = false;
          render();
        }
      }
      if (action === "problem") {
        const problem = checks().errors[Number(target.dataset.index)];
        step = problem.step;
        if (problem.scenario) scenarioId = problem.scenario;
        const found = [
          ["player", play.players],
          ["zone", play.zones],
          ["target", play.targets],
          ["duty", play.assignments],
          ["frame", play.bookmarks],
          ["event", [...play.sharedEvents, ...(plan()?.events || [])]],
        ].find(([, items]) => items.some((o) => o.id === problem.object));
        if (found) selectObject(found[0], problem.object);
        else {
          for (const p of play.players)
            if (
              stepsFor(motionFor(play, plan(), p), plan()?.choices[p.id]).some(
                (a) => a.id === problem.object,
              )
            ) {
              selection = { kind: "player", id: p.id, action: problem.object };
              break;
            }
          drawer = true;
          render();
        }
      }
      if (action === "pause-action")
        mutate(
          () => {
            const motion = ensureMotion();
            if (motion) {
              const a = {
                id: uid("action"),
                type: "pause",
                seconds: 1,
                timing: "fixed",
              };
              stepsFor(
                motion,
                optionId || plan()?.choices?.[selection.id],
              ).push(a);
              addActionStop(selectedPlayer(), a);
              selection.action = a.id;
            }
          },
          { review: true, objects: [selectedPlayer()].filter(Boolean) },
        );
      if (action === "frame-action")
        mutate(() => {
          const a = motionSteps().find((s) => s.id === selection.action);
          if (a) addActionStop(selectedPlayer(), a);
        });
      if (action === "delete-action")
        mutate(
          () => {
            const steps = motionSteps(),
              index = steps.findIndex((a) => a.id === selection.action);
            steps.splice(index, 1);
            retime(selectedPlayer(), selectedMotion());
            delete selection.action;
          },
          { review: true, objects: [selectedPlayer()] },
        );
      if (action === "remove-facing")
        mutate(
          () => {
            delete motionSteps().find((a) => a.id === selection.action)
              .facePlayer;
          },
          { review: true, objects: [selectedPlayer()] },
        );
      if (action === "clear-override")
        mutate(
          () => {
            delete plan().overrides[selection.id];
            scope = "base";
          },
          { review: true, objects: [selectedPlayer()] },
        );
      if (action === "confirm-text")
        mutate(() => {
          const item = object();
          item.explanation ||= explanation();
          item.explanation[getLanguage()] ||= { text: "", status: "confirmed" };
          item.explanation[getLanguage()].status = "confirmed";
        });
      if (action === "confirm-legacy")
        mutate(() => {
          selectedPlayer().legacyReview = false;
        });
      if (action === "reset-layers")
        mutate(() => {
          object().view = {
            zoneIds: play.zones.map((z) => z.id),
            assignmentIds: play.assignments.map((d) => d.id),
          };
        });
      if (action === "add-frame")
        mutate(() => {
          const frame = {
            id: uid("stop"),
            title: { zh: "讲解停点", en: "Teaching stop" },
            binding: { type: "time", seconds: time },
            scenario: scenarioId,
            explanation: explanation(),
          };
          play.bookmarks.push(frame);
          selection = { kind: "frame", id: frame.id };
          drawer = true;
        });
      if (action === "finish-polygon") {
        if (poly.length < 3) {
          toast(tr("至少点三个顶点", "Add at least three vertices"));
          return;
        }
        mutate(() => {
          const z = {
            id: uid("zone"),
            type: "polygon",
            points: clone(poly),
            label: tr("新区域", "New zone"),
            explanation: explanation(),
          };
          play.zones.push(z);
          poly = [];
          selection = { kind: "zone", id: z.id };
          tool = "select";
          drawer = true;
        });
      }
      if (action === "remove-object")
        mutate(
          () => {
            const collections = {
              zone: play.zones,
              target: play.targets,
              duty: play.assignments,
              frame: play.bookmarks,
            };
            if (selection.kind === "event") {
              for (const events of [play.sharedEvents, plan()?.events || []]) {
                const index = events.findIndex((e) => e.id === selection.id);
                if (index >= 0) events.splice(index, 1);
              }
            } else {
              const items = collections[selection.kind],
                index = items?.findIndex((item) => item.id === selection.id);
              if (index >= 0) items.splice(index, 1);
            }
            selection = { kind: "play" };
          },
          { review: true },
        );
      if (action === "copy-plan")
        mutate(() => {
          scenarioId = copyScenario(play, plan()).id;
          time = 0;
          frameId = null;
          selection = { kind: "play" };
        });
      if (action === "new-plan")
        mutate(() => {
          const value = {
            id: uid("plan"),
            title: {
              zh: `方案 ${play.scenarios.length + 1}`,
              en: `Plan ${play.scenarios.length + 1}`,
            },
            mode: "routes",
            choices: {},
            overrides: {},
            events: [],
            explanation: explanation(),
          };
          play.scenarios.push(value);
          scenarioId = value.id;
          selection = { kind: "play" };
        });
      if (action === "delete-plan")
        ask(
          `<p>${esc(tr("删除当前方案？关联停点会保留为待修复，需明确处理。", "Delete this plan? Associated stops remain pending repair."))}</p>`,
          () =>
            mutate(() => {
              play.scenarios = play.scenarios.filter(
                (s) => s.id !== scenarioId,
              );
              scenarioId = play.scenarios[0]?.id;
              selection = { kind: "play" };
            }),
        );
      if (action === "promote")
        ask(
          `<p>${esc(tr("将当前方案到此动作为止的前段设为共同动作，影响所有方案。其他方案原动作保留并重新检查。", "Share this prefix across all plans. Other actions remain and will be checked again."))}</p>`,
          () =>
            mutate(
              () =>
                promotePrefix(
                  play,
                  plan(),
                  plan().events.findIndex((e) => e.id === selection.id),
                ),
              { review: true },
            ),
        );
      if (action === "split-shared")
        mutate(
          () => {
            splitShared(
              play,
              play.sharedEvents.findIndex((e) => e.id === selection.id),
            );
            selection = { kind: "play" };
          },
          { review: true },
        );
      if (action === "history") {
        ask(
          `<h2>${esc(tr("最近 10 个保存版本", "Last 10 saved versions"))}</h2>${record.history.map((v, i) => `<label><input type="radio" name="history" value="${i}" ${!i ? "checked" : ""}> ${esc(new Date(v.at).toLocaleString())}</label>`).join("")}<p>${esc(tr("确认后直接替换当前草稿；保存后形成新版本。不自动另存原草稿。", "Confirmation directly replaces the draft. Saving creates a new version; no automatic safety copy."))}</p>`,
          () => {
            const index = Number(
              dialog.querySelector("[name=history]:checked")?.value,
            );
            if (record.history[index])
              mutate(() => {
                play = clone(record.history[index].play);
                selection = { kind: "play" };
                scenarioId = play.defaultScenario;
                time = 0;
              });
          },
        );
      }
      if (action === "delete-record") {
        const value = records.find((r) => r.id === id);
        ask(
          `<p>${esc(tr("删除整套战术、草稿及保存历史？仅提供本页 10 秒撤销。", "Delete the tactic, draft and history? Undo is available on this page for 10 seconds."))}</p>`,
          async () => {
            records = await store.change([
              { id, expected: value.revision, remove: true },
            ]);
            undoDeletion = clone(value);
            clearTimeout(undoTimer);
            undoTimer = setTimeout(() => {
              undoDeletion = null;
              root.querySelector(".coach-undo")?.remove();
            }, 10000);
            render();
          },
        );
      }
      if (action === "undo-delete" && undoDeletion) {
        const value = undoDeletion;
        records = await store.change([
          { id: value.id, expected: 0, record: value },
        ]);
        undoDeletion = null;
        clearTimeout(undoTimer);
        render();
      }
      if (action === "import") root.querySelector("#coachBackupInput").click();
    } catch (error) {
      saveError = error.message;
      updateStatus();
      toast(error.message);
    }
  });
  function renderUndo() {
    root.querySelector(".coach-undo")?.remove();
    const node = document.createElement("div");
    node.className = "coach-undo";
    node.setAttribute("role", "status");
    node.innerHTML =
      esc(tr("战术已删除 · 10 秒内可撤销", "Deleted · Undo within 10 s")) +
      btn("undo-delete", tr("撤销删除", "Undo deletion"));
    root.append(node);
  }

  function setPath(item, key, value) {
    const keys = key.split(".");
    let current = item;
    for (let index = 0; index < keys.length - 1; index++) {
      const segment = keys[index];
      current = current[segment] ??= /^\d+$/.test(keys[index + 1]) ? [] : {};
    }
    current[keys.at(-1)] = value;
  }
  function editProperty(node, live=false) {
    const key = node.dataset.edit,
      value =
        node.type === "checkbox"
          ? node.checked
          : ["number", "range"].includes(node.type)
            ? node.value === ""
              ? null
              : Number(node.value)
            : node.value;
    if (key === "language") {
      const language = document.getElementById("language");
      language.value = value;
      language.dispatchEvent(new Event("change"));
      render();
      return;
    }
    if (key === "scenario") {
      scenarioId = value;
      optionId = undefined;
      time = 0;
      frameId = null;
      playing = false;
      selection = { kind: "play" };
      render();
      return;
    }
    if (key === "routesOnly") {
      routesOnly = value;
      time = 0;
      frameId = null;
      playing = false;
      render();
      return;
    }
    if (key === "speed") {
      speed = Number(value);
      return;
    }
    if (key === "snap") {
      snap = value;
      return;
    }
    if (key === "whole") {
      whole = value;
      return;
    }
    if (key === "scope") {
      scope = value;
      render();
      return;
    }
    if (key === "seek") {
      time = Number(value);
      playing = false;
      frameId = null;
      const entering = step < 4;
      step = 4;
      if (entering) render();
      else renderBoard();
      const captionNode = root.querySelector(".coach-caption");
      if (captionNode) captionNode.textContent = caption();
      return;
    }
    if (viewOnly) return;
    mutate(() => {
      const item = object();
      if (key === "explanation") {
        item.explanation ||= explanation();
        item.explanation[getLanguage()] = { text: value, status: "review" };
        const other = item.explanation[getLanguage() === "zh" ? "en" : "zh"];
        if (other?.text) other.status = "review";
        return;
      }
      if (key === "planTitle") {
        if (plan()) plan().title[getLanguage()] = value;
        return;
      }
      if (key === "frameTitle") {
        item.title[getLanguage()] = value;
        return;
      }
      if (key === "planMode") {
        if (plan()) plan().mode = value;
        return;
      }
      if (key === "option") {
        optionId = value;
        if (plan()) plan().choices[selection.id] = value;
        return;
      }
      if (key === "template") {
        if (value) applyTemplate(value);
        return;
      }
      if (key.startsWith("view.")) {
        item.view ||= {
          zoneIds: play.zones.map((z) => z.id),
          assignmentIds: play.assignments.map((d) => d.id),
        };
        const [, kind, id] = key.split("."),
          list = kind === "zone" ? "zoneIds" : "assignmentIds";
        if (value && !item.view[list].includes(id)) item.view[list].push(id);
        if (!value) item.view[list] = item.view[list].filter((v) => v !== id);
        return;
      }
      if (selection.kind === "player") {
        const player = selectedPlayer();
        if (key.startsWith("at.")) {
          const to = clone(player.at);
          to[Number(key.split(".")[1])] = value;
          movePlayer(play, player, to, whole);
          return;
        }
        if (key === "motionType") {
          if (value === "path") ensureMotion();
          else {
            const m = { type: value, note: tr("教练设置", "Coach authored") };
            if (scope === "plan") {
              if (plan()) plan().overrides[player.id] = m;
            } else player.motion = m;
          }
          markReview(play, [player]);
          return;
        }
        if (key.startsWith("start.")) {
          const m = ensureMotion();
          if (!m) return;
          m.start ||= { type: "delay", seconds: 0 };
          setPath(m, key, value);
          if (key === "start.type")
            m.start =
              value === "delay"
                ? { type: "delay", seconds: 0 }
                : {
                    type: "action",
                    player: "",
                    action: "",
                    phase: "end",
                    offset: 0,
                  };
          return;
        }
        if (key.startsWith("action.")) {
          ensureMotion();
          const action = motionSteps().find((a) => a.id === selection.action);
          if (action) {
            setPath(action, key.slice(7), value);
            if (key === "action.seconds") action.timing = "fixed";
            retime(player, selectedMotion());
            markReview(play, [player]);
          }
          return;
        }
      }
      if (
        key.endsWith(".type") &&
        ["binding.type", "start.type", "end.type"].includes(key)
      ) {
        const prefix = key.split(".")[0];
        item[prefix] =
          value === "time"
            ? { type: "time", seconds: time }
            : value === "ball"
              ? { type: "ball", event: "", phase: "end" }
              : {
                  type: "action",
                  player: "",
                  action: "",
                  phase: "end",
                  offset: 0,
                };
        return;
      }
      if (selection.kind === "event" && key === "to") {
        item.to = value;
        if (item.end?.type === "action")
          item.end = { ...item.end, player: value, action: "" };
        markReview(play, [item]);
        return;
      }
      if (selection.kind === "event" && key === "type") {
        item.type = value;
        if (["snap", "pass"].includes(value))
          item.end ||= { type: "time", seconds: time + 0.7 };
        else delete item.end;
        if (value === "pump-fake") delete item.to;
        return;
      }
      if (selection.kind === "zone" && key === "type") {
        if (value === "polygon" && item.type !== "polygon") {
          const {
            center: [x, y],
            radiusX: rx,
            radiusY: ry,
          } = item;
          item.points = [
            [x - rx, y - ry],
            [x + rx, y - ry],
            [x + rx, y + ry],
            [x - rx, y + ry],
          ];
        }
        if (value !== "polygon" && item.type === "polygon") {
          const xs = item.points.map((p) => p[0]),
            ys = item.points.map((p) => p[1]);
          item.center = [
            (Math.min(...xs) + Math.max(...xs)) / 2,
            (Math.min(...ys) + Math.max(...ys)) / 2,
          ];
          item.radiusX = (Math.max(...xs) - Math.min(...xs)) / 2;
          item.radiusY = (Math.max(...ys) - Math.min(...ys)) / 2;
        }
        item.type = value;
        markReview(play, [item]);
        return;
      }
      setPath(item, key, value);
      if (
        !key.startsWith("title.") &&
        !["name", "defaultScenario", "initialOwner"].includes(key)
      )
        markReview(play, [item]);
    }, live ? {liveKey:`${selection.kind}:${selection.id}:${key}`} : {});
  }
  root.addEventListener("change", async (event) => {
    if (event.target.id === "coachBackupInput") {
      const file = event.target.files[0];
      if (!file) return;
      try {
        await showImport(file);
      } catch (error) {
        toast(error.message);
      }
      event.target.value = "";
      return;
    }
    if(event.target.dataset.edit && liveEditKey===`${selection.kind}:${selection.id}:${event.target.dataset.edit}`){
      liveEditKey=undefined;
      renderBoard();
      const problems=root.querySelector('.coach-problems');if(problems)problems.outerHTML=problemsHtml();
      const note=root.querySelector('.coach-caption');if(note)note.textContent=caption();
      return;
    }
    if (event.target.dataset.edit) editProperty(event.target);
  });
  root.addEventListener("input", (event) => {
    if (event.target.dataset.edit === "seek") editProperty(event.target);
    else if(event.target.dataset.edit && event.target.matches('input[type="text"],textarea')){
      editProperty(event.target,true);
      const heading=root.querySelector('.coach-head h1');if(heading)heading.textContent=`Flagventures · ${titleOf(play)}`;
      const hint=root.querySelector('[data-coach-text-status]');if(hint && event.target.dataset.edit==='explanation')hint.textContent=tr('旧说明待核对；确认前不用于教学。','Needs review; hidden from teaching until confirmed.');
    }
  });
  async function showImport(file) {
    if (file.size > 25 * 1024 * 1024)
      throw new Error(tr("备份超过 25 MB", "Backup exceeds 25 MB"));
    const incoming = parseBackup(await file.text());
    records = await store.list();
    importRows = incoming.map((value) => {
      const local = records.find((r) => r.id === value.id);
      return { value, local, same: local && equivalent(value, local) };
    });
    ask(
      `<h2>${esc(tr("导入完整编辑备份", "Import full editor backup"))}</h2>${importRows
        .map(
          (row, i) =>
            `<div class="coach-import-row"><strong>${esc(titleOf(row.value.draft))}</strong>${
              row.same
                ? `<p>${esc(tr("内容相同，将跳过", "Identical; skip"))}</p>`
                : `<select data-import="${i}">${options(
                    row.local
                      ? [
                          ["copy", tr("复制为新战术", "Copy as new")],
                          [
                            "replace",
                            tr("替换本机整条记录", "Replace local record"),
                          ],
                          ["skip", tr("跳过", "Skip")],
                        ]
                      : [
                          ["add", tr("新增", "Add")],
                          ["copy", tr("复制并自动改名", "Copy and rename")],
                          ["skip", tr("跳过", "Skip")],
                        ],
                    row.local ? "copy" : "add",
                  )}</select>`
            }</div>`,
        )
        .join(
          "",
        )}<p>${esc(tr("选择替换后，确认会直接替换本机草稿及历史，不自动保留副本。名称冲突请选复制。", "Replace overwrites the local draft and history after confirmation, without a safety copy. Choose Copy for name conflicts."))}</p>`,
      async () => {
        const changes = [],
          future = [...records];
        for (const [i, row] of importRows.entries()) {
          if (row.same) continue;
          const mode = dialog.querySelector(`[data-import="${i}"]`).value;
          if (mode === "skip") continue;
          let value = clone(row.value);
          if (mode === "copy") value = copyRecord(value, future);
          changes.push({
            id: value.id,
            expected: mode === "replace" ? row.local.revision : 0,
            record: value,
            enforceNames: true,
          });
          future.push(value);
        }
        records = await store.change(changes);
        render();
        toast(tr("备份已载入", "Backup loaded"));
      },
    );
  }
  root.addEventListener("keydown", (event) => {
    if (event.key === "Tab") {
      const nodes = [
        ...root.querySelectorAll(
          'button:not(:disabled),input,select,textarea,[tabindex="0"]',
        ),
      ].filter((node) => node.getClientRects().length);
      const edge = nodes[event.shiftKey ? 0 : nodes.length - 1];
      if (event.target === edge) {
        event.preventDefault();
        nodes[event.shiftKey ? nodes.length - 1 : 0]?.focus();
      }
      return;
    }
    if (event.target.matches("input,textarea,select")) return;
    if (event.key === "Escape") {
      if (gesture?.baseline) play = gesture.baseline;
      gesture = null;
      pointers.clear();
      poly = [];
      tool = "select";
      playing = false;
      render();
      event.preventDefault();
      return;
    }
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === "z" &&
      !viewOnly
    ) {
      event.preventDefault();
      root
        .querySelector(`[data-do="${event.shiftKey ? "redo" : "undo"}"]`)
        ?.click();
    }
    if (
      (event.key === "Enter" || event.key === " ") &&
      event.target.dataset.hit
    ) {
      event.preventDefault();
      const hit = event.target.dataset;
      if (step === 4 && hit.hit === "ball-stop") {
        time = Number(hit.time);
        playing = false;
        render();
      } else if (hit.hit === "player" || step !== 4)
        selectObject(hit.hit, hit.id);
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      playing = false;
      if (play && !viewOnly) retain().catch(() => {});
    }
  });
  window.visualViewport?.addEventListener("resize", () => {
    const viewport = window.visualViewport;
    root.style.setProperty(
      "--coach-keyboard",
      `${Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)}px`,
    );
    if (root.contains(document.activeElement))
      document.activeElement.scrollIntoView({ block: "nearest" });
  });
  window.addEventListener("beforeunload", (event) => {
    if (
      !root.hidden &&
      play &&
      !viewOnly &&
      (saveError || generation > retained || store.temporary)
    ) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel("flagventures-coach");
    channel.onmessage = () => {
      if (screen === "library" && !loading)
        store
          .list()
          .then((value) => {
            records = value;
            render();
          })
          .catch((error) => {
            saveError = error.message;
            updateStatus();
          });
    };
    const change = store.change.bind(store);
    store.change = async (changes) => {
      const value = await change(changes);
      channel.postMessage("updated");
      return value;
    };
  }
  function tick(now) {
    coachTick=undefined;
    if (!root.hidden && playing) {
      const duration = compileCurrent().lesson.timeline.duration;
      if (lastTick !== undefined)
        time = Math.min(
          duration,
          time + Math.min(0.1, (now - lastTick) / 1000) * speed,
        );
      lastTick = now;
      if (time >= duration) playing = false;
      renderBoard();
      const clock = root.querySelector("[data-coach-clock]");
      if (clock)
        clock.textContent = `${time.toFixed(1)} / ${duration.toFixed(1)} s`;
      const seek = root.querySelector("[data-edit=seek]");
      if (seek) seek.value = time;
      const captionNode = root.querySelector(".coach-caption");
      if (captionNode) captionNode.textContent = caption();
      if (!playing) render();
    } else lastTick = undefined;
    if(playing&&!root.hidden)coachTick=requestAnimationFrame(tick);
  }
  return {
    async open() {
      pauseTeaching();
      root.hidden = false;
      document.body.style.overflow = "hidden";
      document.body.classList.add("coach-open");
      for (const n of document.querySelectorAll(".app-header,.layout,#floatingPlay"))
        n.inert = true;
      await ready;
      if (!play) screen = "library";
      render();
    },
    async copy() {
      pauseTeaching();
      root.hidden = false;
      document.body.style.overflow = "hidden";
      document.body.classList.add("coach-open");
      for (const n of document.querySelectorAll(".app-header,.layout,#floatingPlay"))
        n.inert = true;
      await ready;
      await leave(() => {
        const source = getCurrentLesson();
        ask(
          `<h2>${esc(tr("复制到我的战术", "Copy to my tactics"))}</h2><p>${esc(titleOf(source))}</p>`,
          () => create(source.kind, source),
        );
      });
      render();
    },
  };
}
