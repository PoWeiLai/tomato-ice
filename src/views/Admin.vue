<script setup lang="ts">
import { computed, onUnmounted, reactive, ref } from 'vue'
import StaffGate from '../components/StaffGate.vue'
import {
  api,
  clearPin,
  downloadBackup,
  setPin,
  PAYMENT_LABEL,
  money,
  orderTitle,
  subscribe,
  type Bill,
  type Category,
  type Discount,
  type DiscountType,
  type Feedback,
  type MenuItem,
  type OrderItem,
  type Payment,
  type QrTable,
  type Report,
} from '../api'

/** 帳單一行：品名（選項）×數量 */
const describeLine = (i: OrderItem) =>
  `${i.name}${i.options.length ? `（${i.options.map((o) => o.name).join('／')}）` : ''}×${i.qty}`

type Tab = 'menu' | 'qrcode' | 'bills' | 'report' | 'feedback'
const tab = ref<Tab>('menu')
const TABS: { id: Tab; label: string }[] = [
  { id: 'menu', label: '菜單管理' },
  { id: 'qrcode', label: 'QRcode 列印' },
  { id: 'bills', label: '帳單結帳' },
  { id: 'report', label: '今日報表' },
  { id: 'feedback', label: '顧客回饋' },
]

const toast = ref('')
const say = (m: string) => {
  toast.value = m
  setTimeout(() => (toast.value = ''), 2600)
}
async function run(fn: () => Promise<unknown>, okMsg?: string) {
  try {
    await fn()
    if (okMsg) say(okMsg)
  } catch (e) {
    say(e instanceof Error ? e.message : '操作失敗')
  }
}

/* ---------- 菜單 ---------- */
const categories = ref<Category[]>([])
const newCat = ref('')
const draft = reactive<Record<number, { name: string; price: string; description: string }>>({})
const bulkText = ref('')
const bulkReplace = ref(false)

const loadMenu = async () => {
  categories.value = await api.menu()
  for (const c of categories.value) {
    if (!draft[c.id]) draft[c.id] = { name: '', price: '', description: '' }
  }
}

function addItem(cat: Category) {
  const d = draft[cat.id]
  if (!d?.name.trim() || d.price === '') return say('請填品名與價格')
  run(async () => {
    await api.addItem({
      categoryId: cat.id,
      name: d.name.trim(),
      price: Number(d.price),
      description: d.description.trim(),
    })
    d.name = ''
    d.price = ''
    d.description = ''
    await loadMenu()
  }, '已新增餐點')
}

const toggleSold = (item: MenuItem) =>
  run(async () => {
    await api.updateItem(item.id, { available: !item.available })
    await loadMenu()
  }, item.available ? `「${item.name}」已標示售完` : `「${item.name}」已重新上架`)

const editPrice = (item: MenuItem) => {
  const input = prompt(`修改「${item.name}」的價格`, String(item.price))
  if (input === null) return
  const price = Number(input)
  if (!Number.isFinite(price) || price < 0) return say('價格不正確')
  run(async () => {
    await api.updateItem(item.id, { price })
    await loadMenu()
  }, '價格已更新')
}

const removeItem = (item: MenuItem) => {
  if (!confirm(`確定刪除「${item.name}」？`)) return
  run(async () => {
    await api.deleteItem(item.id)
    await loadMenu()
  }, '已刪除')
}

const addCategory = () => {
  if (!newCat.value.trim()) return
  run(async () => {
    await api.addCategory(newCat.value.trim())
    newCat.value = ''
    await loadMenu()
  }, '已新增分類')
}

const removeCategory = (cat: Category) => {
  if (!confirm(`刪除分類「${cat.name}」會一併刪除其下 ${cat.items.length} 道菜，確定嗎？`)) return
  run(async () => {
    await api.deleteCategory(cat.id)
    await loadMenu()
  }, '已刪除分類')
}

const uploading = ref(0)
function uploadImage(item: MenuItem, event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  uploading.value = item.id
  run(async () => {
    const { url } = await api.upload(file)
    await api.updateItem(item.id, { image: url })
    await loadMenu()
  }, '照片已更新').finally(() => (uploading.value = 0))
}

const importBulk = () =>
  run(async () => {
    if (bulkReplace.value && !confirm('這會清空現有菜單再匯入，確定嗎？')) return
    const { count } = await api.bulkImport(bulkText.value, bulkReplace.value)
    bulkText.value = ''
    await loadMenu()
    say(`已匯入 ${count} 道菜`)
  })

/* ---------- QRcode ---------- */
const qr = ref<{ baseURL: string; tables: QrTable[]; takeout: { url: string; qr: string } } | null>(null)
const loadQr = async () => (qr.value = await api.qrcodes())

/* ---------- 帳單 / 折扣 ---------- */
const bills = ref<Bill[]>([])
const loadBills = async () => (bills.value = await api.bills())

