const WORK_START = 9 * 60;
const BREAK_START = 11 * 60 + 50;
const BREAK_END = 12 * 60 + 40;
const WORK_END = 17 * 60 + 40;
const DAILY_WORK_MINUTES = 470;
const CONTRACT_COUNT = 8;
const HOLIDAY_API = "https://holidays-jp.github.io/api/v1/date.json";

const defaultContracts = [
  { name: "契約A", no: "A", ratio: 0.125 },
  { name: "契約B", no: "B", ratio: 0.125 },
  { name: "契約C", no: "C", ratio: 0.125 },
  { name: "契約D", no: "D", ratio: 0.125 },
  { name: "契約E", no: "E", ratio: 0.125 },
  { name: "契約F", no: "F", ratio: 0.125 },
  { name: "契約G", no: "G", ratio: 0.125 },
  { name: "契約H", no: "H", ratio: 0.125 },
];

const elements = {
  form: document.querySelector("#planner-form"),
  targetMonth: document.querySelector("#target-month"),
  contractBody: document.querySelector("#contract-body"),
  manualHolidays: document.querySelector("#manual-holidays"),
  ratioTotal: document.querySelector("#ratio-total"),
  holidayStatus: document.querySelector("#holiday-status"),
  messages: document.querySelector("#messages"),
  importClipboard: document.querySelector("#import-clipboard"),
  resetContracts: document.querySelector("#reset-contracts"),
  monthSummary: document.querySelector("#month-summary"),
  workdayCount: document.querySelector("#workday-count"),
  totalMinutes: document.querySelector("#total-minutes"),
  rowCount: document.querySelector("#row-count"),
  allocationBody: document.querySelector("#allocation-body"),
  previewBody: document.querySelector("#preview-body"),
  printPdf: document.querySelector("#print-pdf"),
  fitOnePage: document.querySelector("#fit-one-page"),
  hideContractNamePdf: document.querySelector("#hide-contract-name-pdf"),
  pdfExportRoot: document.querySelector("#pdf-export-root"),
};

let holidayCache = null;
let lastExport = null;

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
  elements.importClipboard.addEventListener("click", importFromClipboard);
  elements.resetContracts.addEventListener("click", () => {
    renderContracts(defaultContracts);
    updateRatioTotal();
    clearMessage();
  });
  elements.printPdf.addEventListener("click", printPdf);
}

async function importFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    const contracts = parseClipboardContracts(text);
    renderContracts(contracts);
    updateRatioTotal();
    clearOutput();
    setMessage("クリップボードからインポートしました。", "");
  } catch (error) {
    setMessage(error.message, "error");
  }
}

function parseClipboardContracts(text) {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0);

  if (lines.length !== CONTRACT_COUNT) {
    throw new Error("インポートは8行のタブ区切りテキストが必要です。");
  }

  const contracts = lines.map((line, index) => {
    const columns = line.split("\t").map((column) => column.trim());
    if (columns.length !== 3) {
      throw new Error(`${index + 1}行目は 契約名・契約No・発注数量 の3列にしてください。`);
    }

    const [name, no, ratioText] = columns;
    const ratio = Number(ratioText);
    if (!name || !no || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
      throw new Error(`${index + 1}行目の内容を確認してください。`);
    }

    return { name, no, ratio };
  });

  const total = contracts.reduce((sum, contract) => sum + contract.ratio, 0);
  if (Math.abs(total - 1) > 0.000001) {
    throw new Error(`発注数量の合計を1にしてください。現在は ${total.toFixed(6)} です。`);
  }

  return contracts;
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
      <td><input type="text" class="contract-no" value="${escapeAttribute(contract.no)}" required /></td>
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
    const no = row.querySelector(".contract-no").value.trim();
    const ratio = Number(row.querySelector(".contract-ratio").value);
    if (!allowInvalid) {
      if (!name) {
        throw new Error(`${index + 1}行目の契約名を入力してください。`);
      }
      if (!no) {
        throw new Error(`${name} の契約Noを入力してください。`);
      }
      if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
        throw new Error(`${name || `${index + 1}行目`} の割合は0以上1以下で入力してください。`);
      }
    }
    return { name, no, ratio };
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
    lastExport = { year, month, allocations, rows };

    renderOutput({ year, month, workdays, totalMinutes, allocations, rows });
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
      no: contract.no,
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
        contract_no: allocation.no,
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

