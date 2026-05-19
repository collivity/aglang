import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'aglang',
  description: 'Architecture Ground Language — agent-first architectural guardrails enforced at git-commit time via Z3 SMT solving.',
  base: '/aglang/',

  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'aglang',

    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'How it works', link: '/how-it-works' },
      { text: 'CLI Reference', link: '/cli/reference' },
      { text: 'Extractors', link: '/extractors' },
      { text: 'Agents', link: '/agents' },
      { text: 'GitHub', link: 'https://github.com/collivity/aglang' }
    ],

    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'What is aglang?', link: '/guide/getting-started' },
          { text: 'Quick Setup (aglc add)', link: '/guide/generate' },
          { text: 'How it works →', link: '/how-it-works' },
        ]
      },
      {
        text: 'Language Reference',
        items: [
          { text: 'Language Reference', link: '/guide/language-reference' },
          { text: 'Contracts', link: '/guide/contracts' },
        ]
      },
      {
        text: 'CLI',
        items: [
          { text: 'All Commands', link: '/cli/reference' },
        ]
      },
      {
        text: 'Ecosystem',
        items: [
          { text: 'Extractors', link: '/extractors' },
          { text: 'AI Agents', link: '/agents' },
          { text: 'JSON Verdict API', link: '/api/json-verdict' },
        ]
      }
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/collivity/aglang' },
      { icon: 'npm', link: 'https://www.npmjs.com/package/@collivity/aglang' }
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2025 Collivity'
    },

    editLink: {
      pattern: 'https://github.com/collivity/aglang/edit/master/docs/:path',
      text: 'Edit this page on GitHub'
    },

    search: {
      provider: 'local'
    }
  },

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/aglang/logo.svg' }],
    ['meta', { name: 'og:type', content: 'website' }],
    ['meta', { name: 'og:title', content: 'aglang — Architectural Guardrails for AI Agents' }],
    ['meta', { name: 'og:description', content: 'Enforce architectural rules at git-commit time using SMT solving. Works with C#, Python, TypeScript, Go, Rust, JVM, Swift.' }],
  ]
})
