const WORK_START = 9 * 60;
const BREAK_START = 11 * 60 + 50;
const BREAK_END = 12 * 60 + 40;
const WORK_END = 17 * 60 + 40;
const DAILY_WORK_MINUTES = 470;
const CONTRACT_COUNT = 8;
const HOLIDAY_API = "https://holidays-jp.github.io/api/v1/date.json";

const defaultContracts = [
  { name: "契約A", ratio: 0.1 },
  { name: "契約B", ratio: 0.2 },
  { name: "契約C", ratio: 0.05 },
  { name: "契約D", ratio: 0.05 },
  { name: "契約E", ratio: 0.05 },
  { name: "契約F", ratio: 0.05 },
  { name: "契約G", ratio: 0.15 },
  { name: "契約H", ratio: 0.35 },
];

const elements = {
  form: document.querySelector("#planner-form"),
  targetMonth: document.querySelector("#target-month"),
  contractBody: document.querySelector("#contract-body"),
  manualHolidays: document.querySelector("#manual-holidays"),
  ratioTotal: document.querySelector("#ratio-total"),
  holidayStatus: document.querySelector("#holiday-status"),
  messages: document.querySelector("#messages"),
  resetContracts: document.querySelector("#reset-contracts"),
  monthSummary: document.querySelector("#month-summary"),
  workdayCount: document.querySelector("#workday-count"),
  totalMinutes: document.querySelector("#total-minutes"),
  rowCount: document.querySelector("#row-count"),
  allocationBody: document.querySelector("#allocation-body"),
  previewBody: document.querySelector("#preview-body"),
  csvOutput: document.querySelector("#csv-output"),
  copyCsv: document.querySelector("#copy-csv"),
  downloadCsv: document.querySelector("#download-csv"),
};

let holidayCache = null;
let lastCsv = "";

function init() {
  elements.targetMonth.value = getCurrentMonthValue();
  renderContracts(defaultContracts);
  updateRatioTotal();
  void loadHolidays();

  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    generate();
  });
  elements.contractBody.addEventListener("input", updateRatioTotal);
  elements.resetContracts.addEventListener("click", () => {
    renderContracts(defaultContracts);
    updateRatioTotal();
    clearMessage();
  });
  elements.copyCsv.addEventListener("click", copyCsv);
  elements.downloadCsv.addEventListener("click", downloadCsv);
}

function getCurrentMonthValue() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
}

