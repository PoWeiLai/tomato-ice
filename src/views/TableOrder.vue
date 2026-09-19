<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import { api, money, subscribe, type Category, type MenuItem, type Feedback, type Order, type OptionChoice } from '../api'
import { PRESS, STORE } from '../store'
import StoreMap from '../components/StoreMap.vue'
import PressCard from '../components/PressCard.vue'

const props = defineProps<{ tableId?: string; takeout?: boolean }>()
/** 外帶沒有桌號，用 0 代表（伺服器端的保留桌） */
const tableNo = computed(() => (props.takeout ? 0 : Number(props.tableId)))

const categories = ref<Category[]>([])
const activeCat = ref<number | null>(null)
const myOrders = ref<Order[]>([])
const loading = ref(true)
const error = ref('')
const toast = ref('')
const view = ref<'menu' | 'orders'>('menu')
const cartOpen = ref(false)
const submitting = ref(false)

interface CartLine {
  key: string
  item: MenuItem
  choices: OptionChoice[]
  qty: number
  note: string
}
const cart = reactive<CartLine[]>([])

const unitPrice = (item: MenuItem, choices: OptionChoice[]) =>
  item.price + choices.reduce((s, c) => s + c.price_delta, 0)
const cartCount = computed(() => cart.reduce((s, l) => s + l.qty, 0))
const cartTotal = computed(() => cart.reduce((s, l) => s + unitPrice(l.item, l.choices) * l.qty, 0))
const orderedTotal = computed(() => myOrders.value.reduce((s, o) => s + o.total, 0))

const STATUS_TEXT: Record<string, string> = {
  pending: '已送出，等待廚房確認',
  preparing: '廚房製作中',
  done: '已完成出餐',
  cancelled: '已取消',
}
const statusText = (o: Order) =>
  o.kind === 'takeout' && o.status === 'done' ? '餐點好了，請到櫃檯取餐' : STATUS_TEXT[o.status]

/* ---------- 外帶：客人資料與自己的單 ---------- */
// 外帶客人沒有桌號可查，手機自己記住今天送出的訂單編號
const TAKEOUT_KEY = 'restaurant.takeoutOrders'
const CUSTOMER_KEY = 'restaurant.takeoutCustomer'
const customer = reactive<{ name: string; phone: string }>(
  JSON.parse(localStorage.getItem(CUSTOMER_KEY) || '{"name":"","phone":""}')
)
/** 台灣手機：09 開頭共 10 碼；客人打的空格、連字號先去掉 */
const PHONE_RE = /^09\d{8}$/
const cleanPhone = () => customer.phone.replace(/[\s-]/g, '')
const myTakeoutIds = (): number[] => JSON.parse(localStorage.getItem(TAKEOUT_KEY) || '[]')
const saveTakeoutIds = (ids: number[]) => localStorage.setItem(TAKEOUT_KEY, JSON.stringify(ids))

function say(msg: string) {
  toast.value = msg
  setTimeout(() => (toast.value = ''), 2600)
}

/* ---------- 選項挑選 ---------- */
const picking = ref<MenuItem | null>(null)
/** groupId -> 已選的 choiceId 陣列 */
const picked = reactive<Record<number, number[]>>({})
const pickNote = ref('')

function openPicker(item: MenuItem) {
  picking.value = item
  pickNote.value = ''
  for (const key of Object.keys(picked)) delete picked[Number(key)]
  for (const g of item.optionGroups) {
    // 非必選的群組預設帶第一個「不加價」選項，客人不用每次都點
    picked[g.id] = g.required ? [] : g.choices[0] ? [g.choices[0].id] : []
  }
}

function toggleChoice(groupId: number, choice: OptionChoice, mode: 'single' | 'multi') {
  const current = picked[groupId] || []
  if (mode === 'single') {
    picked[groupId] = current.includes(choice.id) ? [] : [choice.id]
  } else {
    picked[groupId] = current.includes(choice.id)
      ? current.filter((id) => id !== choice.id)
      : [...current, choice.id]
  }
}

