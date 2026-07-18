<script setup lang="ts">
// Content-driven changelog (D2): entries live as markdown in the `changelog`
// collection (content/changelog/*.md), rendered newest-first. No runtime
// GitHub/release fetch.
const { data: versions } = await useAsyncData('changelog', () =>
  queryCollection('changelog').order('date', 'DESC').all()
)

const title = 'Changelog'
const description = 'New features, improvements, and fixes in teaspill.'

useSeoMeta({
  title,
  ogTitle: title,
  description,
  ogDescription: description
})
</script>

<template>
  <UContainer>
    <UPageHeader
      :title="title"
      :description="description"
      class="py-8"
    />

    <UChangelogVersions
      v-if="versions?.length"
      class="pb-16"
    >
      <UChangelogVersion
        v-for="(version, index) in versions"
        :key="index"
        :title="version.title"
        :description="version.description"
        :date="version.date"
        :badge="version.badge"
        :image="version.image"
      >
        <template #body>
          <ContentRenderer :value="version" />
        </template>
      </UChangelogVersion>
    </UChangelogVersions>
  </UContainer>
</template>
