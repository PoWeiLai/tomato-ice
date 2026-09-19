<script setup lang="ts">
import { computed, ref } from 'vue'
import { youtubeId } from '../store'

const props = defineProps<{
  source: string
  title: string
  summary?: string
  url: string
  video?: string
}>()

const vid = computed(() => youtubeId(props.video ?? ''))
// 先只放縮圖（不載 YouTube 播放器，省客人流量），點了才換成自動播放的 iframe
const playing = ref(false)
const thumb = computed(() => `https://i.ytimg.com/vi/${vid.value}/hqdefault.jpg`)
const embed = computed(
  () => `https://www.youtube-nocookie.com/embed/${vid.value}?autoplay=1&playsinline=1&rel=0&hl=zh-TW`,
)
</script>

<template>
  <!-- 有影片：卡片上方是播放區，下方標題點了才去部落格 -->
  <article v-if="vid" class="card press-card">
    <div class="video">
      <iframe
        v-if="playing"
        :src="embed"
        :title="title"
        allow="autoplay; encrypted-media; picture-in-picture"
        allowfullscreen
      ></iframe>
      <button v-else type="button" class="poster" :aria-label="`播放影片：${title}`" @click="playing = true">
        <img :src="thumb" alt="" loading="lazy" />
        <span class="play"></span>
      </button>
    </div>
    <a :href="url" target="_blank" rel="noopener" class="press-link">
      <span class="muted small">{{ source }}</span>
      <strong>{{ title }}</strong>
      <span v-if="summary" class="muted small">{{ summary }}</span>
      <span class="press-more">看全文 ›</span>
    </a>
  </article>

  <!-- 沒影片：整張卡片就是連結 -->
  <a v-else :href="url" target="_blank" rel="noopener" class="card press-link">
    <span class="muted small">{{ source }}</span>
    <strong>{{ title }}</strong>
    <span v-if="summary" class="muted small">{{ summary }}</span>
    <span class="press-more">看全文 ›</span>
  </a>
</template>

<style scoped>
.press-card {
  overflow: hidden;
  padding: 0;
}
.video {
  position: relative;
  aspect-ratio: 16 / 9;
  background: #000;
}
.video iframe,
.poster,
.poster img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: 0;
}
.poster {
  padding: 0;
  background: none;
  cursor: pointer;
}
.poster img {
  object-fit: cover;
}
/* 紅底白三角的播放鍵，跟 YouTube 長得像，客人一看就知道能點 */
.play {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 64px;
  height: 44px;
  transform: translate(-50%, -50%);
  border-radius: 12px;
  background: #f00;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}
.play::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 55%;
  transform: translate(-50%, -50%);
  border-style: solid;
  border-width: 10px 0 10px 18px;
  border-color: transparent transparent transparent #fff;
}
.press-link {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 16px;
  text-decoration: none;
  color: inherit;
}
.press-link strong {
  font-size: 15px;
  line-height: 1.4;
}
.press-more {
  margin-top: 4px;
  font-size: 13px;
  font-weight: 600;
  color: var(--brand);
}
</style>
