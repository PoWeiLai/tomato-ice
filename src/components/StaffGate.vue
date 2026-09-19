<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, clearPin, getPin, setPin } from '../api'

/** 解鎖後才通知父層載入資料——否則會在登入前就打 API 被擋 401 */
const emit = defineEmits<{ unlocked: [] }>()

const unlocked = ref(false)
const checking = ref(true)
const pin = ref('')
const error = ref('')
const busy = ref(false)

// 忘記密碼：輸入後台登記的老闆手機就能設新密碼
const mode = ref<'login' | 'reset'>('login')
const resetAvailable = ref<boolean | null>(null) // null = 還沒查
const phone = ref('')
const newPin = ref('')
const newPin2 = ref('')

function unlock() {
  unlocked.value = true
  emit('unlocked')
}

// 開頁時先驗證存起來的密碼，密碼被改過就退回登入畫面
onMounted(async () => {
  const saved = getPin()
  if (!saved) {
    checking.value = false
    return
  }
  try {
    await api.login(saved)
    unlock()
  } catch {
    clearPin()
  } finally {
    checking.value = false
  }
})

async function login() {
  busy.value = true
  error.value = ''
  try {
    await api.login(pin.value)
    setPin(pin.value)
    unlock()
  } catch (e) {
    clearPin()
    error.value = e instanceof Error ? e.message : '登入失敗'
  } finally {
    busy.value = false
  }
}

async function openReset() {
  mode.value = 'reset'
  error.value = ''
  if (resetAvailable.value === null) {
    try {
      resetAvailable.value = (await api.resetAvailable()).available
    } catch {
      resetAvailable.value = false
    }
  }
}

function backToLogin() {
  mode.value = 'login'
  error.value = ''
}

async function reset() {
  error.value = ''
  if (!/^\d{4,8}$/.test(newPin.value)) return (error.value = '新密碼必須是 4～8 位數字')
  if (newPin.value !== newPin2.value) return (error.value = '兩次輸入的新密碼不一樣')
  busy.value = true
  try {
    await api.resetPin(phone.value, newPin.value)
    setPin(newPin.value)
    unlock()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '重設失敗'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <slot v-if="unlocked" />
  <div v-else class="gate">
    <p v-if="checking" class="muted">檢查登入狀態…</p>
    <form v-else-if="mode === 'login'" class="card box" @submit.prevent="login">
      <h1>店員登入</h1>
      <p class="muted">此頁面提供廚房與後台使用，請輸入店員密碼。</p>
      <input v-model="pin" type="password" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="店員密碼（數字）" autofocus />
      <p v-if="error" class="err">{{ error }}</p>
      <button class="btn-primary" type="submit" :disabled="busy || !pin">
        {{ busy ? '驗證中…' : '登入' }}
      </button>
      <button class="link" type="button" @click="openReset">忘記密碼？</button>
    </form>
    <form v-else class="card box" @submit.prevent="reset">
      <h1>重設密碼</h1>
      <p v-if="resetAvailable === null" class="muted">檢查中…</p>
      <template v-else-if="resetAvailable">
        <p class="muted">輸入後台登記的老闆手機號碼，驗證後即可設定新密碼。</p>
        <input v-model="phone" type="tel" inputmode="numeric" autocomplete="tel" placeholder="老闆手機號碼" autofocus />
        <input v-model="newPin" type="password" inputmode="numeric" pattern="[0-9]*" autocomplete="new-password" placeholder="新密碼（4～8 位數字）" />
        <input v-model="newPin2" type="password" inputmode="numeric" pattern="[0-9]*" autocomplete="new-password" placeholder="再輸入一次新密碼" />
        <p v-if="error" class="err">{{ error }}</p>
        <button class="btn-primary" type="submit" :disabled="busy || !phone || !newPin || !newPin2">
          {{ busy ? '驗證中…' : '設定新密碼並登入' }}
        </button>
      </template>
      <p v-else class="muted">
        尚未登記老闆手機，無法自助重設。請用原本的密碼登入後台，到「今日報表」→「老闆手機」登記；
        或聯絡系統提供者協助重設。
      </p>
      <button class="link" type="button" @click="backToLogin">返回登入</button>
    </form>
  </div>
</template>

<style scoped>
.gate {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
}
.box {
  width: min(360px, 100%);
  padding: 28px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.err {
  margin: 0;
  color: #b3261e;
}
.link {
  background: none;
  border: 0;
  padding: 4px;
  color: var(--brand);
  text-decoration: underline;
  cursor: pointer;
  font-size: 14px;
}
</style>
