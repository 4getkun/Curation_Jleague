// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// GitHub Pages (project page) 用の設定
// リポジトリ: https://github.com/4getkun/Curation_Jleague
// 公開URL: https://4getkun.github.io/Curation_Jleague/
export default defineConfig({
  site: 'https://4getkun.github.io',
  base: '/Curation_Jleague',
  trailingSlash: 'always',
  vite: {
    plugins: [tailwindcss()],
  },
});
