export default defineAppConfig({
  ui: {
    colors: {
      // "Spilled tea" identity: steeped-copper primary, warm paper-like stone
      // neutral, matcha green for success. Scales defined in assets/css/main.css.
      primary: 'tea',
      neutral: 'stone',
      success: 'matcha'
    },
    footer: {
      slots: {
        root: 'border-t border-default',
        left: 'text-sm text-muted'
      }
    }
  },
  seo: {
    siteName: 'teaspill'
  },
  header: {
    // title/logo left empty so AppHeader renders the <AppLogo> wordmark + mark.
    title: '',
    to: '/',
    logo: {
      alt: '',
      light: '',
      dark: ''
    },
    search: true,
    colorMode: true,
    links: [{
      label: 'Changelog',
      to: '/changelog'
    }, {
      // TODO(repo-url): placeholder — confirm the real GitHub org/repo before launch.
      'icon': 'i-simple-icons-github',
      'to': 'https://github.com/everynow/teaspill',
      'target': '_blank',
      'aria-label': 'teaspill on GitHub'
    }]
  },
  footer: {
    credits: `© ${new Date().getFullYear()} teaspill`,
    colorMode: false,
    links: [{
      // TODO(repo-url): placeholder — confirm the real GitHub org/repo before launch.
      'icon': 'i-simple-icons-github',
      'to': 'https://github.com/everynow/teaspill',
      'target': '_blank',
      'aria-label': 'teaspill on GitHub'
    }]
  },
  toc: {
    title: 'On this page',
    bottom: {
      title: 'Community',
      // TODO(repo-url): placeholder org/path — confirm before launch. Content lives
      // under packages/docs/content in this repo.
      edit: 'https://github.com/everynow/teaspill/edit/main/packages/docs/content',
      links: [{
        icon: 'i-simple-icons-github',
        label: 'Star on GitHub',
        to: 'https://github.com/everynow/teaspill',
        target: '_blank'
      }]
    }
  }
})
