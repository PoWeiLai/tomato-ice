<script setup lang="ts">
import { MAP_EMBED_URL, MAP_LINK, STORE } from '../store'
</script>

<!-- 店家位置：Google 地圖內嵌，地址在 src/store.ts 改 -->
<template>
  <section class="card map">
    <div class="map-head">
      <div>
        <h2>店家位置</h2>
        <p class="muted">{{ STORE.address || STORE.name }}</p>
        <!-- 手機點電話直接撥出，外帶客人叫餐方便 -->
        <p v-if="STORE.phone" class="muted">電話 <a :href="`tel:${STORE.phone.replace(/\D/g, '')}`" class="tel">{{ STORE.phone }}</a></p>
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
</template>

<style scoped>
.map {
  display: block; /* 點餐頁的 section 是 flex，這裡蓋掉才不會在標題和地圖間多出空隙 */
  overflow: hidden;
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
.map-head .tel {
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
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
</style>
