// Optional maintainer automation. Uses Playwright's separate Chromium, never a
// person's Chrome profile. The current development run uses the in-app browser.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { parseBackup } from "../app/coach-storage.js";
const directory = resolve("dist");
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    );
    const file = resolve(
      directory,
      pathname === "/" ? "index.html" : `.${pathname}`,
    );
    if (!file.startsWith(directory + sep)) throw new Error("Invalid path");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(await readFile(file));
  } catch {
    res.statusCode = 404;
    res.end("Not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ headless: true });
await mkdir("tmp/coach-integration", { recursive: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  assert.doesNotMatch(
    await page.locator("#lessonTitle").textContent(),
    /未通过/,
  );
  await page.locator("#manage").click();
  await page.locator('.coach [data-do="new"]').click();
  await page.locator("#coachNewType").selectOption("route");
  await page.locator('.coach-modal [data-do="modal-ok"]').click();
  await page.locator('.coach [data-edit="title.zh"]').fill("Automation route");
  await page.locator('.coach [data-edit="title.zh"]').press("Tab");
  await page.locator('.coach [data-step="2"]').click();
  await page.locator('.coach [data-hit="player"][data-id="X"]').click();
  await page.locator('.coach [data-edit="motionType"]').selectOption("path");
  await page.locator('.coach [data-edit="template"]').selectOption("SLANT");
  assert.equal(await page.locator('.coach [data-hit="player"]').count(), 5);
  await page.locator('.coach [data-do="select-play"]').click();
  await page.locator('.coach [data-edit="explanation"]').fill('Typing without leaving the field');
  await page.locator('.coach-status').filter({hasText:'草稿已保留'}).waitFor();
  await page.reload();
  await page.locator('#manage').click();
  await page.locator('.coach-card').filter({hasText:'Automation route'}).getByRole('button',{name:'编辑',exact:true}).click();
  assert.equal(await page.locator('.coach [data-edit="explanation"]').inputValue(),'Typing without leaving the field','Unblurred text is retained');
  await page.locator('.coach [data-do="save"]').click();
  await page
    .locator(".coach-status")
    .filter({ hasText: "当前内容已手动保存" })
    .waitFor();
  await page.locator('.coach [data-step="4"]').click();
  await page.locator('.coach [data-do="select-play"]').click();
  // Real backup download and restore are tested separately from v1 lesson files.
  const download = page.waitForEvent("download");
  await page.locator('.coach [data-do="export-one"]').click();
  const data = parseBackup(
    await readFile(await (await download).path(), "utf8"),
  );
  assert.equal(data.length, 1);
  assert.equal(data[0].saved.title.zh, "Automation route");
  assert.equal(data[0].saved.players.length, 5);
  await page.locator('.coach [data-step="2"]').click();
  await page.locator('.coach [data-hit="player"][data-id="X"]').click();
  await page.locator('.coach [data-edit="at.0"]').fill("7");
  await page.locator('.coach [data-edit="at.0"]').press("Tab");
  await page.locator('.coach [data-do="library"]').click();
  const card = page
    .locator(".coach-card")
    .filter({ hasText: "Automation route" });
  await card.getByRole("button", { name: "演示", exact: true }).click();
  assert.equal(
    await page
      .locator('.coach-canvas [data-id="X"] circle')
      .first()
      .getAttribute("cx"),
    "5",
    "Teaching uses the saved lineup",
  );
  await page.locator('.coach [data-do="close"]').click();
  await page.reload();
  await page.locator("#manage").click();
  await page
    .locator(".coach-card")
    .filter({ hasText: "Automation route" })
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  await page.locator('.coach [data-hit="player"][data-id="X"]').click();
  assert.equal(
    await page.locator('.coach [data-edit="at.0"]').inputValue(),
    "7",
    "Draft survives reload",
  );
  for (const [width, height] of [
    [390, 844],
    [768, 1024],
    [1024, 768],
  ]) {
    await page.setViewportSize({ width, height });
    assert.ok(
      await page
        .locator(".coach")
        .evaluate((n) => n.scrollWidth <= n.clientWidth + 1),
    );
    await page.screenshot({
      path: `tmp/coach-integration/${width}.png`,
      fullPage: true,
    });
  }
  await page.locator('.coach [data-do="close"]').click();
  await page.goto(pathToFileURL(resolve("dist/Flagventures.html")).href);
  await page.locator("#manage").click();
  assert.match(await page.locator(".coach-status").textContent(), /临时编辑/);
  await page
    .locator("#coachBackupInput")
    .setInputFiles({
      name: "restore.backup.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          format: "flagventures.backup",
          version: 2,
          records: data,
        }),
      ),
    });
  await page.locator('.coach-modal [data-do="modal-ok"]').click();
  assert.equal(await page.locator(".coach-card").count(), 1);
  await page
    .locator("#coachBackupInput")
    .setInputFiles({
      name: "old.flagbook.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"format":"flag-playbook","version":1}'),
    });
  await page
    .locator(".coach-toast")
    .filter({ hasText: "仅支持新版" })
    .waitFor();
  assert.equal(await page.locator(".coach-card").count(), 1);
  assert.deepEqual(errors, []);
  console.log(
    "PASS desktop flows, saved/draft isolation, real persistence, native backup, responsive dimensions, temporary file mode. Real phone/tablet touch acceptance remains separate.",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
