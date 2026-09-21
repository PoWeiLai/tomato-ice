/**
 * 店家基本資料。要改地址、電話、營業時間就改這裡，不用動其他程式。
 * address 填完整地址，地圖會照這個定位；還沒填的話會用店名去 Google 地圖搜尋。
 */
export const STORE = {
  name: '蔗家店',
  /** 板橋四川店（門面照片上的門牌 43 號） */
  address: '新北市板橋區四川路二段 43 號',
  /** 多支電話用「、」隔開，客人手機點了會直接撥號；留空就不顯示 */
  phone: '02-8966-0036、0932-007-148',
  /** 營業時間，例如 '11:00–21:00'；留空就不顯示 */
  hours: '10:00–21:00',
  /** 臉書粉專網址，點餐頁會顯示「來按個讚」卡片；留空就不顯示 */
  facebook: 'https://www.facebook.com/goldentea2007/',
  /** LINE 官方帳號網址（DM 上的「加入 LINE 好友贈 100 元抵用券」），留空就不顯示 */
  line: '',
}

/**
 * 部落格／媒體報導。要加新的文章就往陣列裡加一筆，不想顯示就清空陣列。
 * video 填 YouTube 網址（watch、youtu.be、shorts 都可以），卡片會先秀影片畫面，客人點了直接在點餐頁播；沒影片就留空字串。
 */
export const PRESS: { source: string; title: string; summary?: string; url: string; video?: string }[] = [
  {
    source: 'ShareLife 台灣旅行趣',
    title: '就愛蔗家店！產地水果與甘蔗特調，台北茶飲推薦！',
    summary: 'Golden 自 2007 年起在南投砍甘蔗、彰化育荔枝、台南植鳳梨，蔗家店把產地水果與甘蔗汁特調成一杯。',
    url: 'https://taiwan.sharelife.tw/article_aid-27007.html',
    // 還沒有店家的 YouTube 影片，先留空；之後有再填網址，卡片會自動變成可播放
    video: '',
  },
]

/** 從各種 YouTube 網址抓出影片 ID，抓不到回傳空字串 */
export function youtubeId(url: string): string {
  const m = url.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/)
  return m ? m[1] : ''
}

const mapQuery = STORE.address || STORE.name
/** Google 地圖內嵌網址（免 API 金鑰） */
export const MAP_EMBED_URL = `https://www.google.com/maps?q=${encodeURIComponent(mapQuery)}&output=embed&hl=zh-TW`
/** 手機點了會開 Google 地圖導航 */
export const MAP_LINK = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery)}`
