<template>
  <span class="flex items-center gap-2 font-display font-semibold text-highlighted tracking-tight">
    <!-- Teacup + spill mark. Cup uses currentColor (adapts light/dark);
         the spilled tea + steam use the primary "tea" token. -->
    <svg
      viewBox="0 0 40 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      class="h-[1.15em] w-auto shrink-0"
    >
      <!-- steam -->
      <path
        d="M15 3.5c1.4 1.3 1.4 2.7 0 4M20 2.5c1.4 1.3 1.4 2.7 0 4"
        stroke="var(--ui-primary)"
        stroke-width="1.6"
        stroke-linecap="round"
        opacity="0.7"
      />
      <!-- cup bowl -->
      <path
        d="M8 11h16v3.5A8 8 0 0 1 16 22.5 8 8 0 0 1 8 14.5V11Z"
        fill="currentColor"
      />
      <!-- tea surface -->
      <ellipse
        cx="16"
        cy="11"
        rx="8"
        ry="1.8"
        fill="var(--ui-primary)"
      />
      <!-- handle -->
      <path
        d="M24 12.5h2.5a4 4 0 0 1 0 8H25"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        fill="none"
      />
      <!-- spilled tea puddle -->
      <path
        d="M5 27.5c4-1.7 8.5-.6 12 .2 3.6.8 7.6.6 10-1 .8 2.6-1.8 4.3-6 4.6-3.2.2-5.6-.7-8.6-.9-2.6-.2-5.2.5-6.9-.5-1-.6-1.6-1.6-1.5-2.4Z"
        fill="var(--ui-primary)"
      />
    </svg>
    <span>teaspill</span>
  </span>
</template>