const pickedChoices = computed<OptionChoice[]>(() => {
  if (!picking.value) return []
  return picking.value.optionGroups.flatMap((g) =>
    g.choices.filter((c) => (picked[g.id] || []).includes(c.id))
  )
})

const missingGroup = computed(() =>
  picking.value?.optionGroups.find((g) => g.required && (picked[g.id] || []).length === 0)
)

const pickerPrice = computed(() =>
  picking.value ? unitPrice(picking.value, pickedChoices.value) : 0
)

function confirmPick() {
  const item = picking.value
  if (!item) return
  if (missingGroup.value) return say(`請選擇「${missingGroup.value.name}」`)
  addToCart(item, pickedChoices.value, pickNote.value)
  picking.value = null
}

/* ---------- 購物車 ---------- */
function addToCart(item: MenuItem, choices: OptionChoice[], note: string) {
  // 同一道菜、相同選項與備註才併行；否則各自成一列
  const key = `${item.id}|${choices.map((c) => c.id).sort((a, b) => a - b).join(',')}|${note}`
  const found = cart.find((l) => l.key === key)
  if (found) found.qty++
  else cart.push({ key, item, choices, qty: 1, note })
  say(`已加入「${item.name}」`)
}

function quickAdd(item: MenuItem) {
  if (!item.available) return
  if (item.optionGroups.length) openPicker(item)
  else addToCart(item, [], '')
}

function setQty(line: CartLine, qty: number) {
  if (qty <= 0) cart.splice(cart.indexOf(line), 1)
  else line.qty = Math.min(99, qty)
}

/** 這道菜在購物車裡的總數量，顯示在菜單上 */
const countInCart = (itemId: number) =>
  cart.filter((l) => l.item.id === itemId).reduce((s, l) => s + l.qty, 0)

async function loadMenu() {
  categories.value = await api.menu()
  if (activeCat.value === null) activeCat.value = categories.value[0]?.id ?? null
}

async function loadOrders() {
  if (props.takeout) {
    // 已結帳（取餐付款）或取消的就不用再顯示，也從手機的記憶裡拿掉
    const found = await Promise.all(myTakeoutIds().map((id) => api.order(id).catch(() => null)))
    const live = found.filter((o): o is Order => !!o && !o.closed_at && o.status !== 'cancelled')
    saveTakeoutIds(live.map((o) => o.id))
    myOrders.value = live
    return
  }
  const data = await api.tableSession(tableNo.value)
  myOrders.value = data.orders
}

async function submit() {
  if (cart.length === 0) return
  if (props.takeout && !customer.name.trim()) return say('請留下稱呼，餐點好了才叫得到您')
  if (props.takeout && !PHONE_RE.test(cleanPhone())) return say('請輸入正確的手機號碼（09 開頭共 10 碼）')
  submitting.value = true
  try {
    const order = await api.placeOrder(
      tableNo.value,
      cart.map((l) => ({
        itemId: l.item.id,
        qty: l.qty,
        note: l.note,
        choiceIds: l.choices.map((c) => c.id),
      })),
      '',
      props.takeout ? { name: customer.name.trim(), phone: cleanPhone() } : undefined
    )
    if (props.takeout) {
      saveTakeoutIds([...myTakeoutIds(), order.id])
      localStorage.setItem(CUSTOMER_KEY, JSON.stringify({ name: customer.name.trim(), phone: cleanPhone() }))
    }
    cart.splice(0, cart.length)
    cartOpen.value = false
    await loadOrders()
    view.value = 'orders'
    say(props.takeout ? `外帶單已送出（第 ${order.id} 單），好了會叫您 🍜` : '訂單已送出，廚房已收到 🍜')
  } catch (e) {
    say(e instanceof Error ? e.message : '送出失敗，請再試一次')
  } finally {
    submitting.value = false
  }
}