function renderContracts(contracts) {
  elements.contractBody.innerHTML = "";
  contracts.forEach((contract, index) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${index + 1}</td>
      <td><input type="text" class="contract-name" value="${escapeAttribute(contract.name)}" required /></td>
      <td><input type="number" class="contract-ratio" value="${formatRatio(contract.ratio)}" min="0" max="1" step="0.000001" required /></td>
      <td class="percent-cell">12.50%</td>
    `;
    elements.contractBody.append(row);
  });
}

function formatRatio(value) {
  return Number(value.toFixed(6)).toString();
}

function updateRatioTotal() {
  const contracts = readContracts({ allowInvalid: true });
  const total = contracts.reduce((sum, contract) => sum + (Number(contract.ratio) || 0), 0);
  elements.ratioTotal.textContent = total.toFixed(6);
  elements.ratioTotal.style.color = Math.abs(total - 1) < 0.000001 ? "" : "var(--warn)";

  document.querySelectorAll(".contract-table tbody tr").forEach((row) => {
    const input = row.querySelector(".contract-ratio");
    const percent = Number(input.value) * 100;
    row.querySelector(".percent-cell").textContent = Number.isFinite(percent)
      ? `${percent.toFixed(2)}%`
      : "-";
  });
}

async function loadHolidays() {
  elements.holidayStatus.textContent = "取得中";
  try {
    const response = await fetch(HOLIDAY_API, { cache: "force-cache" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    holidayCache = await response.json();
    elements.holidayStatus.textContent = "取得済み";
  } catch (error) {
    holidayCache = {};
    elements.holidayStatus.textContent = "手入力のみ";
    setMessage("祝日APIを取得できませんでした。追加の休業日に祝日を入力すれば計算できます。", "warn");
  }
}

function readContracts({ allowInvalid = false } = {}) {
  const rows = [...elements.contractBody.querySelectorAll("tr")];
  return rows.map((row, index) => {
    const name = row.querySelector(".contract-name").value.trim();
    const ratio = Number(row.querySelector(".contract-ratio").value);
    if (!allowInvalid) {
      if (!name) {
        throw new Error(`${index + 1}行目の契約名を入力してください。`);
      }
      if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
        throw new Error(`${name || `${index + 1}行目`} の割合は0以上1以下で入力してください。`);
      }
    }
    return { name, ratio };
  });
}

function generate() {
  try {
    const monthValue = elements.targetMonth.value;
    if (!monthValue) {
      throw new Error("対象月を選択してください。");
    }

    const contracts = readContracts();
    const ratioTotal = contracts.reduce((sum, contract) => sum + contract.ratio, 0);
    if (Math.abs(ratioTotal - 1) > 0.000001) {
      throw new Error(`割合の合計を1にしてください。現在は ${ratioTotal.toFixed(6)} です。`);
    }

    const [year, month] = monthValue.split("-").map(Number);
    const holidaySet = buildHolidaySet();
    const workdays = getWorkdays(year, month, holidaySet);
    if (workdays.length === 0) {
      throw new Error("対象月に営業日がありません。追加の休業日を確認してください。");
    }

    const totalMinutes = workdays.length * DAILY_WORK_MINUTES;
    const allocations = allocateMinutes(contracts, totalMinutes);
    const rows = buildRows(workdays, allocations);
    lastCsv = toCsv(rows);

    renderOutput({ year, month, workdays, totalMinutes, allocations, rows, csv: lastCsv });
    setMessage("生成しました。", "");
  } catch (error) {
    setMessage(error.message, "error");
  }
}

function buildHolidaySet() {
  const apiDates = holidayCache ? Object.keys(holidayCache) : [];
  const manualDates = elements.manualHolidays.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const invalid = manualDates.filter((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date));
  if (invalid.length > 0) {
    throw new Error(`追加の休業日は YYYY-MM-DD 形式で入力してください: ${invalid[0]}`);
  }

  return new Set([...apiDates, ...manualDates]);
}

function getWorkdays(year, month, holidaySet) {
  const days = [];
  const lastDay = new Date(year, month, 0).getDate();

  for (let day = 1; day <= lastDay; day += 1) {
    const date = new Date(year, month - 1, day);
    const weekday = date.getDay();
    const isoDate = toIsoDate(year, month, day);
    if (weekday !== 0 && weekday !== 6 && !holidaySet.has(isoDate)) {
      days.push({
        isoDate,
        csvDate: `${year}/${pad2(month)}/${pad2(day)}`,
      });
    }
  }

  return days;
}

function allocateMinutes(contracts, totalMinutes) {
  const exacts = contracts.map((contract, index) => {
    const exact = contract.ratio * totalMinutes;
    return {
      index,
      name: contract.name,
      ratio: contract.ratio,
      minutes: Math.floor(exact),
      remainder: exact - Math.floor(exact),
    };
  });

  let remaining = totalMinutes - exacts.reduce((sum, item) => sum + item.minutes, 0);
  [...exacts]
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
    .forEach((item) => {
      if (remaining > 0) {
        item.minutes += 1;
        remaining -= 1;
      }
    });

  return exacts.sort((a, b) => a.index - b.index);
}

function buildRows(workdays, allocations) {
  const rows = [];
  let dayIndex = 0;
  let cursor = WORK_START;

  for (const allocation of allocations) {
    let minutesLeft = allocation.minutes;
    while (minutesLeft > 0) {
      if (dayIndex >= workdays.length) {
        throw new Error("割り当てが月内の営業日を超えました。");
      }

      cursor = normalizeCursor(cursor);
      if (cursor >= WORK_END) {
        dayIndex += 1;
        cursor = WORK_START;
        continue;
      }

      const available = workingMinutesBetween(cursor, WORK_END);
      const chunk = Math.min(minutesLeft, available);
      const end = addWorkingMinutes(cursor, chunk);
      rows.push({
        date: workdays[dayIndex].csvDate,
        start_time: formatTime(cursor),
        end_time: formatTime(end),
        contract_name: allocation.name,
      });

      minutesLeft -= chunk;
      cursor = end;

      if (cursor >= WORK_END) {
        dayIndex += 1;
        cursor = WORK_START;
      }
    }
  }

  return rows;
}

function normalizeCursor(minutes) {
  if (minutes >= BREAK_START && minutes < BREAK_END) {
    return BREAK_END;
  }
  return minutes;
}

function workingMinutesBetween(start, end) {
  const normalizedStart = normalizeCursor(start);
  if (normalizedStart >= end) {
    return 0;
  }

  let minutes = end - normalizedStart;
  const breakOverlap = Math.max(
    0,
    Math.min(end, BREAK_END) - Math.max(normalizedStart, BREAK_START),
  );
  return minutes - breakOverlap;
}

function addWorkingMinutes(start, minutesToAdd) {
  let cursor = normalizeCursor(start);
  let remaining = minutesToAdd;

  while (remaining > 0) {
    const nextStop = cursor < BREAK_START ? BREAK_START : WORK_END;
    const available = nextStop - cursor;
    if (remaining <= available) {
      return cursor + remaining;
    }

    remaining -= available;
    cursor = nextStop === BREAK_START ? BREAK_END : WORK_END;
  }

  return cursor;
}

function renderOutput({ year, month, workdays, totalMinutes, allocations, rows, csv }) {
  elements.monthSummary.textContent = `${year}年${month}月のCSVです。`;
  elements.workdayCount.textContent = workdays.length.toString();
  elements.totalMinutes.textContent = totalMinutes.toLocaleString("ja-JP");
  elements.rowCount.textContent = rows.length.toString();
  elements.csvOutput.value = csv;
  elements.copyCsv.disabled = rows.length === 0;
  elements.downloadCsv.disabled = rows.length === 0;

  renderAllocationSummary(allocations);

  elements.previewBody.innerHTML = "";
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.date}</td>
      <td>${row.start_time}</td>
      <td>${row.end_time}</td>
      <td>${escapeHtml(row.contract_name)}</td>
    `;
    elements.previewBody.append(tr);
  });
}

