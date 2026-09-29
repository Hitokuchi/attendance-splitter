const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");

function loadApp() {
  const elements = new Map();
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) {
        elements.set(selector, {
          value: "", textContent: "", innerHTML: "", disabled: false,
          style: {}, append() {}, querySelectorAll: () => [],
        });
      }
      return elements.get(selector);
    },
    createElement: () => ({ innerHTML: "" }),
  };
  const context = vm.createContext({ document });
  // Keep production code browser-only; skip startup when testing its functions.
  const source = readFileSync(`${__dirname}/app.js`, "utf8").replace(/\ninit\(\);\s*$/, "\n");
  vm.runInContext(source, context);
  return { app: context, elements };
}

const minutes = (time) => {
  const [hours, rest] = time.split(":").map(Number);
  return hours * 60 + rest;
};

function checkRows(app, schedule, allocations) {
  const rows = app.buildRows(schedule, allocations);
  const days = new Map(schedule.map((day) => [day.csvDate, day]));
  const dailyTotals = new Map();
  const contractTotals = new Map();
  const lastEnds = new Map();
  for (const row of rows) {
    const day = days.get(row.date);
    assert.ok(day, "Only scheduled workdays may appear");
    const start = minutes(row.start_time);
    const end = minutes(row.end_time);
    assert.ok(start >= 540 && end <= day.workEnd && start < end);
    const previousEnd = lastEnds.get(row.date) ?? 540;
    const expectedStart = previousEnd >= 710 && previousEnd < day.breakEnd ? day.breakEnd : previousEnd;
    assert.equal(start, expectedStart, "Rows must be consecutive outside lunch");
    assert.ok(start < 710 || start >= day.breakEnd);
    assert.ok(end <= 710 || end >= day.breakEnd);
    const breakOverlap = Math.max(0, Math.min(end, day.breakEnd) - Math.max(start, 710));
    const duration = end - start - breakOverlap;
    dailyTotals.set(row.date, (dailyTotals.get(row.date) ?? 0) + duration);
    contractTotals.set(row.contract_no, (contractTotals.get(row.contract_no) ?? 0) + duration);
    lastEnds.set(row.date, end);
  }
  for (const day of schedule) {
    assert.equal(dailyTotals.get(day.csvDate), day.workMinutes);
    assert.equal(lastEnds.get(day.csvDate), day.workEnd);
  }
  for (const allocation of allocations) {
    assert.equal(contractTotals.get(allocation.no) ?? 0, allocation.minutes);
  }
  return rows;
}

test("17 workdays reach 140 hours with at most one minute difference", () => {
  const { app } = loadApp();
  const dates = app.getWorkdays(2026, 6, new Set()).slice(0, 17);
  const schedule = app.buildWorkSchedule(dates, 8400);
  assert.equal(schedule.reduce((total, day) => total + day.workMinutes, 0), 8400);
  assert.equal(schedule.filter((day) => day.workMinutes === 495).length, 2);
  assert.equal(schedule.filter((day) => day.workMinutes === 494).length, 15);
  assert.equal(schedule[0].csvDate, dates[0].csvDate);
  assert.equal(schedule[0].workEnd, 18 * 60 + 15);
  assert.equal(schedule[16].workEnd, 18 * 60 + 14);
  assert.ok(schedule.every((day) => day.breakEnd === 770));
  const allocations = app.allocateMinutes([
    { name: "A", no: "A", ratio: 0.1 },
    { name: "B", no: "B", ratio: 0.9 },
  ], 8400);
  assert.equal(allocations[0].minutes, 840);
  checkRows(app, schedule, allocations);
});

test("18 or more workdays keep their normal hours", () => {
  const { app } = loadApp();
  const dates = app.getWorkdays(2026, 6, new Set()).slice(0, 18);
  const schedule = app.buildWorkSchedule(dates, 18 * 470);
  assert.ok(schedule.every((day) => day.workMinutes === 470 && day.breakEnd === 760 && day.workEnd === 1060));
  checkRows(app, schedule, app.allocateMinutes([{ name: "A", no: "A", ratio: 1 }], 8460));
});