/* ---------- 用餐心得 ---------- */
// 點過餐就可以留心得（在「已點餐點」分頁最下面）；用最後一張訂單綁定，同一次消費只能留一次
const FEEDBACK_KEY = 'restaurant.feedbackFor'
const feedbackOrderId = ref<number | null>(null)
const rating = ref(0)
const comment = ref('')
const feedbackSending = ref(false)
// 送出後的心得（含店家回覆）；結帳後訂單從畫面消失，這塊還是會留著
const myFeedback = ref<Feedback | null>(null)
async function loadMyFeedback() {
  const id = Number(localStorage.getItem(FEEDBACK_KEY))
  if (!id) return
  myFeedback.value = await api.myFeedback(id).catch(() => null)
}
loadMyFeedback()
/** 這次消費（同一個 session）已經留過就不再顯示表單；結帳後沒有訂單了，就以留過的為準 */
const currentSessionId = computed(() => myOrders.value[0]?.session_id ?? null)
const feedbackDone = computed(
  () => !!myFeedback.value && (currentSessionId.value === null || myFeedback.value.session_id === currentSessionId.value)
)
const canFeedback = computed(() => !!feedbackOrderId.value && !feedbackDone.value)
watch(myOrders, (list) => {
  const last = list[list.length - 1]
  if (last) feedbackOrderId.value = last.id
})

/** 客人拍的照片：先在手機上縮到 1280px、轉 JPEG，上傳才不會卡（原檔動輒 4～5MB） */
const MAX_PHOTOS = 3
const photos = ref<{ blob: Blob; url: string }[]>([])
async function shrink(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => null)
  if (!bitmap) return file // 瀏覽器讀不了（例如 HEIC）就原檔送，伺服器仍會檢查大小
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return new Promise((r) => canvas.toBlob((b) => r(b || file), 'image/jpeg', 0.82))
}
async function pickPhotos(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files || []).slice(0, MAX_PHOTOS - photos.value.length)
  input.value = '' // 同一張再選一次也要觸發 change
  if (!files.length) return say(`最多 ${MAX_PHOTOS} 張照片`)
  for (const f of files) {
    const blob = await shrink(f)
    photos.value.push({ blob, url: URL.createObjectURL(blob) })
  }
}
function removePhoto(i: number) {
  URL.revokeObjectURL(photos.value[i].url)
  photos.value.splice(i, 1)
}

async function sendFeedback() {
  if (!feedbackOrderId.value) return
  if (!rating.value) return say('請先點一下星星')
  feedbackSending.value = true
  try {
    await api.sendFeedback(
      feedbackOrderId.value,
      rating.value,
      comment.value.trim(),
      photos.value.map((p) => p.blob)
    )
    localStorage.setItem(FEEDBACK_KEY, String(feedbackOrderId.value))
    await loadMyFeedback()
    photos.value.forEach((p) => URL.revokeObjectURL(p.url))
    photos.value = []
    say('謝謝您的回饋 🙏')
  } catch (e) {
    say(e instanceof Error ? e.message : '送出失敗，請再試一次')
  } finally {
    feedbackSending.value = false
  }
}

watch(
  tableNo,
  async () => {
    loading.value = true
    error.value = ''
    try {
      await Promise.all([loadMenu(), loadOrders()])
    } catch (e) {
      error.value = e instanceof Error ? e.message : '載入失敗'
    } finally {
      loading.value = false
    }
  },
  { immediate: true }
)

const unsubscribe = subscribe({
  'order:update': (o: Order) => {
    if (o.table_id === tableNo.value) loadOrders()
  },
  'bill:closed': (b: { tableId: number; sessionId: number }) => {
    // 結帳後訂單會從畫面消失，但留心得的入口要繼續顯示
    if (props.takeout) {
      if (myOrders.value.some((o) => o.session_id === b.sessionId)) {
        loadOrders()
        say('已取餐結帳，謝謝惠顧！')
      }
    } else if (b.tableId === tableNo.value) {
      myOrders.value = []
      say('本桌已結帳，感謝光臨！')
    }
  },
  'menu:update': () => loadMenu(),
  // 店家回覆了我的心得，馬上顯示
  'feedback:reply': (d: { sessionId: number }) => {
    if (myFeedback.value && myFeedback.value.session_id === d.sessionId) {
      loadMyFeedback()
      say('店家回覆了您的心得 💬')
    }
  },
})
onUnmounted(unsubscribe)
</script>