/** 每張帳單各自暫存店員選的折扣，按付款方式時一起送出 */
const discounts = reactive<Record<number, Discount>>({})
const discountOf = (bill: Bill) => (discounts[bill.id] ??= { type: 'none', value: 0, reason: '' })
const DISCOUNT_TYPES: { id: DiscountType; label: string }[] = [
  { id: 'none', label: '不打折' },
  { id: 'percent', label: '打折' },
  { id: 'amount', label: '折抵金額' },
  { id: 'free', label: '免單' },
]
/** 折數輸入法跟台灣習慣一樣：9 = 9折、85 = 85折 */
function discountAmount(bill: Bill) {
  const d = discountOf(bill)
  if (d.type === 'free') return bill.subtotal
  if (d.type === 'percent') {
    const pct = d.value >= 10 ? d.value : d.value * 10
    if (!(pct > 0 && pct < 100)) return 0
    return Math.min(bill.subtotal, Math.round(bill.subtotal * (1 - pct / 100)))
  }
  if (d.type === 'amount') return Math.min(bill.subtotal, Math.max(0, Math.round(d.value || 0)))
  return 0
}
const payable = (bill: Bill) => Math.max(0, bill.subtotal - discountAmount(bill))
const billTitle = (bill: Bill) => orderTitle(bill)

const closeBill = (bill: Bill, payment: Payment) => {
  const d = discountOf(bill)
  const label = d.type === 'free' ? '免單' : `結帳 ${money(payable(bill))}`
  if (!confirm(`${billTitle(bill)} ${label}，確定嗎？`)) return
  run(async () => {
    await api.closeBill(bill.id, payment, d.type === 'none' ? undefined : { ...d })
    delete discounts[bill.id]
    await Promise.all([loadBills(), loadReport()])
  }, d.type === 'free' ? '已免單' : '已完成結帳')
}
const printBill = (bill: Bill) => {
  printTarget.value = bill
  requestAnimationFrame(() => {
    window.print()
    printTarget.value = null
  })
}
const printTarget = ref<Bill | null>(null)
const printAll = () => window.print()

/* ---------- 報表 ---------- */
const report = ref<Report | null>(null)
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
/** 正在看哪一天的報表；訂單都留在資料庫裡，所以往前翻都翻得到 */
const reportDate = ref(today())
const isToday = computed(() => reportDate.value === today())
const loadReport = async () => (report.value = await api.report(reportDate.value))
function viewDate(date: string) {
  reportDate.value = date
  run(loadReport)
}

const KIND_LABEL: Record<string, string> = { dine: '內用', takeout: '外帶' }
// 圖表配色：固定對應到類別，不會因為某天少一種付款方式就跑掉（已用 dataviz 驗證色盲可分辨）
const KIND_COLOR: Record<string, string> = { dine: '#1b5fb4', takeout: '#3b9dd6' }
const PAYMENT_COLOR: Record<string, string> = {
  cash: '#1b5fb4',
  card: '#3b9dd6',
  linepay: '#b0851a',
  applepay: '#6b4fb3',
  mobile: '#6b6b6b',
  free: '#6b6b6b',
}
const pct = (n: number, total: number) => (total ? Math.round((n / total) * 100) : 0)
/** 內用／外帶各占幾成（依筆數） */
const kindShare = computed(() => {
  const rows = report.value?.byKind || []
  const total = rows.reduce((s, r) => s + r.count, 0)
  return rows.filter((r) => r.count > 0).map((r) => ({ ...r, pct: pct(r.count, total) }))
})
/** 各付款方式占營業額幾成 */
const paymentShare = computed(() => {
  const rows = report.value?.byPayment || []
  const total = rows.reduce((s, r) => s + r.amount, 0)
  return rows.filter((r) => r.amount > 0).map((r) => ({ ...r, pct: pct(r.amount, total) }))
})
const topMax = computed(() => Math.max(1, ...(report.value?.topItems || []).map((i) => i.qty)))
/** 時段圖：從最早到最晚有結帳的小時，中間沒生意的小時也留空格 */
const hours = computed(() => {
  const rows = report.value?.byHour || []
  if (!rows.length) return []
  const lo = rows[0].hour
  const hi = rows[rows.length - 1].hour
  const max = Math.max(1, ...rows.map((r) => r.count))
  return Array.from({ length: hi - lo + 1 }, (_, i) => {
    const h = lo + i
    const r = rows.find((x) => x.hour === h)
    return { hour: h, count: r?.count || 0, amount: r?.amount || 0, pct: pct(r?.count || 0, max) }
  })
})
const dayLabel = (iso: string) => {
  const [, m, d] = iso.split('-')
  return `${Number(m)}/${Number(d)}`
}
const monthLabel = (ym: string | null) => (ym ? `${Number(ym.split('-')[1])} 月` : '本月')
const monthTopMax = computed(() => Math.max(1, ...(report.value?.month?.topItems || []).map((i) => i.qty)))
/** 結帳時間只顯示時:分 */
const clock = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false }) : '')

/* ---------- 顧客回饋 ---------- */
const feedback = ref<{ count: number; avg: number; pending: number; list: Feedback[] } | null>(null)
/** 每則回饋各自的回覆草稿，開始編輯時從既有回覆帶入 */
const replyDraft = reactive<Record<number, string>>({})
const replying = ref<number | null>(null)
function openReply(f: Feedback) {
  replyDraft[f.id] ??= f.reply
  replying.value = f.id
}
const saveReply = (f: Feedback) =>
  run(async () => {
    await api.replyFeedback(f.id, (replyDraft[f.id] || '').trim())
    replying.value = null
    await loadFeedback()
  }, replyDraft[f.id]?.trim() ? '已回覆客人' : '已撤回回覆')
const loadFeedback = async () => (feedback.value = await api.feedback())
const removeFeedback = (f: Feedback) => {
  if (!confirm('確定刪除這則回饋？')) return
  run(async () => {
    await api.deleteFeedback(f.id)
    await loadFeedback()
  }, '已刪除')
}
const feedbackTime = (iso: string) =>
  new Date(iso).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/* ---------- 店員密碼 ---------- */
