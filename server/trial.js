// 試用期限。
// 店家到 TRIAL_END 這一天（含當天）都能正常點餐、看後台；隔天凌晨起整站鎖住：
// 客人端、廚房看板、後台都只會看到一頁到期說明，所有 /api 都回 403（只留 /api/health）。
//
// 要延長或解鎖，改主機的環境變數（店家碰不到，只有部署的人能改）：
//   TRIAL_END=2026-10-31   延到 10/31 當天結束
//   TRIAL_END=0            不限期，永久開放
// Render 的話是：服務頁 → Environment → 加/改這個值 → 會自動重啟生效。
const DEFAULT_TRIAL_END = '2026-09-30';

// 以店家當地時間分日，跟報表同一個時差（台灣 +8）。
// 主機在國外，用主機時間算會差 8 小時，店家最後一天會被提早關掉。
const TZ_OFFSET_HOURS = Number(process.env.TZ_OFFSET_HOURS ?? 8);

/** 'YYYY-MM-DD' → 這一天當地 00:00 的 UTC 毫秒；日期不存在（例如 2026-02-31）回 NaN */
function localMidnight(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return NaN;
  const [y, mo, d] = m.slice(1).map(Number);
  const utc = Date.UTC(y, mo - 1, d);
  // Date.UTC 會把 2026-02-31 默默算成 3/3，反推回來比對才擋得掉
  const back = new Date(utc);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return NaN;
  return utc - TZ_OFFSET_HOURS * 3600_000;
}

const DAY_MS = 86_400_000;

const raw = String(process.env.TRIAL_END ?? '').trim();
/** 不限期（環境變數設成 0 / off / never） */
export const TRIAL_UNLIMITED = /^(0|off|none|never|無|不限)$/i.test(raw);

/** 試用最後一天，'YYYY-MM-DD'；不限期時是空字串 */
export let TRIAL_END = '';
/** 鎖住的時間點（最後一天的隔天凌晨），UTC 毫秒；不限期時是 Infinity */
let lockAt = Infinity;

if (!TRIAL_UNLIMITED) {
  let end = raw || DEFAULT_TRIAL_END;
  if (raw && Number.isNaN(localMidnight(raw))) {
    console.warn(`  ⚠ 環境變數 TRIAL_END「${raw}」不是有效日期（要 2026-09-30 這種格式），已改用內定 ${DEFAULT_TRIAL_END}`);
    end = DEFAULT_TRIAL_END;
  }
  TRIAL_END = end;
  lockAt = localMidnight(end) + DAY_MS; // 最後一天過完才鎖
}

/** 現在是否已經超過試用期。每次呼叫都重算，主機不重啟也會在當地凌晨自動翻頁 */
export const trialExpired = () => Date.now() >= lockAt;

/** 還剩幾天（今天是最後一天時回 0）；不限期回 null */
export function trialDaysLeft() {
  if (TRIAL_UNLIMITED) return null;
  return Math.max(0, Math.ceil((lockAt - Date.now()) / DAY_MS) - 1);
}

/** 給 /api/health 和前端提示橫幅用 */
export const trialStatus = () =>
  TRIAL_UNLIMITED
    ? { unlimited: true }
    : { end: TRIAL_END, expired: trialExpired(), daysLeft: trialDaysLeft() };

/** 到期後 API 回的訊息 */
export const TRIAL_OVER_MESSAGE = `試用期已於 ${TRIAL_END} 結束，系統已停用，請聯絡系統提供者`;

const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);

/** 到期後所有網頁都回這一頁。不依賴 dist / 資料庫，單獨一頁也能顯示 */
export const expiredPage = () => `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>試用期已結束</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    font-family: system-ui, -apple-system, "Noto Sans TC", sans-serif;
    background: #faf7f2; color: #3b332b;
  }
  .box {
    max-width: 22rem; text-align: center; background: #fff; border-radius: 18px;
    padding: 32px 24px; box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 12px 32px rgba(0,0,0,.09);
  }
  h1 { margin: 0 0 12px; font-size: 1.35rem; }
  p { margin: 0 0 8px; line-height: 1.7; color: #6b6156; }
  .date { font-weight: 700; color: #3b332b; }
  @media (prefers-color-scheme: dark) {
    body { background: #1c1917; color: #f2ede6; }
    .box { background: #262220; box-shadow: 0 12px 32px rgba(0,0,0,.5); }
    p { color: #b3a79a; }
    .date { color: #f2ede6; }
  }
</style>
</head>
<body>
  <div class="box">
    <h1>試用期已結束</h1>
    <p>本系統的試用期已於 <span class="date">${esc(TRIAL_END)}</span> 結束，點餐與後台都已暫停。</p>
    <p>要繼續使用請聯絡系統提供者。</p>
  </div>
</body>
</html>
`;
