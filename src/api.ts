export interface OptionChoice {
  id: number
  group_id: number
  name: string
  price_delta: number
  sort: number
}
export interface OptionGroup {
  id: number
  key: string
  name: string
  mode: 'single' | 'multi'
  required: number
  sort: number
  choices: OptionChoice[]
}
export interface MenuItem {
  id: number
  category_id: number
  name: string
  description: string
  price: number
  image: string
  available: number
  sort: number
  optionGroups: OptionGroup[]
}
export interface ChosenOption {
  group: string
  name: string
  price_delta: number
}
export interface Category {
  id: number
  name: string
  sort: number
  items: MenuItem[]
}
export interface OrderItem {
  id: number
  order_id: number
  item_id: number | null
  name: string
  price: number
  qty: number
  note: string
  options: ChosenOption[]
}
export type OrderStatus = 'pending' | 'preparing' | 'done' | 'cancelled'
export type SessionKind = 'dine' | 'takeout'
export interface Order {
  id: number
  session_id: number
  table_id: number
  kind: SessionKind
  customer: string
  closed_at: string | null
  status: OrderStatus
  note: string
  created_at: string
  items: OrderItem[]
  total: number
}
/** 廚房／帳單標題：內用顯示桌號，外帶顯示客人稱呼 */
export const orderTitle = (o: { kind: SessionKind; customer: string; table_id: number }) =>
  o.kind === 'takeout' ? `外帶・${o.customer}` : `${o.table_id} 號桌`
export interface Table {
  id: number
  name: string
  seats: number
}
export interface Bill {
  id: number
  table_id: number
  kind: SessionKind
  customer: string
  opened_at: string
  closed_at: string | null
  table: Table
  orders: Order[]
  subtotal: number
  discount: number
  discount_note: string
  total: number
}
export type DiscountType = 'none' | 'percent' | 'amount' | 'free'
export interface Discount {
  type: DiscountType
  value: number
  reason: string
}
export interface QrTable extends Table {
  url: string
  qr: string
}
export interface Report {
  closedCount: number
  takeoutCount: number
  revenue: number
  discountTotal: number
  freeCount: number
  date: string | null
  byKind: { kind: SessionKind; count: number; amount: number }[]
  byPayment: { payment: Payment; count: number; amount: number }[]
  byHour: { hour: number; count: number; amount: number }[]
  days: { date: string; count: number; revenue: number; takeoutCount: number }[]
  topItems: { name: string; qty: number; amount: number }[]
}

export interface Feedback {
  id: number
  session_id: number | null
  kind: SessionKind
  who: string
  rating: number
  comment: string
  photos: string[]
  reply: string
  replied_at: string | null
  created_at: string
}

export type Payment = 'cash' | 'card' | 'linepay' | 'applepay' | 'mobile' | 'free'
export const PAYMENT_LABEL: Record<Payment, string> = {
  cash: '現金',
  card: '刷卡',
  linepay: 'LINE Pay',
  applepay: 'Apple Pay',
  mobile: '行動支付',
  free: '免單',
}

const PIN_KEY = 'restaurant.staffPin'
export const getPin = () => localStorage.getItem(PIN_KEY) || ''
export const setPin = (pin: string) => localStorage.setItem(PIN_KEY, pin)
export const clearPin = () => localStorage.removeItem(PIN_KEY)

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {}
  const pin = getPin()
  if (pin) headers['x-staff-pin'] = pin

  let body: BodyInit | undefined
  if (options.body instanceof FormData) {
    body = options.body
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.body)
  }

  const res = await fetch(`/api${path}`, { method: options.method || 'GET', headers, body })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) throw new ApiError(res.status, data?.error || `連線失敗（${res.status}）`)
  return data as T
}