const newPin = ref('')
const newPin2 = ref('')
function changePin() {
  if (!/^\d{4,8}$/.test(newPin.value)) return say('密碼必須是 4～8 位數字')
  if (newPin.value !== newPin2.value) return say('兩次輸入的密碼不一樣')
  run(async () => {
    await api.changePin(newPin.value)
    setPin(newPin.value) // 這台裝置直接沿用新密碼，不用重新登入
    newPin.value = ''
    newPin2.value = ''
  }, '密碼已更新，其他裝置（廚房平板等）要用新密碼重新登入')
}

/* ---------- 老闆手機（忘記密碼時用來驗證身分） ---------- */
const ownerPhone = ref('')
const ownerPhoneSaved = ref('')
const loadOwnerPhone = async () => {
  ownerPhone.value = ownerPhoneSaved.value = (await api.ownerPhone()).phone
}
function saveOwnerPhone() {
  run(async () => {
    const { phone } = await api.setOwnerPhone(ownerPhone.value)
    ownerPhone.value = ownerPhoneSaved.value = phone
  }, ownerPhone.value.trim() ? '手機已登記，忘記密碼時輸入這支號碼就能重設' : '已取消登記，忘記密碼將無法自助重設')
}

const backupBusy = ref(false)
async function saveBackup() {
  backupBusy.value = true
  await run(downloadBackup, '備份已下載，請妥善保存這個檔案')
  backupBusy.value = false
}

const menuItemCount = computed(() => categories.value.reduce((s, c) => s + c.items.length, 0))

function openTab(next: Tab) {
  tab.value = next
  if (next === 'qrcode' && !qr.value) run(loadQr)
  if (next === 'bills') run(loadBills)
  if (next === 'report') {
    run(loadReport)
    run(loadOwnerPhone)
  }
  if (next === 'feedback') run(loadFeedback)
}

function logout() {
  clearPin()
  location.reload()
}

const ready = ref(false)
/** 登入成功後才載入，否則會在登入前就打 API 被擋 401 */
function start() {
  ready.value = true
  run(loadMenu)
}

const unsubscribe = subscribe({
  'order:new': () => ready.value && tab.value === 'bills' && loadBills(),
  'order:update': () => ready.value && tab.value === 'bills' && loadBills(),
})
onUnmounted(unsubscribe)
</script>

