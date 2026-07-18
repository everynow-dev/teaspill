import { defineContentConfig, defineCollection, z } from '@nuxt/content'

export default defineContentConfig({
  collections: {
    landing: defineCollection({
      type: 'page',
      source: 'index.md'
    }),
    docs: defineCollection({
      type: 'page',
      source: {
        include: '**',
        // Exclude the landing page and the changelog collection so changelog
        // entries never leak into the docs sidebar nav or the ⌘K search index
        // (both are built from the `docs` collection — see app/app.vue).
        exclude: ['index.md', 'changelog/**']
      },
      schema: z.object({
        links: z.array(z.object({
          label: z.string(),
          icon: z.string(),
          to: z.string(),
          target: z.string().optional()
        })).optional()
      })
    }),
    // Content-driven changelog (D2 — no runtime GitHub fetch). Its own
    // collection, disjoint from `docs`, so it is absent from docs nav/search.
    // Rendered newest-first by app/pages/changelog.vue.
    changelog: defineCollection({
      type: 'page',
      source: 'changelog/**',
      schema: z.object({
        date: z.string(),
        badge: z.string().optional(),
        image: z.string().optional()
      })
    })
  }
})