test("479 minutes use 50-minute lunch; 480 and 481 use 60-minute lunch", () => {
  const { app } = loadApp();
  const dates = [{ csvDate: "2026/06/01" }];
  for (const [workMinutes, breakEnd, workEnd] of [[479, 760, 1069], [480, 770, 1080], [481, 770, 1081]]) {
    const schedule = app.buildWorkSchedule(dates, workMinutes);
    assert.equal(schedule[0].breakEnd, breakEnd);
    assert.equal(schedule[0].workEnd, workEnd);
    checkRows(app, schedule, [{ name: "A", no: "A", minutes: workMinutes }]);
  }
});

test("A contract ending exactly at lunch hands over after the full 60 minutes", () => {
  const { app } = loadApp();
  const schedule = app.buildWorkSchedule([{ csvDate: "2026/06/01" }], 480);
  const rows = checkRows(app, schedule, [
    { name: "A", no: "A", minutes: 170 },
    { name: "B", no: "B", minutes: 310 },
  ]);
  assert.equal(rows[0].end_time, "11:50");
  assert.equal(rows[1].start_time, "12:50");
  assert.equal(rows[1].end_time, "18:00");
});

test("Contracts and daily totals stay consistent across workday counts and ratios", () => {
  const { app } = loadApp();
  const allDays = app.getWorkdays(2026, 7, new Set());
  for (let count = 10; count <= allDays.length; count += 1) {
    const total = Math.max(count * 470, 8400);
    const schedule = app.buildWorkSchedule(allDays.slice(0, count), total);
    for (const weights of [[1, 1, 1, 1, 1, 1, 1, 1], [0, 1, 3, 0, 4, 7, 11, 2]]) {
      const sum = weights.reduce((a, b) => a + b, 0);
      const contracts = weights.map((weight, index) => ({ name: `C${index}`, no: String(index), ratio: weight / sum }));
      const allocations = app.allocateMinutes(contracts, total);
      assert.equal(allocations.reduce((a, b) => a + b.minutes, 0), total);
      checkRows(app, schedule, allocations);
    }
  }
});

test("Generation respects API holidays and leave, updates summaries, and clears stale results", async () => {
  const { app, elements } = loadApp();
  elements.get("#target-month").value = "2026-06";
  elements.get("#manual-holidays").value = "2026-06-02\n2026-06-03\n2026-06-04\n2026-06-05\n2026-06-01";
  vm.runInContext('holidayCache = {"2026-06-01": "祝日"}', app);
  app.readContracts = () => [{ name: "A", no: "A", ratio: 0.1 }, { name: "B", no: "B", ratio: 0.9 }];
  await app.generate();
  assert.equal(elements.get("#workday-count").textContent, "17");
  assert.equal(elements.get("#total-minutes").textContent, "8,400");
  assert.equal(elements.get("#daily-minutes").textContent, "494〜495分");
  assert.equal(elements.get("#break-hours").textContent, "11:50-12:50");
  assert.equal(elements.get("#work-hours").textContent, "09:00-18:14〜18:15");
  assert.match(elements.get("#month-summary").textContent, /月140時間に調整/);
  const exported = vm.runInContext("lastExport", app);
  assert.ok(exported.rows.every((row) => !/^2026\/06\/0[1-5]$/.test(row.date)));
  assert.match(app.buildAllocationPrintTable(exported.allocations), /14:00/);
  assert.match(app.buildPreviewPrintTable(exported.rows), /18:15/);
  app.clearOutput();
  assert.equal(elements.get("#daily-minutes").textContent, "470分");
  assert.equal(elements.get("#break-hours").textContent, "11:50-12:40");
  assert.equal(elements.get("#print-pdf").disabled, true);
  assert.equal(elements.get("#copy-attendance-json").disabled, true);
  assert.equal(vm.runInContext("lastExport", app), null);
});

test("Generation waits for holiday loading before calculating workdays", async () => {
  const { app, elements } = loadApp();
  elements.get("#target-month").value = "2026-06";
  app.readContracts = () => [{ name: "A", no: "A", ratio: 1 }];
  let finishLoading;
  app.pendingHolidays = new Promise((resolve) => { finishLoading = resolve; });
  vm.runInContext("holidayLoad = pendingHolidays", app);
  const generation = app.generate();
  assert.equal(elements.get("#generate-button").disabled, true);
  assert.equal(elements.get("#workday-count").textContent, "");
  vm.runInContext('holidayCache = {"2026-06-01": "祝日"}', app);
  finishLoading();
  await generation;
  assert.equal(elements.get("#workday-count").textContent, "21");
  assert.equal(elements.get("#total-minutes").textContent, "9,870");
  assert.equal(elements.get("#generate-button").disabled, false);
});

