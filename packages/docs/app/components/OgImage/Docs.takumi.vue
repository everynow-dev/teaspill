<script setup lang="ts">
defineOptions({
  inheritAttrs: false
})

defineProps<{
  headline?: string
  title?: string
  description?: string
}>()
</script>

<template>
  <div
    class="w-full h-full flex bg-neutral-950 relative overflow-hidden"
    data-theme="dark"
  >
    <div class="absolute top-0 left-0 w-1.5 h-full bg-primary-400" />

    <div class="flex flex-col justify-between flex-1 px-20 py-16">
      <div />

      <div class="flex flex-col gap-5">
        <span
          v-if="headline"
          class="text-2xl font-medium text-primary-400"
        >
          {{ headline }}
        </span>

        <h1
          v-if="title"
          class="text-6xl font-bold text-highlighted"
        >
          {{ title }}
        </h1>

        <p
          v-if="description"
          class="text-3xl/11 text-muted"
          :style="{ lineClamp: 2, textOverflow: 'ellipsis' }"
        >
          {{ description }}
        </p>
      </div>

      <div class="flex items-center gap-4">
        <svg
          class="h-8 w-auto"
          viewBox="0 0 40 32"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M15 3.5c1.4 1.3 1.4 2.7 0 4M20 2.5c1.4 1.3 1.4 2.7 0 4"
            stroke="#DB8A54"
            stroke-width="1.6"
            stroke-linecap="round"
          />
          <path
            d="M8 11h16v3.5A8 8 0 0 1 16 22.5 8 8 0 0 1 8 14.5V11Z"
            fill="#FDF6EF"
          />
          <ellipse
            cx="16"
            cy="11"
            rx="8"
            ry="1.8"
            fill="#DB8A54"
          />
          <path
            d="M24 12.5h2.5a4 4 0 0 1 0 8H25"
            stroke="#FDF6EF"
            stroke-width="2"
            stroke-linecap="round"
            fill="none"
          />
          <path
            d="M5 27.5c4-1.7 8.5-.6 12 .2 3.6.8 7.6.6 10-1 .8 2.6-1.8 4.3-6 4.6-3.2.2-5.6-.7-8.6-.9-2.6-.2-5.2.5-6.9-.5-1-.6-1.6-1.6-1.5-2.4Z"
            fill="#DB8A54"
          />
        </svg>
        <div class="h-px flex-1 bg-border" />
        <span class="text-xl text-dimmed">teaspill</span>
      </div>
    </div>
  </div>
</template>
