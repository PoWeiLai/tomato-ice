<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, type Table } from '../api'
import { STORE, MAP_EMBED_URL, MAP_LINK } from '../store'

const tables = ref<Table[]>([])
onMounted(async () => {
  tables.value = await api.tables()
})
</script>

<template>
  <div class="home">
    <!-- 店門口照片完整呈現（4:3），店名壓在照片下緣 -->
    <div class="hero">
      <div class="hero-text">
        <h1>嚐香聚牛肉麵</h1>
        <p>客人掃桌上的 QRcode 即可點餐，訂單直接進廚房看板。</p>
      </div>
    </div>

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

    <!-- 店家位置：Google 地圖內嵌，地址在 src/store.ts 改 -->
    <section class="card map">
      <div class="map-head">
        <div>
          <h2>店家位置</h2>
          <p class="muted">{{ STORE.address || STORE.name }}<span v-if="STORE.phone">　{{ STORE.phone }}</span></p>
          <p v-if="STORE.hours" class="muted small">營業時間 {{ STORE.hours }}</p>
        </div>
        <a class="btn-primary nav" :href="MAP_LINK" target="_blank" rel="noopener">導航</a>
      </div>
      <iframe
        :src="MAP_EMBED_URL"
        :title="`${STORE.name} 地圖`"
        loading="lazy"
        referrerpolicy="no-referrer-when-downgrade"
        allowfullscreen
      ></iframe>
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
}
.home > * {
  max-width: 720px;
  margin-left: auto;
  margin-right: auto;
}
.hero {
  position: relative;
  aspect-ratio: 4 / 3; /* 跟照片同比例，才不會裁掉招牌 */
  border-radius: var(--radius);
  overflow: hidden;
  box-shadow: var(--shadow);
  background: url('/images/嚐香聚.jpg') center / cover no-repeat;
}
.hero-text {
  position: absolute;
  inset: auto 0 0;
  padding: 48px 20px 18px;
  background: linear-gradient(180deg, transparent, rgba(31, 27, 22, 0.8));
  color: #fff;
  text-shadow: 0 2px 12px rgba(0, 0, 0, 0.6);
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
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
  margin: 40px auto;
}
.tile {
  padding: 20px;
  text-decoration: none;
  color: inherit;
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
  overflow: hidden;
  margin-bottom: 32px;
}
.map-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 20px;
}
.map-head h2 {
  margin: 0 0 4px;
  font-size: 18px;
}
.map-head p {
  margin: 0;
}
.map .nav {
  flex: 0 0 auto;
  padding: 10px 18px;
  border-radius: 999px;
  text-decoration: none;
}
.map iframe {
  display: block;
  width: 100%;
  height: 260px;
  border: 0;
  border-top: 1px solid var(--line);
}
.sub {
  font-size: 18px;
  margin-bottom: 12px;
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
  color: inherit;
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