export const api = {
  menu: () => request<Category[]>('/menu'),
  tables: () => request<Table[]>('/tables'),
  tableSession: (id: number) =>
    request<{ table: Table; session: unknown; orders: Order[]; total: number }>(`/tables/${id}/session`),
  placeOrder: (
    tableId: number,
    items: { itemId: number; qty: number; note?: string; choiceIds?: number[] }[],
    note = '',
    takeout?: { name: string; phone: string }
  ) =>
    request<Order>('/orders', { method: 'POST', body: { tableId, items, note, takeout } }),
  order: (id: number) => request<Order>(`/orders/${id}`),

  login: (pin: string) => request<{ ok: true }>('/staff/login', { method: 'POST', body: { pin } }),
  changePin: (pin: string) => request<{ ok: true }>('/admin/pin', { method: 'POST', body: { pin } }),

  kitchenOrders: (scope: 'active' | 'all' = 'active') => request<Order[]>(`/kitchen/orders?scope=${scope}`),
  setOrderStatus: (id: number, status: OrderStatus) =>
    request<Order>(`/orders/${id}/status`, { method: 'PATCH', body: { status } }),

  addCategory: (name: string) => request<Category>('/admin/categories', { method: 'POST', body: { name } }),
  renameCategory: (id: number, name: string) =>
    request<Category>(`/admin/categories/${id}`, { method: 'PATCH', body: { name } }),
  deleteCategory: (id: number) => request<{ ok: true }>(`/admin/categories/${id}`, { method: 'DELETE' }),

  addItem: (body: { categoryId: number; name: string; price: number; description?: string; image?: string }) =>
    request<MenuItem>('/admin/menu-items', { method: 'POST', body }),
  updateItem: (id: number, body: Partial<{ name: string; price: number; description: string; image: string; available: boolean; categoryId: number }>) =>
    request<MenuItem>(`/admin/menu-items/${id}`, { method: 'PATCH', body }),
  deleteItem: (id: number) => request<{ ok: true }>(`/admin/menu-items/${id}`, { method: 'DELETE' }),
  bulkImport: (text: string, replace: boolean) =>
    request<{ ok: true; count: number }>('/admin/menu/bulk', { method: 'POST', body: { text, replace } }),
  upload: (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return request<{ url: string }>('/admin/upload', { method: 'POST', body: fd })
  },

  qrcodes: () =>
    request<{ baseURL: string; tables: QrTable[]; takeout: { url: string; qr: string } }>('/admin/qrcodes'),
  bills: () => request<Bill[]>('/admin/bills'),
  closeBill: (sessionId: number, payment: Payment, discount?: Discount) =>
    request<{ ok: true; subtotal: number; discount: number; total: number }>(
      `/admin/sessions/${sessionId}/close`,
      { method: 'POST', body: { payment, discount } }
    ),
  report: (date?: string) => request<Report>(`/admin/report${date ? `?date=${date}` : ''}`),

  /** 心得可以附最多 3 張照片，所以用 FormData 送 */
  sendFeedback: (orderId: number, rating: number, comment: string, photos: Blob[] = []) => {
    const fd = new FormData()
    fd.append('orderId', String(orderId))
    fd.append('rating', String(rating))
    fd.append('comment', comment)
    for (const p of photos) fd.append('photos', p, 'photo.jpg')
    return request<{ ok: true }>('/feedback', { method: 'POST', body: fd })
  },
  feedback: () => request<{ count: number; avg: number; pending: number; list: Feedback[] }>('/admin/feedback'),
  replyFeedback: (id: number, reply: string) =>
    request<{ ok: true; reply: string; replied_at: string | null }>(`/admin/feedback/${id}/reply`, { method: 'POST', body: { reply } }),
  myFeedback: (orderId: number) => request<Feedback | null>(`/feedback/by-order/${orderId}`),
  deleteFeedback: (id: number) => request<{ ok: true }>(`/admin/feedback/${id}`, { method: 'DELETE' }),
}

/** 下載整份營運資料備份，交給店家自己保存 */
export async function downloadBackup() {
  const res = await fetch('/api/admin/backup', { headers: { 'x-staff-pin': getPin() } })
  if (!res.ok) {
    const text = await res.text()
    const data = text ? JSON.parse(text) : null
    throw new ApiError(res.status, data?.error || `備份失敗（${res.status}）`)
  }
  const name =
    res.headers.get('content-disposition')?.match(/filename="?([^";]+)/)?.[1] || 'restaurant-backup.db'
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

/** 訂閱伺服器事件；回傳取消訂閱函式 */
export function subscribe(handlers: Record<string, (data: any) => void>): () => void {
  const es = new EventSource('/api/events')
  for (const [type, fn] of Object.entries(handlers)) {
    es.addEventListener(type, (e) => fn(JSON.parse((e as MessageEvent).data || '{}')))
  }
  return () => es.close()
}

export const money = (n: number) => `$${n.toLocaleString('zh-TW')}`
export const clockTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false })
