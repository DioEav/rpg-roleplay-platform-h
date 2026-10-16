// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// 蜜酒厅（Meadhall）使用文档站(品牌 Meadhall,应用名 蜜酒厅/Meadhall)。
// 单一 Markdown 源 = src/content/docs/(zh 根)+ src/content/docs/en/(英文)。
// 产物同时:① 部署 CF Pages → docs.stellatrix.icu(全站导航 / 搜索 / 语言切换 / SEO);
//          ② /embed/<slug> 去框架壳的嵌入视图,供 app 内 HelpDrawer 以 iframe 同控件打开。
export default defineConfig({
  site: 'https://docs.stellatrix.icu',
  integrations: [
    starlight({
      title: '蜜酒厅 Meadhall',
      description: '蜜酒厅（Meadhall）使用文档 —— 剧本、卡牌、记忆、世界书、酒馆、剧本编辑器、自部署。',
      defaultLocale: 'root',
      // i18n 与应用一致:简体中文(默认)+ English;右上角自动出现语言切换。
      locales: {
        root: { label: '简体中文', lang: 'zh-CN' },
        en: { label: 'English', lang: 'en' },
      },
      customCss: ['./src/styles/custom.css'],
      components: {
        // 在默认页脚上方注入「这对我有帮助」反馈模块。
        Footer: './src/components/DocFooter.astro',
      },
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      sidebar: [
        { label: '开始上手', translations: { en: 'Getting started' }, items: ['getting-started', 'account', 'wizard', 'new-game-wizard', 'input', 'tasks'] },
        { label: '内容管理', translations: { en: 'Content' }, items: ['scripts', 'cards', 'saves', 'memory', 'modules', 'worldbook', 'characters', 'branches'] },
        { label: '游戏内面板', translations: { en: 'In-game panels' }, items: ['game-characters', 'game-composer', 'game-memory', 'game-timeline', 'game-worldbook'] },
        { label: '进阶玩法', translations: { en: 'Advanced' }, items: ['tavern', 'timeline', 'branch-graph', 'image-gen'] },
        { label: '创作工具', translations: { en: 'Authoring' }, items: ['md-editor', 'review', 'scripts-review'] },
        { label: '配置', translations: { en: 'Settings' }, items: ['settings-models', 'settings-params', 'settings-memory', 'settings-modelparams', 'settings-modules', 'mcp'] },
        { label: '故障排查', translations: { en: 'Troubleshooting' }, items: ['troubleshooting'] },
        { label: '管理', translations: { en: 'Admin' }, items: ['admin'] },
      ],
    }),
  ],
});
