<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { api } from './api'

// 試用期間一直提醒到期日，不要讓店家毫無預警被關掉。
// 只在廚房看板／後台顯示，客人的點餐頁不出現。
const route = useRoute()
const isStaffPage = computed(() => route.path === '/kitchen' || route.path === '/admin')
const trialEnd = ref('')
const daysLeft = ref<number | null>(null)

onMounted(async () => {
  try {
    const { trial } = await api.health()
    if (trial.unlimited || trial.expired) return
    trialEnd.value = trial.end
    daysLeft.value = trial.daysLeft
  } catch {
    // 提醒拿不到就算了，不影響做生意
  }
})
</script>

<template>
  <div v-if="daysLeft !== null && isStaffPage" class="trial-note">
    試用期 {{ trialEnd }} 結束 ——
    {{ daysLeft === 0 ? '今天是最後一天' : `還剩 ${daysLeft} 天` }}，之後系統會暫停，請聯絡系統提供者
  </div>
  <RouterView />
</template>

<style scoped>
.trial-note {
  padding: 8px 14px;
  background: #fff4e5;
  color: #8a4b00;
  border-bottom: 1px solid #f3d8ae;
  font-size: 0.9rem;
  font-weight: 600;
  text-align: center;
}
@media (prefers-color-scheme: dark) {
  .trial-note {
    background: #3a2a10;
    color: #ffd79a;
    border-bottom-color: #5a4318;
  }
}
</style>
