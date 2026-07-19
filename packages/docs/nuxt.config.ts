// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/image',
    '@nuxt/ui',
    '@nuxt/content',
    'nuxt-og-image',
    'nuxt-llms',
    '@nuxtjs/mcp-toolkit'
  ],

  devtools: {
    enabled: true
  },

  app: {
    head: {
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }
      ]
    }
  },

  css: ['~/assets/css/main.css'],

  content: {
    build: {
      markdown: {
        toc: {
          searchDepth: 1
        }
      }
    },
    experimental: {
      sqliteConnector: 'native'
    }
  },

  experimental: {
    asyncContext: true
  },

  compatibilityDate: '2026-06-30',

  nitro: {
    prerender: {
      routes: [
        '/'
      ],
      crawlLinks: true,
      // The site is authored in waves: earlier pages legitimately link forward
      // to pages that land in a later wave, so a mid-build crawl hits 404s for
      // routes that do not exist yet. Don't fail the whole build on those — the
      // 404s stay visible in the generate log, and the acceptance QA runs a
      // dedicated internal-link check once every page exists.
      failOnError: false
    }
  },

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  },

  // @nuxt/fonts is auto-registered by Nuxt UI v4; this key configures it.
  // Explicit weights make the provisioned webfonts deterministic across builds.
  fonts: {
    families: [
      { name: 'Fraunces', provider: 'google', weights: [400, 500, 600, 700], styles: ['normal', 'italic'] },
      { name: 'Public Sans', provider: 'google', weights: [400, 500, 600, 700] },
      { name: 'JetBrains Mono', provider: 'google', weights: [400, 500, 600] }
    ]
  },

  llms: {
    domain: 'https://teaspill.everynow.dev',
    title: 'teaspill',
    description: 'Durable AI agents that survive restarts, spawn sub-agents, and stream everything to your UI. Self-hosted, open-source.',
    full: {
      title: 'teaspill — full documentation',
      description: 'The complete teaspill documentation: getting started, concepts, guides, reference, and contributing.'
    },
    sections: [
      {
        title: 'Getting Started',
        contentCollection: 'docs',
        contentFilters: [
          { field: 'path', operator: 'LIKE', value: '/getting-started%' }
        ]
      },
      {
        title: 'Concepts',
        contentCollection: 'docs',
        contentFilters: [
          { field: 'path', operator: 'LIKE', value: '/concepts%' }
        ]
      },
      {
        title: 'Guides',
        contentCollection: 'docs',
        contentFilters: [
          { field: 'path', operator: 'LIKE', value: '/guides%' }
        ]
      },
      {
        title: 'Reference',
        contentCollection: 'docs',
        contentFilters: [
          { field: 'path', operator: 'LIKE', value: '/reference%' }
        ]
      },
      {
        title: 'Contributing',
        contentCollection: 'docs',
        contentFilters: [
          { field: 'path', operator: 'LIKE', value: '/contributing%' }
        ]
      }
    ]
  },

  mcp: {
    name: 'teaspill docs'
  },

  ogImage: {
    zeroRuntime: true
  }
})