function renderAllocationSummary(allocations) {
  elements.allocationBody.innerHTML = "";
  allocations.forEach((allocation) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(allocation.name)}</td>
      <td>${formatRatio(allocation.ratio)}</td>
      <td>${allocation.minutes.toLocaleString("ja-JP")}</td>
      <td>${formatDuration(allocation.minutes)}</td>
    `;
    elements.allocationBody.append(tr);
  });
}

function toCsv(rows) {
  const header = ["date", "start_time", "end_time", "contract_name"];
  const lines = rows.map((row) =>
    [row.date, row.start_time, row.end_time, row.contract_name].map(csvEscape).join(","),
  );
  return [header.join(","), ...lines].join("\n");
}

function csvEscape(value) {
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

async function copyCsv() {
  if (!lastCsv) return;
  await navigator.clipboard.writeText(lastCsv);
  setMessage("CSVをクリップボードにコピーしました。", "");
}

function downloadCsv() {
  if (!lastCsv) return;
  const blob = new Blob([lastCsv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `attendance-${elements.targetMonth.value}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function setMessage(message, type) {
  elements.messages.textContent = message;
  elements.messages.className = `messages ${type}`.trim();
}

function clearMessage() {
  setMessage("", "");
}

function formatTime(minutes) {
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

function formatDuration(minutes) {
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return `${hours}:${pad2(restMinutes)}`;
}

function toIsoDate(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

init();
