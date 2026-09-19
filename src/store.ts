/**
 * 店家基本資料。要改地址、電話、營業時間就改這裡，不用動其他程式。
 * address 填完整地址，地圖會照這個定位；還沒填的話會用店名去 Google 地圖搜尋。
 */
export const STORE = {
  name: '嚐香聚牛肉麵',
  address: '澎湖縣馬公市光復路 221 號',
  phone: '06-926-2509',
  hours: '11:00–14:00、17:00–21:00',
  /** 臉書粉專網址，點餐頁會顯示「來按個讚」卡片；留空就不顯示 */
  facebook: 'https://www.facebook.com/tppramen',
}

/**
 * 部落格／媒體報導。要加新的文章就往陣列裡加一筆，不想顯示就清空陣列。
 * video 填 YouTube 網址（watch、youtu.be、shorts 都可以），卡片會先秀影片畫面，客人點了直接在點餐頁播；沒影片就留空字串。
 */
export const PRESS = [
  {
    source: 'ShareLife 台灣旅行趣',
    title: '澎湖｜嚐香聚牛肉麵，載滿人情味的澎湖老麵店',
    summary: '特製麵條 Q 彈有勁，小菜與手炒辣椒全手工製作，鎮店之寶的辣椒只限店內品嚐。',
    url: 'https://taiwan.sharelife.tw/article_aid-14106.html',
    video: 'https://www.youtube.com/watch?v=D0mYLm7Ca-s',
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