function renderOutput({ year, month, workdays, totalMinutes, allocations, rows }) {
  elements.monthSummary.textContent = `${year}年${month}月のCSVです。`;
  elements.workdayCount.textContent = workdays.length.toString();
  elements.totalMinutes.textContent = totalMinutes.toLocaleString("ja-JP");
  elements.rowCount.textContent = rows.length.toString();
  elements.printPdf.disabled = rows.length === 0;

  renderAllocationSummary(allocations);

  elements.previewBody.innerHTML = "";
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.date}</td>
      <td>${row.start_time}</td>
      <td>${row.end_time}</td>
      <td>${escapeHtml(row.contract_name)}</td>
      <td>${escapeHtml(row.contract_no)}</td>
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
      <td>${escapeHtml(allocation.no)}</td>
      <td>${formatRatio(allocation.ratio)}</td>
      <td>${allocation.minutes.toLocaleString("ja-JP")}</td>
      <td>${formatDuration(allocation.minutes)}</td>
    `;
    elements.allocationBody.append(tr);
  });
}

function clearOutput() {
  lastExport = null;
  elements.monthSummary.textContent = "対象月を選んで生成してください。";
  elements.workdayCount.textContent = "0";
  elements.totalMinutes.textContent = "0";
  elements.rowCount.textContent = "0";
  elements.printPdf.disabled = true;
  elements.allocationBody.innerHTML = '<tr><td colspan="5" class="empty compact">生成後に表示されます。</td></tr>';
  elements.previewBody.innerHTML = '<tr><td colspan="5" class="empty">生成結果がここに表示されます。</td></tr>';
  elements.pdfExportRoot.innerHTML = "";
}

function printPdf() {
  if (!lastExport) return;

  const fitClass = elements.fitOnePage.checked ? " fit-one-page" : "";
  const hideContractName = elements.hideContractNamePdf.checked;
  elements.pdfExportRoot.innerHTML = `
    <section class="pdf-page${fitClass}">
      <h1>${lastExport.year}年${lastExport.month}月 契約別合計</h1>
      ${buildAllocationPrintTable(lastExport.allocations, hideContractName)}
    </section>
    <section class="pdf-page${fitClass}">
      <h1>${lastExport.year}年${lastExport.month}月 入力時間</h1>
      ${buildPreviewPrintTable(lastExport.rows, hideContractName)}
    </section>
  `;

  window.print();
}

function buildAllocationPrintTable(allocations, hideContractName = false) {
  const rows = allocations
    .map(
      (allocation) => `
        <tr>
          ${hideContractName ? "" : `<td>${escapeHtml(allocation.name)}</td>`}
          <td>${escapeHtml(allocation.no)}</td>
          <td>${formatRatio(allocation.ratio)}</td>
          <td>${allocation.minutes.toLocaleString("ja-JP")}</td>
          <td>${formatDuration(allocation.minutes)}</td>
        </tr>
      `,
    )
    .join("");

  return `
    <table>
      <thead>
        <tr>
          ${hideContractName ? "" : "<th>契約名</th>"}
          <th>契約No</th>
          <th>発注数量</th>
          <th>合計分数</th>
          <th>時間換算</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function buildPreviewPrintTable(rows, hideContractName = false) {
  const tableRows = rows
    .map(
      (row) => `
        <tr>
          <td>${row.date}</td>
          <td>${row.start_time}</td>
          <td>${row.end_time}</td>
          ${hideContractName ? "" : `<td>${escapeHtml(row.contract_name)}</td>`}
          <td>${escapeHtml(row.contract_no)}</td>
        </tr>
      `,
    )
    .join("");

  return `
    <table>
      <thead>
        <tr>
          <th>日付</th>
          <th>開始時刻</th>
          <th>終了時刻</th>
          ${hideContractName ? "" : "<th>契約名</th>"}
          <th>契約No</th>
        </tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>
  `;
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
