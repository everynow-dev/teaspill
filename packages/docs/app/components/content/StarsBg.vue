<script setup lang="ts">
// On-brand replacement for the template's twinkling-stars motif: soft warm
// "steam" wisps rising through a steeped-tea glow. Props are kept (and optional)
// so existing `:stars-bg` usages in content keep working; `color` re-tints.
withDefaults(defineProps<{
  color?: string
  speed?: 'slow' | 'normal' | 'fast'
}>(), {
  color: 'var(--ui-primary)',
  speed: 'normal'
})

const durationMap = {
  slow: '26s',
  normal: '18s',
  fast: '12s'
}
</script>

<template>
  <div class="steam-bg absolute pointer-events-none z-[-1] inset-y-0 inset-x-5 sm:inset-x-7 lg:inset-x-9 overflow-hidden">
    <!-- steeped-tea glow anchored at the top -->
    <div
      class="glow absolute inset-x-0 top-0 h-2/3"
      :style="{ '--tea-color': color }"
    />

    <!-- rising steam wisps -->
    <div
      class="wisps size-full absolute inset-0"
      :style="{ '--tea-color': color, '--wisp-duration': durationMap[speed] }"
    >
      <span
        v-for="i in 5"
        :key="i"
        class="wisp"
        :style="{
          left: `${12 + i * 15}%`,
          animationDelay: `${i * -3.5}s`,
          opacity: 0.06 + (i % 3) * 0.03
        }"
      />
    </div>
  </div>
</template>

<style scoped>
.glow {
  background: radial-gradient(60% 90% at 50% 0%, var(--tea-color) 0%, transparent 70%);
  opacity: 0.12;
}

.wisps {
  -webkit-mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0) 0%, #000 30%, #000 60%, rgba(0, 0, 0, 0) 100%);
  mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0) 0%, #000 30%, #000 60%, rgba(0, 0, 0, 0) 100%);
}

.wisp {
  position: absolute;
  bottom: -20%;
  width: 8rem;
  height: 60%;
  background: radial-gradient(closest-side, var(--tea-color) 0%, transparent 80%);
  filter: blur(24px);
  border-radius: 9999px;
  animation: rising var(--wisp-duration) linear infinite;
  will-change: transform, opacity;
}

@keyframes rising {
  0% {
    transform: translateY(20%) scale(0.9);
  }
  100% {
    transform: translateY(-120%) scale(1.15);
  }
}

@media (prefers-reduced-motion: reduce) {
  .wisp {
    animation: none;
  }
}
</style>
