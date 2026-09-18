/**
 * 店家基本資料。要改地址、電話、營業時間就改這裡，不用動其他程式。
 * address 填完整地址，地圖會照這個定位；還沒填的話會用店名去 Google 地圖搜尋。
 */
export const STORE = {
  name: '嚐香聚牛肉麵',
  address: '', // 例：'台北市中山區○○路 221 號'
  phone: '',
  hours: '',
}

const mapQuery = STORE.address || STORE.name
/** Google 地圖內嵌網址（免 API 金鑰） */
export const MAP_EMBED_URL = `https://www.google.com/maps?q=${encodeURIComponent(mapQuery)}&output=embed&hl=zh-TW`
/** 手機點了會開 Google 地圖導航 */
export const MAP_LINK = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery)}`
