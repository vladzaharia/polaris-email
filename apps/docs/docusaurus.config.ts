// Docusaurus v3 configuration for docs.mail.plrs.im.
//
// PR 11 ships the IA skeleton + Worker shell only. PR 12 will add:
//   - the OpenAPI plugin (mounted under /reference/api),
//   - the Pagefind post-build search index,
//   - the migrated content.
//
// Keep this file lean — the static build is served as-is by a thin Hono
// Worker (see src/server/index.ts).
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import { themes as prismThemes } from 'prism-react-renderer';

const config: Config = {
  title: 'polaris-email',
  tagline: 'Managed email service for the polaris-* family',
  url: 'https://docs.mail.plrs.im',
  baseUrl: '/',
  favicon: 'img/favicon.ico',

  organizationName: 'polaris',
  projectName: 'polaris-email',

  // Fail the build on broken links / anchors. The site is small enough that
  // this is cheap insurance against IA drift.
  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',

  // Docusaurus 3.10+ moved onBrokenMarkdownLinks under `markdown.hooks`.
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  // PR 12 TODO: add docusaurus-plugin-openapi-docs here, mounted at
  // /reference/api. The generated MDX lands in docs/reference/api/ (which
  // is gitignored). PR 11's build does not depend on it.
  presets: [
    [
      'classic',
      {
        docs: {
          path: 'docs',
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
          // Edit-link points at the source repo so contributors can fix
          // typos via the GitHub UI. PR 12 will firm up the branch/path.
          editUrl: 'https://github.com/polaris/polaris-email/edit/main/apps/docs/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      defaultMode: 'dark',
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'polaris-email',
      logo: {
        alt: 'polaris-email',
        src: 'img/logo.svg',
        // The svg is a placeholder — real brand assets follow up
        // separately. The text title carries the wordmark for now.
      },
      items: [
        {
          href: 'https://github.com/polaris/polaris-email',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      copyright: `Copyright © ${new Date().getFullYear()} polaris-email contributors. <a href="https://github.com/polaris/polaris-email">GitHub</a>.`,
    },
    prism: {
      theme: prismThemes.vsDark,
      darkTheme: prismThemes.vsDark,
      additionalLanguages: [
        // Note: Prism doesn't ship a `jsonc` grammar; `json` covers our
        // wrangler.jsonc snippets well enough. Drop and revisit if/when
        // PR 12 migrates to Shiki.
        'typescript',
        'tsx',
        'go',
        'bash',
        'json',
        'toml',
        'yaml',
        'http',
        'shell-session',
        'sql',
      ],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
