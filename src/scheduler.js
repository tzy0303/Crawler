import { now } from './core/store.js';

/** 今天 HH:mm 的台灣時間字串 "YYYY-MM-DD HH:mm:00" */
const todayAt = (hhmm) => `${now().slice(0, 10)} ${hhmm}:00`;

/**
 * 每天在 time（台灣時間 HH:mm）跑一次 task。
 * 每分鐘檢查一次，所以電腦睡眠/關機錯過時間的話，醒來後會補跑。
 * lastRunAt()：回傳最近一次「排程」執行的開始時間字串（或 null）。
 */
export function startDailyScheduler({ time, task, lastRunAt, log = console.log }) {
  let running = false;
  const state = { time, nextRunAt: null };

  const computeNext = () => {
    const due = todayAt(time);
    const last = lastRunAt();
    // 今天的時間已過、而且今天那個時間之後還沒跑過 → 現在就該跑
    state.nextRunAt = now() >= due && (!last || last < due) ? now() : nextDay(due, now() >= due);
  };

  const tick = async () => {
    if (running || now() < state.nextRunAt) return;
    running = true;
    try {
      log(`[排程] 每日抓取開始`);
      await task();
    } catch (err) {
      log(`[排程] 失敗：${err.message}`);
    } finally {
      running = false;
      state.nextRunAt = nextDay(todayAt(time), true);
      log(`[排程] 下次執行：${state.nextRunAt}`);
    }
  };

  computeNext();
  log(`[排程] 每天 ${time} 自動抓取，下次執行：${state.nextRunAt}`);
  const timer = setInterval(tick, 60_000);
  setTimeout(tick, 10_000);
  return { state, stop: () => clearInterval(timer) };
}

function nextDay(dueStr, plusOne) {
  if (!plusOne) return dueStr;
  const d = new Date(`${dueStr.replace(' ', 'T')}+08:00`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' });
}