<template>
  <StaffGate @unlocked="start">
    <div class="admin">
      <header class="bar no-print">
        <h1>後台管理</h1>
        <nav>
          <button v-for="t in TABS" :key="t.id" :class="{ on: tab === t.id }" @click="openTab(t.id)">
            {{ t.label }}
          </button>
        </nav>
        <button @click="logout">登出</button>
      </header>

      <!-- 菜單管理 -->
      <main v-show="tab === 'menu'" class="wrap no-print">
        <div class="card pad row">
          <input v-model="newCat" placeholder="新增分類名稱（例：熱炒）" @keyup.enter="addCategory" />
          <button class="btn-primary" @click="addCategory">新增分類</button>
          <span class="muted">目前 {{ categories.length }} 個分類 · {{ menuItemCount }} 道菜</span>
        </div>

        <section v-for="cat in categories" :key="cat.id" class="card pad">
          <header class="cat-head">
            <h2>{{ cat.name }}</h2>
            <button class="btn-danger" @click="removeCategory(cat)">刪除分類</button>
          </header>

          <table class="items">
            <thead>
              <tr>
                <th>照片</th>
                <th>品名</th>
                <th>說明</th>
                <th class="num">價格</th>
                <th>狀態</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in cat.items" :key="item.id" :class="{ off: !item.available }">
                <td>
                  <label class="pic">
                    <img v-if="item.image" :src="item.image" :alt="item.name" />
                    <span v-else class="muted">{{ uploading === item.id ? '上傳中…' : '＋圖片' }}</span>
                    <input type="file" accept="image/*" hidden @change="uploadImage(item, $event)" />
                  </label>
                </td>
                <td>
                  {{ item.name }}
                  <div v-if="item.optionGroups.length" class="muted opt-tags">
                    {{ item.optionGroups.map((g) => g.name).join('、') }}
                  </div>
                </td>
                <td class="muted desc">{{ item.description || '—' }}</td>
                <td class="num tabular">{{ money(item.price) }}</td>
                <td>
                  <span class="pill" :class="item.available ? 'on' : 'off'">
                    {{ item.available ? '供應中' : '已售完' }}
                  </span>
                </td>
                <td class="acts">
                  <button @click="editPrice(item)">改價</button>
                  <button @click="toggleSold(item)">{{ item.available ? '標售完' : '重上架' }}</button>
                  <button class="btn-danger" @click="removeItem(item)">刪除</button>
                </td>
              </tr>
              <tr v-if="!cat.items.length">
                <td colspan="6" class="muted center">此分類尚無餐點</td>
              </tr>
            </tbody>
          </table>

          <div class="row add" v-if="draft[cat.id]">
            <input v-model="draft[cat.id].name" placeholder="品名" />
            <input v-model="draft[cat.id].price" type="number" min="0" placeholder="價格" class="w-price" />
            <input v-model="draft[cat.id].description" placeholder="說明（可空白）" />
            <button class="btn-primary" @click="addItem(cat)">新增</button>
          </div>
        </section>

        <section class="card pad">
          <h2>批次匯入菜單</h2>
          <p class="muted">
            每行一道菜，格式：<code>分類,品名,價格,說明</code>（說明可省略）。適合一次把整本菜單貼上來。
          </p>
          <textarea
            v-model="bulkText"
            rows="7"
            placeholder="熱炒,宮保雞丁,180,微辣&#10;熱炒,蒼蠅頭,160&#10;飲料,烏龍茶,30"
          ></textarea>
          <div class="row">
            <label class="check">
              <input type="checkbox" v-model="bulkReplace" />
              <span>覆蓋現有菜單（清空後重新匯入）</span>
            </label>
            <button class="btn-primary" :disabled="!bulkText.trim()" @click="importBulk">開始匯入</button>
          </div>
        </section>
      </main>

      <!-- QRcode -->
      <main v-show="tab === 'qrcode'" class="wrap">
        <div class="card pad row no-print">
          <div>
            <strong>掃碼網址</strong>
            <div class="muted">{{ qr?.baseURL }}/t/桌號 — 客人手機需連上店內 WiFi</div>
          </div>
          <button class="btn-primary" @click="printAll">列印全部 QRcode</button>
        </div>
        <div class="qr-grid">
          <figure v-for="t in qr?.tables || []" :key="t.id" class="card qr-card">
            <img :src="t.qr" :alt="`${t.name} QRcode`" />
            <figcaption>
              <strong>{{ t.name }}</strong>
              <span class="muted small">掃描點餐</span>
            </figcaption>
          </figure>
          <figure v-if="qr?.takeout" class="card qr-card takeout-qr">
            <img :src="qr.takeout.qr" alt="外帶點餐 QRcode" />
            <figcaption>
              <strong>外帶</strong>
              <span class="muted small">貼櫃檯，掃描自助點外帶</span>
            </figcaption>
          </figure>
        </div>
      </main>

      <!-- 帳單 -->
      <main v-show="tab === 'bills'" class="wrap no-print">
        <p v-if="!bills.length" class="card pad muted center">目前沒有未結帳的桌次</p>
        <section v-for="b in bills" :key="b.id" class="card pad bill" :class="{ takeout: b.kind === 'takeout' }">
          <header class="cat-head">
            <h2>
              {{ billTitle(b) }}
              <span v-if="b.kind === 'takeout'" class="pill takeout-pill">外帶</span>
            </h2>
            <strong class="total tabular">{{ money(payable(b)) }}</strong>
          </header>
          <ul class="lines">
            <li v-for="o in b.orders" :key="o.id">
              <span class="muted">第 {{ o.id }} 單</span>
              <span>{{ o.items.map(describeLine).join('、') }}</span>
              <span class="tabular">{{ money(o.total) }}</span>
            </li>
          </ul>

          <!-- 折扣／免單：選好後按任一付款方式一起結掉 -->
          <div class="discount">
            <div class="seg">
              <button
                v-for="t in DISCOUNT_TYPES"
                :key="t.id"
                :class="{ on: discountOf(b).type === t.id, free: t.id === 'free' }"
                @click="discountOf(b).type = t.id"
              >
                {{ t.label }}
              </button>
            </div>
            <template v-if="discountOf(b).type !== 'none'">
              <label v-if="discountOf(b).type === 'percent'" class="disc-field">
                <span class="muted">折數</span>
                <input v-model.number="discountOf(b).value" type="number" inputmode="numeric" min="1" max="99" placeholder="9 = 9折、85 = 85折" />
              </label>
              <label v-else-if="discountOf(b).type === 'amount'" class="disc-field">
                <span class="muted">折抵</span>
                <input v-model.number="discountOf(b).value" type="number" inputmode="numeric" min="1" placeholder="金額" />
              </label>
              <label class="disc-field grow">
                <span class="muted">原因</span>
                <input v-model="discountOf(b).reason" placeholder="例：老闆招待、熟客（可不填）" />
              </label>
            </template>
            <div v-if="discountAmount(b) > 0" class="disc-sum tabular">
              原價 {{ money(b.subtotal) }}　折扣 −{{ money(discountAmount(b)) }}
              <strong>應收 {{ money(payable(b)) }}</strong>
            </div>
          </div>

          <div class="row">
            <button @click="printBill(b)">列印帳單</button>
            <template v-if="discountOf(b).type === 'free'">
              <button class="btn-danger" @click="closeBill(b, 'cash')">確認免單</button>
            </template>
            <template v-else>
              <!-- 客人在櫃檯用哪種方式付，店員就按哪個；系統只記錄，不串金流 -->
              <button class="btn-ok" @click="closeBill(b, 'cash')">現金</button>
              <button class="btn-ok" @click="closeBill(b, 'card')">刷卡</button>
              <button class="btn-ok pay-line" @click="closeBill(b, 'linepay')">LINE Pay</button>
              <button class="btn-ok pay-apple" @click="closeBill(b, 'applepay')"> Pay</button>
            </template>
          </div>
        </section>
      </main>

      <!-- 顧客回饋 -->
      <main v-show="tab === 'feedback'" class="wrap no-print">
        <div class="stats">
          <div class="card pad stat">
            <span class="muted">平均星等</span>
            <strong class="tabular">{{ feedback?.avg ? feedback.avg.toFixed(1) : '—' }} <span class="star-lg">★</span></strong>
            <span class="muted small">
              共 {{ feedback?.count || 0 }} 則回饋
              <template v-if="feedback?.pending">・<b class="pending">{{ feedback.pending }} 則待回覆</b></template>
            </span>
          </div>
        </div>
        <p v-if="feedback && !feedback.list.length" class="card pad muted center">還沒有客人留下回饋</p>
        <section class="fb-list">
          <article v-for="f in feedback?.list || []" :key="f.id" class="card pad fb">
            <header>
              <strong class="stars-ro" :aria-label="`${f.rating} 顆星`">{{ '★'.repeat(f.rating) }}<span class="muted">{{ '★'.repeat(5 - f.rating) }}</span></strong>
              <span class="muted small">{{ f.kind === 'takeout' ? '外帶・' : '' }}{{ f.who }}　{{ feedbackTime(f.created_at) }}</span>
              <button class="small" @click="removeFeedback(f)">刪除</button>
            </header>
            <p v-if="f.comment">{{ f.comment }}</p>
            <p v-else-if="!f.photos.length" class="muted small">（只給了星等，沒有留言）</p>
            <div v-if="f.photos.length" class="fb-photos">
              <a v-for="url in f.photos" :key="url" :href="url" target="_blank" rel="noopener">
                <img :src="url" alt="客人上傳的照片" loading="lazy" />
              </a>
            </div>

            <!-- 店家回覆：客人手機上會即時看到 -->
            <div v-if="replying === f.id" class="fb-reply-edit">
              <textarea v-model="replyDraft[f.id]" rows="3" maxlength="500" placeholder="例：謝謝您的支持，湯頭我們會再調整！"></textarea>
              <div class="row">
                <button class="btn-primary" @click="saveReply(f)">{{ f.reply ? '更新回覆' : '送出回覆' }}</button>
                <button @click="replying = null">取消</button>
              </div>
            </div>
            <div v-else-if="f.reply" class="fb-reply">
              <div>
                <strong>店家回覆</strong><span class="muted small">　{{ f.replied_at ? feedbackTime(f.replied_at) : '' }}</span>
                <p>{{ f.reply }}</p>
              </div>
              <button class="small" @click="openReply(f)">修改</button>
            </div>
            <button v-else class="btn-ok fb-reply-btn" @click="openReply(f)">回覆客人</button>
          </article>
        </section>
      </main>

      <!-- 報表 -->
      <main v-show="tab === 'report'" class="wrap no-print">
        <div class="row report-head">
          <h2>{{ isToday ? '今日' : dayLabel(reportDate) }}營業報表</h2>
          <input type="date" :value="reportDate" :max="today()" @change="viewDate(($event.target as HTMLInputElement).value)" />
          <button v-if="!isToday" @click="viewDate(today())">回到今天</button>
        </div>
        <div class="stats">
          <div class="card pad stat">
            <span class="muted">營業額</span>
            <strong class="tabular">{{ money(report?.revenue || 0) }}</strong>
          </div>
          <div class="card pad stat">
            <span class="muted">結帳筆數</span>
            <strong class="tabular">{{ report?.closedCount || 0 }}</strong>
            <span class="muted small">其中外帶 {{ report?.takeoutCount || 0 }} 筆</span>
          </div>
          <div class="card pad stat">
            <span class="muted">折扣／免單</span>
            <strong class="tabular">−{{ money(report?.discountTotal || 0) }}</strong>
            <span class="muted small">免單 {{ report?.freeCount || 0 }} 筆</span>
          </div>
        </div>

        <!-- 內用／外帶比例（依筆數） -->
        <section class="card pad chart">
          <h2>內用／外帶比例</h2>
          <p v-if="!kindShare.length" class="muted small">這天還沒有結帳紀錄</p>
          <template v-else>
            <div class="share-bar" role="img" :aria-label="kindShare.map((k) => `${KIND_LABEL[k.kind]} ${k.pct}%`).join('、')">
              <div
                v-for="k in kindShare"
                :key="k.kind"
                :style="{ flex: k.count, background: KIND_COLOR[k.kind] }"
                :title="`${KIND_LABEL[k.kind]} ${k.count} 筆・${money(k.amount)}`"
              >
                <span v-if="k.pct >= 12">{{ k.pct }}%</span>
              </div>
            </div>
            <ul class="legend">
              <li v-for="k in kindShare" :key="k.kind">
                <i :style="{ background: KIND_COLOR[k.kind] }"></i>
                {{ KIND_LABEL[k.kind] }} <span class="muted tabular">{{ k.pct }}%・{{ k.count }} 筆・{{ money(k.amount) }}</span>
              </li>
            </ul>
          </template>
        </section>

        <!-- 收款方式比例（依金額）：老闆對 LINE Pay／刷卡機入帳用 -->
        <section class="card pad chart">
          <h2>收款方式</h2>
          <p v-if="!paymentShare.length" class="muted small">這天還沒有收款紀錄</p>
          <template v-else>
            <div class="share-bar" role="img" :aria-label="paymentShare.map((p) => `${PAYMENT_LABEL[p.payment]} ${p.pct}%`).join('、')">
              <div
                v-for="p in paymentShare"
                :key="p.payment"
                :style="{ flex: p.amount, background: PAYMENT_COLOR[p.payment] }"
                :title="`${PAYMENT_LABEL[p.payment]} ${p.count} 筆・${money(p.amount)}`"
              >
                <span v-if="p.pct >= 12">{{ p.pct }}%</span>
              </div>
            </div>
            <table class="pay-table tabular">
              <tbody>
                <tr v-for="p in report?.byPayment || []" :key="p.payment">
                  <td><i class="dot" :style="{ background: PAYMENT_COLOR[p.payment] }"></i>{{ PAYMENT_LABEL[p.payment] }}</td>
                  <td class="num muted">{{ p.count }} 筆</td>
                  <td class="num"><strong>{{ money(p.amount) }}</strong></td>
                </tr>
              </tbody>
            </table>
          </template>
        </section>

        <!-- 時段分布：每小時結帳筆數 -->
        <section v-if="hours.length" class="card pad chart">
          <h2>時段分布</h2>
          <div class="hours" role="img" aria-label="各時段結帳筆數">
            <div v-for="h in hours" :key="h.hour" class="hour" :title="`${h.hour}:00～${h.hour}:59　${h.count} 筆・${money(h.amount)}`">
              <span class="val tabular">{{ h.count || '' }}</span>
              <div class="bar" :style="{ height: `${h.pct}%` }"></div>
              <span class="muted small tabular">{{ h.hour }}</span>
            </div>
          </div>
        </section>

        <!-- 最近 30 天：點日期切換 -->
        <section v-if="report?.days?.length" class="card pad">
          <h2>每日紀錄</h2>
          <table class="items days">
            <thead>
              <tr><th>日期</th><th class="num">筆數</th><th class="num">外帶</th><th class="num">營業額</th></tr>
            </thead>
            <tbody>
              <tr v-for="d in report.days" :key="d.date" :class="{ on: d.date === reportDate }" @click="viewDate(d.date)">
                <td>{{ dayLabel(d.date) }}<span v-if="d.date === today()" class="muted small">（今天）</span></td>
                <td class="num tabular">{{ d.count }}</td>
                <td class="num tabular">{{ d.takeoutCount }}</td>
                <td class="num tabular">{{ money(d.revenue || 0) }}</td>
              </tr>
            </tbody>
          </table>
        </section>
        <section class="card pad backup">
          <div>
            <h2>店員密碼</h2>
            <p class="muted">廚房與後台登入用。只能用 4～8 位數字，手機的數字鍵盤才打得出來。</p>
          </div>
          <form class="row pin-form" @submit.prevent="changePin">
            <input v-model="newPin" type="password" inputmode="numeric" pattern="[0-9]*" placeholder="新密碼" autocomplete="new-password" />
            <input v-model="newPin2" type="password" inputmode="numeric" pattern="[0-9]*" placeholder="再輸入一次" autocomplete="new-password" />
            <button class="btn-primary" type="submit" :disabled="!newPin || !newPin2">更改密碼</button>
          </form>
        </section>
        <section class="card pad backup">
          <div>
            <h2>老闆手機</h2>
            <p class="muted">
              忘記店員密碼時，在登入畫面按「忘記密碼」輸入這支號碼就能重設。
              <strong v-if="!ownerPhoneSaved" class="warn-text">目前未登記，忘記密碼會沒辦法自己重設。</strong>
            </p>
          </div>
          <form class="row pin-form" @submit.prevent="saveOwnerPhone">
            <input v-model="ownerPhone" type="tel" inputmode="numeric" placeholder="例：0912345678" autocomplete="tel" />
            <button class="btn-primary" type="submit" :disabled="ownerPhone.replace(/\D/g, '') === ownerPhoneSaved">
              {{ ownerPhoneSaved ? '更新' : '登記' }}
            </button>
          </form>
        </section>
        <section class="card pad backup">
          <div>
            <h2>資料備份</h2>
            <p class="muted">
              下載後請存到自己的電腦或雲端硬碟。建議每月做一次，萬一系統出狀況才有東西可以還原。
            </p>
          </div>
          <button class="btn-primary" :disabled="backupBusy" @click="saveBackup">
            {{ backupBusy ? '備份中…' : '下載備份' }}
          </button>
        </section>

        <!-- 當日每一張帳單：老闆回頭查某一天到底賣了什麼 -->
        <section class="card pad">
          <h2>{{ isToday ? '今日' : '當日' }}帳單明細</h2>
          <p v-if="!report?.bills?.length" class="muted small">這天沒有結清的帳單</p>
          <ul v-else class="history">
            <li v-for="b in report.bills" :key="b.id">
              <div class="history-head">
                <strong>{{ billTitle(b) }}</strong>
                <span class="muted small tabular">{{ clock(b.closed_at) }}</span>
                <span class="pay-tag" :style="{ background: PAYMENT_COLOR[b.payment] }">{{ PAYMENT_LABEL[b.payment] }}</span>
                <strong class="tabular history-total">{{ money(b.paid_total) }}</strong>
              </div>
              <p class="muted small history-items">
                {{ b.orders.flatMap((o) => o.items).map(describeLine).join('、') }}
                <template v-if="b.discount">（{{ b.discount_note || '折扣' }} −{{ money(b.discount) }}）</template>
              </p>
            </li>
          </ul>
        </section>

        <!-- 整月累計：公司回頭看一個月的狀況 -->
        <section v-if="report?.month" class="card pad month">
          <h2>{{ monthLabel(report.month.month) }}累計</h2>
          <div class="stats month-stats">
            <div class="stat">
              <span class="muted">營業額</span>
              <strong class="tabular">{{ money(report.month.revenue) }}</strong>
              <span class="muted small">營業 {{ report.month.openDays }} 天，平均每天 {{ money(Math.round(report.month.revenue / (report.month.openDays || 1))) }}</span>
            </div>
            <div class="stat">
              <span class="muted">結帳筆數</span>
              <strong class="tabular">{{ report.month.count }}</strong>
              <span class="muted small">其中外帶 {{ report.month.takeoutCount }} 筆，平均每筆 {{ money(Math.round(report.month.revenue / (report.month.count || 1))) }}</span>
            </div>
            <div class="stat">
              <span class="muted">折扣／免單</span>
              <strong class="tabular">−{{ money(report.month.discountTotal) }}</strong>
            </div>
          </div>
          <table v-if="report.month.topItems.length" class="items top">
            <thead>
              <tr><th>本月熱銷</th><th class="bar-col"></th><th class="num">份數</th><th class="num">金額</th></tr>
            </thead>
            <tbody>
              <tr v-for="i in report.month.topItems" :key="i.name">
                <td>{{ i.name }}</td>
                <td class="bar-col"><div class="hbar" :style="{ width: `${pct(i.qty, monthTopMax)}%` }" :title="`${i.name} ${i.qty} 份`"></div></td>
                <td class="num tabular">{{ i.qty }}</td>
                <td class="num tabular">{{ money(i.amount) }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section class="card pad">
          <h2>{{ isToday ? '今日' : '當日' }}熱銷</h2>
          <table class="items top">
            <thead>
              <tr><th>品名</th><th class="bar-col"></th><th class="num">份數</th><th class="num">金額</th></tr>
            </thead>
            <tbody>
              <tr v-for="i in report?.topItems || []" :key="i.name">
                <td>{{ i.name }}</td>
                <td class="bar-col"><div class="hbar" :style="{ width: `${pct(i.qty, topMax)}%` }" :title="`${i.name} ${i.qty} 份`"></div></td>
                <td class="num tabular">{{ i.qty }}</td>
                <td class="num tabular">{{ money(i.amount) }}</td>
              </tr>
              <tr v-if="!report?.topItems?.length">
                <td colspan="4" class="muted center">這天還沒有銷售紀錄</td>
              </tr>
            </tbody>
          </table>
        </section>
      </main>

      <!-- 列印用帳單 -->
      <div v-if="printTarget" class="print-only receipt">
        <h2>{{ billTitle(printTarget) }} 帳單</h2>
        <table>
          <tr v-for="o in printTarget.orders" :key="o.id">
            <td>{{ o.items.map(describeLine).join('、') }}</td>
            <td class="num">{{ money(o.total) }}</td>
          </tr>
          <template v-if="discountAmount(printTarget) > 0">
            <tr>
              <td>小計</td>
              <td class="num">{{ money(printTarget.subtotal) }}</td>
            </tr>
            <tr>
              <td>折扣{{ discountOf(printTarget).reason ? `（${discountOf(printTarget).reason}）` : '' }}</td>
              <td class="num">−{{ money(discountAmount(printTarget)) }}</td>
            </tr>
          </template>
          <tr class="grand">
            <td>應收</td>
            <td class="num">{{ money(payable(printTarget)) }}</td>
          </tr>
        </table>
      </div>

      <div v-if="toast" class="toast no-print">{{ toast }}</div>
    </div>
  </StaffGate>
</template>

<style scoped>
.admin {
  min-height: 100vh;
  padding-bottom: 40px;
}
.bar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  padding: 14px 20px;
  background: var(--surface);
  border-bottom: 1px solid var(--line);
}
.bar nav {
  display: flex;
  gap: 8px;
  flex: 1;
  flex-wrap: wrap;
}
.bar nav button.on {
  background: var(--ink);
  border-color: var(--ink);
  color: #fff;
}
.wrap {
  max-width: 1080px;
  margin: 0 auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.pad {
  padding: 18px;
}
.row {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.row input {
  flex: 1;
  min-width: 140px;
}
.w-price {
  max-width: 120px;
  flex: none !important;
}
.add {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px dashed var(--line);
}
.cat-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.items {
  width: 100%;
  border-collapse: collapse;
}
.items th,
.items td {
  padding: 9px 8px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: middle;
}
.items th {
  font-size: 13px;
  color: var(--muted);
  font-weight: 600;
}
.num {
  text-align: right;
}
.center {
  text-align: center;
}
.desc {
  max-width: 260px;
}
tr.off td {
  opacity: 0.55;
}
.pic {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  border: 1px dashed var(--line);
  border-radius: 8px;
  cursor: pointer;
  font-size: 12px;
  overflow: hidden;
}
.pic img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.opt-tags {
  font-size: 12px;
  margin-top: 2px;
}
.pill {
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 13px;
  background: var(--ok-soft);
  color: var(--ok);
}
.pill.off {
  background: #f4eeee;
  color: #9b6a64;
}
.acts {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}
.acts button {
  padding: 6px 10px;
  font-size: 14px;
}
textarea {
  font-family: ui-monospace, 'Cascadia Code', monospace;
  margin: 10px 0;
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
}
.check input {
  width: auto;
}
code {
  background: #f1ece4;
  padding: 1px 6px;
  border-radius: 5px;
}
.qr-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 16px;
}
.qr-card {
  margin: 0;
  padding: 14px;
  text-align: center;
  break-inside: avoid;
}
.qr-card img {
  width: 100%;
  aspect-ratio: 1;
}
.qr-card figcaption {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 8px;
}
.qr-card strong {
  font-size: 20px;
}
.small {
  font-size: 13px;
}
.bill .total {
  font-size: 22px;
  color: var(--brand);
}
.bill.takeout {
  border-left: 5px solid var(--warn);
}
.takeout-pill {
  margin-left: 8px;
  background: var(--warn-soft);
  color: var(--warn);
  vertical-align: middle;
}
.takeout-qr {
  border: 2px dashed var(--warn);
}
.discount {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 12px;
  margin-bottom: 14px;
  background: var(--bg);
  border-radius: 10px;
}
.seg {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.seg button {
  padding: 7px 12px;
  font-size: 14px;
}
.seg button.on {
  background: var(--ink);
  border-color: var(--ink);
  color: #fff;
}
.seg button.free.on {
  background: #b3261e;
  border-color: #b3261e;
}
.disc-field {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}
.disc-field input {
  width: 150px;
}
.disc-field.grow {
  flex: 1;
  min-width: 200px;
}
.disc-field.grow input {
  width: 100%;
}
.disc-sum {
  width: 100%;
  font-size: 15px;
}
.disc-sum strong {
  color: var(--brand);
  font-size: 17px;
}
.pin-form {
  flex: 1;
  justify-content: flex-end;
}
.pin-form input {
  max-width: 160px;
}
.warn-text {
  color: #b3261e;
}
.lines {
  list-style: none;
  margin: 0 0 14px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.lines li {
  display: grid;
  grid-template-columns: 80px 1fr auto;
  gap: 12px;
}
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
}
.stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.stat strong {
  font-size: 30px;
}
/* 付款按鈕用各家品牌色，店員一眼分得出來 */
.pay-line {
  background: #06c755;
  border-color: #06c755;
}
.pay-apple {
  background: #000;
  border-color: #000;
}
.star-lg {
  color: #f5a623;
  font-size: 22px;
}
.fb-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 16px;
}
.fb header {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.fb header button {
  margin-left: auto;
}
.fb p {
  margin: 10px 0 0;
  white-space: pre-wrap;
}
.stars-ro {
  color: #f5a623;
  letter-spacing: 2px;
}
.pending {
  color: var(--brand);
}
.fb-reply-btn {
  margin-top: 12px;
}
.fb-reply-edit {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.fb-reply-edit textarea {
  width: 100%;
  resize: vertical;
}
.fb-reply {
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--brand-soft);
  border-left: 3px solid var(--brand);
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
.fb-reply strong {
  color: var(--brand);
  font-size: 14px;
}
.fb-reply p {
  margin: 4px 0 0;
}
.fb-photos {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.fb-photos img {
  width: 96px;
  height: 96px;
  object-fit: cover;
  border-radius: 8px;
  display: block;
}
.stars-ro .muted {
  color: var(--line);
}
/* ---- 報表圖表：純 CSS，不用圖表套件 ---- */
.report-head {
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.report-head h2 {
  margin: 0;
  flex: 1;
}
.report-head input {
  flex: 0 0 auto;
  min-width: 0;
}
.chart h2 {
  margin-bottom: 12px;
}
.chart + .chart,
.chart + section,
.stats + .chart {
  margin-top: 16px;
}
/* 100% 堆疊橫條：區段之間留 2px 底色縫，顏色相近也分得開 */
.share-bar {
  display: flex;
  gap: 2px;
  height: 28px;
  border-radius: 4px;
  overflow: hidden;
}
.share-bar > div {
  display: grid;
  place-items: center;
  min-width: 4px;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.legend {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
  font-size: 14px;
}
.legend i,
.dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
  margin-right: 6px;
  vertical-align: 0;
}
/* 時段直條圖 */
.hours {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 140px;
  border-bottom: 1px solid var(--line);
}
.hour {
  flex: 1;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  min-width: 0;
}
.hour .bar {
  width: 100%;
  max-width: 28px;
  background: var(--brand);
  border-radius: 4px 4px 0 0;
}
.hour .val {
  font-size: 12px;
  color: var(--muted);
  height: 14px;
}
/* 熱銷橫條 */
.top .bar-col {
  width: 40%;
}
.hbar {
  height: 10px;
  min-width: 4px;
  background: var(--brand);
  border-radius: 0 4px 4px 0;
}
/* 當日帳單明細：一張帳單一列，抬頭是桌號／時間／付款方式／金額，下面一行品項 */
.history {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.history li {
  padding: 10px 0;
  border-bottom: 1px solid var(--line);
}
.history li:last-child {
  border-bottom: 0;
}
.history-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.history-total {
  margin-left: auto;
}
.history-items {
  margin: 4px 0 0;
}
.pay-tag {
  font-size: 12px;
  color: #fff;
  padding: 2px 8px;
  border-radius: 999px;
}
.month-stats {
  margin: 4px 0 16px;
}
.month-stats .stat strong {
  font-size: 24px;
}
.days tbody tr {
  cursor: pointer;
}
.days tbody tr:hover,
.days tbody tr.on {
  background: var(--brand-soft);
}
.pay-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 8px;
}
.pay-table td {
  padding: 8px 4px;
  border-top: 1px solid var(--line);
}
.backup {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.backup p {
  margin: 4px 0 0;
  max-width: 48ch;
}
.print-only {
  display: none;
}
@media print {
  .print-only {
    display: block;
  }
  .receipt {
    padding: 20px;
  }
  .receipt table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 12px;
  }
  .receipt td {
    padding: 6px 0;
    border-bottom: 1px solid #ddd;
  }
  .receipt .grand td {
    font-weight: 700;
    font-size: 18px;
    border-bottom: none;
  }
}
</style>