<template>
  <div class="page">
    <!-- 門面照片當抬頭，跟店裡紙本菜單同一個版型 -->
    <div class="banner" role="img" aria-label="嚐香聚牛肉麵 門面">
      <div class="banner-text">
        <strong>嚐香聚牛肉麵</strong>
        <span>{{ takeout ? '外帶點餐' : `內用 ${tableNo} 號桌` }}</span>
      </div>
    </div>
    <header class="top">
      <div>
        <div class="muted small">{{ takeout ? '外帶' : '內用桌號' }}</div>
        <h1>{{ takeout ? '外帶點餐' : `${tableNo} 號桌` }}</h1>
      </div>
      <div class="switch">
        <button :class="{ on: view === 'menu' }" @click="view = 'menu'">菜單</button>
        <button :class="{ on: view === 'orders' }" @click="view = 'orders'">
          已點餐點<span v-if="myOrders.length" class="dot">{{ myOrders.length }}</span>
        </button>
      </div>
    </header>

    <p v-if="loading" class="state muted">菜單載入中…</p>
    <p v-else-if="error" class="state error">{{ error }}</p>

    <!-- 菜單 -->
    <template v-else-if="view === 'menu'">
      <nav class="cats">
        <button v-for="c in categories" :key="c.id" :class="{ on: activeCat === c.id }" @click="activeCat = c.id">
          {{ c.name }}
        </button>
      </nav>

      <main class="list">
        <template v-for="c in categories" :key="c.id">
          <section v-if="activeCat === c.id">
            <article v-for="item in c.items" :key="item.id" class="card item" :class="{ soldout: !item.available }">
              <img v-if="item.image" :src="item.image" :alt="item.name" class="thumb" />
              <div v-else class="thumb placeholder" aria-hidden="true">{{ item.name.slice(0, 2) }}</div>
              <div class="info">
                <h3>{{ item.name }}</h3>
                <p v-if="item.description" class="muted small">{{ item.description }}</p>
                <p v-if="item.optionGroups.length" class="muted small opts">
                  可選：{{ item.optionGroups.map((g) => g.name).join('、') }}
                </p>
                <div class="price tabular">{{ money(item.price) }}<span v-if="item.optionGroups.length" class="muted"> 起</span></div>
              </div>
              <div class="action">
                <span v-if="!item.available" class="tag">售完</span>
                <template v-else>
                  <span v-if="countInCart(item.id)" class="incart tabular">{{ countInCart(item.id) }}</span>
                  <button class="btn-primary" @click="quickAdd(item)">
                    {{ item.optionGroups.length ? '選擇' : '加入' }}
                  </button>
                </template>
              </div>
            </article>
            <p v-if="c.items.length === 0" class="state muted">此分類尚未有餐點</p>
          </section>
        </template>

        <!-- 部落格報導：文章清單在 src/store.ts 的 PRESS 改 -->
        <section v-if="PRESS.length" class="press">
          <h2 class="press-title">媒體報導</h2>
          <PressCard v-for="p in PRESS" :key="p.url" v-bind="p" />
        </section>

        <!-- 店家位置：內用、外帶都看得到，地址在 src/store.ts 改 -->
        <!-- 臉書粉專：網址在 src/store.ts 的 STORE.facebook 改 -->
        <a v-if="STORE.facebook" :href="STORE.facebook" target="_blank" rel="noopener" class="card fb press">
          <span class="fb-icon" aria-hidden="true">f</span>
          <span class="fb-text">
            <strong>吃得開心嗎？來粉專按個讚 💙</strong>
            <span class="muted small">新菜色、公休、優惠都在臉書搶先說，追蹤不漏接</span>
          </span>
          <span class="fb-go">去看看 ›</span>
        </a>

        <StoreMap class="press" />
      </main>
    </template>

    <!-- 已點餐點 -->
    <main v-else class="list">
      <p v-if="myOrders.length === 0" class="state muted">
        {{ takeout ? '還沒有外帶單，先去菜單點餐吧' : '本桌還沒有訂單，先去菜單點餐吧' }}
      </p>
      <p v-else-if="takeout" class="takeout-hint muted small">餐點完成後請到櫃檯報「第幾單」或稱呼取餐、付款（可用現金、刷卡、LINE Pay、Apple Pay）</p>
      <article v-for="o in myOrders" :key="o.id" class="card order">
        <header>
          <strong>第 {{ o.id }} 單<em v-if="o.kind === 'takeout'" class="muted who">・{{ o.customer }}</em></strong>
          <span class="status" :data-status="o.status">{{ statusText(o) }}</span>
        </header>
        <ul>
          <li v-for="i in o.items" :key="i.id">
            <span>
              {{ i.name }}
              <em v-if="i.options.length" class="muted opt-line">{{ i.options.map((o2) => o2.name).join('／') }}</em>
              <em v-if="i.note" class="muted opt-line">備註：{{ i.note }}</em>
            </span>
            <span class="tabular muted">×{{ i.qty }}</span>
            <span class="tabular">{{ money(i.price * i.qty) }}</span>
          </li>
        </ul>
        <footer class="tabular">小計 {{ money(o.total) }}</footer>
      </article>
      <div v-if="myOrders.length" class="card sum">
        <span>{{ takeout ? '外帶合計' : '本桌合計' }}</span><strong class="tabular">{{ money(orderedTotal) }}</strong>
      </div>

      <!-- 用餐心得：出餐後出現，送出一次就收起 -->
      <section v-if="canFeedback" class="card feedback">
        <h2>今天吃得還好嗎？</h2>
        <p class="muted small">給個星等、留幾句話，老闆會親自看</p>
        <div class="stars" role="radiogroup" aria-label="星等">
          <button
            v-for="n in 5"
            :key="n"
            type="button"
            :class="{ on: n <= rating }"
            :aria-label="`${n} 顆星`"
            @click="rating = n"
          >
            ★
          </button>
        </div>
        <textarea v-model="comment" rows="3" maxlength="300" placeholder="例：牛肉很嫩、湯頭可以再鹹一點…（選填）"></textarea>
        <!-- 拍照／選圖：手機會直接開相機或相簿 -->
        <div class="photos">
          <div v-for="(p, i) in photos" :key="p.url" class="thumb">
            <img :src="p.url" alt="" />
            <button type="button" aria-label="移除照片" @click="removePhoto(i)">✕</button>
          </div>
          <label v-if="photos.length < MAX_PHOTOS" class="thumb add">
            <input type="file" accept="image/*" multiple @change="pickPhotos" />
            <span>📷</span>
            <span class="small">拍照／選圖</span>
          </label>
        </div>
        <button class="btn-primary" :disabled="feedbackSending" @click="sendFeedback">
          {{ feedbackSending ? '送出中…' : '送出心得' }}
        </button>
      </section>
      <!-- 已留過：顯示自己的心得與店家回覆 -->
      <section v-else-if="feedbackDone && myFeedback" class="card feedback">
        <h2>您的心得</h2>
        <div class="stars-ro" :aria-label="`${myFeedback.rating} 顆星`">{{ '★'.repeat(myFeedback.rating) }}<span>{{ '★'.repeat(5 - myFeedback.rating) }}</span></div>
        <p v-if="myFeedback.comment" class="said">{{ myFeedback.comment }}</p>
        <div v-if="myFeedback.photos.length" class="photos">
          <div v-for="url in myFeedback.photos" :key="url" class="thumb"><img :src="url" alt="" /></div>
        </div>
        <div v-if="myFeedback.reply" class="reply">
          <strong>店家回覆</strong>
          <p>{{ myFeedback.reply }}</p>
        </div>
        <p v-else class="muted small">已收到您的回饋，謝謝！店家回覆後會顯示在這裡。</p>
      </section>
    </main>

    <!-- 選項挑選 -->
    <div v-if="picking" class="scrim" @click="picking = null"></div>
    <section v-if="picking" class="sheet">
      <header>
        <div>
          <h2>{{ picking.name }}</h2>
          <span class="muted small">{{ money(picking.price) }} 起</span>
        </div>
        <button @click="picking = null">關閉</button>
      </header>
      <div class="sheet-body">
        <fieldset v-for="g in picking.optionGroups" :key="g.id" class="group">
          <legend>
            {{ g.name }}
            <span class="req" :class="{ must: g.required }">{{ g.required ? '必選' : '選填' }}</span>
          </legend>
          <div class="choices">
            <button
              v-for="c in g.choices"
              :key="c.id"
              class="choice"
              :class="{ on: (picked[g.id] || []).includes(c.id) }"
              @click="toggleChoice(g.id, c, g.mode)"
            >
              {{ c.name }}
              <span v-if="c.price_delta" class="delta tabular">+{{ c.price_delta }}</span>
            </button>
          </div>
        </fieldset>
        <label class="note-field">
          <span class="muted small">備註（例：不要辣、麵少一點）</span>
          <input v-model="pickNote" placeholder="可不填" />
        </label>
      </div>
      <footer class="sheet-foot">
        <div class="tabular">單價 <strong>{{ money(pickerPrice) }}</strong></div>
        <button class="btn-primary big" @click="confirmPick">加入購物車</button>
      </footer>
    </section>

    <!-- 購物車 -->
    <div v-if="cartOpen" class="scrim" @click="cartOpen = false"></div>
    <section v-if="cartOpen" class="sheet">
      <header>
        <h2>購物車</h2>
        <button @click="cartOpen = false">關閉</button>
      </header>
      <div class="sheet-body">
        <div v-for="l in cart" :key="l.key" class="line">
          <div class="line-top">
            <div>
              <strong>{{ l.item.name }}</strong>
              <div v-if="l.choices.length" class="muted small">{{ l.choices.map((c) => c.name).join('／') }}</div>
              <div v-if="l.note" class="muted small">備註：{{ l.note }}</div>
            </div>
            <span class="tabular">{{ money(unitPrice(l.item, l.choices) * l.qty) }}</span>
          </div>
          <div class="stepper">
            <button @click="setQty(l, l.qty - 1)">−</button>
            <span class="tabular">{{ l.qty }}</span>
            <button @click="setQty(l, l.qty + 1)">＋</button>
          </div>
        </div>
        <div v-if="takeout" class="customer">
          <label class="note-field">
            <span class="muted small">稱呼（必填，好了要叫您）</span>
            <input v-model="customer.name" placeholder="例：王小姐、阿明" autocomplete="name" />
          </label>
          <label class="note-field">
            <span class="muted small">手機（必填，餐點有問題才聯絡得到）</span>
            <input v-model="customer.phone" type="tel" inputmode="numeric" placeholder="09xxxxxxxx" maxlength="12" autocomplete="tel" />
          </label>
        </div>
      </div>
      <footer class="sheet-foot">
        <div class="tabular">合計 <strong>{{ money(cartTotal) }}</strong></div>
        <button class="btn-primary big" :disabled="submitting" @click="submit">
          {{ submitting ? '送出中…' : '送出訂單' }}
        </button>
      </footer>
    </section>

    <button v-if="cartCount && !cartOpen && !picking" class="cartbar btn-primary" @click="cartOpen = true">
      <span class="badge tabular">{{ cartCount }}</span>
      <span>查看購物車</span>
      <span class="tabular">{{ money(cartTotal) }}</span>
    </button>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>