test("Zero workdays and adjustments past midnight show errors and disable export", async () => {
  const { app, elements } = loadApp();
  elements.get("#target-month").value = "2026-06";
  app.readContracts = () => [{ name: "A", no: "A", ratio: 1 }];
  const dates = app.getWorkdays(2026, 6, new Set());
  for (const [leave, message] of [[dates, /営業日がありません/], [dates.slice(1), /日付をまたぎます/]]) {
    elements.get("#manual-holidays").value = leave.map((day) => day.isoDate).join("\n");
    await app.generate();
    assert.match(elements.get("#messages").textContent, message);
    assert.equal(elements.get("#print-pdf").disabled, true);
    assert.equal(elements.get("#copy-attendance-json").disabled, true);
    assert.equal(vm.runInContext("lastExport", app), null);
  }
});

test("Clipboard JSON has one item per workday, adjusted end times and 60-minute breaks", async () => {
  const { app, elements } = loadApp();
  elements.get("#target-month").value = "2026-06";
  elements.get("#manual-holidays").value = "2026-06-02\n2026-06-03\n2026-06-04\n2026-06-05";
  vm.runInContext('holidayCache = {"2026-06-01": "祝日"}', app);
  app.readContracts = () => [{ name: "A", no: "A", ratio: 0.1 }, { name: "B", no: "B", ratio: 0.9 }];
  const writes = [];
  app.navigator = { clipboard: { writeText: async (text) => { writes.push(text); } } };
  await app.generate();
  assert.equal(elements.get("#copy-attendance-json").disabled, false);
  await app.copyAttendanceJson();
  assert.equal(writes.length, 1);
  const attendance = JSON.parse(writes[0]);
  assert.equal(attendance.length, 17);
  assert.ok(vm.runInContext("lastExport.rows.length", app) > attendance.length);
  assert.deepEqual(attendance[0], { date: "2026-06-08", start: "09:00", end: "18:15", break: "01:00" });
  assert.deepEqual(attendance[2], { date: "2026-06-10", start: "09:00", end: "18:14", break: "01:00" });
  assert.equal(new Set(attendance.map((day) => day.date)).size, 17);
  assert.ok(attendance.every((day) => Object.keys(day).join(",") === "date,start,end,break"));
  assert.equal(attendance.reduce((total, day) => total + minutes(day.end) - minutes(day.start) - minutes(day.break), 0), 8400);
  assert.match(elements.get("#messages").textContent, /17日分.*コピーしました/);
  app.clearOutput();
  assert.equal(elements.get("#copy-attendance-json").disabled, true);
  await app.copyAttendanceJson();
  assert.equal(writes.length, 1, "Cleared results must not be copied");
});

test("Clipboard JSON for an unadjusted month has normal end times and zero-padded 50-minute breaks", async () => {
  const { app, elements } = loadApp();
  elements.get("#target-month").value = "2026-06";
  app.readContracts = () => [{ name: "A", no: "A", ratio: 1 }];
  let copied;
  app.navigator = { clipboard: { writeText: async (text) => { copied = text; } } };
  await app.generate();
  await app.copyAttendanceJson();
  const attendance = JSON.parse(copied);
  assert.equal(attendance.length, 22);
  assert.deepEqual(attendance[0], { date: "2026-06-01", start: "09:00", end: "17:40", break: "00:50" });
  assert.ok(attendance.every((day) => day.start === "09:00" && day.end === "17:40" && day.break === "00:50"));
});

test("Clipboard permission errors show a message without discarding generated results", async () => {
  const { app, elements } = loadApp();
  elements.get("#target-month").value = "2026-06";
  app.readContracts = () => [{ name: "A", no: "A", ratio: 1 }];
  app.navigator = { clipboard: { writeText: async () => { throw new Error("Permission denied"); } } };
  await app.generate();
  await app.copyAttendanceJson();
  assert.match(elements.get("#messages").textContent, /コピーできませんでした/);
  assert.equal(elements.get("#messages").className, "messages error");
  assert.equal(elements.get("#copy-attendance-json").disabled, false);
  assert.notEqual(vm.runInContext("lastExport", app), null);
});
