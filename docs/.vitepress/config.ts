import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'orager',
  description: 'Production-grade AI agent runtime',
  base: '/',
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/installation' },
      { text: 'API Reference', link: '/api/' },
      { text: 'Architecture', link: '/architecture/' },
      { text: 'GitHub', link: 'https://github.com/JayCodesX/orager' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Installation', link: '/guide/installation' },
            { text: 'Quick Start', link: '/guide/quick-start' },
            { text: 'Core Concepts', link: '/guide/core-concepts' },
            { text: 'Licensing & Tiers', link: '/guide/licensing' },
          ]
        },
        {
          text: 'Guides',
          items: [
            { text: 'CLI Reference', link: '/guide/cli-reference' },
            { text: 'Configuration', link: '/guide/configuration' },
            { text: 'Memory System', link: '/guide/memory' },
            { text: 'SkillBank & Learning', link: '/guide/skills' },
            { text: 'OMLS Training', link: '/guide/omls-training' },
            { text: 'Multi-Agent Patterns', link: '/guide/multi-agent' },
            { text: 'Custom Tools', link: '/guide/custom-tools' },
            { text: 'Provider Routing', link: '/guide/provider-routing' },
            { text: 'Security & Permissions', link: '/guide/security-permissions' },
            { text: 'Performance & Cost', link: '/guide/performance-cost' },
            { text: 'Troubleshooting', link: '/guide/troubleshooting' },
          ]
        }
      ],
      '/api/': [
        {
          text: 'API Reference',
          items: [
            { text: 'Overview', link: '/api/' },
            { text: 'Library API', link: '/api/library' },
            { text: 'Agent Definition', link: '/api/agent-definition' },
            { text: 'Memory API', link: '/api/memory-api' },
            { text: 'Session API', link: '/api/session-api' },
            { text: 'Subprocess Transport', link: '/api/subprocess' },
          ]
        }
      ],
      '/architecture/': [
        {
          text: 'Architecture',
          items: [
            { text: 'System Overview', link: '/architecture/' },
          ]
        },
        {
          text: 'ADRs',
          items: [
            { text: 'ADR Index', link: '/adr/' },
            { text: 'ADR-0001: Hierarchical Memory', link: '/adr/0001-hierarchical-memory-system' },
            { text: 'ADR-0002: ANN Vector Index', link: '/adr/0002-ann-vector-index' },
            { text: 'ADR-0003: In-Process Agents', link: '/adr/0003-in-process-agents-remove-daemon' },
            { text: 'ADR-0004: Semantic Memory Retrieval', link: '/adr/0004-semantic-memory-retrieval-distillation' },
            { text: 'ADR-0005: Multi-Context Memory', link: '/adr/0005-multi-context-cross-agent-memory' },
            { text: 'ADR-0006: SkillBank', link: '/adr/0006-skillbank-persistent-skill-memory' },
            { text: 'ADR-0007: OMLS Training', link: '/adr/0007-omls-opportunistic-rl-training' },
            { text: 'ADR-0008: Storage Overhaul', link: '/adr/0008-storage-architecture-overhaul' },
            { text: 'ADR-0009: Local-First Inference', link: '/adr/0009-local-first-inference-client-architecture' },
            { text: 'ADR-0010: Provider Adapters', link: '/adr/0010-provider-adapter-system' },
            { text: 'ADR-0011: Skill Merge Pipeline', link: '/adr/0011-skill-merge-pipeline' },
            { text: 'ADR-0012: OMLS Mode', link: '/adr/0012-omls-mode' },
            { text: 'ADR-0013: Prompt Tournament', link: '/adr/0013-prompt-variant-tournament' },
          ]
        }
      ],
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/JayCodesX/orager' }
    ],
    footer: {
      message: 'Core runtime released under the Apache 2.0 License.'
    }
  }
})