<style scoped>
/* 配色取自店裡的紙本菜單：橘色漸層底、紅字標題、門面照片抬頭 */
.page {
  --paper-top: #f7d2ad;
  --paper-bottom: #f0a96f;
  --menu-red: #b3261e;
  max-width: 640px;
  margin: 0 auto;
  padding-bottom: 96px;
  min-height: 100%;
  background: linear-gradient(180deg, var(--paper-top), var(--paper-bottom));
}
.banner {
  aspect-ratio: 4 / 3; /* 跟照片同比例，完整顯示店門口 */
  background: url('/images/嚐香聚.jpg') center / cover no-repeat;
  position: relative;
}
.banner-text {
  position: absolute;
  inset: auto 0 0;
  padding: 28px 16px 12px;
  background: linear-gradient(180deg, transparent, rgba(31, 27, 22, 0.75));
  color: #fff;
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.banner-text strong {
  font-size: 22px;
  letter-spacing: 2px;
}
.banner-text span {
  font-size: 14px;
  opacity: 0.9;
}
.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px;
  background: rgba(255, 250, 244, 0.92);
  backdrop-filter: blur(6px);
  border-bottom: 1px solid rgba(179, 38, 30, 0.18);
  position: sticky;
  top: 0;
  z-index: 20;
}
.top h1 {
  color: var(--menu-red);
}
.small {
  font-size: 13px;
}
.switch {
  display: flex;
  gap: 6px;
}
.switch button.on {
  background: var(--brand-soft);
  border-color: var(--brand);
  color: var(--brand-dark);
  font-weight: 600;
}
.dot {
  display: inline-block;
  min-width: 20px;
  margin-left: 6px;
  padding: 0 5px;
  background: var(--brand);
  color: #fff;
  border-radius: 999px;
  font-size: 12px;
}
.cats {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding: 12px 16px;
  position: sticky;
  top: 73px;
  background: var(--paper-top);
  z-index: 10;
  scrollbar-width: none;
}
.cats button {
  background: rgba(255, 255, 255, 0.7);
  border-color: rgba(179, 38, 30, 0.25);
  color: var(--menu-red);
  font-weight: 600;
}
.cats::-webkit-scrollbar {
  display: none;
}
.cats button {
  white-space: nowrap;
}
.cats button.on {
  background: var(--menu-red);
  border-color: var(--menu-red);
  color: #fff;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 16px 16px;
}
.list section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.press {
  margin-top: 12px;
  gap: 8px;
}
.press-title {
  margin: 0;
  font-size: 15px;
  color: var(--menu-red);
}
/* 臉書卡片：藍色圓形 f 當圖示，整張可點 */
.fb {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  text-decoration: none;
  color: inherit;
  border-color: #1877f2;
  box-shadow: 0 0 0 2px rgba(24, 119, 242, 0.15), var(--shadow);
}
.fb-icon {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: #1877f2;
  color: #fff;
  font-family: Georgia, "Times New Roman", serif;
  font-size: 26px;
  font-weight: 700;
  line-height: 1;
  padding-top: 4px; /* 字母 f 視覺置中 */
}
.fb-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.fb-text strong {
  font-size: 15px;
  line-height: 1.4;
}
.fb-go {
  flex: 0 0 auto;
  font-size: 13px;
  font-weight: 600;
  color: #1877f2;
}
.item {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 12px;
}
.item.soldout {
  opacity: 0.55;
}
.thumb {
  width: 76px;
  height: 76px;
  border-radius: 10px;
  object-fit: cover;
  flex: none;
}
/* 還沒拍照的品項：用品名前兩字做字卡，不留空白 */
.placeholder {
  display: grid;
  place-items: center;
  background: linear-gradient(140deg, var(--brand-soft), #f6e3d8);
  color: var(--brand-dark);
  font-weight: 700;
  font-size: 22px;
  letter-spacing: 1px;
}
.info {
  flex: 1;
  min-width: 0;
}
.opts {
  margin: 2px 0 0;
}
.price {
  margin-top: 4px;
  font-weight: 700;
  color: var(--brand);
}
.action {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
}
.incart {
  min-width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  background: var(--brand-soft);
  color: var(--brand-dark);
  font-weight: 700;
  font-size: 14px;
}
.tag {
  padding: 6px 10px;
  border-radius: 999px;
  background: #f1ece4;
  color: var(--muted);
  font-size: 13px;
}
.stepper {
  display: flex;
  align-items: center;
  gap: 4px;
}
.stepper button {
  width: 36px;
  height: 36px;
  padding: 0;
  font-size: 18px;
  line-height: 1;
}
.stepper span {
  min-width: 28px;
  text-align: center;
  font-weight: 600;
}
.state {
  padding: 40px 16px;
  text-align: center;
}
.error {
  color: #b3261e;
}
.order {
  padding: 14px;
}
.order header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.status {
  font-size: 13px;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--warn-soft);
  color: var(--warn);
}
.status[data-status='done'] {
  background: var(--ok-soft);
  color: var(--ok);
}
.order ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.order li {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 12px;
  align-items: start;
}
.opt-line {
  display: block;
  font-style: normal;
  font-size: 13px;
}
.who {
  font-style: normal;
  font-weight: 400;
  font-size: 14px;
}
.takeout-hint {
  margin: 0;
  padding: 4px 4px 0;
}
.customer {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 14px;
  border-top: 1px dashed var(--line);
}
.order footer {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--line);
  text-align: right;
  font-weight: 600;
}
.sum {
  display: flex;
  justify-content: space-between;
  padding: 14px;
  font-size: 18px;
}
.feedback {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
}
.feedback h2 {
  margin: 0;
  font-size: 18px;
}
.feedback p {
  margin: -4px 0 0;
}
.feedback textarea {
  width: 100%;
  resize: vertical;
}
.stars {
  display: flex;
  gap: 4px;
}
.stars button {
  flex: 1;
  padding: 6px 0;
  font-size: 30px;
  line-height: 1;
  color: var(--line);
  background: none;
  border: none;
}
.stars button.on {
  color: #f5a623;
}
.stars-ro {
  color: #f5a623;
  font-size: 22px;
  letter-spacing: 2px;
}
.stars-ro span {
  color: var(--line);
}
.feedback .said {
  margin: 0;
  white-space: pre-wrap;
}
.reply {
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--brand-soft);
  border-left: 3px solid var(--brand);
}
.reply strong {
  color: var(--brand);
  font-size: 14px;
}
.reply p {
  margin: 4px 0 0;
  white-space: pre-wrap;
}
.photos {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.thumb {
  position: relative;
  width: 84px;
  height: 84px;
  border-radius: 10px;
  overflow: hidden;
  background: var(--bg);
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.thumb > button {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 12px;
  line-height: 24px;
}
.thumb.add {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border: 1px dashed var(--line);
  color: var(--muted);
  font-size: 22px;
  cursor: pointer;
}
.thumb.add input {
  display: none;
}
.cartbar {
  position: fixed;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  width: min(608px, calc(100vw - 32px));
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  font-size: 17px;
  z-index: 30;
  box-shadow: var(--shadow);
}
.cartbar span:nth-child(2) {
  flex: 1;
  text-align: left;
}
.badge {
  background: #fff;
  color: var(--brand);
  border-radius: 999px;
  min-width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  font-weight: 700;
  font-size: 14px;
}
.scrim {
  position: fixed;
  inset: 0;
  background: rgba(31, 27, 22, 0.4);
  z-index: 40;
}
.sheet {
  position: fixed;
  left: 50%;
  bottom: 0;
  transform: translateX(-50%);
  width: min(640px, 100vw);
  max-height: 86vh;
  background: var(--surface);
  border-radius: 18px 18px 0 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
}
.sheet > header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 16px;
  border-bottom: 1px solid var(--line);
}
.sheet-body {
  overflow-y: auto;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.group {
  border: none;
  padding: 0;
  margin: 0;
}
.group legend {
  padding: 0 0 8px;
  font-weight: 600;
}
.req {
  margin-left: 6px;
  font-size: 12px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 999px;
  background: #f1ece4;
  color: var(--muted);
}
.req.must {
  background: var(--brand-soft);
  color: var(--brand-dark);
}
.choices {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.choice {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}
.choice.on {
  background: var(--brand-soft);
  border-color: var(--brand);
  color: var(--brand-dark);
  font-weight: 600;
}
.delta {
  font-size: 13px;
  color: var(--brand);
}
.note-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.line-top {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}
.sheet-foot {
  padding: 14px 16px calc(14px + env(safe-area-inset-bottom));
  border-top: 1px solid var(--line);
  display: flex;
  align-items: center;
  gap: 14px;
}
.sheet-foot div {
  flex: 1;
  font-size: 18px;
}
.big {
  padding: 14px 28px;
  font-size: 17px;
}
</style>
