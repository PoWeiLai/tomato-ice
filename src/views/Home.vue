<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, type Table } from '../api'
import { PRESS, STORE } from '../store'
import StoreMap from '../components/StoreMap.vue'
import PressCard from '../components/PressCard.vue'

const tables = ref<Table[]>([])
onMounted(async () => {
  tables.value = await api.tables()
})
</script>

<template>
  <div class="home">
    <!-- 門面照片完整呈現（4:3），店名壓在照片下緣，下方一條希臘回紋 -->
    <div class="hero">
      <div class="hero-text">
        <h1>{{ STORE.name }}</h1>
        <p>專注番茄牛肉麵・天然冰品・原汁飲品</p>
      </div>
    </div>
    <div class="meander hero-trim" aria-hidden="true"></div>
    <p class="lead muted">客人掃桌上的 QRcode 即可點餐，訂單直接進廚房看板。</p>

    <div class="cards">
      <RouterLink to="/takeout" class="card tile takeout">
        <h2>外帶點餐</h2>
        <p class="muted">櫃檯或電話外帶都從這裡點，留稱呼即可</p>
      </RouterLink>
      <RouterLink to="/kitchen" class="card tile">
        <h2>廚房看板</h2>
        <p class="muted">即時收單、標記製作中與完成出餐</p>
      </RouterLink>
      <RouterLink to="/admin" class="card tile">
        <h2>後台管理</h2>
        <p class="muted">改菜單、列印 QRcode、結帳與今日報表</p>
      </RouterLink>
    </div>

    <!-- 店家位置：地址在 src/store.ts 改 -->
    <StoreMap class="map" />

    <!-- 部落格報導：文章清單在 src/store.ts 的 PRESS 改 -->
    <section v-if="PRESS.length" class="press">
      <h2 class="sub">媒體報導</h2>
      <PressCard v-for="p in PRESS" :key="p.url" v-bind="p" />
    </section>

    <h2 class="sub">各桌點餐頁（測試用）</h2>
    <div class="tables">
      <RouterLink v-for="t in tables" :key="t.id" :to="`/t/${t.id}`" class="card table">
        {{ t.id }}
      </RouterLink>
    </div>
  </div>
</template>

<style scoped>
.home {
  min-height: 100vh;
  padding: 24px 20px 64px;
  /* 白牆配天空：上白下淡藍 */
  background: linear-gradient(180deg, #ffffff 0%, var(--bg) 40%);
}
.home > * {
  max-width: 720px;
  margin-left: auto;
  margin-right: auto;
}
.hero {
  position: relative;
  aspect-ratio: 4 / 3; /* 跟門面照同比例，才不會裁掉招牌 */
  border-radius: var(--radius) var(--radius) 0 0;
  overflow: hidden;
  box-shadow: var(--shadow);
  background: url('/images/門面.jpg') center / cover no-repeat;
  border: 3px solid #fff;
  border-bottom: 0;
}
.hero-text {
  position: absolute;
  inset: auto 0 0;
  padding: 48px 20px 18px;
  background: linear-gradient(180deg, transparent, rgba(18, 70, 138, 0.85));
  color: #fff;
  text-shadow: 0 2px 12px rgba(0, 0, 0, 0.5);
}
.hero h1 {
  margin: 0;
  font-size: 34px;
  letter-spacing: 3px;
}
.hero p {
  margin: 8px 0 0;
  opacity: 0.92;
}
.hero-trim {
  background-color: #fff;
  border: 3px solid #fff;
  border-top: 0;
  border-radius: 0 0 var(--radius) var(--radius);
  box-shadow: var(--shadow);
  height: 18px;
}
.lead {
  margin: 16px 0 0;
  text-align: center;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
  margin: 28px auto 40px;
}
.tile {
  padding: 20px;
  text-decoration: none;
  color: inherit;
  border-top: 4px solid var(--brand);
}
.tile p {
  margin: 6px 0 0;
}
.tile.takeout {
  border-color: var(--brand);
  box-shadow: 0 0 0 2px var(--brand-soft), var(--shadow);
}
.tile.takeout h2 {
  color: var(--brand);
}
.map {
  margin-bottom: 32px;
}
.sub {
  font-size: 18px;
  margin-bottom: 12px;
  color: var(--brand-dark);
}
.press {
  margin-bottom: 32px;
}
.tables {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
  gap: 10px;
}
.table {
  display: grid;
  place-items: center;
  aspect-ratio: 1;
  font-size: 22px;
  font-weight: 700;
  text-decoration: none;
  color: var(--brand);
}
@media (max-width: 600px) {
  .home {
    padding-top: 12px;
  }
  .hero h1 {
    font-size: 26px;
  }
  .hero-text {
    padding: 36px 14px 12px;
  }
}
</style>
